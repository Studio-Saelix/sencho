/**
 * Preview-confirm apply binding and stale-guard behaviour.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let adminCookie: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let BlueprintReconciler: typeof import('../services/BlueprintReconciler').BlueprintReconciler;
let counter = 0;

function seedNode(): { id: number; name: string } {
    counter += 1;
    const name = `bp-preview-node-${counter}`;
    const db = DatabaseService.getInstance().getDb();
    const result = db.prepare(
        `INSERT INTO nodes (name, type, mode, compose_dir, is_default, status, created_at)
         VALUES (?, 'local', 'proxy', '/tmp/compose', 0, 'online', ?)`,
    ).run(name, Date.now());
    return { id: result.lastInsertRowid as number, name };
}

function validBlueprintBody(nodeId: number) {
    return {
        name: `bp-preview-${counter + 1}`,
        compose_content: 'services:\n  app:\n    image: nginx\n',
        selector: { type: 'nodes', ids: [nodeId] },
        drift_mode: 'observe',
    };
}

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ app } = await import('../index'));
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ BlueprintReconciler } = await import('../services/BlueprintReconciler'));
    adminCookie = await loginAsTestAdmin(app);
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(BlueprintReconciler.getInstance(), 'reconcileConfirmedPlan').mockResolvedValue({ outcomes: [] });
    const db = DatabaseService.getInstance().getDb();
    db.prepare('DELETE FROM blueprint_deployments').run();
    db.prepare('DELETE FROM blueprints').run();
    db.prepare('DELETE FROM nodes WHERE is_default = 0').run();
});

describe('POST /api/blueprints/:id/apply confirm binding', () => {
    it('rejects apply without planFingerprint', async () => {
        const node = seedNode();
        counter += 1;
        const created = await request(app)
            .post('/api/blueprints')
            .set('Cookie', adminCookie)
            .send(validBlueprintBody(node.id));
        expect(created.status).toBe(201);

        const res = await request(app)
            .post(`/api/blueprints/${created.body.id}/apply`)
            .set('Cookie', adminCookie)
            .send({});
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('CONFIRM_REQUIRED');
    });

    it('rejects stale fingerprint with PREVIEW_STALE', async () => {
        const node = seedNode();
        counter += 1;
        const created = await request(app)
            .post('/api/blueprints')
            .set('Cookie', adminCookie)
            .send(validBlueprintBody(node.id));
        expect(created.status).toBe(201);

        const preview = await request(app)
            .get(`/api/blueprints/${created.body.id}/preview`)
            .set('Cookie', adminCookie);
        expect(preview.status).toBe(200);

        const res = await request(app)
            .post(`/api/blueprints/${created.body.id}/apply`)
            .set('Cookie', adminCookie)
            .send({
                planFingerprint: 'deadbeef',
                actions: preview.body.confirmableActions,
            });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('PREVIEW_STALE');
    });

    it('persists approval and calls reconcileConfirmedPlan with executor actions', async () => {
        const node = seedNode();
        counter += 1;
        const created = await request(app)
            .post('/api/blueprints')
            .set('Cookie', adminCookie)
            .send(validBlueprintBody(node.id));
        expect(created.status).toBe(201);

        const preview = await request(app)
            .get(`/api/blueprints/${created.body.id}/preview`)
            .set('Cookie', adminCookie);
        expect(preview.status).toBe(200);
        expect(preview.body.effectiveApproval).toBe('pending');
        expect(preview.body.planFingerprint).toBeTruthy();

        const reconcileSpy = vi.mocked(BlueprintReconciler.getInstance().reconcileConfirmedPlan);
        const res = await request(app)
            .post(`/api/blueprints/${created.body.id}/apply`)
            .set('Cookie', adminCookie)
            .send({
                planFingerprint: preview.body.planFingerprint,
                actions: preview.body.confirmableActions,
            });
        expect(res.status).toBe(200);
        expect(res.body.effectiveApproval).toBe('approved');
        expect(res.body.outcomes).toEqual([]);
        expect(res.body.outcomeSummary).toEqual({
            total: 0,
            ok: 0,
            failed: 0,
            pending: 0,
            skipped: 0,
        });
        expect(reconcileSpy).toHaveBeenCalledWith(created.body.id, preview.body.executorActions);

        const detail = await request(app)
            .get(`/api/blueprints/${created.body.id}`)
            .set('Cookie', adminCookie);
        expect(detail.status).toBe(200);
        expect(detail.body.effectiveApproval).toBe('approved');

        const stored = DatabaseService.getInstance().getBlueprint(created.body.id)!;
        expect(stored.approval_status).toBe('approved');
        expect(stored.approved_intent_fingerprint).toBe(preview.body.planFingerprint);
        expect(stored.updated_at).toBe(created.body.updated_at);
    });

    it('returns PREVIEW_STALE when compose drifts between preview and approval persist', async () => {
        const node = seedNode();
        counter += 1;
        const created = await request(app)
            .post('/api/blueprints')
            .set('Cookie', adminCookie)
            .send(validBlueprintBody(node.id));
        expect(created.status).toBe(201);

        const preview = await request(app)
            .get(`/api/blueprints/${created.body.id}/preview`)
            .set('Cookie', adminCookie);
        expect(preview.status).toBe(200);

        const db = DatabaseService.getInstance();
        const originalSet = db.setBlueprintApproval.bind(db);
        vi.spyOn(db, 'setBlueprintApproval').mockImplementation((id, input) => {
            // Concurrent edit landed compose v2 before approval was written; Apply
            // still persists the v1 fingerprint onto that row.
            db.getDb().prepare('UPDATE blueprints SET compose_content = ? WHERE id = ?').run(
                'services:\n  app:\n    image: nginx:evil\n',
                id,
            );
            return originalSet(id, input);
        });

        const reconcileSpy = vi.mocked(BlueprintReconciler.getInstance().reconcileConfirmedPlan);
        const res = await request(app)
            .post(`/api/blueprints/${created.body.id}/apply`)
            .set('Cookie', adminCookie)
            .send({
                planFingerprint: preview.body.planFingerprint,
                actions: preview.body.confirmableActions,
            });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('PREVIEW_STALE');
        expect(reconcileSpy).not.toHaveBeenCalled();

        const stored = DatabaseService.getInstance().getBlueprint(created.body.id)!;
        expect(stored.approval_status).toBe('pending');
        expect(stored.approved_intent_fingerprint).toBeNull();
    });

    it('returns PREVIEW_STALE when reconcileConfirmedPlan refuses after approval', async () => {
        const node = seedNode();
        counter += 1;
        const created = await request(app)
            .post('/api/blueprints')
            .set('Cookie', adminCookie)
            .send(validBlueprintBody(node.id));
        expect(created.status).toBe(201);

        const preview = await request(app)
            .get(`/api/blueprints/${created.body.id}/preview`)
            .set('Cookie', adminCookie);
        expect(preview.status).toBe(200);

        vi.mocked(BlueprintReconciler.getInstance().reconcileConfirmedPlan).mockResolvedValueOnce({
            outcomes: [],
            refused: true,
        });

        const res = await request(app)
            .post(`/api/blueprints/${created.body.id}/apply`)
            .set('Cookie', adminCookie)
            .send({
                planFingerprint: preview.body.planFingerprint,
                actions: preview.body.confirmableActions,
            });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('PREVIEW_STALE');

        const stored = DatabaseService.getInstance().getBlueprint(created.body.id)!;
        expect(stored.approval_status).toBe('pending');
        expect(stored.approved_intent_fingerprint).toBeNull();
    });

    it('reports live pending approval when approval is cleared during reconcile', async () => {
        const node = seedNode();
        counter += 1;
        const created = await request(app)
            .post('/api/blueprints')
            .set('Cookie', adminCookie)
            .send(validBlueprintBody(node.id));
        expect(created.status).toBe(201);

        const preview = await request(app)
            .get(`/api/blueprints/${created.body.id}/preview`)
            .set('Cookie', adminCookie);
        expect(preview.status).toBe(200);

        vi.mocked(BlueprintReconciler.getInstance().reconcileConfirmedPlan).mockImplementationOnce(async (id) => {
            // Concurrent edit invalidated approval while the confirmed snapshot ran.
            DatabaseService.getInstance().clearBlueprintApproval(id);
            return {
                outcomes: [{
                    nodeId: node.id,
                    nodeName: node.name,
                    action: 'create',
                    status: 'ok',
                }],
            };
        });

        const res = await request(app)
            .post(`/api/blueprints/${created.body.id}/apply`)
            .set('Cookie', adminCookie)
            .send({
                planFingerprint: preview.body.planFingerprint,
                actions: preview.body.confirmableActions,
            });
        expect(res.status).toBe(200);
        expect(res.body.effectiveApproval).toBe('pending');
        expect(res.body.message).toMatch(/approval is no longer current/i);
        expect(res.body.outcomes).toHaveLength(1);
        expect(res.body.outcomes[0].status).toBe('ok');
        expect(res.body.outcomeSummary.ok).toBe(1);

        const stored = DatabaseService.getInstance().getBlueprint(created.body.id)!;
        expect(stored.approval_status).toBe('pending');
    });

    it('returns failed outcomes without pretending the rollout was clean', async () => {
        const node = seedNode();
        counter += 1;
        const created = await request(app)
            .post('/api/blueprints')
            .set('Cookie', adminCookie)
            .send(validBlueprintBody(node.id));
        expect(created.status).toBe(201);

        const preview = await request(app)
            .get(`/api/blueprints/${created.body.id}/preview`)
            .set('Cookie', adminCookie);
        expect(preview.status).toBe(200);

        vi.mocked(BlueprintReconciler.getInstance().reconcileConfirmedPlan).mockResolvedValueOnce({
            outcomes: [{
                nodeId: node.id,
                nodeName: node.name,
                action: 'create',
                status: 'failed',
                error: 'EHOSTUNREACH',
            }],
        });

        const res = await request(app)
            .post(`/api/blueprints/${created.body.id}/apply`)
            .set('Cookie', adminCookie)
            .send({
                planFingerprint: preview.body.planFingerprint,
                actions: preview.body.confirmableActions,
            });
        expect(res.status).toBe(200);
        expect(res.body.effectiveApproval).toBe('approved');
        expect(res.body.message).toMatch(/node failures/i);
        expect(res.body.outcomeSummary.failed).toBe(1);
        expect(res.body.outcomes[0].error).toBe('EHOSTUNREACH');
    });

    it('marks create as blocked when an unmanaged same-name stack already exists', async () => {
        const node = seedNode();
        counter += 1;
        const created = await request(app)
            .post('/api/blueprints')
            .set('Cookie', adminCookie)
            .send(validBlueprintBody(node.id));
        expect(created.status).toBe(201);

        const composeDir = process.env.COMPOSE_DIR!;
        DatabaseService.getInstance().getDb()
            .prepare('UPDATE nodes SET compose_dir = ? WHERE id = ?')
            .run(composeDir, node.id);

        const stackDir = path.join(composeDir, created.body.name as string);
        fs.mkdirSync(stackDir, { recursive: true });
        fs.writeFileSync(path.join(stackDir, 'docker-compose.yml'), 'services:\n  app:\n    image: nginx\n');

        const { BlueprintService } = await import('../services/BlueprintService');
        const conflict = await BlueprintService.getInstance().hasNameConflict(
            created.body.name as string,
            DatabaseService.getInstance().getNode(node.id)!,
        );
        expect(conflict).toBe(true);

        const preview = await request(app)
            .get(`/api/blueprints/${created.body.id}/preview`)
            .set('Cookie', adminCookie);
        expect(preview.status).toBe(200);
        const change = preview.body.changes.find((c: { nodeId: number }) => c.nodeId === node.id);
        expect(change.action).toBe('blocked_name_conflict');
        expect(change.severity).toBe('blocker');
        expect(preview.body.summary.blocker).toBeGreaterThan(0);
        // Name-conflict detection must not mutate unmanaged alternate compose files.
        expect(fs.readFileSync(path.join(stackDir, 'docker-compose.yml'), 'utf-8'))
            .toBe('services:\n  app:\n    image: nginx\n');
    });

    it('blocks rename while a non-withdrawn deployment exists', async () => {
        const node = seedNode();
        counter += 1;
        const created = await request(app)
            .post('/api/blueprints')
            .set('Cookie', adminCookie)
            .send(validBlueprintBody(node.id));
        expect(created.status).toBe(201);

        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: created.body.id,
            node_id: node.id,
            status: 'active',
            applied_revision: 1,
            last_deployed_at: Date.now(),
        });

        const res = await request(app)
            .put(`/api/blueprints/${created.body.id}`)
            .set('Cookie', adminCookie)
            .send({ name: 'renamed-while-live' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('RENAME_BLOCKED');
    });
});

describe('preview projection status precedence', () => {
    it('emits informational in_flight_deploy for a leaving deploying row, not remove', async () => {
        const node = seedNode();
        counter += 1;
        const created = await request(app)
            .post('/api/blueprints')
            .set('Cookie', adminCookie)
            .send({
                ...validBlueprintBody(node.id),
                selector: { type: 'nodes', ids: [] },
            });
        expect(created.status).toBe(201);

        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: created.body.id,
            node_id: node.id,
            status: 'deploying',
            applied_revision: 1,
        });

        const preview = await request(app)
            .get(`/api/blueprints/${created.body.id}/preview`)
            .set('Cookie', adminCookie);
        expect(preview.status).toBe(200);
        const row = preview.body.changes.find((c: { nodeId: number }) => c.nodeId === node.id);
        expect(row?.action).toBe('in_flight_deploy');
        expect(row?.kind).toBe('informational');
        expect(preview.body.executorActions.some(
            (a: { nodeId: number; action: string }) => a.nodeId === node.id && a.action === 'remove',
        )).toBe(false);
    });

    it('emits clear_stale_guard for never-deployed pending_state_review leavers', async () => {
        const node = seedNode();
        counter += 1;
        const created = await request(app)
            .post('/api/blueprints')
            .set('Cookie', adminCookie)
            .send({
                name: `bp-stale-${counter}`,
                compose_content: 'services:\n  app:\n    image: nginx\n    volumes:\n      - data:/data\nvolumes:\n  data:\n',
                selector: { type: 'nodes', ids: [] },
                drift_mode: 'observe',
            });
        expect(created.status).toBe(201);

        DatabaseService.getInstance().upsertDeployment({
            blueprint_id: created.body.id,
            node_id: node.id,
            status: 'pending_state_review',
            last_deployed_at: null,
        });

        const preview = await request(app)
            .get(`/api/blueprints/${created.body.id}/preview`)
            .set('Cookie', adminCookie);
        expect(preview.status).toBe(200);
        const row = preview.body.changes.find((c: { nodeId: number }) => c.nodeId === node.id);
        expect(row?.action).toBe('clear_stale_guard');
        expect(preview.body.executorActions).toContainEqual({ nodeId: node.id, action: 'clear_stale_guard' });
    });
});
