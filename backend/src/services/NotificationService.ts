import WebSocket from 'ws';
import { DatabaseService, NotificationHistory } from './DatabaseService';
import { NodeRegistry } from './NodeRegistry';
import { isDebugEnabled } from '../utils/debug';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';
import { sanitizeNotificationMessage } from '../utils/notificationMessage';
import { StackActivityMetricsService } from './StackActivityMetricsService';
import {
    appliesToBell,
    appliesToExternal,
    matchesNotificationFilters,
    ruleNeedsStackLabels,
} from '../helpers/notificationMatchers';
import { scheduleAllowsSuppression } from '../helpers/notificationSchedule';
import {
    type NotificationChannelType,
    type ParsedAppriseConfig,
    normalizeAppriseStoredJson,
    parseStoredAppriseConfig,
    validateNotificationChannel,
} from '../helpers/notificationChannels';
import { parseNotificationDispatchRetries } from '../helpers/notificationDispatchRetries';
import { renderPayloadTemplate } from '../helpers/notificationPayloadTemplate';

export type NotificationCategory =
    | 'deploy_success'
    | 'deploy_failure'
    | 'stack_started'
    | 'stack_stopped'
    | 'stack_restarted'
    | 'stack_taken_down'
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
    // Manual rollback-generation release (Resources → Rollback). History-only
    // for the same reason as the drift pair above.
    | 'rollback_generation_released'
    // Automatic external-network creation during deploy. History-only.
    | 'network_auto_created'
    // Git source change-plan attempts. History-only (Activity timeline).
    | 'git_pull_ready'
    | 'git_plan_blocked'
    | 'git_pull_failed'
    | 'git_apply'
    | 'git_apply_failed'
    | 'git_apply_rolled_back'
    | 'git_create'
    | 'node_update_available'
    | 'dev_build_update_available'
    | 'system';

export const ALL_NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [
    'deploy_success', 'deploy_failure', 'stack_started', 'stack_stopped',
    'stack_restarted', 'stack_taken_down', 'image_update_available', 'image_update_applied',
    'autoheal_triggered', 'monitor_alert', 'scan_finding',
    'blueprint_deployed', 'blueprint_deployment_failed',
    'blueprint_drift_detected', 'blueprint_drift_correction_failed',
    'node_update_available', 'dev_build_update_available', 'system',
];

/** Every category that can appear in notification history / the bell panel. */
export const ALL_SUPPRESSIBLE_CATEGORIES: readonly NotificationCategory[] = [
    ...ALL_NOTIFICATION_CATEGORIES,
    'drift_detected', 'drift_resolved',
    'update_started', 'health_gate_passed', 'health_gate_failed',
    'network_auto_created', 'rollback_generation_released',
    'git_pull_ready', 'git_plan_blocked', 'git_pull_failed',
    'git_apply', 'git_apply_failed', 'git_apply_rolled_back', 'git_create',
];

/** Webhook timeout: 10 seconds per external dispatch call. */
const WEBHOOK_TIMEOUT_MS = 10_000;

/** Fixed delay between retryable delivery attempts (extra attempts only). */
const RETRY_DELAY_MS_DEFAULT = 1_000;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Valid notification channel types for defense-in-depth validation. */
const ALLOWED_CHANNEL_TYPES = new Set<NotificationChannelType>(['discord', 'slack', 'webhook', 'apprise', 'ntfy']);

export class NotificationDeliveryError extends Error {
    public constructor(message: string, public readonly status: number | null, public readonly retryable: boolean) {
        super(message);
    }
}

/**
 * Per-dispatch extras for templated payloads. The template replaces the
 * built-in body; all variable values are fixed at dispatch time (level and
 * message come from the dispatch arguments, the rest from this object), so
 * retries of the same dispatch send an identical body.
 */
export interface NotificationDispatchOptions {
    category?: string;
    stackName?: string;
    actor?: string;
    /** Dispatch timestamp (epoch ms); rendered as ISO-8601. Resolved once per dispatch by callers. */
    timestampMs: number;
    /** User-authored payload template; null/blank keeps the built-in body. */
    template?: string | null;
}

export class NotificationService {
    private static instance: NotificationService;
    private dbService: DatabaseService;
    private readonly subscribers = new Set<WebSocket>();
    /** Overridable in tests so retry loops need not wait a real second. */
    private static retryDelayMs = RETRY_DELAY_MS_DEFAULT;

    private constructor() {
        this.dbService = DatabaseService.getInstance();
    }

    public static getInstance(): NotificationService {
        if (!NotificationService.instance) {
            NotificationService.instance = new NotificationService();
        }
        return NotificationService.instance;
    }

    /** @internal Test-only: set the inter-attempt delay (production uses 1000). */
    public static setRetryDelayMsForTests(ms: number): void {
        NotificationService.retryDelayMs = ms;
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
    ): Promise<{ persisted: boolean }> {
        const t0 = Date.now();
        const { stackName, containerName, actor } = options ?? {};

        // dispatchAlert is called fire-and-forget from monitors, event streams,
        // and request handlers across the app. It must never reject: node
        // resolution, the history insert, channel-table reads, and the
        // WebSocket broadcast can all throw on an unhealthy DB, which would
        // otherwise surface as an unhandledRejection and take the process down.
        // The whole body is wrapped so the worst case is a dropped notification.
        // Callers that gate cooldowns on history use `persisted` (true only after the row write).
        let wroteHistory = false;
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
                wroteHistory = true;
                StackActivityMetricsService.getInstance().record(localNodeId, 'write', Date.now() - t0, true);
            } catch (err) {
                StackActivityMetricsService.getInstance().record(localNodeId, 'write', Date.now() - t0, false);
                console.error('[Notify] Failed to persist notification:', err);
                return { persisted: false };
            }
            // Separate [StackActivity:diag] namespace from the [Notify:diag] lines
            // below so a single grep can pull every per-stack timeline write across
            // route reads and dispatch writes.
            if (isDebugEnabled()) {
                console.log('[StackActivity:diag] write', {
                    category, stackName, nodeId: localNodeId, actor: actor ?? null, messageLen: sanitized.length,
                });
            }

            const atMs = Date.now();
            const suppressionRules = this.dbService.getEnabledNotificationSuppressionRules(atMs);
            const routes = this.dbService.getEnabledNotificationRoutes();
            const needsStackLabels = stackName !== undefined && (
                ruleNeedsStackLabels(suppressionRules)
                || routes.some((r) => r.label_ids != null && r.label_ids.length > 0)
            );
            const stackLabelIds = needsStackLabels
                ? this.dbService.getStackLabelIds(localNodeId, stackName!)
                : [];
            const matchCtx = {
                localNodeId,
                stackName,
                category,
                level,
                stackLabelIds,
            };
            const matchedSuppression = suppressionRules.filter((r) =>
                matchesNotificationFilters(matchCtx, r)
                && scheduleAllowsSuppression(r.schedule, r.scheduleInvalid, atMs)
            );
            const suppressBell = matchedSuppression.some((r) => appliesToBell(r.applies_to));
            const suppressExternal = matchedSuppression.some((r) => appliesToExternal(r.applies_to));

            if (isDebugEnabled() && matchedSuppression.length > 0) {
                console.log(`[Notify:diag] Suppression matched ${matchedSuppression.length} rule(s); bell=${suppressBell}, external=${suppressExternal}`);
            }

            if (matchedSuppression.length > 0 && notification.id != null) {
                this.dbService.updateNotificationSuppressionMatch(notification.id, {
                    rules: matchedSuppression.map((r) => ({ id: r.id, name: r.name })),
                    bellSuppressed: suppressBell,
                    externalSuppressed: suppressExternal,
                });
            }

            // 2. Push to connected browser clients via WebSocket
            if (!suppressBell) {
                this.broadcastToSubscribers(notification);
            }

            if (suppressExternal) {
                return { persisted: wroteHistory };
            }

            // Resolve retry extras once for this dispatch (shared by all destinations).
            const retries = this.resolveDispatchRetries();

            // 3. Check notification routing rules — always evaluated, matchers compose AND
            const errors: string[] = [];

            const matched = routes.filter(r => matchesNotificationFilters(matchCtx, r));
            if (matched.length > 0) {
                if (isDebugEnabled()) console.log(`[Notify:diag] Matched ${matched.length} route(s) for stack "${sanitizeForLog(stackName ?? '(none)')}", category="${sanitizeForLog(category)}"`);
                await Promise.allSettled(
                    matched.map(route =>
                        this.sendWithRetries(route.channel_type, route.channel_url, level, sanitized, route.config, retries)
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
                return { persisted: wroteHistory };
            }

            // 4. Fall back to this instance's agents (keyed by this instance's default node id).
            const agents = this.dbService.getEnabledAgents(localNodeId);
            if (agents.length === 0) {
                if (isDebugEnabled()) console.log('[Notify:diag] No routes or agents matched; skipping external dispatch');
                return { persisted: wroteHistory };
            }

            if (isDebugEnabled()) console.log(`[Notify:diag] Falling back to ${agents.length} global agent(s)`);
            await Promise.allSettled(
                agents.map(agent =>
                    this.sendWithRetries(agent.type, agent.url, level, sanitized, agent.config, retries, {
                        category,
                        stackName,
                        actor,
                        timestampMs: notification.timestamp,
                        template: agent.payload_template ?? null,
                    })
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
            return { persisted: wroteHistory };
        } catch (err) {
            console.error('[Notify] dispatchAlert failed:', err);
            // History may already be written; callers must not treat that as a miss.
            return { persisted: wroteHistory };
        }
    }

    /**
     * Read notification_dispatch_retries once. Missing, malformed, out-of-range,
     * or thrown settings reads fall back to 0 so the initial send still happens.
     */
    private resolveDispatchRetries(): number {
        try {
            const raw = this.dbService.getGlobalSettings().notification_dispatch_retries;
            const parsed = parseNotificationDispatchRetries(raw);
            if (parsed === null) {
                console.warn('[Notify] Invalid notification_dispatch_retries; using 0');
                return 0;
            }
            return parsed;
        } catch (err) {
            console.warn('[Notify] Failed to read notification_dispatch_retries; using 0:', err);
            return 0;
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

    /**
     * Deliver with up to `retries` extra attempts after the first try.
     * Waits a fixed 1s between attempts only when a retryable failure leaves attempts remaining.
     */
    private async sendWithRetries(
        type: string,
        url: string,
        level: 'info' | 'warning' | 'error',
        message: string,
        config: string | null | undefined,
        retries: number,
        options?: NotificationDispatchOptions,
    ): Promise<void> {
        const totalAttempts = 1 + retries;
        let lastError: NotificationDeliveryError | undefined;
        for (let attempt = 0; attempt < totalAttempts; attempt++) {
            try {
                await this.sendToChannel(type, url, level, message, config, options);
                return;
            } catch (error) {
                const deliveryError = error instanceof NotificationDeliveryError
                    ? error
                    : new NotificationDeliveryError(
                        getErrorMessage(error, 'Notification delivery failed'),
                        null,
                        false,
                    );
                lastError = deliveryError;
                const attemptsRemain = attempt < totalAttempts - 1;
                if (!deliveryError.retryable || !attemptsRemain) {
                    throw deliveryError;
                }
                await sleep(NotificationService.retryDelayMs);
            }
        }
        throw lastError ?? new NotificationDeliveryError('Notification delivery failed', null, false);
    }

    private async sendToChannel(type: string, url: string, level: 'info' | 'warning' | 'error', message: string, config?: string | null, options?: NotificationDispatchOptions): Promise<void> {
        // A stored template replaces the built-in body for every channel
        // type; a whitespace-only stored template counts as no template.
        if (options?.template && options.template.trim()) {
            await this.sendTemplatedPayload(type, url, level, message, config, options);
            return;
        }
        if (type === 'discord') {
            await this.sendDiscordWebhook(url, level, message);
        } else if (type === 'slack') {
            await this.sendSlackWebhook(url, level, message);
        } else if (type === 'webhook') {
            await this.sendCustomWebhook(url, level, message);
        } else if (type === 'ntfy') {
            await this.sendNtfy(url, level, message);
        } else if (type === 'apprise') {
            const parsed = parseStoredAppriseConfig(url, config);
            if (!parsed.ok) {
                throw new NotificationDeliveryError(parsed.reason, null, false);
            }
            await this.sendAppriseNotify(url, level, message, parsed);
        } else {
            throw new NotificationDeliveryError(`Unsupported channel type: ${type}`, null, false);
        }
    }

    public async testDispatch(type: NotificationChannelType, url: string, config?: unknown, template?: string | null) {
        if (!ALLOWED_CHANNEL_TYPES.has(type)) throw new Error(`Invalid notification type: ${type}`);
        const validation = validateNotificationChannel(type, url, config);
        if (validation) throw new Error(`URL ${validation}`);
        const stored = type === 'apprise' ? normalizeAppriseStoredJson(url, config) : (config == null ? null : JSON.stringify(config));
        const retries = this.resolveDispatchRetries();
        // Single timestamp for the whole test dispatch so every retry renders the same body.
        await this.sendWithRetries(type, url, 'info', '🔌 Test Notification from Sencho!', stored, retries, {
            category: 'system',
            stackName: '',
            actor: '',
            timestampMs: Date.now(),
            template: template ?? null,
        });
    }

    /**
     * Deliver a user-authored payload template for any channel type. The
     * rendered document fully replaces the built-in body. Apprise keeps its
     * destinations authoritative: the stored `urls` (stateless) or `tag`
     * (keyed) are merged in after rendering, and the template may not carry
     * those keys (rejected at write time). Render failures are non-retryable:
     * a template that survived save-time validation cannot fail here, so a
     * failure means hand-edited storage.
     */
    private async sendTemplatedPayload(
        type: string,
        url: string,
        level: 'info' | 'warning' | 'error',
        message: string,
        config: string | null | undefined,
        options: NotificationDispatchOptions,
    ): Promise<void> {
        let payload: unknown;
        try {
            payload = renderPayloadTemplate(options.template!, {
                level,
                message,
                category: options.category ?? '',
                timestamp: new Date(options.timestampMs).toISOString(),
                stack_name: options.stackName ?? '',
                actor: options.actor ?? '',
            });
        } catch (error) {
            console.error('[Notify] Failed to render payload template:', error);
            throw new NotificationDeliveryError('Templated payload could not be rendered', null, false);
        }

        let body = payload;
        if (type === 'apprise') {
            if (typeof body !== 'object' || body === null || Array.isArray(body)) {
                throw new NotificationDeliveryError('Apprise payload template must render a JSON object', null, false);
            }
            const parsed = parseStoredAppriseConfig(url, config);
            if (!parsed.ok) {
                throw new NotificationDeliveryError('Stored Apprise configuration is invalid for this endpoint', null, false);
            }
            const merged: Record<string, unknown> = { ...(body as Record<string, unknown>) };
            if (parsed.mode === 'stateless') merged.urls = parsed.urlsJoined;
            else if (parsed.tags) merged.tag = parsed.tags;
            body = merged;
        }

        let targetUrl = url;
        let authorization: string | undefined;
        if (type === 'ntfy') {
            const normalized = this.normalizeNtfyEndpoint(url);
            targetUrl = normalized.effectiveUrl;
            authorization = normalized.authorization;
        }

        try {
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (authorization) headers['Authorization'] = authorization;
            const response = await fetch(targetUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
            });
            if (type === 'apprise' && response.status === 204) {
                throw new NotificationDeliveryError('Apprise returned no delivery (HTTP 204)', 204, false);
            }
            if (response.status >= 400 && response.status < 500) {
                throw new NotificationDeliveryError(`${type} rejected templated payload with HTTP ${response.status}`, response.status, false);
            }
            if (!response.ok) {
                throw new NotificationDeliveryError(`${type} responded with HTTP ${response.status}`, response.status, true);
            }
        } catch (error) {
            if (error instanceof NotificationDeliveryError) throw error;
            const aborted = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
            throw new NotificationDeliveryError(
                aborted ? `${type} request timed out` : `${type} request failed`,
                null,
                true,
            );
        }
    }

    private async sendAppriseNotify(
        url: string,
        level: 'info' | 'warning' | 'error',
        message: string,
        config: Extract<ParsedAppriseConfig, { ok: true }>,
    ): Promise<void> {
        const payload: Record<string, string> = {
            title: `Sencho Alert [${level.toUpperCase()}]`,
            body: message,
            type: level === 'error' ? 'failure' : level,
        };
        if (config.mode === 'stateless') payload.urls = config.urlsJoined;
        else if (config.tags) payload.tag = config.tags;
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
            });
            if (response.status === 204) throw new NotificationDeliveryError('Apprise returned no delivery (HTTP 204)', 204, false);
            if (response.status >= 400 && response.status < 500) {
                throw new NotificationDeliveryError(`Apprise responded with HTTP ${response.status}`, response.status, false);
            }
            if (!response.ok) throw new NotificationDeliveryError(`Apprise responded with HTTP ${response.status}`, response.status, true);
        } catch (error) {
            if (error instanceof NotificationDeliveryError) throw error;
            const aborted = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
            throw new NotificationDeliveryError(
                aborted ? 'Apprise request timed out' : 'Apprise request failed',
                null,
                true,
            );
        }
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

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
            });

            if (response.status >= 400 && response.status < 500) {
                throw new NotificationDeliveryError(`Discord webhook responded with HTTP ${response.status}`, response.status, false);
            }
            if (!response.ok) {
                throw new NotificationDeliveryError(`Discord webhook responded with HTTP ${response.status}`, response.status, true);
            }
        } catch (error) {
            if (error instanceof NotificationDeliveryError) throw error;
            const aborted = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
            throw new NotificationDeliveryError(
                aborted ? 'Discord webhook request timed out' : 'Discord webhook request failed',
                null,
                true,
            );
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

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
            });

            if (response.status >= 400 && response.status < 500) {
                throw new NotificationDeliveryError(`Slack webhook responded with HTTP ${response.status}`, response.status, false);
            }
            if (!response.ok) {
                throw new NotificationDeliveryError(`Slack webhook responded with HTTP ${response.status}`, response.status, true);
            }
        } catch (error) {
            if (error instanceof NotificationDeliveryError) throw error;
            const aborted = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
            throw new NotificationDeliveryError(
                aborted ? 'Slack webhook request timed out' : 'Slack webhook request failed',
                null,
                true,
            );
        }
    }

    private async sendCustomWebhook(url: string, level: 'info' | 'warning' | 'error', message: string) {
        const payload = {
            level,
            message,
            timestamp: new Date().toISOString(),
            source: 'sencho'
        };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
            });

            if (response.status >= 400 && response.status < 500) {
                throw new NotificationDeliveryError(`Custom webhook responded with HTTP ${response.status}`, response.status, false);
            }
            if (!response.ok) {
                throw new NotificationDeliveryError(`Custom webhook responded with HTTP ${response.status}`, response.status, true);
            }
        } catch (error) {
            if (error instanceof NotificationDeliveryError) throw error;
            const aborted = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
            throw new NotificationDeliveryError(
                aborted ? 'Custom webhook request timed out' : 'Custom webhook request failed',
                null,
                true,
            );
        }
    }

    /**
     * Normalize an ntfy URL for delivery: strip URL userinfo into a Basic
     * Authorization header (defensive; validateNtfyUrl rejects userinfo on
     * the write path) and strip a trailing slash so URLs like
     * https://ntfy.sh/mytopic/ reach the correct topic path. Returns the raw
     * URL unchanged on parse failure.
     */
    private normalizeNtfyEndpoint(url: string): { effectiveUrl: string; authorization?: string } {
        try {
            const parsed = new URL(url);
            let authorization: string | undefined;
            if (parsed.username || parsed.password) {
                const encoded = btoa(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`);
                authorization = `Basic ${encoded}`;
                parsed.username = '';
                parsed.password = '';
            }
            parsed.pathname = parsed.pathname.replace(/\/+$/, '');
            return { effectiveUrl: parsed.toString(), authorization };
        } catch {
            return { effectiveUrl: url };
        }
    }

    private async sendNtfy(url: string, level: 'info' | 'warning' | 'error', message: string) {
        const priorityMap = {
            info: 'default',
            warning: 'high',
            error: 'urgent',
        };
        const priority = priorityMap[level];
        const tags = level === 'error' ? 'warning,rotating_light' : (level === 'warning' ? 'warning' : '');

        const headers: Record<string, string> = {
            'Content-Type': 'text/plain',
            'Title': `Sencho Alert [${level.toUpperCase()}]`,
            'Priority': priority,
        };
        if (tags) headers['Tags'] = tags;

        const { effectiveUrl, authorization } = this.normalizeNtfyEndpoint(url);
        if (authorization) headers['Authorization'] = authorization;

        try {
            const response = await fetch(effectiveUrl, {
                method: 'POST',
                headers,
                body: message,
                signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
            });

            if (response.status >= 400 && response.status < 500) {
                throw new NotificationDeliveryError(`ntfy responded with HTTP ${response.status}`, response.status, false);
            }
            if (!response.ok) {
                throw new NotificationDeliveryError(`ntfy responded with HTTP ${response.status}`, response.status, true);
            }
        } catch (error) {
            if (error instanceof NotificationDeliveryError) throw error;
            const aborted = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
            throw new NotificationDeliveryError(
                aborted ? 'ntfy request timed out' : 'ntfy request failed',
                null,
                true,
            );
        }
    }
}
