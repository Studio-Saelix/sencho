/**
 * Gate coverage for the mesh router.
 *
 * Mesh is not tier-gated. Node enable/disable and override regeneration are
 * permission-gated. Stack membership remains Admin-only because a membership
 * change redeploys every affected mesh stack. The read routes (status,
 * aliases, activity, diagnostics) need only the read permission (node:read /
 * stack:read), not Admin, which is what lets a non-admin see a read-only
 * Routing tab. The node-to-node routes that central calls over the proxy on the
 * operator's behalf (local-override PUT/DELETE, alias test) are intentionally
 * not admin-gated. These tests lock that split so the backend
 * can never silently diverge from the matching frontend render gate (a button
 * that 403s, or a feature an owner cannot see).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, TEST_JWT_SECRET, TEST_USERNAME } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let defaultNodeId: number;

function userToken(username: string): string {
    const user = DatabaseService.getInstance().getUserByUsername(username);
    if (!user) throw new Error(`missing test user ${username}`);
    return jwt.sign({ username, role: user.role, tv: user.token_version }, TEST_JWT_SECRET, { expiresIn: '5m' });
}

function setTier(tier: 'community' | 'paid'): void {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue(tier);
}

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ LicenseService } = await import('../services/LicenseService'));

    const viewerHash = await bcrypt.hash('password123', 1);
    DatabaseService.getInstance().addUser({ username: 'mesh-viewer', password_hash: viewerHash, role: 'viewer' });
    defaultNodeId = DatabaseService.getInstance().getDefaultNode()?.id ?? 1;

    ({ app } = await import('../index'));
});

beforeEach(() => {
    // Community by default: Mesh must work without a paid license.
    setTier('community');
});

afterAll(() => {
    vi.restoreAllMocks();
    cleanupTestDb(tmpDir);
});

describe('mesh is not tier-gated', () => {
    it('serves aliases to a Community admin', async () => {
        const res = await request(app)
            .get('/api/mesh/aliases')
            .set('Authorization', `Bearer ${userToken(TEST_USERNAME)}`);
        expect(res.status).toBe(200);
    });

    // Every route except the SSE activity stream, which never ends a response.
    // Handlers may still 4xx/5xx for other reasons in the test environment;
    // only a tier rejection is asserted absent.
    const everyRoute: { method: 'get' | 'post' | 'put' | 'delete'; path: () => string }[] = [
        { method: 'get', path: () => '/api/mesh/status' },
        { method: 'post', path: () => '/api/mesh/regen-overrides' },
        { method: 'post', path: () => `/api/mesh/nodes/${defaultNodeId}/enable` },
        { method: 'post', path: () => `/api/mesh/nodes/${defaultNodeId}/disable` },
        { method: 'get', path: () => '/api/mesh/local-services/demo' },
        { method: 'get', path: () => '/api/mesh/local-stacks' },
        { method: 'put', path: () => '/api/mesh/local-override/demo' },
        { method: 'delete', path: () => '/api/mesh/local-override/demo' },
        { method: 'get', path: () => `/api/mesh/nodes/${defaultNodeId}/stacks` },
        { method: 'post', path: () => `/api/mesh/nodes/${defaultNodeId}/stacks/demo/opt-in` },
        { method: 'post', path: () => `/api/mesh/nodes/${defaultNodeId}/stacks/demo/opt-out` },
        { method: 'get', path: () => '/api/mesh/aliases' },
        { method: 'get', path: () => '/api/mesh/aliases/demo/diagnostic' },
        { method: 'post', path: () => '/api/mesh/aliases/demo/test' },
        { method: 'get', path: () => `/api/mesh/nodes/${defaultNodeId}/diagnostic` },
        { method: 'get', path: () => '/api/mesh/activity' },
    ];
    for (const route of everyRoute) {
        it(`${route.method.toUpperCase()} ${route.path()} is not tier-rejected for a Community admin`, async () => {
            const res = await request(app)[route.method](route.path())
                .set('Authorization', `Bearer ${userToken(TEST_USERNAME)}`);
            expect(res.body.code).not.toBe('PAID_REQUIRED');
        });
    }

    it('serves aliases identically on a paid instance', async () => {
        setTier('paid');
        const res = await request(app)
            .get('/api/mesh/aliases')
            .set('Authorization', `Bearer ${userToken(TEST_USERNAME)}`);
        expect(res.status).toBe(200);
    });
});

describe('mesh read routes are visible to a non-admin user', () => {
    it('returns aliases to a viewer', async () => {
        const res = await request(app)
            .get('/api/mesh/aliases')
            .set('Authorization', `Bearer ${userToken('mesh-viewer')}`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.aliases)).toBe(true);
    });

    it('returns activity to a viewer', async () => {
        const res = await request(app)
            .get('/api/mesh/activity')
            .set('Authorization', `Bearer ${userToken('mesh-viewer')}`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.events)).toBe(true);
    });

    it('returns status to a viewer', async () => {
        const res = await request(app)
            .get('/api/mesh/status')
            .set('Authorization', `Bearer ${userToken('mesh-viewer')}`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.nodes)).toBe(true);
    });
});

describe('mesh mutation authorization', () => {
    const permissionRoutes: { name: string; path: () => string }[] = [
        { name: 'POST /regen-overrides', path: () => '/api/mesh/regen-overrides' },
        { name: 'POST /nodes/:id/enable', path: () => `/api/mesh/nodes/${defaultNodeId}/enable` },
        { name: 'POST /nodes/:id/disable', path: () => `/api/mesh/nodes/${defaultNodeId}/disable` },
    ];
    const adminRoutes: { name: string; path: () => string }[] = [
        { name: 'POST /nodes/:id/stacks/:stack/opt-in', path: () => `/api/mesh/nodes/${defaultNodeId}/stacks/demo/opt-in` },
        { name: 'POST /nodes/:id/stacks/:stack/opt-out', path: () => `/api/mesh/nodes/${defaultNodeId}/stacks/demo/opt-out` },
    ];

    for (const route of permissionRoutes) {
        it(`${route.name} rejects a user without the required operational permission`, async () => {
            const res = await request(app)
                .post(route.path())
                .set('Authorization', `Bearer ${userToken('mesh-viewer')}`);
            expect(res.status).toBe(403);
            expect(res.body.code).toBe('PERMISSION_DENIED');
        });
    }

    for (const route of adminRoutes) {
        it(`${route.name} remains Admin-only`, async () => {
            const res = await request(app)
                .post(route.path())
                .set('Authorization', `Bearer ${userToken('mesh-viewer')}`);
            expect(res.status).toBe(403);
            expect(res.body.code).toBe('ADMIN_REQUIRED');
        });
    }

    it('lets a Community admin through on regen-overrides', async () => {
        const res = await request(app)
            .post('/api/mesh/regen-overrides')
            .set('Authorization', `Bearer ${userToken(TEST_USERNAME)}`);
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('regenerated');
    });

    it('lets a Community admin past the gates on a node mutation (not gate-rejected)', async () => {
        // An admin on a Community instance must never be rejected by a gate. The
        // handler may still 4xx/5xx for other reasons in the test environment;
        // only the gate codes are asserted absent.
        const res = await request(app)
            .post(`/api/mesh/nodes/${defaultNodeId}/enable`)
            .set('Authorization', `Bearer ${userToken(TEST_USERNAME)}`);
        expect(res.body.code).not.toBe('PAID_REQUIRED');
        expect(res.body.code).not.toBe('ADMIN_REQUIRED');
    });
});
