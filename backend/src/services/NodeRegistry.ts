import Docker from 'dockerode';
import axios from 'axios';
import { EventEmitter } from 'events';
import { DatabaseService, Node } from './DatabaseService';
import { fetchRemoteMeta, OFFLINE_META, RemoteMeta } from './CapabilityRegistry';
import { PilotTunnelManager } from './PilotTunnelManager';

/**
 * NodeRegistry: Manages connections for multiple nodes.
 *
 * In the Distributed API model:
 * - Local nodes: direct Docker socket connection via Dockerode (unchanged)
 * - Remote nodes: HTTP/WS proxy to a remote Sencho instance (api_url + api_token)
 *   No direct Docker TCP connections are made for remote nodes.
 *
 * Extends EventEmitter so subscribers (e.g. DockerEventManager) can react to
 * node lifecycle changes. Emits:
 *   - 'node-added'   (nodeId: number) after a node is created
 *   - 'node-removed' (nodeId: number) after a node is deleted
 *   - 'node-updated' (nodeId: number) after a node is updated (type may change)
 * Route handlers in index.ts are responsible for calling the notify* helpers.
 */
export class NodeRegistry extends EventEmitter {
    private static instance: NodeRegistry;
    private connections: Map<number, Docker> = new Map();

    private constructor() {
        super();
        // Raise the default listener cap (10) so future subscribers do not trip a warning.
        this.setMaxListeners(50);
    }

    public static getInstance(): NodeRegistry {
        if (!NodeRegistry.instance) {
            NodeRegistry.instance = new NodeRegistry();
        }
        return NodeRegistry.instance;
    }

    /**
     * Get a Docker client for a LOCAL node only.
     * Remote nodes are never accessed via Dockerode - use the HTTP proxy instead.
     */
    public getDocker(nodeId: number): Docker {
        if (this.connections.has(nodeId)) {
            return this.connections.get(nodeId)!;
        }

        const db = DatabaseService.getInstance();
        const node = db.getNode(nodeId);

        if (!node) {
            throw new Error(`Node with id ${nodeId} not found`);
        }

        if (node.type === 'remote') {
            throw new Error(
                `Node "${node.name}" is a remote Distributed API node. ` +
                `Its Docker daemon is not directly accessible - all requests are proxied via HTTP.`
            );
        }

        const docker = new Docker();
        this.connections.set(nodeId, docker);
        return docker;
    }

    /**
     * Get the Docker client for the default node.
     * Backward-compatible path for local-node code.
     */
    public getDefaultDocker(): Docker {
        const db = DatabaseService.getInstance();
        const defaultNode = db.getDefaultNode();

        if (!defaultNode || !defaultNode.id) {
            return new Docker();
        }

        return this.getDocker(defaultNode.id);
    }

    /**
     * Get the default node ID.
     */
    public getDefaultNodeId(): number {
        const db = DatabaseService.getInstance();
        const defaultNode = db.getDefaultNode();
        return defaultNode?.id || 1;
    }

    /**
     * Get a node configuration by its ID.
     */
    public getNode(nodeId: number): Node | undefined {
        const db = DatabaseService.getInstance();
        return db.getNode(nodeId);
    }

    /**
     * Get the HTTP proxy target for a remote node.
     * Returns { apiUrl, apiToken } for use by the HTTP proxy middleware.
     *
     * Pilot-agent nodes resolve to the loopback URL of their active tunnel
     * bridge; the bridge strips the bearer token and re-authenticates
     * implicitly via the pre-verified tunnel socket.
     */
    public getProxyTarget(nodeId: number): { apiUrl: string; apiToken: string } | null {
        const node = DatabaseService.getInstance().getNode(nodeId);
        if (!node || node.type !== 'remote') return null;

        if (node.mode === 'pilot_agent') {
            const loopbackUrl = PilotTunnelManager.getInstance().getLoopbackUrl(nodeId);
            if (!loopbackUrl) return null;
            return { apiUrl: loopbackUrl, apiToken: '' };
        }

        if (!node.api_url || !node.api_token) return null;
        return { apiUrl: node.api_url, apiToken: node.api_token };
    }

    /**
     * Fetch /api/meta from a remote node, dispatching through the proxy
     * target. Returns OFFLINE_META when no target is reachable (proxy-mode
     * missing api_url/api_token, or pilot-agent tunnel disconnected).
     */
    public async fetchMetaForNode(nodeId: number): Promise<RemoteMeta> {
        const target = this.getProxyTarget(nodeId);
        if (!target) return { ...OFFLINE_META };
        return fetchRemoteMeta(target.apiUrl, target.apiToken);
    }

    /**
     * Test connectivity to a specific node.
     * - Local: pings the Docker daemon directly
     * - Remote: makes a GET to /api/auth/check on the remote Sencho instance
     */
    public async testConnection(nodeId: number): Promise<{ success: boolean; error?: string; info?: any }> {
        const db = DatabaseService.getInstance();
        const node = db.getNode(nodeId);

        if (!node) {
            return { success: false, error: 'Node not found' };
        }

        if (node.type === 'remote') {
            if (node.mode === 'pilot_agent') {
                return this.testPilotConnection(node);
            }
            return this.testRemoteConnection(node);
        }

        return this.testLocalConnection(nodeId);
    }

    /**
     * Check whether a pilot-agent node has an active tunnel. Does not call
     * any endpoint; tunnel liveness is tracked in-process by
     * PilotTunnelManager and via the JWT handshake that originally accepted
     * the agent.
     */
    private async testPilotConnection(node: Node): Promise<{ success: boolean; error?: string; info?: any }> {
        const db = DatabaseService.getInstance();
        const active = PilotTunnelManager.getInstance().hasActiveTunnel(node.id);
        if (!active) {
            db.updateNodeStatus(node.id, 'offline');
            return { success: false, error: 'Pilot agent is not connected. Start the agent container or regenerate the enrollment token.' };
        }
        db.updateNodeStatus(node.id, 'online');
        return {
            success: true,
            info: {
                name: node.name,
                serverVersion: 'Pilot Agent',
                senchoVersion: node.pilot_agent_version ?? null,
                capabilities: [],
                os: 'Remote (tunnel)',
                architecture: 'Remote',
                containers: '-',
                containersRunning: '-',
                images: '-',
                memTotal: 0,
                cpus: '-',
                pilotLastSeen: node.pilot_last_seen ?? null,
            },
        };
    }

    private async testLocalConnection(nodeId: number): Promise<{ success: boolean; error?: string; info?: any }> {
        const db = DatabaseService.getInstance();
        try {
            const docker = new Docker();
            const info = await docker.info();

            if (!info || !info.OperatingSystem || typeof info.Containers !== 'number') {
                throw new Error('Invalid response from Docker daemon.');
            }

            db.updateNodeStatus(nodeId, 'online');
            return {
                success: true,
                info: {
                    name: info.Name,
                    serverVersion: info.ServerVersion,
                    os: info.OperatingSystem,
                    architecture: info.Architecture,
                    containers: info.Containers,
                    containersRunning: info.ContainersRunning,
                    images: info.Images,
                    memTotal: info.MemTotal,
                    cpus: info.NCPU,
                }
            };
        } catch (error: any) {
            db.updateNodeStatus(nodeId, 'offline');
            return { success: false, error: error.message || 'Connection failed' };
        }
    }

    private async testRemoteConnection(node: Node): Promise<{ success: boolean; error?: string; info?: any }> {
        const db = DatabaseService.getInstance();

        if (!node.api_url || !node.api_token) {
            return { success: false, error: 'Remote node is missing an API URL or token. Configure it in Settings → Nodes.' };
        }

        const baseUrl = node.api_url.replace(/\/$/, '');
        const headers = { Authorization: `Bearer ${node.api_token}` };

        try {
            // Step 1: Verify auth. A 401 here means wrong token - surface that clearly.
            const authRes = await axios.get(`${baseUrl}/api/auth/check`, { headers, timeout: 8000 });
            if (authRes.status !== 200) throw new Error(`Unexpected status ${authRes.status}`);

            db.updateNodeStatus(node.id, 'online');

            // Step 2: Fetch Docker stats in parallel. Use allSettled so a slow or missing
            // endpoint doesn't fail the whole test - each field falls back to '-' gracefully.
            const [statsResult, sysResult, imagesResult, metaResult] = await Promise.allSettled([
                axios.get(`${baseUrl}/api/stats`, { headers, timeout: 8000 }),
                axios.get(`${baseUrl}/api/system/stats`, { headers, timeout: 8000 }),
                axios.get(`${baseUrl}/api/system/images`, { headers, timeout: 8000 }),
                fetchRemoteMeta(baseUrl, node.api_token!),
            ]);

            const stats = statsResult.status === 'fulfilled' ? statsResult.value.data : null;
            const sys = sysResult.status === 'fulfilled' ? sysResult.value.data : null;
            const images = imagesResult.status === 'fulfilled' ? imagesResult.value.data : null;
            const meta = metaResult.status === 'fulfilled' ? metaResult.value : null;

            return {
                success: true,
                info: {
                    name: node.name,
                    serverVersion: 'Remote Sencho',
                    senchoVersion: meta?.version ?? null,
                    capabilities: meta?.capabilities ?? [],
                    os: 'Remote',
                    architecture: 'Remote',
                    containers: stats?.total ?? '-',
                    containersRunning: stats?.active ?? '-',
                    images: Array.isArray(images) ? images.length : '-',
                    memTotal: sys?.memory?.total ?? 0,
                    cpus: sys?.cpu?.cores ?? '-',
                }
            };
        } catch (error: any) {
            db.updateNodeStatus(node.id, 'offline');
            const msg = error.response?.status === 401
                ? 'Authentication failed - check the API token.'
                : (error.message || 'Connection failed');
            return { success: false, error: msg };
        }
    }

    /**
     * Evict a cached Docker connection (e.g., after node config change).
     */
    public evictConnection(nodeId: number): void {
        this.connections.delete(nodeId);
    }

    /**
     * Emit 'node-added' for subscribers (e.g. DockerEventManager).
     * Call this from the POST /api/nodes route after the DB insert succeeds.
     */
    public notifyNodeAdded(nodeId: number): void {
        this.emit('node-added', nodeId);
    }

    /**
     * Emit 'node-removed' for subscribers.
     * Call this from the DELETE /api/nodes/:id route after the DB delete succeeds.
     */
    public notifyNodeRemoved(nodeId: number): void {
        this.emit('node-removed', nodeId);
    }

    /**
     * Emit 'node-updated' for subscribers. Type changes (local<->remote) are
     * handled downstream by tearing down and respawning the subscription.
     * Call this from the PUT /api/nodes/:id route after the DB update succeeds.
     */
    public notifyNodeUpdated(nodeId: number): void {
        this.emit('node-updated', nodeId);
    }

    /**
     * Flush all cached connections.
     */
    public flushAll(): void {
        this.connections.clear();
    }

    /**
     * Get the compose directory for a local node.
     */
    public getComposeDir(nodeId: number): string {
        const db = DatabaseService.getInstance();
        const node = db.getNode(nodeId);
        return node?.compose_dir || process.env.COMPOSE_DIR || '/app/compose';
    }
}
