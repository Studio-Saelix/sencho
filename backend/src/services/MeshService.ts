import net from 'net';
import path from 'path';
import fs from 'fs/promises';
import { EventEmitter } from 'events';
import { DatabaseService } from './DatabaseService';
import DockerController from './DockerController';
import { LicenseService } from './LicenseService';
import { PROXY_TIER_HEADER, PROXY_VARIANT_HEADER } from './license-headers';
import { MeshForwarder, type MeshForwarderHost } from './MeshForwarder';
import { NodeRegistry } from './NodeRegistry';
import { PilotTunnelManager } from './PilotTunnelManager';
import { generateOverrideYaml, MeshAlias } from './MeshComposeOverride';
import { sanitizeForLog } from '../utils/safeLog';
import { isPathWithinBase, isValidStackName } from '../utils/validation';

const ACTIVITY_BUFFER_SIZE = 1000;
const ALIAS_REFRESH_INTERVAL_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;
const SLOW_PROBE_THRESHOLD_MS = 500;

export type MeshActivitySource = 'pilot' | 'mesh';
export type MeshActivityLevel = 'info' | 'warn' | 'error';
export type MeshActivityType =
    | 'route.resolve.ok' | 'route.resolve.denied'
    | 'tunnel.open' | 'tunnel.fail' | 'tunnel.backpressure'
    | 'opt_in' | 'opt_out'
    | 'mesh.enable' | 'mesh.disable'
    | 'probe.ok' | 'probe.fail'
    | 'forwarder.listen' | 'forwarder.unlisten' | 'forwarder.error';

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

export interface MeshNodeStatus {
    nodeId: number;
    nodeName: string;
    enabled: boolean;
    /** Forwarder state for the LOCAL node (the Sencho instance answering this request). Always `null` for any non-local node — fetching the remote forwarder state requires a cross-node call which lands in Phase B. */
    localForwarderListening: boolean | null;
    pilotConnected: boolean;
    optedInStacks: string[];
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
 *   - in-process TCP forwarder (`MeshForwarder`) that binds host-network
 *     listeners on alias ports. Replaces the prior separate sidecar
 *     container; one container per node now.
 *   - opt-in / opt-out persistence and cascading override regeneration
 *   - global alias aggregation (across the fleet via the existing HTTP
 *     proxy chain — see `inspectStackServices`)
 *   - cross-node TCP forwarding via `PilotTunnelManager` (central-side)
 *   - probe + diagnostics + activity ring buffer
 *
 * V1 limitations:
 *   - one cross-node alias per TCP port across the fleet (port-collision
 *     check at opt-in)
 *   - aliases resolve via `host-gateway` extra_hosts; Sencho's container
 *     must run with `network_mode: host` for the forwarder's listeners to
 *     bind on the host's network where meshed containers' `host-gateway`
 *     entries point
 *   - cross-node mesh routing is central → pilot in this phase. Pilot →
 *     central and pilot ↔ pilot via central relay land in Phase B.
 */
export class MeshService extends EventEmitter implements MeshForwarderHost {
    private static instance: MeshService;
    private started = false;
    private aliasCache = new Map<string, MeshGlobalAlias>();
    private aliasByPort = new Map<number, MeshGlobalAlias>();
    private activity: MeshActivityEvent[] = [];
    private activeStreams = new Map<number, ActiveStreamRecord>();
    private aliasRefreshTimer?: NodeJS.Timeout;
    private routeErrorMap = new Map<string, { ts: number; message: string }>();
    private routeLatencyMap = new Map<string, number>();
    private activityListeners = new Set<(e: MeshActivityEvent) => void>();
    private readonly forwarder: MeshForwarder;

    private constructor() {
        super();
        this.setMaxListeners(50);
        this.forwarder = new MeshForwarder(this);
    }

    public static getInstance(): MeshService {
        if (!MeshService.instance) MeshService.instance = new MeshService();
        return MeshService.instance;
    }

    public async start(): Promise<void> {
        if (this.started) return;
        this.started = true;

        const ptm = PilotTunnelManager.getInstance();
        ptm.on('tunnel-down', (nodeId: number) => this.onTunnelDown(nodeId));
        ptm.on('tunnel-up', (nodeId: number) => this.logActivity({
            source: 'pilot', level: 'info', type: 'tunnel.open',
            nodeId, message: `pilot tunnel up for node ${nodeId}`,
        }));

        await this.refreshAliasCache();
        await this.syncForwarderListeners();
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

        this.logActivity({
            source: 'mesh', level: 'info', type: 'mesh.enable',
            message: 'MeshService started',
        });
    }

    public async stop(): Promise<void> {
        if (!this.started) return;
        this.started = false;
        if (this.aliasRefreshTimer) {
            clearInterval(this.aliasRefreshTimer);
            this.aliasRefreshTimer = undefined;
        }
        await this.forwarder.shutdown();
    }

    /**
     * Bind the forwarder's listeners to every alias port across the fleet
     * and release any listeners no longer in the alias set. Called from
     * `start`, after each `refreshAliasCache` tick, and after every
     * opt-in / opt-out / disable so the bound port set follows the DB
     * state.
     *
     * Every meshed node binds every alias port — not just ports it owns —
     * because meshed containers' `extra_hosts: <alias>:host-gateway`
     * entries resolve to the SOURCE node's gateway, so the source node is
     * where the inbound TCP connection lands. `handleAccept` then
     * dispatches to the same-node fast path or the cross-node bridge based
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
        const db = DatabaseService.getInstance();
        if (db.isMeshStackEnabled(nodeId, stackName)) return;

        const services = await this.inspectStackServices(nodeId, stackName);
        if (services.length === 0) {
            throw new MeshError('no_target', `stack ${stackName} has no running services on this node`);
        }

        const newPorts = new Set<number>();
        for (const svc of services) for (const p of svc.ports) newPorts.add(p);
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
        await this.regenerateOverridesForNode(nodeId);

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
        await this.removeStackOverride(nodeId, stackName);
        await this.refreshAliasCache();
        await this.syncForwarderListeners();
        await this.regenerateOverridesForNode(nodeId);

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
    }

    public async disableForNode(nodeId: number): Promise<void> {
        DatabaseService.getInstance().setNodeMeshEnabled(nodeId, false);
        const stacks = DatabaseService.getInstance().listMeshStacks(nodeId);
        for (const s of stacks) {
            DatabaseService.getInstance().deleteMeshStack(nodeId, s.stack_name);
            await this.removeStackOverride(nodeId, s.stack_name);
        }
        await this.refreshAliasCache();
        await this.syncForwarderListeners();
        this.logActivity({
            source: 'mesh', level: 'info', type: 'mesh.disable',
            nodeId, message: `mesh disabled on node ${nodeId}`,
        });
    }

    // --- Override file management ---

    public async ensureStackOverride(nodeId: number, stackName: string): Promise<string | null> {
        if (!isValidStackName(stackName)) return null;
        const db = DatabaseService.getInstance();
        if (!db.isMeshStackEnabled(nodeId, stackName)) return null;

        const aliases: MeshAlias[] = Array.from(this.aliasCache.values()).map((a) => ({ host: a.host }));
        const services = await this.inspectStackServices(nodeId, stackName);
        const yaml = generateOverrideYaml({
            services: services.map((s) => s.service),
            aliases,
        });

        const dir = this.overrideDirFor(nodeId);
        await fs.mkdir(dir, { recursive: true });
        const file = path.resolve(dir, `${stackName}.override.yml`);
        if (!isPathWithinBase(file, dir)) return null;
        await fs.writeFile(file, yaml, 'utf8');
        return file;
    }

    private async removeStackOverride(nodeId: number, stackName: string): Promise<void> {
        if (!isValidStackName(stackName)) return;
        const dir = this.overrideDirFor(nodeId);
        const file = path.resolve(dir, `${stackName}.override.yml`);
        if (!isPathWithinBase(file, dir)) return;
        try { await fs.unlink(file); } catch { /* ignore not-exist */ }
    }

    private overrideDirFor(nodeId: number): string {
        const dataDir = process.env.DATA_DIR || '/app/data';
        return path.join(dataDir, 'mesh', 'overrides', String(nodeId));
    }

    private async regenerateOverridesForNode(nodeId: number): Promise<void> {
        const db = DatabaseService.getInstance();
        const stacks = db.listMeshStacks(nodeId);
        for (const s of stacks) {
            try {
                await this.ensureStackOverride(nodeId, s.stack_name);
            } catch (err) {
                console.warn('[MeshService] override regen failed:', sanitizeForLog((err as Error).message));
            }
        }
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
        this.aliasCache = next;
        this.aliasByPort = portMap;
    }

    public async listAliases(): Promise<MeshGlobalAlias[]> {
        return Array.from(this.aliasCache.values());
    }

    /**
     * Inspect a stack and return its running services with the ports they
     * listen on. For the LOCAL Docker daemon only — callers targeting a
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

        const target = NodeRegistry.getInstance().getProxyTarget(nodeId);
        if (!target) {
            console.warn(`[MeshService] inspectStackServices: no proxy target for node ${nodeId} (${sanitizeForLog(node.name)})`);
            return [];
        }
        try {
            const url = `${target.apiUrl.replace(/\/$/, '')}/api/mesh/local-services/${encodeURIComponent(stackName)}`;
            const headers: Record<string, string> = {};
            if (target.apiToken) headers['Authorization'] = `Bearer ${target.apiToken}`;
            const proxyHeaders = LicenseService.getInstance().getProxyHeaders();
            headers[PROXY_TIER_HEADER] = proxyHeaders.tier;
            headers[PROXY_VARIANT_HEADER] = proxyHeaders.variant || '';
            const res = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
            if (!res.ok) {
                console.error(`[MeshService] inspectStackServices: HTTP ${res.status} from node ${nodeId} (${sanitizeForLog(node.name)})`);
                return [];
            }
            const body = await res.json() as { services?: Array<{ service: string; ports: number[] }> };
            return body.services ?? [];
        } catch (err) {
            console.error('[MeshService] inspectStackServices remote unreachable:', sanitizeForLog((err as Error).message));
            return [];
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
        const localNodeId = NodeRegistry.getInstance().getDefaultNodeId();
        if (target.nodeId === localNodeId) {
            await this.openSameNode(target, src);
        } else {
            this.openCrossNode(target, src);
        }
    }

    /**
     * Same-node forward: dial the target container's bridge IP directly.
     * Sencho runs in `network_mode: host` so it sees the docker bridge
     * networks and can reach container IPs without going through any
     * host-port publish. Looks up the container by Compose's
     * `<project>-<service>-<index>` naming convention; falls back to a
     * label-filtered listContainers if the conventional name is absent
     * (e.g. when the operator overrode the project name).
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
        try {
            const docker = DockerController.getInstance().getDocker();
            // Compose default container name pattern; -1 is the first replica.
            const conventionalName = `${target.stack}-${target.service}-1`;
            const info = await docker.getContainer(conventionalName).inspect().catch(() => null);
            const fromInspect = info ? this.extractContainerIp(target.stack, info) : null;
            if (fromInspect) return fromInspect;
            // Fallback: filter by compose labels in case of a non-conventional
            // container name (operator overrode `container_name` or compose
            // project).
            const containers = await docker.listContainers({
                all: true,
                filters: {
                    label: [
                        `com.docker.compose.project=${target.stack}`,
                        `com.docker.compose.service=${target.service}`,
                    ],
                },
            });
            if (containers.length === 0) return null;
            const fallbackInfo = await docker.getContainer(containers[0].Id).inspect().catch(() => null);
            return fallbackInfo ? this.extractContainerIp(target.stack, fallbackInfo) : null;
        } catch (err) {
            console.warn('[MeshService] container IP lookup failed:', sanitizeForLog((err as Error).message));
            return null;
        }
    }

    /**
     * Pick a deterministic IP. Prefer the compose default network
     * (`<stack>_default` or any network whose name starts with `<stack>_`),
     * then any other declared network, then the legacy bridge `IPAddress`.
     * Without this preference order, `Object.values(Networks)` ordering on
     * containers attached to multiple networks varies across daemon
     * versions and can make same-node forwarding flaky on a redeploy.
     */
    private extractContainerIp(
        stackName: string,
        info: { NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }>; IPAddress?: string } },
    ): string | null {
        const networks = info.NetworkSettings?.Networks ?? {};
        const composeDefault = networks[`${stackName}_default`];
        if (composeDefault?.IPAddress) return composeDefault.IPAddress;
        for (const [name, net] of Object.entries(networks)) {
            if (name.startsWith(`${stackName}_`) && net?.IPAddress) return net.IPAddress;
        }
        for (const net of Object.values(networks)) {
            if (net?.IPAddress) return net.IPAddress;
        }
        return info.NetworkSettings?.IPAddress || null;
    }

    /**
     * Pluggable reverse dialer. Set by `PilotAgent` on a pilot host; left
     * null on a central host. When set, `openCrossNode` routes outbound
     * mesh dials through the agent's `tcp_open_reverse` path; when unset,
     * `openCrossNode` uses the central-side `PilotTunnelManager.getBridge`
     * directly. Lets the same MeshService code work on both sides.
     */
    private reverseDialer: ReverseMeshDialer | null = null;

    public setReverseDialer(dialer: ReverseMeshDialer | null): void {
        this.reverseDialer = dialer;
    }

    private dialMeshTcpStream(target: MeshTarget): MeshTcpStreamLike | null {
        if (this.reverseDialer) {
            return this.reverseDialer.openMeshTcpStream({
                nodeId: target.nodeId,
                stack: target.stack,
                service: target.service,
                port: target.port,
            });
        }
        const ptm = PilotTunnelManager.getInstance();
        if (!ptm.hasActiveTunnel(target.nodeId)) return null;
        const bridge = ptm.getBridge(target.nodeId);
        if (!bridge) return null;
        return bridge.openTcpStream({ stack: target.stack, service: target.service, port: target.port });
    }

    private openCrossNode(target: MeshTarget, src: net.Socket): void {
        const tcpStream = this.dialMeshTcpStream(target);
        if (!tcpStream) {
            this.logActivity({
                source: 'pilot', level: 'error', type: 'tunnel.fail',
                nodeId: target.nodeId, alias: target.alias,
                message: this.reverseDialer
                    ? `cannot open reverse mesh stream to node ${target.nodeId}`
                    : `no active pilot tunnel to node ${target.nodeId}`,
            });
            try { src.destroy(); } catch { /* ignore */ }
            return;
        }
        const record = this.registerActiveStream(target.alias, tcpStream.streamId);
        const t0 = Date.now();
        tcpStream.on('open', () => {
            this.logActivity({
                source: 'mesh', level: 'info', type: 'route.resolve.ok',
                nodeId: target.nodeId, alias: target.alias, streamId: record.streamId,
                message: `cross-node connect to ${target.alias}`,
            });
            this.routeLatencyMap.set(target.alias, Date.now() - t0);
        });
        tcpStream.on('data', (chunk: Buffer) => {
            record.bytesIn += chunk.length;
            try { src.write(chunk); } catch { /* ignore */ }
        });
        tcpStream.on('error', (err: Error) => {
            this.logActivity({
                source: 'pilot', level: 'error', type: 'tunnel.fail',
                nodeId: target.nodeId, alias: target.alias, streamId: record.streamId,
                message: err.message,
            });
            this.activeStreams.delete(record.streamId);
            try { src.destroy(); } catch { /* ignore */ }
        });
        tcpStream.on('close', () => {
            this.activeStreams.delete(record.streamId);
            try { src.end(); } catch { /* ignore */ }
        });
        src.on('data', (chunk: Buffer) => {
            record.bytesOut += chunk.length;
            tcpStream.write(chunk);
        });
        src.on('end', () => tcpStream.end());
        src.on('close', () => tcpStream.destroy());
        src.on('error', () => tcpStream.destroy());
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
            const ptm = PilotTunnelManager.getInstance();
            if (!ptm.hasActiveTunnel(target.nodeId)) {
                return { ok: false, where: 'pilot_tunnel', code: 'tunnel_down', message: 'no pilot tunnel' };
            }
            const bridge = ptm.getBridge(target.nodeId);
            if (!bridge) {
                return { ok: false, where: 'pilot_tunnel', code: 'tunnel_down', message: 'no bridge' };
            }
            const t0 = Date.now();
            const stream = bridge.openTcpStream({ stack: target.stackName, service: target.serviceName, port: target.port });
            if (!stream) return { ok: false, where: 'pilot_tunnel', code: 'tunnel_down', message: 'open failed' };
            return new Promise<MeshProbeResult>((resolve) => {
                const timer = setTimeout(() => {
                    stream.destroy();
                    resolve({ ok: false, where: 'agent_dial', code: 'timeout', message: 'probe timeout' });
                }, PROBE_TIMEOUT_MS);
                stream.once('open', () => {
                    clearTimeout(timer);
                    const latency = Date.now() - t0;
                    this.routeLatencyMap.set(target.host, latency);
                    stream.destroy();
                    this.logActivity({
                        source: 'mesh', level: 'info', type: 'probe.ok',
                        alias: target.host, message: `probe ok ${latency}ms`,
                    });
                    resolve({ ok: true, latencyMs: latency });
                });
                stream.once('error', (err: Error) => {
                    clearTimeout(timer);
                    this.logActivity({
                        source: 'mesh', level: 'error', type: 'probe.fail',
                        alias: target.host, message: err.message,
                    });
                    resolve({ ok: false, where: 'agent_dial', code: 'unreachable', message: err.message });
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
                sock.destroy();
                resolve({ ok: true, latencyMs: latency });
            });
            sock.once('timeout', () => {
                sock.destroy();
                resolve({ ok: false, where: 'target_port', code: 'timeout', message: 'connect timeout' });
            });
            sock.once('error', (err) => {
                resolve({ ok: false, where: 'target_port', code: 'unreachable', message: err.message });
            });
        });
    }

    private lookupAliasGlobal(host: string): MeshGlobalAlias | null {
        return this.aliasCache.get(host) || null;
    }

    // --- Diagnostics ---

    /**
     * Whether mesh traffic to this node can flow. Local nodes are always
     * reachable because mesh uses the same-node fast path on localhost.
     * Remote nodes are reachable only when a pilot tunnel is registered. The
     * literal `hasActiveTunnel(localNodeId)` would always be false (local
     * nodes do not establish tunnels to themselves), so a direct call would
     * render every local alias as `tunnel down` in the UI even on a working
     * route.
     */
    private isMeshReachable(nodeId: number): boolean {
        const node = DatabaseService.getInstance().getNode(nodeId);
        if (!node) return false;
        if (node.type !== 'remote') return true;
        return PilotTunnelManager.getInstance().hasActiveTunnel(nodeId);
    }

    public async getRouteDiagnostic(alias: string): Promise<MeshRouteDiagnostic> {
        const target = this.lookupAliasGlobal(alias);
        const lastError = this.routeErrorMap.get(alias) || null;
        const lastProbeMs = this.routeLatencyMap.get(alias) ?? null;

        if (!target) {
            return { alias, target: null, pilot: { connected: false, lastSeen: null }, lastError, lastProbeMs, state: 'not authorized' };
        }

        const pilotConnected = this.isMeshReachable(target.nodeId);
        const node = DatabaseService.getInstance().getNode(target.nodeId);
        const lastSeen = node?.pilot_last_seen ?? null;
        const optedIn = DatabaseService.getInstance().isMeshStackEnabled(target.nodeId, target.stackName);

        let state: MeshRouteDiagnostic['state'];
        if (!optedIn) state = 'not authorized';
        else if (!pilotConnected) state = 'tunnel down';
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
            pilot: { connected: pilotConnected, lastSeen },
            lastError,
            lastProbeMs,
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
        return nodes.map((node) => ({
            nodeId: node.id,
            nodeName: node.name,
            enabled: db.getNodeMeshEnabled(node.id),
            localForwarderListening: node.id === localNodeId ? localListening : null,
            pilotConnected: this.isMeshReachable(node.id),
            optedInStacks: db.listMeshStacks(node.id).map((s) => s.stack_name),
            activeStreamCount: this.activeStreams.size,
        }));
    }

    /** True when the local Sencho's forwarder is started and bound to at least one alias port. */
    private isLocalForwarderActive(): boolean {
        return this.started && this.forwarder.getListenerPorts().length > 0;
    }

    // mintSidecarToken / verifySidecarToken / spawnSidecar / stopSidecar /
    // isSidecarRunning / handleSidecarResolve / sendSidecar /
    // attachSidecarSocket are gone: the in-process MeshForwarder replaces
    // the entire sidecar layer. Routing decisions happen via direct
    // MeshService calls — no JWT minting, no separate container, no control
    // WebSocket. See `docs/internal/architecture/mesh.md` for the new flow.
}

export class MeshError extends Error {
    public readonly code: 'no_target' | 'port_collision' | 'denied' | 'agent_error';
    constructor(code: 'no_target' | 'port_collision' | 'denied' | 'agent_error', message: string) {
        super(message);
        this.code = code;
    }
}

/**
 * Common surface of an outbound mesh TCP stream as MeshService consumes
 * it. Both the central-side `PilotTunnelBridge.TcpStream` and the
 * pilot-side `ReverseTcpStreamHandle` (from `pilot/agent.ts`) implement
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
