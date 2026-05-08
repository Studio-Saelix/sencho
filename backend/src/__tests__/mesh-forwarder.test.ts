/**
 * Unit tests for MeshForwarder. Exercises the per-port listener lifecycle
 * (listen/unlisten/shutdown) and the accept dispatch into the host
 * (MeshService surrogate). MeshForwarder itself does not splice bytes —
 * the host's `handleAccept` does — so the test injects a recording
 * surrogate and asserts the call shape.
 */
import net from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MeshForwarder, type MeshForwarderHost } from '../services/MeshForwarder';

interface Accept {
    port: number;
    socket: net.Socket;
}

function makeRecordingHost(): { host: MeshForwarderHost; accepts: Accept[]; resolveAfter: (cb: (a: Accept) => void) => void } {
    const accepts: Accept[] = [];
    const subscribers: Array<(a: Accept) => void> = [];
    const host: MeshForwarderHost = {
        async handleAccept(port, socket) {
            const a = { port, socket };
            accepts.push(a);
            for (const s of subscribers.splice(0)) s(a);
        },
    };
    return {
        host,
        accepts,
        resolveAfter: (cb) => { subscribers.push(cb); },
    };
}

async function getEphemeralPort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.unref();
        s.listen(0, '127.0.0.1', () => {
            const addr = s.address();
            if (!addr || typeof addr === 'string') {
                reject(new Error('no address'));
                return;
            }
            const port = addr.port;
            s.close(() => resolve(port));
        });
    });
}

async function dial(port: number, host = '127.0.0.1'): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const s = net.createConnection({ host, port });
        s.once('connect', () => resolve(s));
        s.once('error', reject);
    });
}

async function waitFor<T>(check: () => T | undefined, timeoutMs = 1000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const v = check();
        if (v !== undefined && v !== null && (Array.isArray(v) ? (v as unknown[]).length > 0 : true)) {
            return v as T;
        }
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('timeout waiting for condition');
}

describe('MeshForwarder', () => {
    let forwarder: MeshForwarder | null = null;

    afterEach(async () => {
        if (forwarder) await forwarder.shutdown();
        forwarder = null;
    });

    beforeEach(() => { /* fresh per test */ });

    it('binds a listener on the requested port and reports it via getListenerPorts', async () => {
        const { host } = makeRecordingHost();
        forwarder = new MeshForwarder(host);
        const port = await getEphemeralPort();
        await forwarder.listen(port);

        expect(forwarder.getListenerPorts()).toEqual([port]);
        expect(forwarder.isListening(port)).toBe(true);
    });

    it('hands accepted sockets to the host with the original destination port', async () => {
        const { host, accepts } = makeRecordingHost();
        forwarder = new MeshForwarder(host);
        const port = await getEphemeralPort();
        await forwarder.listen(port);

        const client = await dial(port);
        const seen = await waitFor(() => accepts.length ? accepts : undefined);
        expect(seen[0].port).toBe(port);
        expect(seen[0].socket).toBeInstanceOf(net.Socket);

        client.destroy();
        seen[0].socket.destroy();
    });

    it('listen is idempotent (repeated calls on the same port no-op)', async () => {
        const { host } = makeRecordingHost();
        forwarder = new MeshForwarder(host);
        const port = await getEphemeralPort();
        await forwarder.listen(port);
        await forwarder.listen(port);
        expect(forwarder.getListenerPorts()).toEqual([port]);
    });

    it('two concurrent listen() calls on the same port produce a single bind, not EADDRINUSE', async () => {
        const { host } = makeRecordingHost();
        forwarder = new MeshForwarder(host);
        const port = await getEphemeralPort();
        // Fire both calls before either resolves. Without the in-flight
        // dedup map, the second call would race past the listeners.has()
        // check and fail with EADDRINUSE on its own bind attempt.
        const [a, b] = await Promise.all([forwarder.listen(port), forwarder.listen(port)]);
        expect(a).toBeUndefined();
        expect(b).toBeUndefined();
        expect(forwarder.getListenerPorts()).toEqual([port]);
    });

    it('unlisten releases the port so a new listener can bind it', async () => {
        const { host } = makeRecordingHost();
        forwarder = new MeshForwarder(host);
        const port = await getEphemeralPort();
        await forwarder.listen(port);
        await forwarder.unlisten(port);
        expect(forwarder.isListening(port)).toBe(false);

        // Verify the port is genuinely free by binding a fresh net.Server.
        await new Promise<void>((resolve, reject) => {
            const probe = net.createServer();
            probe.once('error', reject);
            probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
        });
    });

    it('rejects new connections after shutdown', async () => {
        const { host } = makeRecordingHost();
        forwarder = new MeshForwarder(host);
        const port = await getEphemeralPort();
        await forwarder.listen(port);
        await forwarder.shutdown();

        await expect(dial(port)).rejects.toThrow();
        forwarder = null;
    });

    it('destroys the source socket when the host handler throws', async () => {
        const host: MeshForwarderHost = {
            async handleAccept() { throw new Error('host blew up'); },
        };
        forwarder = new MeshForwarder(host);
        const port = await getEphemeralPort();
        await forwarder.listen(port);

        const client = await dial(port);
        const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
        await closed;
    });
});
