/**
 * Regression guard for F-11: `MeshService.getRouteDiagnostic` must reflect
 * current upstream reachability, not the last cached probe outcome.
 *
 * Pre-fix behavior: after a stop of the upstream container, the alias
 * remained in `aliasCache` for up to 60 s (the refresh interval), and
 * `routeLatencyMap` still carried the last successful probe value.
 * `getRouteDiagnostic` returned `state: 'healthy'` from the stale data
 * until someone manually hit `POST /aliases/:alias/test`.
 *
 * Post-fix behavior: `getRouteDiagnostic` calls `testUpstream` synchronously
 * before computing state, so a failed probe lands in `routeErrorMap` and
 * the state computation resolves to `'unreachable'` on the same GET.
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
        routeLatencyMap: Map<string, number>;
        routeErrorMap: Map<string, { ts: number; message: string }>;
        routeProbeAtMap: Map<string, number>;
    };
    svc.aliasCache = new Map();
    svc.aliasByPort = new Map();
    svc.routeLatencyMap = new Map();
    svc.routeErrorMap = new Map();
    svc.routeProbeAtMap = new Map();
});

describe('MeshService.getRouteDiagnostic — freshness (F-11)', () => {
    const ALIAS = 'echo.audit-mesh-fresh.local.sencho';

    function seedHealthyLocalAlias(): number {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const localNodeId = db.getNodes()[0].id;
        db.insertMeshStack(localNodeId, 'audit-mesh-fresh', 'tester');

        // Local node has no pilot tunnel; the helper short-circuits to
        // routable=true.
        vi.spyOn(PilotTunnelManager.getInstance(), 'hasActiveTunnel').mockReturnValue(false);

        (svc as unknown as { aliasCache: Map<string, unknown> }).aliasCache = new Map([
            [ALIAS, {
                host: ALIAS,
                nodeId: localNodeId,
                nodeName: 'local',
                stackName: 'audit-mesh-fresh',
                serviceName: 'echo',
                port: 9100,
            }],
        ]);
        // Seed the maps with stale "healthy" data — the pre-fix sequence the
        // bug report described (last probe was fast and recent, no errors).
        (svc as unknown as { routeLatencyMap: Map<string, number> }).routeLatencyMap.set(ALIAS, 19);
        (svc as unknown as { routeProbeAtMap: Map<string, number> }).routeProbeAtMap.set(
            ALIAS, Date.now() - 30_000,
        );
        return localNodeId;
    }

    it('flips state from cached "healthy" to "unreachable" when the live probe fails', async () => {
        const svc = MeshService.getInstance();
        const localNodeId = seedHealthyLocalAlias();

        // Mock testUpstream the same way the real same-node failure path
        // would: write a fresh routeErrorMap entry (which the real probe
        // achieves via logActivity → error event → routeErrorMap.set), bump
        // routeProbeAtMap, and resolve a failing MeshProbeResult.
        vi.spyOn(svc, 'testUpstream').mockImplementation(async (alias: string) => {
            (svc as unknown as { routeErrorMap: Map<string, { ts: number; message: string }> })
                .routeErrorMap.set(alias, { ts: Date.now(), message: 'ECONNREFUSED' });
            (svc as unknown as { routeProbeAtMap: Map<string, number> })
                .routeProbeAtMap.set(alias, Date.now());
            return { ok: false, where: 'target_port', code: 'unreachable', message: 'ECONNREFUSED' };
        });

        const diag = await svc.getRouteDiagnostic(ALIAS);
        expect(diag.state).toBe('unreachable');
        expect(diag.lastError?.message).toBe('ECONNREFUSED');
        expect(diag.lastProbeAt).not.toBeNull();
        // Probe should have been invoked exactly once during the GET.
        expect(svc.testUpstream).toHaveBeenCalledTimes(1);

        DatabaseService.getInstance().deleteMeshStack(localNodeId, 'audit-mesh-fresh');
    });

    it('keeps state healthy and stamps a fresh lastProbeAt when the live probe succeeds', async () => {
        const svc = MeshService.getInstance();
        const localNodeId = seedHealthyLocalAlias();
        const beforeMs = Date.now();

        vi.spyOn(svc, 'testUpstream').mockImplementation(async (alias: string) => {
            (svc as unknown as { routeLatencyMap: Map<string, number> }).routeLatencyMap.set(alias, 4);
            (svc as unknown as { routeProbeAtMap: Map<string, number> })
                .routeProbeAtMap.set(alias, Date.now());
            return { ok: true, latencyMs: 4 };
        });

        const diag = await svc.getRouteDiagnostic(ALIAS);
        expect(diag.state).toBe('healthy');
        expect(diag.lastProbeMs).toBe(4);
        expect(diag.lastProbeAt).not.toBeNull();
        expect(diag.lastProbeAt!).toBeGreaterThanOrEqual(beforeMs);
        expect(svc.testUpstream).toHaveBeenCalledTimes(1);

        DatabaseService.getInstance().deleteMeshStack(localNodeId, 'audit-mesh-fresh');
    });

    it('does not probe when the target is unresolved (alias not in cache)', async () => {
        const svc = MeshService.getInstance();
        // No aliasCache seed; lookup returns null.
        const probeSpy = vi.spyOn(svc, 'testUpstream');

        const diag = await svc.getRouteDiagnostic('ghost.notthere.local.sencho');
        expect(diag.state).toBe('not authorized');
        expect(diag.target).toBeNull();
        expect(probeSpy).not.toHaveBeenCalled();
    });

    it('does not probe when the tunnel is down (avoids holding the GET for the probe timeout)', async () => {
        const svc = MeshService.getInstance();
        const db = DatabaseService.getInstance();
        const remoteNodeId = db.addNode({
            name: 'f11-remote',
            type: 'remote',
            mode: 'pilot_agent',
            compose_dir: '/tmp',
            is_default: false,
            api_url: '',
            api_token: '',
        });
        db.insertMeshStack(remoteNodeId, 'audit-mesh-down', 'tester');
        vi.spyOn(PilotTunnelManager.getInstance(), 'hasActiveTunnel').mockReturnValue(false);

        const alias = 'echo.audit-mesh-down.f11-remote.sencho';
        (svc as unknown as { aliasCache: Map<string, unknown> }).aliasCache = new Map([
            [alias, {
                host: alias,
                nodeId: remoteNodeId,
                nodeName: 'f11-remote',
                stackName: 'audit-mesh-down',
                serviceName: 'echo',
                port: 9101,
            }],
        ]);
        const probeSpy = vi.spyOn(svc, 'testUpstream');

        const diag = await svc.getRouteDiagnostic(alias);
        expect(diag.state).toBe('tunnel down');
        expect(probeSpy).not.toHaveBeenCalled();

        db.deleteMeshStack(remoteNodeId, 'audit-mesh-down');
        db.deleteNode(remoteNodeId);
    });
});
