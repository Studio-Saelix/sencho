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
let SecretVersionConflictError: typeof import('../services/DatabaseService').SecretVersionConflictError;
let SecretsService: typeof import('../services/SecretsService').SecretsService;
let parseEnv: typeof import('../services/SecretsService').parseEnv;

function adminToken(): string {
    const db = DatabaseService.getInstance();
    const user = db.getUserByUsername(TEST_USERNAME)!;
    return jwt.sign({ username: TEST_USERNAME, role: 'admin', tv: user.token_version }, TEST_JWT_SECRET, { expiresIn: '1m' });
}

function secondAdminToken(): string {
    const db = DatabaseService.getInstance();
    let user = db.getUserByUsername('masked-admin-two');
    if (!user) {
        db.addUser({ username: 'masked-admin-two', password_hash: 'x', role: 'admin' });
        user = db.getUserByUsername('masked-admin-two')!;
    }
    return jwt.sign({ username: 'masked-admin-two', role: 'admin', tv: user.token_version }, TEST_JWT_SECRET, { expiresIn: '1m' });
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
    ({ DatabaseService, SecretVersionConflictError } = await import('../services/DatabaseService'));
    ({ SecretsService, parseEnv } = await import('../services/SecretsService'));
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
        const grant = await request(app)
            .post(`/api/secrets/${bundleId}/reveal-grant`)
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ key: 'API_KEY' });
        expect(grant.headers['cache-control']).toBe('no-store');
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
        expect(created.expiresAt - Date.now()).toBeGreaterThan(25_000);
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

    it('refuses a grant redeemed by a different admin account', async () => {
        const created = await grant('API_KEY');
        const res = await request(app)
            .post(`/api/secrets/${bundleId}/reveal`)
            .set('Authorization', `Bearer ${secondAdminToken()}`)
            .send({ grantId: created.grantId });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('REVEAL_MISMATCH');
        expect(JSON.stringify(res.body)).not.toContain('super-secret-api');
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

    it('refuses a rename onto a key that already exists, leaving both values intact', async () => {
        const res = await patch({ expectedVersion: 1, ops: [{ op: 'rename', from: 'API_KEY', to: 'DB_PASSWORD' }] });
        expect(res.status).toBe(400);
        expect(SecretsService.getInstance().getDecryptedKv(bundleId)).toEqual({
            API_KEY: 'super-secret-api',
            DB_PASSWORD: 'hunter2',
        });
    });

    it('refuses a rename from a key that is not there', async () => {
        const res = await patch({ expectedVersion: 1, ops: [{ op: 'rename', from: 'NOPE', to: 'OTHER' }] });
        expect(res.status).toBe(400);
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

    it('refuses a description-only change based on a stale version', async () => {
        expect((await patch({ expectedVersion: 1, ops: [{ op: 'set', key: 'API_KEY', value: 'first' }] })).status).toBe(200);
        const stale = await patch({ expectedVersion: 1, description: 'late description', ops: [] });
        expect(stale.status).toBe(409);
        expect(SecretsService.getInstance().getDetail(bundleId)!.description).toBe('api and db credentials');
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

describe('the version guard holds inside the write transaction', () => {
    it('refuses a stale updateSecretWithVersion after the bundle has moved on', () => {
        const db = DatabaseService.getInstance();
        expect(() => db.updateSecretWithVersion({
            secretId: bundleId,
            description: null,
            encryptedPayload: 'enc:whatever',
            keyCount: 1,
            createdBy: TEST_USERNAME,
            note: '',
            expectedVersion: 99,
        })).toThrow(SecretVersionConflictError);
    });

    it('refuses a stale updateSecretDescription', () => {
        const db = DatabaseService.getInstance();
        expect(() => db.updateSecretDescription({
            secretId: bundleId,
            description: 'late',
            expectedVersion: 99,
        })).toThrow(SecretVersionConflictError);
        expect(SecretsService.getInstance().getDetail(bundleId)!.description).toBe('api and db credentials');
    });
});

describe('an unreadable stored payload is an error, never an empty bundle', () => {
    function corruptPayload(value: string): void {
        DatabaseService.getInstance().getDb()
            .prepare('UPDATE secret_versions SET encrypted_payload = ? WHERE secret_id = ?')
            .run(value, bundleId);
    }

    it('answers 500 with a specific code on a non-encrypted payload', async () => {
        corruptPayload('{"API_KEY":"leaked"}');
        const read = await request(app)
            .get(`/api/secrets/${bundleId}`)
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(read.status).toBe(500);
        expect(read.body.code).toBe('SECRET_PAYLOAD_UNREADABLE');
        expect(JSON.stringify(read.body)).not.toContain('leaked');
    });

    it('answers 500 on ciphertext that cannot be decrypted', async () => {
        corruptPayload('enc:00112233:44556677:aabbcc');
        const read = await request(app)
            .get(`/api/secrets/${bundleId}`)
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(read.status).toBe(500);
        expect(read.body.code).toBe('SECRET_PAYLOAD_UNREADABLE');
    });

    it('refuses a patch rather than overwriting the unreadable bundle', async () => {
        corruptPayload('enc:00112233:44556677:aabbcc');
        const res = await request(app)
            .patch(`/api/secrets/${bundleId}`)
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ expectedVersion: 1, ops: [{ op: 'set', key: 'C', value: 'c' }] });
        expect(res.status).toBe(500);
        expect(res.body.code).toBe('SECRET_PAYLOAD_UNREADABLE');
        const row = DatabaseService.getInstance().getSecret(bundleId)!;
        expect(row.current_version).toBe(1);
        expect(DatabaseService.getInstance().listSecretVersions(bundleId)).toHaveLength(1);
    });

    it('treats an empty stored payload as unreadable, not as an empty bundle', async () => {
        corruptPayload('');
        const read = await request(app)
            .get(`/api/secrets/${bundleId}`)
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(read.status).toBe(500);
        expect(read.body.code).toBe('SECRET_PAYLOAD_UNREADABLE');
        const patch = await request(app)
            .patch(`/api/secrets/${bundleId}`)
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ expectedVersion: 1, ops: [{ op: 'set', key: 'C', value: 'c' }] });
        expect(patch.status).toBe(500);
        expect(DatabaseService.getInstance().getSecret(bundleId)!.current_version).toBe(1);
    });

    it('refuses a reveal grant rather than blaming the key', async () => {
        corruptPayload('enc:00112233:44556677:aabbcc');
        const res = await request(app)
            .post(`/api/secrets/${bundleId}/reveal-grant`)
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ key: 'API_KEY' });
        expect(res.status).toBe(500);
        expect(res.body.code).toBe('SECRET_PAYLOAD_UNREADABLE');
    });
});

describe('an import source that does not exist is reported, not read as empty', () => {
    it('404s a preview for a stack that is not there', async () => {
        const localNode = DatabaseService.getInstance().getNodes().find(n => n.type === 'local')!;
        const res = await request(app)
            .post(`/api/secrets/${bundleId}/import-from-stack/preview`)
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ nodeId: localNode.id, stackName: 'no-such-stack', envFileBasename: '.env' });
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('IMPORT_SOURCE_NOT_FOUND');
    });

    it('404s an apply for a stack that is not there and mints no version', async () => {
        const localNode = DatabaseService.getInstance().getNodes().find(n => n.type === 'local')!;
        const res = await request(app)
            .post(`/api/secrets/${bundleId}/import-from-stack`)
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({
                nodeId: localNode.id,
                stackName: 'no-such-stack',
                envFileBasename: '.env',
                expectedVersion: 1,
                expectedFingerprint: 'a'.repeat(64),
            });
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('IMPORT_SOURCE_NOT_FOUND');
        expect(SecretsService.getInstance().getDetail(bundleId)!.currentVersion).toBe(1);
    });

    it('refuses an apply whose source changed after the preview', async () => {
        const composeDir = process.env.COMPOSE_DIR!;
        const stackDir = path.join(composeDir, 'moving-import');
        fs.mkdirSync(stackDir, { recursive: true });
        fs.writeFileSync(path.join(stackDir, '.env'), 'FIRST=one\n');
        fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  app:\n    image: nginx\n');
        const localNode = DatabaseService.getInstance().getNodes().find(n => n.type === 'local')!;

        const preview = await request(app)
            .post(`/api/secrets/${bundleId}/import-from-stack/preview`)
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ nodeId: localNode.id, stackName: 'moving-import', envFileBasename: '.env' });
        expect(preview.status).toBe(200);
        expect(preview.body.fingerprint).toMatch(/^[a-f0-9]{64}$/);

        fs.writeFileSync(path.join(stackDir, '.env'), 'FIRST=one\nSNUCK_IN=two\n');
        const apply = await request(app)
            .post(`/api/secrets/${bundleId}/import-from-stack`)
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({
                nodeId: localNode.id,
                stackName: 'moving-import',
                envFileBasename: '.env',
                expectedVersion: 1,
                expectedFingerprint: preview.body.fingerprint,
            });
        expect(apply.status).toBe(409);
        expect(apply.body.code).toBe('IMPORT_SOURCE_CHANGED');
        expect(SecretsService.getInstance().getDecryptedKv(bundleId)).toEqual({
            API_KEY: 'super-secret-api',
            DB_PASSWORD: 'hunter2',
        });
        expect(DatabaseService.getInstance().getSecret(bundleId)!.current_version).toBe(1);
    });

    it('applies an import that presents the previewed fingerprint', async () => {
        const composeDir = process.env.COMPOSE_DIR!;
        const stackDir = path.join(composeDir, 'steady-import');
        fs.mkdirSync(stackDir, { recursive: true });
        fs.writeFileSync(path.join(stackDir, '.env'), 'STABLE=value\n');
        fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  app:\n    image: nginx\n');
        const localNode = DatabaseService.getInstance().getNodes().find(n => n.type === 'local')!;

        const preview = await request(app)
            .post(`/api/secrets/${bundleId}/import-from-stack/preview`)
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ nodeId: localNode.id, stackName: 'steady-import', envFileBasename: '.env' });
        const apply = await request(app)
            .post(`/api/secrets/${bundleId}/import-from-stack`)
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({
                nodeId: localNode.id,
                stackName: 'steady-import',
                envFileBasename: '.env',
                expectedVersion: 1,
                expectedFingerprint: preview.body.fingerprint,
            });
        expect(apply.status).toBe(200);
        expect(apply.body.added).toBe(1);
        expect(SecretsService.getInstance().getDecryptedKv(bundleId).STABLE).toBe('value');
    });

    it('404s an import from a node that is not in the fleet', async () => {
        const res = await request(app)
            .post(`/api/secrets/${bundleId}/import-from-stack/preview`)
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ nodeId: 99999, stackName: 'anything', envFileBasename: '.env' });
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('IMPORT_SOURCE_NOT_FOUND');
    });
});

describe('hostile key names and escape attempts are refused', () => {
    it('refuses a prototype key on set, remove, or rename', async () => {
        for (const op of [
            { op: 'set', key: '__proto__', value: 'polluted' },
            { op: 'remove', key: '__proto__' },
            { op: 'rename', from: 'API_KEY', to: '__proto__' },
        ]) {
            const res = await request(app)
                .patch(`/api/secrets/${bundleId}`)
                .set('Authorization', `Bearer ${adminToken()}`)
                .send({ expectedVersion: 1, ops: [op] });
            expect(res.status).toBe(400);
        }
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect(SecretsService.getInstance().getDecryptedKv(bundleId)).toEqual({
            API_KEY: 'super-secret-api',
            DB_PASSWORD: 'hunter2',
        });
    });

    it('keeps a prototype-shaped key from an env file as data', () => {
        const kv = parseEnv('__proto__=stored\nNORMAL=value\n');
        expect(Object.keys(kv).sort()).toEqual(['NORMAL', '__proto__']);
        expect(kv['__proto__']).toBe('stored');
        expect(({} as Record<string, unknown>).stored).toBeUndefined();
    });

    it('refuses an env file path that escapes the compose root', async () => {
        const composeDir = process.env.COMPOSE_DIR!;
        const stackDir = path.join(composeDir, 'escape-import');
        fs.mkdirSync(stackDir, { recursive: true });
        fs.writeFileSync(
            path.join(stackDir, 'compose.yaml'),
            'services:\n  app:\n    image: nginx\n    env_file:\n      - ../../outside.env\n',
        );
        fs.writeFileSync(path.join(composeDir, '..', 'outside.env'), 'STOLEN=value\n');
        const localNode = DatabaseService.getInstance().getNodes().find(n => n.type === 'local')!;

        const res = await request(app)
            .post(`/api/secrets/${bundleId}/import-from-stack/preview`)
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ nodeId: localNode.id, stackName: 'escape-import', envFileBasename: 'outside.env' });
        expect(res.status).toBe(404);
        expect(JSON.stringify(res.body)).not.toContain('STOLEN');
    });

    it('keeps a stored env key named like a prototype slot as data', () => {
        const kv: Record<string, string> = {};
        Object.defineProperty(kv, '__proto__', { value: 'stored', enumerable: true, writable: true, configurable: true });
        const { id } = SecretsService.getInstance().create({
            name: 'prototype-key-bundle',
            kv,
            user: TEST_USERNAME,
        });
        expect(SecretsService.getInstance().getDecryptedKv(id)).toEqual(kv);
        expect(({} as Record<string, unknown>).stored).toBeUndefined();
    });
});
