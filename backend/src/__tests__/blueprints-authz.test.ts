/**
 * Authorization parity tests for /api/blueprints.
 *
 * The Blueprints UI gates affordances on license tier (Skipper / Admiral) and
 * admin role; these tests pin the matching server-side guards so a UI gate and a
 * route guard cannot silently drift apart. Specifically:
 *   - PUT /:id/pin requires Admiral tier AND admin role (the admin-role half is
 *     the parity gap the Federation pin control was hardened to match).
 *   - The mutation routes require admin role.
 *   - The read routes require paid tier but NOT admin role.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { LicenseTier, LicenseVariant } from '../services/license-types';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let BlueprintReconciler: typeof import('../services/BlueprintReconciler').BlueprintReconciler;
let adminCookie: string;
let viewerCookie: string;
let counter = 0;

function setLicense(tier: LicenseTier, variant: LicenseVariant): void {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue(tier);
    vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue(variant);
}

function seedNode(): { id: number; name: string } {
    counter += 1;
    const name = `bp-authz-node-${counter}`;
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
        name: `bp-authz-${counter}`,
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

async function seedAndLoginViewer(): Promise<string> {
    const bcrypt = (await import('bcrypt')).default;
    const supertest = (await import('supertest')).default;
    const passwordHash = await bcrypt.hash('bp-viewer-pass', 1);
    DatabaseService.getInstance().addUser({ username: 'bp-viewer', password_hash: passwordHash, role: 'viewer' });
    const res = await supertest(app)
        .post('/api/auth/login')
        .send({ username: 'bp-viewer', password: 'bp-viewer-pass' });
    const cookies = res.headers['set-cookie'] as string | string[];
    return Array.isArray(cookies) ? cookies[0] : cookies;
}

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ LicenseService } = await import('../services/LicenseService'));
    ({ BlueprintReconciler } = await import('../services/BlueprintReconciler'));

    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
    vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue('admiral');
    vi.spyOn(LicenseService.getInstance(), 'getSeatLimits').mockReturnValue({ maxAdmins: null, maxViewers: null });

    ({ app } = await import('../index'));
    adminCookie = await loginAsTestAdmin(app);
    viewerCookie = await seedAndLoginViewer();
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
    vi.restoreAllMocks();
    setLicense('paid', 'admiral');
    vi.spyOn(LicenseService.getInstance(), 'getSeatLimits').mockReturnValue({ maxAdmins: null, maxViewers: null });
    // Neutralize the post-pin background reconcile so the 200 path has no side effects.
    vi.spyOn(BlueprintReconciler.getInstance(), 'reconcileOne').mockResolvedValue(undefined);
    const db = DatabaseService.getInstance().getDb();
    db.prepare('DELETE FROM blueprint_deployments').run();
    db.prepare('DELETE FROM blueprints').run();
    db.prepare('DELETE FROM nodes WHERE is_default = 0').run();
});

describe('PUT /api/blueprints/:id/pin authorization', () => {
    it('allows an admin on an Admiral license to pin a blueprint', async () => {
        const node = seedNode();
        const bp = seedBlueprint([node.id]);

        const res = await request(app)
            .put(`/api/blueprints/${bp.id}/pin`)
            .set('Cookie', adminCookie)
            .send({ nodeId: node.id });

        expect(res.status).toBe(200);
        expect(res.body.pinned_node_id).toBe(node.id);
    });

    it('allows an admin on an Admiral license to unpin (nodeId null)', async () => {
        const node = seedNode();
        const bp = seedBlueprint([node.id]);
        DatabaseService.getInstance().setBlueprintPinnedNode(bp.id, node.id);

        const res = await request(app)
            .put(`/api/blueprints/${bp.id}/pin`)
            .set('Cookie', adminCookie)
            .send({ nodeId: null });

        expect(res.status).toBe(200);
        expect(res.body.pinned_node_id).toBeNull();
    });

    it('rejects an admin on a Skipper license with ADMIRAL_REQUIRED', async () => {
        setLicense('paid', 'skipper');
        const node = seedNode();
        const bp = seedBlueprint([node.id]);

        const res = await request(app)
            .put(`/api/blueprints/${bp.id}/pin`)
            .set('Cookie', adminCookie)
            .send({ nodeId: node.id });

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ADMIRAL_REQUIRED');
    });

    it('rejects an admin on a Community license with PAID_REQUIRED', async () => {
        setLicense('community', null);
        const node = seedNode();
        const bp = seedBlueprint([node.id]);

        const res = await request(app)
            .put(`/api/blueprints/${bp.id}/pin`)
            .set('Cookie', adminCookie)
            .send({ nodeId: node.id });

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('PAID_REQUIRED');
    });

    it('rejects a non-admin on an Admiral license with ADMIN_REQUIRED', async () => {
        const node = seedNode();
        const bp = seedBlueprint([node.id]);

        const res = await request(app)
            .put(`/api/blueprints/${bp.id}/pin`)
            .set('Cookie', viewerCookie)
            .send({ nodeId: node.id });

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ADMIN_REQUIRED');
    });
});

describe('Blueprint mutation routes require admin role', () => {
    // Tier is paid+admiral in beforeEach, so requirePaid passes and the admin
    // guard is what rejects. The gate short-circuits before id parsing, so dummy
    // ids are sufficient to prove the role boundary.
    const mutations: Array<{ name: string; method: 'post' | 'put' | 'delete'; path: string }> = [
        { name: 'create', method: 'post', path: '/api/blueprints' },
        { name: 'update', method: 'put', path: '/api/blueprints/1' },
        { name: 'delete', method: 'delete', path: '/api/blueprints/1' },
        { name: 'apply', method: 'post', path: '/api/blueprints/1/apply' },
        { name: 'withdraw', method: 'post', path: '/api/blueprints/1/withdraw/1' },
        { name: 'accept', method: 'post', path: '/api/blueprints/1/accept/1' },
    ];

    it.each(mutations)('rejects a non-admin on $name with ADMIN_REQUIRED', async ({ method, path }) => {
        const res = await request(app)[method](path).set('Cookie', viewerCookie).send({});
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ADMIN_REQUIRED');
    });

    it('rejects an admin on a Community license from creating with PAID_REQUIRED', async () => {
        setLicense('community', null);
        const res = await request(app)
            .post('/api/blueprints')
            .set('Cookie', adminCookie)
            .send({});
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('PAID_REQUIRED');
    });
});

describe('Blueprint read routes require paid tier but not admin role', () => {
    it('lets a non-admin paid user list blueprints', async () => {
        seedBlueprint([]);
        const res = await request(app).get('/api/blueprints').set('Cookie', viewerCookie);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    it('lets a non-admin paid user fetch a blueprint detail', async () => {
        const bp = seedBlueprint([]);
        const res = await request(app).get(`/api/blueprints/${bp.id}`).set('Cookie', viewerCookie);
        expect(res.status).toBe(200);
        expect(res.body.blueprint.id).toBe(bp.id);
    });

    it('lets a non-admin paid user preview a blueprint', async () => {
        const node = seedNode();
        const bp = seedBlueprint([node.id]);
        const res = await request(app).get(`/api/blueprints/${bp.id}/preview`).set('Cookie', viewerCookie);
        expect(res.status).toBe(200);
        expect(res.body.blueprintId).toBe(bp.id);
    });

    it('lets a non-admin paid user analyze compose', async () => {
        const res = await request(app)
            .post('/api/blueprints/analyze')
            .set('Cookie', viewerCookie)
            .send({ compose_content: 'services:\n  app:\n    image: nginx\n' });
        expect(res.status).toBe(200);
        expect(res.body.classification).toBeDefined();
    });

    it('rejects an admin on a Community license from listing with PAID_REQUIRED', async () => {
        setLicense('community', null);
        const res = await request(app).get('/api/blueprints').set('Cookie', adminCookie);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('PAID_REQUIRED');
    });
});
