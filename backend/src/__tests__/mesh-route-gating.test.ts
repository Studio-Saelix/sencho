/**
 * Gate coverage for the mesh router.
 *
 * Every /api/mesh route is tier-gated (requirePaid). The five operator
 * mutations are additionally role-gated (requireAdmin): node enable/disable,
 * stack opt-in/opt-out, and the override regen. The operator read routes
 * (status, aliases, activity, diagnostics) stay reachable for any paid-tier
 * user regardless of role, which is what lets a non-admin see a read-only
 * Routing tab. The node-to-node routes that central calls over the proxy on the
 * operator's behalf (local-override PUT/DELETE, alias test) are paid-gated
 * but intentionally not admin-gated. These tests lock that split so the backend
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
    // Default every test to a fully entitled paid instance; tier-rejection
    // tests override this locally.
    setTier('paid');
});

afterAll(() => {
    vi.restoreAllMocks();
    cleanupTestDb(tmpDir);
});

describe('mesh tier gate (requirePaid)', () => {
    it('rejects Community tier with PAID_REQUIRED', async () => {
        setTier('community');
        const res = await request(app)
            .get('/api/mesh/aliases')
            .set('Authorization', `Bearer ${userToken(TEST_USERNAME)}`);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('PAID_REQUIRED');
    });

    it('rejects Community tier on a mutation before the role gate runs', async () => {
        setTier('community');
        const res = await request(app)
            .post('/api/mesh/regen-overrides')
            .set('Authorization', `Bearer ${userToken(TEST_USERNAME)}`);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('PAID_REQUIRED');
    });
});

describe('mesh read routes are visible to a non-admin paid user', () => {
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

describe('mesh mutation routes require the admin role (requireAdmin)', () => {
    const mutationRoutes: { name: string; path: () => string }[] = [
        { name: 'POST /regen-overrides', path: () => '/api/mesh/regen-overrides' },
        { name: 'POST /nodes/:id/enable', path: () => `/api/mesh/nodes/${defaultNodeId}/enable` },
        { name: 'POST /nodes/:id/disable', path: () => `/api/mesh/nodes/${defaultNodeId}/disable` },
        { name: 'POST /nodes/:id/stacks/:stack/opt-in', path: () => `/api/mesh/nodes/${defaultNodeId}/stacks/demo/opt-in` },
        { name: 'POST /nodes/:id/stacks/:stack/opt-out', path: () => `/api/mesh/nodes/${defaultNodeId}/stacks/demo/opt-out` },
    ];

    for (const route of mutationRoutes) {
        it(`${route.name} rejects a non-admin paid user with ADMIN_REQUIRED`, async () => {
            const res = await request(app)
                .post(route.path())
                .set('Authorization', `Bearer ${userToken('mesh-viewer')}`);
            expect(res.status).toBe(403);
            expect(res.body.code).toBe('ADMIN_REQUIRED');
        });
    }

    it('lets a paid admin pass both gates on regen-overrides', async () => {
        const res = await request(app)
            .post('/api/mesh/regen-overrides')
            .set('Authorization', `Bearer ${userToken(TEST_USERNAME)}`);
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('regenerated');
    });

    it('lets a paid admin past both gates on a node mutation (not gate-rejected)', async () => {
        // Locks the guard order (tier before role) for a mutation other than
        // regen-overrides: an admin must never be rejected by either gate. The
        // handler may still 4xx/5xx for other reasons in the test environment;
        // only the gate codes are asserted absent.
        const res = await request(app)
            .post(`/api/mesh/nodes/${defaultNodeId}/enable`)
            .set('Authorization', `Bearer ${userToken(TEST_USERNAME)}`);
        expect(res.body.code).not.toBe('PAID_REQUIRED');
        expect(res.body.code).not.toBe('ADMIN_REQUIRED');
    });
});
