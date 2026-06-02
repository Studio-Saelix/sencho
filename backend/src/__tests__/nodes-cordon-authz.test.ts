/**
 * Authorization and validation tests for the Federation cordon routes
 * (POST /api/nodes/:id/cordon and /uncordon).
 *
 * These guard the same boundary the NodeCard cordon control renders against, so
 * a UI gate and a route guard cannot silently drift apart. Cordon/uncordon
 * require Admiral tier AND the node:manage permission (held by admin and
 * node-admin roles). The guard order is:
 *   rejectApiTokenScope (SCOPE_DENIED) -> requirePermission (PERMISSION_DENIED)
 *   -> requireAdmiral (PAID_REQUIRED / ADMIRAL_REQUIRED) -> invalid-id 400
 *   -> reason 400 (cordon only) -> 404.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { LicenseTier, LicenseVariant } from '../services/license-types';
import type { UserRole } from '../services/DatabaseService';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin, TEST_USERNAME } from './helpers/setupTestDb';
import { createTestApiToken } from './helpers/apiTokenTestHelper';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let adminCookie: string;
let adminUserId: number;
const roleCookie: Record<string, string> = {};
let counter = 0;

function setLicense(tier: LicenseTier, variant: LicenseVariant): void {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue(tier);
    vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue(variant);
}

function seedNode(): { id: number; name: string } {
    counter += 1;
    const name = `cordon-authz-node-${counter}`;
    const db = DatabaseService.getInstance().getDb();
    const result = db.prepare(
        `INSERT INTO nodes (name, type, mode, compose_dir, is_default, status, created_at)
         VALUES (?, 'local', 'proxy', '/tmp/compose', 0, 'online', ?)`,
    ).run(name, Date.now());
    return { id: result.lastInsertRowid as number, name };
}

async function seedAndLogin(role: UserRole): Promise<string> {
    const bcrypt = (await import('bcrypt')).default;
    const supertest = (await import('supertest')).default;
    const username = `cordon-${role}`;
    const password = `cordon-${role}-pass`;
    const passwordHash = await bcrypt.hash(password, 1);
    DatabaseService.getInstance().addUser({ username, password_hash: passwordHash, role });
    const res = await supertest(app).post('/api/auth/login').send({ username, password });
    const cookies = res.headers['set-cookie'] as string | string[];
    return Array.isArray(cookies) ? cookies[0] : cookies;
}

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ LicenseService } = await import('../services/LicenseService'));

    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
    vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue('admiral');
    vi.spyOn(LicenseService.getInstance(), 'getSeatLimits').mockReturnValue({ maxAdmins: null, maxViewers: null });

    ({ app } = await import('../index'));
    adminCookie = await loginAsTestAdmin(app);
    for (const role of ['node-admin', 'viewer', 'deployer', 'auditor'] as const) {
        roleCookie[role] = await seedAndLogin(role);
    }
    const adminRow = DatabaseService.getInstance().getDb()
        .prepare('SELECT id FROM users WHERE username = ?')
        .get(TEST_USERNAME) as { id: number } | undefined;
    if (!adminRow) throw new Error('seeded admin user not found');
    adminUserId = adminRow.id;
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
    vi.restoreAllMocks();
    setLicense('paid', 'admiral');
    vi.spyOn(LicenseService.getInstance(), 'getSeatLimits').mockReturnValue({ maxAdmins: null, maxViewers: null });
    DatabaseService.getInstance().getDb().prepare('DELETE FROM nodes WHERE is_default = 0').run();
});

describe('POST /api/nodes/:id/cordon authorization', () => {
    it('lets an admin cordon a node and stores the trimmed reason', async () => {
        const node = seedNode();
        const res = await request(app)
            .post(`/api/nodes/${node.id}/cordon`)
            .set('Cookie', adminCookie)
            .send({ reason: '  patching kernel  ' });
        expect(res.status).toBe(200);
        expect(res.body.cordoned).toBe(true);
        expect(res.body.cordoned_reason).toBe('patching kernel');
    });

    it('lets a node-admin cordon a node', async () => {
        const node = seedNode();
        const res = await request(app)
            .post(`/api/nodes/${node.id}/cordon`)
            .set('Cookie', roleCookie['node-admin'])
            .send({});
        expect(res.status).toBe(200);
        expect(res.body.cordoned).toBe(true);
    });

    it.each(['viewer', 'deployer', 'auditor'])(
        'rejects a %s without node:manage with PERMISSION_DENIED',
        async (role) => {
            const node = seedNode();
            const res = await request(app)
                .post(`/api/nodes/${node.id}/cordon`)
                .set('Cookie', roleCookie[role])
                .send({});
            expect(res.status).toBe(403);
            expect(res.body.code).toBe('PERMISSION_DENIED');
        },
    );

    it('rejects an admin on a Skipper license with ADMIRAL_REQUIRED', async () => {
        setLicense('paid', 'skipper');
        const node = seedNode();
        const res = await request(app)
            .post(`/api/nodes/${node.id}/cordon`)
            .set('Cookie', adminCookie)
            .send({});
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ADMIRAL_REQUIRED');
    });

    it('rejects an admin on a Community license with PAID_REQUIRED', async () => {
        setLicense('community', null);
        const node = seedNode();
        const res = await request(app)
            .post(`/api/nodes/${node.id}/cordon`)
            .set('Cookie', adminCookie)
            .send({});
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('PAID_REQUIRED');
    });

    it('rejects a full-admin API token with SCOPE_DENIED (API tokens cannot manage nodes)', async () => {
        const node = seedNode();
        const token = createTestApiToken({ db: DatabaseService, scope: 'full-admin', userId: adminUserId });
        const res = await request(app)
            .post(`/api/nodes/${node.id}/cordon`)
            .set('Authorization', `Bearer ${token}`)
            .send({ reason: 'ci' });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('SCOPE_DENIED');
    });

    it('rejects a reason longer than 256 characters with 400', async () => {
        const node = seedNode();
        const res = await request(app)
            .post(`/api/nodes/${node.id}/cordon`)
            .set('Cookie', adminCookie)
            .send({ reason: 'a'.repeat(257) });
        expect(res.status).toBe(400);
    });

    it('rejects a non-string reason with 400', async () => {
        const node = seedNode();
        const res = await request(app)
            .post(`/api/nodes/${node.id}/cordon`)
            .set('Cookie', adminCookie)
            .send({ reason: 123 });
        expect(res.status).toBe(400);
    });

    it('rejects an invalid node id with 400', async () => {
        const res = await request(app)
            .post('/api/nodes/0/cordon')
            .set('Cookie', adminCookie)
            .send({});
        expect(res.status).toBe(400);
    });

    it('rejects a numeric-prefix node id with 400', async () => {
        const res = await request(app)
            .post('/api/nodes/1abc/cordon')
            .set('Cookie', adminCookie)
            .send({});
        expect(res.status).toBe(400);
    });

    it('returns 404 for a node that does not exist', async () => {
        const res = await request(app)
            .post('/api/nodes/999999/cordon')
            .set('Cookie', adminCookie)
            .send({});
        expect(res.status).toBe(404);
    });

    it('stores null when the reason is whitespace only', async () => {
        const node = seedNode();
        const res = await request(app)
            .post(`/api/nodes/${node.id}/cordon`)
            .set('Cookie', adminCookie)
            .send({ reason: '   ' });
        expect(res.status).toBe(200);
        expect(res.body.cordoned).toBe(true);
        expect(res.body.cordoned_reason).toBeNull();
    });

    it('checks node:manage before the tier gate (Skipper viewer gets PERMISSION_DENIED, not ADMIRAL_REQUIRED)', async () => {
        setLicense('paid', 'skipper');
        const node = seedNode();
        const res = await request(app)
            .post(`/api/nodes/${node.id}/cordon`)
            .set('Cookie', roleCookie['viewer'])
            .send({});
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('PERMISSION_DENIED');
    });
});

describe('POST /api/nodes/:id/uncordon authorization', () => {
    function seedCordonedNode(): { id: number; name: string } {
        const node = seedNode();
        DatabaseService.getInstance().setNodeCordoned(node.id, true, 'pre');
        return node;
    }

    it('lets an admin uncordon a node', async () => {
        const node = seedCordonedNode();
        const res = await request(app)
            .post(`/api/nodes/${node.id}/uncordon`)
            .set('Cookie', adminCookie)
            .send({});
        expect(res.status).toBe(200);
        expect(res.body.cordoned).toBe(false);
        expect(res.body.cordoned_reason).toBeNull();
    });

    it('lets a node-admin uncordon a node', async () => {
        const node = seedCordonedNode();
        const res = await request(app)
            .post(`/api/nodes/${node.id}/uncordon`)
            .set('Cookie', roleCookie['node-admin'])
            .send({});
        expect(res.status).toBe(200);
        expect(res.body.cordoned).toBe(false);
    });

    it.each(['viewer', 'deployer', 'auditor'])(
        'rejects a %s without node:manage with PERMISSION_DENIED',
        async (role) => {
            const node = seedCordonedNode();
            const res = await request(app)
                .post(`/api/nodes/${node.id}/uncordon`)
                .set('Cookie', roleCookie[role])
                .send({});
            expect(res.status).toBe(403);
            expect(res.body.code).toBe('PERMISSION_DENIED');
        },
    );

    it('rejects an admin on a Skipper license with ADMIRAL_REQUIRED', async () => {
        setLicense('paid', 'skipper');
        const node = seedCordonedNode();
        const res = await request(app)
            .post(`/api/nodes/${node.id}/uncordon`)
            .set('Cookie', adminCookie)
            .send({});
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ADMIRAL_REQUIRED');
    });

    it('rejects a full-admin API token with SCOPE_DENIED', async () => {
        const node = seedCordonedNode();
        const token = createTestApiToken({ db: DatabaseService, scope: 'full-admin', userId: adminUserId });
        const res = await request(app)
            .post(`/api/nodes/${node.id}/uncordon`)
            .set('Authorization', `Bearer ${token}`)
            .send({});
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('SCOPE_DENIED');
    });

    it('returns 404 for a node that does not exist', async () => {
        const res = await request(app)
            .post('/api/nodes/999999/uncordon')
            .set('Cookie', adminCookie)
            .send({});
        expect(res.status).toBe(404);
    });

    it('rejects an invalid node id with 400', async () => {
        const res = await request(app)
            .post('/api/nodes/0/uncordon')
            .set('Cookie', adminCookie)
            .send({});
        expect(res.status).toBe(400);
    });

    it('rejects a numeric-prefix node id with 400', async () => {
        const res = await request(app)
            .post('/api/nodes/1abc/uncordon')
            .set('Cookie', adminCookie)
            .send({});
        expect(res.status).toBe(400);
    });
});
