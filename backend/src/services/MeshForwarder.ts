import net from 'net';
import { sanitizeForLog } from '../utils/safeLog';

/**
 * In-process mesh TCP forwarder. Owns per-port `net.Server` listeners on the
 * host network and delegates accepted sockets to the host (MeshService) for
 * resolve + splice. Replaces the separate `saelix/sencho-mesh` sidecar
 * container that previously did this job over a control WebSocket. The
 * resolve step is now a sync map lookup rather than a round-trip, so
 * MeshForwarder is just a thin lifecycle layer; all routing + splicing
 * lives on MeshService.
 *
 * Sencho's container must run in `network_mode: host` (Linux) for the
 * listeners to bind on the host's network where meshed containers'
 * `extra_hosts: <alias>:host-gateway` entries point. Without host network
 * mode, `net.createServer().listen(port)` lands inside the container's
 * namespace and inbound traffic from peers never reaches it.
 */

export interface MeshForwarderHost {
    /** Called on each accepted inbound socket. The host owns the splice
     *  lifecycle; MeshForwarder only manages listener boilerplate. */
    handleAccept(port: number, source: net.Socket): Promise<void>;
}

export class MeshForwarder {
    private readonly listeners = new Map<number, net.Server>();
    /**
     * In-flight `listen(port)` promises so concurrent callers race-safely
     * deduplicate. Without this guard, two concurrent calls to listen on
     * the same port would both pass the `listeners.has(port)` check (which
     * is only populated after the listening event resolves) and the second
     * would fail with EADDRINUSE.
     */
    private readonly pending = new Map<number, Promise<void>>();
    private shuttingDown = false;

    constructor(private readonly host: MeshForwarderHost) {}

    public async listen(port: number): Promise<void> {
        if (this.shuttingDown) return;
        if (this.listeners.has(port)) return;
        const inflight = this.pending.get(port);
        if (inflight) return inflight;
        const promise = (async () => {
            const server = net.createServer((socket) => this.acceptConnection(port, socket));
            try {
                await new Promise<void>((resolve, reject) => {
                    const onError = (err: Error) => { server.removeListener('listening', onListening); reject(err); };
                    const onListening = () => { server.removeListener('error', onError); resolve(); };
                    server.once('error', onError);
                    server.once('listening', onListening);
                    // Bind on all interfaces. Under host network mode this is
                    // the host's own network; under bridge mode (mesh disabled
                    // at boot) this would be the container's namespace.
                    server.listen(port, '0.0.0.0');
                });
                this.listeners.set(port, server);
            } finally {
                this.pending.delete(port);
            }
        })();
        this.pending.set(port, promise);
        return promise;
    }

    public async unlisten(port: number): Promise<void> {
        const server = this.listeners.get(port);
        if (!server) return;
        this.listeners.delete(port);
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    public async shutdown(): Promise<void> {
        this.shuttingDown = true;
        const ports = Array.from(this.listeners.keys());
        await Promise.all(ports.map((p) => this.unlisten(p)));
    }

    public getListenerPorts(): number[] {
        return Array.from(this.listeners.keys());
    }

    public isListening(port: number): boolean {
        return this.listeners.has(port);
    }

    private acceptConnection(port: number, source: net.Socket): void {
        if (this.shuttingDown) {
            try { source.destroy(); } catch { /* ignore */ }
            return;
        }
        // Defer to the host for resolve + splice. MeshForwarder itself does
        // not look at the source bytes; routing lives on MeshService where
        // the alias map and the cross-node bridge dispatch are.
        this.host.handleAccept(port, source).catch((err) => {
            console.warn('[MeshForwarder] accept handler failed:', sanitizeForLog((err as Error).message));
            try { source.destroy(); } catch { /* ignore */ }
        });
    }
}
