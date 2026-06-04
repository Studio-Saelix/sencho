/**
 * Edge-case coverage for the Blueprints feature that the existing suites leave open:
 *   - PUT /:id refusing to disable a blueprint that still has active deployments (409).
 *   - POST / rejecting a selector that exceeds the 200-entry cap (400).
 *   - checkForDrift flagging revision drift when the on-node marker is stale.
 *   - withdrawFromNode refusing to act when the marker belongs to a different blueprint.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let BlueprintService: typeof import('../services/BlueprintService').BlueprintService;
let adminCookie: string;
let counter = 0;

function seedNode(): { id: number; name: string } {
    counter += 1;
    const name = `bp-edge-node-${counter}`;
    const db = DatabaseService.getInstance().getDb();
    const result = db.prepare(
        `INSERT INTO nodes (name, type, mode, compose_dir, is_default, status, created_at)
         VALUES (?, 'local', 'proxy', '/tmp/compose', 0, 'online', ?)`,
    ).run(name, Date.now());
    return { id: result.lastInsertRowid as number, name };
}

function seedBlueprint(nodeIds: number[]) {
    counter += 1;
    return DatabaseService.getInstance().createBlueprint({
        name: `bp-edge-${counter}`,
        description: null,
        compose_content: 'services:\n  app:\n    image: nginx\n',
        selector: { type: 'nodes', ids: nodeIds },
        drift_mode: 'suggest',
        classification: 'stateless',
        classification_reasons: [],
        enabled: true,
        created_by: 'admin',
    });
}

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ LicenseService } = await import('../services/LicenseService'));
    ({ BlueprintService } = await import('../services/BlueprintService'));

    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');

    ({ app } = await import('../index'));
    adminCookie = await loginAsTestAdmin(app);
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
    // Reset developer mode so the diagnostics matrix below is order-independent.
    DatabaseService.getInstance().updateGlobalSetting('developer_mode', '0');
    const db = DatabaseService.getInstance().getDb();
    db.prepare('DELETE FROM blueprint_deployments').run();
    db.prepare('DELETE FROM blueprints').run();
    db.prepare('DELETE FROM nodes WHERE is_default = 0').run();
});

describe('Blueprint route edge cases', () => {
    it('refuses to disable a blueprint that still has an active deployment', async () => {
        const node = seedNode();
        const bp = seedBlueprint([node.id]);
        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: bp.id,
            node_id: node.id,
            status: 'active',
            applied_revision: bp.revision,
        });

        const res = await request(app)
            .put(`/api/blueprints/${bp.id}`)
            .set('Cookie', adminCookie)
            .send({ enabled: false });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('has_active_deployments');
        // The blueprint must remain enabled.
        expect(DatabaseService.getInstance().getBlueprint(bp.id)?.enabled).toBe(true);
    });

    it('rejects a node selector that exceeds the 200-entry cap', async () => {
        const ids = Array.from({ length: 201 }, (_, i) => i + 1);
        const res = await request(app)
            .post('/api/blueprints')
            .set('Cookie', adminCookie)
            .send({
                name: 'bp-edge-oversized',
                compose_content: 'services:\n  app:\n    image: nginx\n',
                selector: { type: 'nodes', ids },
                drift_mode: 'suggest',
            });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('200');
        expect(DatabaseService.getInstance().listBlueprints()).toHaveLength(0);
    });
});

describe('BlueprintService marker edge cases', () => {
    it('flags revision drift when the on-node marker is stale', async () => {
        const localNode = DatabaseService.getInstance().getNodes()[0];
        const bp = seedBlueprint([localNode.id]);
        const bpObj = DatabaseService.getInstance().getBlueprint(bp.id)!;

        vi.spyOn(BlueprintService.getInstance(), 'readMarker').mockResolvedValue({
            blueprintId: bp.id,
            revision: bpObj.revision + 5,
            lastApplied: 0,
        });

        const result = await BlueprintService.getInstance().checkForDrift(bpObj, localNode);

        expect(result.drifted).toBe(true);
        expect(result.reason).toContain('revision drift');
    });

    it('refuses to withdraw when the marker belongs to a different blueprint', async () => {
        const localNode = DatabaseService.getInstance().getNodes()[0];
        const bp = seedBlueprint([localNode.id]);
        const bpObj = DatabaseService.getInstance().getBlueprint(bp.id)!;

        vi.spyOn(BlueprintService.getInstance(), 'readMarker').mockResolvedValue({
            blueprintId: bp.id + 999,
            revision: 1,
            lastApplied: 0,
        });

        const result = await BlueprintService.getInstance().withdrawFromNode(bpObj, localNode);

        expect(result.status).toBe('name_conflict');
        // The deployment row must record the conflict, not silently disappear.
        const dep = DatabaseService.getInstance().getDeployment(bp.id, localNode.id);
        expect(dep).toBeDefined();
        expect(dep?.status).toBe('name_conflict');
    });
});

describe('BlueprintService developer-mode diagnostics', () => {
    // withdrawFromNode emits its "withdraw inputs" diagnostic line before reading the
    // marker, so a cross-blueprint marker stub lets us assert the gate without Docker.
    function arrangeWithdraw() {
        const localNode = DatabaseService.getInstance().getNodes()[0];
        const bp = seedBlueprint([localNode.id]);
        const bpObj = DatabaseService.getInstance().getBlueprint(bp.id)!;
        vi.spyOn(BlueprintService.getInstance(), 'readMarker').mockResolvedValue({
            blueprintId: bp.id + 999,
            revision: 1,
            lastApplied: 0,
        });
        return { bpObj, localNode };
    }

    it('does not emit diagnostic logs when developer mode is off', async () => {
        const { bpObj, localNode } = arrangeWithdraw();
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

        await BlueprintService.getInstance().withdrawFromNode(bpObj, localNode);

        expect(infoSpy.mock.calls.some(([m]) => String(m).includes('[BlueprintService:diag]'))).toBe(false);
    });

    it('emits diagnostic logs when developer mode is on', async () => {
        DatabaseService.getInstance().updateGlobalSetting('developer_mode', '1');
        const { bpObj, localNode } = arrangeWithdraw();
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

        await BlueprintService.getInstance().withdrawFromNode(bpObj, localNode);

        expect(infoSpy.mock.calls.some(([m]) => String(m).includes('[BlueprintService:diag]'))).toBe(true);
    });
});
