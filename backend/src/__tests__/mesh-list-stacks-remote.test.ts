/**
 * Regression guard for F8: MeshService.listStacksOnNode dispatches local-vs-remote
 * the same way as inspectStackServices.
 *
 *   - Local node  → reads the LOCAL filesystem via FileSystemService.getStacks().
 *   - Remote node → fetches `/api/mesh/local-stacks` against the resolved proxy
 *     target with the appropriate Authorization and license tier headers,
 *     parses the JSON envelope, and returns the decoded `stacks[]` array.
 *
 * Pre-fix the route in `routes/mesh.ts` called FileSystemService.getInstance(nodeId)
 * unconditionally, which always reads central's own filesystem regardless of
 * whether the targeted node was local or remote. Result: the mesh opt-in sheet
 * showed "No stacks deployed on this node yet" for every remote pilot.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let MeshService: typeof import('../services/MeshService').MeshService;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let NodeRegistry: typeof import('../services/NodeRegistry').NodeRegistry;
let FileSystemService: typeof import('../services/FileSystemService').FileSystemService;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ MeshService } = await import('../services/MeshService'));
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ NodeRegistry } = await import('../services/NodeRegistry'));
    ({ FileSystemService } = await import('../services/FileSystemService'));
});

afterAll(() => {
    vi.restoreAllMocks();
    cleanupTestDb(tmpDir);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('MeshService.listStacksOnNode dispatch (F8)', () => {
    it('uses the local filesystem path for the local node', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const localNodeId = db.getNodes()[0].id;

        const fsSpy = vi
            .spyOn(FileSystemService.prototype, 'getStacks')
            .mockResolvedValue(['audit-mesh-prod', 'whoami']);
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        const out = await svc.listStacksOnNode(localNodeId);

        expect(out).toEqual(['audit-mesh-prod', 'whoami']);
        expect(fsSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('fetches /api/mesh/local-stacks for remote nodes and forwards the proxy target headers', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const remoteNodeId = db.addNode({
            name: 'list-stacks-remote-test',
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

        const fetchMock = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(new Response(
                JSON.stringify({ stacks: ['audit-mesh-pilot', 'monitor'] }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            ));

        const out = await svc.listStacksOnNode(remoteNodeId);

        expect(out).toEqual(['audit-mesh-pilot', 'monitor']);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const call = fetchMock.mock.calls[0];
        expect(String(call[0])).toBe('https://remote.example.com:1852/api/mesh/local-stacks');
        const init = call[1] as { method: string; headers: Record<string, string> };
        expect(init.method).toBe('GET');
        expect(init.headers['Authorization']).toBe('Bearer remote-tok');
        expect(init.headers).toHaveProperty('x-sencho-tier');
        expect(init.headers).toHaveProperty('x-sencho-variant');

        db.deleteNode(remoteNodeId);
    });

    it('returns [] when the remote responds non-2xx', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const remoteNodeId = db.addNode({
            name: 'list-stacks-remote-fail',
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
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Internal Server Error', { status: 500 }));

        const out = await svc.listStacksOnNode(remoteNodeId);

        expect(out).toEqual([]);
        db.deleteNode(remoteNodeId);
    });

    it('returns [] for a remote node with no active proxy target (e.g. pilot-agent tunnel down)', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const remoteNodeId = db.addNode({
            name: 'list-stacks-remote-down',
            type: 'remote',
            mode: 'pilot_agent',
            compose_dir: '/tmp',
            is_default: false,
            api_url: '',
            api_token: '',
        });

        vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue(null);
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        const out = await svc.listStacksOnNode(remoteNodeId);

        expect(out).toEqual([]);
        expect(fetchSpy).not.toHaveBeenCalled();
        db.deleteNode(remoteNodeId);
    });

    it('defends against malformed remote bodies', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const remoteNodeId = db.addNode({
            name: 'list-stacks-remote-malformed',
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
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
            JSON.stringify({ stacks: ['ok-string', 42, null, { not: 'a string' }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        ));

        const out = await svc.listStacksOnNode(remoteNodeId);

        expect(out).toEqual(['ok-string']);
        db.deleteNode(remoteNodeId);
    });

    it('returns [] for an unknown node id', async () => {
        const svc = MeshService.getInstance();
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const out = await svc.listStacksOnNode(999_999);
        expect(out).toEqual([]);
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
