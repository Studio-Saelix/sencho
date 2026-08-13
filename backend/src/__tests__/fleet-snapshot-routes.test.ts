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
import { createHash, randomUUID } from 'crypto';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import * as policyGate from '../helpers/policyGate';
import { RollbackGenerationStore } from '../services/RollbackGenerationStore';
import type { ResolvedRollbackInventory, RollbackGenerationManifest } from '../types/rollbackGeneration';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let CryptoService: typeof import('../services/CryptoService').CryptoService;
let ComposeService: typeof import('../services/ComposeService').ComposeService;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let NodeRegistry: typeof import('../services/NodeRegistry').NodeRegistry;
let FileSystemService: typeof import('../services/FileSystemService').FileSystemService;
let StackUpdateRecoveryService: typeof import('../services/StackUpdateRecoveryService').StackUpdateRecoveryService;
let StackOpLockService: typeof import('../services/StackOpLockService').StackOpLockService;
let adminCookie: string;
let viewerCookie: string;
let snapshotId: number;

const VIEWER_USER = 'viewer-snap';
const VIEWER_PASS = 'viewer-pass-123';
const ENV_SECRET = 'DB_PASSWORD=s3cr3t-value\n';

// Every operator-authored dossier field, blank, for building test dossiers.
const BLANK_FIELDS = {
    purpose: '', owner: '', access_urls: '', static_ip: '', vlan: '', firewall_notes: '',
    reverse_proxy_notes: '', backup_notes: '', upgrade_notes: '', recovery_notes: '', custom_notes: '',
};

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ CryptoService } = await import('../services/CryptoService'));
    ({ ComposeService } = await import('../services/ComposeService'));
    ({ LicenseService } = await import('../services/LicenseService'));
    ({ NodeRegistry } = await import('../services/NodeRegistry'));
    ({ FileSystemService } = await import('../services/FileSystemService'));
    ({ StackUpdateRecoveryService } = await import('../services/StackUpdateRecoveryService'));
    ({ StackOpLockService } = await import('../services/StackOpLockService'));
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
        expect(env?.available).toBe(true);
        if (env?.available) expect(env.content).toBe(ENV_SECRET);
    });

    it('decrypts content on the restore read path (getSnapshotStackFiles)', () => {
        const db = DatabaseService.getInstance();
        const files = db.getSnapshotStackFiles(snapshotId, 1, 'web');
        const env = files.find(f => f.filename === '.env');
        expect(env?.available).toBe(true);
        if (env?.available) expect(env.content).toBe(ENV_SECRET);
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
        expect(files[0].available).toBe(true);
        if (files[0].available) expect(files[0].content).toBe('plain: text\n');
    });

    it('reads punctuated legacy enc: plaintext rows back verbatim', () => {
        const db = DatabaseService.getInstance();
        const legacyId = db.createSnapshot('legacy-punct', 'admin', 1, 1, '[]', '[]');
        db.getDb().prepare(
            'INSERT INTO fleet_snapshot_files (snapshot_id, node_id, node_name, stack_name, filename, content) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(legacyId, 1, 'local', 'legacy', 'compose.yaml', 'enc:hello-world');

        const files = db.getSnapshotFiles(legacyId);
        expect(files[0].available).toBe(true);
        if (files[0].available) expect(files[0].content).toBe('enc:hello-world');
    });

    it('isolates a corrupt encrypted sibling without failing the read', () => {
        const db = DatabaseService.getInstance();
        const id = db.createSnapshot('partial-corrupt', 'admin', 1, 2, '[]', '[]');
        const good = CryptoService.getInstance().encrypt('services: {}\n');
        const bad = CryptoService.getInstance().encrypt('SECRET=x\n');
        const payload = bad.slice('enc:'.length);
        const [iv, tag, ct] = payload.split(':');
        const damaged = `enc:${iv}:${tag}:${ct.slice(0, 3)}`;
        db.getDb().prepare(
            'INSERT INTO fleet_snapshot_files (snapshot_id, node_id, node_name, stack_name, filename, content) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(id, 1, 'local', 'good', 'compose.yaml', good);
        db.getDb().prepare(
            'INSERT INTO fleet_snapshot_files (snapshot_id, node_id, node_name, stack_name, filename, content) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(id, 1, 'local', 'bad', 'compose.yaml', damaged);

        const files = db.getSnapshotFiles(id);
        expect(files).toHaveLength(2);
        const goodFile = files.find(f => f.stack_name === 'good');
        const badFile = files.find(f => f.stack_name === 'bad');
        expect(goodFile?.available).toBe(true);
        if (goodFile?.available) expect(goodFile.content).toBe('services: {}\n');
        expect(badFile?.available).toBe(false);
    });

    it('preserves a valid empty file as available empty content', () => {
        const db = DatabaseService.getInstance();
        const id = db.createSnapshot('empty-env', 'admin', 1, 1, '[]', '[]');
        db.insertSnapshotFiles(id, [
            { nodeId: 1, nodeName: 'local', stackName: 'web', filename: '.env', content: '' },
            { nodeId: 1, nodeName: 'local', stackName: 'web', filename: 'compose.yaml', content: 'services: {}\n' },
        ]);
        const files = db.getSnapshotFiles(id);
        const env = files.find(f => f.filename === '.env');
        expect(env?.available).toBe(true);
        if (env?.available) expect(env.content).toBe('');
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

    it('returns 409 SNAPSHOT_FILE_UNAVAILABLE and does not mutate live files', async () => {
        const db = DatabaseService.getInstance();
        const id = db.createSnapshot('restore-corrupt', 'admin', 1, 1, '[]', '[]');
        const cipher = CryptoService.getInstance().encrypt('services: {}\n');
        const payload = cipher.slice('enc:'.length);
        const [iv, tag, ct] = payload.split(':');
        const damaged = `enc:${iv}:${tag}:${ct.slice(0, 3)}`;
        db.getDb().prepare(
            'INSERT INTO fleet_snapshot_files (snapshot_id, node_id, node_name, stack_name, filename, content) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(id, LOCAL_NODE_ID, 'local', 'corrupt-web', 'compose.yaml', damaged);
        seedStackDir('corrupt-web');
        const beforeCompose = 'services:\n  keep: {}\n';
        const beforeEnv = 'KEEP=1\n';
        fs.writeFileSync(composePath('corrupt-web'), beforeCompose);
        fs.writeFileSync(envPath('corrupt-web'), beforeEnv);

        const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockResolvedValue({ recoveryId: null });
        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore`)
            .set('Cookie', adminCookie)
            .send({ nodeId: LOCAL_NODE_ID, stackName: 'corrupt-web', redeploy: true, restoreNotes: true });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('SNAPSHOT_FILE_UNAVAILABLE');
        expect(fs.readFileSync(composePath('corrupt-web'), 'utf-8')).toBe(beforeCompose);
        expect(fs.readFileSync(envPath('corrupt-web'), 'utf-8')).toBe(beforeEnv);
        expect(deploySpy).not.toHaveBeenCalled();
    });

    it('returns 409 for mixed available and unavailable files in the same stack without writing', async () => {
        const db = DatabaseService.getInstance();
        const id = db.createSnapshot('restore-mixed', 'admin', 1, 1, '[]', '[]');
        const good = CryptoService.getInstance().encrypt('services: { ok: {} }\n');
        const bad = CryptoService.getInstance().encrypt('SECRET=long-enough-to-truncate\n');
        const payload = bad.slice('enc:'.length);
        const [iv, tag, ct] = payload.split(':');
        db.getDb().prepare(
            'INSERT INTO fleet_snapshot_files (snapshot_id, node_id, node_name, stack_name, filename, content) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(id, LOCAL_NODE_ID, 'local', 'mixed-web', 'compose.yaml', good);
        db.getDb().prepare(
            'INSERT INTO fleet_snapshot_files (snapshot_id, node_id, node_name, stack_name, filename, content) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(id, LOCAL_NODE_ID, 'local', 'mixed-web', '.env', `enc:${iv}:${tag}:${ct.slice(0, 3)}`);
        seedStackDir('mixed-web');
        const beforeCompose = 'services:\n  keep: {}\n';
        const beforeEnv = 'KEEP=1\n';
        fs.writeFileSync(composePath('mixed-web'), beforeCompose);
        fs.writeFileSync(envPath('mixed-web'), beforeEnv);

        const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockResolvedValue({ recoveryId: null });
        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore`)
            .set('Cookie', adminCookie)
            .send({ nodeId: LOCAL_NODE_ID, stackName: 'mixed-web', redeploy: true });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('SNAPSHOT_FILE_UNAVAILABLE');
        expect(fs.readFileSync(composePath('mixed-web'), 'utf-8')).toBe(beforeCompose);
        expect(fs.readFileSync(envPath('mixed-web'), 'utf-8')).toBe(beforeEnv);
        expect(deploySpy).not.toHaveBeenCalled();
    });

    it('returns 409 when a delimiter byte is corrupted and does not write ciphertext', async () => {
        const db = DatabaseService.getInstance();
        const id = db.createSnapshot('restore-delim', 'admin', 1, 1, '[]', '[]');
        const cipher = CryptoService.getInstance().encrypt('services: { ok: {} }\n');
        const payload = cipher.slice('enc:'.length);
        const [iv, tag, ct] = payload.split(':');
        const damaged = `enc:${iv}=${tag}:${ct}`;
        db.getDb().prepare(
            'INSERT INTO fleet_snapshot_files (snapshot_id, node_id, node_name, stack_name, filename, content) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(id, LOCAL_NODE_ID, 'local', 'delim-web', 'compose.yaml', damaged);
        seedStackDir('delim-web');
        const beforeCompose = 'services:\n  keep: {}\n';
        fs.writeFileSync(composePath('delim-web'), beforeCompose);

        const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockResolvedValue({ recoveryId: null });
        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore`)
            .set('Cookie', adminCookie)
            .send({ nodeId: LOCAL_NODE_ID, stackName: 'delim-web', redeploy: true });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('SNAPSHOT_FILE_UNAVAILABLE');
        expect(fs.readFileSync(composePath('delim-web'), 'utf-8')).toBe(beforeCompose);
        expect(deploySpy).not.toHaveBeenCalled();
    });

    it('detail returns 200 with unavailable marker and intact sibling content', async () => {
        const db = DatabaseService.getInstance();
        const id = db.createSnapshot('detail-corrupt', 'admin', 1, 2, '[]', '[]');
        const good = CryptoService.getInstance().encrypt('services: { ok: {} }\n');
        const bad = CryptoService.getInstance().encrypt('SECRET=long-enough-to-truncate\n');
        const payload = bad.slice('enc:'.length);
        const [iv, tag, ct] = payload.split(':');
        db.getDb().prepare(
            'INSERT INTO fleet_snapshot_files (snapshot_id, node_id, node_name, stack_name, filename, content) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(id, LOCAL_NODE_ID, 'local', 'ok', 'compose.yaml', good);
        db.getDb().prepare(
            'INSERT INTO fleet_snapshot_files (snapshot_id, node_id, node_name, stack_name, filename, content) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(id, LOCAL_NODE_ID, 'local', 'bad', 'compose.yaml', `enc:${iv}:${tag}:${ct.slice(0, 3)}`);

        const res = await request(app).get(`/api/fleet/snapshots/${id}`).set('Cookie', adminCookie);
        expect(res.status).toBe(200);
        expect(res.body.fileDecryptWarnings).toEqual([
            expect.objectContaining({ stackName: 'bad', filename: 'compose.yaml' }),
        ]);
        const okStack = res.body.nodes[0].stacks.find((s: { stackName: string }) => s.stackName === 'ok');
        const badStack = res.body.nodes[0].stacks.find((s: { stackName: string }) => s.stackName === 'bad');
        expect(okStack.files[0].content).toBe('services: { ok: {} }\n');
        expect(okStack.files[0].unavailable).toBeUndefined();
        expect(badStack.files[0].unavailable).toBe(true);
        expect(badStack.files[0].content).toBeUndefined();
        expect(JSON.stringify(res.body)).not.toContain('enc:');
    });

    it('redeploys after restore when requested', async () => {
        vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
        const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockResolvedValue({ recoveryId: null });
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
        expect(deploySpy).toHaveBeenCalledWith('redeploy-web', undefined, undefined, {
            source: 'fleet_snapshot',
            actor: 'system:fleet-snapshot',
        });
    });
});

describe('Snapshot documentation capture (persistence)', () => {
    const docJson = JSON.stringify({
        generated_at: '2026-01-01T00:00:00Z',
        stacks: [{ nodeId: LOCAL_NODE_ID, nodeName: 'local', stackName: 'doc-web', dossier: { ...BLANK_FIELDS, purpose: 'edge', owner: 'ops' } }],
        warnings: [],
    });

    it('stores documentation encrypted at rest and flags has_documentation', () => {
        const db = DatabaseService.getInstance();
        const id = db.createSnapshot('doc-snap', 'admin', 1, 1, '[]', '[]', docJson);
        expect(db.getSnapshot(id)!.has_documentation).toBe(1);
        const raw = db.getDb().prepare('SELECT documentation FROM fleet_snapshots WHERE id = ?').get(id) as { documentation: string };
        expect(CryptoService.getInstance().isEncrypted(raw.documentation)).toBe(true);
        expect(raw.documentation).not.toContain('edge');
        expect(db.getSnapshotDocumentation(id)).toBe(docJson);
    });

    it('leaves documentation empty and has_documentation 0 when none captured', () => {
        const db = DatabaseService.getInstance();
        const id = db.createSnapshot('no-doc', 'admin', 1, 1, '[]', '[]');
        expect(db.getSnapshot(id)!.has_documentation).toBe(0);
        expect(db.getSnapshotDocumentation(id)).toBe('');
    });

    it('GET detail surfaces the documentation object for an admin', async () => {
        const db = DatabaseService.getInstance();
        const id = db.createSnapshot('doc-detail', 'admin', 1, 1, '[]', '[]', docJson);
        db.insertSnapshotFiles(id, [
            { nodeId: LOCAL_NODE_ID, nodeName: 'local', stackName: 'doc-web', filename: 'compose.yaml', content: 'services: {}\n' },
        ]);
        const res = await request(app).get(`/api/fleet/snapshots/${id}`).set('Cookie', adminCookie);
        expect(res.status).toBe(200);
        expect(res.body.has_documentation).toBe(1);
        expect(res.body.documentation.stacks[0]).toMatchObject({ nodeId: LOCAL_NODE_ID, stackName: 'doc-web', dossier: { purpose: 'edge' } });
    });

    it('detail degrades to no documentation (still 200) when the blob is unparseable', async () => {
        const db = DatabaseService.getInstance();
        const id = db.createSnapshot('doc-corrupt', 'admin', 1, 1, '[]', '[]', JSON.stringify({ generated_at: 'x', stacks: [], warnings: [] }));
        // Overwrite the encrypted column with non-JSON plaintext to simulate a
        // corrupt or tampered blob; getSnapshotDocumentation returns it verbatim
        // (decrypt passes non-ciphertext through) and the route's JSON.parse fails.
        db.getDb().prepare('UPDATE fleet_snapshots SET documentation = ? WHERE id = ?').run('not-json', id);
        const res = await request(app).get(`/api/fleet/snapshots/${id}`).set('Cookie', adminCookie);
        expect(res.status).toBe(200);
        expect(res.body.documentation).toBeUndefined();
    });
});

describe('Snapshot restore: dossier notes opt-in', () => {
    afterEach(() => vi.restoreAllMocks());

    function snapWithNotes(stackName: string, purpose: string): number {
        const db = DatabaseService.getInstance();
        const docJson = JSON.stringify({
            generated_at: 'x',
            stacks: [{ nodeId: LOCAL_NODE_ID, nodeName: 'local', stackName, dossier: { ...BLANK_FIELDS, purpose } }],
            warnings: [],
        });
        const id = db.createSnapshot(`notes-${stackName}`, 'admin', 1, 1, '[]', '[]', docJson);
        db.insertSnapshotFiles(id, [
            { nodeId: LOCAL_NODE_ID, nodeName: 'local', stackName, filename: 'compose.yaml', content: 'services: {}\n' },
        ]);
        seedStackDir(stackName);
        return id;
    }

    it('does NOT overwrite current notes when restoreNotes is omitted', async () => {
        const db = DatabaseService.getInstance();
        db.upsertStackDossier(LOCAL_NODE_ID, 'notes-keep', { ...BLANK_FIELDS, purpose: 'current' });
        const id = snapWithNotes('notes-keep', 'snapshot-version');
        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore`)
            .set('Cookie', adminCookie)
            .send({ nodeId: LOCAL_NODE_ID, stackName: 'notes-keep' });
        expect(res.status).toBe(200);
        expect(res.body.notesRestored).toBe(false);
        expect(db.getStackDossier(LOCAL_NODE_ID, 'notes-keep')?.purpose).toBe('current');
    });

    it('restores notes when restoreNotes is true', async () => {
        const db = DatabaseService.getInstance();
        db.upsertStackDossier(LOCAL_NODE_ID, 'notes-overwrite', { ...BLANK_FIELDS, purpose: 'current' });
        const id = snapWithNotes('notes-overwrite', 'snapshot-version');
        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore`)
            .set('Cookie', adminCookie)
            .send({ nodeId: LOCAL_NODE_ID, stackName: 'notes-overwrite', restoreNotes: true });
        expect(res.status).toBe(200);
        expect(res.body.notesRestored).toBe(true);
        expect(db.getStackDossier(LOCAL_NODE_ID, 'notes-overwrite')?.purpose).toBe('snapshot-version');
    });

    it('reports notesRestored false when the snapshot has no documentation', async () => {
        const db = DatabaseService.getInstance();
        const id = db.createSnapshot('notes-none', 'admin', 1, 1, '[]', '[]');
        db.insertSnapshotFiles(id, [
            { nodeId: LOCAL_NODE_ID, nodeName: 'local', stackName: 'notes-none-web', filename: 'compose.yaml', content: 'services: {}\n' },
        ]);
        seedStackDir('notes-none-web');
        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore`)
            .set('Cookie', adminCookie)
            .send({ nodeId: LOCAL_NODE_ID, stackName: 'notes-none-web', restoreNotes: true });
        expect(res.status).toBe(200);
        expect(res.body.notesRestored).toBe(false);
    });

    it('ignores a non-boolean restoreNotes (string "false") and leaves notes untouched', async () => {
        const db = DatabaseService.getInstance();
        db.upsertStackDossier(LOCAL_NODE_ID, 'notes-strict', { ...BLANK_FIELDS, purpose: 'current' });
        const id = snapWithNotes('notes-strict', 'snapshot-version');
        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore`)
            .set('Cookie', adminCookie)
            .send({ nodeId: LOCAL_NODE_ID, stackName: 'notes-strict', restoreNotes: 'false' });
        expect(res.status).toBe(200);
        expect(res.body.notesRestored).toBe(false);
        expect(db.getStackDossier(LOCAL_NODE_ID, 'notes-strict')?.purpose).toBe('current');
    });

    it('does not restore notes from a malformed documentation blob', async () => {
        const db = DatabaseService.getInstance();
        db.upsertStackDossier(LOCAL_NODE_ID, 'notes-malformed', { ...BLANK_FIELDS, purpose: 'current' });
        const id = db.createSnapshot('notes-bad-doc', 'admin', 1, 1, '[]', '[]', JSON.stringify({ generated_at: 'x', stacks: null, warnings: [] }));
        db.insertSnapshotFiles(id, [
            { nodeId: LOCAL_NODE_ID, nodeName: 'local', stackName: 'notes-malformed', filename: 'compose.yaml', content: 'services: {}\n' },
        ]);
        seedStackDir('notes-malformed');
        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore`)
            .set('Cookie', adminCookie)
            .send({ nodeId: LOCAL_NODE_ID, stackName: 'notes-malformed', restoreNotes: true });
        expect(res.status).toBe(200);
        expect(res.body.notesRestored).toBe(false);
        expect(db.getStackDossier(LOCAL_NODE_ID, 'notes-malformed')?.purpose).toBe('current');
    });

    it('does not overwrite current notes with an all-blank captured dossier', async () => {
        const db = DatabaseService.getInstance();
        db.upsertStackDossier(LOCAL_NODE_ID, 'notes-blank', { ...BLANK_FIELDS, purpose: 'current' });
        const docJson = JSON.stringify({
            generated_at: 'x',
            stacks: [{ nodeId: LOCAL_NODE_ID, nodeName: 'local', stackName: 'notes-blank', dossier: { ...BLANK_FIELDS } }],
            warnings: [],
        });
        const id = db.createSnapshot('notes-blank-doc', 'admin', 1, 1, '[]', '[]', docJson);
        db.insertSnapshotFiles(id, [
            { nodeId: LOCAL_NODE_ID, nodeName: 'local', stackName: 'notes-blank', filename: 'compose.yaml', content: 'services: {}\n' },
        ]);
        seedStackDir('notes-blank');
        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore`)
            .set('Cookie', adminCookie)
            .send({ nodeId: LOCAL_NODE_ID, stackName: 'notes-blank', restoreNotes: true });
        expect(res.status).toBe(200);
        expect(res.body.notesRestored).toBe(false);
        expect(db.getStackDossier(LOCAL_NODE_ID, 'notes-blank')?.purpose).toBe('current');
    });

    it('restore-all restores notes only for stacks the snapshot documented', async () => {
        const db = DatabaseService.getInstance();
        // Only 'all-a' carries dossier notes; 'all-b' has files but no notes.
        const docJson = JSON.stringify({
            generated_at: 'x',
            stacks: [{ nodeId: LOCAL_NODE_ID, nodeName: 'local', stackName: 'allnotes-a', dossier: { ...BLANK_FIELDS, purpose: 'documented' } }],
            warnings: [],
        });
        const id = db.createSnapshot('restore-all-notes', 'admin', 1, 2, '[]', '[]', docJson);
        db.insertSnapshotFiles(id, [
            { nodeId: LOCAL_NODE_ID, nodeName: 'local', stackName: 'allnotes-a', filename: 'compose.yaml', content: 'services: {}\n' },
            { nodeId: LOCAL_NODE_ID, nodeName: 'local', stackName: 'allnotes-b', filename: 'compose.yaml', content: 'services: {}\n' },
        ]);
        seedStackDir('allnotes-a');
        seedStackDir('allnotes-b');

        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore-all`)
            .set('Cookie', adminCookie)
            .send({ restoreNotes: true });

        expect(res.status).toBe(200);
        expect(res.body.restored).toBe(2);
        const results = res.body.results as Array<{ stackName: string; notesRestored: boolean }>;
        expect(results.find(r => r.stackName === 'allnotes-a')?.notesRestored).toBe(true);
        expect(results.find(r => r.stackName === 'allnotes-b')?.notesRestored).toBe(false);
        expect(db.getStackDossier(LOCAL_NODE_ID, 'allnotes-a')?.purpose).toBe('documented');
        expect(db.getStackDossier(LOCAL_NODE_ID, 'allnotes-b')).toBeUndefined();
    });
});

describe('Snapshot restore: remote dossier notes (proxy PUT)', () => {
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

    function remoteDocSnapshot(stackName: string, purpose: string): { id: number; remoteId: number } {
        const db = DatabaseService.getInstance();
        const remoteId = db.addNode({ name: `remote-${stackName}`, type: 'remote', api_url: 'http://remote:1852', api_token: 'tok', compose_dir: '/app/compose', is_default: false });
        const docJson = JSON.stringify({
            generated_at: 'x',
            stacks: [{ nodeId: remoteId, nodeName: `remote-${stackName}`, stackName, dossier: { ...BLANK_FIELDS, purpose } }],
            warnings: [],
        });
        const id = db.createSnapshot(`remote-notes-${stackName}`, 'admin', 1, 1, '[]', '[]', docJson);
        db.insertSnapshotFiles(id, [
            { nodeId: remoteId, nodeName: `remote-${stackName}`, stackName, filename: 'compose.yaml', content: 'services: {}\n' },
        ]);
        return { id, remoteId };
    }

    it('writes notes to a remote node via the proxy dossier PUT when opted in', async () => {
        const { id, remoteId } = remoteDocSnapshot('rweb', 'documented');
        vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue({ apiUrl: 'http://remote:1852', apiToken: 'tok' });
        const calls: Array<{ url: string; method?: string }> = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: { method?: string }) => {
            calls.push({ url, method: opts?.method });
            return { ok: true, status: 200, text: async () => '' } as unknown as Response;
        }));

        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore`)
            .set('Cookie', adminCookie)
            .send({ nodeId: remoteId, stackName: 'rweb', restoreNotes: true });

        expect(res.status).toBe(200);
        expect(res.body.notesRestored).toBe(true);
        expect(res.body.notesError).toBeUndefined();
        expect(calls.some(c => /\/dossier$/.test(c.url) && c.method === 'PUT')).toBe(true);
    });

    it('reports a non-fatal notesError when the remote dossier PUT fails but files restored', async () => {
        const { id, remoteId } = remoteDocSnapshot('rweb2', 'documented');
        vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue({ apiUrl: 'http://remote:1852', apiToken: 'tok' });
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            if (/\/dossier$/.test(url)) return { ok: false, status: 500, text: async () => 'boom' } as unknown as Response;
            return { ok: true, status: 200, text: async () => '' } as unknown as Response;
        }));

        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore`)
            .set('Cookie', adminCookie)
            .send({ nodeId: remoteId, stackName: 'rweb2', restoreNotes: true });

        // File restore succeeded; only the optional notes write failed.
        expect(res.status).toBe(200);
        expect(res.body.notesRestored).toBe(false);
        expect(res.body.notesError).toBeTruthy();
    });

    it('restore-all records a per-row notesError but keeps the stack success when the remote notes PUT fails', async () => {
        // restore-all is driven by snapshot id; the target node is resolved from
        // the snapshot's stored files, so the returned remoteId is not needed here.
        const { id } = remoteDocSnapshot('rweb3', 'documented');
        vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue({ apiUrl: 'http://remote:1852', apiToken: 'tok' });
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            if (/\/dossier$/.test(url)) return { ok: false, status: 500, text: async () => 'boom' } as unknown as Response;
            return { ok: true, status: 200, text: async () => '' } as unknown as Response;
        }));

        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore-all`)
            .set('Cookie', adminCookie)
            .send({ restoreNotes: true });

        expect(res.status).toBe(200);
        expect(res.body.restored).toBe(1);
        expect(res.body.failed).toBe(0);
        const row = (res.body.results as Array<{ stackName: string; success: boolean; notesRestored: boolean; notesError?: string }>)
            .find(r => r.stackName === 'rweb3');
        expect(row?.success).toBe(true);
        expect(row?.notesRestored).toBe(false);
        expect(row?.notesError).toBeTruthy();
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

    it('isolates corrupt decrypt stacks before any mutation with notes and redeploy requested', async () => {
        vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
        const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockResolvedValue({ recoveryId: null });
        const db = DatabaseService.getInstance();
        const id = db.createSnapshot('restore-all-corrupt', 'admin', 1, 2, '[]', '[]');
        const good = CryptoService.getInstance().encrypt('services:\n  app: {}\n');
        const bad = CryptoService.getInstance().encrypt('SECRET=x\n');
        const payload = bad.slice('enc:'.length);
        const [iv, tag, ct] = payload.split(':');
        const damaged = `enc:${iv}:${tag}:${ct.slice(0, 3)}`;
        db.getDb().prepare(
            'INSERT INTO fleet_snapshot_files (snapshot_id, node_id, node_name, stack_name, filename, content) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(id, LOCAL_NODE_ID, 'local', 'healthy', 'compose.yaml', good);
        db.getDb().prepare(
            'INSERT INTO fleet_snapshot_files (snapshot_id, node_id, node_name, stack_name, filename, content) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(id, LOCAL_NODE_ID, 'local', 'corrupt', 'compose.yaml', damaged);
        seedStackDir('healthy');
        seedStackDir('corrupt');
        fs.writeFileSync(composePath('corrupt'), 'services:\n  keep: {}\n');

        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore-all`)
            .set('Cookie', adminCookie)
            .send({ redeploy: true, restoreNotes: true });
        expect(res.status).toBe(200);
        expect(res.body.restored).toBe(1);
        expect(res.body.failed).toBe(1);
        const corrupt = (res.body.results as Array<{ stackName: string; success: boolean; error?: string; redeployed: boolean }>)
            .find(r => r.stackName === 'corrupt');
        expect(corrupt?.success).toBe(false);
        expect(corrupt?.error).toMatch(/could not be decrypted/i);
        expect(corrupt?.redeployed).toBe(false);
        expect(fs.readFileSync(composePath('corrupt'), 'utf-8')).toContain('keep: {}');
        expect(fs.readFileSync(composePath('healthy'), 'utf-8')).toContain('app: {}');
        expect(deploySpy).toHaveBeenCalledTimes(1);
        expect(deploySpy).toHaveBeenCalledWith('healthy', undefined, undefined, {
            source: 'fleet_snapshot',
            actor: 'system:fleet-snapshot',
        });
        expect(deploySpy.mock.calls.every(call => call[0] !== 'corrupt')).toBe(true);
    });

    it('isolates delimiter-byte corruption before restore-all mutation', async () => {
        vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
        const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockResolvedValue({ recoveryId: null });
        const db = DatabaseService.getInstance();
        const id = db.createSnapshot('restore-all-delim', 'admin', 1, 2, '[]', '[]');
        const good = CryptoService.getInstance().encrypt('services:\n  app: {}\n');
        const bad = CryptoService.getInstance().encrypt('SECRET=long-enough-to-mutate\n');
        const payload = bad.slice('enc:'.length);
        const [iv, tag, ct] = payload.split(':');
        const damaged = `enc:${iv} ${tag}:${ct}`;
        db.getDb().prepare(
            'INSERT INTO fleet_snapshot_files (snapshot_id, node_id, node_name, stack_name, filename, content) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(id, LOCAL_NODE_ID, 'local', 'delim-healthy', 'compose.yaml', good);
        db.getDb().prepare(
            'INSERT INTO fleet_snapshot_files (snapshot_id, node_id, node_name, stack_name, filename, content) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(id, LOCAL_NODE_ID, 'local', 'delim-corrupt', 'compose.yaml', damaged);
        seedStackDir('delim-healthy');
        seedStackDir('delim-corrupt');
        fs.writeFileSync(composePath('delim-corrupt'), 'services:\n  keep: {}\n');

        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore-all`)
            .set('Cookie', adminCookie)
            .send({ redeploy: true });
        expect(res.status).toBe(200);
        expect(res.body.restored).toBe(1);
        expect(res.body.failed).toBe(1);
        const corrupt = (res.body.results as Array<{ stackName: string; success: boolean; error?: string }>)
            .find(r => r.stackName === 'delim-corrupt');
        expect(corrupt?.success).toBe(false);
        expect(fs.readFileSync(composePath('delim-corrupt'), 'utf-8')).toContain('keep: {}');
        expect(deploySpy).toHaveBeenCalledTimes(1);
        expect(deploySpy.mock.calls.every(call => call[0] !== 'delim-corrupt')).toBe(true);
    });

    it('redeploys each restored stack when requested', async () => {
        vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
        const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockResolvedValue({ recoveryId: null });
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
        expect(deploySpy).toHaveBeenCalledWith('redeploy-all-web', undefined, undefined, {
            source: 'fleet_snapshot',
            actor: 'system:fleet-snapshot',
        });
    });

    it('records a policy-blocked redeploy as a per-stack failure and still restores the rest', async () => {
        const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockResolvedValue({ recoveryId: null });
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
        expect(deploySpy).toHaveBeenCalledWith('ok-web', undefined, undefined, {
            source: 'fleet_snapshot',
            actor: 'system:fleet-snapshot',
        });
        expect(deploySpy.mock.calls.map((c) => c[0])).not.toContain('blocked-web');
    });
});

describe('Snapshot restore: recovery generation contract', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        StackOpLockService.resetForTests();
        DatabaseService.getInstance().getDb().prepare('DELETE FROM stack_update_recovery_generations').run();
    });

    function seedExistingStack(stack: string, compose: string, extraName?: string, extraContent?: string): void {
        seedStackDir(stack);
        fs.writeFileSync(composePath(stack), compose);
        if (extraName && extraContent !== undefined) {
            fs.writeFileSync(path.join(process.env.COMPOSE_DIR as string, stack, extraName), extraContent);
        }
    }

    function insertSnapshot(
        label: string,
        files: Array<{ nodeId: number; nodeName: string; stackName: string; filename: string; content: string }>,
        stackCount = 1,
    ): number {
        const db = DatabaseService.getInstance();
        const id = db.createSnapshot(label, 'admin', 1, stackCount, '[]', '[]');
        db.insertSnapshotFiles(id, files);
        return id;
    }

    function addRemoteNode(name: string): number {
        return DatabaseService.getInstance().addNode({
            name,
            type: 'remote',
            api_url: 'http://remote:1852',
            api_token: 'tok',
            compose_dir: '/app/compose',
            is_default: false,
        });
    }

    function stubRemoteProxy(): void {
        vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue({
            apiUrl: 'http://remote:1852',
            apiToken: 'tok',
        });
    }

    function sha256Text(text: string): string {
        return createHash('sha256').update(text, 'utf8').digest('hex');
    }

    function liveInventory(stack: string): ResolvedRollbackInventory {
        const stackDir = path.join(process.env.COMPOSE_DIR as string, stack);
        const entries: ResolvedRollbackInventory['entries'] = [{
            relativePath: 'compose.yaml',
            dependencyKind: 'compose-root',
            provenance: 'authored',
            sensitivity: 'low',
            absolutePath: path.join(stackDir, 'compose.yaml'),
        }];
        if (fs.existsSync(envPath(stack))) {
            entries.push({
                relativePath: '.env',
                dependencyKind: 'project-env',
                provenance: 'authored',
                sensitivity: 'low',
                absolutePath: envPath(stack),
            });
        }
        return {
            entries,
            invocation: {
                composeArgsPrefix: [],
                projectDirectory: null,
                projectName: stack,
                explicitComposeFiles: ['compose.yaml'],
                meshEnabled: false,
                meshOverrideRelativePath: null,
            },
            git: null,
            appliedDeploySpec: null,
            lastAppliedContentHash: null,
            manifestState: null,
            manifestGeneration: null,
            exactCoverage: true,
            coverageRefusal: null,
        };
    }

    async function persistPreRestoreGeneration(stack: string): Promise<string> {
        const id = randomUUID();
        await RollbackGenerationStore.captureGeneration({
            nodeId: LOCAL_NODE_ID,
            stackName: stack,
            generationId: id,
            inventory: liveInventory(stack),
            operationKind: 'manual_backup',
        });
        const now = Date.now();
        DatabaseService.getInstance().insertStackUpdateRecoveryGeneration({
            id,
            node_id: LOCAL_NODE_ID,
            stack_name: stack,
            status: 'active',
            phase: 'immediate_verified',
            is_current: 1,
            backup_slot_id: id,
            content_path: id,
            operation_kind: 'manual_backup',
            override_path: null,
            services_json: '[]',
            health_gate_id: null,
            gate_retain_until: null,
            artifact_expires_at: null,
            operation_lease_expires_at: null,
            created_at: now,
            updated_at: now,
            created_by: 'system:fleet-snapshot',
            artifacts_retired: 0,
            released_at: null,
            released_by: null,
        });
        return id;
    }

    function spyCaptureRecordingLive(stack: string): { composeAtCapture: string; envAtCapture: string } {
        const captured = { composeAtCapture: '', envAtCapture: '' };
        vi.spyOn(StackUpdateRecoveryService.getInstance(), 'captureCurrentBackup').mockImplementation(async () => {
            captured.composeAtCapture = fs.readFileSync(composePath(stack), 'utf-8');
            captured.envAtCapture = fs.existsSync(envPath(stack)) ? fs.readFileSync(envPath(stack), 'utf-8') : '';
            const id = await persistPreRestoreGeneration(stack);
            return { id } as never;
        });
        return captured;
    }

    function expectCurrentGenerationMatches(stack: string, compose: string, env: string): void {
        const current = StackUpdateRecoveryService.getInstance().getCurrent(LOCAL_NODE_ID, stack);
        expect(current?.id).toBeTruthy();
        const genDir = RollbackGenerationStore.getGenerationDir(LOCAL_NODE_ID, stack, current!.id);
        const manifest = JSON.parse(
            fs.readFileSync(path.join(genDir, 'generation.json'), 'utf-8'),
        ) as RollbackGenerationManifest;
        expect(manifest.entries.find((e) => e.relativePath === 'compose.yaml')?.contentSha256).toBe(sha256Text(compose));
        expect(manifest.entries.find((e) => e.relativePath === '.env')?.contentSha256).toBe(sha256Text(env));
    }

    it('captures the pre-restore multi-file project before overwriting compose.yaml', async () => {
        const id = insertSnapshot('restore-gen-local', [
            { nodeId: LOCAL_NODE_ID, nodeName: 'local', stackName: 'preimage-web', filename: 'compose.yaml', content: 'services:\n  snap: {}\n' },
            { nodeId: LOCAL_NODE_ID, nodeName: 'local', stackName: 'preimage-web', filename: '.env', content: 'SNAP=1\n' },
        ]);
        const preCompose = 'services:\n  old: {}\n';
        const preEnv = 'OLD=1\n';
        seedExistingStack('preimage-web', preCompose, 'extra.yml', 'x: 1\n');
        fs.writeFileSync(envPath('preimage-web'), preEnv);
        const captured = spyCaptureRecordingLive('preimage-web');

        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore`)
            .set('Cookie', adminCookie)
            .send({ nodeId: LOCAL_NODE_ID, stackName: 'preimage-web' });

        expect(res.status).toBe(200);
        expect(captured.composeAtCapture).toBe(preCompose);
        expect(captured.envAtCapture).toBe(preEnv);
        expect(fs.readFileSync(composePath('preimage-web'), 'utf-8')).toContain('snap: {}');
        expect(fs.readFileSync(envPath('preimage-web'), 'utf-8')).toContain('SNAP=1');
        expect(fs.readFileSync(path.join(process.env.COMPOSE_DIR as string, 'preimage-web', 'extra.yml'), 'utf-8')).toBe('x: 1\n');
        expectCurrentGenerationMatches('preimage-web', preCompose, preEnv);
    });

    it('does not mutate live files when capture fails', async () => {
        const id = insertSnapshot('restore-gen-fail', [
            { nodeId: LOCAL_NODE_ID, nodeName: 'local', stackName: 'fail-web', filename: 'compose.yaml', content: 'services:\n  snap: {}\n' },
        ]);
        const preCompose = 'services:\n  keep: {}\n';
        seedExistingStack('fail-web', preCompose);
        vi.spyOn(StackUpdateRecoveryService.getInstance(), 'captureCurrentBackup')
            .mockRejectedValue(new Error('generation capture failed'));

        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore`)
            .set('Cookie', adminCookie)
            .send({ nodeId: LOCAL_NODE_ID, stackName: 'fail-web' });

        expect(res.status).toBe(500);
        expect(fs.readFileSync(composePath('fail-web'), 'utf-8')).toBe(preCompose);
    });

    it('returns 409 and does not write when the stack operation lock is held', async () => {
        const id = insertSnapshot('restore-gen-lock', [
            { nodeId: LOCAL_NODE_ID, nodeName: 'local', stackName: 'lock-web', filename: 'compose.yaml', content: 'services:\n  snap: {}\n' },
        ]);
        const preCompose = 'services:\n  keep: {}\n';
        seedExistingStack('lock-web', preCompose);
        const captureSpy = vi.spyOn(StackUpdateRecoveryService.getInstance(), 'captureCurrentBackup')
            .mockResolvedValue({ id: 'gen-lock-web' } as never);
        StackOpLockService.getInstance().tryAcquire(LOCAL_NODE_ID, 'lock-web', 'deploy', 'other');

        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore`)
            .set('Cookie', adminCookie)
            .send({ nodeId: LOCAL_NODE_ID, stackName: 'lock-web' });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('stack_op_in_progress');
        expect(captureSpy).not.toHaveBeenCalled();
        expect(fs.readFileSync(composePath('lock-web'), 'utf-8')).toBe(preCompose);
    });

    it('keeps the captured generation when a later snapshot file write fails', async () => {
        const id = insertSnapshot('restore-gen-partial', [
            { nodeId: LOCAL_NODE_ID, nodeName: 'local', stackName: 'partial-web', filename: 'compose.yaml', content: 'services:\n  snap: {}\n' },
            { nodeId: LOCAL_NODE_ID, nodeName: 'local', stackName: 'partial-web', filename: '.env', content: 'SNAP=1\n' },
        ]);
        const preCompose = 'services:\n  old: {}\n';
        const preEnv = 'OLD=1\n';
        seedExistingStack('partial-web', preCompose);
        fs.writeFileSync(envPath('partial-web'), preEnv);
        const captured = spyCaptureRecordingLive('partial-web');
        vi.spyOn(FileSystemService.prototype, 'saveEnvContent').mockRejectedValue(new Error('disk full'));

        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore`)
            .set('Cookie', adminCookie)
            .send({ nodeId: LOCAL_NODE_ID, stackName: 'partial-web' });

        expect(res.status).toBe(500);
        expect(captured.composeAtCapture).toBe(preCompose);
        expect(captured.envAtCapture).toBe(preEnv);
        expect(fs.readFileSync(composePath('partial-web'), 'utf-8')).toContain('snap: {}');
        expect(fs.readFileSync(envPath('partial-web'), 'utf-8')).toBe(preEnv);
        expectCurrentGenerationMatches('partial-web', preCompose, preEnv);
    });

    it('does not capture a generation when restoring a stack that does not exist yet', async () => {
        const id = insertSnapshot('restore-gen-new', [
            { nodeId: LOCAL_NODE_ID, nodeName: 'local', stackName: 'brand-new', filename: 'compose.yaml', content: 'services:\n  snap: {}\n' },
        ]);
        seedStackDir('brand-new');
        const captureSpy = vi.spyOn(StackUpdateRecoveryService.getInstance(), 'captureCurrentBackup')
            .mockResolvedValue({ id: 'should-not-run' } as never);

        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore`)
            .set('Cookie', adminCookie)
            .send({ nodeId: LOCAL_NODE_ID, stackName: 'brand-new' });

        expect(res.status).toBe(200);
        expect(captureSpy).not.toHaveBeenCalled();
        expect(fs.readFileSync(composePath('brand-new'), 'utf-8')).toContain('snap: {}');
    });

    it('restore-all captures existing stacks and still restores siblings when one capture fails', async () => {
        const id = insertSnapshot('restore-all-gen', [
            { nodeId: LOCAL_NODE_ID, nodeName: 'local', stackName: 'all-keep', filename: 'compose.yaml', content: 'services:\n  keep: {}\n' },
            { nodeId: LOCAL_NODE_ID, nodeName: 'local', stackName: 'all-fail', filename: 'compose.yaml', content: 'services:\n  fail: {}\n' },
        ], 2);
        seedExistingStack('all-keep', 'services:\n  old-keep: {}\n');
        fs.writeFileSync(envPath('all-keep'), 'KEEP=1\n');
        seedExistingStack('all-fail', 'services:\n  old-fail: {}\n');
        fs.writeFileSync(envPath('all-fail'), 'FAIL=1\n');
        vi.spyOn(StackUpdateRecoveryService.getInstance(), 'captureCurrentBackup')
            .mockImplementation(async (input) => {
                if (input.stackName === 'all-fail') throw new Error('generation capture failed');
                const id = await persistPreRestoreGeneration(input.stackName);
                return { id } as never;
            });

        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore-all`)
            .set('Cookie', adminCookie)
            .send({});

        expect(res.status).toBe(200);
        expect(res.body.restored).toBe(1);
        expect(res.body.failed).toBe(1);
        const failed = (res.body.results as Array<{ stackName: string; success: boolean }>).find(r => r.stackName === 'all-fail');
        expect(failed?.success).toBe(false);
        expect(fs.readFileSync(composePath('all-keep'), 'utf-8')).toContain('keep: {}');
        expect(fs.readFileSync(composePath('all-fail'), 'utf-8')).toContain('old-fail: {}');
        expect(fs.readFileSync(envPath('all-fail'), 'utf-8')).toBe('FAIL=1\n');
        expectCurrentGenerationMatches('all-keep', 'services:\n  old-keep: {}\n', 'KEEP=1\n');
        expect(StackUpdateRecoveryService.getInstance().getCurrent(LOCAL_NODE_ID, 'all-fail')).toBeUndefined();
    });

    it('restores a remote stack through one node-local apply request', async () => {
        const remoteId = addRemoteNode('remote-gen');
        const id = insertSnapshot('restore-gen-remote', [
            { nodeId: remoteId, nodeName: 'remote-gen', stackName: 'rweb', filename: 'compose.yaml', content: 'services: {}\n' },
            { nodeId: remoteId, nodeName: 'remote-gen', stackName: 'rweb', filename: '.env', content: 'SNAP=1\n' },
        ]);
        stubRemoteProxy();
        const calls: Array<{ url: string; method?: string; body?: string }> = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: { method?: string; body?: string }) => {
            calls.push({ url, method: opts?.method, body: opts?.body });
            return { ok: true, status: 200, text: async () => '' } as unknown as Response;
        }));

        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore`)
            .set('Cookie', adminCookie)
            .send({ nodeId: remoteId, stackName: 'rweb' });

        expect(res.status).toBe(200);
        const applyCalls = calls.filter(c => c.url.includes('/fleet-snapshot-apply'));
        expect(applyCalls).toHaveLength(1);
        expect(applyCalls[0].method).toBe('POST');
        expect(applyCalls[0].body).toContain('compose.yaml');
        expect(applyCalls[0].body).toContain('.env');
        expect(calls.some(c => c.method === 'PUT' && /\/api\/stacks\/[^/]+$/.test(c.url))).toBe(false);
        expect(calls.some(c => c.method === 'PUT' && /\/env$/.test(c.url))).toBe(false);
    });

    it('fails a remote restore without writing when the node-local apply returns 409', async () => {
        const remoteId = addRemoteNode('remote-lock');
        const id = insertSnapshot('restore-gen-remote-lock', [
            { nodeId: remoteId, nodeName: 'remote-lock', stackName: 'rlock', filename: 'compose.yaml', content: 'services: {}\n' },
        ]);
        stubRemoteProxy();
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: false,
            status: 409,
            text: async () => JSON.stringify({ error: 'locked', code: 'stack_op_in_progress' }),
        } as unknown as Response)));

        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore`)
            .set('Cookie', adminCookie)
            .send({ nodeId: remoteId, stackName: 'rlock' });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('stack_op_in_progress');
    });

    it('does not invent stack_op_in_progress from a bare remote 409', async () => {
        const remoteId = addRemoteNode('remote-bare-409');
        const id = insertSnapshot('restore-gen-remote-bare-409', [
            { nodeId: remoteId, nodeName: 'remote-bare-409', stackName: 'rbare', filename: 'compose.yaml', content: 'services: {}\n' },
        ]);
        stubRemoteProxy();
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: false,
            status: 409,
            text: async () => JSON.stringify({ error: 'conflict' }),
        } as unknown as Response)));

        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore`)
            .set('Cookie', adminCookie)
            .send({ nodeId: remoteId, stackName: 'rbare' });

        expect(res.status).toBe(500);
        expect(res.body.code).toBeUndefined();
    });

    it('restore-all sends one node-local apply per remote stack', async () => {
        const remoteId = addRemoteNode('remote-all');
        const id = insertSnapshot('restore-all-gen-remote', [
            { nodeId: remoteId, nodeName: 'remote-all', stackName: 'ra', filename: 'compose.yaml', content: 'services:\n  a: {}\n' },
            { nodeId: remoteId, nodeName: 'remote-all', stackName: 'rb', filename: 'compose.yaml', content: 'services:\n  b: {}\n' },
        ], 2);
        stubRemoteProxy();
        const urls: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            urls.push(url);
            return { ok: true, status: 200, text: async () => '' } as unknown as Response;
        }));

        const res = await request(app)
            .post(`/api/fleet/snapshots/${id}/restore-all`)
            .set('Cookie', adminCookie)
            .send({});

        expect(res.status).toBe(200);
        expect(res.body.restored).toBe(2);
        expect(urls.filter(u => u.includes('/fleet-snapshot-apply'))).toHaveLength(2);
        expect(urls.some(u => /\/api\/stacks\/[^/]+$/.test(u))).toBe(false);
    });

    it('POST /api/stacks/:stackName/fleet-snapshot-apply returns 403 for a viewer', async () => {
        const res = await request(app)
            .post('/api/stacks/preimage-web/fleet-snapshot-apply')
            .set('Cookie', viewerCookie)
            .send({ files: [{ filename: 'compose.yaml', content: 'services: {}\n' }] });
        expect(res.status).toBe(403);
    });

    it('POST /api/stacks/:stackName/fleet-snapshot-apply captures an existing stack before writing', async () => {
        const preCompose = 'services:\n  old: {}\n';
        const preEnv = 'OLD=1\n';
        seedExistingStack('apply-existing', preCompose);
        fs.writeFileSync(envPath('apply-existing'), preEnv);
        spyCaptureRecordingLive('apply-existing');

        const res = await request(app)
            .post('/api/stacks/apply-existing/fleet-snapshot-apply')
            .set('Cookie', adminCookie)
            .send({
                files: [
                    { filename: 'compose.yaml', content: 'services:\n  snap: {}\n' },
                    { filename: '.env', content: 'SNAP=1\n' },
                ],
            });

        expect(res.status).toBe(200);
        expect(res.body.capturedGenerationId).toBe(
            StackUpdateRecoveryService.getInstance().getCurrent(LOCAL_NODE_ID, 'apply-existing')?.id,
        );
        expect(fs.readFileSync(composePath('apply-existing'), 'utf-8')).toContain('snap: {}');
        expect(fs.readFileSync(envPath('apply-existing'), 'utf-8')).toBe('SNAP=1\n');
        expectCurrentGenerationMatches('apply-existing', preCompose, preEnv);
    });

    it('POST /api/stacks/:stackName/fleet-snapshot-apply returns 400 when no restoreable files remain', async () => {
        seedStackDir('apply-empty');
        const res = await request(app)
            .post('/api/stacks/apply-empty/fleet-snapshot-apply')
            .set('Cookie', adminCookie)
            .send({ files: [{ filename: 'notes.txt', content: 'nope\n' }] });
        expect(res.status).toBe(400);
        expect(fs.existsSync(composePath('apply-empty'))).toBe(false);
    });

    it('POST /api/stacks/:stackName/fleet-snapshot-apply ignores extra filenames', async () => {
        seedStackDir('apply-extra');
        const res = await request(app)
            .post('/api/stacks/apply-extra/fleet-snapshot-apply')
            .set('Cookie', adminCookie)
            .send({
                files: [
                    { filename: 'compose.yaml', content: 'services:\n  snap: {}\n' },
                    { filename: 'notes.txt', content: 'should-not-write\n' },
                    { filename: '.env', content: 'SNAP=1\n' },
                ],
            });
        expect(res.status).toBe(200);
        expect(fs.readFileSync(composePath('apply-extra'), 'utf-8')).toContain('snap: {}');
        expect(fs.readFileSync(envPath('apply-extra'), 'utf-8')).toBe('SNAP=1\n');
        expect(fs.existsSync(path.join(process.env.COMPOSE_DIR as string, 'apply-extra', 'notes.txt'))).toBe(false);
    });

    it('POST /api/stacks/:stackName/fleet-snapshot-apply accepts a combined body over 100 KB', async () => {
        seedStackDir('apply-large');
        const compose = `services:\n  snap:\n    image: nginx\n    labels:\n      note: "${'x'.repeat(150 * 1024)}"\n`;
        const res = await request(app)
            .post('/api/stacks/apply-large/fleet-snapshot-apply')
            .set('Cookie', adminCookie)
            .send({ files: [{ filename: 'compose.yaml', content: compose }] });
        expect(res.status).toBe(200);
        expect(fs.readFileSync(composePath('apply-large'), 'utf-8')).toBe(compose);
    });
});
