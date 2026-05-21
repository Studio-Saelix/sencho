/**
 * Tests for /api/cloud-backup routes — tier gating (community/skipper/admiral),
 * admin gating, config CRUD round-trip with secret encryption, audit logging.
 * The S3 SDK is mocked at the module level so no network calls happen.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

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
    vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue('admiral');

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
    ]) {
        db.updateGlobalSetting(k, '');
    }
});

// Sticky mocks (mockReturnValue, not mockReturnValueOnce) so a test that does
// not actually hit a tier-gated codepath doesn't leak its persona into later
// tests. The afterEach hook resets back to the Admiral baseline.
function mockCommunity() {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
}

function mockSkipper() {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
    vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue('skipper');
}

afterEach(() => {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
    vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue('admiral');
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

    it('GET /config is readable on Skipper', async () => {
        mockSkipper();
        const res = await request(app).get('/api/cloud-backup/config').set('Cookie', authCookie);
        expect(res.status).toBe(200);
    });

    it('GET /config is readable on Admiral', async () => {
        const res = await request(app).get('/api/cloud-backup/config').set('Cookie', authCookie);
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('provider', 'disabled');
    });

    // PUT /config: 'custom' is available on every tier, 'sencho' is Admiral-only.
    it('PUT /config with provider=custom succeeds on Community', async () => {
        mockCommunity();
        const res = await request(app).put('/api/cloud-backup/config').set('Cookie', authCookie).send(customConfigBody);
        expect(res.status).toBe(204);
    });

    it('PUT /config with provider=custom succeeds on Skipper', async () => {
        mockSkipper();
        const res = await request(app).put('/api/cloud-backup/config').set('Cookie', authCookie).send(customConfigBody);
        expect(res.status).toBe(204);
    });

    it('PUT /config with provider=sencho is rejected on Community with PAID_REQUIRED', async () => {
        mockCommunity();
        const res = await request(app).put('/api/cloud-backup/config').set('Cookie', authCookie).send({ provider: 'sencho' });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('PAID_REQUIRED');
    });

    it('PUT /config with provider=sencho is rejected on Skipper with ADMIRAL_REQUIRED', async () => {
        mockSkipper();
        const res = await request(app).put('/api/cloud-backup/config').set('Cookie', authCookie).send({ provider: 'sencho' });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ADMIRAL_REQUIRED');
    });

    // POST /provision is Admiral-only by definition (Sencho Cloud Backup activation).
    it('POST /provision is rejected on Community', async () => {
        mockCommunity();
        const res = await request(app).post('/api/cloud-backup/provision').set('Cookie', authCookie);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('PAID_REQUIRED');
    });

    it('POST /provision is rejected on Skipper', async () => {
        mockSkipper();
        const res = await request(app).post('/api/cloud-backup/provision').set('Cookie', authCookie);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ADMIRAL_REQUIRED');
    });

    // GET /usage is Admiral-only (sencho-specific endpoint).
    it('GET /usage is rejected on Community', async () => {
        mockCommunity();
        const res = await request(app).get('/api/cloud-backup/usage').set('Cookie', authCookie);
        expect(res.status).toBe(403);
    });

    it('GET /usage is rejected on Skipper', async () => {
        mockSkipper();
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

    // Admiral retains access to every endpoint.
    it('Admiral can configure provider=sencho', async () => {
        const res = await request(app).put('/api/cloud-backup/config').set('Cookie', authCookie).send({ provider: 'sencho' });
        expect(res.status).toBe(204);
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
