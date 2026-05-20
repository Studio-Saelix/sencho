/**
 * Narrow contract test for `MeshService.removeOverrideFromNode` against a
 * remote node. Pins the HTTP shape (method, path, headers) so a regression
 * inside `removeOverrideFromNode` itself is caught even when callers like
 * `disableForNode` are tested against a mock of the helper.
 *
 * Same fetch-spy pattern as `mesh-inspect-remote.test.ts`.
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

describe('MeshService.removeOverrideFromNode (remote dispatch)', () => {
    it('issues DELETE /api/mesh/local-override/<stack> with Authorization and tier headers', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const remoteNodeId = db.addNode({
            name: 'remove-override-remote-test',
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
            .mockResolvedValue(new Response('ok', { status: 200 }));

        await svc.removeOverrideFromNode(remoteNodeId, 'sample-stack');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const call = fetchMock.mock.calls[0];
        expect(String(call[0])).toBe('https://remote.example.com:1852/api/mesh/local-override/sample-stack');
        const init = call[1] as { method: string; headers: Record<string, string> };
        expect(init.method).toBe('DELETE');
        expect(init.headers['Authorization']).toBe('Bearer remote-tok');
        expect(init.headers).toHaveProperty('x-sencho-tier');
        expect(init.headers).toHaveProperty('x-sencho-variant');

        db.deleteNode(remoteNodeId);
    });

    it('url-encodes the stack name in the path', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const remoteNodeId = db.addNode({
            name: 'remove-override-encode-test',
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
            .mockResolvedValue(new Response('ok', { status: 200 }));

        await svc.removeOverrideFromNode(remoteNodeId, 'stack with space');

        const call = fetchMock.mock.calls[0];
        expect(String(call[0])).toBe('https://remote.example.com:1852/api/mesh/local-override/stack%20with%20space');

        db.deleteNode(remoteNodeId);
    });

    it('swallows network errors from the remote so the disable cascade can continue', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const remoteNodeId = db.addNode({
            name: 'remove-override-error-test',
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

        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });

        // Must not throw: the remote being offline is a tolerable condition;
        // the cascade upstream uses Promise.allSettled and continues.
        await expect(svc.removeOverrideFromNode(remoteNodeId, 'sample-stack')).resolves.toBeUndefined();
        expect(warnSpy).toHaveBeenCalled();

        db.deleteNode(remoteNodeId);
    });
});
