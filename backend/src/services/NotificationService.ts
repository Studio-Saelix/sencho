import WebSocket from 'ws';
import { DatabaseService, NotificationHistory } from './DatabaseService';
import { NodeRegistry } from './NodeRegistry';
import { isDebugEnabled } from '../utils/debug';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';
import { sanitizeNotificationMessage } from '../utils/notificationMessage';
import { StackActivityMetricsService } from './StackActivityMetricsService';

export type NotificationCategory =
    | 'deploy_success'
    | 'deploy_failure'
    | 'stack_started'
    | 'stack_stopped'
    | 'stack_restarted'
    | 'image_update_available'
    | 'image_update_applied'
    | 'autoheal_triggered'
    | 'monitor_alert'
    | 'scan_finding'
    | 'blueprint_deployed'
    | 'blueprint_deployment_failed'
    | 'blueprint_drift_detected'
    | 'blueprint_drift_correction_failed'
    // Stack drift ledger transitions. Written to history only (the Activity
    // timeline), never dispatched to channels, so they are deliberately excluded
    // from ALL_NOTIFICATION_CATEGORIES (the routable-category whitelist) below.
    | 'drift_detected'
    | 'drift_resolved'
    // Update lifecycle markers from the post-update health gate. History-only
    // for the same reason as the drift pair above.
    | 'update_started'
    | 'health_gate_passed'
    | 'health_gate_failed'
    | 'node_update_available'
    | 'system';

export const ALL_NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [
    'deploy_success', 'deploy_failure', 'stack_started', 'stack_stopped',
    'stack_restarted', 'image_update_available', 'image_update_applied',
    'autoheal_triggered', 'monitor_alert', 'scan_finding',
    'blueprint_deployed', 'blueprint_deployment_failed',
    'blueprint_drift_detected', 'blueprint_drift_correction_failed',
    'node_update_available', 'system',
];

/** Webhook timeout: 10 seconds per external dispatch call. */
const WEBHOOK_TIMEOUT_MS = 10_000;

/** Valid notification channel types for defense-in-depth validation. */
const ALLOWED_CHANNEL_TYPES = new Set(['discord', 'slack', 'webhook']);

export class NotificationService {
    private static instance: NotificationService;
    private dbService: DatabaseService;
    private readonly subscribers = new Set<WebSocket>();

    private constructor() {
        this.dbService = DatabaseService.getInstance();
    }

    public static getInstance(): NotificationService {
        if (!NotificationService.instance) {
            NotificationService.instance = new NotificationService();
        }
        return NotificationService.instance;
    }

    /**
     * Register a WebSocket as a live-notification subscriber. Returns an
     * unsubscribe function the caller should invoke on `'close'` / `'error'`
     * (callers may guard against double-unsubscribe themselves; the Set
     * handles repeated deletes safely either way).
     */
    public subscribe(ws: WebSocket): () => void {
        this.subscribers.add(ws);
        return () => this.subscribers.delete(ws);
    }

    public getSubscriberCount(): number {
        return this.subscribers.size;
    }

    /** Push a `{type,payload}` envelope to every currently-open subscriber. */
    private broadcastToSubscribers(notification: NotificationHistory): void {
        if (this.subscribers.size === 0) return;
        const msg = JSON.stringify({ type: 'notification', payload: notification });
        // Snapshot first: a 'close'/'error' handler firing during a send would
        // otherwise mutate the Set mid-iteration.
        for (const ws of [...this.subscribers]) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(msg);
            }
        }
    }

    /**
     * Broadcast an arbitrary non-notification event envelope to every
     * currently-open subscriber WITHOUT writing it to the alerts history.
     *
     * Used by DockerEventService to push lightweight `state-invalidate`
     * signals so the UI can refetch stack statuses on a real container event
     * instead of waiting for the next polling tick. Persisting these would
     * spam the notifications panel; they are pure ephemeral signals.
     */
    public broadcastEvent(envelope: { type: string; [key: string]: unknown }): void {
        if (this.subscribers.size === 0) return;
        const msg = JSON.stringify(envelope);
        // Snapshot first: a 'close'/'error' handler firing during a send would
        // otherwise mutate the Set mid-iteration.
        for (const ws of [...this.subscribers]) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(msg);
            }
        }
    }

    /**
     * Dispatch an alert: log to history, push via WebSocket, and route to
     * external channels.
     *
     * Never rejects. Callers fire this off without awaiting, so any failure
     * (node resolution, history insert, channel-table read, broadcast) is
     * caught and logged internally rather than propagated.
     *
     * Routing uses two layers that coexist intentionally:
     *  - notification_routes (paid tier, admin-managed): per-stack
     *    pattern/label/category routing with priority ordering. If any route
     *    matches, global agents are skipped.
     *  - agents table (all tiers): global fallback channels used when no
     *    notification_routes match or when no stackName is provided.
     */
    public async dispatchAlert(
        level: 'info' | 'warning' | 'error',
        category: NotificationCategory,
        message: string,
        options?: { stackName?: string; containerName?: string; actor?: string },
    ) {
        const t0 = Date.now();
        const { stackName, containerName, actor } = options ?? {};

        // dispatchAlert is called fire-and-forget from monitors, event streams,
        // and request handlers across the app. It must never reject: node
        // resolution, the history insert, channel-table reads, and the
        // WebSocket broadcast can all throw on an unhealthy DB, which would
        // otherwise surface as an unhandledRejection and take the process down.
        // The whole body is wrapped so the worst case is a dropped notification.
        try {
            // Internal writes use the middleware default so they share a row key
            // with user-initiated requests; otherwise the UI and monitors split
            // between different node_id buckets.
            const localNodeId = NodeRegistry.getInstance().getDefaultNodeId();
            // Use the full resolution chain (node.compose_dir, env, default)
            // so messages mentioning a per-node compose override get collapsed.
            const sanitized = sanitizeNotificationMessage(message, {
                composeDir: NodeRegistry.getInstance().getComposeDir(localNodeId),
            });

            // The inner try only distinguishes a write success from a write
            // failure for metrics; on failure there is no row to dispatch, so
            // we log and stop.
            let notification: NotificationHistory;
            try {
                notification = this.dbService.addNotificationHistory(localNodeId, {
                    level,
                    category,
                    message: sanitized,
                    timestamp: Date.now(),
                    stack_name: stackName,
                    container_name: containerName,
                    actor_username: actor ?? null,
                });
                StackActivityMetricsService.getInstance().record(localNodeId, 'write', Date.now() - t0, true);
            } catch (err) {
                StackActivityMetricsService.getInstance().record(localNodeId, 'write', Date.now() - t0, false);
                console.error('[Notify] Failed to persist notification:', err);
                return;
            }
            // Separate [StackActivity:diag] namespace from the [Notify:diag] lines
            // below so a single grep can pull every per-stack timeline write across
            // route reads and dispatch writes.
            if (isDebugEnabled()) {
                console.log('[StackActivity:diag] write', {
                    category, stackName, nodeId: localNodeId, actor: actor ?? null, messageLen: sanitized.length,
                });
            }

            // 2. Push to connected browser clients via WebSocket
            this.broadcastToSubscribers(notification);

            // 3. Check notification routing rules — always evaluated, matchers compose AND
            const errors: string[] = [];

            const routes = this.dbService.getEnabledNotificationRoutes();
            const needsLabels = stackName !== undefined && routes.some(r => r.label_ids != null && r.label_ids.length > 0);
            const stackLabelIds = needsLabels ? this.dbService.getStackLabelIds(localNodeId, stackName!) : [];

            const matched = routes.filter(r => {
                if (r.node_id != null && r.node_id !== localNodeId) return false;
                if (r.stack_patterns.length > 0 && (stackName === undefined || !r.stack_patterns.includes(stackName))) return false;
                if (r.label_ids != null && r.label_ids.length > 0 && !r.label_ids.some(id => stackLabelIds.includes(id))) return false;
                if (r.categories != null && r.categories.length > 0 && !r.categories.includes(category)) return false;
                return true;
            });
            if (matched.length > 0) {
                if (isDebugEnabled()) console.log(`[Notify:diag] Matched ${matched.length} route(s) for stack "${sanitizeForLog(stackName ?? '(none)')}", category="${sanitizeForLog(category)}"`);
                await Promise.allSettled(
                    matched.map(route =>
                        this.sendToChannel(route.channel_type, route.channel_url, level, sanitized)
                            .then(() => {
                                if (isDebugEnabled()) console.log(`[Notify:diag] Dispatched ${level} via route "${sanitizeForLog(route.name)}" (${route.channel_type})`);
                            })
                            .catch(error => {
                                console.error(`Failed to dispatch notification via route "${sanitizeForLog(route.name)}":`, error);
                                errors.push(`Route "${route.name}": ${getErrorMessage(error, String(error))}`);
                            })
                    )
                );
                this.recordDispatchErrors(notification.id!, errors);
                return;
            }

            // 4. Fall back to this instance's agents (keyed by this instance's default node id).
            const agents = this.dbService.getEnabledAgents(localNodeId);
            if (agents.length === 0) {
                if (isDebugEnabled()) console.log('[Notify:diag] No routes or agents matched; skipping external dispatch');
                return;
            }

            if (isDebugEnabled()) console.log(`[Notify:diag] Falling back to ${agents.length} global agent(s)`);
            await Promise.allSettled(
                agents.map(agent =>
                    this.sendToChannel(agent.type, agent.url, level, sanitized)
                        .then(() => {
                            if (isDebugEnabled()) console.log(`[Notify:diag] Dispatched ${level} via global agent (${agent.type})`);
                        })
                        .catch(error => {
                            console.error(`Failed to dispatch notification to ${agent.type}:`, error);
                            errors.push(`${agent.type}: ${getErrorMessage(error, String(error))}`);
                        })
                )
            );
            this.recordDispatchErrors(notification.id!, errors);
        } catch (err) {
            console.error('[Notify] dispatchAlert failed:', err);
        }
    }

    /** Persist dispatch errors to the notification record for user visibility. */
    private recordDispatchErrors(notificationId: number, errors: string[]) {
        if (errors.length > 0) {
            try {
                this.dbService.updateNotificationDispatchError(notificationId, errors.join('; '));
            } catch (e) {
                console.error('[Notify] Failed to record dispatch error:', e);
            }
        }
    }

    private async sendToChannel(type: string, url: string, level: 'info' | 'warning' | 'error', message: string): Promise<void> {
        if (type === 'discord') {
            await this.sendDiscordWebhook(url, level, message);
        } else if (type === 'slack') {
            await this.sendSlackWebhook(url, level, message);
        } else if (type === 'webhook') {
            await this.sendCustomWebhook(url, level, message);
        } else {
            throw new Error(`Unsupported channel type: ${type}`);
        }
    }

    public async testDispatch(type: 'discord' | 'slack' | 'webhook', url: string) {
        if (!ALLOWED_CHANNEL_TYPES.has(type)) throw new Error(`Invalid notification type: ${type}`);
        if (!url || !url.startsWith('https://')) throw new Error('URL must use HTTPS');
        await this.sendToChannel(type, url, 'info', '🔌 Test Notification from Sencho!');
    }

    private async sendDiscordWebhook(url: string, level: 'info' | 'warning' | 'error', message: string) {
        const colorMap = {
            info: 3447003,    // Blue
            warning: 16776960, // Yellow
            error: 15158332    // Red
        };

        const payload = {
            embeds: [{
                title: `Sencho Alert [${level.toUpperCase()}]`,
                description: message,
                color: colorMap[level],
                timestamp: new Date().toISOString()
            }]
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        });

        if (!response.ok) {
            throw new Error(`Discord Webhook responded with ${response.status}`);
        }
    }

    private async sendSlackWebhook(url: string, level: 'info' | 'warning' | 'error', message: string) {
        const emojiMap = {
            info: 'ℹ️',
            warning: '⚠️',
            error: '🚨'
        };

        const payload = {
            text: `${emojiMap[level]} *Sencho Alert [${level.toUpperCase()}]*\n${message}`
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        });

        if (!response.ok) {
            throw new Error(`Slack Webhook responded with ${response.status}`);
        }
    }

    private async sendCustomWebhook(url: string, level: 'info' | 'warning' | 'error', message: string) {
        const payload = {
            level,
            message,
            timestamp: new Date().toISOString(),
            source: 'sencho'
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        });

        if (!response.ok) {
            throw new Error(`Custom Webhook responded with ${response.status}`);
        }
    }
}
