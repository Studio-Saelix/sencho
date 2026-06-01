/**
 * Fleet snapshot routes: admin-only read enforcement (a non-admin must not be
 * able to enumerate snapshots or read their secret-bearing .env content) and
 * content-at-rest encryption round-trip (file bodies stored as ciphertext, read
 * back as plaintext so restore and cloud-archive paths stay portable).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let CryptoService: typeof import('../services/CryptoService').CryptoService;
let adminCookie: string;
let viewerCookie: string;
let snapshotId: number;

const VIEWER_USER = 'viewer-snap';
const VIEWER_PASS = 'viewer-pass-123';
const ENV_SECRET = 'DB_PASSWORD=s3cr3t-value\n';

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ CryptoService } = await import('../services/CryptoService'));
    ({ app } = await import('../index'));
    adminCookie = await loginAsTestAdmin(app);

    const db = DatabaseService.getInstance();
    const bcrypt = (await import('bcrypt')).default;
    const hash = await bcrypt.hash(VIEWER_PASS, 1);
    db.addUser({ username: VIEWER_USER, password_hash: hash, role: 'viewer' });
    const loginRes = await request(app).post('/api/auth/login').send({ username: VIEWER_USER, password: VIEWER_PASS });
    const cookies = loginRes.headers['set-cookie'] as string | string[];
    viewerCookie = Array.isArray(cookies) ? cookies[0] : cookies;

    snapshotId = db.createSnapshot('audit-seed', 'admin', 1, 1, '[]', '[]');
    db.insertSnapshotFiles(snapshotId, [
        { nodeId: 1, nodeName: 'local', stackName: 'web', filename: 'compose.yaml', content: 'services: {}\n' },
        { nodeId: 1, nodeName: 'local', stackName: 'web', filename: '.env', content: ENV_SECRET },
    ]);
});

afterAll(() => cleanupTestDb(tmpDir));

describe('Fleet snapshot read authorization', () => {
    it('GET /api/fleet/snapshots requires authentication', async () => {
        const res = await request(app).get('/api/fleet/snapshots');
        expect(res.status).toBe(401);
    });

    it('GET /api/fleet/snapshots returns 403 for a non-admin', async () => {
        const res = await request(app).get('/api/fleet/snapshots').set('Cookie', viewerCookie);
        expect(res.status).toBe(403);
    });

    it('GET /api/fleet/snapshots returns the list for an admin', async () => {
        const res = await request(app).get('/api/fleet/snapshots').set('Cookie', adminCookie);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.snapshots)).toBe(true);
    });

    it('GET /api/fleet/snapshots/:id returns 403 for a non-admin', async () => {
        const res = await request(app).get(`/api/fleet/snapshots/${snapshotId}`).set('Cookie', viewerCookie);
        expect(res.status).toBe(403);
    });

    it('GET /api/fleet/snapshots/:id returns decrypted detail for an admin', async () => {
        const res = await request(app).get(`/api/fleet/snapshots/${snapshotId}`).set('Cookie', adminCookie);
        expect(res.status).toBe(200);
        const files = res.body.nodes[0].stacks[0].files as Array<{ filename: string; content: string }>;
        const envFile = files.find(f => f.filename === '.env');
        expect(envFile?.content).toBe(ENV_SECRET);
    });
});

describe('Snapshot content-at-rest encryption', () => {
    it('stores file content as ciphertext but reads it back as plaintext', () => {
        const db = DatabaseService.getInstance();
        const raw = db.getDb().prepare(
            "SELECT content FROM fleet_snapshot_files WHERE snapshot_id = ? AND filename = '.env'",
        ).get(snapshotId) as { content: string };

        expect(CryptoService.getInstance().isEncrypted(raw.content)).toBe(true);
        expect(raw.content).not.toContain('s3cr3t');

        const env = db.getSnapshotFiles(snapshotId).find(f => f.filename === '.env');
        expect(env?.content).toBe(ENV_SECRET);
    });

    it('decrypts content on the restore read path (getSnapshotStackFiles)', () => {
        const db = DatabaseService.getInstance();
        const files = db.getSnapshotStackFiles(snapshotId, 1, 'web');
        const env = files.find(f => f.filename === '.env');
        expect(env?.content).toBe(ENV_SECRET);
    });

    it('reads a legacy plaintext row back verbatim (decrypt tolerates non-ciphertext)', () => {
        const db = DatabaseService.getInstance();
        const legacyId = db.createSnapshot('legacy', 'admin', 1, 1, '[]', '[]');
        // Insert directly, bypassing insertSnapshotFiles' encryption, to simulate
        // a snapshot written before content-at-rest encryption shipped.
        db.getDb().prepare(
            'INSERT INTO fleet_snapshot_files (snapshot_id, node_id, node_name, stack_name, filename, content) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(legacyId, 1, 'local', 'legacy', 'compose.yaml', 'plain: text\n');

        const files = db.getSnapshotFiles(legacyId);
        expect(files[0].content).toBe('plain: text\n');
    });
});
