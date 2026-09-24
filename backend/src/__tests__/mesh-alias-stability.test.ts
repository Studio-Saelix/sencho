/**
 * Alias and port stability while a node is offline.
 *
 * Before: the 60s alias refresh rebuilt everything from live inspection,
 * and an unreachable node contributed nothing. Its aliases vanished from
 * every override written in that window and its ports became claimable by
 * another stack. Now the refresh keeps each stack's last known services for
 * unreachable nodes, and a stopped stack keeps its ports reserved.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let MeshService: typeof import('../services/MeshService').MeshService;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let remoteNodeId: number;

type Inspect = (nodeId: number, stack: string, reach?: { reachable: boolean }) => Promise<Array<{ service: string; ports: number[] }>>;
type Internals = {
    inspectStackServices: Inspect;
    reservedPorts: Map<number, { host: string }>;
    aliasByPort: Map<number, unknown>;
    aliasCache: Map<string, unknown>;
};

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ MeshService } = await import('../services/MeshService'));
    ({ DatabaseService } = await import('../services/DatabaseService'));
    remoteNodeId = DatabaseService.getInstance().addNode({
        name: 'edge',
        type: 'remote',
        compose_dir: '',
        is_default: false,
        api_url: 'http://edge.invalid:1852',
        api_token: 'tok',
    });
});

afterAll(() => {
    vi.restoreAllMocks();
    cleanupTestDb(tmpDir);
});

beforeEach(() => {
    vi.restoreAllMocks();
    const db = DatabaseService.getInstance();
    for (const row of db.listMeshStacks()) db.deleteMeshStack(row.node_id, row.stack_name);
    const svc = MeshService.getInstance() as unknown as Internals;
    svc.reservedPorts = new Map();
    svc.aliasByPort = new Map();
    svc.aliasCache = new Map();
});

function mockInspect(impl: Inspect): void {
    const svc = MeshService.getInstance() as unknown as Internals;
    vi.spyOn(svc, 'inspectStackServices').mockImplementation(impl);
}

describe('mesh alias stability', () => {
    it('persists the services seen while the node is reachable', async () => {
        const db = DatabaseService.getInstance();
        db.insertMeshStack(remoteNodeId, 'pg', 'tester');
        mockInspect(async () => [{ service: 'db', ports: [5432] }]);

        await MeshService.getInstance().refreshAliasCache();

        const row = db.listMeshStacks(remoteNodeId).find((r) => r.stack_name === 'pg');
        expect(JSON.parse(row?.last_known_services ?? 'null')).toEqual([{ service: 'db', ports: [5432] }]);
    });

    it('keeps aliases and port reservations of an unreachable node', async () => {
        const db = DatabaseService.getInstance();
        db.insertMeshStack(remoteNodeId, 'pg', 'tester');
        db.setMeshStackLastKnownServices(remoteNodeId, 'pg', JSON.stringify([{ service: 'db', ports: [5432] }]));
        mockInspect(async (_n, _s, reach) => {
            if (reach) reach.reachable = false;
            return [];
        });

        const svc = MeshService.getInstance();
        await svc.refreshAliasCache();

        const hosts = (await svc.listAliases()).map((a) => a.host);
        expect(hosts).toContain('db.pg.edge.sencho');
        expect((svc as unknown as Internals).reservedPorts.get(5432)?.host).toBe('db.pg.edge.sencho');
    });

    it('drops aliases of a reachable but stopped stack while keeping its ports reserved', async () => {
        const db = DatabaseService.getInstance();
        db.insertMeshStack(remoteNodeId, 'pg', 'tester');
        db.setMeshStackLastKnownServices(remoteNodeId, 'pg', JSON.stringify([{ service: 'db', ports: [5432] }]));
        mockInspect(async () => []);

        const svc = MeshService.getInstance();
        await svc.refreshAliasCache();

        expect((await svc.listAliases()).map((a) => a.host)).not.toContain('db.pg.edge.sencho');
        expect((svc as unknown as Internals).reservedPorts.has(5432)).toBe(true);
    });

    it('gives a contested port to the earliest opt-in, regardless of inspection order', async () => {
        const db = DatabaseService.getInstance();
        db.insertMeshStack(remoteNodeId, 'first', 'tester');
        db.insertMeshStack(remoteNodeId, 'second', 'tester');
        mockInspect(async (_n, stack) => {
            // Resolve the older stack last to prove ordering does not depend on timing.
            if (stack === 'first') await new Promise((r) => setTimeout(r, 20));
            return [{ service: 'web', ports: [8080] }];
        });

        const svc = MeshService.getInstance();
        await svc.refreshAliasCache();

        expect((svc as unknown as Internals).reservedPorts.get(8080)?.host).toBe('web.first.edge.sencho');
    });
});
