import { INTENTIONAL_KILL_WINDOW_MS } from './ContainerLifecycleClassifier';
import { DatabaseService, AutoHealPolicy, AutoHealHistoryEntry } from './DatabaseService';
import DockerController from './DockerController';
import { DockerEventManager } from './DockerEventManager';
import { ContainerHealthSnapshot } from './DockerEventService';
import { LicenseService } from './LicenseService';
import { NodeRegistry } from './NodeRegistry';
import { NotificationService } from './NotificationService';
import { PROXY_TIER_HEADER, PROXY_VARIANT_HEADER } from './license-headers';
import { isDebugEnabled } from '../utils/debug';
import { getErrorMessage } from '../utils/errors';

// Dockerode listContainers shape (subset used here)
type ContainerInfo = {
    Id: string;
    Names?: string[];
    Labels?: Record<string, string>;
    State?: string;
    Status?: string;
};

/** Why a container is eligible for healing. */
type HealReason = 'unhealthy' | 'crashed';

/**
 * Reasons shouldHeal declines to act. The `skipped_*` members are the subset
 * recorded to history (the matching values exist in AutoHealHistoryEntry['action']);
 * `not_unhealthy` and `duration_not_met` are internal-only and filtered out before
 * any history write.
 */
type SkipReason =
    | 'not_unhealthy'
    | 'duration_not_met'
    | 'skipped_user_action'
    | 'skipped_cooldown'
    | 'skipped_rate_limit';

/**
 * Normalized heal trigger for a single container. `reason`/`downSince` are set
 * only when there is something to act on; the safety rails (kill window,
 * cooldown, hourly cap) are evaluated separately in shouldHeal.
 */
interface HealSignal {
    reason?: HealReason;
    /** When the heal-worthy condition began (unhealthy-since or crashed-at). */
    downSince?: number;
    /** Last operator kill/stop, used to suppress healing right after a manual action. */
    lastKillAt?: number;
}

const EVAL_INTERVAL_MS = 30_000;
const INITIAL_DELAY_MS = 10_000;
const RATE_LIMIT_WINDOW_MS = 60 * 60_000; // 1 hour
const HISTORY_THROTTLE_MS = 5 * 60_000;
// Refresh proxied remotes' entitlement well under the 5-minute lease the remote
// route grants, so a remote node's policies keep evaluating between operator visits.
const LEASE_REFRESH_INTERVAL_MS = 2 * 60_000;
const LEASE_REFRESH_TIMEOUT_MS = 10_000;
// Consecutive failed lease refreshes for one node before we surface a WARN. At the
// 2-minute cadence this is ~6 minutes of a node being unreachable, by which point
// its entitlement lease has lapsed and its auto-heal has stopped.
const LEASE_REFRESH_FAILURE_WARN_THRESHOLD = 3;

export class AutoHealService {
    private static instance: AutoHealService;
    private intervalId: NodeJS.Timeout | null = null;
    private initialTimer: NodeJS.Timeout | null = null;
    private leaseRefreshTimer: NodeJS.Timeout | null = null;
    private isProcessing = false;
    private restartTimestamps = new Map<string, number[]>();
    private observedUnhealthySince = new Map<string, number>();
    private historyTimestamps = new Map<string, number>();
    private leaseRefreshFailures = new Map<number, number>();

    private constructor() {}

    static getInstance(): AutoHealService {
        if (!AutoHealService.instance) {
            AutoHealService.instance = new AutoHealService();
        }
        return AutoHealService.instance;
    }

    start(): void {
        if (this.initialTimer || this.intervalId) return;
        this.initialTimer = setTimeout(() => {
            void this.evaluate();
            this.intervalId = setInterval(() => void this.evaluate(), EVAL_INTERVAL_MS);
        }, INITIAL_DELAY_MS);
        // Keep proxied remotes' auto-heal entitlement alive without depending on
        // operator UI traffic (which would otherwise let the lease lapse).
        this.leaseRefreshTimer = setInterval(
            () => void this.refreshRemoteLeases(),
            LEASE_REFRESH_INTERVAL_MS,
        );
    }

    stop(): void {
        if (this.initialTimer) {
            clearTimeout(this.initialTimer);
            this.initialTimer = null;
        }
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        if (this.leaseRefreshTimer) {
            clearInterval(this.leaseRefreshTimer);
            this.leaseRefreshTimer = null;
        }
    }

    /**
     * From a paid controlling instance, ping each enrolled remote node's auto-heal
     * list endpoint so the remote renews its proxy entitlement lease. Without this,
     * a Community-tier remote stops evaluating its policies a few minutes after the
     * operator last opened the Auto-Heal sheet. Best-effort and per-node isolated:
     * a single unreachable node never blocks the others or throws.
     */
    private async refreshRemoteLeases(): Promise<void> {
        if (LicenseService.getInstance().getTier() !== 'paid') return;
        const remotes = DatabaseService.getInstance().getNodes().filter(n => n.type === 'remote');
        if (remotes.length === 0) return;

        const registry = NodeRegistry.getInstance();
        const proxyHeaders = LicenseService.getInstance().getProxyHeaders();
        // Drop failure counters for nodes that are no longer enrolled.
        const remoteIds = new Set(remotes.map(n => n.id));
        for (const id of this.leaseRefreshFailures.keys()) {
            if (!remoteIds.has(id)) this.leaseRefreshFailures.delete(id);
        }

        await Promise.allSettled(remotes.map(async (node) => {
            if (node.id === undefined) return;
            const nodeId = node.id;
            const target = registry.getProxyTarget(nodeId);
            if (!target) {
                // No reachable proxy target (e.g. a pilot-agent tunnel that is down
                // or a remote missing its URL/token): count it so a persistently
                // untargetable node is surfaced rather than silently skipped.
                this.noteLeaseRefreshFailure(nodeId, 'no proxy target');
                return;
            }
            const baseUrl = target.apiUrl.replace(/\/$/, '');
            try {
                const res = await fetch(`${baseUrl}/api/auto-heal/policies`, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${target.apiToken}`,
                        [PROXY_TIER_HEADER]: proxyHeaders.tier,
                        [PROXY_VARIANT_HEADER]: proxyHeaders.variant ?? '',
                    },
                    signal: AbortSignal.timeout(LEASE_REFRESH_TIMEOUT_MS),
                });
                if (res.ok) {
                    this.leaseRefreshFailures.delete(nodeId);
                } else {
                    this.noteLeaseRefreshFailure(nodeId, `HTTP ${res.status}`);
                }
            } catch (err) {
                this.noteLeaseRefreshFailure(nodeId, getErrorMessage(err, 'unknown'));
            }
        }));
    }

    /**
     * Record a failed lease refresh for a node and surface a one-time WARN once it
     * has failed enough times in a row that its auto-heal has almost certainly
     * stopped, so a revoked token or a long-unreachable node is not silently lost.
     */
    private noteLeaseRefreshFailure(nodeId: number, detail: string): void {
        const count = (this.leaseRefreshFailures.get(nodeId) ?? 0) + 1;
        this.leaseRefreshFailures.set(nodeId, count);
        if (count === LEASE_REFRESH_FAILURE_WARN_THRESHOLD) {
            console.warn(
                `[AutoHeal] Could not refresh auto-heal entitlement for node ${nodeId} ` +
                `after ${count} consecutive attempts (${detail}). Auto-heal on that node ` +
                `will stop until it is reachable again.`,
            );
        } else if (isDebugEnabled()) {
            console.log(`[AutoHeal:diag] lease refresh for node ${nodeId} failed (attempt ${count}): ${detail}`);
        }
    }

    async evaluate(): Promise<void> {
        if (this.isProcessing) return;
        this.isProcessing = true;
        try {
            const localPaid = LicenseService.getInstance().getTier() === 'paid';
            const db = DatabaseService.getInstance();

            // Evaluate only on local nodes (remote nodes self-monitor via their own instance)
            const nodes = db.getNodes().filter(n => n.type === 'local');
            const now = Date.now();
            if (isDebugEnabled()) {
                console.log(`[AutoHeal:diag] evaluate: ${nodes.length} local node(s), localPaid=${localPaid}`);
            }
            for (const node of nodes) {
                const policies = db.getAutoHealPolicies(undefined, node.id).filter(p =>
                    p.enabled === 1 && (localPaid || p.proxy_entitled_until > now)
                );
                this.pruneInactivePolicyHistory(node.id, policies);
                if (policies.length === 0) continue;
                if (isDebugEnabled()) {
                    console.log(`[AutoHeal:diag] node ${node.id}: ${policies.length} active policy(ies)`);
                }
                await this.evaluateForNode(node.id, policies);
            }
        } catch (err) {
            console.error('[AutoHeal] evaluate error:', err instanceof Error ? err.message : err);
        } finally {
            this.isProcessing = false;
        }
    }

    private async evaluateForNode(nodeId: number, policies: AutoHealPolicy[]): Promise<void> {
        let containers: ContainerInfo[];
        try {
            // all:true so exited/crashed containers are visible too, not just
            // running-but-unhealthy ones.
            containers = await DockerController.getInstance(nodeId).getAllContainers();
        } catch (err) {
            const now = Date.now();
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.error(
                `[AutoHeal] failed to list containers on node ${nodeId}:`,
                errorMsg,
            );
            for (const policy of policies) {
                if (policy.id === undefined) continue;
                this.recordThrottledHistory(policy, {
                    policy_id: policy.id!,
                    stack_name: policy.stack_name,
                    service_name: policy.service_name,
                    container_name: `node-${nodeId}`,
                    container_id: `node-${nodeId}`,
                    action: 'docker_unavailable',
                    reason: 'Skipped: Docker daemon is unavailable for this node.',
                    success: 0,
                    error: errorMsg,
                    timestamp: now,
                }, nodeId);
            }
            return;
        }

        const eventSvc = DockerEventManager.getInstance().getService(nodeId);
        const now = Date.now();

        // Prune stale entries for containers no longer running on this node
        const liveIds = new Set(containers.map(c => c.Id));
        const liveKeys = new Set(containers.map(c => this.containerKey(nodeId, c.Id)));
        for (const [key, timestamps] of this.restartTimestamps.entries()) {
            if (!key.startsWith(`${nodeId}:`)) continue;
            const containerId = key.slice(String(nodeId).length + 1);
            const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
            if (recent.length === 0 || !liveIds.has(containerId)) {
                this.restartTimestamps.delete(key);
            } else {
                this.restartTimestamps.set(key, recent);
            }
        }
        for (const key of this.observedUnhealthySince.keys()) {
            if (key.startsWith(`${nodeId}:`) && !liveKeys.has(key)) {
                this.observedUnhealthySince.delete(key);
            }
        }
        this.pruneInactivePolicyHistory(nodeId, policies);

        // Containers already restarted in this pass, so overlapping policies (an
        // all-services policy plus a service-specific one) can't double-restart
        // the same container and halve its hourly cap.
        const healedThisPass = new Set<string>();

        for (const policy of policies) {
            if (policy.id === undefined) {
                console.warn('[AutoHeal] skipping policy without id:', policy.stack_name);
                continue;
            }
            const candidates = containers.filter(c => {
                const labels = c.Labels ?? {};
                if (labels['com.docker.compose.project'] !== policy.stack_name) return false;
                if (policy.service_name) {
                    return labels['com.docker.compose.service'] === policy.service_name;
                }
                return true;
            });

            for (const container of candidates) {
                const containerName =
                    container.Names?.[0]?.replace(/^\//, '') ?? container.Id.slice(0, 12);
                const serviceOverride = container.Labels?.['com.docker.compose.service'] ?? null;
                const signal = this.getHealSignal(nodeId, container, eventSvc?.getContainerState(container.Id), now);
                const decision = this.shouldHeal(signal, policy, this.containerKey(nodeId, container.Id), now);

                if (!decision.heal) {
                    if (
                        decision.skipReason &&
                        decision.skipReason !== 'not_unhealthy' &&
                        decision.skipReason !== 'duration_not_met'
                    ) {
                        this.recordThrottledHistory(policy, {
                            policy_id: policy.id!,
                            stack_name: policy.stack_name,
                            service_name: policy.service_name ?? serviceOverride,
                            container_name: containerName,
                            container_id: container.Id,
                            action: decision.skipReason,
                            reason: this.skipReasonText(decision.skipReason),
                            success: 0,
                            error: null,
                            timestamp: now,
                        }, nodeId, container.Id);
                    }
                    continue;
                }

                if (healedThisPass.has(container.Id)) continue;
                healedThisPass.add(container.Id);

                if (isDebugEnabled()) {
                    const downForSec = signal.downSince ? Math.round((now - signal.downSince) / 1000) : 0;
                    console.log(`[AutoHeal:diag] healing ${containerName} on node ${nodeId}: reason=${decision.reason} downFor=${downForSec}s`);
                }

                await this.executeHeal(
                    policy,
                    nodeId,
                    container.Id,
                    containerName,
                    policy.service_name ?? serviceOverride,
                    decision.reason ?? 'unhealthy',
                );
            }
        }
    }

    private getHealSignal(
        nodeId: number,
        container: ContainerInfo,
        eventState: ContainerHealthSnapshot | undefined,
        now: number,
    ): HealSignal {
        const key = this.containerKey(nodeId, container.Id);

        // Stopped: heal only when the event stream classified the exit as a crash
        // or OOM kill. crashedAt is never stamped for operator stops or clean
        // exits, so intentionally-stopped containers are not resurrected. Checked
        // before any health-text parsing so an exited container can never fall into
        // the healthcheck path.
        const rawState = (container.State ?? '').toLowerCase();
        if (rawState === 'exited' || rawState === 'dead') {
            this.observedUnhealthySince.delete(key);
            if (eventState?.crashedAt) {
                return { reason: 'crashed', downSince: eventState.crashedAt, lastKillAt: eventState.lastKillAt };
            }
            return { lastKillAt: eventState?.lastKillAt };
        }

        const statusText = `${container.State ?? ''} ${container.Status ?? ''}`.toLowerCase();
        const dockerHealth = statusText.includes('unhealthy')
            ? 'unhealthy'
            : statusText.includes('healthy')
                ? 'healthy'
                : statusText.includes('starting')
                    ? 'starting'
                    : undefined;

        // Running but failing its healthcheck.
        if (dockerHealth === 'unhealthy') {
            const since = eventState?.healthStatus === 'unhealthy' && eventState.unhealthySince
                ? eventState.unhealthySince
                : this.observedUnhealthySince.get(key) ?? now;
            this.observedUnhealthySince.set(key, since);
            return { reason: 'unhealthy', downSince: since, lastKillAt: eventState?.lastKillAt };
        }

        // Running and healthy (or warming up): clear unhealthy tracking, nothing to heal.
        if (dockerHealth === 'healthy' || dockerHealth === 'starting') {
            this.observedUnhealthySince.delete(key);
            return { lastKillAt: eventState?.lastKillAt };
        }

        // Running without a Docker healthcheck (or freshly 'created'): fall back to
        // any health the event stream recorded, otherwise no trigger.
        if (eventState?.healthStatus === 'unhealthy' && eventState.unhealthySince) {
            this.observedUnhealthySince.set(key, eventState.unhealthySince);
            return { reason: 'unhealthy', downSince: eventState.unhealthySince, lastKillAt: eventState.lastKillAt };
        }
        this.observedUnhealthySince.delete(key);
        return { lastKillAt: eventState?.lastKillAt };
    }

    private shouldHeal(
        signal: HealSignal,
        policy: AutoHealPolicy,
        containerKey: string,
        now: number,
    ): { heal: boolean; skipReason?: SkipReason; reason?: HealReason } {
        // No heal-worthy condition (healthy, clean exit, or unclassified stop)
        if (!signal.reason || !signal.downSince) {
            return { heal: false, skipReason: 'not_unhealthy' };
        }

        // Duration threshold not yet met
        if (now - signal.downSince < policy.unhealthy_duration_mins * 60_000) {
            return { heal: false, skipReason: 'duration_not_met' };
        }

        // Suppress if user recently killed the container
        if (signal.lastKillAt !== undefined && now - signal.lastKillAt < INTENTIONAL_KILL_WINDOW_MS) {
            return { heal: false, skipReason: 'skipped_user_action' };
        }

        // Cooldown: respect last_fired_at (set on every attempt, success or failure)
        if (policy.last_fired_at > 0 && now - policy.last_fired_at < policy.cooldown_mins * 60_000) {
            return { heal: false, skipReason: 'skipped_cooldown' };
        }

        // Rate limit: max restart attempts per hour
        const recentRestarts = (this.restartTimestamps.get(containerKey) ?? []).filter(
            t => now - t < RATE_LIMIT_WINDOW_MS,
        );
        if (recentRestarts.length >= policy.max_restarts_per_hour) {
            return { heal: false, skipReason: 'skipped_rate_limit' };
        }

        return { heal: true, reason: signal.reason };
    }

    private async executeHeal(
        policy: AutoHealPolicy,
        nodeId: number,
        containerId: string,
        containerName: string,
        serviceName: string | null,
        reason: HealReason,
    ): Promise<void> {
        const db = DatabaseService.getInstance();
        const now = Date.now();
        const baseEntry = {
            policy_id: policy.id!,
            stack_name: policy.stack_name,
            service_name: serviceName,
            container_name: containerName,
            container_id: containerId,
            timestamp: now,
        };
        const condition = reason === 'crashed' ? 'crashed and stayed down' : 'unhealthy';

        // Stamp the attempt up front so the cooldown and hourly cap apply to a
        // failed restart too. Otherwise a container that keeps failing to restart
        // would be retried on every poll (every 30s) until auto-disable.
        db.updateAutoHealPolicy(policy.id!, { last_fired_at: now });
        const restartKey = this.containerKey(nodeId, containerId);
        const timestamps = (this.restartTimestamps.get(restartKey) ?? []).filter(
            t => now - t < RATE_LIMIT_WINDOW_MS,
        );
        timestamps.push(now);
        this.restartTimestamps.set(restartKey, timestamps);

        try {
            await DockerController.getInstance(nodeId).restartContainer(containerId);
            if (isDebugEnabled()) {
                console.log(`[AutoHeal:diag] restart of ${containerName} on node ${nodeId} took ${Date.now() - now}ms`);
            }

            db.resetConsecutiveFailures(policy.id!);

            db.recordAutoHealHistory({
                ...baseEntry,
                action: 'restarted',
                reason: `Container ${condition} for ${policy.unhealthy_duration_mins} minute(s); auto-restarted.`,
                success: 1,
                error: null,
            });

            db.insertAuditLog({
                timestamp: now,
                username: 'system',
                method: 'POST',
                path: '/system/auto-heal',
                status_code: 200,
                node_id: nodeId,
                ip_address: '127.0.0.1',
                summary: `Auto-healed container ${containerName} on stack ${policy.stack_name}`,
            });

            NotificationService.getInstance()
                .dispatchAlert(
                    'info',
                    'autoheal_triggered',
                    `Auto-Heal: Restarted ${containerName} on stack ${policy.stack_name} after being ${condition} for ${policy.unhealthy_duration_mins} minute(s).`,
                    { stackName: policy.stack_name, containerName, actor: 'system:autoheal' },
                )
                .catch(err => console.error('[AutoHeal] notification dispatch failed:', err));
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);

            db.incrementConsecutiveFailures(policy.id!);
            // Re-read to get updated consecutive_failures count
            const updated = db.getAutoHealPolicy(policy.id!);
            const failures = updated?.consecutive_failures ?? policy.consecutive_failures + 1;

            db.recordAutoHealHistory({
                ...baseEntry,
                action: 'failed',
                reason: `Restart failed: ${errorMsg}`,
                success: 0,
                error: errorMsg,
            });

            NotificationService.getInstance()
                .dispatchAlert(
                    'warning',
                    'autoheal_triggered',
                    `Auto-Heal: Failed to restart ${containerName} on stack ${policy.stack_name}. Error: ${errorMsg}`,
                    { stackName: policy.stack_name, containerName, actor: 'system:autoheal' },
                )
                .catch(e => console.error('[AutoHeal] notification dispatch failed:', e));

            // Auto-disable if failure threshold reached
            if (failures >= policy.auto_disable_after_failures) {
                this.handleAutoDisable(policy.id!, policy, baseEntry, failures);
            }

            console.error(`[AutoHeal] restart failed for ${containerName} (${containerId}):`, errorMsg);
        }
    }

    private handleAutoDisable(
        policyId: number,
        policy: AutoHealPolicy,
        baseEntry: Omit<Parameters<DatabaseService['recordAutoHealHistory']>[0], 'action' | 'reason' | 'success' | 'error'>,
        failures: number,
    ): void {
        const db = DatabaseService.getInstance();
        db.setPolicyEnabled(policyId, false);
        db.recordAutoHealHistory({
            ...baseEntry,
            action: 'policy_auto_disabled',
            reason: `Policy disabled after ${failures} consecutive restart failures. Check container logs and re-enable when resolved.`,
            success: 0,
            error: null,
        });
        NotificationService.getInstance()
            .dispatchAlert(
                'warning',
                'autoheal_triggered',
                `Auto-Heal: Policy for ${policy.stack_name}${policy.service_name ? '/' + policy.service_name : ''} has been auto-disabled after ${failures} consecutive failures.`,
                { stackName: policy.stack_name, actor: 'system:autoheal' },
            )
            .catch(e => console.error('[AutoHeal] notification dispatch failed:', e));
    }

    private recordThrottledHistory(
        policy: AutoHealPolicy,
        entry: Omit<AutoHealHistoryEntry, 'id'>,
        nodeId: number,
        containerId = entry.container_id,
    ): void {
        if (policy.id === undefined) return;
        const key = `${nodeId}:${policy.id}:${containerId}:${entry.action}`;
        const lastRecorded = this.historyTimestamps.get(key) ?? 0;
        if (entry.timestamp - lastRecorded < HISTORY_THROTTLE_MS) return;
        this.historyTimestamps.set(key, entry.timestamp);
        DatabaseService.getInstance().recordAutoHealHistory(entry);
    }

    private pruneInactivePolicyHistory(nodeId: number, policies: AutoHealPolicy[]): void {
        const activePolicyIds = new Set(policies.map(p => p.id).filter((id): id is number => id !== undefined));
        for (const key of this.historyTimestamps.keys()) {
            const [keyNodeId, policyId] = key.split(':');
            if (keyNodeId === String(nodeId) && !activePolicyIds.has(Number(policyId))) {
                this.historyTimestamps.delete(key);
            }
        }
    }

    private containerKey(nodeId: number, containerId: string): string {
        return `${nodeId}:${containerId}`;
    }

    private skipReasonText(reason: SkipReason): string {
        switch (reason) {
            case 'skipped_user_action':
                return 'Skipped: recent user action detected on this container.';
            case 'skipped_cooldown':
                return 'Skipped: cooldown period has not elapsed since last restart.';
            case 'skipped_rate_limit':
                return 'Skipped: hourly restart limit reached for this container.';
            default:
                return reason;
        }
    }
}
