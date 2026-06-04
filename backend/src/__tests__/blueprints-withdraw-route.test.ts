/**
 * Route-level tests for POST /api/blueprints/:id/withdraw/:nodeId.
 * Covers the snapshot-before-evict wiring: snapshot_then_evict captures a
 * fleet_snapshots row + one fleet_snapshot_files row, and aborts the eviction
 * (without invoking withdrawFromNode) when the snapshot write fails. Also
 * verifies evict_and_destroy and stateless withdraws do not create snapshots.
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
    const db = DatabaseService.getInstance().getDb();
    db.prepare('DELETE FROM blueprint_deployments').run();
    db.prepare('DELETE FROM blueprints').run();
    db.prepare('DELETE FROM fleet_snapshot_files').run();
    db.prepare('DELETE FROM fleet_snapshots').run();
    db.prepare("DELETE FROM nodes WHERE is_default = 0").run();
});

function seedNode(): { id: number; name: string } {
    counter += 1;
    const name = `bp-route-${counter}`;
    const db = DatabaseService.getInstance().getDb();
    const result = db.prepare(
        `INSERT INTO nodes (name, type, mode, compose_dir, is_default, status, created_at)
         VALUES (?, 'local', 'proxy', '/tmp/compose', 0, 'online', ?)`
    ).run(name, Date.now());
    return { id: result.lastInsertRowid as number, name };
}

function seedBlueprint(opts: {
    classification: 'stateless' | 'stateful' | 'unknown';
    nodeIds: number[];
    composeContent?: string;
}) {
    counter += 1;
    return DatabaseService.getInstance().createBlueprint({
        name: `bp-${counter}`,
        description: null,
        compose_content: opts.composeContent ?? 'services:\n  app:\n    image: nginx\n',
        selector: { type: 'nodes', ids: opts.nodeIds },
        drift_mode: 'suggest',
        classification: opts.classification,
        classification_reasons: [],
        enabled: true,
        created_by: 'admin',
    });
}

function seedActiveDeployment(blueprintId: number, nodeId: number, revision: number) {
    DatabaseService.getInstance().upsertDeployment({
        blueprint_id: blueprintId,
        node_id: nodeId,
        status: 'active',
        applied_revision: revision,
    });
}

describe('POST /api/blueprints/:id/withdraw/:nodeId', () => {
    it('snapshot_then_evict on a stateful blueprint captures compose into fleet_snapshots, then withdraws', async () => {
        const node = seedNode();
        const compose = 'services:\n  db:\n    image: postgres:16\n    volumes:\n      - data:/var/lib/postgresql/data\nvolumes:\n  data:\n';
        const bp = seedBlueprint({ classification: 'stateful', nodeIds: [node.id], composeContent: compose });
        seedActiveDeployment(bp.id, node.id, bp.revision);

        const withdrawSpy = vi.spyOn(BlueprintService.getInstance(), 'withdrawFromNode')
            .mockResolvedValue({ status: 'withdrawn' });

        const res = await request(app)
            .post(`/api/blueprints/${bp.id}/withdraw/${node.id}`)
            .set('Cookie', adminCookie)
            .send({ confirm: 'snapshot_then_evict' });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('withdrawn');
        expect(res.body.snapshotPolicy).toBe('snapshot_then_evict');
        expect(typeof res.body.snapshotId).toBe('number');
        expect(withdrawSpy).toHaveBeenCalledOnce();

        const db = DatabaseService.getInstance().getDb();
        const snapRow = db.prepare('SELECT * FROM fleet_snapshots WHERE id = ?').get(res.body.snapshotId) as {
            description: string;
            node_count: number;
            stack_count: number;
        };
        expect(snapRow).toBeDefined();
        expect(snapRow.description).toBe(`Pre-eviction: blueprint=${bp.name} node=${node.name}`);
        expect(snapRow.node_count).toBe(1);
        expect(snapRow.stack_count).toBe(1);

        const fileRows = db.prepare('SELECT * FROM fleet_snapshot_files WHERE snapshot_id = ?')
            .all(res.body.snapshotId) as Array<{ stack_name: string; filename: string; content: string; node_id: number }>;
        expect(fileRows).toHaveLength(1);
        expect(fileRows[0].stack_name).toBe(bp.name);
        expect(fileRows[0].filename).toBe('docker-compose.yml');
        // Content is encrypted at rest; it decrypts back to the captured compose.
        const { CryptoService } = await import('../services/CryptoService');
        expect(CryptoService.getInstance().isEncrypted(fileRows[0].content)).toBe(true);
        expect(CryptoService.getInstance().decrypt(fileRows[0].content)).toBe(compose);
        expect(fileRows[0].node_id).toBe(node.id);
    });

    it('aborts the eviction with 500 and does NOT call withdrawFromNode when the snapshot write fails', async () => {
        const node = seedNode();
        const bp = seedBlueprint({ classification: 'stateful', nodeIds: [node.id] });
        seedActiveDeployment(bp.id, node.id, bp.revision);

        const withdrawSpy = vi.spyOn(BlueprintService.getInstance(), 'withdrawFromNode')
            .mockResolvedValue({ status: 'withdrawn' });
        vi.spyOn(DatabaseService.getInstance(), 'createSnapshot').mockImplementation(() => {
            throw new Error('disk full');
        });

        const res = await request(app)
            .post(`/api/blueprints/${bp.id}/withdraw/${node.id}`)
            .set('Cookie', adminCookie)
            .send({ confirm: 'snapshot_then_evict' });

        expect(res.status).toBe(500);
        expect(res.body.code).toBe('snapshot_failed');
        expect(withdrawSpy).not.toHaveBeenCalled();

        const db = DatabaseService.getInstance().getDb();
        const count = (db.prepare('SELECT COUNT(*) as n FROM fleet_snapshots').get() as { n: number }).n;
        expect(count).toBe(0);
    });

    it('cleans up the orphan snapshot row when insertSnapshotFiles fails after createSnapshot succeeded', async () => {
        const node = seedNode();
        const bp = seedBlueprint({ classification: 'stateful', nodeIds: [node.id] });
        seedActiveDeployment(bp.id, node.id, bp.revision);

        const withdrawSpy = vi.spyOn(BlueprintService.getInstance(), 'withdrawFromNode')
            .mockResolvedValue({ status: 'withdrawn' });
        vi.spyOn(DatabaseService.getInstance(), 'insertSnapshotFiles').mockImplementation(() => {
            throw new Error('constraint violation');
        });

        const res = await request(app)
            .post(`/api/blueprints/${bp.id}/withdraw/${node.id}`)
            .set('Cookie', adminCookie)
            .send({ confirm: 'snapshot_then_evict' });

        expect(res.status).toBe(500);
        expect(res.body.code).toBe('snapshot_failed');
        expect(withdrawSpy).not.toHaveBeenCalled();

        const db = DatabaseService.getInstance().getDb();
        const count = (db.prepare('SELECT COUNT(*) as n FROM fleet_snapshots').get() as { n: number }).n;
        expect(count).toBe(0);
    });

    it('evict_and_destroy on a stateful blueprint does NOT create a snapshot', async () => {
        const node = seedNode();
        const bp = seedBlueprint({ classification: 'stateful', nodeIds: [node.id] });
        seedActiveDeployment(bp.id, node.id, bp.revision);

        vi.spyOn(BlueprintService.getInstance(), 'withdrawFromNode')
            .mockResolvedValue({ status: 'withdrawn' });

        const res = await request(app)
            .post(`/api/blueprints/${bp.id}/withdraw/${node.id}`)
            .set('Cookie', adminCookie)
            .send({ confirm: 'evict_and_destroy' });

        expect(res.status).toBe(200);
        expect(res.body.snapshotPolicy).toBe('evict_and_destroy');
        expect(res.body.snapshotId).toBeNull();

        const db = DatabaseService.getInstance().getDb();
        const count = (db.prepare('SELECT COUNT(*) as n FROM fleet_snapshots').get() as { n: number }).n;
        expect(count).toBe(0);
    });

    it('standard withdraw on a stateless blueprint does NOT create a snapshot', async () => {
        const node = seedNode();
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [node.id] });
        seedActiveDeployment(bp.id, node.id, bp.revision);

        vi.spyOn(BlueprintService.getInstance(), 'withdrawFromNode')
            .mockResolvedValue({ status: 'withdrawn' });

        const res = await request(app)
            .post(`/api/blueprints/${bp.id}/withdraw/${node.id}`)
            .set('Cookie', adminCookie)
            .send({ confirm: 'standard' });

        expect(res.status).toBe(200);
        expect(res.body.snapshotPolicy).toBe('standard');
        expect(res.body.snapshotId).toBeNull();

        const db = DatabaseService.getInstance().getDb();
        const count = (db.prepare('SELECT COUNT(*) as n FROM fleet_snapshots').get() as { n: number }).n;
        expect(count).toBe(0);
    });

    it('rejects standard withdraw on a stateful blueprint with evict_blocked', async () => {
        const node = seedNode();
        const bp = seedBlueprint({ classification: 'stateful', nodeIds: [node.id] });
        seedActiveDeployment(bp.id, node.id, bp.revision);

        const res = await request(app)
            .post(`/api/blueprints/${bp.id}/withdraw/${node.id}`)
            .set('Cookie', adminCookie)
            .send({ confirm: 'standard' });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('evict_blocked');
    });

    it('rejects an unknown confirm mode with 400', async () => {
        const node = seedNode();
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [node.id] });

        const res = await request(app)
            .post(`/api/blueprints/${bp.id}/withdraw/${node.id}`)
            .set('Cookie', adminCookie)
            .send({ confirm: 'wrong_mode' });

        expect(res.status).toBe(400);
    });

    it('defaults to standard withdraw when the confirm field is omitted', async () => {
        const node = seedNode();
        const bp = seedBlueprint({ classification: 'stateless', nodeIds: [node.id] });
        seedActiveDeployment(bp.id, node.id, bp.revision);

        vi.spyOn(BlueprintService.getInstance(), 'withdrawFromNode')
            .mockResolvedValue({ status: 'withdrawn' });

        const res = await request(app)
            .post(`/api/blueprints/${bp.id}/withdraw/${node.id}`)
            .set('Cookie', adminCookie)
            .send({});

        expect(res.status).toBe(200);
        expect(res.body.snapshotPolicy).toBe('standard');
        expect(res.body.snapshotId).toBeNull();
    });

    it('snapshot_then_evict returns 500 when compose_content is empty', async () => {
        const node = seedNode();
        const bp = seedBlueprint({ classification: 'stateful', nodeIds: [node.id], composeContent: '   \n  \n' });
        seedActiveDeployment(bp.id, node.id, bp.revision);

        const withdrawSpy = vi.spyOn(BlueprintService.getInstance(), 'withdrawFromNode')
            .mockResolvedValue({ status: 'withdrawn' });

        const res = await request(app)
            .post(`/api/blueprints/${bp.id}/withdraw/${node.id}`)
            .set('Cookie', adminCookie)
            .send({ confirm: 'snapshot_then_evict' });

        expect(res.status).toBe(500);
        expect(res.body.code).toBe('snapshot_failed');
        expect(withdrawSpy).not.toHaveBeenCalled();

        const db = DatabaseService.getInstance().getDb();
        const count = (db.prepare('SELECT COUNT(*) as n FROM fleet_snapshots').get() as { n: number }).n;
        expect(count).toBe(0);
    });
});
