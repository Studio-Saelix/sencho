import axios, { AxiosError } from 'axios';
import { createHash } from 'crypto';
import { CveSuppression, DatabaseService, Node, ScanPolicy } from './DatabaseService';
import { NodeRegistry } from './NodeRegistry';
import { NotificationService } from './NotificationService';
import { isDebugEnabled } from '../utils/debug';
import {
    FleetResource,
    MAX_SYNC_ROWS,
    SYNC_ERROR_CODES,
    SYNC_STATE_KEYS,
    TRUNCATION_ALERT_COOLDOWN_MS,
} from './fleetSyncConstants';

export type { FleetResource };

export const FLEET_RESOURCES: readonly FleetResource[] = ['scan_policies', 'cve_suppressions'];

export function isFleetResource(value: unknown): value is FleetResource {
    return typeof value === 'string' && (FLEET_RESOURCES as readonly string[]).includes(value);
}

export type FleetRole = 'control' | 'replica';

export const LOCAL_IDENTITY_SENTINEL = 'local';

/**
 * Wire-format payload pushed to a remote's POST /api/fleet/sync/:resource.
 * The receiver parses individual fields with explicit type checks, so this
 * stays internal to the sender. Both sides tolerate absent `pushedAt` and
 * `controlIdentity` for back-compat with controls that predate the
 * versioning protocol.
 */
interface FleetSyncPayload {
    rows: unknown[];
    pushedAt: number;
    targetIdentity: string;
    controlIdentity: string;
}

/**
 * Thrown by `applyIncomingSync` when the incoming `pushedAt` is strictly older
 * than the receiver's last-applied watermark for the same resource. The route
 * handler catches this specifically and returns 409 STALE_SYNC_PUSH; any other
 * error becomes a 500.
 */
export class StaleSyncPushError extends Error {
    constructor(public readonly previous: number, public readonly incoming: number) {
        super(`Stale sync push: pushedAt=${incoming} is older than last applied=${previous}`);
        this.name = 'StaleSyncPushError';
    }
}

/**
 * Thrown by `applyIncomingSync` when the incoming `controlIdentity` does not
 * match the fingerprint cached on first sync. The replica is anchored to a
 * specific control; an operator must re-anchor explicitly via
 * POST /api/fleet/role/reanchor before a different control can write. The
 * route handler catches this specifically and returns 409
 * CONTROL_IDENTITY_MISMATCH.
 */
export class ControlIdentityMismatchError extends Error {
    constructor(public readonly expected: string, public readonly got: string) {
        super(`Control identity mismatch: replica is anchored to "${expected}", push from "${got}"`);
        this.name = 'ControlIdentityMismatchError';
    }
}

/**
 * FleetSyncService replicates security configuration from a control Sencho
 * instance to every managed remote node. Security rules live on the control's
 * SQLite database; each write triggers a push of the full table to every
 * remote that has an api_url and api_token configured.
 *
 * Per-node concurrency: pushes to the same remote are serialized via an
 * in-memory mutex map. Sencho runs as a single Node.js process per instance,
 * so process-local serialization is correct for the supported topology.
 *
 * Push failures are recorded on `fleet_sync_status` for the UI and the retry
 * service. STALE_SYNC_PUSH 409 responses are not recorded — they are an
 * expected protocol outcome, not a node health issue.
 */
export class FleetSyncService {
    private static instance: FleetSyncService;

    /** Tail of the most recent push promise for each node id. */
    private inflightByNode = new Map<number, Promise<void>>();

    /**
     * Strictly-increasing timestamp guard for outgoing pushes. Process-global
     * across resources: scan_policies and cve_suppressions share the counter
     * because the receiver tracks watermarks per resource via separate
     * `received_pushed_at:<resource>` keys.
     */
    private static lastPushedAt = 0;

    private static warnedMissingIdentity = false;

    private constructor() {}

    public static getInstance(): FleetSyncService {
        if (!FleetSyncService.instance) {
            FleetSyncService.instance = new FleetSyncService();
        }
        return FleetSyncService.instance;
    }

    public static getRole(): FleetRole {
        return DatabaseService.getInstance().getSystemState(SYNC_STATE_KEYS.fleetRole) === 'replica'
            ? 'replica'
            : 'control';
    }

    /**
     * Identity string used when matching scan policies on this instance. The
     * empty string fallback on a replica with corrupted state means
     * identity-scoped policies will not apply until the next sync push restores
     * the cached identity.
     */
    public static getSelfIdentity(): string {
        if (FleetSyncService.getRole() === 'replica') {
            const cached = DatabaseService.getInstance().getSystemState(SYNC_STATE_KEYS.fleetSelfIdentity);
            if (!cached) {
                if (!FleetSyncService.warnedMissingIdentity) {
                    console.warn(
                        '[FleetSync] Replica has no cached self-identity. Identity-scoped policies will not apply until the next sync push.',
                    );
                    FleetSyncService.warnedMissingIdentity = true;
                }
                return '';
            }
            return cached;
        }
        return LOCAL_IDENTITY_SENTINEL;
    }

    /**
     * Map a policy's node_id to a node_identity string.
     * NULL → '' (fleet-wide); local → LOCAL_IDENTITY_SENTINEL; remote → api_url.
     */
    public static resolveIdentityForNodeId(nodeId: number | null | undefined): string {
        if (nodeId == null) return '';
        const node = NodeRegistry.getInstance().getNode(nodeId);
        if (!node) return '';
        if (node.type === 'remote' && node.api_url) return node.api_url;
        return LOCAL_IDENTITY_SENTINEL;
    }

    /**
     * Stable fingerprint that identifies this control instance to its
     * replicas. Derived by SHA-256-truncating `system_state.instance_id`
     * (the local UUID generated once on first boot by LicenseService.initialize).
     *
     * Anchored on the URL path is fragile: an operator who switches a
     * control's public hostname would falsely flag drift. Anchoring on the
     * persisted instance UUID survives hostname rotations; only a full
     * SQLite reset (or explicit reanchor) breaks the binding.
     *
     * Returns the empty string when `instance_id` is missing (very early
     * boot, before LicenseService.initialize has run). The receiver treats
     * empty as legacy and accepts.
     */
    public static getControlIdentity(): string {
        if (FleetSyncService.cachedControlIdentity !== null) {
            return FleetSyncService.cachedControlIdentity;
        }
        const instanceId = DatabaseService.getInstance().getSystemState('instance_id');
        if (!instanceId) {
            return '';
        }
        const fingerprint = createHash('sha256').update(instanceId).digest('hex').slice(0, 16);
        FleetSyncService.cachedControlIdentity = fingerprint;
        return fingerprint;
    }

    private static cachedControlIdentity: string | null = null;

    private nextPushedAt(): number {
        const now = Date.now();
        const next = now > FleetSyncService.lastPushedAt ? now : FleetSyncService.lastPushedAt + 1;
        FleetSyncService.lastPushedAt = next;
        return next;
    }

    /** Push the current state of a resource to every remote node. */
    public async pushResource(resource: FleetResource): Promise<void> {
        if (FleetSyncService.getRole() === 'replica') {
            if (isDebugEnabled()) {
                console.debug(`[FleetSync:debug] Skipping push for ${resource}: this instance is a replica`);
            }
            return;
        }
        const db = DatabaseService.getInstance();
        const nodes = db.getNodes().filter((n): n is Node & { id: number } => {
            return n.type === 'remote' && Boolean(n.api_url) && Boolean(n.api_token) && n.id != null;
        });
        if (nodes.length === 0) {
            if (isDebugEnabled()) {
                console.debug(`[FleetSync:debug] No eligible remote nodes for ${resource} push`);
            }
            return;
        }

        const rows = this.loadResource(resource);
        const payload: Omit<FleetSyncPayload, 'targetIdentity'> = {
            rows,
            pushedAt: this.nextPushedAt(),
            controlIdentity: FleetSyncService.getControlIdentity(),
        };

        if (isDebugEnabled()) {
            console.debug(
                `[FleetSync:debug] Pushing ${resource} to ${nodes.length} remote(s): rows=${rows.length} pushedAt=${payload.pushedAt}`,
            );
        }

        await Promise.all(nodes.map((node) => this.enqueuePushToNode(node, resource, payload)));
    }

    /** Fire-and-forget wrapper for write handlers. Errors are already logged inside. */
    public pushResourceAsync(resource: FleetResource): void {
        this.pushResource(resource).catch((err) => {
            console.error(`[FleetSync] Unexpected error pushing ${resource}:`, err);
        });
    }

    /**
     * Apply a received sync payload on a replica. Runs control-anchor check,
     * staleness comparison, role flip, identity cache, row replacement, and
     * watermark write inside a single SQLite transaction so a partial-write
     * window cannot leave the watermark behind the row state.
     *
     * Throws (rolling back the transaction):
     *   - `ControlIdentityMismatchError` when the cached fingerprint differs
     *     from the incoming non-empty fingerprint. Route translates to 409
     *     CONTROL_IDENTITY_MISMATCH; an admin must reanchor explicitly.
     *   - `StaleSyncPushError` when the incoming pushedAt is older than the
     *     persisted watermark. Route translates to 409 STALE_SYNC_PUSH.
     *
     * Both `pushedAt` and `controlIdentity` are optional for back-compat with
     * legacy controls; absent values skip the corresponding check.
     */
    public applyIncomingSync(
        resource: FleetResource,
        rows: ScanPolicy[] | Array<Omit<CveSuppression, 'id'>>,
        targetIdentity: string,
        pushedAt?: number,
        controlIdentity?: string,
    ): void {
        const db = DatabaseService.getInstance();
        db.transaction(() => {
            if (controlIdentity && controlIdentity.length > 0) {
                // The cached fingerprint has three possible states:
                //   null            fresh install, never received a push.
                //   ''              post-reanchor, explicitly cleared by an admin.
                //   '<fingerprint>' anchored to a specific control.
                // The first two are treated identically as "un-anchored": persist
                // the incoming fingerprint. Only a non-empty mismatch rejects.
                const cached = db.getSystemState(SYNC_STATE_KEYS.fleetControlIdentity);
                if (cached && cached !== controlIdentity) {
                    throw new ControlIdentityMismatchError(cached, controlIdentity);
                }
                if (!cached) {
                    db.setSystemState(SYNC_STATE_KEYS.fleetControlIdentity, controlIdentity);
                }
            }
            if (pushedAt !== undefined && Number.isFinite(pushedAt)) {
                const watermarkKey = SYNC_STATE_KEYS.receivedPushedAt(resource);
                const previousRaw = db.getSystemState(watermarkKey);
                const previous = previousRaw !== null ? Number(previousRaw) : null;
                if (previous !== null && Number.isFinite(previous) && pushedAt < previous) {
                    throw new StaleSyncPushError(previous, pushedAt);
                }
                db.setSystemState(watermarkKey, String(pushedAt));
            }
            db.setSystemState(SYNC_STATE_KEYS.fleetRole, 'replica');
            if (targetIdentity) {
                db.setSystemState(SYNC_STATE_KEYS.fleetSelfIdentity, targetIdentity);
            }
            if (resource === 'scan_policies') {
                db.replaceReplicatedScanPolicies(rows as ScanPolicy[]);
            } else if (resource === 'cve_suppressions') {
                db.replaceReplicatedCveSuppressions(rows as Array<Omit<CveSuppression, 'id'>>);
            }
        });
    }

    /**
     * Reset the control anchor on this replica so a different control may
     * push to it. Clears the cached fingerprint and all replicated rows so
     * stale state from the prior control does not leak forward. Watermarks
     * also reset to allow the next control's first push to succeed.
     *
     * Intentionally leaves `fleet_role = 'replica'` and `fleet_self_identity`
     * untouched: the node remains a passive receiver, and the next push
     * overwrites the cached identity. The static `cachedControlIdentity` is
     * also flushed defensively in case this process previously acted as a
     * control before being demoted into a replica role.
     */
    public reanchor(): void {
        const db = DatabaseService.getInstance();
        db.transaction(() => {
            db.setSystemState(SYNC_STATE_KEYS.fleetControlIdentity, '');
            db.setSystemState(SYNC_STATE_KEYS.receivedPushedAt('scan_policies'), '');
            db.setSystemState(SYNC_STATE_KEYS.receivedPushedAt('cve_suppressions'), '');
            db.replaceReplicatedScanPolicies([]);
            db.replaceReplicatedCveSuppressions([]);
        });
        FleetSyncService.cachedControlIdentity = null;
    }

    /**
     * Chain a push behind any in-flight push for the same node. Different
     * nodes still run in parallel via the outer Promise.all.
     */
    private enqueuePushToNode(
        node: Node & { id: number },
        resource: FleetResource,
        payload: Omit<FleetSyncPayload, 'targetIdentity'>,
    ): Promise<void> {
        const prev = this.inflightByNode.get(node.id) ?? Promise.resolve();
        // .catch() before .then() so a thrown push does not poison the chain
        // for that node id. executePushToNode swallows internally today, but
        // the catch is defense-in-depth against future regressions.
        const next = prev.catch(() => undefined).then(
            () => this.executePushToNode(node, resource, payload),
        );
        const tracked = next.finally(() => {
            if (this.inflightByNode.get(node.id) === tracked) {
                this.inflightByNode.delete(node.id);
            }
        });
        this.inflightByNode.set(node.id, tracked);
        return next;
    }

    private async executePushToNode(
        node: Node & { id: number },
        resource: FleetResource,
        partial: Omit<FleetSyncPayload, 'targetIdentity'>,
    ): Promise<void> {
        const db = DatabaseService.getInstance();
        const apiUrl = node.api_url ?? '';
        const baseUrl = apiUrl.replace(/\/$/, '');
        const payload: FleetSyncPayload = { ...partial, targetIdentity: apiUrl };
        try {
            await axios.post(
                `${baseUrl}/api/fleet/sync/${resource}`,
                payload,
                {
                    headers: { Authorization: `Bearer ${node.api_token}` },
                    timeout: 15_000,
                },
            );
            db.recordFleetSyncSuccess(node.id, resource);
            if (isDebugEnabled()) {
                console.debug(
                    `[FleetSync:debug] Pushed ${resource} to "${node.name}" (${baseUrl}) ok: rows=${payload.rows.length} pushedAt=${payload.pushedAt}`,
                );
            }
        } catch (err) {
            // STALE_SYNC_PUSH (409) is an expected protocol outcome: a newer
            // push for the same resource has already landed. The node is
            // healthy; suppress the failure record so it does not surface as
            // an alert in the sync-status panel.
            if (err instanceof AxiosError && err.response?.status === 409) {
                const data = err.response.data as { code?: string } | undefined;
                if (data?.code === SYNC_ERROR_CODES.staleSyncPush) {
                    if (isDebugEnabled()) {
                        console.debug(
                            `[FleetSync:debug] Stale push to "${node.name}" (${baseUrl}) for ${resource}; receiver already has a newer state.`,
                        );
                    }
                    return;
                }
            }
            const message = this.formatError(err);
            console.warn(
                `[FleetSync] Failed to push ${resource} to "${node.name}" (${baseUrl}): ${message}`,
            );
            db.recordFleetSyncFailure(node.id, resource, message);
        }
    }

    private loadResource(resource: FleetResource): unknown[] {
        const db = DatabaseService.getInstance();
        let rows: unknown[];
        if (resource === 'scan_policies') {
            rows = db.getLocalScanPolicies().map((p) => ({
                name: p.name,
                node_identity: p.node_identity,
                stack_pattern: p.stack_pattern,
                max_severity: p.max_severity,
                block_on_deploy: p.block_on_deploy,
                enabled: p.enabled,
                created_at: p.created_at,
                updated_at: p.updated_at,
            }));
        } else if (resource === 'cve_suppressions') {
            rows = db.getLocalCveSuppressions().map((s) => ({
                cve_id: s.cve_id,
                pkg_name: s.pkg_name,
                image_pattern: s.image_pattern,
                reason: s.reason,
                created_by: s.created_by,
                created_at: s.created_at,
                expires_at: s.expires_at,
            }));
        } else {
            return [];
        }

        if (rows.length > MAX_SYNC_ROWS) {
            const dropped = rows.length - MAX_SYNC_ROWS;
            console.warn(
                `[FleetSync] ${resource} has ${rows.length} local rows; truncating to ${MAX_SYNC_ROWS} for sync (dropped=${dropped})`,
            );
            this.maybeNotifyTruncation(resource, dropped);
            rows = rows.slice(0, MAX_SYNC_ROWS);
        }
        return rows;
    }

    /**
     * Dispatch a truncation warning at most once per cooldown window. Without
     * this throttle, a configuration that exceeds the row cap would generate
     * one alert per write and flood the operator's notification stream.
     */
    private maybeNotifyTruncation(resource: FleetResource, dropped: number): void {
        const db = DatabaseService.getInstance();
        const stateKey = SYNC_STATE_KEYS.truncationAlertAt(resource);
        const lastRaw = db.getSystemState(stateKey);
        const last = lastRaw !== null ? Number(lastRaw) : 0;
        const now = Date.now();
        if (Number.isFinite(last) && now - last < TRUNCATION_ALERT_COOLDOWN_MS) {
            return;
        }
        db.setSystemState(stateKey, String(now));
        void NotificationService.getInstance()
            .dispatchAlert(
                'warning',
                'system',
                `Fleet sync truncated ${resource} to ${MAX_SYNC_ROWS} rows (${dropped} not replicated). Reduce the local set or contact support.`,
            )
            .catch((err) => {
                console.warn('[FleetSync] Failed to dispatch truncation alert:', err);
            });
    }

    private formatError(err: unknown): string {
        if (err instanceof AxiosError) {
            if (err.response) {
                const data = err.response.data;
                const detail = typeof data === 'object' && data && 'error' in data
                    ? String((data as { error: unknown }).error)
                    : err.response.statusText;
                return `HTTP ${err.response.status}: ${detail}`;
            }
            return err.message;
        }
        return err instanceof Error ? err.message : String(err);
    }
}
