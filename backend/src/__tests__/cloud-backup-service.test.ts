/**
 * Tests for CloudBackupService — provider resolution, encryption round-trip,
 * archive format, and S3 client invocation. The S3 SDK is mocked at the
 * module level so no network calls happen.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as zlib from 'zlib';
import * as tar from 'tar-stream';
import { Readable } from 'stream';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

const sentSpy = vi.fn();
const s3ClientCtorSpy = vi.fn();

vi.mock('@aws-sdk/client-s3', () => {
    class S3Client {
        constructor(opts: unknown) { s3ClientCtorSpy(opts); }
        async send(cmd: { name: string; input: Record<string, unknown> }) { return sentSpy(cmd); }
    }
    class PutObjectCommand { name = 'PutObjectCommand'; constructor(public input: Record<string, unknown>) {} }
    class GetObjectCommand { name = 'GetObjectCommand'; constructor(public input: Record<string, unknown>) {} }
    class ListObjectsV2Command { name = 'ListObjectsV2Command'; constructor(public input: Record<string, unknown>) {} }
    class DeleteObjectCommand { name = 'DeleteObjectCommand'; constructor(public input: Record<string, unknown>) {} }
    class HeadBucketCommand { name = 'HeadBucketCommand'; constructor(public input: Record<string, unknown>) {} }
    return { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand, HeadBucketCommand };
});

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let CryptoService: typeof import('../services/CryptoService').CryptoService;
let CloudBackupService: typeof import('../services/CloudBackupService').CloudBackupService;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ CryptoService } = await import('../services/CryptoService'));
    ({ CloudBackupService } = await import('../services/CloudBackupService'));
});

afterAll(() => {
    CloudBackupService.getInstance().stop();
    cleanupTestDb(tmpDir);
});

beforeEach(() => {
    sentSpy.mockReset();
    s3ClientCtorSpy.mockReset();
    const db = DatabaseService.getInstance();
    // Reset all cloud-backup-related settings between tests.
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
    for (const k of [
        'sencho_cloud_backup_endpoint',
        'sencho_cloud_backup_bucket',
        'sencho_cloud_backup_access_key',
        'sencho_cloud_backup_secret_key',
        'sencho_cloud_backup_path_prefix',
        'sencho_cloud_backup_quota_bytes',
        'sencho_cloud_backup_provisioned_at',
    ]) {
        db.setSystemState(k, '');
    }
    db.setSystemState('instance_id', 'test-instance-id');
});

describe('CloudBackupService — provider resolution', () => {
    it('returns "disabled" when no provider is set', () => {
        expect(CloudBackupService.getInstance().getProvider()).toBe('disabled');
        expect(CloudBackupService.getInstance().isEnabled()).toBe(false);
        expect(CloudBackupService.getInstance().getResolvedConfig()).toBeNull();
    });

    it('returns null config for custom provider when fields are missing', () => {
        const db = DatabaseService.getInstance();
        db.updateGlobalSetting('cloud_backup_provider', 'custom');
        db.updateGlobalSetting('cloud_backup_endpoint', 'https://s3.example.com');
        // bucket, access_key, secret_key still missing
        expect(CloudBackupService.getInstance().getResolvedConfig()).toBeNull();
    });

    it('decrypts custom secret_key on read', () => {
        const db = DatabaseService.getInstance();
        const crypto = CryptoService.getInstance();
        db.updateGlobalSetting('cloud_backup_provider', 'custom');
        db.updateGlobalSetting('cloud_backup_endpoint', 'https://s3.example.com');
        db.updateGlobalSetting('cloud_backup_region', 'us-east-1');
        db.updateGlobalSetting('cloud_backup_bucket', 'my-bucket');
        db.updateGlobalSetting('cloud_backup_access_key', 'AKIA1234');
        db.updateGlobalSetting('cloud_backup_secret_key', crypto.encrypt('plaintext-secret'));
        db.updateGlobalSetting('cloud_backup_auto_upload', '1');

        const cfg = CloudBackupService.getInstance().getResolvedConfig();
        expect(cfg).not.toBeNull();
        expect(cfg!.provider).toBe('custom');
        expect(cfg!.secretKey).toBe('plaintext-secret');
        expect(cfg!.autoUpload).toBe(true);
    });

    it('resolves sencho provider from system_state and forces auto_upload on', () => {
        const db = DatabaseService.getInstance();
        const crypto = CryptoService.getInstance();
        db.updateGlobalSetting('cloud_backup_provider', 'sencho');
        db.setSystemState('sencho_cloud_backup_endpoint', 'https://r2.example.com');
        db.setSystemState('sencho_cloud_backup_bucket', 'sencho-cloud-backups');
        db.setSystemState('sencho_cloud_backup_access_key', 'R2-ACCESS');
        db.setSystemState('sencho_cloud_backup_secret_key', crypto.encrypt('R2-SECRET'));
        db.setSystemState('sencho_cloud_backup_path_prefix', 'tenants/123/');
        db.setSystemState('sencho_cloud_backup_quota_bytes', '524288000');

        const cfg = CloudBackupService.getInstance().getResolvedConfig();
        expect(cfg!.provider).toBe('sencho');
        expect(cfg!.region).toBe('auto');
        expect(cfg!.secretKey).toBe('R2-SECRET');
        expect(cfg!.autoUpload).toBe(true);
        expect(cfg!.quotaBytes).toBe(524_288_000);
    });
});

describe('CloudBackupService — uploadSnapshot', () => {
    function seedCustomProvider() {
        const db = DatabaseService.getInstance();
        const crypto = CryptoService.getInstance();
        db.updateGlobalSetting('cloud_backup_provider', 'custom');
        db.updateGlobalSetting('cloud_backup_endpoint', 'https://s3.example.com');
        db.updateGlobalSetting('cloud_backup_region', 'us-east-1');
        db.updateGlobalSetting('cloud_backup_bucket', 'my-bucket');
        db.updateGlobalSetting('cloud_backup_access_key', 'AKIA1234');
        db.updateGlobalSetting('cloud_backup_secret_key', crypto.encrypt('test-secret'));
        db.updateGlobalSetting('cloud_backup_path_prefix', 'sencho/');
        db.updateGlobalSetting('cloud_backup_auto_upload', '1');
    }

    it('uploads a snapshot with correct object key and gzipped tar archive', async () => {
        seedCustomProvider();
        const db = DatabaseService.getInstance();

        const snapshotId = db.createSnapshot('Test backup', 'admin', 1, 1, '[]');
        db.insertSnapshotFiles(snapshotId, [
            { nodeId: 1, nodeName: 'gateway', stackName: 'web', filename: 'compose.yaml', content: 'services: {}\n' },
            { nodeId: 1, nodeName: 'gateway', stackName: 'web', filename: '.env', content: 'KEY=value\n' },
        ]);

        sentSpy.mockResolvedValue({});
        await CloudBackupService.getInstance().uploadSnapshot(snapshotId);

        expect(s3ClientCtorSpy).toHaveBeenCalledWith(expect.objectContaining({
            endpoint: 'https://s3.example.com',
            region: 'us-east-1',
            forcePathStyle: true,
            credentials: { accessKeyId: 'AKIA1234', secretAccessKey: 'test-secret' },
        }));

        const putCall = sentSpy.mock.calls.find(c => c[0].name === 'PutObjectCommand');
        expect(putCall).toBeDefined();
        const input = putCall![0].input as { Bucket: string; Key: string; Body: Buffer; ContentType: string };
        expect(input.Bucket).toBe('my-bucket');
        expect(input.Key).toContain('sencho/instances/test-instance-id/snapshots/');
        expect(input.Key).toMatch(/\.tar\.gz$/);
        expect(input.ContentType).toBe('application/gzip');
        expect(Buffer.isBuffer(input.Body)).toBe(true);
        expect(input.Body.byteLength).toBeGreaterThan(0);

        const decompressed = zlib.gunzipSync(input.Body);
        const entries: Array<{ name: string; content: string }> = await new Promise((resolve, reject) => {
            const extract = tar.extract();
            const list: Array<{ name: string; content: string }> = [];
            extract.on('entry', (header, stream, next) => {
                const chunks: Buffer[] = [];
                stream.on('data', (c: Buffer) => chunks.push(c));
                stream.on('end', () => { list.push({ name: header.name, content: Buffer.concat(chunks).toString('utf-8') }); next(); });
                stream.resume();
            });
            extract.on('finish', () => resolve(list));
            extract.on('error', reject);
            Readable.from(decompressed).pipe(extract);
        });

        const meta = entries.find(e => e.name === 'metadata.json');
        expect(meta).toBeDefined();
        const parsed = JSON.parse(meta!.content);
        expect(parsed.id).toBe(snapshotId);
        expect(parsed.instance_id).toBe('test-instance-id');
        expect(parsed.archive_version).toBe(1);

        // Content is encrypted at rest but the archive must carry plaintext so a
        // downloaded snapshot restores on any instance (portability contract).
        const composeEntry = entries.find(e => e.name === 'nodes/1_gateway/web/compose.yaml');
        expect(composeEntry?.content).toBe('services: {}\n');
        const envEntry = entries.find(e => e.name === 'nodes/1_gateway/web/.env');
        expect(envEntry?.content).toBe('KEY=value\n');

        expect(CloudBackupService.getInstance().getUploadStatus(snapshotId).status).toBe('success');
    });

    it('records failure status when upload throws', async () => {
        seedCustomProvider();
        const db = DatabaseService.getInstance();
        const snapshotId = db.createSnapshot('Failing', 'admin', 0, 0, '[]');

        sentSpy.mockRejectedValueOnce(new Error('AccessDenied: bad creds'));
        await expect(CloudBackupService.getInstance().uploadSnapshot(snapshotId)).rejects.toThrow(/bad creds/);

        const status = CloudBackupService.getInstance().getUploadStatus(snapshotId);
        expect(status.status).toBe('failed');
        expect(status.error).toContain('bad creds');
    });

    it('throws when no provider is configured', async () => {
        await expect(CloudBackupService.getInstance().uploadSnapshot(999)).rejects.toThrow(/not configured/i);
    });
});

describe('CloudBackupService — listCloudSnapshots', () => {
    it('parses snapshot ID from object key and sorts by lastModified desc', async () => {
        const db = DatabaseService.getInstance();
        const crypto = CryptoService.getInstance();
        db.updateGlobalSetting('cloud_backup_provider', 'custom');
        db.updateGlobalSetting('cloud_backup_endpoint', 'https://s3.example.com');
        db.updateGlobalSetting('cloud_backup_region', 'us-east-1');
        db.updateGlobalSetting('cloud_backup_bucket', 'b');
        db.updateGlobalSetting('cloud_backup_access_key', 'a');
        db.updateGlobalSetting('cloud_backup_secret_key', crypto.encrypt('s'));
        db.updateGlobalSetting('cloud_backup_path_prefix', 'sencho/');

        sentSpy.mockResolvedValueOnce({
            Contents: [
                { Key: 'sencho/instances/test-instance-id/snapshots/3_2026-01-01_a.tar.gz', Size: 100, LastModified: new Date('2026-01-01T00:00:00Z') },
                { Key: 'sencho/instances/test-instance-id/snapshots/7_2026-04-01_b.tar.gz', Size: 200, LastModified: new Date('2026-04-01T00:00:00Z') },
            ],
        });
        const list = await CloudBackupService.getInstance().listCloudSnapshots();
        expect(list).toHaveLength(2);
        expect(list[0].snapshotId).toBe(7);
        expect(list[1].snapshotId).toBe(3);
    });
});
