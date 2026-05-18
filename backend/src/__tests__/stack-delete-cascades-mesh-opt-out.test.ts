/** F-1 / F-14: DELETE /api/stacks/:stackName must cascade a mesh opt-out. */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let MeshService: typeof import('../services/MeshService').MeshService;
let ComposeService: typeof import('../services/ComposeService').ComposeService;
let FileSystemService: typeof import('../services/FileSystemService').FileSystemService;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let adminCookie: string;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ MeshService } = await import('../services/MeshService'));
    ({ ComposeService } = await import('../services/ComposeService'));
    ({ FileSystemService } = await import('../services/FileSystemService'));
    ({ LicenseService } = await import('../services/LicenseService'));

    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
    vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue('admiral');
    vi.spyOn(LicenseService.getInstance(), 'getSeatLimits').mockReturnValue({ maxAdmins: null, maxViewers: null });

    ({ app } = await import('../index'));
    adminCookie = await loginAsTestAdmin(app);
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

beforeEach(() => {
    const db = DatabaseService.getInstance().getDb();
    db.prepare('DELETE FROM mesh_stacks').run();

    vi.restoreAllMocks();

    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
    vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue('admiral');
    vi.spyOn(LicenseService.getInstance(), 'getSeatLimits').mockReturnValue({ maxAdmins: null, maxViewers: null });

    vi.spyOn(ComposeService.prototype, 'downStack').mockResolvedValue(undefined);
    vi.spyOn(FileSystemService.prototype, 'deleteStack').mockResolvedValue(undefined);

    // optInStack rejects when senchoIp is null; seed a placeholder.
    const svc = MeshService.getInstance() as unknown as {
        aliasCache: Map<string, unknown>;
        aliasByPort: Map<number, unknown>;
        activity: unknown[];
        senchoIp: string | null;
        networkSetupError: string | null;
    };
    svc.aliasCache = new Map();
    svc.aliasByPort = new Map();
    svc.activity = [];
    svc.senchoIp = '172.30.0.2';
    svc.networkSetupError = null;

    // Stub only the leaf I/O; the real optInStack and optOutStack run so
    // the cascade contract is exercised end-to-end.
    const meshSvc = MeshService.getInstance();
    vi.spyOn(meshSvc as unknown as { inspectStackServices: (n: number, s: string) => Promise<unknown> }, 'inspectStackServices')
        .mockResolvedValue([{ service: 'web', ports: [8080] }]);
    vi.spyOn(meshSvc as unknown as { pushOverrideToNode: (n: number, s: string) => Promise<void> }, 'pushOverrideToNode')
        .mockResolvedValue(undefined);
    vi.spyOn(meshSvc as unknown as { regenerateOverridesAcrossFleet: (n?: number, s?: string) => Promise<void> }, 'regenerateOverridesAcrossFleet')
        .mockResolvedValue(undefined);
    vi.spyOn(meshSvc as unknown as { syncForwarderListeners: () => Promise<void> }, 'syncForwarderListeners')
        .mockResolvedValue(undefined);
    vi.spyOn(meshSvc as unknown as { refreshAliasCache: () => Promise<void> }, 'refreshAliasCache')
        .mockResolvedValue(undefined);
    vi.spyOn(meshSvc as unknown as { triggerRedeploy: (n: number, s: string, a: string) => void }, 'triggerRedeploy')
        .mockReturnValue(undefined);
    vi.spyOn(meshSvc as unknown as { cascadeRecomposeAcrossFleet: (n?: number, s?: string, a?: string) => void }, 'cascadeRecomposeAcrossFleet')
        .mockReturnValue(undefined);
});

describe('DELETE /api/stacks/:stackName mesh opt-out cascade (F-1 / F-14)', () => {
    it('clears the mesh_stacks row and removes the override file when the deleted stack was opted in', async () => {
        const db = DatabaseService.getInstance();
        const localNodeId = db.getNodes()[0].id;
        const svc = MeshService.getInstance();
        const removeSpy = vi.spyOn(svc as unknown as { removeStackOverride: (n: number, s: string) => Promise<void> }, 'removeStackOverride')
            .mockResolvedValue(undefined);

        await svc.optInStack(localNodeId, 'api', 'tester');
        expect(db.isMeshStackEnabled(localNodeId, 'api')).toBe(true);

        const res = await request(app)
            .delete('/api/stacks/api')
            .set('Cookie', adminCookie);

        expect(res.status).toBe(200);
        expect(db.isMeshStackEnabled(localNodeId, 'api')).toBe(false);
        expect(removeSpy).toHaveBeenCalledWith(localNodeId, 'api');
    });

    it('is a no-op when the deleted stack was never opted into the mesh', async () => {
        const svc = MeshService.getInstance();
        const removeSpy = vi.spyOn(svc as unknown as { removeStackOverride: (n: number, s: string) => Promise<void> }, 'removeStackOverride')
            .mockResolvedValue(undefined);

        const res = await request(app)
            .delete('/api/stacks/never-meshed')
            .set('Cookie', adminCookie);

        expect(res.status).toBe(200);
        // optOutStack short-circuits at isMeshStackEnabled === false, so the
        // override removal is never invoked.
        expect(removeSpy).not.toHaveBeenCalled();
    });

    it('still returns 200 and warns when the mesh cascade itself rejects', async () => {
        const db = DatabaseService.getInstance();
        const localNodeId = db.getNodes()[0].id;
        const svc = MeshService.getInstance();

        await svc.optInStack(localNodeId, 'api', 'tester');
        vi.spyOn(svc, 'optOutStack').mockRejectedValue(new Error('simulated mesh failure'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const res = await request(app)
            .delete('/api/stacks/api')
            .set('Cookie', adminCookie);

        expect(res.status).toBe(200);
        const sawCascadeWarning = warnSpy.mock.calls.some(args =>
            typeof args[0] === 'string' && args[0].includes('Mesh opt-out cascade failed')
        );
        expect(sawCascadeWarning).toBe(true);
    });
});
