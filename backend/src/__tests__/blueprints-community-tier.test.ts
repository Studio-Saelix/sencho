/**
 * Confirms core Blueprint CRUD, reconciliation, and Federation pin routes are
 * reachable on the Community tier.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_JWT_SECRET, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let adminCookie: string;
let viewerAuthHeader: string;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let BlueprintReconciler: typeof import('../services/BlueprintReconciler').BlueprintReconciler;
let counter = 0;

function mockTier(tier: 'paid' | 'community') {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue(tier);
}

function seedNode(): { id: number; name: string } {
    counter += 1;
    const name = `bp-community-node-${counter}`;
    const db = DatabaseService.getInstance().getDb();
    const result = db.prepare(
        `INSERT INTO nodes (name, type, mode, compose_dir, is_default, status, created_at)
         VALUES (?, 'local', 'proxy', '/tmp/compose', 0, 'online', ?)`,
    ).run(name, Date.now());
    return { id: result.lastInsertRowid as number, name };
}

function validBlueprintBody(nodeId: number) {
    return {
        name: `bp-community-${counter + 1}`,
        compose_content: 'services:\n  app:\n    image: nginx\n',
        selector: { type: 'nodes', ids: [nodeId] },
        drift_mode: 'enforce',
    };
}

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ app } = await import('../index'));
    ({ LicenseService } = await import('../services/LicenseService'));
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ BlueprintReconciler } = await import('../services/BlueprintReconciler'));

    DatabaseService.getInstance().addUser({ username: 'bp-community-viewer', password_hash: 'hash', role: 'viewer' });
    const viewerToken = jwt.sign({ username: 'bp-community-viewer' }, TEST_JWT_SECRET, { expiresIn: '1h' });
    viewerAuthHeader = `Bearer ${viewerToken}`;

    adminCookie = await loginAsTestAdmin(app);
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
    vi.restoreAllMocks();
    mockTier('community');
    vi.spyOn(BlueprintReconciler.getInstance(), 'reconcileOne').mockResolvedValue(undefined);
    vi.spyOn(BlueprintReconciler.getInstance(), 'reconcileConfirmedPlan').mockResolvedValue({ outcomes: [] });
    const db = DatabaseService.getInstance().getDb();
    db.prepare('DELETE FROM blueprint_deployments').run();
    db.prepare('DELETE FROM blueprints').run();
    db.prepare('DELETE FROM nodes WHERE is_default = 0').run();
});

describe('Blueprints on Community tier', () => {
    it('GET /api/blueprints returns 200 for an admin', async () => {
        const res = await request(app).get('/api/blueprints').set('Cookie', adminCookie);
        expect(res.status).toBe(200);
        expect(res.body.code).not.toBe('PAID_REQUIRED');
    });

    it('POST /api/blueprints creates a blueprint for an admin', async () => {
        const node = seedNode();
        counter += 1;
        const res = await request(app)
            .post('/api/blueprints')
            .set('Cookie', adminCookie)
            .send(validBlueprintBody(node.id));
        expect(res.status).toBe(201);
        expect(res.body.drift_mode).toBe('enforce');
    });

    it('GET /api/blueprints/:id returns detail for a viewer', async () => {
        const node = seedNode();
        counter += 1;
        const created = await request(app)
            .post('/api/blueprints')
            .set('Cookie', adminCookie)
            .send(validBlueprintBody(node.id));
        expect(created.status).toBe(201);

        const res = await request(app)
            .get(`/api/blueprints/${created.body.id}`)
            .set('Authorization', viewerAuthHeader);
        expect(res.status).toBe(200);
        expect(res.body.blueprint.id).toBe(created.body.id);
    });

    it('POST /api/blueprints/:id/apply triggers reconciliation for an admin', async () => {
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
                planFingerprint: preview.body.planFingerprint,
                actions: preview.body.confirmableActions,
            });
        expect(res.status).toBe(200);
        expect(res.body.code).not.toBe('PAID_REQUIRED');
    });

    it('rejects blueprint mutations for a viewer without stack:create', async () => {
        const res = await request(app)
            .post('/api/blueprints')
            .set('Authorization', viewerAuthHeader)
            .send({});
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('PERMISSION_DENIED');
    });

    it('lets a Community viewer list blueprints', async () => {
        const res = await request(app).get('/api/blueprints').set('Authorization', viewerAuthHeader);
        expect(res.status).toBe(200);
        expect(res.body.code).not.toBe('PAID_REQUIRED');
    });

    it('node_proxy with community tier header can reach apply-local (not PAID_REQUIRED)', async () => {
        const token = jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });
        const res = await request(app)
            .post('/api/blueprints/apply-local')
            .set('Authorization', `Bearer ${token}`)
            .set('x-sencho-tier', 'community')
            .send({});
        expect(res.status).not.toBe(403);
        expect(res.body.code).not.toBe('PAID_REQUIRED');
    });

    it('node_proxy with community tier header can list blueprints', async () => {
        const token = jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });
        const res = await request(app)
            .get('/api/blueprints')
            .set('Authorization', `Bearer ${token}`)
            .set('x-sencho-tier', 'community');
        expect(res.status).toBe(200);
        expect(res.body.code).not.toBe('PAID_REQUIRED');
    });

    it('PUT /api/blueprints/:id/pin succeeds for a Community admin', async () => {
        const node = seedNode();
        counter += 1;
        const created = await request(app)
            .post('/api/blueprints')
            .set('Cookie', adminCookie)
            .send(validBlueprintBody(node.id));
        expect(created.status).toBe(201);

        const res = await request(app)
            .put(`/api/blueprints/${created.body.id}/pin`)
            .set('Cookie', adminCookie)
            .send({ nodeId: node.id });
        expect(res.status).toBe(200);
        expect(res.body.pinned_node_id).toBe(node.id);
    });
});
