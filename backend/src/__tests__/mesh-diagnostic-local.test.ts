/**
 * Regression guard for the M-12 fix: `MeshService.getRouteDiagnostic` and
 * `MeshService.getStatus` must report `pilotConnected: true` for local nodes
 * instead of asking `PilotTunnelManager.hasActiveTunnel`, which always returns
 * false for local nodes (they do not have pilot tunnels because they do not
 * need them — local mesh traffic uses the same-node fast path). Without this
 * conditional, the route detail sheet renders every local alias as a
 * destructive `tunnel down` pill on a working route.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let MeshService: typeof import('../services/MeshService').MeshService;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let PilotTunnelManager: typeof import('../services/PilotTunnelManager').PilotTunnelManager;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ MeshService } = await import('../services/MeshService'));
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ PilotTunnelManager } = await import('../services/PilotTunnelManager'));
});

afterAll(() => {
    vi.restoreAllMocks();
    cleanupTestDb(tmpDir);
});

afterEach(() => {
    vi.restoreAllMocks();
    const svc = MeshService.getInstance() as unknown as {
        aliasCache: Map<string, unknown>;
        aliasByPort: Map<number, unknown>;
    };
    svc.aliasCache = new Map();
    svc.aliasByPort = new Map();
});

describe('MeshService diagnostic — local-node pilot state (M-12)', () => {
    it('reports pilotConnected: true and state: healthy for a local alias even though no pilot tunnel exists', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const localNodeId = db.getNodes()[0].id;
        db.insertMeshStack(localNodeId, 'audit-mesh-prod', 'tester');

        // hasActiveTunnel always returns false for local nodes; the helper
        // must short-circuit that, otherwise the diagnostic flips to
        // 'tunnel down'.
        vi.spyOn(PilotTunnelManager.getInstance(), 'hasActiveTunnel').mockReturnValue(false);

        (svc as unknown as { aliasCache: Map<string, unknown> }).aliasCache = new Map([
            ['echo.audit-mesh-prod.local.sencho', {
                host: 'echo.audit-mesh-prod.local.sencho',
                nodeId: localNodeId,
                nodeName: 'local',
                stackName: 'audit-mesh-prod',
                serviceName: 'echo',
                port: 9000,
            }],
        ]);

        const diag = await svc.getRouteDiagnostic('echo.audit-mesh-prod.local.sencho');
        expect(diag.pilot.connected).toBe(true);
        expect(diag.state).toBe('healthy');

        db.deleteMeshStack(localNodeId, 'audit-mesh-prod');
    });

    it('reports pilotConnected: false when the alias points to a node that no longer exists', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        // Create a remote node, register an alias pointing at it, opt the
        // stack in (so the alias is not 'not authorized'), then delete the
        // node row. The diagnostic should fall back to false rather than
        // throw or treat a missing node as reachable.
        const remoteNodeId = db.addNode({
            name: 'm12-orphan',
            type: 'remote',
            mode: 'pilot_agent',
            compose_dir: '/tmp',
            is_default: false,
            api_url: '',
            api_token: '',
        });
        db.insertMeshStack(remoteNodeId, 'audit-mesh-orphan', 'tester');
        (svc as unknown as { aliasCache: Map<string, unknown> }).aliasCache = new Map([
            ['echo.audit-mesh-orphan.m12-orphan.sencho', {
                host: 'echo.audit-mesh-orphan.m12-orphan.sencho',
                nodeId: remoteNodeId,
                nodeName: 'm12-orphan',
                stackName: 'audit-mesh-orphan',
                serviceName: 'echo',
                port: 9002,
            }],
        ]);
        // Drop the node row but leave the alias cache + mesh_stacks intact
        // (mirrors a race where listMeshStacks ran before the node delete
        // cascade completed). The orphan path is already covered by the
        // initial !node check; this asserts the fallback is false rather
        // than the test-default true.
        db.deleteMeshStack(remoteNodeId, 'audit-mesh-orphan');
        db.deleteNode(remoteNodeId);

        const diag = await svc.getRouteDiagnostic('echo.audit-mesh-orphan.m12-orphan.sencho');
        expect(diag.pilot.connected).toBe(false);
    });

    it('still reports pilotConnected: false and state: tunnel down for a remote alias when the tunnel is actually down', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const remoteNodeId = db.addNode({
            name: 'm12-remote',
            type: 'remote',
            mode: 'pilot_agent',
            compose_dir: '/tmp',
            is_default: false,
            api_url: '',
            api_token: '',
        });
        db.insertMeshStack(remoteNodeId, 'audit-mesh-pilot', 'tester');

        vi.spyOn(PilotTunnelManager.getInstance(), 'hasActiveTunnel').mockReturnValue(false);

        (svc as unknown as { aliasCache: Map<string, unknown> }).aliasCache = new Map([
            ['echo.audit-mesh-pilot.m12-remote.sencho', {
                host: 'echo.audit-mesh-pilot.m12-remote.sencho',
                nodeId: remoteNodeId,
                nodeName: 'm12-remote',
                stackName: 'audit-mesh-pilot',
                serviceName: 'echo',
                port: 9001,
            }],
        ]);

        const diag = await svc.getRouteDiagnostic('echo.audit-mesh-pilot.m12-remote.sencho');
        expect(diag.pilot.connected).toBe(false);
        expect(diag.state).toBe('tunnel down');

        db.deleteMeshStack(remoteNodeId, 'audit-mesh-pilot');
        db.deleteNode(remoteNodeId);
    });
});
