/**
 * Regression guard for the C-3 fix: MeshService inspects remote nodes via the
 * existing HTTP proxy chain rather than calling Dockerode directly (which
 * NodeRegistry.getDocker explicitly throws for any remote node by design).
 *
 * Two behaviors covered:
 *   1. For a local node, the dispatcher calls `inspectLocalStackServices`
 *      (which uses the local Dockerode).
 *   2. For a remote node, the dispatcher fetches `/api/mesh/local-services/:stackName`
 *      against the resolved proxy target with the appropriate Authorization
 *      and license tier headers, parses the JSON envelope, and returns the
 *      decoded `services[]` array.
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
    // Restore both spies and the global fetch patch so a sibling test file
    // running in the same worker (e.g. fleet.test.ts) does not see a stale
    // mocked fetch / getProxyTarget.
    vi.restoreAllMocks();
});

describe('MeshService.inspectStackServices dispatch (C-3 fix)', () => {
    it('uses the local Dockerode path for the local node', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const localNodeId = db.getNodes()[0].id;

        const localSpy = vi
            .spyOn(svc, 'inspectLocalStackServices')
            .mockResolvedValue([{ service: 'echo', ports: [9000] }]);
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        const out = await (svc as unknown as { inspectStackServices: (n: number, s: string) => Promise<unknown> })
            .inspectStackServices(localNodeId, 'audit-mesh-prod');

        expect(localSpy).toHaveBeenCalledWith('audit-mesh-prod');
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(out).toEqual([{ service: 'echo', ports: [9000] }]);
    });

    it('fetches /api/mesh/local-services for remote nodes and forwards the proxy target headers', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const remoteNodeId = db.addNode({
            name: 'inspect-remote-test',
            type: 'remote',
            mode: 'proxy',
            compose_dir: '/tmp',
            is_default: false,
            api_url: 'https://remote.example.com:1852',
            api_token: 'remote-tok',
        });

        // Force the registry to return a known target so we exercise the
        // request shape rather than the registry's own resolution rules.
        vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue({
            apiUrl: 'https://remote.example.com:1852',
            apiToken: 'remote-tok',
        });

        const fetchMock = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(new Response(
                JSON.stringify({ services: [{ service: 'echo', ports: [9001] }] }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            ));

        const out = await (svc as unknown as { inspectStackServices: (n: number, s: string) => Promise<unknown> })
            .inspectStackServices(remoteNodeId, 'audit-mesh-pilot');

        expect(out).toEqual([{ service: 'echo', ports: [9001] }]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const call = fetchMock.mock.calls[0];
        expect(String(call[0])).toBe('https://remote.example.com:1852/api/mesh/local-services/audit-mesh-pilot');
        const headers = (call[1] as { headers: Record<string, string> }).headers;
        expect(headers['Authorization']).toBe('Bearer remote-tok');
        expect(headers).toHaveProperty('x-sencho-tier');
        expect(headers).toHaveProperty('x-sencho-variant');

        db.deleteNode(remoteNodeId);
    });

    it('returns [] when the remote responds non-2xx', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const remoteNodeId = db.addNode({
            name: 'inspect-remote-fail',
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

        const out = await (svc as unknown as { inspectStackServices: (n: number, s: string) => Promise<unknown> })
            .inspectStackServices(remoteNodeId, 'audit-mesh-pilot');

        expect(out).toEqual([]);
        db.deleteNode(remoteNodeId);
    });

    it('returns [] for a remote node with no active proxy target (e.g. pilot-agent tunnel down)', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const remoteNodeId = db.addNode({
            name: 'inspect-remote-down',
            type: 'remote',
            mode: 'pilot_agent',
            compose_dir: '/tmp',
            is_default: false,
            api_url: '',
            api_token: '',
        });

        vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue(null);
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        const out = await (svc as unknown as { inspectStackServices: (n: number, s: string) => Promise<unknown> })
            .inspectStackServices(remoteNodeId, 'audit-mesh-pilot');

        expect(out).toEqual([]);
        expect(fetchSpy).not.toHaveBeenCalled();
        db.deleteNode(remoteNodeId);
    });

    it('logs an offline-shaped warn (not a generic error) when proxyFetch throws MeshError no_target', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const remoteNodeId = db.addNode({
            name: 'inspect-remote-no-target',
            type: 'remote',
            mode: 'pilot_agent',
            compose_dir: '/tmp',
            is_default: false,
            api_url: '',
            api_token: '',
        });

        // getProxyTarget returns null -> proxyFetch raises MeshError('no_target').
        // The catch branch must recognise no_target alongside push_failed and
        // emit console.warn (operator-friendly), not console.error (which the
        // Routing tab surfaces as an unexpected fault).
        vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue(null);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* swallow */ });
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { /* swallow */ });

        const out = await (svc as unknown as { inspectStackServices: (n: number, s: string) => Promise<unknown> })
            .inspectStackServices(remoteNodeId, 'audit-mesh-pilot');

        expect(out).toEqual([]);
        const warnedAboutNoTarget = warnSpy.mock.calls.some((args) =>
            String(args[0] ?? '').includes('inspectStackServices: unreachable') &&
            String(args[0] ?? '').includes('no_target'),
        );
        expect(warnedAboutNoTarget).toBe(true);
        // No "remote unreachable" error log: that path is reserved for
        // unexpected exceptions, not the known no_target / push_failed pair.
        const erroredAsUnreachable = errorSpy.mock.calls.some((args) =>
            String(args[0] ?? '').includes('inspectStackServices remote unreachable'),
        );
        expect(erroredAsUnreachable).toBe(false);

        db.deleteNode(remoteNodeId);
    });
});
