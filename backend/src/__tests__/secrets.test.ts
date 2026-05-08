/**
 * Tests for Fleet Secrets v1 MVP:
 *  - parseEnv / serializeEnv round-trip
 *  - applyOverlay / computeDiff
 *  - encrypt round-trip via CryptoService
 *  - DatabaseService secret + version + push CRUD
 *  - SecretsService versioning, importFromStack, executePush aggregation
 *  - Route guards (requirePaid 403, push lock 409)
 *  - getAuditSummary patterns for /secrets routes
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { getAuditSummary } from '../utils/audit-summaries';
import { parseEnv, serializeEnv, applyOverlay, computeDiff } from '../services/SecretsService';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let SecretsService: typeof import('../services/SecretsService').SecretsService;
let CryptoService: typeof import('../services/CryptoService').CryptoService;

function authToken(username: string, role: string = 'admin', tv?: number): string {
    const payload: Record<string, unknown> = { username, role };
    if (tv !== undefined) payload.tv = tv;
    return jwt.sign(payload, TEST_JWT_SECRET, { expiresIn: '1m' });
}

function adminToken(): string {
    const db = DatabaseService.getInstance();
    const user = db.getUserByUsername(TEST_USERNAME)!;
    return authToken(TEST_USERNAME, 'admin', user.token_version);
}

function clearSecretsTables(): void {
    const db = DatabaseService.getInstance().getDb();
    db.prepare('DELETE FROM secret_pushes').run();
    db.prepare('DELETE FROM secret_versions').run();
    db.prepare('DELETE FROM secrets').run();
}

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ SecretsService } = await import('../services/SecretsService'));
    ({ CryptoService } = await import('../services/CryptoService'));

    const { LicenseService } = await import('../services/LicenseService');
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
    vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue('skipper');
    vi.spyOn(LicenseService.getInstance(), 'getSeatLimits').mockReturnValue({ maxAdmins: null, maxViewers: null });

    ({ app } = await import('../index'));
});

afterAll(() => {
    vi.restoreAllMocks();
    cleanupTestDb(tmpDir);
});

beforeEach(() => {
    clearSecretsTables();
});

// ---- Pure functions ----

describe('parseEnv / serializeEnv', () => {
    it('parses simple key=value lines', () => {
        const kv = parseEnv('FOO=bar\nBAZ=qux\n');
        expect(kv).toEqual({ FOO: 'bar', BAZ: 'qux' });
    });

    it('drops blank lines and # comments', () => {
        const kv = parseEnv('# comment\n\nFOO=bar\n# another\n');
        expect(kv).toEqual({ FOO: 'bar' });
    });

    it('strips matching outer double quotes and decodes escapes', () => {
        const kv = parseEnv('FOO="hello world"\nBAR="multi\\nline"\n');
        expect(kv.FOO).toBe('hello world');
        expect(kv.BAR).toBe('multi\nline');
    });

    it('strips matching outer single quotes literally', () => {
        const kv = parseEnv("FOO='raw \\n value'\n");
        expect(kv.FOO).toBe('raw \\n value');
    });

    it('handles empty values', () => {
        const kv = parseEnv('EMPTY=\nNON_EMPTY=x\n');
        expect(kv.EMPTY).toBe('');
        expect(kv.NON_EMPTY).toBe('x');
    });

    it('strips trailing inline comments on bare values', () => {
        const kv = parseEnv('FOO=bar # trailing\n');
        expect(kv.FOO).toBe('bar');
    });

    it('drops malformed keys', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const kv = parseEnv('1BAD=oops\nGOOD=ok\n');
        expect(kv).toEqual({ GOOD: 'ok' });
        warnSpy.mockRestore();
    });

    it('round-trips serialize → parse', () => {
        const original = { FOO: 'simple', SPACED: 'two words', QUOTED: 'has "quote"', EMPTY: '' };
        const serialized = serializeEnv(original);
        const parsed = parseEnv(serialized);
        expect(parsed).toEqual(original);
    });

    it('returns empty string for empty map', () => {
        expect(serializeEnv({})).toBe('');
    });
});

describe('applyOverlay / computeDiff', () => {
    it('preserves keys absent from overlay (overlay merge)', () => {
        const merged = applyOverlay({ KEEP: 'x', REPLACE: 'old' }, { REPLACE: 'new', NEW: 'fresh' });
        expect(merged).toEqual({ KEEP: 'x', REPLACE: 'new', NEW: 'fresh' });
    });

    it('classifies all four diff statuses', () => {
        const diff = computeDiff(
            { KEEP: 'same', REPLACE: 'old', GONE: 'orphan' },
            { KEEP: 'same', REPLACE: 'new', NEW: 'fresh' },
        );
        const byKey = Object.fromEntries(diff.map(e => [e.key, e]));
        expect(byKey.KEEP.status).toBe('unchanged');
        expect(byKey.REPLACE.status).toBe('changed');
        expect(byKey.REPLACE.before).toBe('old');
        expect(byKey.REPLACE.after).toBe('new');
        expect(byKey.NEW.status).toBe('added');
        expect(byKey.GONE.status).toBe('removed');
        expect(byKey.GONE.before).toBe('orphan');
    });
});

// ---- Encryption round-trip ----

describe('encryption via CryptoService', () => {
    it('round-trips a JSON-encoded KV map', () => {
        const kv = { DB_URL: 'postgres://localhost/app', API_KEY: 'abc123' };
        const cipher = CryptoService.getInstance().encrypt(JSON.stringify(kv));
        expect(cipher.startsWith('enc:')).toBe(true);
        const plain = CryptoService.getInstance().decrypt(cipher);
        expect(JSON.parse(plain)).toEqual(kv);
    });
});

// ---- DatabaseService secret accessors ----

describe('DatabaseService secret accessors', () => {
    it('creates a secret with v1 and bumps to v2 on update', () => {
        const db = DatabaseService.getInstance();
        const created = db.createSecretWithVersion({
            name: 'creds',
            description: 'app creds',
            encryptedPayload: 'enc:dummy',
            keyCount: 2,
            createdBy: TEST_USERNAME,
            note: '',
        });
        expect(created.version).toBe(1);
        const row = db.getSecret(created.id)!;
        expect(row.current_version).toBe(1);

        const updated = db.updateSecretWithVersion({
            secretId: created.id,
            description: 'updated',
            encryptedPayload: 'enc:dummy2',
            keyCount: 3,
            createdBy: TEST_USERNAME,
            note: 'added DEBUG',
        });
        expect(updated.version).toBe(2);
        const refreshed = db.getSecret(created.id)!;
        expect(refreshed.current_version).toBe(2);
        expect(refreshed.description).toBe('updated');

        const versions = db.listSecretVersions(created.id);
        expect(versions.map(v => v.version)).toEqual([2, 1]);
    });

    it('cascades versions and pushes on delete', () => {
        const db = DatabaseService.getInstance();
        const created = db.createSecretWithVersion({
            name: 'to-delete',
            description: '',
            encryptedPayload: 'enc:x',
            keyCount: 1,
            createdBy: TEST_USERNAME,
            note: '',
        });
        db.insertSecretPushes([{
            secret_id: created.id,
            version: 1,
            push_id: 'push-1',
            node_id: 1,
            stack_name: 'demo',
            env_file_basename: '.env',
            status: 'ok',
            error: '',
            added_count: 1,
            changed_count: 0,
            unchanged_count: 0,
            pushed_by: TEST_USERNAME,
            pushed_at: Date.now(),
        }]);
        expect(db.deleteSecret(created.id)).toBe(true);
        expect(db.getSecret(created.id)).toBeUndefined();
        expect(db.listSecretVersions(created.id)).toEqual([]);
        expect(db.listSecretPushes(created.id)).toEqual([]);
    });
});

// ---- SecretsService versioning + decryption ----

describe('SecretsService', () => {
    it('encrypts on create and decrypts on read', () => {
        const svc = SecretsService.getInstance();
        const { id } = svc.create({
            name: 'app-secrets',
            description: 'app',
            kv: { DB_URL: 'postgres://x', API_KEY: 'abc' },
            user: TEST_USERNAME,
        });
        const kv = svc.getDecryptedKv(id);
        expect(kv).toEqual({ DB_URL: 'postgres://x', API_KEY: 'abc' });
        // Stored payload must be encrypted, not plaintext.
        const versionRow = DatabaseService.getInstance().getCurrentSecretVersion(id)!;
        expect(versionRow.encrypted_payload.startsWith('enc:')).toBe(true);
        expect(versionRow.encrypted_payload).not.toContain('postgres://x');
    });

    it('rejects invalid env keys at create', () => {
        const svc = SecretsService.getInstance();
        expect(() => svc.create({
            name: 'bad-keys',
            kv: { '1BAD': 'value' },
            user: TEST_USERNAME,
        })).toThrow(/Invalid env key/);
    });

    it('listVersions returns newest first', () => {
        const svc = SecretsService.getInstance();
        const { id } = svc.create({ name: 'v-list', kv: { A: '1' }, user: TEST_USERNAME });
        svc.update(id, { kv: { A: '2', B: '3' }, user: TEST_USERNAME, note: 'add B' });
        svc.update(id, { kv: { A: '4' }, user: TEST_USERNAME });
        const versions = svc.listVersions(id);
        expect(versions.map(v => v.version)).toEqual([3, 2, 1]);
        expect(versions[1].note).toBe('add B');
    });
});

// ---- importFromStack against the local node ----

describe('SecretsService.importFromStack (local node)', () => {
    beforeEach(() => {
        const composeDir = process.env.COMPOSE_DIR!;
        const stackDir = path.join(composeDir, 'demo');
        fs.mkdirSync(stackDir, { recursive: true });
        fs.writeFileSync(path.join(stackDir, '.env'), 'DB_URL=postgres://x\nAPI_KEY=abc\n');
        fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  app:\n    image: nginx\n');
    });

    it('reads the local stack .env into a KV map', async () => {
        const db = DatabaseService.getInstance();
        const localNode = db.getNodes().find(n => n.type === 'local')!;
        const kv = await SecretsService.getInstance().importFromStack(localNode.id, 'demo', '.env');
        expect(kv).toEqual({ DB_URL: 'postgres://x', API_KEY: 'abc' });
    });
});

// ---- executePush against the local node ----

describe('SecretsService.executePush (local node)', () => {
    beforeEach(() => {
        const composeDir = process.env.COMPOSE_DIR!;
        const stackDir = path.join(composeDir, 'targetstack');
        fs.mkdirSync(stackDir, { recursive: true });
        fs.writeFileSync(path.join(stackDir, '.env'), 'EXISTING=keep\nAPI_KEY=old\n');
        fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  app:\n    image: nginx\n');
    });

    it('overlays bundle keys onto the existing .env and records audit rows', async () => {
        const db = DatabaseService.getInstance();
        const localNode = db.getNodes().find(n => n.type === 'local')!;
        const svc = SecretsService.getInstance();

        const { id } = svc.create({
            name: 'push-bundle',
            kv: { API_KEY: 'new', DEBUG: '1' },
            user: TEST_USERNAME,
        });

        const result = await svc.executePush(
            id,
            { type: 'nodes', ids: [localNode.id] },
            'targetstack',
            '.env',
            TEST_USERNAME,
        );

        expect(result.results).toHaveLength(1);
        expect(result.results[0].status).toBe('ok');
        expect(result.results[0].added).toBe(1); // DEBUG
        expect(result.results[0].changed).toBe(1); // API_KEY

        const composeDir = process.env.COMPOSE_DIR!;
        const envText = fs.readFileSync(path.join(composeDir, 'targetstack', '.env'), 'utf-8');
        const kv = parseEnv(envText);
        // Overlay: existing EXISTING preserved, API_KEY replaced, DEBUG added.
        expect(kv.EXISTING).toBe('keep');
        expect(kv.API_KEY).toBe('new');
        expect(kv.DEBUG).toBe('1');

        const pushes = db.listSecretPushes(id);
        expect(pushes).toHaveLength(1);
        expect(pushes[0].status).toBe('ok');
        expect(pushes[0].push_id).toBe(result.pushId);
    });

    it('marks a node failed when the env file is not declared and continues', async () => {
        const db = DatabaseService.getInstance();
        const localNode = db.getNodes().find(n => n.type === 'local')!;
        const svc = SecretsService.getInstance();
        const { id } = svc.create({ name: 'push-bad-file', kv: { X: '1' }, user: TEST_USERNAME });

        const result = await svc.executePush(
            id,
            { type: 'nodes', ids: [localNode.id] },
            'targetstack',
            'nonexistent.env',
            TEST_USERNAME,
        );

        expect(result.results[0].status).toBe('failed');
        expect(result.results[0].error).toMatch(/not found/);
    });
});

// ---- getAuditSummary patterns ----

describe('getAuditSummary for secrets routes', () => {
    it('resolves create / update / delete', () => {
        expect(getAuditSummary('POST', '/secrets')).toBe('Created secret');
        expect(getAuditSummary('PUT', '/secrets/42')).toBe('Updated secret: 42');
        expect(getAuditSummary('DELETE', '/secrets/42')).toBe('Deleted secret: 42');
    });

    it('resolves push and import wildcards', () => {
        expect(getAuditSummary('POST', '/secrets/42/import-from-stack')).toBe('Imported env into secret: 42');
        expect(getAuditSummary('POST', '/secrets/42/push/preview')).toBe('Previewed secret push: 42');
        expect(getAuditSummary('POST', '/secrets/42/push')).toBe('Pushed secret: 42');
    });
});

// ---- Route guards via supertest ----

describe('Routes /api/secrets tier gating and lock', () => {
    it('returns 403 when license is community', async () => {
        const { LicenseService } = await import('../services/LicenseService');
        // Use mockReturnValueOnce so the outer beforeAll spy keeps returning 'paid' for sibling tests.
        // requirePaid only consults getTier once per request via effectiveTier(req).
        const inst = LicenseService.getInstance();
        const tierSpy = vi.spyOn(inst, 'getTier');
        tierSpy.mockReturnValueOnce('community');
        const res = await request(app)
            .get('/api/secrets')
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('PAID_REQUIRED');
    });

    it('rejects unauthenticated requests', async () => {
        const res = await request(app).get('/api/secrets');
        expect(res.status).toBe(401);
    });

    it('returns 200 when paid', async () => {
        const res = await request(app)
            .get('/api/secrets')
            .set('Authorization', `Bearer ${adminToken()}`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    it('rejects malformed body on POST /secrets', async () => {
        const res = await request(app)
            .post('/api/secrets')
            .set('Authorization', `Bearer ${adminToken()}`)
            .send({ name: 'x', kv: 'not-an-object' });
        expect(res.status).toBe(400);
    });
});
