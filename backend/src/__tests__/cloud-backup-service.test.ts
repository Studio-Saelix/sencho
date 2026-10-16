/**
 * Tests for CloudBackupService — provider resolution, encryption round-trip,
 * archive format, and S3 client invocation. The S3 SDK is mocked at the
 * module level so no network calls happen.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as zlib from 'zlib';
import * as tar from 'tar-stream';
import { Readable } from 'stream';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { isEncryptedArchive, MAX_ARCHIVE_OBJECT_BYTES, openSnapshotArchive } from '../services/cloudBackupArchive';

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
let SnapshotKeyError: typeof import('../services/CloudBackupService').SnapshotKeyError;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ CryptoService } = await import('../services/CryptoService'));
    ({ CloudBackupService, SnapshotKeyError } = await import('../services/CloudBackupService'));
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
        'cloud_backup_encrypt_archives',
        'cloud_backup_archive_passphrase',
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
                stream.on('data', (c: unknown) => { if (Buffer.isBuffer(c)) chunks.push(c); });
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
        expect(parsed.archive_version).toBe(2);
        expect(parsed.has_documentation).toBe(false);
        // No dossier metadata was captured, so the archive omits documentation.json.
        expect(entries.find(e => e.name === 'documentation.json')).toBeUndefined();

        // Encryption is off, so the archive carries plaintext. A downloaded
        // snapshot can be read on any instance.
        const composeEntry = entries.find(e => e.name === 'nodes/1_gateway/web/compose.yaml');
        expect(composeEntry?.content).toBe('services: {}\n');
        const envEntry = entries.find(e => e.name === 'nodes/1_gateway/web/.env');
        expect(envEntry?.content).toBe('KEY=value\n');

        expect(CloudBackupService.getInstance().getUploadStatus(snapshotId).status).toBe('success');
    });

    it('includes documentation.json when the snapshot captured dossier metadata', async () => {
        seedCustomProvider();
        const db = DatabaseService.getInstance();

        const docJson = JSON.stringify({
            generated_at: '2026-01-01T00:00:00Z',
            stacks: [{ nodeId: 1, nodeName: 'gateway', stackName: 'web', dossier: { purpose: 'edge proxy' } }],
            warnings: [],
        });
        const snapshotId = db.createSnapshot('Documented backup', 'admin', 1, 1, '[]', '[]', docJson);
        db.insertSnapshotFiles(snapshotId, [
            { nodeId: 1, nodeName: 'gateway', stackName: 'web', filename: 'compose.yaml', content: 'services: {}\n' },
        ]);

        sentSpy.mockResolvedValue({});
        await CloudBackupService.getInstance().uploadSnapshot(snapshotId);

        const putCall = sentSpy.mock.calls.find(c => c[0].name === 'PutObjectCommand');
        const input = putCall![0].input as { Body: Buffer };
        const decompressed = zlib.gunzipSync(input.Body);
        const entries: Array<{ name: string; content: string }> = await new Promise((resolve, reject) => {
            const extract = tar.extract();
            const list: Array<{ name: string; content: string }> = [];
            extract.on('entry', (header, stream, next) => {
                const chunks: Buffer[] = [];
                stream.on('data', (c: unknown) => { if (Buffer.isBuffer(c)) chunks.push(c); });
                stream.on('end', () => { list.push({ name: header.name, content: Buffer.concat(chunks).toString('utf-8') }); next(); });
                stream.resume();
            });
            extract.on('finish', () => resolve(list));
            extract.on('error', reject);
            Readable.from(decompressed).pipe(extract);
        });

        const meta = JSON.parse(entries.find(e => e.name === 'metadata.json')!.content);
        expect(meta.has_documentation).toBe(true);
        const docEntry = entries.find(e => e.name === 'documentation.json');
        expect(docEntry).toBeDefined();
        // The archive carries plaintext dossier metadata for portability.
        expect(JSON.parse(docEntry!.content).stacks[0].dossier.purpose).toBe('edge proxy');
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

    it('fails closed with no PutObject when a snapshot file is unavailable', async () => {
        seedCustomProvider();
        const db = DatabaseService.getInstance();
        const snapshotId = db.createSnapshot('Corrupt member', 'admin', 1, 1, '[]');
        const cipher = CryptoService.getInstance().encrypt('services: {}\n');
        const payload = cipher.slice('enc:'.length);
        const [iv, tag, ct] = payload.split(':');
        db.getDb().prepare(
            'INSERT INTO fleet_snapshot_files (snapshot_id, node_id, node_name, stack_name, filename, content) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(snapshotId, 1, 'gateway', 'web', 'compose.yaml', `enc:${iv}:${tag}:${ct.slice(0, 3)}`);

        sentSpy.mockClear();
        await expect(CloudBackupService.getInstance().uploadSnapshot(snapshotId)).rejects.toThrow(/could not be decrypted/i);

        const putCalls = sentSpy.mock.calls.filter(c => c[0].name === 'PutObjectCommand');
        expect(putCalls).toHaveLength(0);
        const status = CloudBackupService.getInstance().getUploadStatus(snapshotId);
        expect(status.status).toBe('failed');
        expect(status.error).toMatch(/could not be decrypted/i);
    });

    it('fails closed with no PutObject when a healthy sibling file exists alongside an unavailable one', async () => {
        seedCustomProvider();
        const db = DatabaseService.getInstance();
        const snapshotId = db.createSnapshot('Mixed members', 'admin', 1, 1, '[]');
        const good = CryptoService.getInstance().encrypt('services: { ok: {} }\n');
        const bad = CryptoService.getInstance().encrypt('SECRET=long-enough-to-truncate\n');
        const payload = bad.slice('enc:'.length);
        const [iv, tag, ct] = payload.split(':');
        db.getDb().prepare(
            'INSERT INTO fleet_snapshot_files (snapshot_id, node_id, node_name, stack_name, filename, content) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(snapshotId, 1, 'gateway', 'web', 'compose.yaml', good);
        db.getDb().prepare(
            'INSERT INTO fleet_snapshot_files (snapshot_id, node_id, node_name, stack_name, filename, content) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(snapshotId, 1, 'gateway', 'web', '.env', `enc:${iv}:${tag}:${ct.slice(0, 3)}`);

        sentSpy.mockClear();
        await expect(CloudBackupService.getInstance().uploadSnapshot(snapshotId)).rejects.toThrow(/could not be decrypted/i);

        const putCalls = sentSpy.mock.calls.filter(c => c[0].name === 'PutObjectCommand');
        expect(putCalls).toHaveLength(0);
        const status = CloudBackupService.getInstance().getUploadStatus(snapshotId);
        expect(status.status).toBe('failed');
        expect(status.error).toMatch(/could not be decrypted/i);
    });

    it('fails closed with no PutObject when a delimiter byte is corrupted', async () => {
        seedCustomProvider();
        const db = DatabaseService.getInstance();
        const snapshotId = db.createSnapshot('Delim damage', 'admin', 1, 1, '[]');
        const cipher = CryptoService.getInstance().encrypt('services: { ok: {} }\n');
        const payload = cipher.slice('enc:'.length);
        const [iv, tag, ct] = payload.split(':');
        db.getDb().prepare(
            'INSERT INTO fleet_snapshot_files (snapshot_id, node_id, node_name, stack_name, filename, content) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(snapshotId, 1, 'gateway', 'web', 'compose.yaml', `enc:${iv}=${tag}:${ct}`);

        sentSpy.mockClear();
        await expect(CloudBackupService.getInstance().uploadSnapshot(snapshotId)).rejects.toThrow(/could not be decrypted/i);

        const putCalls = sentSpy.mock.calls.filter(c => c[0].name === 'PutObjectCommand');
        expect(putCalls).toHaveLength(0);
        const status = CloudBackupService.getInstance().getUploadStatus(snapshotId);
        expect(status.status).toBe('failed');
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
                { Key: 'sencho/instances/test-instance-id/snapshots/3_2026-01-01_a.tar.gz.senc', Size: 100, LastModified: new Date('2026-01-01T00:00:00Z') },
                { Key: 'sencho/instances/test-instance-id/snapshots/7_2026-04-01_b.tar.gz', Size: 200, LastModified: new Date('2026-04-01T00:00:00Z') },
            ],
        });
        const list = await CloudBackupService.getInstance().listCloudSnapshots();
        expect(list).toHaveLength(2);
        expect(list[0].snapshotId).toBe(7);
        expect(list[0].encrypted).toBe(false);
        expect(list[1].snapshotId).toBe(3);
        expect(list[1].encrypted).toBe(true);
    });
});

const ARCHIVE_PASSPHRASE = 'correct-horse';

function seedCustomBucket(): void {
    const db = DatabaseService.getInstance();
    const crypto = CryptoService.getInstance();
    db.updateGlobalSetting('cloud_backup_provider', 'custom');
    db.updateGlobalSetting('cloud_backup_endpoint', 'https://s3.example.com');
    db.updateGlobalSetting('cloud_backup_region', 'us-east-1');
    db.updateGlobalSetting('cloud_backup_bucket', 'my-bucket');
    db.updateGlobalSetting('cloud_backup_access_key', 'AKIA1234');
    db.updateGlobalSetting('cloud_backup_secret_key', crypto.encrypt('test-secret'));
    db.updateGlobalSetting('cloud_backup_path_prefix', 'sencho/');
}

function composeNames(): string[] {
    return fs.readdirSync(process.env.COMPOSE_DIR || '').sort();
}

function snapshotCounts(): { headers: number; files: number } {
    const db = DatabaseService.getInstance().getDb();
    const headers = db.prepare('SELECT COUNT(*) AS n FROM fleet_snapshots').get() as { n: number };
    const files = db.prepare('SELECT COUNT(*) AS n FROM fleet_snapshot_files').get() as { n: number };
    return { headers: headers.n, files: files.n };
}

function putObjectInput(): { Key: string; Body: Buffer; ContentType: string } {
    const putCall = sentSpy.mock.calls.find(c => c[0].name === 'PutObjectCommand');
    return putCall![0].input as { Key: string; Body: Buffer; ContentType: string };
}

describe('CloudBackupService archive encryption', () => {
    it('uploads ciphertext with a .senc key when encryption is on', async () => {
        seedCustomBucket();
        const db = DatabaseService.getInstance();
        db.updateGlobalSetting('cloud_backup_encrypt_archives', '1');
        db.updateGlobalSetting('cloud_backup_archive_passphrase', CryptoService.getInstance().encrypt(ARCHIVE_PASSPHRASE));
        const snapshotId = db.createSnapshot('Sealed backup', 'admin', 1, 1, '[]');
        db.insertSnapshotFiles(snapshotId, [
            { nodeId: 1, nodeName: 'gateway', stackName: 'web', filename: 'compose.yaml', content: 'services: {}\n' },
            { nodeId: 1, nodeName: 'gateway', stackName: 'web', filename: '.env', content: 'KEY=value\n' },
        ]);

        sentSpy.mockResolvedValue({});
        await CloudBackupService.getInstance().uploadSnapshot(snapshotId);

        const input = putObjectInput();
        expect(input.Key).toMatch(/\.tar\.gz\.senc$/);
        expect(input.ContentType).toBe('application/octet-stream');
        expect(isEncryptedArchive(input.Body)).toBe(true);
        expect(input.Body.includes(Buffer.from('services: {}'))).toBe(false);
        expect(input.Body.includes(Buffer.from('KEY=value'))).toBe(false);

        const opened = await openSnapshotArchive(input.Body, ARCHIVE_PASSPHRASE);
        expect(opened.files.find(file => file.filename === 'compose.yaml')?.content).toBe('services: {}\n');
        expect(opened.files.find(file => file.filename === '.env')?.content).toBe('KEY=value\n');
    });

    it('does not call PutObject when encryption is on and no passphrase is saved', async () => {
        seedCustomBucket();
        const db = DatabaseService.getInstance();
        db.updateGlobalSetting('cloud_backup_encrypt_archives', '1');
        const snapshotId = db.createSnapshot('Unsealed', 'admin', 0, 0, '[]');
        sentSpy.mockClear();
        await expect(CloudBackupService.getInstance().uploadSnapshot(snapshotId)).rejects.toThrow(/no passphrase is saved/i);
        expect(sentSpy.mock.calls.filter(c => c[0].name === 'PutObjectCommand')).toHaveLength(0);
    });

    it('imports a plaintext archive into a new local snapshot and leaves the compose directory alone', async () => {
        seedCustomBucket();
        const db = DatabaseService.getInstance();
        const snapshotId = db.createSnapshot('Plain archive', 'admin', 1, 1, '[]');
        db.insertSnapshotFiles(snapshotId, [
            { nodeId: 1, nodeName: 'gateway', stackName: 'web', filename: 'compose.yaml', content: 'services: { web: {} }\n' },
        ]);
        sentSpy.mockResolvedValue({});
        await CloudBackupService.getInstance().uploadSnapshot(snapshotId);
        const uploaded = putObjectInput();
        const before = snapshotCounts();
        const composeBefore = composeNames();

        sentSpy.mockImplementation(async (cmd: { name: string }) => {
            if (cmd.name === 'GetObjectCommand') return { Body: Readable.from(uploaded.Body) };
            return {};
        });
        const importedId = await CloudBackupService.getInstance().importSnapshot(uploaded.Key);
        const after = snapshotCounts();
        expect(importedId).not.toBe(snapshotId);
        expect(after.headers).toBe(before.headers + 1);
        expect(after.files).toBe(before.files + 1);
        const imported = db.getSnapshotFiles(importedId).find(file => file.available && file.filename === 'compose.yaml');
        expect(imported && imported.available ? imported.content : '').toBe('services: { web: {} }\n');
        const stored = db.getDb().prepare(
            'SELECT content FROM fleet_snapshot_files WHERE snapshot_id = ? AND filename = ?',
        ).get(importedId, 'compose.yaml') as { content: string };
        expect(stored.content.startsWith('enc:')).toBe(true);
        expect(stored.content.includes('services:')).toBe(false);
        expect(composeNames()).toEqual(composeBefore);
    });

    it('imports an encrypted archive with only the passphrase', async () => {
        seedCustomBucket();
        const db = DatabaseService.getInstance();
        db.updateGlobalSetting('cloud_backup_encrypt_archives', '1');
        db.updateGlobalSetting('cloud_backup_archive_passphrase', CryptoService.getInstance().encrypt(ARCHIVE_PASSPHRASE));
        const snapshotId = db.createSnapshot('Sealed import', 'admin', 1, 1, '[]');
        db.insertSnapshotFiles(snapshotId, [
            { nodeId: 1, nodeName: 'edge_gw', stackName: 'web', filename: '.env', content: 'TOKEN=abc\n' },
        ]);
        sentSpy.mockResolvedValue({});
        await CloudBackupService.getInstance().uploadSnapshot(snapshotId);
        const uploaded = putObjectInput();
        const before = snapshotCounts();

        sentSpy.mockImplementation(async (cmd: { name: string }) => {
            if (cmd.name === 'GetObjectCommand') return { Body: Readable.from(uploaded.Body) };
            return {};
        });
        const withStored = await CloudBackupService.getInstance().importSnapshot(uploaded.Key);
        expect(withStored).not.toBe(snapshotId);
        const downloaded = await CloudBackupService.getInstance().downloadSnapshot(uploaded.Key);
        expect(isEncryptedArchive(downloaded)).toBe(false);
        expect(zlib.gunzipSync(downloaded).includes(Buffer.from('TOKEN=abc'))).toBe(true);

        db.updateGlobalSetting('cloud_backup_archive_passphrase', '');
        const importedId = await CloudBackupService.getInstance().importSnapshot(uploaded.Key, ARCHIVE_PASSPHRASE);
        expect(snapshotCounts().headers).toBe(before.headers + 2);
        const imported = db.getSnapshotFiles(importedId).find(file => file.available && file.filename === '.env');
        expect(imported && imported.available ? imported.content : '').toBe('TOKEN=abc\n');
    });

    it('inserts nothing when the passphrase is wrong', async () => {
        seedCustomBucket();
        const db = DatabaseService.getInstance();
        db.updateGlobalSetting('cloud_backup_encrypt_archives', '1');
        db.updateGlobalSetting('cloud_backup_archive_passphrase', CryptoService.getInstance().encrypt(ARCHIVE_PASSPHRASE));
        const snapshotId = db.createSnapshot('Bad passphrase', 'admin', 1, 1, '[]');
        db.insertSnapshotFiles(snapshotId, [
            { nodeId: 1, nodeName: 'gateway', stackName: 'web', filename: 'compose.yaml', content: 'services: {}\n' },
        ]);
        sentSpy.mockResolvedValue({});
        await CloudBackupService.getInstance().uploadSnapshot(snapshotId);
        const uploaded = putObjectInput();
        const before = snapshotCounts();
        const composeBefore = composeNames();
        sentSpy.mockImplementation(async (cmd: { name: string }) => {
            if (cmd.name === 'GetObjectCommand') return { Body: Readable.from(uploaded.Body) };
            return {};
        });
        await expect(CloudBackupService.getInstance().importSnapshot(uploaded.Key, 'not-the-passphrase')).rejects.toThrow(/incorrect/i);
        expect(snapshotCounts()).toEqual(before);
        expect(composeNames()).toEqual(composeBefore);
    });

    it('rolls back the snapshot header when a file write fails inside the transaction', async () => {
        const db = DatabaseService.getInstance();
        const before = snapshotCounts();
        const crypto = CryptoService.getInstance();
        const real = crypto.encrypt.bind(crypto);
        let calls = 0;
        const spy = vi.spyOn(crypto, 'encrypt').mockImplementation((value: string) => {
            calls += 1;
            if (calls >= 2) throw new Error('forced write failure');
            return real(value);
        });
        try {
            expect(() => db.importSnapshotArchive({
                description: 'partial',
                createdBy: 'admin',
                createdAt: 1,
                nodeCount: 1,
                stackCount: 1,
                skippedNodes: '[]',
                skippedStacks: '[]',
                documentation: '{"stacks":[]}',
                files: [{ nodeId: 1, nodeName: 'gateway', stackName: 'web', filename: 'compose.yaml', content: 'services: {}\n' }],
            })).toThrow(/forced write failure/);
        } finally {
            spy.mockRestore();
        }
        expect(snapshotCounts()).toEqual(before);
    });

    it('rejects an object larger than the import limit', async () => {
        seedCustomBucket();
        const db = DatabaseService.getInstance();
        const instanceId = db.getSystemState('instance_id') || 'unknown';
        const objectKey = `sencho/instances/${instanceId}/snapshots/big.tar.gz`;
        sentSpy.mockResolvedValue({
            ContentLength: MAX_ARCHIVE_OBJECT_BYTES + 1,
            Body: Readable.from(Buffer.from('x')),
        });
        await expect(CloudBackupService.getInstance().importSnapshot(objectKey)).rejects.toMatchObject({ code: 'TOO_LARGE' });

        const chunks: Buffer[] = [];
        const chunk = Buffer.alloc(1024 * 1024);
        for (let i = 0; i < 33; i += 1) chunks.push(chunk);
        sentSpy.mockResolvedValue({ Body: Readable.from(chunks) });
        await expect(CloudBackupService.getInstance().importSnapshot(objectKey)).rejects.toMatchObject({ code: 'TOO_LARGE' });
    });

    it('rejects object keys outside this instance snapshot prefix', async () => {
        seedCustomBucket();
        const svc = CloudBackupService.getInstance();
        const foreign = 'other/instances/test-instance-id/snapshots/1.tar.gz';
        sentSpy.mockClear();
        await expect(svc.downloadSnapshot(foreign)).rejects.toBeInstanceOf(SnapshotKeyError);
        await expect(svc.importSnapshot(foreign)).rejects.toBeInstanceOf(SnapshotKeyError);
        await expect(svc.deleteCloudSnapshot(foreign)).rejects.toBeInstanceOf(SnapshotKeyError);
        expect(sentSpy).not.toHaveBeenCalled();
    });
});
