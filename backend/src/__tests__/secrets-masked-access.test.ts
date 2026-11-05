/**
 * Fleet Secrets: masked-by-default bundle access, single-use per-value reveal,
 * and per-key writes that preserve values the caller never saw.
 *
 * Covers the API contract the bundle editor, push preview, and import rely on:
 *  - detail reads carry key names only, never a value, current or historical;
 *  - a reveal needs a grant bound to one bundle version and key, and the grant
 *    is single use and short lived;
 *  - a per-key patch cannot erase or overwrite an untouched hidden value, and a
 *    stale expectedVersion is refused;
 *  - push previews and import previews carry change classes, not values;
 *  - every secret route is no-store and rejects machine credentials.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let SecretsService: typeof import('../services/SecretsService').SecretsService;

function adminToken(): string {
    const db = DatabaseService.getInstance();
    const user = db.getUserByUsername(TEST_USERNAME)!;
    return jwt.sign({ username: TEST_USERNAME, role: 'admin', tv: user.token_version }, TEST_JWT_SECRET, { expiresIn: '1m' });
}

function viewerToken(): string {
    const db = DatabaseService.getInstance();
    let user = db.getUserByUsername('masked-viewer');
    if (!user) {
        db.addUser({ username: 'masked-viewer', password_hash: 'x', role: 'viewer' });
        user = db.getUserByUsername('masked-viewer')!;
    }
    return jwt.sign({ username: 'masked-viewer', role: 'viewer', tv: user.token_version }, TEST_JWT_SECRET, { expiresIn: '1m' });
}

function clearSecretsTables(): void {
    const db = DatabaseService.getInstance().getDb();
    db.prepare('DELETE FROM secret_pushes').run();
    db.prepare('DELETE FROM secret_versions').run();
    db.prepare('DELETE FROM secrets').run();
}

let bundleId: number;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ SecretsService } = await import('../services/SecretsService'));
    ({ app } = await import('../index'));
});

afterAll(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    cleanupTestDb(tmpDir);
});

beforeEach(() => {
    clearSecretsTables();
    SecretsService.getInstance().clearRevealGrants();
    const created = SecretsService.getInstance().create({
        name: 'masked-bundle',
        description: 'api and db credentials',
        kv: { API_KEY: 'super-secret-api', DB_PASSWORD: 'hunter2' },
        user: TEST_USERNAME,
    });
    bundleId = created.id;
});

describe('GET /api/secrets/:id masks values by default', () => {
    it('returns key names, metadata, and a fixed mask', async () => {
        const res = await request(app)
            .get(`/api/secrets/${bundleId}`)
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(res.status).toBe(200);
        expect(res.body.keys).toEqual([
            { key: 'API_KEY', masked: '••••••••' },
            { key: 'DB_PASSWORD', masked: '••••••••' },
        ]);
        expect(res.body.masked).toBe(true);
        expect(res.body.currentVersion).toBe(1);
        const body = JSON.stringify(res.body);
        expect(body).not.toContain('super-secret-api');
        expect(body).not.toContain('hunter2');
        expect(res.body.kv).toBeUndefined();
    });

    it('never puts a value in the version list', async () => {
        const res = await request(app)
            .get(`/api/secrets/${bundleId}/versions`)
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toContain('hunter2');
    });

    it('sends no-store so no cache keeps a payload', async () => {
        const res = await request(app)
            .get(`/api/secrets/${bundleId}`)
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(res.headers['cache-control']).toBe('no-store');
    });
});

describe('reveal is bound, single use, and short lived', () => {
    async function grant(key: string, version?: number): Promise<{ grantId: string; expiresAt: number; version: number }> {
        const res = await request(app)
            .post(`/api/secrets/${bundleId}/reveal-grant`)
            .set('Authorization', `Bearer ${adminToken()}`)
            .send(version === undefined ? { key } : { key, version });
        expect(res.status).toBe(200);
        return res.body;
    }

    async function consume(grantId: string, id = bundleId): Promise<request.Response> {
        return request(app)
            .post(`/api/secrets/${id}/reveal`)
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ grantId });
    }

    it('reveals exactly one key for a bounded window', async () => {
        const created = await grant('DB_PASSWORD');
        expect(created.expiresAt - Date.now()).toBeLessThanOrEqual(30_000);
        const res = await consume(created.grantId);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            key: 'DB_PASSWORD',
            version: 1,
            value: 'hunter2',
            expiresAt: created.expiresAt,
        });
        expect(res.headers['cache-control']).toBe('no-store');
    });

    it('refuses a replay of the same grant', async () => {
        const created = await grant('API_KEY');
        expect((await consume(created.grantId)).status).toBe(200);
        const replay = await consume(created.grantId);
        expect(replay.status).toBe(403);
        expect(replay.body.code).toBe('REVEAL_GRANT_INVALID');
        expect(JSON.stringify(replay.body)).not.toContain('super-secret-api');
    });

    it('refuses an unknown grant without naming a value', async () => {
        const res = await consume('not-a-real-grant-token-value');
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('REVEAL_GRANT_INVALID');
    });

    it('refuses an expired grant', async () => {
        const created = await grant('API_KEY');
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date(Date.now() + 31_000));
            const res = await consume(created.grantId);
            expect(res.status).toBe(403);
            expect(res.body.code).toBe('REVEAL_EXPIRED');
        } finally {
            vi.useRealTimers();
        }
    });

    it('refuses a grant minted for a different bundle', async () => {
        const other = SecretsService.getInstance().create({
            name: 'other-bundle',
            kv: { OTHER: 'other-value' },
            user: TEST_USERNAME,
        });
        const created = await grant('API_KEY');
        const res = await consume(created.grantId, other.id);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('REVEAL_MISMATCH');
    });

    it('404s a key that is not in the bundle', async () => {
        const res = await request(app)
            .post(`/api/secrets/${bundleId}/reveal-grant`)
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ key: 'NOPE' });
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('REVEAL_TARGET_MISSING');
    });

    it('reveals a historical version, not just the current one', async () => {
        SecretsService.getInstance().applyPatch(bundleId, {
            expectedVersion: 1,
            ops: [{ op: 'set', key: 'API_KEY', value: 'rotated-api' }],
            user: TEST_USERNAME,
        });
        const created = await grant('API_KEY', 1);
        expect(created.version).toBe(1);
        const res = await consume(created.grantId);
        expect(res.status).toBe(200);
        expect(res.body.value).toBe('super-secret-api');
    });
});

describe('PATCH /api/secrets/:id writes one key and keeps the rest', () => {
    async function patch(body: Record<string, unknown>): Promise<request.Response> {
        return request(app)
            .patch(`/api/secrets/${bundleId}`)
            .set('Authorization', `Bearer ${adminToken()}`)
            .send(body);
    }

    it('replaces one value and preserves the hidden one', async () => {
        const res = await patch({ expectedVersion: 1, ops: [{ op: 'set', key: 'API_KEY', value: 'new-api' }] });
        expect(res.status).toBe(200);
        expect(res.body.version).toBe(2);
        expect(SecretsService.getInstance().getDecryptedKv(bundleId)).toEqual({
            API_KEY: 'new-api',
            DB_PASSWORD: 'hunter2',
        });
    });

    it('renames a key without the caller ever seeing its value', async () => {
        const res = await patch({ expectedVersion: 1, ops: [{ op: 'rename', from: 'DB_PASSWORD', to: 'DATABASE_PASSWORD' }] });
        expect(res.status).toBe(200);
        expect(SecretsService.getInstance().getDecryptedKv(bundleId)).toEqual({
            API_KEY: 'super-secret-api',
            DATABASE_PASSWORD: 'hunter2',
        });
    });

    it('removes a key on request', async () => {
        const res = await patch({ expectedVersion: 1, ops: [{ op: 'remove', key: 'API_KEY' }] });
        expect(res.status).toBe(200);
        expect(SecretsService.getInstance().getDecryptedKv(bundleId)).toEqual({ DB_PASSWORD: 'hunter2' });
    });

    it('refuses a stale edit and leaves the bundle at the newer version', async () => {
        expect((await patch({ expectedVersion: 1, ops: [{ op: 'set', key: 'API_KEY', value: 'first-writer' }] })).status).toBe(200);
        const stale = await patch({ expectedVersion: 1, ops: [{ op: 'set', key: 'API_KEY', value: 'second-writer' }] });
        expect(stale.status).toBe(409);
        expect(stale.body.code).toBe('VERSION_CONFLICT');
        expect(stale.body.currentVersion).toBe(2);
        expect(SecretsService.getInstance().getDecryptedKv(bundleId)).toEqual({
            API_KEY: 'first-writer',
            DB_PASSWORD: 'hunter2',
        });
    });

    it('rejects an empty or malformed op list', async () => {
        expect((await patch({ expectedVersion: 1, ops: [] })).status).toBe(400);
        expect((await patch({ expectedVersion: 1, ops: [{ op: 'set', key: '1BAD', value: 'x' }] })).status).toBe(400);
        expect((await patch({ expectedVersion: 1, ops: [{ op: 'remove', key: 'MISSING' }] })).status).toBe(400);
    });

    it('requires the version the caller loaded', async () => {
        const res = await patch({ ops: [{ op: 'set', key: 'API_KEY', value: 'x' }] });
        expect(res.status).toBe(400);
    });

    it('updates only the description without minting a version or touching values', async () => {
        const res = await patch({ expectedVersion: 1, description: 'rotated by ops', ops: [] });
        expect(res.status).toBe(200);
        expect(res.body.version).toBe(1);
        const detail = SecretsService.getInstance().getDetail(bundleId)!;
        expect(detail.description).toBe('rotated by ops');
        expect(SecretsService.getInstance().getDecryptedKv(bundleId)).toEqual({
            API_KEY: 'super-secret-api',
            DB_PASSWORD: 'hunter2',
        });
        expect(SecretsService.getInstance().listVersions(bundleId)).toHaveLength(1);
    });

    it('changes the description alongside a value write', async () => {
        const res = await patch({
            expectedVersion: 1,
            description: 'rotated by ops',
            ops: [{ op: 'set', key: 'API_KEY', value: 'super-secret-api' }],
        });
        expect(res.status).toBe(200);
        expect(SecretsService.getInstance().getDetail(bundleId)!.description).toBe('rotated by ops');
        expect(SecretsService.getInstance().getDecryptedKv(bundleId).DB_PASSWORD).toBe('hunter2');
    });

    it('does not expose a full-map write route', async () => {
        const res = await request(app)
            .put(`/api/secrets/${bundleId}`)
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ kv: { ONLY: 'one' } });
        expect(res.status).toBe(404);
        expect(SecretsService.getInstance().getDecryptedKv(bundleId)).toEqual({
            API_KEY: 'super-secret-api',
            DB_PASSWORD: 'hunter2',
        });
    });
});

describe('push and import previews carry change classes only', () => {
    it('omits before/after values from the push preview', async () => {
        const composeDir = process.env.COMPOSE_DIR!;
        const stackDir = path.join(composeDir, 'masked-push');
        fs.mkdirSync(stackDir, { recursive: true });
        fs.writeFileSync(path.join(stackDir, '.env'), 'API_KEY=old-api\nKEEP_ME=kept\n');
        fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  app:\n    image: nginx\n');
        const localNode = DatabaseService.getInstance().getNodes().find(n => n.type === 'local')!;

        const res = await request(app)
            .post(`/api/secrets/${bundleId}/push/preview`)
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ selector: { type: 'nodes', ids: [localNode.id] }, stackName: 'masked-push', envFileBasename: '.env' });
        expect(res.status).toBe(200);
        const entry = res.body[0];
        expect(entry.changed).toBe(1);
        expect(entry.diff).toEqual(expect.arrayContaining([{ key: 'API_KEY', status: 'changed' }]));
        const body = JSON.stringify(res.body);
        expect(body).not.toContain('old-api');
        expect(body).not.toContain('super-secret-api');
        expect(body).not.toContain('kept');
        for (const item of entry.diff as Array<Record<string, unknown>>) {
            expect(item.before).toBeUndefined();
            expect(item.after).toBeUndefined();
        }
    });

    it('omits the env values from the import preview', async () => {
        const composeDir = process.env.COMPOSE_DIR!;
        const stackDir = path.join(composeDir, 'masked-import');
        fs.mkdirSync(stackDir, { recursive: true });
        fs.writeFileSync(path.join(stackDir, '.env'), 'STACK_ONLY=stack-value\nAPI_KEY=stack-api\n');
        fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  app:\n    image: nginx\n');
        const localNode = DatabaseService.getInstance().getNodes().find(n => n.type === 'local')!;

        const res = await request(app)
            .post(`/api/secrets/${bundleId}/import-from-stack/preview`)
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ nodeId: localNode.id, stackName: 'masked-import', envFileBasename: '.env' });
        expect(res.status).toBe(200);
        expect(res.body.keys).toEqual([
            { key: 'API_KEY', status: 'changed' },
            { key: 'STACK_ONLY', status: 'added' },
        ]);
        const body = JSON.stringify(res.body);
        expect(body).not.toContain('stack-value');
        expect(body).not.toContain('stack-api');
    });
});

describe('new routes keep the admin and session boundary', () => {
    it('403s a viewer on the reveal endpoints', async () => {
        for (const p of [`/api/secrets/${bundleId}/reveal-grant`, `/api/secrets/${bundleId}/reveal`]) {
            const res = await request(app)
                .post(p)
                .set('Authorization', `Bearer ${viewerToken()}`)
                .send({ key: 'API_KEY', grantId: 'x'.repeat(24) });
            expect(res.status).toBe(403);
            expect(res.body.code).toBe('ADMIN_REQUIRED');
        }
    });

    it('403s a full-admin API token on the reveal endpoints', async () => {
        const created = await request(app)
            .post('/api/api-tokens')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ name: `masked-reveal-token-${Date.now()}`, scope: 'full-admin' });
        const token = created.body.token as string;
        const res = await request(app)
            .post(`/api/secrets/${bundleId}/reveal-grant`)
            .set('Authorization', `Bearer ${token}`)
            .send({ key: 'API_KEY' });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('SESSION_REQUIRED');
    });
});
