import { DatabaseService, type Node } from './DatabaseService';
import { FleetSyncService, FLEET_RESOURCES } from './FleetSyncService';
import { NotificationService } from './NotificationService';
import { isDebugEnabled } from '../utils/debug';
import { RETRY_MAX_AGE_MS, STALE_THRESHOLD_MS } from './fleetSyncConstants';

const INITIAL_DELAY_MS = 30_000;
const EVAL_INTERVAL_MS = 5 * 60_000;

/**
 * Background retry loop for fleet sync.
 *
 * The control's normal write path fires `pushResource` once per change; if a
 * remote was offline at that moment, the failure is recorded on
 * `fleet_sync_status` but never re-attempted unless another write happens. In
 * practice an operator who sets a policy and walks away leaves the dead remote
 * permanently stale. This service ticks every 5 minutes, queries the failed-
 * not-yet-succeeded targets within the last 24h, and re-pushes through the
 * same per-node mutex used by the write path.
 *
 * After STALE_THRESHOLD_MS of continuous failure for one (node, resource), we
 * dispatch a single warning notification and remember the alert. The next
 * recorded success clears the memo so a future failure can alert again.
 */
export class FleetSyncRetryService {
    private static instance: FleetSyncRetryService;
    private intervalId: NodeJS.Timeout | null = null;
    private initialTimer: NodeJS.Timeout | null = null;
    private isProcessing = false;

    /** Per-target alert memo: `${nodeId}:${resource}` → timestamp of last alert. */
    private alertedAt = new Map<string, number>();

    private constructor() {}

    static getInstance(): FleetSyncRetryService {
        if (!FleetSyncRetryService.instance) {
            FleetSyncRetryService.instance = new FleetSyncRetryService();
        }
        return FleetSyncRetryService.instance;
    }

    start(): void {
        this.initialTimer = setTimeout(() => {
            void this.evaluate();
            this.intervalId = setInterval(() => void this.evaluate(), EVAL_INTERVAL_MS);
        }, INITIAL_DELAY_MS);
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
    }

    /**
     * One pass: find every (node, resource) pair with an unresolved failure
     * inside the retry window and re-push to it. Each push goes through the
     * FleetSyncService per-node mutex, so a normal fanout in flight will
     * serialize naturally.
     */
    async evaluate(): Promise<void> {
        if (this.isProcessing) return;
        this.isProcessing = true;
        try {
            if (FleetSyncService.getRole() === 'replica') {
                if (isDebugEnabled()) {
                    console.debug('[FleetSyncRetry:debug] Skipping tick: this instance is a replica');
                }
                return;
            }
            const db = DatabaseService.getInstance();
            for (const resource of FLEET_RESOURCES) {
                const failedTargets = db.getFailedSyncTargets(resource, RETRY_MAX_AGE_MS);
                for (const target of failedTargets) {
                    const node = db.getNode(target.node_id);
                    if (!node) continue;
                    await this.retryOne(node, resource, target.last_failure_at, target.last_success_at);
                }
            }
        } catch (err) {
            console.error('[FleetSyncRetry] evaluate error:', err instanceof Error ? err.message : err);
        } finally {
            this.isProcessing = false;
        }
    }

    private async retryOne(
        node: Node,
        resource: typeof FLEET_RESOURCES[number],
        lastFailureAt: number | null,
        lastSuccessAt: number | null,
    ): Promise<void> {
        if (node.id == null) return;
        if (isDebugEnabled()) {
            console.debug(
                `[FleetSyncRetry:debug] Retrying ${resource} for node "${node.name}" (id=${node.id})`,
            );
        }
        await FleetSyncService.getInstance().pushResourceToNode(
            node as Node & { id: number },
            resource,
        );
        // After the retry, re-read status to decide whether to alert. A
        // successful retry clears the alert memo via the success path above
        // (recordFleetSyncSuccess was called inside the push). A still-failing
        // retry might have crossed the staleness threshold.
        if (lastFailureAt !== null && this.exceedsStaleThreshold(lastFailureAt, lastSuccessAt)) {
            this.maybeAlertStale(node, resource);
        }
    }

    private exceedsStaleThreshold(lastFailureAt: number, lastSuccessAt: number | null): boolean {
        // Alert only when a previously-working node has been failing for more
        // than the threshold. Brand-new nodes that have never succeeded fall
        // through here: misconfigured remotes are caught by the test-connection
        // affordance at registration time, not by this background notifier.
        if (lastSuccessAt === null) return false;
        return lastFailureAt - lastSuccessAt > STALE_THRESHOLD_MS;
    }

    private maybeAlertStale(node: Node, resource: typeof FLEET_RESOURCES[number]): void {
        if (node.id == null) return;
        const key = `${node.id}:${resource}`;
        const now = Date.now();
        const lastAlerted = this.alertedAt.get(key);
        if (lastAlerted !== undefined && now - lastAlerted < STALE_THRESHOLD_MS) {
            return;
        }
        // Re-read post-retry status: if the most recent push succeeded, clear
        // the memo and skip the alert. The retry above ran inside the per-node
        // mutex, so the status is up to date by the time we read it.
        // recordFleetSyncSuccess clears last_failure_at to NULL, so a successful
        // retry shows as `last_success_at !== null && last_failure_at === null`.
        // A retry that landed atop an existing failure shows as both non-null
        // with last_success_at >= last_failure_at.
        const db = DatabaseService.getInstance();
        const fresh = db
            .getFleetSyncStatuses()
            .find((s) => s.node_id === node.id && s.resource === resource);
        if (fresh && fresh.last_success_at !== null
            && (fresh.last_failure_at === null || fresh.last_success_at >= fresh.last_failure_at)) {
            this.alertedAt.delete(key);
            return;
        }
        this.alertedAt.set(key, now);
        void NotificationService.getInstance()
            .dispatchAlert(
                'warning',
                'system',
                `Fleet sync to node "${node.name}" has been failing for over an hour for ${resource}. Check the node's connectivity and API token.`,
            )
            .catch((err) => {
                console.warn('[FleetSyncRetry] Failed to dispatch stale alert:', err);
            });
    }
}
