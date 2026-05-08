/**
 * Regression guard for the C-4 fix: MeshService sidecar lifecycle methods
 * (spawn/stop/inspect) used DockerController.getInstance(nodeId), but
 * NodeRegistry.getDocker explicitly throws for remote nodes by design.
 * Sidecars must spawn on each node's LOCAL Docker daemon, so the central
 * cannot drive remote spawns via Dockerode. The fix mirrors PR #992: the
 * dispatcher routes local nodes to the existing Dockerode path and remote
 * nodes to a new HTTP endpoint on the remote Sencho's mesh router that
 * runs the same Dockerode logic against its own local daemon.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let MeshService: typeof import('../services/MeshService').MeshService;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let NodeRegistry: typeof import('../services/NodeRegistry').NodeRegistry;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ MeshService } = await import('../services/MeshService'));
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ NodeRegistry } = await import('../services/NodeRegistry'));
});

afterAll(() => {
    vi.restoreAllMocks();
    cleanupTestDb(tmpDir);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('MeshService sidecar lifecycle dispatch (C-4 fix)', () => {
    it('routes spawn for the local node to spawnLocalSidecar (no remote HTTP)', async () => {
        const svc = MeshService.getInstance();
        const localNodeId = DatabaseService.getInstance().getNodes()[0].id;

        const localSpy = vi.spyOn(svc, 'spawnLocalSidecar').mockResolvedValue(undefined);
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        await svc.spawnSidecar(localNodeId);

        expect(localSpy).toHaveBeenCalledWith(localNodeId);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('routes spawn for a remote node to the local-sidecar HTTP endpoint with proxy headers', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const remoteNodeId = db.addNode({
            name: 'sidecar-remote-test',
            type: 'remote',
            mode: 'proxy',
            compose_dir: '/tmp',
            is_default: false,
            api_url: 'https://remote.example.com:1852',
            api_token: 'remote-tok',
        });

        vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue({
            apiUrl: 'https://remote.example.com:1852',
            apiToken: 'remote-tok',
        });
        const localSpy = vi.spyOn(svc, 'spawnLocalSidecar');
        const fetchMock = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));

        await svc.spawnSidecar(remoteNodeId);

        expect(localSpy).not.toHaveBeenCalled();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toBe('https://remote.example.com:1852/api/mesh/local-sidecar/spawn');
        expect((init as { method: string }).method).toBe('POST');
        const headers = (init as { headers: Record<string, string> }).headers;
        expect(headers['Authorization']).toBe('Bearer remote-tok');
        expect(headers).toHaveProperty('x-sencho-tier');

        db.deleteNode(remoteNodeId);
    });

    it('throws when spawn for a remote node has no active proxy target (e.g. pilot tunnel down)', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const remoteNodeId = db.addNode({
            name: 'sidecar-remote-down',
            type: 'remote',
            mode: 'pilot_agent',
            compose_dir: '/tmp',
            is_default: false,
            api_url: '',
            api_token: '',
        });

        vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue(null);

        await expect(svc.spawnSidecar(remoteNodeId)).rejects.toThrow(/no active proxy target/);
        db.deleteNode(remoteNodeId);
    });

    it('routes stop for a remote node to the local-sidecar HTTP endpoint', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const remoteNodeId = db.addNode({
            name: 'sidecar-remote-stop',
            type: 'remote',
            mode: 'proxy',
            compose_dir: '/tmp',
            is_default: false,
            api_url: 'https://remote.example.com:1852',
            api_token: 'remote-tok',
        });

        vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue({
            apiUrl: 'https://remote.example.com:1852',
            apiToken: 'remote-tok',
        });
        const fetchMock = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));

        await svc.stopSidecar(remoteNodeId);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toBe('https://remote.example.com:1852/api/mesh/local-sidecar/stop');
        expect((init as { method: string }).method).toBe('POST');

        db.deleteNode(remoteNodeId);
    });

    it('isSidecarRunning for a remote node uses GET /local-sidecar/inspect and folds running:true into true', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const remoteNodeId = db.addNode({
            name: 'sidecar-remote-running',
            type: 'remote',
            mode: 'proxy',
            compose_dir: '/tmp',
            is_default: false,
            api_url: 'https://remote.example.com:1852',
            api_token: 'remote-tok',
        });

        vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue({
            apiUrl: 'https://remote.example.com:1852',
            apiToken: 'remote-tok',
        });
        const fetchMock = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValue(new Response(JSON.stringify({ running: true }), { status: 200, headers: { 'content-type': 'application/json' } }));

        const out = await (svc as unknown as { isSidecarRunning: (n: number) => Promise<boolean> }).isSidecarRunning(remoteNodeId);

        expect(out).toBe(true);
        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toBe('https://remote.example.com:1852/api/mesh/local-sidecar/inspect');
        expect((init as { method: string }).method).toBe('GET');

        db.deleteNode(remoteNodeId);
    });

    it('stopSidecar on an unknown nodeId is a silent no-op (no throw, no fetch)', async () => {
        const svc = MeshService.getInstance();
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const localSpy = vi.spyOn(svc, 'stopLocalSidecar');

        await expect(svc.stopSidecar(999_999)).resolves.toBeUndefined();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(localSpy).not.toHaveBeenCalled();
    });

    it('isSidecarRunning for a remote node returns false when the inspect HTTP call returns non-2xx', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const remoteNodeId = db.addNode({
            name: 'sidecar-remote-inspect-fail',
            type: 'remote',
            mode: 'proxy',
            compose_dir: '/tmp',
            is_default: false,
            api_url: 'https://remote.example.com:1852',
            api_token: 'remote-tok',
        });

        vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue({
            apiUrl: 'https://remote.example.com:1852',
            apiToken: 'remote-tok',
        });
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 502 }));

        const out = await (svc as unknown as { isSidecarRunning: (n: number) => Promise<boolean> }).isSidecarRunning(remoteNodeId);
        expect(out).toBe(false);
        db.deleteNode(remoteNodeId);
    });
});
