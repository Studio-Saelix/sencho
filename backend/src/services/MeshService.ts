import net from 'net';
import path from 'path';
import fs from 'fs/promises';
import { EventEmitter } from 'events';
import * as YAML from 'yaml';
import { ComposeService } from './ComposeService';
import { DatabaseService, type NodeMode } from './DatabaseService';
import DockerController from './DockerController';
import { FileSystemService } from './FileSystemService';
import { LicenseService } from './LicenseService';
import { PROXY_TIER_HEADER, PROXY_VARIANT_HEADER } from './license-headers';
import { MeshForwarder, type MeshForwarderHost } from './MeshForwarder';
import { NodeRegistry } from './NodeRegistry';
import { PilotTunnelManager } from './PilotTunnelManager';
import { MeshProxyTunnelDialer, type DialFailureCode } from './MeshProxyTunnelDialer';
import { generateOverrideYaml, MeshAlias, SENCHO_MESH_NETWORK } from './MeshComposeOverride';
import { lookupContainerIp } from '../mesh/containerLookup';
import { STREAM_PENDING_DATA_MAX_BYTES } from '../pilot/protocol';
import { sanitizeForLog } from '../utils/safeLog';
import { isPathWithinBase, isValidStackName } from '../utils/validation';
import { PORT as SENCHO_LISTEN_PORT } from '../helpers/constants';
import { assertPolicyGateAllows, buildSystemPolicyGateOptions } from '../helpers/policyGate';

const ACTIVITY_BUFFER_SIZE = 1000;
const ALIAS_REFRESH_INTERVAL_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;
const SLOW_PROBE_THRESHOLD_MS = 500;
const DEFAULT_MESH_SUBNET = '172.30.0.0/24';

/**
 * Subnets attempted in order when SENCHO_MESH_SUBNET is unset and no
 * `sencho_mesh` network already exists. Each is a `/24` chosen to dodge the
 * usual homelab Docker patterns: `172.30.0.0/24` matches the prior default,
 * `172.31.0.0/24` sits one above it, and the `10.42`/`10.43` pair lands well
 * outside both the linuxserver/* `172.30.0.0/16` family and the typical
 * `192.168.x` LAN range. The first candidate that Docker accepts wins; the
 * chosen subnet persists implicitly through the `sencho_mesh` network on the
 * Docker daemon (next boot adopts it via the inspect path).
 */
export const MESH_SUBNET_CANDIDATES = [
    '172.30.0.0/24',
    '172.31.0.0/24',
    '10.42.0.0/24',
    '10.43.0.0/24',
];

const REACHABLE_REASON: Record<DialFailureCode, string> = {
    auth_failed: 'api token rejected by remote',
    endpoint_not_found: 'remote does not support proxy mesh',
    tls_failed: 'TLS handshake failed',
    no_target: 'proxy target missing',
    network_error: 'remote unreachable',
};

/**
 * Returns the static IPv4 address Sencho will pin itself to on the mesh
 * Docker network: `<network address> + 2`. The Docker daemon assigns
 * `<network> + 1` to the bridge gateway, so `+2` is the first usable host
 * address. For the default `172.30.0.0/24` this is `172.30.0.2`. Throws
 * on invalid CIDR or a prefix too narrow to host two addresses.
 */
export function getSenchoIpFromSubnet(subnet: string): string {
    const cidr = subnet.trim().match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/);
    if (!cidr) throw new Error(`Invalid mesh subnet CIDR: ${subnet}`);
    const octets = [Number(cidr[1]), Number(cidr[2]), Number(cidr[3]), Number(cidr[4])];
    const prefix = Number(cidr[5]);
    if (octets.some((o) => o < 0 || o > 255) || prefix < 8 || prefix > 30) {
        throw new Error(`Invalid mesh subnet CIDR: ${subnet}`);
    }
    const ipInt = (octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3];
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const network = (ipInt & mask) >>> 0;
    const sencho = (network + 2) >>> 0;
    return [
        (sencho >>> 24) & 0xff,
        (sencho >>> 16) & 0xff,
        (sencho >>> 8) & 0xff,
        sencho & 0xff,
    ].join('.');
}

/**
 * Discriminator for why the mesh data plane is or is not healthy. Set by
 * `setupMeshNetwork` and exposed through `getDataPlaneStatus()` so
 * `/api/health` and `/api/meta` can surface the state without parsing the
 * raw error string.
 */
export type MeshDataPlaneReason =
    | 'ok'
    | 'not_started'      // MeshService.start() has not finished setupMeshNetwork yet
    | 'subnet_invalid'   // SENCHO_MESH_SUBNET did not parse
    | 'subnet_overlap'   // Docker refused the IPAM pool, another network owns the CIDR
    | 'subnet_mismatch'  // sencho_mesh already exists with a different subnet
    | 'ip_in_use'        // another container squats <network>+2
    | 'attach_failed'    // self-attach failed for any other reason
    | 'not_in_docker';   // HOSTNAME unset or self-container lookup returned 404

export interface MeshDataPlaneStatus {
    ok: boolean;
    reason: MeshDataPlaneReason;
    message: string | null;
    subnet: string;
}

export type MeshActivitySource = 'pilot' | 'mesh';
export type MeshActivityLevel = 'info' | 'warn' | 'error';
export type MeshActivityType =
    | 'route.dispatch' | 'route.resolve.ok' | 'route.resolve.denied' | 'route.resolve.fail'
    | 'tunnel.open' | 'tunnel.fail' | 'tunnel.backpressure'
    | 'opt_in' | 'opt_out'
    | 'mesh.enable' | 'mesh.disable'
    | 'mesh.override.preserved'
    | 'probe.ok' | 'probe.fail'
    | 'forwarder.listen' | 'forwarder.unlisten' | 'forwarder.error'
    | 'proxy-tunnel.open.ok' | 'proxy-tunnel.open.fail' | 'proxy-tunnel.close'
    | 'mesh.proxy_tunnel.identify'
    | 'mesh.reconcile.fail';

export interface MeshActivityEvent {
    ts: number;
    source: MeshActivitySource;
    level: MeshActivityLevel;
    type: MeshActivityType;
    nodeId?: number;
    alias?: string;
    streamId?: number;
    message: string;
    details?: Record<string, unknown>;
}

export interface MeshGlobalAlias {
    /** `<service>.<stack>.<nodeName>.sencho` */
    host: string;
    nodeId: number;
    nodeName: string;
    stackName: string;
    serviceName: string;
    port: number;
}

export interface MeshTarget {
    nodeId: number;
    stack: string;
    service: string;
    port: number;
    alias: string;
}

export interface MeshRegenFailure {
    nodeId: number;
    stackName: string;
    message: string;
}

export interface MeshRegenSummary {
    regenerated: number;
    failures: MeshRegenFailure[];
    skipped: boolean;
    reason?: string;
}

/**
 * How a node participates in mesh routing right now:
 *   - `local`: the Sencho serving this request.
 *   - `pilot`: a remote with a pilot agent. Live-tunnel state is captured
 *      separately in `pilotConnected`.
 *   - `proxy`: a remote that central reaches via the long-lived api_token.
 *      Central maintains a persistent bidirectional WS to each mesh-enabled
 *      proxy peer, reconciled periodically; the operator sees no badge while
 *      the bridge is up.
 *   - `unreachable`: configuration or runtime problem keeps mesh traffic
 *      from flowing. `reachableReason` carries an actionable hint.
 */
export type MeshReachableMode = 'local' | 'pilot' | 'proxy' | 'unreachable';

/**
 * State of the peer→central reverse path. The forward WS to a proxy-mode
 * peer is bidirectional; peer→central traffic flows over the same WS via
 * `tcp_open_reverse`. This discriminator surfaces whether that bridge is
 * currently usable so the Routing tab can show a transient pill while the
 * dialer is reconnecting.
 *   - `connected`: forward WS is open; peer can dispatch reverse streams.
 *   - `connecting`: dial in flight; transient.
 *   - `unavailable`: no bridge and no dial in flight (peer just rebooted, or
 *     last dial cached a failure).
 *   - `not_applicable`: not a proxy-mode peer, or mesh disabled on this node.
 */
export type MeshReverseCallbackStatus = 'connected' | 'connecting' | 'unavailable' | 'not_applicable';

export interface MeshNodeStatus {
    nodeId: number;
    nodeName: string;
    enabled: boolean;
    /** Forwarder state for the LOCAL node (the Sencho instance answering this request). Always `null` for any non-local node — fetching the remote forwarder state requires a cross-node call which lands in Phase B. */
    localForwarderListening: boolean | null;
    /**
     * True iff a pilot tunnel is currently registered for this node. Only
     * meaningful when `reachableMode === 'pilot'`. Kept for diagnostic
     * surfaces; the Routing tab badge logic consumes `reachableMode` and
     * ignores this field for proxy / local nodes.
     * TODO: collapse into `reachableMode` (introduce `pilot_offline` value)
     * once no remaining caller reads `pilotConnected` directly.
     */
    pilotConnected: boolean;
    /** Canonical reachability classification consumed by the Routing tab. */
    reachableMode: MeshReachableMode;
    /** Short, operator-facing reason when `reachableMode === 'unreachable'`. Null otherwise. */
    reachableReason: string | null;
    /** Peer→central reverse path state. `not_applicable` for non-proxy peers. */
    reverseCallbackStatus: MeshReverseCallbackStatus;
    /**
     * Stacks opted into the mesh on this node, with a per-stack resolvability
     * flag. `currentlyResolvable` is `true` iff the alias cache currently
     * carries at least one alias for that (nodeId, stackName) pair, i.e. the
     * stack's services were inspectable and exposed at least one port the
     * last time `refreshAliasCache()` ran (every 60 s on a timer, plus on
     * opt-in / opt-out and pilot reconnect). A suspended opt-in (stack
     * stopped, services not running) reports `currentlyResolvable: false` so
     * the Routing tab can surface the asymmetry between the persistent
     * registry and the live alias list.
     */
    optedInStacks: Array<{ stackName: string; currentlyResolvable: boolean }>;
    activeStreamCount: number;
}

export interface MeshNodeDiagnostic {
    nodeId: number;
    forwarder: { listening: boolean; listenerCount: number };
    pilot: { connected: boolean; bufferedAmount: number; lastSeen: number | null };
    activeStreams: Array<{ streamId: number; alias?: string; bytesIn: number; bytesOut: number; ageMs: number }>;
    aliasCache: Array<{ host: string; targetNodeId: number; port: number }>;
}

export interface MeshRouteDiagnostic {
    alias: string;
    target: MeshTarget | null;
    pilot: { connected: boolean; lastSeen: number | null };
    lastError: { ts: number; message: string } | null;
    lastProbeMs: number | null;
    /** Wall-clock ms epoch of the last probe for this alias; null when no probe has ever run. */
    lastProbeAt: number | null;
    state: 'healthy' | 'degraded' | 'unreachable' | 'tunnel down' | 'not authorized';
}

export interface MeshProbeResult {
    ok: boolean;
    latencyMs?: number;
    where?: 'no_route' | 'pilot_tunnel' | 'agent_resolve' | 'agent_dial' | 'target_port';
    code?: string;
    message?: string;
}

interface ActiveStreamRecord {
    streamId: number;
    alias?: string;
    bytesIn: number;
    bytesOut: number;
    openedAt: number;
}

/**
 * Sencho Mesh orchestrator. Owns:
 *   - in-process TCP forwarder (`MeshForwarder`) that binds per-alias
 *     listeners on Sencho's `sencho_mesh` bridge-network IP.
 *   - opt-in / opt-out persistence and cascading override regeneration
 *   - global alias aggregation (across the fleet via the existing HTTP
 *     proxy chain, see `inspectStackServices`)
 *   - cross-node TCP forwarding via `PilotTunnelManager` (central-side)
 *   - probe + diagnostics + activity ring buffer
 *
 * V1 limitations:
 *   - one cross-node alias per TCP port across the fleet (port-collision
 *     check at opt-in)
 *   - aliases resolve to Sencho's static IP on the internal `sencho_mesh`
 *     Docker bridge network. Meshed user services join `sencho_mesh` so
 *     that IP is reachable from inside their containers without any
 *     host-firewall coordination.
 */
export class MeshService extends EventEmitter implements MeshForwarderHost {
    private static instance: MeshService;
    private started = false;
    private aliasCache = new Map<string, MeshGlobalAlias>();
    private aliasByPort = new Map<number, MeshGlobalAlias>();
    // Populated on pilot nodes via the D-1 override push. Central's
    // db.listMeshStacks() is authoritative on central; pilots have no
    // mesh_stacks rows (C-3 design), so the push payload carries the alias
    // data they need to bind forwarder listeners for the reverse direction.
    private pilotAliasOverlay = new Map<string, MeshGlobalAlias[]>();
    private activity: MeshActivityEvent[] = [];
    private activeStreams = new Map<number, ActiveStreamRecord>();
    private aliasRefreshTimer?: NodeJS.Timeout;
    private bridgeReconcileTimer?: NodeJS.Timeout;
    private routeErrorMap = new Map<string, { ts: number; message: string }>();
    private routeLatencyMap = new Map<string, number>();
    // Lets the route diagnostic distinguish a fresh "healthy" verdict from a
    // stale one carried over from a past probe; written in lockstep with the
    // latency/error maps by every probe outcome.
    private routeProbeAtMap = new Map<string, number>();
    private activityListeners = new Set<(e: MeshActivityEvent) => void>();
    private readonly forwarder: MeshForwarder;
    private senchoIp: string | null = null;
    private meshSubnet: string = DEFAULT_MESH_SUBNET;
    private networkSetupError: string | null = null;
    // Discriminator-typed mirror of networkSetupError. Both stay in sync via
    // `recordSetupFailure` / the setupMeshNetwork success path. The discriminator
    // is consumed by /api/health and the Routing tab; networkSetupError is
    // preserved for callers that already read the raw error string (optInStack,
    // applyLocalOverride, regenerateAllOverrides).
    private dataPlaneStatus: MeshDataPlaneStatus = {
        ok: false,
        reason: 'not_started',
        message: 'mesh data plane has not initialized yet',
        subnet: '',
    };
    // On a pilot node, central's DB id for this node (e.g. 14). Used by
    // handleAccept to decide same-node vs cross-node; the pilotAliasOverlay
    // carries nodeIds from central's perspective, so comparing against the
    // pilot's own local DB id (always 1) inverts dispatch. Null on central
    // (fallback to getDefaultNodeId()). Populated from SENCHO_ENROLL_TOKEN.
    private selfCentralNodeId: number | null = null;
    // On a proxy-mode peer, central's DB id for this node, communicated
    // through the `?nodeId=` query param on the `/api/mesh/proxy-tunnel` WS
    // upgrade. Same purpose as `selfCentralNodeId` but for proxy peers,
    // where there is no SENCHO_ENROLL_TOKEN to read at boot. Takes
    // precedence in `handleAccept`'s self-id resolution because the active
    // upstream tunnel is the most authoritative source. Cleared on tunnel
    // close.
    private proxyTunnelSelfCentralNodeId: number | null = null;

    private constructor() {
        super();
        this.setMaxListeners(50);
        this.forwarder = new MeshForwarder(this);
    }

    public static getInstance(): MeshService {
        if (!MeshService.instance) MeshService.instance = new MeshService();
        return MeshService.instance;
    }

    private resolveSelfCentralNodeId(): number {
        const tok = process.env.SENCHO_ENROLL_TOKEN;
        if (tok) {
            try {
                // Extract payload only — signature verification not needed here;
                // we only need the nodeId claim, not auth.
                const [, b64] = tok.split('.');
                const payload = JSON.parse(
                    Buffer.from(b64, 'base64url').toString('utf8'),
                ) as Record<string, unknown>;
                if (typeof payload.nodeId === 'number') return payload.nodeId;
            } catch {
                // Malformed token; fall through to local default.
            }
        }
        return NodeRegistry.getInstance().getDefaultNodeId();
    }

    public async start(): Promise<void> {
        if (this.started) return;
        this.started = true;

        const ptm = PilotTunnelManager.getInstance();
        ptm.on('tunnel-down', (nodeId: number) => this.onTunnelDown(nodeId));
        ptm.on('tunnel-up', (nodeId: number) => {
            this.logActivity({
                source: 'pilot', level: 'info', type: 'tunnel.open',
                nodeId, message: `pilot tunnel up for node ${nodeId}`,
            });
            // Boot regen runs before any pilot tunnel comes up, so any
            // pilot-mode node misses its initial override push. Now that
            // the tunnel is live, retry the regen for this node so its
            // overrides on disk match what central holds. Idempotent:
            // pushOverrideToNode writes the same file every time, and a
            // tunnel reconnect during runtime regenerates harmlessly.
            void this.regenerateOverridesForNode(nodeId).catch((err) => {
                this.logActivity({
                    source: 'mesh', level: 'warn', type: 'forwarder.error',
                    nodeId,
                    message: `tunnel-up regen failed for node ${nodeId}: ${sanitizeForLog((err as Error).message)}`,
                });
            });
        });

        this.selfCentralNodeId = this.resolveSelfCentralNodeId();

        await this.setupMeshNetwork();
        try {
            await this.refreshAliasCache();
        } catch (err) {
            this.logActivity({
                source: 'mesh', level: 'error', type: 'forwarder.error',
                message: `boot refreshAliasCache failed: ${sanitizeForLog((err as Error).message)}`,
            });
        }
        try {
            await this.syncForwarderListeners();
        } catch (err) {
            this.logActivity({
                source: 'mesh', level: 'error', type: 'forwarder.error',
                message: `boot syncForwarderListeners failed: ${sanitizeForLog((err as Error).message)}`,
            });
        }
        await this.regenerateAllOverrides();
        // Proactively dial every mesh-enabled proxy peer so the forward WS
        // (which also carries peer→central reverse traffic) is up before any
        // user request hits it. Fire-and-forget so start() does not block on
        // remote I/O.
        void this.proactiveBridgeFanout();
        this.startBridgeReconcileLoop();
        this.aliasRefreshTimer = setInterval(() => {
            void (async () => {
                try {
                    await this.refreshAliasCache();
                    await this.syncForwarderListeners();
                } catch (err) {
                    console.warn('[MeshService] alias refresh failed:', sanitizeForLog((err as Error).message));
                }
            })();
        }, ALIAS_REFRESH_INTERVAL_MS);

        const dpReason = this.dataPlaneStatus.reason;
        const dataPlane = this.senchoIp ? 'ok' : `unavailable (${dpReason}: ${this.networkSetupError ?? 'unknown'})`;
        const subnetSuffix = this.senchoIp ? `, subnet ${this.meshSubnet}` : '';
        const summaryLevel: MeshActivityLevel = dpReason === 'ok'
            ? 'info'
            : dpReason === 'not_in_docker' ? 'warn' : 'error';
        this.logActivity({
            source: 'mesh', level: summaryLevel, type: 'mesh.enable',
            message: `MeshService started (data plane ${dataPlane}${subnetSuffix}, self nodeId ${this.selfCentralNodeId})`,
        });
    }

    public async stop(): Promise<void> {
        if (!this.started) return;
        this.started = false;
        if (this.aliasRefreshTimer) {
            clearInterval(this.aliasRefreshTimer);
            this.aliasRefreshTimer = undefined;
        }
        this.stopBridgeReconcileLoop();
        await this.forwarder.shutdown();
    }

    /**
     * Walk every mesh-enabled proxy-mode peer and call
     * `MeshProxyTunnelDialer.ensureBridge(nodeId)` on each. The bridge is
     * the persistent bidirectional control-plane channel: central→peer
     * `tcp_open` and peer→central `tcp_open_reverse` both flow over the
     * same WS. Bounded concurrency 4 with a 250 ms stagger; failures are
     * logged and never abort the fan-out. Called both at startup and on
     * every reconcile tick. `ensureBridge` short-circuits on already-open
     * bridges, so steady-state cost is one Map lookup per peer.
     */
    private async proactiveBridgeFanout(): Promise<void> {
        const rows = DatabaseService.getInstance().getDb().prepare(`
            SELECT id FROM nodes
            WHERE type = 'remote' AND mode = 'proxy' AND mesh_enabled = 1
            ORDER BY id
        `).all() as Array<{ id: number }>;

        const queue = rows.map((r) => r.id);
        const dialer = MeshProxyTunnelDialer.getInstance();
        const worker = async (): Promise<void> => {
            for (;;) {
                const nodeId = queue.shift();
                if (nodeId === undefined) return;
                try {
                    await dialer.ensureBridge(nodeId);
                } catch (err) {
                    this.logActivity({
                        source: 'mesh', level: 'warn', type: 'proxy-tunnel.open.fail',
                        nodeId,
                        message: `proxy-tunnel reconcile dial failed: ${sanitizeForLog((err as Error).message)}`,
                        details: { trigger: 'reconcile' },
                    });
                }
                await new Promise((r) => setTimeout(r, 250));
            }
        };
        const workerCount = Math.min(4, Math.max(1, queue.length));
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
    }

    /**
     * Schedule the proxy-tunnel reconcile tick. Interval is overridable via
     * `SENCHO_MESH_RECONCILE_INTERVAL_MS` (default 60_000 ms) so an operator
     * can tune the peer-reboot detection window. Idempotent: a second call
     * is a no-op while the timer is live.
     */
    private startBridgeReconcileLoop(): void {
        if (this.bridgeReconcileTimer) return;
        const raw = process.env.SENCHO_MESH_RECONCILE_INTERVAL_MS;
        const parsed = raw === undefined ? Number.NaN : Number(raw);
        const intervalMs = Number.isFinite(parsed) && parsed >= 1000 ? parsed : 60_000;
        this.bridgeReconcileTimer = setInterval(() => {
            void this.proactiveBridgeFanout().catch((err) => {
                this.logActivity({
                    source: 'mesh', level: 'error', type: 'mesh.reconcile.fail',
                    message: `bridge reconcile threw: ${sanitizeForLog((err as Error).message)}`,
                });
            });
        }, intervalMs);
        this.bridgeReconcileTimer.unref?.();
    }

    private stopBridgeReconcileLoop(): void {
        if (this.bridgeReconcileTimer) {
            clearInterval(this.bridgeReconcileTimer);
            this.bridgeReconcileTimer = undefined;
        }
    }

    public getSenchoIp(): string | null {
        return this.senchoIp;
    }

    public getMeshSubnet(): string {
        return this.meshSubnet;
    }

    public getNetworkSetupError(): string | null {
        return this.networkSetupError;
    }

    /**
     * Typed mirror of `networkSetupError` for consumers that need a
     * discriminator (e.g. `/api/health` and the Routing tab). Always returns
     * a value: `{ ok: true, reason: 'ok' }` once `setupMeshNetwork` completes
     * successfully, otherwise a typed failure shape.
     */
    public getDataPlaneStatus(): MeshDataPlaneStatus {
        return this.dataPlaneStatus;
    }

    /**
     * Single recording path for every mesh-setup failure. Keeps the legacy
     * `networkSetupError` string in sync, sets the typed `dataPlaneStatus`,
     * and emits a `mesh.disable` activity entry. Callers pass `level: 'warn'`
     * for expected conditions (`not_in_docker` in dev mode) and `'error'` for
     * real failures.
     */
    private recordSetupFailure(
        reason: Exclude<MeshDataPlaneReason, 'ok' | 'not_started'>,
        err: unknown,
        level: MeshActivityLevel,
        // The subnet_invalid path fires before `this.meshSubnet` is assigned,
        // so callers must pass the value they tried explicitly; deriving from
        // the field would silently report DEFAULT_MESH_SUBNET instead of the
        // bad CIDR the operator actually configured.
        subnet: string,
    ): void {
        const message = err instanceof Error ? err.message : String(err);
        this.networkSetupError = message;
        this.dataPlaneStatus = { ok: false, reason, message, subnet };
        this.senchoIp = null;
        this.logActivity({
            source: 'mesh',
            level,
            type: 'mesh.disable',
            message: `mesh data plane unavailable (${reason}): ${sanitizeForLog(message)}`,
            details: { reason, subnet },
        });
    }

    /**
     * Classify a throw from `ensureMeshNetwork` into a typed reason by matching
     * on the error message. Docker's "pool overlaps with other one on this
     * address space" surfaces as a 500 when another bridge owns the requested
     * CIDR; the subnet-mismatch error is thrown synchronously from
     * `ensureMeshNetwork` itself and contains the literal "exists with subnet".
     */
    private classifyMeshNetworkError(err: unknown): 'subnet_overlap' | 'subnet_mismatch' | 'attach_failed' {
        const m = err instanceof Error ? err.message : String(err);
        if (/overlap/i.test(m)) return 'subnet_overlap';
        if (/exists with subnet/i.test(m)) return 'subnet_mismatch';
        return 'attach_failed';
    }

    /**
     * Classify a throw from `ensureSelfAttached` (after its non-throwing
     * not-in-Docker paths). Docker's "Address already in use" /
     * "no available addresses" come back when another container squats
     * `<network>+2`; anything else is a generic attach failure.
     */
    private classifySelfAttachError(err: unknown): 'ip_in_use' | 'attach_failed' {
        const m = err instanceof Error ? err.message : String(err);
        if (/already in use|no available addresses|address already/i.test(m)) return 'ip_in_use';
        return 'attach_failed';
    }

    /**
     * Idempotent setup of the shared `sencho_mesh` Docker bridge network and
     * Sencho's static attachment to it. Called once at boot before alias
     * cache refresh. Failures here disable mesh routing for the lifetime of
     * the process (forwarder still binds, but `ensureStackOverride` short-
     * circuits because there is no IP to point user containers at).
     *
     * Skipped entirely when Sencho is not running inside Docker (dev mode,
     * detected by an unset HOSTNAME env var or by the inspect lookup
     * failing). The forwarder still runs locally for unit-test coverage.
     *
     * Three subnet-resolution paths:
     *   1. **Operator-explicit.** `SENCHO_MESH_SUBNET` is set. Use exactly
     *      that subnet; a pre-existing `sencho_mesh` with a different subnet
     *      raises `subnet_mismatch`. Preserves the loud-config-error case.
     *   2. **Adopt-existing.** `SENCHO_MESH_SUBNET` is unset and
     *      `sencho_mesh` already exists on the Docker daemon. Adopt its
     *      subnet (Docker is the source of truth across restarts).
     *   3. **Candidate iteration.** Neither of the above. Walk
     *      `MESH_SUBNET_CANDIDATES` in order; first subnet Docker accepts
     *      wins. If every candidate overlaps an existing network, record
     *      `subnet_overlap` with a message naming every attempted subnet.
     */
    private async setupMeshNetwork(): Promise<void> {
        const envSubnet = process.env.SENCHO_MESH_SUBNET?.trim() || null;

        // Validate the operator-supplied CIDR before any Docker call. An
        // invalid env var is the operator's problem, not the daemon's, and
        // reporting `subnet_invalid` from here means the diagnostic stays
        // accurate even if the daemon is also broken.
        if (envSubnet) {
            try {
                this.senchoIp = getSenchoIpFromSubnet(envSubnet);
                this.meshSubnet = envSubnet;
            } catch (err) {
                this.recordSetupFailure('subnet_invalid', err, 'error', envSubnet);
                return;
            }
        }

        let existingSubnet: string | null;
        try {
            existingSubnet = await this.inspectExistingMeshSubnet();
        } catch (err) {
            // A genuinely broken Docker daemon (404s return null, see
            // `inspectExistingMeshSubnet`). Classify as `attach_failed`;
            // calling create would just hit the same error one layer down.
            this.recordSetupFailure(
                'attach_failed',
                err,
                'error',
                envSubnet ?? DEFAULT_MESH_SUBNET,
            );
            return;
        }

        if (envSubnet) {
            if (existingSubnet && existingSubnet !== envSubnet) {
                this.recordSetupFailure(
                    'subnet_mismatch',
                    new Error(
                        `${SENCHO_MESH_NETWORK} exists with subnet ${existingSubnet}, ` +
                        `expected ${envSubnet}. Remove the network or set SENCHO_MESH_SUBNET to match.`,
                    ),
                    'error',
                    envSubnet,
                );
                return;
            }
            if (!existingSubnet) {
                try {
                    await this.createMeshNetwork(envSubnet);
                } catch (err) {
                    // TOCTOU: another process may have created `sencho_mesh`
                    // between our inspect (returned null) and our create
                    // (rejected with 409). Re-inspect; if the existing
                    // subnet matches what the operator requested, treat
                    // this as idempotent success (matches the prior
                    // ensureMeshNetwork 409-then-inspect behavior). Any
                    // other error or a mismatch reverts to the typed
                    // failure path.
                    const dockerErr = err as { statusCode?: number };
                    if (dockerErr?.statusCode === 409) {
                        const raceWinner = await this.inspectExistingMeshSubnet().catch(() => null);
                        if (raceWinner === envSubnet) {
                            // Adopt the race-winner's network; proceed to attach.
                        } else if (raceWinner) {
                            this.recordSetupFailure(
                                'subnet_mismatch',
                                new Error(
                                    `${SENCHO_MESH_NETWORK} exists with subnet ${raceWinner}, ` +
                                    `expected ${envSubnet}. Remove the network or set SENCHO_MESH_SUBNET to match.`,
                                ),
                                'error',
                                envSubnet,
                            );
                            return;
                        } else {
                            this.recordSetupFailure('attach_failed', err, 'error', envSubnet);
                            return;
                        }
                    } else {
                        this.recordSetupFailure(
                            this.classifyMeshNetworkError(err),
                            err,
                            'error',
                            envSubnet,
                        );
                        return;
                    }
                }
            }
        } else if (existingSubnet) {
            try {
                this.senchoIp = getSenchoIpFromSubnet(existingSubnet);
                this.meshSubnet = existingSubnet;
            } catch (err) {
                this.recordSetupFailure('subnet_invalid', err, 'error', existingSubnet);
                return;
            }
        } else {
            const tried: string[] = [];
            let chosen: string | null = null;
            let lastErr: unknown = null;
            for (const candidate of MESH_SUBNET_CANDIDATES) {
                tried.push(candidate);
                try {
                    await this.createMeshNetwork(candidate);
                    chosen = candidate;
                    break;
                } catch (err) {
                    const cls = this.classifyMeshNetworkError(err);
                    if (cls === 'subnet_overlap') {
                        lastErr = err;
                        continue;
                    }
                    // Non-overlap failures (e.g. daemon attach error) are not
                    // helped by trying another candidate; bail with the typed
                    // reason for this candidate. A 409 from another process
                    // racing to create `sencho_mesh` between our inspect and
                    // our create will classify as `attach_failed` here; the
                    // race is rare enough that we accept the bail and let the
                    // next process start adopt the now-existing network.
                    this.recordSetupFailure(cls, err, 'error', candidate);
                    return;
                }
            }
            if (!chosen) {
                this.recordSetupFailure(
                    'subnet_overlap',
                    new Error(
                        `every candidate subnet overlaps an existing Docker network on this host ` +
                        `(tried ${tried.join(', ')}). Set SENCHO_MESH_SUBNET to a free /24 and restart.` +
                        (lastErr instanceof Error ? ` Last error: ${lastErr.message}` : ''),
                    ),
                    'error',
                    tried[tried.length - 1],
                );
                return;
            }
            try {
                this.senchoIp = getSenchoIpFromSubnet(chosen);
                this.meshSubnet = chosen;
            } catch (err) {
                // Hard-coded candidates are well-formed; defensive only.
                this.recordSetupFailure('subnet_invalid', err, 'error', chosen);
                return;
            }
        }

        try {
            await this.ensureSelfAttached();
        } catch (err) {
            this.recordSetupFailure(
                this.classifySelfAttachError(err),
                err,
                'error',
                this.meshSubnet,
            );
            return;
        }

        // `ensureSelfAttached` has non-throwing paths for the not-in-Docker
        // case (HOSTNAME unset / inspect 404). Those paths call
        // `recordSetupFailure` directly and leave `senchoIp` null, so a
        // null here means the data plane is intentionally disabled (dev
        // mode), not that the success path should run.
        if (!this.senchoIp) return;

        this.networkSetupError = null;
        this.dataPlaneStatus = { ok: true, reason: 'ok', message: null, subnet: this.meshSubnet };
    }

    /**
     * Return the subnet of an existing `sencho_mesh` network, or null if the
     * network does not exist. Docker's inspect endpoint surfaces 404 for
     * the missing case; any other error is re-raised so the caller can
     * classify it as `attach_failed`.
     */
    private async inspectExistingMeshSubnet(): Promise<string | null> {
        const dc = DockerController.getInstance(NodeRegistry.getInstance().getDefaultNodeId());
        try {
            const info = await dc.inspectNetwork(SENCHO_MESH_NETWORK) as {
                IPAM?: { Config?: Array<{ Subnet?: string }> };
            } | undefined;
            return info?.IPAM?.Config?.[0]?.Subnet ?? null;
        } catch (err) {
            const e = err as { statusCode?: number };
            if (e?.statusCode === 404) return null;
            throw err;
        }
    }

    /**
     * Create the `sencho_mesh` bridge network with the given subnet. Throws
     * the raw Dockerode error (including the 500 pool-overlap that
     * `classifyMeshNetworkError` recognises) so callers can decide whether
     * to retry on another candidate or bail.
     */
    private async createMeshNetwork(subnet: string): Promise<void> {
        const dc = DockerController.getInstance(NodeRegistry.getInstance().getDefaultNodeId());
        await dc.createNetwork({
            Name: SENCHO_MESH_NETWORK,
            Driver: 'bridge',
            Attachable: true,
            IPAM: { Config: [{ Subnet: subnet }] },
            Labels: { 'io.sencho.mesh': 'true' },
        });
    }

    /**
     * Connect Sencho's own container to `sencho_mesh` at the static IP. Uses
     * the `HOSTNAME` env var (which Docker sets to the container's short ID
     * by default) to identify the container, mirroring the
     * SelfUpdateService pattern. Skipped in dev mode where HOSTNAME is
     * the laptop hostname and the inspect lookup would fail.
     */
    private async ensureSelfAttached(): Promise<void> {
        if (!this.senchoIp) return;
        const hostname = process.env.HOSTNAME;
        if (!hostname) {
            this.recordSetupFailure(
                'not_in_docker',
                new Error('HOSTNAME unset; mesh routing disabled (not running in Docker?)'),
                'warn',
                this.meshSubnet,
            );
            return;
        }
        const dc = DockerController.getInstance(NodeRegistry.getInstance().getDefaultNodeId());
        try {
            await dc.connectContainerToNetwork(SENCHO_MESH_NETWORK, hostname, { ipv4Address: this.senchoIp });
        } catch (err) {
            const e = err as { statusCode?: number; message?: string };
            if (e?.statusCode === 404) {
                this.recordSetupFailure(
                    'not_in_docker',
                    new Error('self-container lookup failed (404); mesh routing disabled (not running in Docker?)'),
                    'warn',
                    this.meshSubnet,
                );
                return;
            }
            throw err;
        }
    }

    /**
     * Bind the forwarder's listeners to every alias port across the fleet
     * and release any listeners no longer in the alias set. Called from
     * `start`, after each `refreshAliasCache` tick, and after every
     * opt-in / opt-out / disable so the bound port set follows the DB
     * state.
     *
     * Every meshed node binds every alias port (not just ports it owns)
     * because alias DNS entries resolve to the SOURCE node's Sencho IP, so
     * the source node is where the inbound TCP connection lands.
     * `handleAccept` then dispatches to the same-node fast path or the
     * cross-node bridge based
     * on the resolved alias's owner. Fleet-wide port collisions are
     * blocked at opt-in time (`optInStack` checks `aliasByPort`), so
     * binding every alias port is unambiguous.
     */
    private async syncForwarderListeners(): Promise<void> {
        const localNodeId = NodeRegistry.getInstance().getDefaultNodeId();
        const wantPorts = new Set<number>(this.aliasByPort.keys());
        const havePorts = new Set(this.forwarder.getListenerPorts());
        for (const port of havePorts) {
            if (!wantPorts.has(port)) {
                await this.forwarder.unlisten(port);
                this.logActivity({
                    source: 'mesh', level: 'info', type: 'forwarder.unlisten',
                    nodeId: localNodeId, message: `forwarder released port ${port}`,
                });
            }
        }
        for (const port of wantPorts) {
            if (havePorts.has(port)) continue;
            try {
                await this.forwarder.listen(port);
                this.logActivity({
                    source: 'mesh', level: 'info', type: 'forwarder.listen',
                    nodeId: localNodeId, message: `forwarder listening on port ${port}`,
                });
            } catch (err) {
                this.logActivity({
                    source: 'mesh', level: 'error', type: 'forwarder.error',
                    nodeId: localNodeId,
                    message: `forwarder bind failed on port ${port}: ${sanitizeForLog((err as Error).message)}`,
                    details: { port },
                });
            }
        }
    }

    // --- Activity log ---

    public logActivity(event: Omit<MeshActivityEvent, 'ts'>): void {
        const full: MeshActivityEvent = { ts: Date.now(), ...event };
        this.activity.push(full);
        if (this.activity.length > ACTIVITY_BUFFER_SIZE) this.activity.shift();
        for (const listener of this.activityListeners) {
            try { listener(full); } catch { /* ignore */ }
        }
        if (event.alias && event.level === 'error') {
            this.routeErrorMap.set(event.alias, { ts: full.ts, message: event.message });
        }
    }

    public getActivity(filter?: { alias?: string; source?: MeshActivitySource; level?: MeshActivityLevel; limit?: number }): MeshActivityEvent[] {
        let out = this.activity;
        if (filter?.alias) out = out.filter((e) => e.alias === filter.alias);
        if (filter?.source) out = out.filter((e) => e.source === filter.source);
        if (filter?.level) out = out.filter((e) => e.level === filter.level);
        const limit = filter?.limit ?? 200;
        return out.slice(-limit);
    }

    public subscribeActivity(listener: (e: MeshActivityEvent) => void): () => void {
        this.activityListeners.add(listener);
        return () => { this.activityListeners.delete(listener); };
    }

    // --- Opt-in / opt-out ---

    public async optInStack(nodeId: number, stackName: string, actor: string): Promise<void> {
        if (!isValidStackName(stackName)) {
            throw new MeshError('denied', `invalid stack name: ${stackName}`);
        }
        if (!this.senchoIp) {
            throw new MeshError(
                'denied',
                this.networkSetupError || 'mesh data plane unavailable (mesh network setup did not complete)',
            );
        }
        const db = DatabaseService.getInstance();
        if (db.isMeshStackEnabled(nodeId, stackName)) return;

        const services = await this.inspectStackServices(nodeId, stackName);
        if (services.length === 0) {
            throw new MeshError('no_target', `stack ${stackName} has no running services on this node`);
        }

        const newPorts = new Set<number>();
        for (const svc of services) for (const p of svc.ports) newPorts.add(p);
        if (newPorts.size === 0) {
            throw new MeshError(
                'no_target',
                `stack ${stackName} has no service ports to mesh (every service declared ports: [])`,
            );
        }
        if (newPorts.has(SENCHO_LISTEN_PORT)) {
            throw new MeshError(
                'port_collision',
                `port ${SENCHO_LISTEN_PORT} is reserved for the Sencho API and cannot be used by a meshed service`,
            );
        }
        for (const port of newPorts) {
            const existing = this.aliasByPort.get(port);
            if (existing) {
                throw new MeshError(
                    'port_collision',
                    `port ${port} is already claimed by ${existing.host}`,
                );
            }
        }

        db.insertMeshStack(nodeId, stackName, actor);
        await this.refreshAliasCache();
        await this.syncForwarderListeners();

        // Push the just-opted-in stack's override loudly. If this fails the
        // DB state is invalid (alias claimed but remote pilot has no
        // override file) so roll back rather than leave a half-state that
        // future opt-in calls would short-circuit on `isMeshStackEnabled`.
        try {
            await this.pushOverrideToNode(nodeId, stackName);
        } catch (err) {
            db.deleteMeshStack(nodeId, stackName);
            await this.refreshAliasCache();
            await this.syncForwarderListeners();
            throw err;
        }
        // Regenerate every other meshed stack's override across the fleet
        // so they pick up the new alias entry. The just-opted-in stack was
        // already pushed above; skip the (nodeId, stackName) tuple to
        // avoid a duplicate round-trip. Best-effort; per-stack failures
        // surface as forwarder.error activity events.
        await this.regenerateOverridesAcrossFleet(nodeId, stackName);
        // Recompose every previously-meshed container so the new alias
        // actually lands in /etc/hosts. The override file alone is not
        // enough: extra_hosts is read at container creation, so prior
        // containers need to be recreated. Skip the just-opted-in tuple
        // because the explicit triggerRedeploy below already covers it.
        this.cascadeRecomposeAcrossFleet(nodeId, stackName, actor);
        this.triggerRedeploy(nodeId, stackName, actor);

        this.logActivity({
            source: 'mesh', level: 'info', type: 'opt_in',
            nodeId, message: `opt-in ${stackName}`, details: { actor },
        });
        db.insertAuditLog({
            timestamp: Date.now(), username: actor, method: 'POST',
            path: `/api/mesh/nodes/${nodeId}/stacks/${stackName}/opt-in`,
            status_code: 200, node_id: nodeId, ip_address: '127.0.0.1',
            summary: `Sencho Mesh: opted ${stackName} into the mesh`,
        });
    }

    public async optOutStack(nodeId: number, stackName: string, actor: string): Promise<void> {
        if (!isValidStackName(stackName)) {
            throw new MeshError('denied', `invalid stack name: ${stackName}`);
        }
        const db = DatabaseService.getInstance();
        if (!db.isMeshStackEnabled(nodeId, stackName)) return;
        db.deleteMeshStack(nodeId, stackName);
        await this.removeOverrideFromNode(nodeId, stackName);
        await this.refreshAliasCache();
        await this.syncForwarderListeners();
        // The opted-out row is already deleted, so listMeshStacks() will not
        // include it. Walk the remaining fleet-wide rows so every other
        // meshed stack regenerates its override without the dropped alias.
        await this.regenerateOverridesAcrossFleet();
        // Recompose every still-meshed container so the dropped alias
        // exits /etc/hosts. Skip args are absent because the opted-out
        // row is already gone from listMeshStacks; the explicit
        // triggerRedeploy below recomposes the opted-out stack itself
        // (with the override file removed) so its container drops the
        // entries it owned.
        this.cascadeRecomposeAcrossFleet(undefined, undefined, actor);
        this.triggerRedeploy(nodeId, stackName, actor);

        this.logActivity({
            source: 'mesh', level: 'info', type: 'opt_out',
            nodeId, message: `opt-out ${stackName}`, details: { actor },
        });
        db.insertAuditLog({
            timestamp: Date.now(), username: actor, method: 'POST',
            path: `/api/mesh/nodes/${nodeId}/stacks/${stackName}/opt-out`,
            status_code: 200, node_id: nodeId, ip_address: '127.0.0.1',
            summary: `Sencho Mesh: opted ${stackName} out of the mesh`,
        });
    }

    public async enableForNode(nodeId: number): Promise<void> {
        DatabaseService.getInstance().setNodeMeshEnabled(nodeId, true);
        this.logActivity({
            source: 'mesh', level: 'info', type: 'mesh.enable',
            nodeId, message: `mesh enabled on node ${nodeId}`,
        });
        // When mesh is enabled on a proxy peer, dial the persistent bridge
        // immediately so the next forward (or peer-initiated reverse)
        // request has the WS already up. Fire-and-forget; failures are
        // logged by the dialer.
        const node = DatabaseService.getInstance().getNode(nodeId);
        if (node && node.type === 'remote' && node.mode === 'proxy') {
            void MeshProxyTunnelDialer.getInstance().ensureBridge(nodeId).catch((err) => {
                console.warn(`[Mesh] proxy-tunnel dial on mesh-enable failed for node ${nodeId}: ${(err as Error).message}`);
            });
        }
    }

    public async disableForNode(
        nodeId: number,
        actor: string = 'system:mesh.disable',
    ): Promise<void> {
        DatabaseService.getInstance().setNodeMeshEnabled(nodeId, false);
        const stacks = DatabaseService.getInstance().listMeshStacks(nodeId);
        for (const s of stacks) {
            DatabaseService.getInstance().deleteMeshStack(nodeId, s.stack_name);
        }
        // Dispatch DELETE /api/mesh/local-override/:stack for remote nodes
        // (pilot or proxy) so the override file pushed earlier via
        // applyLocalOverride is removed; falls back to local deletion for
        // local nodes. Parallelize per the regenerateOverridesForNode
        // rationale: each remote call is its own HTTP round-trip, so
        // awaiting sequentially turns N stacks into N serialised DELETEs.
        // `allSettled` so a single failure does not abort the others
        // (removeOverrideFromNode already swallows errors internally).
        await Promise.allSettled(
            stacks.map((s) => this.removeOverrideFromNode(nodeId, s.stack_name)),
        );
        await this.refreshAliasCache();
        await this.syncForwarderListeners();
        // Mirror optOutStack: regenerate every remaining node's override
        // without the dropped aliases, recompose the rest of the fleet so
        // their containers shed the stale extra_hosts, and redeploy the
        // disabled node's own stacks so their containers detach from the
        // sencho_mesh network and lose the alias entries they owned.
        await this.regenerateOverridesAcrossFleet();
        this.cascadeRecomposeAcrossFleet(undefined, undefined, actor);
        for (const s of stacks) {
            this.triggerRedeploy(nodeId, s.stack_name, actor);
        }
        this.logActivity({
            source: 'mesh', level: 'info', type: 'mesh.disable',
            nodeId, message: `mesh disabled on node ${nodeId}`,
        });
    }

    // --- Override file management ---

    public async ensureStackOverride(nodeId: number, stackName: string): Promise<string | null> {
        if (!isValidStackName(stackName)) return null;
        const db = DatabaseService.getInstance();
        const dir = this.overrideDirFor(nodeId);
        if (!db.isMeshStackEnabled(nodeId, stackName)) {
            // Pilot nodes intentionally have no mesh_stacks rows (opt-in state
            // lives on central per the C-3 design). Use file-presence as the
            // fallback: if central pushed an override via applyLocalOverride, return
            // that path so ComposeService picks it up on the next deploy.
            const file = path.resolve(dir, `${path.basename(stackName)}.override.yml`);
            if (!isPathWithinBase(file, dir)) return null;
            try {
                await fs.access(file);
                return file;
            } catch {
                return null;
            }
        }
        if (!this.senchoIp) return null;

        const aliases: MeshAlias[] = Array.from(this.aliasCache.values()).map((a) => ({ host: a.host }));
        const serviceNames = await this.getDeclaredStackServiceNames(stackName, nodeId);

        await fs.mkdir(dir, { recursive: true });
        // path.basename mirrors the applyLocalOverride pattern (and is
        // the form CodeQL's path-injection model recognizes).
        const file = path.resolve(dir, `${path.basename(stackName)}.override.yml`);
        if (!isPathWithinBase(file, dir)) return null;

        // Defensive fallback: a deploy that runs `compose down` immediately
        // before `compose up` removes the containers, but the compose file
        // is still on disk so getDeclaredStackServiceNames returns the
        // declared services. The fallback below covers the much narrower
        // case where the compose file itself is unreadable (permission
        // glitch, transient FS error, mid-write rename); in that case
        // keep any existing override rather than overwrite with `services: {}`.
        if (serviceNames.length === 0) {
            const existing = await this.readExistingOverrideServiceNames(dir, stackName);
            if (existing.length > 0) {
                this.logActivity({
                    source: 'mesh', level: 'warn', type: 'mesh.override.preserved',
                    nodeId,
                    message: `mesh override preserved for ${stackName}: declared services unreadable, keeping ${existing.length} existing entries`,
                    details: { stackName, preservedServices: existing },
                });
                return file;
            }
        }

        const yaml = generateOverrideYaml({
            services: serviceNames,
            aliases,
            senchoIp: this.senchoIp,
        });
        await fs.writeFile(file, yaml, 'utf8');
        return file;
    }

    /**
     * Render and write a mesh override on the LOCAL node's filesystem from
     * a fleet-wide alias list supplied by central. The pilot looks up its
     * own service names and uses its own static IP, so each node's
     * override resolves alias hostnames to that node's local Sencho.
     * This is critical because each node has its own `sencho_mesh`
     * network with its own subnet. Returns the absolute path on success
     * or null if path validation rejects the input.
     */
    public async applyLocalOverride(
        stackName: string,
        aliases: MeshAlias[],
        portAliases?: MeshGlobalAlias[],
    ): Promise<string | null> {
        if (!isValidStackName(stackName)) return null;
        if (!this.senchoIp) {
            throw new MeshError(
                'push_failed',
                this.networkSetupError || 'mesh data plane unavailable on this node',
            );
        }
        const localNodeId = NodeRegistry.getInstance().getDefaultNodeId();
        const serviceNames = await this.getDeclaredStackServiceNames(stackName, localNodeId);

        const dir = this.overrideDirFor(localNodeId);
        await fs.mkdir(dir, { recursive: true });
        // path.basename strips any directory component as defense-in-depth
        // on top of isValidStackName + isPathWithinBase. Recognized by
        // CodeQL's path-injection model.
        const file = path.resolve(dir, `${path.basename(stackName)}.override.yml`);
        if (!isPathWithinBase(file, dir)) return null;

        // Defensive fallback (mirror of ensureStackOverride): keep any
        // existing override when the compose file is transiently
        // unreadable. The remote that pushed this update will retry on
        // its next regen tick, so a one-shot read failure should not
        // wipe out a working override.
        if (serviceNames.length === 0) {
            const existing = await this.readExistingOverrideServiceNames(dir, stackName);
            if (existing.length > 0) {
                this.logActivity({
                    source: 'mesh', level: 'warn', type: 'mesh.override.preserved',
                    nodeId: localNodeId,
                    message: `mesh override preserved for ${stackName}: declared services unreadable, keeping ${existing.length} existing entries`,
                    details: { stackName, preservedServices: existing },
                });
                return file;
            }
        }

        const yaml = generateOverrideYaml({
            services: serviceNames,
            aliases,
            senchoIp: this.senchoIp,
        });
        await fs.writeFile(file, yaml, 'utf8');
        if (portAliases && portAliases.length > 0) {
            this.pilotAliasOverlay.set(stackName, portAliases);
            await this.refreshAliasCache();
            await this.syncForwarderListeners();
        }
        return file;
    }

    /**
     * Delete a previously applied local override (mirror of
     * `applyLocalOverride`). Used by central when a stack is opted out.
     */
    public async removeLocalOverride(stackName: string): Promise<void> {
        if (!isValidStackName(stackName)) return;
        const localNodeId = NodeRegistry.getInstance().getDefaultNodeId();
        const dir = this.overrideDirFor(localNodeId);
        const file = path.resolve(dir, `${path.basename(stackName)}.override.yml`);
        if (!isPathWithinBase(file, dir)) return;
        try { await fs.unlink(file); } catch { /* ignore not-exist */ }
        if (this.pilotAliasOverlay.delete(stackName)) {
            await this.refreshAliasCache();
            await this.syncForwarderListeners();
        }
    }

    private async removeStackOverride(nodeId: number, stackName: string): Promise<void> {
        if (!isValidStackName(stackName)) return;
        const dir = this.overrideDirFor(nodeId);
        const file = path.resolve(dir, `${path.basename(stackName)}.override.yml`);
        if (!isPathWithinBase(file, dir)) return;
        try { await fs.unlink(file); } catch { /* ignore not-exist */ }
    }

    private overrideDirFor(nodeId: number): string {
        const dataDir = process.env.DATA_DIR || '/app/data';
        return path.join(dataDir, 'mesh', 'overrides', String(nodeId));
    }

    private async regenerateOverridesForNode(nodeId: number, skipStack?: string): Promise<void> {
        const db = DatabaseService.getInstance();
        const stacks = db.listMeshStacks(nodeId);
        // Push all overrides in parallel: each remote-node call is its own
        // HTTP round-trip, so awaiting sequentially turns N stacks into N
        // serialised PUTs. `allSettled` so a single failure does not abort
        // the others.
        await Promise.allSettled(
            stacks
                .filter((s) => s.stack_name !== skipStack)
                .map(async (s) => {
                    try {
                        await this.pushOverrideToNode(nodeId, s.stack_name);
                    } catch (err) {
                        console.warn('[MeshService] override push failed:', sanitizeForLog((err as Error).message));
                    }
                }),
        );
    }

    /**
     * Walk every `mesh_stacks` row across the fleet and re-push each override.
     * Called from optInStack / optOutStack so a new or removed alias
     * propagates to every meshed node's override file in one pass, not just
     * the node whose row changed. Best-effort: per-stack failures emit a
     * forwarder.error activity event and the other nodes still get
     * regenerated. An offline remote node leaves stale overrides until the
     * next opt-in / opt-out, the next tunnel reconnect, or a manual
     * `POST /api/mesh/regen-overrides`.
     */
    private async regenerateOverridesAcrossFleet(
        skipNodeId?: number,
        skipStack?: string,
    ): Promise<void> {
        const db = DatabaseService.getInstance();
        const stacks = db.listMeshStacks();
        await Promise.allSettled(
            stacks
                .filter((s) => !(s.node_id === skipNodeId && s.stack_name === skipStack))
                .map(async (s) => {
                    try {
                        await this.pushOverrideToNode(s.node_id, s.stack_name);
                    } catch (err) {
                        const message = sanitizeForLog((err as Error).message);
                        this.logActivity({
                            source: 'mesh', level: 'warn', type: 'forwarder.error',
                            nodeId: s.node_id,
                            message: `cascade override push failed for ${s.stack_name}: ${message}`,
                            details: { stackName: s.stack_name },
                        });
                    }
                }),
        );
    }

    /**
     * Walk every `mesh_stacks` row across the fleet and fire a redeploy for
     * each, skipping the (skipNodeId, skipStack) tuple. Called from
     * optInStack / optOutStack after `regenerateOverridesAcrossFleet` so
     * previously-meshed containers actually pick up the new or removed
     * alias entries in `/etc/hosts`. Without this, override `.yml` files on
     * disk reflect the new alias set but the running containers still hold
     * the alias set they had at last compose, so cross-stack DNS silently
     * fails until an operator redeploys every prior stack by hand.
     *
     * Each `triggerRedeploy` call is fire-and-forget. Local stacks route
     * through `ComposeService.deployStack`, remote stacks through
     * `POST /api/stacks/:name/deploy` via the proxy chain. Failures land in
     * the mesh activity ring buffer and the audit log, so one slow or
     * offline peer cannot block other targets.
     *
     * This is intentionally not invoked from `regenerateAllOverrides`
     * (boot and manual `/regen-overrides`). A Sencho restart must not
     * force a fleet-wide recompose of every meshed stack; the override
     * files alone are sufficient there.
     *
     * Pacing: the cascade fans out in parallel. For the v1 mesh-stack
     * counts (single-digit to low teens per host) this is fine; Docker's
     * daemon serializes the contention that matters. If real-world fleets
     * routinely exceed ~20 meshed stacks on one host, swap the loop for a
     * `p-limit(4)` semaphore keyed on `node_id` (no test rewiring needed).
     */
    private cascadeRecomposeAcrossFleet(
        skipNodeId: number | undefined,
        skipStack: string | undefined,
        actor: string,
    ): void {
        const db = DatabaseService.getInstance();
        const targets = db.listMeshStacks().filter(
            (s) => !(s.node_id === skipNodeId && s.stack_name === skipStack),
        );
        if (targets.length === 0) return;

        for (const t of targets) {
            this.triggerRedeploy(t.node_id, t.stack_name, actor);
        }

        const nodeIds = new Set(targets.map((t) => t.node_id));
        const skippedNote = skipNodeId !== undefined && skipStack !== undefined
            ? ` (skipped ${skipStack} on node ${skipNodeId})`
            : '';
        this.logActivity({
            source: 'mesh', level: 'info', type: 'mesh.enable',
            message: `mesh cascade recompose: ${targets.length} stack${targets.length === 1 ? '' : 's'} across ${nodeIds.size} node${nodeIds.size === 1 ? '' : 's'}${skippedNote}`,
            details: {
                cascadeRecomposes: targets.length,
                nodeCount: nodeIds.size,
                skipNodeId: skipNodeId ?? null,
                skipStack: skipStack ?? null,
            },
        });
    }

    /**
     * Walk every `mesh_stacks` row across the fleet and re-push each override
     * to its owning node. Called once at boot so on-disk override files
     * survive a Sencho restart even if they were lost (image rebuild, volume
     * reset, manual cleanup). Also exposed as `POST /api/mesh/regen-overrides`
     * so an operator can rerun it after fixing a remote node that was offline
     * at boot. Best-effort: failures are logged per-stack and other nodes
     * still get regenerated. An offline remote node leaves stale overrides
     * until the next opt-in / opt-out on that node, or the next manual rerun.
     */
    public async regenerateAllOverrides(): Promise<MeshRegenSummary> {
        if (!this.senchoIp) {
            const reason = this.networkSetupError ?? 'mesh data plane unavailable';
            this.logActivity({
                source: 'mesh', level: 'warn', type: 'mesh.disable',
                message: `mesh override regen skipped: data plane unavailable (${sanitizeForLog(reason)})`,
            });
            return { regenerated: 0, failures: [], skipped: true, reason };
        }
        const db = DatabaseService.getInstance();
        const stacks = db.listMeshStacks();
        const failures: MeshRegenFailure[] = [];
        await Promise.allSettled(
            stacks.map(async (s) => {
                try {
                    await this.pushOverrideToNode(s.node_id, s.stack_name);
                } catch (err) {
                    const message = sanitizeForLog((err as Error).message);
                    failures.push({ nodeId: s.node_id, stackName: s.stack_name, message });
                    this.logActivity({
                        source: 'mesh', level: 'warn', type: 'forwarder.error',
                        nodeId: s.node_id,
                        message: `mesh override regen failed for ${s.stack_name}: ${message}`,
                        details: { stackName: s.stack_name },
                    });
                }
            }),
        );
        const succeeded = stacks.length - failures.length;
        const failedNodeIds = Array.from(new Set(failures.map((f) => f.nodeId))).sort((a, b) => a - b);
        this.logActivity({
            source: 'mesh', level: failures.length === 0 ? 'info' : 'warn', type: 'mesh.enable',
            message: `mesh override regen complete: ${succeeded} succeeded, ${failures.length} failed across ${failedNodeIds.length} node(s)`,
            details: { succeeded, failed: failures.length, failedNodeIds },
        });
        return { regenerated: succeeded, failures, skipped: false };
    }

    // --- Alias aggregation ---

    public async refreshAliasCache(): Promise<void> {
        const db = DatabaseService.getInstance();
        const next = new Map<string, MeshGlobalAlias>();
        const portMap = new Map<number, MeshGlobalAlias>();
        const stacks = db.listMeshStacks();

        // Inspect all stacks in parallel; each remote-node lookup involves an
        // HTTP fetch with its own 5 s AbortSignal. Sequential awaiting would
        // let one slow node stall the whole refresh, which is on a 60 s loop.
        const inspections = await Promise.allSettled(
            stacks.map(async (row) => {
                const node = db.getNode(row.node_id);
                if (!node) return null;
                const services = await this.inspectStackServices(row.node_id, row.stack_name);
                return { row, node, services };
            }),
        );
        for (const result of inspections) {
            if (result.status !== 'fulfilled' || !result.value) continue;
            const { row, node, services } = result.value;
            for (const svc of services) {
                const host = `${svc.service}.${row.stack_name}.${node.name}.sencho`;
                for (const port of svc.ports) {
                    const alias: MeshGlobalAlias = {
                        host,
                        nodeId: row.node_id,
                        nodeName: node.name,
                        stackName: row.stack_name,
                        serviceName: svc.service,
                        port,
                    };
                    next.set(host, alias);
                    if (!portMap.has(port)) portMap.set(port, alias);
                }
            }
        }
        // Merge pilot overlay. Invariant: on central, pilotAliasOverlay is
        // always empty (DB is authoritative); on pilots, db.listMeshStacks()
        // returns empty (C-3), so the two populations are mutually exclusive
        // and the first-write-wins portMap policy is safe.
        for (const overlayAliases of this.pilotAliasOverlay.values()) {
            for (const alias of overlayAliases) {
                next.set(alias.host, alias);
                if (!portMap.has(alias.port)) portMap.set(alias.port, alias);
            }
        }
        this.aliasCache = next;
        this.aliasByPort = portMap;
    }

    public async listAliases(): Promise<MeshGlobalAlias[]> {
        return Array.from(this.aliasCache.values());
    }

    /**
     * Read the local stack's compose file and return its declared service
     * names. Used by the override-write paths so a deploy that has just
     * torn containers down still emits a complete services map even
     * though Dockerode briefly returns no containers. Independent of
     * runtime container state, so the override stays correct across the
     * deploy lifecycle.
     *
     * Returns [] when the compose file is missing, unreadable, or fails
     * to parse. Combined with the defensive fallback in
     * {@link ensureStackOverride} / {@link applyLocalOverride} a transient
     * empty result does not clobber a known-good override.
     *
     * LIMITATION: stacks that pull services in via compose `extends:` or
     * `include:` will not have those external services covered. The
     * top-level YAML.parse is sufficient for the supported compose
     * shapes; if extends/include usage emerges, swap to
     * `docker compose config --services` (subprocess).
     */
    public async getDeclaredStackServiceNames(stackName: string, nodeId?: number): Promise<string[]> {
        if (!isValidStackName(stackName)) return [];
        const targetNodeId = nodeId ?? NodeRegistry.getInstance().getDefaultNodeId();
        try {
            const fsSvc = FileSystemService.getInstance(targetNodeId);
            const filename = await fsSvc.getComposeFilename(stackName);
            const baseDir = fsSvc.getBaseDir();
            // path.basename strips any directory component as defense-in-depth
            // on top of isValidStackName + isPathWithinBase. Recognized by
            // CodeQL's path-injection model.
            const composePath = path.join(baseDir, path.basename(stackName), filename);
            if (!isPathWithinBase(composePath, baseDir)) return [];
            const content = await fs.readFile(composePath, 'utf8');
            const parsed = YAML.parse(content) as { services?: Record<string, unknown> } | null;
            const services = parsed?.services && typeof parsed.services === 'object' ? parsed.services : null;
            if (!services) return [];
            return Object.keys(services).filter((name) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name));
        } catch (err) {
            console.warn(
                '[MeshService] getDeclaredStackServiceNames failed:',
                sanitizeForLog((err as Error).message),
            );
            return [];
        }
    }

    /**
     * Parse an existing mesh override file and extract the service names
     * it already lists. Used by the defensive fallback so a transient
     * empty compose-file read does not clobber a known-good override.
     * Takes (dir, stackName) rather than a pre-built filePath so the
     * path-injection sanitizer pattern (path.basename + isPathWithinBase)
     * lives next to the read sink and stays recognizable to CodeQL.
     */
    private async readExistingOverrideServiceNames(dir: string, stackName: string): Promise<string[]> {
        const file = path.resolve(dir, `${path.basename(stackName)}.override.yml`);
        if (!isPathWithinBase(file, dir)) return [];
        try {
            const content = await fs.readFile(file, 'utf8');
            const parsed = YAML.parse(content) as { services?: Record<string, unknown> } | null;
            const services = parsed?.services && typeof parsed.services === 'object' ? parsed.services : null;
            if (!services) return [];
            return Object.keys(services);
        } catch {
            return [];
        }
    }

    /**
     * Inspect a stack and return its running services with the ports they
     * listen on. For the LOCAL Docker daemon only; callers targeting a
     * remote node must use {@link inspectStackServices}, which dispatches
     * via the HTTP proxy to the remote's `/api/mesh/local-services/:stack`.
     */
    public async inspectLocalStackServices(stackName: string): Promise<Array<{ service: string; ports: number[] }>> {
        try {
            const docker = DockerController.getInstance().getDocker();
            const containers = await docker.listContainers({
                all: true,
                filters: { label: [`com.docker.compose.project=${stackName}`] },
            });
            const byService = new Map<string, Set<number>>();
            for (const c of containers) {
                const svc = c.Labels?.['com.docker.compose.service'];
                if (!svc) continue;
                const ports = byService.get(svc) || new Set<number>();
                for (const p of c.Ports || []) {
                    if (p.PrivatePort) ports.add(p.PrivatePort);
                }
                byService.set(svc, ports);
            }
            return Array.from(byService.entries()).map(([service, ports]) => ({ service, ports: Array.from(ports) }));
        } catch (err) {
            console.warn('[MeshService] inspectLocalStackServices failed:', sanitizeForLog((err as Error).message));
            return [];
        }
    }

    /**
     * Inspect a stack on a (possibly remote) node and return its running
     * services with the ports they listen on. Local nodes hit Dockerode
     * directly; remote nodes (proxy mode and pilot-agent) reach their own
     * Sencho's `/api/mesh/local-services/:stackName` via the existing
     * `NodeRegistry.getProxyTarget` resolution chain because Dockerode is not
     * directly reachable for remote nodes by design.
     */
    private async inspectStackServices(nodeId: number, stackName: string): Promise<Array<{ service: string; ports: number[] }>> {
        const node = DatabaseService.getInstance().getNode(nodeId);
        if (!node) return [];
        if (node.type !== 'remote') return this.inspectLocalStackServices(stackName);

        try {
            const res = await this.proxyFetch(
                nodeId,
                'GET',
                `/api/mesh/local-services/${encodeURIComponent(stackName)}`,
                undefined,
                5_000,
            );
            if (!res.ok) {
                console.error(`[MeshService] inspectStackServices: HTTP ${res.status} from node ${nodeId} (${sanitizeForLog(node.name)})`);
                return [];
            }
            const body = await res.json() as { services?: Array<{ service: string; ports: number[] }> };
            return body.services ?? [];
        } catch (err) {
            // proxyFetch throws MeshError('no_target') when getProxyTarget
            // returns null (pilot tunnel offline, proxy bridge unreachable)
            // and MeshError('push_failed') on a non-OK HTTP response. Treat
            // both as a soft "no services to report" so the Routing tab does
            // not surface a stack trace for a node that is simply offline.
            if (err instanceof MeshError && (err.code === 'no_target' || err.code === 'push_failed')) {
                console.warn(`[MeshService] inspectStackServices: unreachable node ${nodeId} (${sanitizeForLog(node.name)}): ${err.code}`);
                return [];
            }
            console.error('[MeshService] inspectStackServices remote unreachable:', sanitizeForLog((err as Error).message));
            return [];
        }
    }

    public async listLocalStacks(): Promise<string[]> {
        const localNodeId = NodeRegistry.getInstance().getDefaultNodeId();
        return FileSystemService.getInstance(localNodeId).getStacks();
    }

    /**
     * Local nodes read the filesystem; remote nodes fetch their own
     * Sencho's `/api/mesh/local-stacks` because the remote's compose
     * directory is not visible from central (pilot's filesystem lives
     * on a different host).
     */
    public async listStacksOnNode(nodeId: number): Promise<string[]> {
        const node = DatabaseService.getInstance().getNode(nodeId);
        if (!node) return [];
        if (node.type !== 'remote') return this.listLocalStacks();

        try {
            const res = await this.proxyFetch(nodeId, 'GET', '/api/mesh/local-stacks', undefined, 5_000);
            if (!res.ok) {
                console.error(`[MeshService] listStacksOnNode: HTTP ${res.status} from node ${nodeId} (${sanitizeForLog(node.name)})`);
                return [];
            }
            const body = await res.json() as { stacks?: unknown };
            if (!Array.isArray(body.stacks)) return [];
            return body.stacks.filter((s): s is string => typeof s === 'string');
        } catch (err) {
            if (err instanceof MeshError && err.code === 'no_target') {
                console.warn(`[MeshService] listStacksOnNode: no proxy target for node ${nodeId} (${sanitizeForLog(node.name)})`);
                return [];
            }
            console.error('[MeshService] listStacksOnNode remote unreachable:', sanitizeForLog((err as Error).message));
            return [];
        }
    }

    /**
     * Build a `fetch` against a remote Sencho's API with the bearer token
     * and the proxy tier/variant headers in place. Centralizes the header
     * shape so a future addition (license header, audit context) only
     * needs to land in one place.
     *
     * `x-node-id` is deliberately NOT set: callers target the remote
     * Sencho's own routes, which operate against the remote's local node
     * id. The bearer token alone authenticates.
     */
    private async proxyFetch(
        nodeId: number,
        method: 'GET' | 'PUT' | 'POST' | 'DELETE',
        apiPath: string,
        body: unknown,
        timeoutMs: number,
    ): Promise<Response> {
        const target = NodeRegistry.getInstance().getProxyTarget(nodeId);
        if (!target) throw new MeshError('no_target', `no proxy target for node ${nodeId}`);
        const url = `${target.apiUrl.replace(/\/$/, '')}${apiPath}`;
        const headers: Record<string, string> = {};
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (target.apiToken) headers['Authorization'] = `Bearer ${target.apiToken}`;
        const proxyHeaders = LicenseService.getInstance().getProxyHeaders();
        headers[PROXY_TIER_HEADER] = proxyHeaders.tier;
        headers[PROXY_VARIANT_HEADER] = proxyHeaders.variant || '';
        return await fetch(url, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
    }

    /**
     * Place a mesh override for a stack on whichever node owns it:
     *   - local node: regenerates via `ensureStackOverride`, which uses
     *     central's own senchoIp (correct because central is the node
     *     deploying that stack).
     *   - remote node: sends the fleet-wide alias list to the remote's
     *     `PUT /api/mesh/local-override/:stackName`; the remote renders
     *     the YAML using its OWN local senchoIp and writes it under its
     *     own DATA_DIR. This is essential because each node has its own
     *     `sencho_mesh` network and may be configured with a different
     *     SENCHO_MESH_SUBNET, so alias hostnames must always resolve to
     *     the local Sencho IP on the deploying node.
     *
     * Throws on remote push failure so callers (opt-in / opt-out) can abort
     * cleanly rather than silently leaving stale overrides.
     */
    public async pushOverrideToNode(nodeId: number, stackName: string): Promise<void> {
        const node = DatabaseService.getInstance().getNode(nodeId);
        if (!node) throw new MeshError('denied', `unknown node ${nodeId}`);

        if (node.type !== 'remote') {
            await this.ensureStackOverride(nodeId, stackName);
            return;
        }

        const portAliases: MeshGlobalAlias[] = Array.from(this.aliasCache.values());
        const aliases: MeshAlias[] = portAliases.map((a) => ({ host: a.host }));
        const res = await this.proxyFetch(
            nodeId,
            'PUT',
            `/api/mesh/local-override/${encodeURIComponent(stackName)}`,
            { aliases, portAliases },
            5_000,
        );
        if (res.status === 404) {
            throw new MeshError(
                'push_failed',
                `node ${node.name} does not support mesh override push (upgrade required)`,
            );
        }
        if (!res.ok) {
            throw new MeshError('push_failed', `HTTP ${res.status} from node ${node.name}`);
        }
    }

    /**
     * Fire-and-forget redeploy of a stack on whichever node owns it. Used
     * by opt-in and opt-out so the new alias entries reach the user
     * containers' /etc/hosts without an operator manually clicking deploy.
     *
     * For local stacks: invokes `ComposeService.deployStack` directly.
     * For remote stacks: HTTP POSTs to `<apiUrl>/api/stacks/:name/deploy`
     * via the same bearer-token pattern the rest of the proxy chain uses.
     *
     * Errors are logged to the mesh activity buffer rather than thrown so
     * the opt-in or opt-out call site can return success quickly. The
     * operator sees the redeploy progress through the existing deploy
     * stream surfaces; if it fails, the activity log records why.
     */
    public triggerRedeploy(nodeId: number, stackName: string, actor: string): void {
        void this.runRedeploy(nodeId, stackName, actor).catch((err) => {
            const reason = sanitizeForLog((err as Error).message);
            this.logActivity({
                source: 'mesh', level: 'error', type: 'forwarder.error',
                nodeId,
                message: `mesh redeploy failed for ${stackName}: ${reason}`,
                details: { actor, stackName },
            });
            // Also drop a durable audit row so an operator who walks away
            // from the toast still has a trail. The activity ring buffer
            // alone gets pruned at 1000 events.
            DatabaseService.getInstance().insertAuditLog({
                timestamp: Date.now(), username: actor, method: 'POST',
                path: `/api/mesh/nodes/${nodeId}/stacks/${stackName}/redeploy`,
                status_code: 500, node_id: nodeId, ip_address: '127.0.0.1',
                summary: `Sencho Mesh: redeploy failed for ${stackName}: ${reason}`,
            });
        });
    }

    private async runRedeploy(nodeId: number, stackName: string, actor: string): Promise<void> {
        const node = DatabaseService.getInstance().getNode(nodeId);
        if (!node) throw new Error(`unknown node ${nodeId}`);

        if (node.type !== 'remote') {
            await assertPolicyGateAllows(
                stackName,
                nodeId,
                buildSystemPolicyGateOptions(actor, {
                    auditPath: `/api/mesh/nodes/${nodeId}/stacks/${stackName}/redeploy`,
                }),
            );
            await ComposeService.getInstance(nodeId).deployStack(stackName);
            this.logActivity({
                source: 'mesh', level: 'info', type: 'mesh.enable',
                nodeId,
                message: `mesh redeploy ok for ${stackName}`,
                details: { actor, stackName },
            });
            return;
        }

        // Mesh redeploys are bounded by docker compose's own runtime; pick a
        // generous ceiling rather than the 5 s default used for control-plane
        // calls so a slow image pull does not abort the redeploy.
        const res = await this.proxyFetch(
            nodeId,
            'POST',
            `/api/stacks/${encodeURIComponent(stackName)}/deploy`,
            {},
            10 * 60 * 1000,
        );
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status} from node ${node.name}: ${body.slice(0, 256)}`);
        }
        this.logActivity({
            source: 'mesh', level: 'info', type: 'mesh.enable',
            nodeId,
            message: `mesh redeploy ok for ${stackName}`,
            details: { actor, stackName },
        });
    }

    public async removeOverrideFromNode(nodeId: number, stackName: string): Promise<void> {
        const node = DatabaseService.getInstance().getNode(nodeId);
        if (!node) return;

        if (node.type !== 'remote') {
            await this.removeStackOverride(nodeId, stackName);
            return;
        }

        try {
            await this.proxyFetch(
                nodeId,
                'DELETE',
                `/api/mesh/local-override/${encodeURIComponent(stackName)}`,
                undefined,
                5_000,
            );
        } catch (err) {
            console.warn('[MeshService] removeOverrideFromNode failed:', sanitizeForLog((err as Error).message));
        }
    }

    // --- Resolution + forwarding ---

    public resolveByLocalPort(port: number): MeshTarget | null {
        const alias = this.aliasByPort.get(port);
        if (!alias) return null;
        return {
            nodeId: alias.nodeId,
            stack: alias.stackName,
            service: alias.serviceName,
            port: alias.port,
            alias: alias.host,
        };
    }

    /**
     * MeshForwarder calls this on every accepted inbound socket. Resolves
     * the alias by destination port, then dispatches to the same-node fast
     * path or the cross-node bridge path.
     */
    public async handleAccept(port: number, src: net.Socket): Promise<void> {
        const target = this.resolveByLocalPort(port);
        if (!target) {
            this.logActivity({
                source: 'mesh', level: 'warn', type: 'route.resolve.denied',
                message: `inbound on port ${port} has no registered alias`,
                details: { port, remoteAddr: src.remoteAddress ?? '' },
            });
            try { src.destroy(); } catch { /* ignore */ }
            return;
        }
        // Resolution order: active proxy-tunnel install > boot-time enroll
        // token > local DB default. The proxy-tunnel value is the most
        // authoritative when present because the upstream central just told
        // this peer how it sees it; the enroll token covers pilot mode; the
        // default-node fallback covers central itself.
        const selfNodeId =
            this.proxyTunnelSelfCentralNodeId
            ?? this.selfCentralNodeId
            ?? NodeRegistry.getInstance().getDefaultNodeId();
        if (target.nodeId === selfNodeId) {
            await this.openSameNode(target, src);
        } else {
            await this.openCrossNode(target, src);
        }
    }

    /**
     * Same-node forward: dial the target container's bridge IP directly.
     * Sencho joins the `sencho_mesh` Docker bridge network alongside the
     * meshed user containers, so it can reach their bridge IPs without
     * going through any host-port publish. Looks up the container by
     * Compose's `<project>-<service>-<index>` naming convention; falls
     * back to a label-filtered listContainers if the conventional name
     * is absent (e.g. when the operator overrode the project name).
     */
    private async openSameNode(target: MeshTarget, src: net.Socket): Promise<void> {
        const ip = await this.resolveContainerIp(target);
        if (!ip) {
            this.logActivity({
                source: 'mesh', level: 'error', type: 'route.resolve.denied',
                alias: target.alias,
                message: `cannot resolve container IP for ${target.alias}`,
            });
            try { src.destroy(); } catch { /* ignore */ }
            return;
        }
        const upstream = net.createConnection({ host: ip, port: target.port });
        upstream.setTimeout(PROBE_TIMEOUT_MS);
        const stream = this.registerActiveStream(target.alias);
        upstream.once('connect', () => {
            upstream.setTimeout(0);
            this.logActivity({
                source: 'mesh', level: 'info', type: 'route.resolve.ok',
                alias: target.alias, streamId: stream.streamId,
                message: `same-node connect to ${target.alias} (${ip}:${target.port})`,
            });
            src.pipe(upstream);
            upstream.pipe(src);
        });
        const teardown = () => {
            this.activeStreams.delete(stream.streamId);
            try { upstream.destroy(); } catch { /* ignore */ }
            try { src.destroy(); } catch { /* ignore */ }
        };
        upstream.on('error', () => teardown());
        upstream.on('close', () => teardown());
        src.on('error', () => teardown());
        src.on('close', () => teardown());
    }

    /**
     * Find the bridge-network IP of the first container of
     * `<stack>/<service>`. Public so the central-side
     * `PilotTunnelBridge` reverse-open handler (Phase B) can dial the same
     * target shape when a pilot's mesh forwarder routes traffic back to
     * central.
     */
    public async resolveContainerIp(target: { stack: string; service: string }): Promise<string | null> {
        const docker = DockerController.getInstance().getDocker() as unknown as Parameters<typeof lookupContainerIp>[0];
        try {
            return await lookupContainerIp(docker, target.stack, target.service);
        } catch (err) {
            console.warn('[MeshService] container IP lookup failed:', sanitizeForLog((err as Error).message));
            return null;
        }
    }

    /**
     * Pluggable reverse dialer. Set by `PilotAgent` on a pilot host or by
     * the proxy-mode WS handler when a `/api/mesh/proxy-tunnel` upgrade
     * comes in; left null on a central host with no inbound mesh tunnel.
     * When set, `openCrossNode` routes outbound mesh dials through the
     * dialer's `tcp_open_reverse` path; when unset, `openCrossNode` uses
     * the central-side `PilotTunnelManager.getBridge` directly. Lets the
     * same MeshService code work on both sides.
     */
    private reverseDialer: ReverseMeshDialer | null = null;

    /**
     * Install or clear the reverse dialer. Supports compare-and-swap via
     * the optional `expected` argument so a caller (e.g., the proxy-mode
     * WS handler) can install on a null slot and uninstall only if its
     * own dialer is still the active one. Without the `expected` arg the
     * operation is unconditional (used by the pilot agent at boot).
     *
     * Returns true when the swap happened, false when the CAS rejected
     * because `expected` did not match the current dialer.
     */
    public setReverseDialer(dialer: ReverseMeshDialer | null, expected?: ReverseMeshDialer | null): boolean {
        if (expected !== undefined && this.reverseDialer !== expected) return false;
        // Loud warn instead of silent overwrite: pilot and proxy modes are
        // mutually exclusive by topology, so this branch indicates a
        // misconfigured deployment rather than an expected race.
        if (expected === undefined && dialer !== null && this.reverseDialer !== null && this.reverseDialer !== dialer) {
            console.warn('[MeshService] reverse dialer overwritten without CAS; pilot/proxy mode race or duplicate install');
        }
        this.reverseDialer = dialer;
        return true;
    }

    /**
     * Install (or clear) the central-namespace nodeId communicated by the
     * upstream central at proxy-tunnel upgrade. Called by the proxy-tunnel
     * WS handler; cleared on disconnect. Consumed by `handleAccept` to
     * dispatch cross-node aliases correctly on proxy peers.
     *
     * The caller is implicitly single-tenant: it runs only after
     * `setReverseDialer`'s CAS install succeeds (slot already guarded). A
     * second non-null install while a different non-null value is present
     * indicates a misconfigured deployment, so we warn loudly instead of
     * silently overwriting.
     */
    public setProxyTunnelSelfCentralNodeId(nodeId: number | null): void {
        if (
            nodeId !== null
            && this.proxyTunnelSelfCentralNodeId !== null
            && this.proxyTunnelSelfCentralNodeId !== nodeId
        ) {
            console.warn(
                `[MeshService] proxyTunnelSelfCentralNodeId overwritten ${this.proxyTunnelSelfCentralNodeId} -> ${nodeId}; concurrent proxy-tunnel install or misconfigured deployment`,
            );
        }
        if (nodeId !== null && this.proxyTunnelSelfCentralNodeId !== nodeId) {
            this.logActivity({
                source: 'mesh', level: 'info', type: 'mesh.proxy_tunnel.identify',
                message: `proxy-tunnel: this node is nodeId=${nodeId} in central's namespace`,
            });
        }
        // Null-clear (tunnel teardown) is intentionally not logged: it
        // would double the entries on every reconnect cycle without adding
        // signal beyond the existing `proxy-tunnel.close` event.
        this.proxyTunnelSelfCentralNodeId = nodeId;
    }

    private async dialMeshTcpStream(target: MeshTarget): Promise<MeshTcpStreamLike | null> {
        if (this.reverseDialer) {
            return this.reverseDialer.openMeshTcpStream({
                nodeId: target.nodeId,
                stack: target.stack,
                service: target.service,
                port: target.port,
            });
        }
        const ptm = PilotTunnelManager.getInstance();
        // ensureBridge resolves an existing pilot tunnel, an existing
        // proxy-mode tunnel, or dials a fresh proxy-mode tunnel on demand.
        // Returns null for unreachable nodes (no api_url/api_token, scope
        // insufficient, remote pre-Phase-C, network error).
        const bridge = await ptm.ensureBridge(target.nodeId);
        if (!bridge) return null;
        return bridge.openTcpStream({ stack: target.stack, service: target.service, port: target.port });
    }

    private async openCrossNode(target: MeshTarget, src: net.Socket): Promise<void> {
        // Log every dispatch entry. Same-node logs route.resolve.ok on
        // its TCP `connect` event; cross-node only logs route.resolve.ok
        // once tcp_open_ack arrives from the agent. Without this entry
        // log, a stuck cross-node dial leaves zero events in the activity
        // buffer even though the prober's TCP handshake completed.
        this.logActivity({
            source: 'mesh', level: 'info', type: 'route.dispatch',
            nodeId: target.nodeId, alias: target.alias,
            message: `cross-node dispatch to ${target.alias} on node ${target.nodeId}`,
        });

        const tcpStream = await this.dialMeshTcpStream(target);
        if (!tcpStream) {
            // Three failure shapes on this path:
            //   - central with reverseDialer somehow installed (unusual; relay edge case)
            //   - central without reverseDialer (normal): ensureBridge could not reach the target peer
            //   - peer side: target nodeId is central's id, which the peer's NodeRegistry does
            //     not know as a remote proxy target, so ensureBridge returns null. The actionable
            //     condition is "central has not dialed the bridge yet"; tell the operator.
            const targetIsLocalKnownRemote = NodeRegistry.getInstance().getNode(target.nodeId)?.type === 'remote';
            const message = this.reverseDialer
                ? `cannot open reverse mesh stream to node ${target.nodeId}`
                : targetIsLocalKnownRemote
                    ? `no mesh tunnel reachable for node ${target.nodeId}`
                    : `peer cross-node dispatch deferred: waiting for central to dial the reverse bridge`;
            this.logActivity({
                source: 'pilot', level: 'error', type: 'tunnel.fail',
                nodeId: target.nodeId, alias: target.alias, message,
            });
            try { src.destroy(); } catch { /* ignore */ }
            return;
        }
        const record = this.registerActiveStream(target.alias, tcpStream.streamId);
        const t0 = Date.now();

        // Hold src bytes until tcp_open_ack arrives. Writing through to the
        // tunnel before 'open' fires races the first packet ahead of the
        // ack, which breaks protocols that send immediately after connect
        // (HTTP, TLS, Redis, Postgres). Cap matches the bridge's reservation
        // cap so a misbehaving source cannot exhaust gateway memory.
        let tcpOpen = false;
        const pending: Buffer[] = [];
        let pendingBytes = 0;

        // Timer guards against the agent never returning a tcp_open_ack
        // (broken pilot, frame dropped, dial stuck after handshake).
        // Without this the stream sits forever and the operator sees
        // nothing in the activity log between dispatch and close.
        let openTimer: NodeJS.Timeout | null = setTimeout(() => {
            openTimer = null;
            this.logActivity({
                source: 'pilot', level: 'warn', type: 'tunnel.fail',
                nodeId: target.nodeId, alias: target.alias, streamId: record.streamId,
                message: `cross-node dial to ${target.alias} timed out waiting for tcp_open_ack`,
            });
            try { tcpStream.destroy(); } catch { /* ignore */ }
            try { src.destroy(); } catch { /* ignore */ }
        }, PROBE_TIMEOUT_MS);
        const clearOpenTimer = () => {
            if (openTimer) { clearTimeout(openTimer); openTimer = null; }
        };
        // Idempotent stream cleanup. F-10: src.on('close'/'error') used to
        // only destroy tcpStream and never delete the activeStreams entry,
        // so failed dials whose remote tcp_close ack was lost (or whose peer
        // was already gone) leaked records until the whole tunnel idle-
        // closed. Map.delete is naturally idempotent, so it's safe for both
        // the src side and the tcpStream side to call this.
        const cleanupRecord = () => {
            clearOpenTimer();
            this.activeStreams.delete(record.streamId);
        };

        tcpStream.on('open', () => {
            clearOpenTimer();
            this.logActivity({
                source: 'mesh', level: 'info', type: 'route.resolve.ok',
                nodeId: target.nodeId, alias: target.alias, streamId: record.streamId,
                message: `cross-node connect to ${target.alias}`,
            });
            this.routeLatencyMap.set(target.alias, Date.now() - t0);
            // Flush any bytes that arrived before tcp_open_ack so the upstream
            // sees them in order, ahead of anything that lands post-ack.
            for (const buf of pending) {
                try { tcpStream.write(buf); } catch { /* ignore */ }
            }
            pending.length = 0;
            pendingBytes = 0;
            tcpOpen = true;
        });
        tcpStream.on('data', (chunk: Buffer) => {
            record.bytesIn += chunk.length;
            try { src.write(chunk); } catch { /* ignore */ }
        });
        tcpStream.on('error', (err: Error) => {
            cleanupRecord();
            this.logActivity({
                source: 'pilot', level: 'error', type: 'tunnel.fail',
                nodeId: target.nodeId, alias: target.alias, streamId: record.streamId,
                message: sanitizeForLog(err.message),
            });
            try { src.destroy(); } catch { /* ignore */ }
        });
        tcpStream.on('close', () => {
            cleanupRecord();
            try { src.end(); } catch { /* ignore */ }
        });
        src.on('data', (chunk: Buffer) => {
            record.bytesOut += chunk.length;
            if (tcpOpen) {
                tcpStream.write(chunk);
                return;
            }
            if (pendingBytes + chunk.length > STREAM_PENDING_DATA_MAX_BYTES) {
                try { src.destroy(); } catch { /* ignore */ }
                try { tcpStream.destroy(); } catch { /* ignore */ }
                return;
            }
            pending.push(Buffer.from(chunk));
            pendingBytes += chunk.length;
        });
        src.on('end', () => tcpStream.end());
        src.on('close', () => { cleanupRecord(); try { tcpStream.destroy(); } catch { /* ignore */ } });
        src.on('error', () => { cleanupRecord(); try { tcpStream.destroy(); } catch { /* ignore */ } });
    }

    private registerActiveStream(alias: string, streamId?: number): ActiveStreamRecord {
        const id = streamId ?? -Math.floor(Math.random() * 0x7fffffff);
        const record: ActiveStreamRecord = {
            streamId: id, alias, bytesIn: 0, bytesOut: 0, openedAt: Date.now(),
        };
        this.activeStreams.set(id, record);
        return record;
    }

    private onTunnelDown(nodeId: number): void {
        this.logActivity({
            source: 'pilot', level: 'warn', type: 'tunnel.fail',
            nodeId, message: `pilot tunnel down for node ${nodeId}`,
        });
    }

    // --- Probe / Test upstream ---

    public async testUpstream(alias: string, sourceNodeId: number): Promise<MeshProbeResult> {
        const target = this.lookupAliasGlobal(alias);
        if (!target) {
            return { ok: false, where: 'no_route', code: 'no_route', message: 'alias not found' };
        }
        if (!DatabaseService.getInstance().isMeshStackEnabled(target.nodeId, target.stackName)) {
            return { ok: false, where: 'agent_resolve', code: 'denied', message: 'target stack not opted in' };
        }

        if (target.nodeId !== sourceNodeId) {
            // Use ensureBridge so proxy-mode remotes get a bridge dialed
            // on demand. Pre-fix this called hasActiveTunnel + getBridge,
            // which only checked the pilot-tunnel slot and returned
            // tunnel_down for proxy-mode targets even when the regular
            // dialMeshTcpStream path worked.
            const ptm = PilotTunnelManager.getInstance();
            const bridge = await ptm.ensureBridge(target.nodeId);
            if (!bridge) {
                return { ok: false, where: 'pilot_tunnel', code: 'tunnel_down', message: 'no bridge' };
            }
            const t0 = Date.now();
            const stream = bridge.openTcpStream({ stack: target.stackName, service: target.serviceName, port: target.port });
            if (!stream) return { ok: false, where: 'pilot_tunnel', code: 'tunnel_down', message: 'open failed' };
            return new Promise<MeshProbeResult>((resolve) => {
                const timer = setTimeout(() => {
                    stream.destroy();
                    this.routeProbeAtMap.set(target.host, Date.now());
                    resolve({ ok: false, where: 'agent_dial', code: 'timeout', message: 'probe timeout' });
                }, PROBE_TIMEOUT_MS);
                stream.once('open', () => {
                    clearTimeout(timer);
                    const latency = Date.now() - t0;
                    this.routeLatencyMap.set(target.host, latency);
                    this.routeProbeAtMap.set(target.host, Date.now());
                    stream.destroy();
                    this.logActivity({
                        source: 'mesh', level: 'info', type: 'probe.ok',
                        alias: target.host, message: `probe ok ${latency}ms`,
                    });
                    resolve({ ok: true, latencyMs: latency });
                });
                stream.once('error', (err: Error) => {
                    clearTimeout(timer);
                    this.routeProbeAtMap.set(target.host, Date.now());
                    const sanitized = sanitizeForLog(err.message);
                    this.logActivity({
                        source: 'mesh', level: 'error', type: 'probe.fail',
                        alias: target.host, message: sanitized,
                    });
                    resolve({ ok: false, where: 'agent_dial', code: 'unreachable', message: sanitized });
                });
            });
        }

        const t0 = Date.now();
        return new Promise<MeshProbeResult>((resolve) => {
            const sock = net.createConnection({ host: '127.0.0.1', port: target.port });
            sock.setTimeout(PROBE_TIMEOUT_MS);
            sock.once('connect', () => {
                const latency = Date.now() - t0;
                this.routeLatencyMap.set(target.host, latency);
                this.routeProbeAtMap.set(target.host, Date.now());
                sock.destroy();
                resolve({ ok: true, latencyMs: latency });
            });
            sock.once('timeout', () => {
                sock.destroy();
                this.routeProbeAtMap.set(target.host, Date.now());
                this.logActivity({
                    source: 'mesh', level: 'error', type: 'probe.fail',
                    alias: target.host, message: 'connect timeout',
                });
                resolve({ ok: false, where: 'target_port', code: 'timeout', message: 'connect timeout' });
            });
            sock.once('error', (err) => {
                this.routeProbeAtMap.set(target.host, Date.now());
                const sanitized = sanitizeForLog(err.message);
                this.logActivity({
                    source: 'mesh', level: 'error', type: 'probe.fail',
                    alias: target.host, message: sanitized,
                });
                resolve({ ok: false, where: 'target_port', code: 'unreachable', message: sanitized });
            });
        });
    }

    private lookupAliasGlobal(host: string): MeshGlobalAlias | null {
        return this.aliasCache.get(host) || null;
    }

    // --- Diagnostics ---

    /**
     * Whether mesh CAN route to a node based on current configuration.
     * Distinct from "live tunnel up right now": for proxy-mode remotes
     * the tunnel is opened on demand, so a caller that demanded a
     * current tunnel would misreport every idle proxy-mode route as
     * `tunnel down`. Live pilot-tunnel state is surfaced separately.
     */
    private isNodeMeshConfigured(node: ReturnType<typeof DatabaseService.prototype.getNode>): boolean {
        if (!node) return false;
        if (node.type !== 'remote') return true;
        if (node.mode === 'pilot_agent') return true;
        if (node.mode === 'proxy') return !!node.api_url && !!node.api_token;
        return false;
    }

    /**
     * Compute the reachability classification surfaced in `MeshNodeStatus`
     * and consumed by the Routing tab. See `MeshReachableMode` for the
     * meaning of each value. Callers pass in the already-fetched node row
     * (and the local nodeId) so this helper is free of DB I/O when
     * `getStatus` iterates the fleet.
     */
    private computeReachable(node: ReturnType<typeof DatabaseService.prototype.getNode>, localNodeId: number): { mode: MeshReachableMode; reason: string | null } {
        if (!node) return { mode: 'unreachable', reason: 'unknown node' };
        if (node.id === localNodeId || node.type !== 'remote') return { mode: 'local', reason: null };
        if (node.mode === 'pilot_agent') return { mode: 'pilot', reason: null };
        if (node.mode === 'proxy') {
            if (!node.api_url) return { mode: 'unreachable', reason: 'api_url not set' };
            if (!node.api_token) return { mode: 'unreachable', reason: 'api token missing' };
            // Recent-failure cache surfaces the last failed dial so the
            // operator sees a clear reason without triggering a redial
            // storm.
            const failure = MeshProxyTunnelDialer.getInstance().getRecentFailure(node.id);
            if (failure) {
                const reason = REACHABLE_REASON[failure.code] ?? failure.message ?? 'remote unreachable';
                return { mode: 'unreachable', reason };
            }
            return { mode: 'proxy', reason: null };
        }
        return { mode: 'unreachable', reason: 'unknown node mode' };
    }

    public async getRouteDiagnostic(alias: string): Promise<MeshRouteDiagnostic> {
        const target = this.lookupAliasGlobal(alias);

        if (!target) {
            const lastError = this.routeErrorMap.get(alias) || null;
            const lastProbeMs = this.routeLatencyMap.get(alias) ?? null;
            const lastProbeAt = this.routeProbeAtMap.get(alias) ?? null;
            return { alias, target: null, pilot: { connected: false, lastSeen: null }, lastError, lastProbeMs, lastProbeAt, state: 'not authorized' };
        }

        const node = DatabaseService.getInstance().getNode(target.nodeId);
        const routable = this.isNodeMeshConfigured(node);
        // Pilot-mode routes surface live tunnel state; proxy-mode routes
        // fall back to `routable` because the tunnel is opened on demand
        // and a quiescent state is normal.
        const pilotLive = node?.type === 'remote' && node.mode === 'pilot_agent'
            ? PilotTunnelManager.getInstance().hasActiveTunnel(target.nodeId)
            : routable;
        const lastSeen = node?.pilot_last_seen ?? null;
        const optedIn = DatabaseService.getInstance().isMeshStackEnabled(target.nodeId, target.stackName);

        // F-11: cached state was stale until someone manually hit POST .../test.
        // Probe synchronously here so the GET reflects current upstream state.
        // Skip when the probe would be wasted (no target, opt-out, tunnel down) —
        // those short-circuits keep a downed peer from holding the GET for
        // PROBE_TIMEOUT_MS. Probe failures are swallowed because we only use the
        // call for its side effects on routeLatencyMap / routeErrorMap /
        // routeProbeAtMap; the activity log already records probe.fail.
        if (optedIn && routable && pilotLive) {
            try {
                await this.testUpstream(alias, NodeRegistry.getInstance().getDefaultNodeId());
            } catch {
                // ignore — diagnostic must not error out on probe failure
            }
        }

        const lastError = this.routeErrorMap.get(alias) || null;
        const lastProbeMs = this.routeLatencyMap.get(alias) ?? null;
        const lastProbeAt = this.routeProbeAtMap.get(alias) ?? null;

        let state: MeshRouteDiagnostic['state'];
        if (!optedIn) state = 'not authorized';
        else if (!routable || !pilotLive) state = 'tunnel down';
        else if (lastError && Date.now() - lastError.ts < 60_000) state = 'unreachable';
        else if (lastProbeMs !== null && lastProbeMs > SLOW_PROBE_THRESHOLD_MS) state = 'degraded';
        else state = 'healthy';

        return {
            alias,
            target: {
                nodeId: target.nodeId,
                stack: target.stackName,
                service: target.serviceName,
                port: target.port,
                alias,
            },
            pilot: { connected: pilotLive, lastSeen },
            lastError,
            lastProbeMs,
            lastProbeAt,
            state,
        };
    }

    public async getNodeDiagnostic(nodeId: number): Promise<MeshNodeDiagnostic> {
        const ptm = PilotTunnelManager.getInstance();
        const bridge = ptm.getBridge(nodeId);
        const node = DatabaseService.getInstance().getNode(nodeId);
        const localNodeId = NodeRegistry.getInstance().getDefaultNodeId();
        const isLocal = nodeId === localNodeId;

        const aliasCacheRows = Array.from(this.aliasCache.values())
            .filter((a) => a.nodeId === nodeId)
            .map((a) => ({ host: a.host, targetNodeId: a.nodeId, port: a.port }));

        const now = Date.now();
        const activeStreams = Array.from(this.activeStreams.values()).map((s) => ({
            streamId: s.streamId, alias: s.alias,
            bytesIn: s.bytesIn, bytesOut: s.bytesOut,
            ageMs: now - s.openedAt,
        }));

        const listenerCount = isLocal ? this.forwarder.getListenerPorts().length : 0;
        return {
            nodeId,
            forwarder: {
                listening: isLocal && this.isLocalForwarderActive(),
                listenerCount,
            },
            pilot: {
                connected: !!bridge,
                bufferedAmount: bridge?.getBufferedAmount() ?? 0,
                lastSeen: node?.pilot_last_seen ?? null,
            },
            activeStreams,
            aliasCache: aliasCacheRows,
        };
    }

    public async getStatus(): Promise<MeshNodeStatus[]> {
        const db = DatabaseService.getInstance();
        const nodes = db.getNodes();
        const localNodeId = NodeRegistry.getInstance().getDefaultNodeId();
        const localListening = this.isLocalForwarderActive();
        const ptm = PilotTunnelManager.getInstance();
        const dialer = MeshProxyTunnelDialer.getInstance();
        // Precompute the (nodeId, stackName) pairs that currently have at least
        // one alias in the cache. Reading the cache (refreshed every 60 s and
        // on opt-in/opt-out) keeps the new `currentlyResolvable` field aligned
        // with what `/api/mesh/aliases` reports, without paying the cost of a
        // fresh Dockerode/cross-node inspect per status poll.
        const resolvableKeys = new Set<string>();
        for (const alias of this.aliasCache.values()) {
            resolvableKeys.add(`${alias.nodeId}:${alias.stackName}`);
        }
        return nodes.map((node) => {
            const reach = this.computeReachable(node, localNodeId);
            const meshEnabled = db.getNodeMeshEnabled(node.id);
            return {
                nodeId: node.id,
                nodeName: node.name,
                enabled: meshEnabled,
                localForwarderListening: node.id === localNodeId ? localListening : null,
                // `pilotConnected` stays at its original meaning: a pilot
                // tunnel is currently registered for this node. The
                // Routing tab now derives badge state from `reachableMode`
                // and reads `pilotConnected` only for the pilot-offline
                // sub-state.
                pilotConnected: node.type !== 'remote' || ptm.hasActiveTunnel(node.id),
                reachableMode: reach.mode,
                reachableReason: reach.reason,
                reverseCallbackStatus: this.computeReverseCallbackStatus(node, meshEnabled, dialer),
                optedInStacks: db.listMeshStacks(node.id).map((s) => ({
                    stackName: s.stack_name,
                    currentlyResolvable: resolvableKeys.has(`${node.id}:${s.stack_name}`),
                })),
                activeStreamCount: this.activeStreams.size,
            };
        });
    }

    private computeReverseCallbackStatus(
        node: { id: number; type: 'local' | 'remote'; mode: NodeMode },
        meshEnabled: boolean,
        dialer: MeshProxyTunnelDialer,
    ): MeshReverseCallbackStatus {
        if (node.type !== 'remote' || node.mode !== 'proxy' || !meshEnabled) {
            return 'not_applicable';
        }
        if (dialer.hasBridge(node.id)) return 'connected';
        if (dialer.isDialing(node.id)) return 'connecting';
        return 'unavailable';
    }

    /** True when the local Sencho's forwarder is started and bound to at least one alias port. */
    private isLocalForwarderActive(): boolean {
        return this.started && this.forwarder.getListenerPorts().length > 0;
    }
}

export type MeshErrorCode =
    | 'no_target'
    | 'port_collision'
    | 'denied'
    | 'agent_error'
    | 'push_failed';

export class MeshError extends Error {
    public readonly code: MeshErrorCode;
    constructor(code: MeshErrorCode, message: string) {
        super(message);
        this.code = code;
    }
}

/**
 * Common surface of an outbound mesh TCP stream as MeshService consumes
 * it. Both the central-side `PilotTunnelBridge.TcpStream` and the
 * pilot-side `ReverseTcpStreamHandle` (from `mesh/tcpStreamSwitchboard.ts`) implement
 * this shape structurally so MeshService.openCrossNode can splice bytes
 * against either without caring which side initiated the stream.
 */
export interface MeshTcpStreamLike {
    readonly streamId: number;
    write(chunk: Buffer): boolean;
    end(): void;
    destroy(): void;
    on(event: 'open', listener: () => void): this;
    on(event: 'data', listener: (chunk: Buffer) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'close', listener: () => void): this;
}

/**
 * Pilot-side reverse dialer. Set by `PilotAgent` when the agent boots
 * (Phase B); leaves MeshService.openCrossNode able to route outbound
 * cross-node mesh traffic over the agent's outbound `tcp_open_reverse`
 * frame instead of central's `PilotTunnelManager.getBridge`.
 */
export interface ReverseMeshDialer {
    openMeshTcpStream(target: { nodeId: number; stack: string; service: string; port: number }): MeshTcpStreamLike | null;
}
