import net from 'net';
import path from 'path';
import fs from 'fs/promises';
import { EventEmitter } from 'events';
import jwt from 'jsonwebtoken';
import { DatabaseService } from './DatabaseService';
import DockerController from './DockerController';
import { LicenseService } from './LicenseService';
import { PROXY_TIER_HEADER, PROXY_VARIANT_HEADER } from './license-headers';
import { NodeRegistry } from './NodeRegistry';
import { PilotTunnelManager } from './PilotTunnelManager';
import { generateOverrideYaml, MeshAlias } from './MeshComposeOverride';
import { sanitizeForLog } from '../utils/safeLog';
import { isPathWithinBase, isValidStackName } from '../utils/validation';

const ACTIVITY_BUFFER_SIZE = 1000;
const ALIAS_REFRESH_INTERVAL_MS = 60_000;
const SIDECAR_CONTAINER_PREFIX = 'sencho-mesh-';
const DEFAULT_SIDECAR_IMAGE = process.env.SENCHO_MESH_IMAGE || 'saelix/sencho-mesh:latest';
const SIDECAR_TOKEN_TTL = '7d';
const PROBE_TIMEOUT_MS = 5_000;
const SLOW_PROBE_THRESHOLD_MS = 500;

export type MeshActivitySource = 'sidecar' | 'pilot' | 'mesh';
export type MeshActivityLevel = 'info' | 'warn' | 'error';
export type MeshActivityType =
    | 'route.resolve.ok' | 'route.resolve.denied'
    | 'tunnel.open' | 'tunnel.fail' | 'tunnel.backpressure'
    | 'opt_in' | 'opt_out'
    | 'mesh.enable' | 'mesh.disable'
    | 'probe.ok' | 'probe.fail'
    | 'sidecar.start' | 'sidecar.stop' | 'sidecar.crash';

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
    sidecarRunning: boolean;
    pilotConnected: boolean;
    optedInStacks: string[];
    activeStreamCount: number;
}

export interface MeshNodeDiagnostic {
    nodeId: number;
    sidecar: { running: boolean; restartCount: number };
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
    where?: 'sidecar' | 'pilot_tunnel' | 'agent_resolve' | 'agent_dial' | 'target_port';
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

interface PendingResolve {
    sidecarSocket: WebSocketLike;
    connId: number;
    port: number;
    remoteAddr: string;
}

interface WebSocketLike {
    send(data: string | Buffer, opts?: unknown, cb?: (err?: Error) => void): void;
    readyState: number;
    on(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * Sencho Mesh orchestrator. Owns:
 *   - sidecar lifecycle (Dockerode-spawned per-instance)
 *   - opt-in / opt-out persistence and cascading override regeneration
 *   - global alias aggregation (across the fleet via the existing API)
 *   - request-based resolution from sidecar control WS
 *   - cross-node TCP forwarding via PilotTunnelManager
 *   - probe + diagnostics + activity ring buffer
 *
 * V1 limitations:
 *   - one cross-node alias per TCP port across the fleet (port-collision check at opt-in)
 *   - sidecar runs in host network mode; aliases resolve via `host-gateway` extra_hosts
 *   - pilot-to-pilot mesh routing is not supported (only central <-> pilot)
 */
export class MeshService extends EventEmitter {
    private static instance: MeshService;
    private started = false;
    private aliasCache = new Map<string, MeshGlobalAlias>();
    private aliasByPort = new Map<number, MeshGlobalAlias>();
    private activity: MeshActivityEvent[] = [];
    private activeStreams = new Map<number, ActiveStreamRecord>();
    private pendingResolves = new Map<string, PendingResolve>();
    private sidecarSockets = new Set<WebSocketLike>();
    private aliasRefreshTimer?: NodeJS.Timeout;
    private routeErrorMap = new Map<string, { ts: number; message: string }>();
    private routeLatencyMap = new Map<string, number>();
    private activityListeners = new Set<(e: MeshActivityEvent) => void>();

    private constructor() {
        super();
        this.setMaxListeners(50);
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
        this.aliasRefreshTimer = setInterval(() => {
            void this.refreshAliasCache().catch((err) => {
                console.warn('[MeshService] alias refresh failed:', sanitizeForLog((err as Error).message));
            });
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
        for (const ws of this.sidecarSockets) {
            try { (ws as { close?: (code: number) => void }).close?.(1000); } catch { /* ignore */ }
        }
        this.sidecarSockets.clear();
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
     * Forward bytes from a sidecar-accepted local socket to the target.
     * Same-node target: open a direct TCP socket.
     * Cross-node target: open a pilot-tunnel TcpStream to that node's agent.
     */
    public openTcp(target: MeshTarget, src: net.Socket, sourceNodeId: number): void {
        if (target.nodeId === sourceNodeId) {
            this.openSameNode(target, src);
            return;
        }
        this.openCrossNode(target, src);
    }

    private openSameNode(target: MeshTarget, src: net.Socket): void {
        // For same-node fast path, the agent's resolution logic isn't needed:
        // we can dial via Dockerode's container IP. For V1 simplicity, we dial
        // the host-gateway's published port if mapped, falling back to
        // 127.0.0.1 (the sidecar runs in host network mode so localhost reaches
        // the container's published port).
        const upstream = net.createConnection({ host: '127.0.0.1', port: target.port });
        upstream.setTimeout(PROBE_TIMEOUT_MS);
        const stream = this.registerActiveStream(target.alias);
        upstream.once('connect', () => {
            upstream.setTimeout(0);
            this.logActivity({
                source: 'mesh', level: 'info', type: 'route.resolve.ok',
                alias: target.alias, streamId: stream.streamId,
                message: `same-node connect to ${target.alias}`,
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

    private openCrossNode(target: MeshTarget, src: net.Socket): void {
        const ptm = PilotTunnelManager.getInstance();
        if (!ptm.hasActiveTunnel(target.nodeId)) {
            this.logActivity({
                source: 'pilot', level: 'error', type: 'tunnel.fail',
                nodeId: target.nodeId, alias: target.alias,
                message: `no active pilot tunnel to node ${target.nodeId}`,
            });
            try { src.destroy(); } catch { /* ignore */ }
            return;
        }
        const bridge = ptm.getBridge(target.nodeId);
        if (!bridge) { try { src.destroy(); } catch { /* ignore */ } return; }
        const tcpStream = bridge.openTcpStream({ stack: target.stack, service: target.service, port: target.port });
        if (!tcpStream) { try { src.destroy(); } catch { /* ignore */ } return; }

        const record = this.registerActiveStream(target.alias, tcpStream.streamId);
        const t0 = Date.now();
        tcpStream.on('open', () => {
            this.logActivity({
                source: 'mesh', level: 'info', type: 'route.resolve.ok',
                nodeId: target.nodeId, alias: target.alias, streamId: tcpStream.streamId,
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
                nodeId: target.nodeId, alias: target.alias, streamId: tcpStream.streamId,
                message: err.message,
            });
            this.activeStreams.delete(tcpStream.streamId);
            try { src.destroy(); } catch { /* ignore */ }
        });
        tcpStream.on('close', () => {
            this.activeStreams.delete(tcpStream.streamId);
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
            return { ok: false, where: 'sidecar', code: 'no_route', message: 'alias not found' };
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
        const sidecarRunning = await this.isSidecarRunning(nodeId);

        const aliasCacheRows = Array.from(this.aliasCache.values())
            .filter((a) => a.nodeId === nodeId)
            .map((a) => ({ host: a.host, targetNodeId: a.nodeId, port: a.port }));

        const now = Date.now();
        const activeStreams = Array.from(this.activeStreams.values()).map((s) => ({
            streamId: s.streamId, alias: s.alias,
            bytesIn: s.bytesIn, bytesOut: s.bytesOut,
            ageMs: now - s.openedAt,
        }));

        return {
            nodeId,
            sidecar: { running: sidecarRunning, restartCount: 0 },
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
        const out: MeshNodeStatus[] = [];
        for (const node of nodes) {
            const optedInStacks = db.listMeshStacks(node.id).map((s) => s.stack_name);
            out.push({
                nodeId: node.id,
                nodeName: node.name,
                enabled: db.getNodeMeshEnabled(node.id),
                sidecarRunning: await this.isSidecarRunning(node.id),
                pilotConnected: this.isMeshReachable(node.id),
                optedInStacks,
                activeStreamCount: Array.from(this.activeStreams.values()).length,
            });
        }
        return out;
    }

    // --- Sidecar lifecycle (best-effort; real spawn happens on local node) ---

    public async spawnSidecar(nodeId: number): Promise<void> {
        const docker = DockerController.getInstance(nodeId).getDocker();
        const name = `${SIDECAR_CONTAINER_PREFIX}${nodeId}`;
        try {
            const existing = docker.getContainer(name);
            const info = await existing.inspect().catch(() => null);
            if (info?.State?.Running) return;
            if (info) await existing.remove({ force: true }).catch(() => undefined);
        } catch { /* ignore */ }

        const token = this.mintSidecarToken(nodeId);
        const controlUrl = process.env.SENCHO_INTERNAL_URL || 'ws://127.0.0.1:1852/api/mesh/control';
        try {
            const container = await docker.createContainer({
                name,
                Image: DEFAULT_SIDECAR_IMAGE,
                Env: [
                    `SENCHO_CONTROL_URL=${controlUrl}`,
                    `SENCHO_MESH_TOKEN=${token}`,
                    `MESH_NODE_ID=${nodeId}`,
                ],
                HostConfig: {
                    NetworkMode: 'host',
                    RestartPolicy: { Name: 'unless-stopped' },
                },
                Labels: {
                    'sencho.mesh.role': 'sidecar',
                    'sencho.mesh.node_id': String(nodeId),
                },
            });
            await container.start();
            this.logActivity({
                source: 'mesh', level: 'info', type: 'sidecar.start',
                nodeId, message: `sidecar started for node ${nodeId}`,
            });
        } catch (err) {
            this.logActivity({
                source: 'mesh', level: 'error', type: 'sidecar.crash',
                nodeId, message: `sidecar spawn failed: ${(err as Error).message}`,
            });
            throw err;
        }
    }

    public async stopSidecar(nodeId: number): Promise<void> {
        const docker = DockerController.getInstance(nodeId).getDocker();
        const name = `${SIDECAR_CONTAINER_PREFIX}${nodeId}`;
        try {
            const c = docker.getContainer(name);
            await c.stop({ t: 5 }).catch(() => undefined);
            await c.remove({ force: true }).catch(() => undefined);
            this.logActivity({
                source: 'mesh', level: 'info', type: 'sidecar.stop',
                nodeId, message: `sidecar stopped for node ${nodeId}`,
            });
        } catch { /* ignore */ }
    }

    private async isSidecarRunning(nodeId: number): Promise<boolean> {
        try {
            const docker = DockerController.getInstance(nodeId).getDocker();
            const info = await docker.getContainer(`${SIDECAR_CONTAINER_PREFIX}${nodeId}`).inspect();
            return !!info.State?.Running;
        } catch {
            return false;
        }
    }

    public mintSidecarToken(nodeId: number): string {
        const settings = DatabaseService.getInstance().getGlobalSettings();
        const secret = settings.auth_jwt_secret;
        if (!secret) throw new Error('JWT secret not configured');
        return jwt.sign({ scope: 'mesh_sidecar', nodeId }, secret, { expiresIn: SIDECAR_TOKEN_TTL });
    }

    public verifySidecarToken(token: string): { nodeId: number } | null {
        try {
            const settings = DatabaseService.getInstance().getGlobalSettings();
            const secret = settings.auth_jwt_secret;
            if (!secret) return null;
            const decoded = jwt.verify(token, secret) as { scope?: string; nodeId?: number };
            if (decoded.scope !== 'mesh_sidecar' || typeof decoded.nodeId !== 'number') return null;
            return { nodeId: decoded.nodeId };
        } catch {
            return null;
        }
    }

    // --- Sidecar control WS attachment (called from websocket/meshControl.ts) ---

    public attachSidecarSocket(ws: WebSocketLike, _nodeId: number): void {
        this.sidecarSockets.add(ws);
        ws.on('close', () => { this.sidecarSockets.delete(ws); });
    }

    /** Resolve an inbound sidecar request: "I have a connection on this port; who's it for?" */
    public handleSidecarResolve(ws: WebSocketLike, nodeId: number, connId: number, port: number, remoteAddr: string): void {
        const target = this.resolveByLocalPort(port);
        if (!target) {
            this.sendSidecar(ws, { t: 'resolve_err', connId, code: 'no_route', message: 'port not registered' });
            this.logActivity({
                source: 'sidecar', level: 'warn', type: 'route.resolve.denied',
                nodeId, message: `unknown port ${port}`, details: { connId, remoteAddr },
            });
            return;
        }

        // The sidecar is the SOURCE; it asks for routing on its local node.
        // Open a TCP path on this node's MeshService (same-node fast path or
        // pilot tunnel) and acknowledge the resolve with a freshly allocated
        // streamId. For V1 we do NOT bridge real bytes through the control WS
        // until the sidecar package gains binary frame plumbing (Phase B).
        // Instead we ack the resolve with the target metadata so the sidecar
        // can dial directly on the host gateway.
        this.sendSidecar(ws, { t: 'resolve_ok', connId, streamId: connId, alias: target.alias });
        this.logActivity({
            source: 'sidecar', level: 'info', type: 'route.resolve.ok',
            nodeId, alias: target.alias,
            message: `resolved port ${port} to ${target.alias}`,
            details: { connId, remoteAddr },
        });
    }

    private sendSidecar(ws: WebSocketLike, frame: Record<string, unknown>): void {
        if (ws.readyState !== 1 /* OPEN */) return;
        try { ws.send(JSON.stringify(frame)); } catch { /* ignore */ }
    }
}

export class MeshError extends Error {
    public readonly code: 'no_target' | 'port_collision' | 'denied' | 'agent_error';
    constructor(code: 'no_target' | 'port_collision' | 'denied' | 'agent_error', message: string) {
        super(message);
        this.code = code;
    }
}
