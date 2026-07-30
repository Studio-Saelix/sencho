import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, TEST_JWT_SECRET, TEST_USERNAME } from './helpers/setupTestDb';
import { generateApiToken } from '../utils/apiTokenFormat';
import { PROXY_TIER_HEADER } from '../services/license-headers';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let ROLE_PERMISSIONS: typeof import('../middleware/permissions').ROLE_PERMISSIONS;

type SeedRole = 'admin' | 'node-admin' | 'deployer' | 'viewer' | 'auditor';

function userToken(username: string): string {
    const user = DatabaseService.getInstance().getUserByUsername(username);
    if (!user) throw new Error(`missing test user ${username}`);
    return jwt.sign({ username, role: user.role, tv: user.token_version }, TEST_JWT_SECRET, { expiresIn: '5m' });
}

/** Seed a user with the given role if it doesn't already exist. */
async function seedRoleUser(username: string, role: SeedRole): Promise<void> {
    const db = DatabaseService.getInstance();
    if (db.getUserByUsername(username)) return;
    const hash = await bcrypt.hash('password123', 1);
    db.addUser({ username, password_hash: hash, role });
}

function createApiToken(scope: 'read-only' | 'deploy-only' | 'full-admin'): string {
    const rawToken = generateApiToken();
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const admin = DatabaseService.getInstance().getUserByUsername(TEST_USERNAME);
    if (!admin?.id) throw new Error('missing seeded admin');
    DatabaseService.getInstance().addApiToken({
        token_hash: tokenHash,
        name: `auto-heal-${scope}-${Date.now()}`,
        scope,
        user_id: admin.id,
        created_at: Date.now(),
        expires_at: null,
    });
    return rawToken;
}

function makePolicy(nodeId: number, stackName = 'route-stack') {
    const now = Date.now();
    return DatabaseService.getInstance().addAutoHealPolicy({
        node_id: nodeId,
        proxy_entitled_until: 0,
        stack_name: stackName,
        service_name: null,
        unhealthy_duration_mins: 5,
        cooldown_mins: 5,
        max_restarts_per_hour: 3,
        auto_disable_after_failures: 5,
        enabled: 1,
        consecutive_failures: 0,
        last_fired_at: 0,
        created_at: now,
        updated_at: now,
    });
}

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ LicenseService } = await import('../services/LicenseService'));
    ({ ROLE_PERMISSIONS } = await import('../middleware/permissions'));
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');

    const viewerHash = await bcrypt.hash('password123', 1);
    DatabaseService.getInstance().addUser({ username: 'route-viewer', password_hash: viewerHash, role: 'viewer' });

    ({ app } = await import('../index'));
});

beforeEach(() => {
    DatabaseService.getInstance().getDb().prepare('DELETE FROM auto_heal_history').run();
    DatabaseService.getInstance().getDb().prepare('DELETE FROM auto_heal_policies').run();
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
});

afterAll(() => {
    vi.restoreAllMocks();
    cleanupTestDb(tmpDir);
});

/** Insert a second local node via raw SQL, bypassing the addNode singleton guard. */
function insertLegacyLocal(name: string, isDefault = false): number {
    const db = DatabaseService.getInstance().getDb();
    if (isDefault) {
        db.prepare('UPDATE nodes SET is_default = 0').run();
    }
    const result = db.prepare(
        "INSERT INTO nodes (name, type, compose_dir, is_default, status, created_at) VALUES (?, 'local', ?, ?, 'online', ?)"
    ).run(name, process.env.COMPOSE_DIR ?? '', isDefault ? 1 : 0, Date.now());
    return result.lastInsertRowid as number;
}

describe('/api/auto-heal routes', () => {
    it('allows Community tier access', async () => {
        vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');

        const res = await request(app)
            .get('/api/auto-heal/policies')
            .set('Authorization', `Bearer ${userToken(TEST_USERNAME)}`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    it('marks trusted proxy-created policies with a lease on a Community runtime node', async () => {
        vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
        const proxyToken = jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '5m' });

        const res = await request(app)
            .post('/api/auto-heal/policies')
            .set('Authorization', `Bearer ${proxyToken}`)
            .set(PROXY_TIER_HEADER, 'paid')
            .send({
                stack_name: 'proxy-runtime-stack',
                unhealthy_duration_mins: 5,
            });

        expect(res.status).toBe(201);
        expect(res.body.proxy_entitled_until).toBeGreaterThan(Date.now());
    });

    it('allows admins to create node-scoped policies', async () => {
        const res = await request(app)
            .post('/api/auto-heal/policies')
            .set('Authorization', `Bearer ${userToken(TEST_USERNAME)}`)
            .send({
                stack_name: 'route-stack',
                service_name: null,
                unhealthy_duration_mins: 5,
            });

        expect(res.status).toBe(201);
        expect(res.body.node_id).toBe(DatabaseService.getInstance().getDefaultNode()?.id);
        expect(res.body.proxy_entitled_until).toBe(0);
    });

    it.each(['viewer', 'deployer', 'auditor'] as const)(
        'rejects %s policy mutation with 403 PERMISSION_DENIED',
        async (role) => {
            await seedRoleUser(`auto-heal-post-${role}`, role);
            const res = await request(app)
                .post('/api/auto-heal/policies')
                .set('Authorization', `Bearer ${userToken(`auto-heal-post-${role}`)}`)
                .send({
                    stack_name: 'route-stack',
                    unhealthy_duration_mins: 5,
                });

            expect(res.status).toBe(403);
            expect(res.body.code).toBe('PERMISSION_DENIED');
        },
    );

    it.each(['admin', 'node-admin'] as const)(
        'lets %s pass the policy mutation permission gate',
        async (role) => {
            await seedRoleUser(`auto-heal-post-${role}`, role);
            const res = await request(app)
                .post('/api/auto-heal/policies')
                .set('Authorization', `Bearer ${userToken(`auto-heal-post-${role}`)}`)
                .send({
                    stack_name: `route-stack-${role}`,
                    unhealthy_duration_mins: 5,
                });

            expect(res.status).toBe(201);
        },
    );

    it('denies policy listing with 403 PERMISSION_DENIED when the caller lacks stack:read', async () => {
        const original = ROLE_PERMISSIONS.viewer;
        ROLE_PERMISSIONS.viewer = original.filter((p) => p !== 'stack:read');
        try {
            const res = await request(app)
                .get('/api/auto-heal/policies')
                .set('Authorization', `Bearer ${userToken('route-viewer')}`);

            expect(res.status).toBe(403);
            expect(res.body.code).toBe('PERMISSION_DENIED');
        } finally {
            ROLE_PERMISSIONS.viewer = original;
        }
    });

    it('lists only policies for the active node', async () => {
        const defaultNodeId = DatabaseService.getInstance().getDefaultNode()?.id ?? 1;
        const secondNodeId = insertLegacyLocal('route-second-local');
        makePolicy(defaultNodeId, 'same-stack');
        makePolicy(secondNodeId, 'same-stack');

        const defaultRes = await request(app)
            .get('/api/auto-heal/policies?stackName=same-stack')
            .set('Authorization', `Bearer ${userToken(TEST_USERNAME)}`);
        const secondRes = await request(app)
            .get('/api/auto-heal/policies?stackName=same-stack')
            .set('Authorization', `Bearer ${userToken(TEST_USERNAME)}`)
            .set('x-node-id', String(secondNodeId));

        expect(defaultRes.status).toBe(200);
        expect(defaultRes.body).toHaveLength(1);
        expect(defaultRes.body[0].node_id).toBe(defaultNodeId);
        expect(secondRes.status).toBe(200);
        expect(secondRes.body).toHaveLength(1);
        expect(secondRes.body[0].node_id).toBe(secondNodeId);
    });

    it('rejects history access for a policy owned by a different node', async () => {
        const secondNodeId = insertLegacyLocal('history-second-local');
        const policy = makePolicy(secondNodeId, 'history-stack');

        const res = await request(app)
            .get(`/api/auto-heal/policies/${policy.id}/history`)
            .set('Authorization', `Bearer ${userToken(TEST_USERNAME)}`);

        expect(res.status).toBe(404);
    });

    it('denies history access with 403 PERMISSION_DENIED when the caller lacks stack:read', async () => {
        // Every shipped role carries stack:read, so the denial path is exercised
        // by temporarily removing it from viewer at runtime. This proves the
        // permission check that was previously entirely absent from this route
        // actually runs.
        const defaultNodeId = DatabaseService.getInstance().getDefaultNode()?.id ?? 1;
        const policy = makePolicy(defaultNodeId, 'history-perm-gate-stack');
        const original = ROLE_PERMISSIONS.viewer;
        ROLE_PERMISSIONS.viewer = original.filter((p) => p !== 'stack:read');
        try {
            const res = await request(app)
                .get(`/api/auto-heal/policies/${policy.id}/history`)
                .set('Authorization', `Bearer ${userToken('route-viewer')}`);

            expect(res.status).toBe(403);
            expect(res.body.code).toBe('PERMISSION_DENIED');
        } finally {
            ROLE_PERMISSIONS.viewer = original;
        }
    });

    it('returns 404 for a wrong-node policy id before the permission check runs', async () => {
        // A viewer lacks stack:edit, so if the permission check ran before the
        // node-ownership check, this would 403 PERMISSION_DENIED instead of 404.
        const secondNodeId = insertLegacyLocal('ordering-second-local');
        const policy = makePolicy(secondNodeId, 'ordering-stack');

        const patchRes = await request(app)
            .patch(`/api/auto-heal/policies/${policy.id}`)
            .set('Authorization', `Bearer ${userToken('route-viewer')}`)
            .send({ enabled: 0 });
        expect(patchRes.status).toBe(404);

        const deleteRes = await request(app)
            .delete(`/api/auto-heal/policies/${policy.id}`)
            .set('Authorization', `Bearer ${userToken('route-viewer')}`);
        expect(deleteRes.status).toBe(404);
    });

    it('persists enabled toggles through the patch route', async () => {
        const defaultNodeId = DatabaseService.getInstance().getDefaultNode()?.id ?? 1;
        const policy = makePolicy(defaultNodeId, 'toggle-stack');

        const res = await request(app)
            .patch(`/api/auto-heal/policies/${policy.id}`)
            .set('Authorization', `Bearer ${userToken(TEST_USERNAME)}`)
            .send({ enabled: 0 });

        expect(res.status).toBe(200);
        expect(res.body.enabled).toBe(0);
        expect(DatabaseService.getInstance().getAutoHealPolicy(policy.id!)?.enabled).toBe(0);
    });

    it('allows read-only API tokens to list but not mutate policies', async () => {
        const token = createApiToken('read-only');

        const getRes = await request(app)
            .get('/api/auto-heal/policies')
            .set('Authorization', `Bearer ${token}`);
        const postRes = await request(app)
            .post('/api/auto-heal/policies')
            .set('Authorization', `Bearer ${token}`)
            .send({ stack_name: 'api-token-stack', unhealthy_duration_mins: 5 });

        expect(getRes.status).toBe(200);
        expect(postRes.status).toBe(403);
        expect(postRes.body.code).toBe('SCOPE_DENIED');
    });

    it('returns 503 for disconnected remote auto-heal requests before local routes run', async () => {
        const remoteNodeId = DatabaseService.getInstance().addNode({
            name: 'disconnected-remote',
            type: 'remote',
            compose_dir: '',
            is_default: false,
            api_url: '',
            api_token: '',
        });

        const res = await request(app)
            .get('/api/auto-heal/policies')
            .set('Authorization', `Bearer ${userToken(TEST_USERNAME)}`)
            .set('x-node-id', String(remoteNodeId));

        expect(res.status).toBe(503);
        expect(res.body.error).toContain('has no API URL or token');
    });
});
