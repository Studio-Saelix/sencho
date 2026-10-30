/**
 * Tests for /api/cloud-backup routes — tier gating (community vs paid),
 * admin gating, config CRUD round-trip with secret encryption, audit logging.
 * The S3 SDK is mocked at the module level so no network calls happen.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'stream';
import * as zlib from 'zlib';
import * as tar from 'tar-stream';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import { encryptArchive } from '../services/cloudBackupArchive';

const sentSpy = vi.fn();

vi.mock('@aws-sdk/client-s3', () => {
    class S3Client { async send(cmd: { name: string; input: Record<string, unknown> }) { return sentSpy(cmd); } }
    class PutObjectCommand { name = 'PutObjectCommand'; constructor(public input: Record<string, unknown>) {} }
    class GetObjectCommand { name = 'GetObjectCommand'; constructor(public input: Record<string, unknown>) {} }
    class ListObjectsV2Command { name = 'ListObjectsV2Command'; constructor(public input: Record<string, unknown>) {} }
    class DeleteObjectCommand { name = 'DeleteObjectCommand'; constructor(public input: Record<string, unknown>) {} }
    class HeadBucketCommand { name = 'HeadBucketCommand'; constructor(public input: Record<string, unknown>) {} }
    return { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand, HeadBucketCommand };
});

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let authCookie: string;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ LicenseService } = await import('../services/LicenseService'));

    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');

    ({ app } = await import('../index'));
    authCookie = await loginAsTestAdmin(app);
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

beforeEach(() => {
    sentSpy.mockReset();
    const db = DatabaseService.getInstance();
    for (const k of [
        'cloud_backup_provider',
        'cloud_backup_endpoint',
        'cloud_backup_region',
        'cloud_backup_bucket',
        'cloud_backup_access_key',
        'cloud_backup_secret_key',
        'cloud_backup_path_prefix',
        'cloud_backup_auto_upload',
        'cloud_backup_encrypt_archives',
        'cloud_backup_archive_passphrase',
    ]) {
        db.updateGlobalSetting(k, '');
    }
});

// Sticky mocks (mockReturnValue, not mockReturnValueOnce) so a test that does
// not actually hit a tier-gated codepath doesn't leak its persona into later
// tests. The afterEach hook resets back to the paid baseline.
function mockCommunity() {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
}

afterEach(() => {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
});

const customConfigBody = {
    provider: 'custom',
    custom: {
        endpoint: 'https://s3.example.com',
        region: 'us-east-1',
        bucket: 'b',
        access_key: 'a',
        secret_key: 's',
        path_prefix: 'p/',
        auto_upload: false,
    },
};

describe('Cloud backup tier gating', () => {
    // GET /config is ungated — every tier can read the stored configuration.
    it('GET /config is readable on Community', async () => {
        mockCommunity();
        const res = await request(app).get('/api/cloud-backup/config').set('Cookie', authCookie);
        expect(res.status).toBe(200);
    });

    it('GET /config is readable on the paid tier', async () => {
        const res = await request(app).get('/api/cloud-backup/config').set('Cookie', authCookie);
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('provider', 'disabled');
    });

    // PUT /config: 'custom' is available on every tier, 'sencho' is paid-only.
    it('PUT /config with provider=custom succeeds on Community', async () => {
        mockCommunity();
        const res = await request(app).put('/api/cloud-backup/config').set('Cookie', authCookie).send(customConfigBody);
        expect(res.status).toBe(204);
    });

    it('PUT /config with provider=sencho is rejected on Community with PAID_REQUIRED', async () => {
        mockCommunity();
        const res = await request(app).put('/api/cloud-backup/config').set('Cookie', authCookie).send({ provider: 'sencho' });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('PAID_REQUIRED');
    });

    // POST /provision is paid-only by definition (Sencho Snapshot Vault activation).
    it('POST /provision is rejected on Community', async () => {
        mockCommunity();
        const res = await request(app).post('/api/cloud-backup/provision').set('Cookie', authCookie);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('PAID_REQUIRED');
    });

    // GET /usage is paid-only (sencho-specific endpoint).
    it('GET /usage is rejected on Community', async () => {
        mockCommunity();
        const res = await request(app).get('/api/cloud-backup/usage').set('Cookie', authCookie);
        expect(res.status).toBe(403);
    });

    // POST /test, GET /snapshots, POST /upload, GET /status, GET /object/.../download,
    // DELETE /object are gated by the *currently saved* provider.
    it('POST /test reaches handler on Community when saved provider is custom', async () => {
        DatabaseService.getInstance().updateGlobalSetting('cloud_backup_provider', 'custom');
        mockCommunity();
        const res = await request(app).post('/api/cloud-backup/test').set('Cookie', authCookie);
        expect(res.status).not.toBe(403);
    });

    it('POST /test is rejected on Community when saved provider is sencho', async () => {
        DatabaseService.getInstance().updateGlobalSetting('cloud_backup_provider', 'sencho');
        mockCommunity();
        const res = await request(app).post('/api/cloud-backup/test').set('Cookie', authCookie);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('PAID_REQUIRED');
    });

    it('GET /snapshots reaches handler on Community when saved provider is custom', async () => {
        DatabaseService.getInstance().updateGlobalSetting('cloud_backup_provider', 'custom');
        mockCommunity();
        const res = await request(app).get('/api/cloud-backup/snapshots').set('Cookie', authCookie);
        expect(res.status).not.toBe(403);
    });

    it('GET /snapshots is rejected on Community when saved provider is sencho', async () => {
        DatabaseService.getInstance().updateGlobalSetting('cloud_backup_provider', 'sencho');
        mockCommunity();
        const res = await request(app).get('/api/cloud-backup/snapshots').set('Cookie', authCookie);
        expect(res.status).toBe(403);
    });

    // The paid tier retains access to every endpoint.
    it('a paid admin can configure provider=sencho', async () => {
        const res = await request(app).put('/api/cloud-backup/config').set('Cookie', authCookie).send({ provider: 'sencho' });
        expect(res.status).toBe(204);
    });
});

describe('Cloud backup read routes are admin-only', () => {
    // The archive download returns plaintext compose/.env, so listing and
    // downloading cloud snapshots must be admin-gated like the local snapshot
    // reads, regardless of provider/tier.
    let viewerCookie: string;
    const keyB64 = Buffer.from('sencho/instances/x/snapshots/1.tar.gz').toString('base64url');

    beforeAll(async () => {
        const db = DatabaseService.getInstance();
        const bcrypt = (await import('bcrypt')).default;
        const hash = await bcrypt.hash('cloud-viewer-pass', 1);
        try { db.addUser({ username: 'cloud-viewer', password_hash: hash, role: 'viewer' }); } catch { /* may already exist */ }
        const login = await request(app).post('/api/auth/login').send({ username: 'cloud-viewer', password: 'cloud-viewer-pass' });
        const cookies = login.headers['set-cookie'] as string | string[];
        viewerCookie = Array.isArray(cookies) ? cookies[0] : cookies;
    });

    it('GET /snapshots returns 403 for a non-admin', async () => {
        const res = await request(app).get('/api/cloud-backup/snapshots').set('Cookie', viewerCookie);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ADMIN_REQUIRED');
    });

    it('GET /status/:id returns 403 for a non-admin', async () => {
        const res = await request(app).get('/api/cloud-backup/status/1').set('Cookie', viewerCookie);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ADMIN_REQUIRED');
    });

    it('GET /object/:keyB64/download returns 403 for a non-admin', async () => {
        const res = await request(app).get(`/api/cloud-backup/object/${keyB64}/download`).set('Cookie', viewerCookie);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ADMIN_REQUIRED');
    });

    it('POST download and import return 403 for a non-admin', async () => {
        const download = await request(app).post(`/api/cloud-backup/object/${keyB64}/download`).set('Cookie', viewerCookie).send({});
        const imported = await request(app).post(`/api/cloud-backup/object/${keyB64}/import`).set('Cookie', viewerCookie).send({});
        expect(download.status).toBe(403);
        expect(download.body.code).toBe('ADMIN_REQUIRED');
        expect(imported.status).toBe(403);
        expect(imported.body.code).toBe('ADMIN_REQUIRED');
    });

    it('does not block an admin on GET /snapshots', async () => {
        const res = await request(app).get('/api/cloud-backup/snapshots').set('Cookie', authCookie);
        expect(res.status).not.toBe(403);
    });
});

describe('Cloud backup config CRUD', () => {
    it('redacts secret_key on read; persists encrypted ciphertext', async () => {
        const putRes = await request(app)
            .put('/api/cloud-backup/config')
            .set('Cookie', authCookie)
            .send({
                provider: 'custom',
                custom: {
                    endpoint: 'https://s3.example.com',
                    region: 'us-east-1',
                    bucket: 'b',
                    access_key: 'AKIA1234',
                    secret_key: 'super-secret',
                    path_prefix: 'sencho/',
                    auto_upload: true,
                },
            });
        expect(putRes.status).toBe(204);

        const stored = DatabaseService.getInstance().getGlobalSettings().cloud_backup_secret_key;
        expect(stored.startsWith('enc:')).toBe(true);
        expect(stored.includes('super-secret')).toBe(false);

        const getRes = await request(app).get('/api/cloud-backup/config').set('Cookie', authCookie);
        expect(getRes.status).toBe(200);
        expect(getRes.body.provider).toBe('custom');
        expect(getRes.body.custom.secret_key).toBe('***');
        expect(getRes.body.custom.bucket).toBe('b');
    });

    it('preserves saved secret when client sends "***"', async () => {
        const db = DatabaseService.getInstance();
        await request(app)
            .put('/api/cloud-backup/config')
            .set('Cookie', authCookie)
            .send({
                provider: 'custom',
                custom: { endpoint: 'https://e', region: 'r', bucket: 'b', access_key: 'a', secret_key: 'first-secret', path_prefix: 's/', auto_upload: false },
            });
        const firstStored = db.getGlobalSettings().cloud_backup_secret_key;

        await request(app)
            .put('/api/cloud-backup/config')
            .set('Cookie', authCookie)
            .send({
                provider: 'custom',
                custom: { endpoint: 'https://e', region: 'r2', bucket: 'b', access_key: 'a', secret_key: '***', path_prefix: 's/', auto_upload: true },
            });
        const secondStored = db.getGlobalSettings().cloud_backup_secret_key;
        expect(secondStored).toBe(firstStored);
        expect(db.getGlobalSettings().cloud_backup_region).toBe('r2');
        expect(db.getGlobalSettings().cloud_backup_auto_upload).toBe('1');
    });

    it('rejects invalid provider value', async () => {
        const res = await request(app)
            .put('/api/cloud-backup/config')
            .set('Cookie', authCookie)
            .send({ provider: 'bogus' });
        expect(res.status).toBe(400);
    });

    it('rejects custom config missing required fields', async () => {
        const res = await request(app)
            .put('/api/cloud-backup/config')
            .set('Cookie', authCookie)
            .send({ provider: 'custom', custom: { endpoint: '', bucket: '', access_key: '' } });
        expect(res.status).toBe(400);
    });
});

describe('Cloud backup archive passphrase', () => {
    const passphrase = 'correct-horse';

    it('rejects the first enable when the passphrase is missing or a placeholder', async () => {
        const empty = await request(app).put('/api/cloud-backup/config').set('Cookie', authCookie).send({
            ...customConfigBody,
            encrypt_archives: true,
            archive_passphrase: '',
        });
        expect(empty.status).toBe(400);

        const placeholder = await request(app).put('/api/cloud-backup/config').set('Cookie', authCookie).send({
            ...customConfigBody,
            encrypt_archives: true,
            archive_passphrase: '***',
        });
        expect(placeholder.status).toBe(400);
        const settings = DatabaseService.getInstance().getGlobalSettings();
        expect(settings.cloud_backup_encrypt_archives).not.toBe('1');
        expect(settings.cloud_backup_provider).toBe('');
    });

    it('rejects a passphrase shorter than 12 characters', async () => {
        const res = await request(app).put('/api/cloud-backup/config').set('Cookie', authCookie).send({
            ...customConfigBody,
            encrypt_archives: true,
            archive_passphrase: 'too-short',
        });
        expect(res.status).toBe(400);
    });

    it('stores the passphrase encrypted, redacts it, and keeps it across a placeholder save', async () => {
        const db = DatabaseService.getInstance();
        const save = await request(app).put('/api/cloud-backup/config').set('Cookie', authCookie).send({
            ...customConfigBody,
            encrypt_archives: true,
            archive_passphrase: passphrase,
        });
        expect(save.status).toBe(204);
        const stored = db.getGlobalSettings().cloud_backup_archive_passphrase;
        expect(stored.startsWith('enc:')).toBe(true);
        expect(stored.includes(passphrase)).toBe(false);

        const read = await request(app).get('/api/cloud-backup/config').set('Cookie', authCookie);
        expect(read.body.encrypt_archives).toBe(true);
        expect(read.body.archive_passphrase).toBe('***');

        const again = await request(app).put('/api/cloud-backup/config').set('Cookie', authCookie).send({
            ...customConfigBody,
            encrypt_archives: true,
            archive_passphrase: '***',
        });
        expect(again.status).toBe(204);
        expect(db.getGlobalSettings().cloud_backup_archive_passphrase).toBe(stored);

        const off = await request(app).put('/api/cloud-backup/config').set('Cookie', authCookie).send({
            ...customConfigBody,
            encrypt_archives: false,
        });
        expect(off.status).toBe(204);
        expect(db.getGlobalSettings().cloud_backup_encrypt_archives).toBe('0');
        expect(db.getGlobalSettings().cloud_backup_archive_passphrase).toBe(stored);
    });
});

describe('Cloud backup object prefix', () => {
    it('rejects download, import, and delete outside the snapshot prefix', async () => {
        await request(app).put('/api/cloud-backup/config').set('Cookie', authCookie).send(customConfigBody);
        const key = Buffer.from('elsewhere/instances/x/snapshots/1.tar.gz').toString('base64url');
        const download = await request(app).get(`/api/cloud-backup/object/${key}/download`).set('Cookie', authCookie);
        const imported = await request(app).post(`/api/cloud-backup/object/${key}/import`).set('Cookie', authCookie).send({});
        const deleted = await request(app).delete(`/api/cloud-backup/object/${key}`).set('Cookie', authCookie);
        expect(download.status).toBe(400);
        expect(imported.status).toBe(400);
        expect(deleted.status).toBe(400);
    });

    it('asks for a passphrase when an encrypted object has none stored', async () => {
        await request(app).put('/api/cloud-backup/config').set('Cookie', authCookie).send(customConfigBody);
        DatabaseService.getInstance().setSystemState('instance_id', 'inst');
        const objectKey = 'p/instances/inst/snapshots/1.tar.gz.senc';
        const blob = await encryptArchive(Buffer.from('hello'), 'correct-horse');
        sentSpy.mockResolvedValue({ Body: Readable.from(blob) });
        const key = Buffer.from(objectKey).toString('base64url');
        const res = await request(app).get(`/api/cloud-backup/object/${key}/download`).set('Cookie', authCookie);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('PASSPHRASE_REQUIRED');
    });

    it('returns gzip when the download body carries the passphrase', async () => {
        await request(app).put('/api/cloud-backup/config').set('Cookie', authCookie).send(customConfigBody);
        DatabaseService.getInstance().setSystemState('instance_id', 'inst');
        const gzip = zlib.gzipSync(Buffer.from('sealed-bytes'));
        const blob = await encryptArchive(gzip, 'correct-horse');
        sentSpy.mockResolvedValue({ Body: Readable.from(blob) });
        const key = Buffer.from('p/instances/inst/snapshots/1.tar.gz.senc').toString('base64url');
        const res = await request(app)
            .post(`/api/cloud-backup/object/${key}/download`)
            .set('Cookie', authCookie)
            .send({ passphrase: 'correct-horse' })
            .buffer(true)
            .parse((parserRes, callback) => {
                const chunks: Buffer[] = [];
                parserRes.on('data', (chunk: Buffer) => chunks.push(chunk));
                parserRes.on('end', () => callback(null, Buffer.concat(chunks)));
            });
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/gzip/);
        expect(zlib.gunzipSync(res.body).toString()).toBe('sealed-bytes');
    });
});

describe('Cloud backup audit log', () => {
    it('writes audit row with the cloud-backup summary on PUT /config', async () => {
        await request(app)
            .put('/api/cloud-backup/config')
            .set('Cookie', authCookie)
            .send({
                provider: 'custom',
                custom: { endpoint: 'https://s3.example.com', region: 'r', bucket: 'b', access_key: 'a', secret_key: 's', path_prefix: 'p/', auto_upload: false },
            });
        const { entries } = DatabaseService.getInstance().getAuditLogs({ limit: 50 });
        const cloudEntry = entries.find(e => e.path.includes('/cloud-backup/config') && e.method === 'PUT');
        expect(cloudEntry).toBeDefined();
        expect(cloudEntry!.summary).toBe('Updated cloud backup config');
    });
});

describe('Cloud backup test endpoint', () => {
    it('reports failure when no provider is configured', async () => {
        const res = await request(app).post('/api/cloud-backup/test').set('Cookie', authCookie).send({});
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(false);
    });

    it('reports success when HeadBucketCommand resolves', async () => {
        const db = DatabaseService.getInstance();
        const { CryptoService } = await import('../services/CryptoService');
        db.updateGlobalSetting('cloud_backup_provider', 'custom');
        db.updateGlobalSetting('cloud_backup_endpoint', 'https://s3.example.com');
        db.updateGlobalSetting('cloud_backup_region', 'us-east-1');
        db.updateGlobalSetting('cloud_backup_bucket', 'b');
        db.updateGlobalSetting('cloud_backup_access_key', 'a');
        db.updateGlobalSetting('cloud_backup_secret_key', CryptoService.getInstance().encrypt('s'));

        sentSpy.mockResolvedValueOnce({});
        const res = await request(app).post('/api/cloud-backup/test').set('Cookie', authCookie).send({});
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

describe('Sencho Snapshot Vault provisioning', () => {
    let CloudBackupService: typeof import('../services/CloudBackupService').CloudBackupService;

    beforeAll(async () => {
        ({ CloudBackupService } = await import('../services/CloudBackupService'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
        DatabaseService.getInstance().setSystemState('license_key', '');
    });

    it('records the provision call as "Provisioned Sencho Snapshot Vault" in the audit log', async () => {
        vi.spyOn(CloudBackupService.getInstance(), 'provisionSenchoCloudBackup').mockResolvedValue({ success: true, quotaBytes: 1024 });
        const res = await request(app).post('/api/cloud-backup/provision').set('Cookie', authCookie);
        expect(res.status).toBe(200);
        const { entries } = DatabaseService.getInstance().getAuditLogs({ limit: 50 });
        const entry = entries.find(e => e.path.includes('/cloud-backup/provision') && e.method === 'POST');
        expect(entry).toBeDefined();
        expect(entry!.summary).toBe('Provisioned Sencho Snapshot Vault');
    });

    it('names Sencho Snapshot Vault when provisioning throws unexpectedly', async () => {
        vi.spyOn(CloudBackupService.getInstance(), 'provisionSenchoCloudBackup').mockRejectedValue(new Error('boom'));
        const res = await request(app).post('/api/cloud-backup/provision').set('Cookie', authCookie);
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Failed to provision Sencho Snapshot Vault');
    });

    it('refuses provisioning below Admiral at the service level with the renamed message', async () => {
        DatabaseService.getInstance().setSystemState('license_key', 'AAAAA-BBBBB-CCCCC-DDDDD');
        mockCommunity();
        const result = await CloudBackupService.getInstance().provisionSenchoCloudBackup();
        expect(result).toEqual({ success: false, error: 'Sencho Snapshot Vault requires the Admiral tier.' });
    });

    it('GET /usage names Sencho Snapshot Vault when another provider is saved', async () => {
        DatabaseService.getInstance().updateGlobalSetting('cloud_backup_provider', 'custom');
        const res = await request(app).get('/api/cloud-backup/usage').set('Cookie', authCookie);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Usage is only available for Sencho Snapshot Vault');
    });
});

describe('Cloud backup encryption writes its own settings only', () => {
    it('saves encryption without submitting or changing the destination', async () => {
        const db = DatabaseService.getInstance();
        await request(app).put('/api/cloud-backup/config').set('Cookie', authCookie).send({
            provider: 'custom',
            custom: {
                endpoint: 'https://saved.example.com',
                region: 'saved-region',
                bucket: 'saved-bucket',
                access_key: 'saved-key',
                secret_key: 'saved-secret',
                path_prefix: 'saved/',
                auto_upload: true,
            },
        });
        const before = db.getGlobalSettings();

        const res = await request(app).put('/api/cloud-backup/config').set('Cookie', authCookie).send({
            encrypt_archives: true,
            archive_passphrase: 'correct-horse-battery',
        });
        expect(res.status).toBe(204);

        const after = db.getGlobalSettings();
        expect(after.cloud_backup_encrypt_archives).toBe('1');
        expect(after.cloud_backup_archive_passphrase.startsWith('enc:')).toBe(true);
        expect(after.cloud_backup_provider).toBe(before.cloud_backup_provider);
        expect(after.cloud_backup_endpoint).toBe(before.cloud_backup_endpoint);
        expect(after.cloud_backup_region).toBe(before.cloud_backup_region);
        expect(after.cloud_backup_bucket).toBe(before.cloud_backup_bucket);
        expect(after.cloud_backup_access_key).toBe(before.cloud_backup_access_key);
        expect(after.cloud_backup_secret_key).toBe(before.cloud_backup_secret_key);
        expect(after.cloud_backup_path_prefix).toBe(before.cloud_backup_path_prefix);
        expect(after.cloud_backup_auto_upload).toBe(before.cloud_backup_auto_upload);
    });

    it('accepts an encryption-only write on Community when the saved provider is custom', async () => {
        await request(app).put('/api/cloud-backup/config').set('Cookie', authCookie).send(customConfigBody);
        mockCommunity();
        const res = await request(app).put('/api/cloud-backup/config').set('Cookie', authCookie).send({
            encrypt_archives: true,
            archive_passphrase: 'correct-horse-battery',
        });
        expect(res.status).toBe(204);
    });

    it('rejects a write that carries no change', async () => {
        const res = await request(app).put('/api/cloud-backup/config').set('Cookie', authCookie).send({});
        expect(res.status).toBe(400);
    });
});

describe('Cloud backup recovery', () => {
    const recoveryKey = 'p/instances/old-instance/snapshots/5_2026-01-01_sealed.tar.gz.senc';
    const passphrase = 'correct-horse-battery';

    async function sealedArchiveObject(instanceId: string): Promise<Buffer> {
        const pack = tar.pack();
        pack.entry({ name: 'metadata.json' }, JSON.stringify({
            description: 'from the old instance',
            created_by: 'ada',
            created_at: 1_700_000_000_000,
            node_count: 1,
            stack_count: 1,
            skipped_nodes: [],
            skipped_stacks: [],
            instance_id: instanceId,
            archive_version: 2,
        }));
        pack.entry({ name: 'nodes/1_original/web/compose.yaml' }, 'services: {}\n');
        pack.finalize();
        const gzip = zlib.createGzip();
        const chunks: Buffer[] = [];
        const plain = await new Promise<Buffer>((resolve, reject) => {
            gzip.on('data', (chunk: Buffer) => chunks.push(chunk));
            gzip.on('end', () => resolve(Buffer.concat(chunks)));
            gzip.on('error', reject);
            pack.on('error', reject);
            pack.pipe(gzip);
        });
        return encryptArchive(plain, passphrase);
    }

    it('lists only other instances archives', async () => {
        await request(app).put('/api/cloud-backup/config').set('Cookie', authCookie).send(customConfigBody);
        DatabaseService.getInstance().setSystemState('instance_id', 'new-instance');
        sentSpy.mockResolvedValue({
            Contents: [
                { Key: 'p/instances/new-instance/snapshots/1_mine.tar.gz.senc', Size: 1, LastModified: new Date('2026-01-01T00:00:00Z') },
                { Key: recoveryKey, Size: 2, LastModified: new Date('2026-02-01T00:00:00Z') },
            ],
        });
        const res = await request(app).get('/api/cloud-backup/recovery-archives').set('Cookie', authCookie);
        expect(res.status).toBe(200);
        expect(res.body.entries.map((entry: { objectKey: string }) => entry.objectKey)).toEqual([recoveryKey]);
        expect(res.body.truncated).toBe(false);
    });

    it('requires a passphrase and refuses a plaintext archive', async () => {
        await request(app).put('/api/cloud-backup/config').set('Cookie', authCookie).send(customConfigBody);
        DatabaseService.getInstance().setSystemState('instance_id', 'new-instance');

        const missing = await request(app).post('/api/cloud-backup/recover').set('Cookie', authCookie).send({ object_key: recoveryKey });
        expect(missing.status).toBe(409);
        expect(missing.body.code).toBe('PASSPHRASE_REQUIRED');

        sentSpy.mockResolvedValue({ Body: Readable.from(zlib.gzipSync(Buffer.from('plain'))) });
        const plaintext = await request(app).post('/api/cloud-backup/recover').set('Cookie', authCookie)
            .send({ object_key: recoveryKey, passphrase });
        expect(plaintext.status).toBe(400);
        expect(plaintext.body.error).toMatch(/Only an encrypted archive/);
    });

    it('recovers a sealed archive after the instance identity changed', async () => {
        await request(app).put('/api/cloud-backup/config').set('Cookie', authCookie).send(customConfigBody);
        const db = DatabaseService.getInstance();
        db.setSystemState('instance_id', 'new-instance');
        const blob = await sealedArchiveObject('old-instance');
        sentSpy.mockResolvedValue({ Body: Readable.from(blob) });

        const res = await request(app).post('/api/cloud-backup/recover').set('Cookie', authCookie)
            .send({ object_key: recoveryKey, passphrase });
        expect(res.status).toBe(201);
        const imported = db.getSnapshot(res.body.snapshot_id)!;
        expect(imported.source_instance_id).toBe('old-instance');
        expect(imported.description).toBe('from the old instance');
        expect(imported.warnings_known).toBe(1);
    });

    it('rejects a recovery key outside the bucket snapshot area', async () => {
        await request(app).put('/api/cloud-backup/config').set('Cookie', authCookie).send(customConfigBody);
        const res = await request(app).post('/api/cloud-backup/recover').set('Cookie', authCookie)
            .send({ object_key: 'p/elsewhere/1.tar.gz.senc', passphrase });
        expect(res.status).toBe(400);
    });

    it('requires authentication', async () => {
        const res = await request(app).post('/api/cloud-backup/recover').send({ object_key: recoveryKey, passphrase });
        expect(res.status).toBe(401);
    });
});
