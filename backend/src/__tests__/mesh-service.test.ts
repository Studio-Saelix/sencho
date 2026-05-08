import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let MeshService: typeof import('../services/MeshService').MeshService;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ MeshService } = await import('../services/MeshService'));
    ({ DatabaseService } = await import('../services/DatabaseService'));
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

beforeEach(() => {
    const db = DatabaseService.getInstance().getDb();
    db.prepare('DELETE FROM mesh_stacks').run();
    db.prepare('DELETE FROM nodes WHERE is_default = 0').run();
    const svc = MeshService.getInstance() as unknown as {
        aliasCache: Map<string, unknown>;
        aliasByPort: Map<number, unknown>;
        activity: unknown[];
        activeStreams: Map<number, unknown>;
        routeErrorMap: Map<string, unknown>;
        routeLatencyMap: Map<string, unknown>;
    };
    svc.aliasCache = new Map();
    svc.aliasByPort = new Map();
    svc.activity = [];
    svc.activeStreams = new Map();
    svc.routeErrorMap = new Map();
    svc.routeLatencyMap = new Map();
    vi.restoreAllMocks();
});

describe('MeshService.optInStack', () => {
    it('writes a mesh_stacks row and rejects duplicate ports', async () => {
        const svc = MeshService.getInstance();

        vi.spyOn(svc as unknown as { inspectStackServices: (n: number, s: string) => Promise<unknown> }, 'inspectStackServices')
            .mockResolvedValue([{ service: 'db', ports: [5432] }]);
        vi.spyOn(svc as unknown as { regenerateOverridesForNode: (n: number) => Promise<void> }, 'regenerateOverridesForNode')
            .mockResolvedValue(undefined);

        const db = DatabaseService.getInstance();
        const localNodeId = db.getNodes()[0].id;

        await svc.optInStack(localNodeId, 'api', 'tester');
        expect(db.isMeshStackEnabled(localNodeId, 'api')).toBe(true);

        await expect(svc.optInStack(localNodeId, 'shadow', 'tester'))
            .rejects.toThrow(/port 5432 is already claimed/);
    });

    it('opt-out removes the row and the override', async () => {
        const svc = MeshService.getInstance();
        vi.spyOn(svc as unknown as { inspectStackServices: (n: number, s: string) => Promise<unknown> }, 'inspectStackServices')
            .mockResolvedValue([{ service: 'db', ports: [5432] }]);
        vi.spyOn(svc as unknown as { regenerateOverridesForNode: (n: number) => Promise<void> }, 'regenerateOverridesForNode')
            .mockResolvedValue(undefined);
        vi.spyOn(svc as unknown as { removeStackOverride: (n: number, s: string) => Promise<void> }, 'removeStackOverride')
            .mockResolvedValue(undefined);

        const db = DatabaseService.getInstance();
        const localNodeId = db.getNodes()[0].id;
        await svc.optInStack(localNodeId, 'api', 'tester');
        await svc.optOutStack(localNodeId, 'api', 'tester');
        expect(db.isMeshStackEnabled(localNodeId, 'api')).toBe(false);
    });

    it('rejects an invalid stack name (path traversal attempt)', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const localNodeId = db.getNodes()[0].id;
        await expect(svc.optInStack(localNodeId, '../../etc/passwd', 'tester'))
            .rejects.toThrow(/invalid stack name/);
        expect(db.isMeshStackEnabled(localNodeId, '../../etc/passwd')).toBe(false);
    });
});

describe('MeshService activity log', () => {
    it('keeps the most recent events under the 1000-cap', () => {
        const svc = MeshService.getInstance();
        for (let i = 0; i < 1100; i++) {
            svc.logActivity({ source: 'mesh', level: 'info', type: 'opt_in', message: `evt-${i}` });
        }
        const all = svc.getActivity({ limit: 2000 });
        expect(all.length).toBe(1000);
        expect(all[0].message).toBe('evt-100');
        expect(all[all.length - 1].message).toBe('evt-1099');
    });

    it('filters by alias / source / level', () => {
        const svc = MeshService.getInstance();
        svc.logActivity({ source: 'mesh', level: 'info', type: 'opt_in', alias: 'a.b.c.sencho', message: 'a' });
        svc.logActivity({ source: 'pilot', level: 'error', type: 'tunnel.fail', alias: 'a.b.c.sencho', message: 'b' });
        svc.logActivity({ source: 'mesh', level: 'info', type: 'route.resolve.ok', alias: 'x.y.z.sencho', message: 'c' });

        expect(svc.getActivity({ alias: 'a.b.c.sencho' }).length).toBe(2);
        expect(svc.getActivity({ source: 'pilot' }).length).toBe(1);
        expect(svc.getActivity({ level: 'error' }).length).toBe(1);
    });

    it('subscribeActivity fires for new events and unsubscribes cleanly', () => {
        const svc = MeshService.getInstance();
        const seen: string[] = [];
        const unsubscribe = svc.subscribeActivity((e) => seen.push(e.message));
        svc.logActivity({ source: 'mesh', level: 'info', type: 'mesh.enable', message: 'one' });
        unsubscribe();
        svc.logActivity({ source: 'mesh', level: 'info', type: 'mesh.disable', message: 'two' });
        expect(seen).toEqual(['one']);
    });
});

describe('MeshService.testUpstream tunnel-down path', () => {
    it('returns ok:false where=pilot_tunnel when no tunnel is registered', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const localNodeId = db.getNodes()[0].id;
        const remoteNodeId = db.addNode({
            name: 'opsix', type: 'remote', is_default: false,
            compose_dir: '/tmp', api_url: 'https://opsix.example',
            api_token: 'tok', mode: 'pilot_agent',
        });

        (svc as unknown as { aliasCache: Map<string, unknown> }).aliasCache = new Map([
            ['db.api.opsix.sencho', {
                host: 'db.api.opsix.sencho',
                nodeId: remoteNodeId,
                nodeName: 'opsix',
                stackName: 'api',
                serviceName: 'db',
                port: 5432,
            }],
        ]);
        db.insertMeshStack(remoteNodeId, 'api', 'tester');

        const result = await svc.testUpstream('db.api.opsix.sencho', localNodeId);
        expect(result.ok).toBe(false);
        expect(result.where).toBe('pilot_tunnel');
        expect(result.code).toBe('tunnel_down');
    });

    it('returns ok:false where=agent_resolve when target stack is not opted in', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const localNodeId = db.getNodes()[0].id;

        (svc as unknown as { aliasCache: Map<string, unknown> }).aliasCache = new Map([
            ['db.api.opsix.sencho', {
                host: 'db.api.opsix.sencho',
                nodeId: localNodeId,
                nodeName: 'opsix',
                stackName: 'api',
                serviceName: 'db',
                port: 5432,
            }],
        ]);

        const result = await svc.testUpstream('db.api.opsix.sencho', localNodeId);
        expect(result.ok).toBe(false);
        expect(result.where).toBe('agent_resolve');
        expect(result.code).toBe('denied');
    });

    it('returns ok:false where=sidecar when alias is unknown', async () => {
        const svc = MeshService.getInstance();
        const localNodeId = DatabaseService.getInstance().getNodes()[0].id;

        const result = await svc.testUpstream('nonexistent.sencho', localNodeId);
        expect(result.ok).toBe(false);
        expect(result.where).toBe('no_route');
        expect(result.code).toBe('no_route');
    });
});
