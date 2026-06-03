/**
 * Fleet snapshot routes: admin-only read enforcement (a non-admin must not be
 * able to enumerate snapshots or read their secret-bearing .env content) and
 * content-at-rest encryption round-trip (file bodies stored as ciphertext, read
 * back as plaintext so restore and cloud-archive paths stay portable).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import * as policyGate from '../helpers/policyGate';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let CryptoService: typeof import('../services/CryptoService').CryptoService;
let ComposeService: typeof import('../services/ComposeService').ComposeService;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
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
    ({ ComposeService } = await import('../services/ComposeService'));
    ({ LicenseService } = await import('../services/LicenseService'));
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

// The seeded baseline carries a default local node (id 1) whose compose_dir is
// the per-test temp dir, so a local restore writes real files without Docker.
const LOCAL_NODE_ID = 1;
const composePath = (stack: string) => path.join(process.env.COMPOSE_DIR as string, stack, 'compose.yaml');
const envPath = (stack: string) => path.join(process.env.COMPOSE_DIR as string, stack, '.env');
// Restore overwrites an existing stack's files; the stack directory is expected
// to already exist (it did at capture time). Seed it to mirror that precondition.
const seedStackDir = (stack: string) => fs.mkdirSync(path.join(process.env.COMPOSE_DIR as string, stack), { recursive: true });

describe('Single-stack snapshot restore (behavior lock)', () => {
    afterEach(() => vi.restoreAllMocks());

    it('returns 404 for a missing snapshot', async () => {
        const res = await request(app)
            .post('/api/fleet/snapshots/999999/restore')
            .set('Cookie', adminCookie)
            .send({ nodeId: LOCAL_NODE_ID, stackName: 'web' });
        expect(res.status).toBe(404);
    });

    it('returns 404 when the stack has no files in the snapshot', async () => {
        const db = DatabaseService.getInstance();
        const id = db.createSnapshot('restore-nofiles', 'admin', 1, 1, '[]', '[]');
        db.insertSnapshotFiles(id, [
            { nodeId: LOCAL_NODE_ID, nodeName: 'local', stackName: 'present', filename: 'compose.yaml', content: 'services: {}\n' },
        ]);
        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore`)
            .set('Cookie', adminCookie)
            .send({ nodeId: LOCAL_NODE_ID, stackName: 'absent' });
        expect(res.status).toBe(404);
    });

    it('returns 404 when the target node no longer exists', async () => {
        const db = DatabaseService.getInstance();
        const id = db.createSnapshot('restore-deadnode', 'admin', 1, 1, '[]', '[]');
        db.insertSnapshotFiles(id, [
            { nodeId: 4242, nodeName: 'gone', stackName: 'orphan', filename: 'compose.yaml', content: 'services: {}\n' },
        ]);
        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore`)
            .set('Cookie', adminCookie)
            .send({ nodeId: 4242, stackName: 'orphan' });
        expect(res.status).toBe(404);
    });

    it('returns 503 when a remote target node has no reachable proxy', async () => {
        const db = DatabaseService.getInstance();
        const remoteId = db.addNode({ name: 'unreachable', type: 'remote', api_url: '', api_token: '', compose_dir: '/app/compose', is_default: false });
        const id = db.createSnapshot('restore-remote', 'admin', 1, 1, '[]', '[]');
        db.insertSnapshotFiles(id, [
            { nodeId: remoteId, nodeName: 'unreachable', stackName: 'svc', filename: 'compose.yaml', content: 'services: {}\n' },
        ]);
        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore`)
            .set('Cookie', adminCookie)
            .send({ nodeId: remoteId, stackName: 'svc' });
        expect(res.status).toBe(503);
    });

    it('restores a local stack to disk, including its .env (no redeploy)', async () => {
        const db = DatabaseService.getInstance();
        const id = db.createSnapshot('restore-local', 'admin', 1, 1, '[]', '[]');
        db.insertSnapshotFiles(id, [
            { nodeId: LOCAL_NODE_ID, nodeName: 'local', stackName: 'restore-web', filename: 'compose.yaml', content: 'services:\n  app: {}\n' },
            { nodeId: LOCAL_NODE_ID, nodeName: 'local', stackName: 'restore-web', filename: '.env', content: 'SECRET=restored-value\n' },
        ]);
        seedStackDir('restore-web');
        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore`)
            .set('Cookie', adminCookie)
            .send({ nodeId: LOCAL_NODE_ID, stackName: 'restore-web' });
        expect(res.status).toBe(200);
        expect(res.body.redeployed).toBe(false);
        expect(fs.readFileSync(composePath('restore-web'), 'utf-8')).toContain('app: {}');
        expect(fs.readFileSync(envPath('restore-web'), 'utf-8')).toContain('SECRET=restored-value');
    });

    it('returns 409 when the deploy policy blocks the redeploy', async () => {
        vi.spyOn(policyGate, 'runPolicyGate').mockImplementation(async (_req, res) => {
            res.status(409).json({ error: 'Policy "block-criticals" blocked deploy' });
            return false;
        });
        const db = DatabaseService.getInstance();
        const id = db.createSnapshot('restore-409', 'admin', 1, 1, '[]', '[]');
        db.insertSnapshotFiles(id, [
            { nodeId: LOCAL_NODE_ID, nodeName: 'local', stackName: 'policy-web', filename: 'compose.yaml', content: 'services: {}\n' },
        ]);
        seedStackDir('policy-web');
        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore`)
            .set('Cookie', adminCookie)
            .send({ nodeId: LOCAL_NODE_ID, stackName: 'policy-web', redeploy: true });
        expect(res.status).toBe(409);
    });

    it('redeploys after restore when requested', async () => {
        vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
        const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockResolvedValue();
        const db = DatabaseService.getInstance();
        const id = db.createSnapshot('restore-redeploy', 'admin', 1, 1, '[]', '[]');
        db.insertSnapshotFiles(id, [
            { nodeId: LOCAL_NODE_ID, nodeName: 'local', stackName: 'redeploy-web', filename: 'compose.yaml', content: 'services: {}\n' },
        ]);
        seedStackDir('redeploy-web');
        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore`)
            .set('Cookie', adminCookie)
            .send({ nodeId: LOCAL_NODE_ID, stackName: 'redeploy-web', redeploy: true });
        expect(res.status).toBe(200);
        expect(res.body.redeployed).toBe(true);
        expect(deploySpy).toHaveBeenCalledWith('redeploy-web');
    });
});

describe('Restore-all', () => {
    afterEach(() => vi.restoreAllMocks());

    it('requires authentication', async () => {
        const res = await request(app).post(`/api/fleet/snapshots/${snapshotId}/restore-all`).send({});
        expect(res.status).toBe(401);
    });

    it('returns 403 for a non-admin', async () => {
        const res = await request(app).post(`/api/fleet/snapshots/${snapshotId}/restore-all`).set('Cookie', viewerCookie).send({});
        expect(res.status).toBe(403);
    });

    it('returns 404 for a missing snapshot', async () => {
        const res = await request(app).post('/api/fleet/snapshots/999999/restore-all').set('Cookie', adminCookie).send({});
        expect(res.status).toBe(404);
    });

    it('returns 404 when the snapshot has no files', async () => {
        const db = DatabaseService.getInstance();
        const id = db.createSnapshot('restore-all-empty', 'admin', 0, 0, '[]', '[]');
        const res = await request(app).post(`/api/fleet/snapshots/${id}/restore-all`).set('Cookie', adminCookie).send({});
        expect(res.status).toBe(404);
    });

    it('restores every stack and reports the counts', async () => {
        const db = DatabaseService.getInstance();
        const id = db.createSnapshot('restore-all-ok', 'admin', 1, 2, '[]', '[]');
        db.insertSnapshotFiles(id, [
            { nodeId: LOCAL_NODE_ID, nodeName: 'local', stackName: 'all-a', filename: 'compose.yaml', content: 'services:\n  a: {}\n' },
            { nodeId: LOCAL_NODE_ID, nodeName: 'local', stackName: 'all-b', filename: 'compose.yaml', content: 'services:\n  b: {}\n' },
        ]);
        seedStackDir('all-a');
        seedStackDir('all-b');
        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore-all`)
            .set('Cookie', adminCookie)
            .send({});
        expect(res.status).toBe(200);
        expect(res.body.restored).toBe(2);
        expect(res.body.failed).toBe(0);
        expect(res.body.results).toHaveLength(2);
        expect(fs.readFileSync(composePath('all-a'), 'utf-8')).toContain('a: {}');
        expect(fs.readFileSync(composePath('all-b'), 'utf-8')).toContain('b: {}');
    });

    it('records a per-stack failure and still restores the rest', async () => {
        const db = DatabaseService.getInstance();
        const id = db.createSnapshot('restore-all-partial', 'admin', 2, 2, '[]', '[]');
        db.insertSnapshotFiles(id, [
            { nodeId: LOCAL_NODE_ID, nodeName: 'local', stackName: 'good', filename: 'compose.yaml', content: 'services: {}\n' },
            { nodeId: 4242, nodeName: 'gone', stackName: 'bad', filename: 'compose.yaml', content: 'services: {}\n' },
        ]);
        seedStackDir('good');
        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore-all`)
            .set('Cookie', adminCookie)
            .send({});
        expect(res.status).toBe(200);
        expect(res.body.restored).toBe(1);
        expect(res.body.failed).toBe(1);
        const bad = (res.body.results as Array<{ stackName: string; success: boolean; error?: string }>).find(r => r.stackName === 'bad');
        expect(bad?.success).toBe(false);
        expect(bad?.error).toMatch(/no longer exists/i);
    });

    it('redeploys each restored stack when requested', async () => {
        vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
        const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockResolvedValue();
        const db = DatabaseService.getInstance();
        const id = db.createSnapshot('restore-all-redeploy', 'admin', 1, 1, '[]', '[]');
        db.insertSnapshotFiles(id, [
            { nodeId: LOCAL_NODE_ID, nodeName: 'local', stackName: 'redeploy-all-web', filename: 'compose.yaml', content: 'services: {}\n' },
        ]);
        seedStackDir('redeploy-all-web');
        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore-all`)
            .set('Cookie', adminCookie)
            .send({ redeploy: true });
        expect(res.status).toBe(200);
        expect(res.body.restored).toBe(1);
        expect(res.body.results[0].redeployed).toBe(true);
        expect(deploySpy).toHaveBeenCalledWith('redeploy-all-web');
    });

    it('records a policy-blocked redeploy as a per-stack failure and still restores the rest', async () => {
        const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockResolvedValue();
        vi.spyOn(policyGate, 'assertPolicyGateAllows').mockImplementation(async (stackName: string) => {
            if (stackName === 'blocked-web') throw new Error('Policy "block-criticals" blocked deploy: 1 image(s) exceed high');
        });
        const db = DatabaseService.getInstance();
        const id = db.createSnapshot('restore-all-policy', 'admin', 1, 2, '[]', '[]');
        db.insertSnapshotFiles(id, [
            { nodeId: LOCAL_NODE_ID, nodeName: 'local', stackName: 'ok-web', filename: 'compose.yaml', content: 'services: {}\n' },
            { nodeId: LOCAL_NODE_ID, nodeName: 'local', stackName: 'blocked-web', filename: 'compose.yaml', content: 'services: {}\n' },
        ]);
        seedStackDir('ok-web');
        seedStackDir('blocked-web');
        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore-all`)
            .set('Cookie', adminCookie)
            .send({ redeploy: true });
        expect(res.status).toBe(200);
        expect(res.body.restored).toBe(1);
        expect(res.body.failed).toBe(1);
        const blocked = (res.body.results as Array<{ stackName: string; success: boolean; error?: string }>).find(r => r.stackName === 'blocked-web');
        expect(blocked?.success).toBe(false);
        expect(blocked?.error).toMatch(/blocked deploy/i);
        expect(deploySpy).toHaveBeenCalledWith('ok-web');
        expect(deploySpy).not.toHaveBeenCalledWith('blocked-web');
    });
});
