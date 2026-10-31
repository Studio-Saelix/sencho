/**
 * CloudBackupService: off-site replication for fleet snapshots.
 *
 * Two providers share the same S3-compatible code path:
 *   - 'sencho' : managed Sencho Snapshot Vault. Credentials provisioned by
 *                sencho.io/api/cloud-backup/provision and stored in system_state.
 *   - 'custom' : bring-your-own-bucket. Credentials user-configured in global_settings.
 *
 * Routes call this service after a snapshot is persisted to SQLite. The service
 * reads snapshot rows from DatabaseService, packs them into a tar.gz archive,
 * and uploads via @aws-sdk/client-s3.
 */

import { Readable } from 'stream';
import axios from 'axios';
import { DatabaseService } from './DatabaseService';
import { CryptoService } from './CryptoService';
import { LicenseService } from './LicenseService';
import {
    isAvailableSnapshotFile,
    type AvailableSnapshotFile,
} from '../helpers/snapshotFileDecrypt';
import { getErrorMessage } from '../utils/errors';
import { isDebugEnabled } from '../utils/debug';
import {
    ArchiveFormatError,
    assertArchiveFitsLimits,
    assertArchiveObjectSize,
    decryptArchive,
    encryptArchive,
    isEncryptedArchive,
    MAX_ARCHIVE_OBJECT_BYTES,
    openSnapshotArchive,
    packSnapshotArchive,
    type ArchiveEntryPlan,
} from './cloudBackupArchive';

// Bounds on requests to the S3 endpoint, all shorter than the panel's own
// 60 s deadline so the operator sees the endpoint's failure, not a generic
// timeout. connectionMs and socketMs (inactivity, so a large archive that keeps
// moving is not cut off) cover the connect and the wait for response headers;
// the SDK arms no socket timer once headers have arrived. operationMs therefore
// bounds a whole small request (Test, listings, delete), and bodyIdleMs bounds
// a gap in an archive download. Tests shrink these to prove a silent endpoint
// fails fast.
export const S3_TIMEOUTS = { connectionMs: 10_000, socketMs: 30_000, operationMs: 45_000, bodyIdleMs: 30_000 };

// Cloud backup is opt-in (paid feature) and the AWS SDK v3 client pulls
// in dozens of @smithy/* and @aws-sdk/middleware-* packages, so installs
// without cloud backup configured pay a real boot-parse cost they never use.
// The package is declared as an optionalDependency: present in the default
// install, but operators who never touch cloud backup can run
// `npm ci --omit=optional` for a slimmer image. Lazy-load the SDK on first
// call and surface a clear error if it has been opt-out-pruned.
type S3Sdk = typeof import('@aws-sdk/client-s3');
type S3Client = InstanceType<S3Sdk['S3Client']>;

let cachedS3Sdk: S3Sdk | undefined;

async function loadS3Sdk(): Promise<S3Sdk> {
    if (!cachedS3Sdk) {
        try {
            cachedS3Sdk = await import('@aws-sdk/client-s3');
        } catch (err) {
            throw new Error(
                'Cloud backup requires the @aws-sdk/client-s3 package. ' +
                'It is shipped by default; if you built this image with ' +
                '`npm ci --omit=optional`, reinstall without that flag to ' +
                'enable cloud backup.',
                { cause: err },
            );
        }
    }
    return cachedS3Sdk;
}

export type CloudProvider = 'disabled' | 'sencho' | 'custom';
export type UploadStatus = 'idle' | 'uploading' | 'success' | 'failed';

export interface ResolvedCloudConfig {
    provider: 'sencho' | 'custom';
    endpoint: string;
    region: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
    pathPrefix: string;
    autoUpload: boolean;
    quotaBytes?: number;
}

export interface CloudSnapshotEntry {
    objectKey: string;
    sizeBytes: number;
    lastModified: string | null;
    snapshotId: number | null;
    encrypted: boolean;
}

/** The object key is not under this instance's snapshot prefix. */
export class SnapshotKeyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SnapshotKeyError';
    }
}

export interface ProvisionResult {
    success: boolean;
    quotaBytes?: number;
    error?: string;
}

export interface UploadStatusEntry {
    status: UploadStatus;
    objectKey?: string;
    error?: string;
    updatedAt: number;
}

const SENCHO_CLOUD_BACKUP_API_DEFAULT = 'https://sencho.io';
const PROVIDER_KEY = 'cloud_backup_provider';
const SUCCESS_STATUS_TTL_MS = 5 * 60 * 1000;
/** Recovery listing pages, 1,000 objects each. The response says when it stopped early. */
const RECOVERY_LIST_PAGE_LIMIT = 10;

export class CloudBackupService {
    private static instance: CloudBackupService;
    private uploadStatus = new Map<number, UploadStatusEntry>();
    private statusGcTimer: ReturnType<typeof setInterval> | null = null;

    private constructor() {
        this.statusGcTimer = setInterval(() => this.gcUploadStatus(), 60 * 1000);
        if (typeof this.statusGcTimer.unref === 'function') this.statusGcTimer.unref();
    }

    public static getInstance(): CloudBackupService {
        if (!CloudBackupService.instance) {
            CloudBackupService.instance = new CloudBackupService();
        }
        return CloudBackupService.instance;
    }

    public stop(): void {
        if (this.statusGcTimer) {
            clearInterval(this.statusGcTimer);
            this.statusGcTimer = null;
        }
    }

    // ─── Configuration ─────────────────────────────────────────────────────────

    public getProvider(): CloudProvider {
        const value = DatabaseService.getInstance().getGlobalSettings()[PROVIDER_KEY];
        if (value === 'sencho' || value === 'custom') return value;
        return 'disabled';
    }

    public isEnabled(): boolean {
        return this.getResolvedConfig() !== null;
    }

    public isAutoUploadOn(): boolean {
        const cfg = this.getResolvedConfig();
        return cfg?.autoUpload === true;
    }

    public archivesAreEncrypted(): boolean {
        return DatabaseService.getInstance().getGlobalSettings().cloud_backup_encrypt_archives === '1';
    }

    public getResolvedConfig(): ResolvedCloudConfig | null {
        const provider = this.getProvider();
        if (provider === 'disabled') return null;
        const db = DatabaseService.getInstance();
        const crypto = CryptoService.getInstance();

        if (provider === 'sencho') {
            const endpoint = db.getSystemState('sencho_cloud_backup_endpoint');
            const bucket = db.getSystemState('sencho_cloud_backup_bucket');
            const accessKey = db.getSystemState('sencho_cloud_backup_access_key');
            const secretRaw = db.getSystemState('sencho_cloud_backup_secret_key');
            const pathPrefix = db.getSystemState('sencho_cloud_backup_path_prefix') || '';
            const quotaRaw = db.getSystemState('sencho_cloud_backup_quota_bytes');
            if (!endpoint || !bucket || !accessKey || !secretRaw) return null;
            return {
                provider: 'sencho',
                endpoint,
                region: 'auto',
                bucket,
                accessKey,
                secretKey: crypto.decrypt(secretRaw),
                pathPrefix,
                autoUpload: true,
                quotaBytes: quotaRaw ? parseInt(quotaRaw, 10) : undefined,
            };
        }

        const settings = db.getGlobalSettings();
        const endpoint = settings.cloud_backup_endpoint;
        const region = settings.cloud_backup_region;
        const bucket = settings.cloud_backup_bucket;
        const accessKey = settings.cloud_backup_access_key;
        const secretRaw = settings.cloud_backup_secret_key;
        const pathPrefix = settings.cloud_backup_path_prefix || 'sencho/';
        if (!endpoint || !bucket || !accessKey || !secretRaw) return null;
        return {
            provider: 'custom',
            endpoint,
            region: region || 'us-east-1',
            bucket,
            accessKey,
            secretKey: crypto.decrypt(secretRaw),
            pathPrefix,
            autoUpload: settings.cloud_backup_auto_upload === '1',
        };
    }

    // ─── Sencho Snapshot Vault lifecycle ───────────────────────────────────────

    public async provisionSenchoCloudBackup(): Promise<ProvisionResult> {
        const db = DatabaseService.getInstance();
        const crypto = CryptoService.getInstance();
        const licenseKey = db.getSystemState('license_key');
        if (!licenseKey) return { success: false, error: 'No license key found. Activate an Admiral license first.' };

        if (LicenseService.getInstance().getTier() !== 'paid') {
            return { success: false, error: 'Sencho Snapshot Vault requires the Admiral tier.' };
        }

        const apiBase = process.env.SENCHO_CLOUD_BACKUP_API || SENCHO_CLOUD_BACKUP_API_DEFAULT;
        try {
            const res = await axios.post(`${apiBase}/api/cloud-backup/provision`, { license_key: licenseKey }, { timeout: 15000 });
            const data = res.data as {
                endpoint: string;
                region?: string;
                bucket: string;
                access_key: string;
                secret_key: string;
                path_prefix: string;
                quota_bytes: number;
            };
            db.setSystemState('sencho_cloud_backup_endpoint', data.endpoint);
            db.setSystemState('sencho_cloud_backup_bucket', data.bucket);
            db.setSystemState('sencho_cloud_backup_access_key', data.access_key);
            db.setSystemState('sencho_cloud_backup_secret_key', crypto.encrypt(data.secret_key));
            db.setSystemState('sencho_cloud_backup_path_prefix', data.path_prefix);
            db.setSystemState('sencho_cloud_backup_quota_bytes', String(data.quota_bytes));
            db.setSystemState('sencho_cloud_backup_provisioned_at', new Date().toISOString());
            db.updateGlobalSetting(PROVIDER_KEY, 'sencho');
            return { success: true, quotaBytes: data.quota_bytes };
        } catch (err) {
            const responseError = (err as { response?: { data?: { error?: string } } }).response?.data?.error;
            return { success: false, error: responseError || getErrorMessage(err, 'Failed to provision Sencho Snapshot Vault.') };
        }
    }

    public async refreshSenchoCloudBackupCredentials(): Promise<void> {
        const result = await this.provisionSenchoCloudBackup();
        if (!result.success) throw new Error(result.error || 'Failed to refresh Sencho Snapshot Vault credentials.');
    }

    public async getSenchoCloudBackupUsage(): Promise<{ used_bytes: number; quota_bytes: number; object_count: number }> {
        const db = DatabaseService.getInstance();
        const licenseKey = db.getSystemState('license_key');
        if (!licenseKey) throw new Error('No license key found.');
        const apiBase = process.env.SENCHO_CLOUD_BACKUP_API || SENCHO_CLOUD_BACKUP_API_DEFAULT;
        const res = await axios.post(`${apiBase}/api/cloud-backup/usage`, { license_key: licenseKey }, { timeout: 15000 });
        const data = res.data as { used_bytes: number; quota_bytes: number; object_count: number };
        return data;
    }

    // ─── S3 operations ─────────────────────────────────────────────────────────

    public async testConnection(): Promise<{ success: boolean; error?: string }> {
        const cfg = this.getResolvedConfig();
        if (!cfg) return { success: false, error: 'No cloud backup configuration is active.' };
        try {
            // One attempt: the SDK retries a timeout up to three times by
            // default, and a Test that fails should report after one.
            const { client, sdk } = await this.buildS3Client(cfg, 1);
            await this.runBounded(signal => client.send(new sdk.HeadBucketCommand({ Bucket: cfg.bucket }), { abortSignal: signal }));
            return { success: true };
        } catch (err) {
            return { success: false, error: getErrorMessage(err, 'Connection test failed.') };
        }
    }

    public async uploadSnapshot(snapshotId: number): Promise<void> {
        const cfg = this.getResolvedConfig();
        if (!cfg) throw new Error('Cloud backup is not configured.');
        const db = DatabaseService.getInstance();
        const snapshot = db.getSnapshot(snapshotId);
        if (!snapshot) throw new Error(`Snapshot ${snapshotId} not found.`);
        const files = db.getSnapshotFiles(snapshotId);
        const documentation = db.getSnapshotDocumentation(snapshotId);
        let objectKey = this.buildObjectKey(cfg, snapshot.id, snapshot.description, snapshot.created_at, false);

        const availableFiles = files.filter(isAvailableSnapshotFile);
        if (availableFiles.length !== files.length) {
            const message = 'One or more snapshot files could not be decrypted';
            this.setStatus(snapshotId, { status: 'failed', objectKey, error: message, updatedAt: Date.now() });
            throw new Error(message);
        }

        this.setStatus(snapshotId, { status: 'uploading', objectKey, updatedAt: Date.now() });
        try {
            const archive = await this.buildArchive(snapshot, availableFiles, documentation);
            const protectedBody = await this.protectArchive(archive);
            objectKey = this.buildObjectKey(cfg, snapshot.id, snapshot.description, snapshot.created_at, protectedBody.encrypted);
            this.setStatus(snapshotId, { status: 'uploading', objectKey, updatedAt: Date.now() });
            const { client, sdk } = await this.buildS3Client(cfg);
            await client.send(new sdk.PutObjectCommand({
                Bucket: cfg.bucket,
                Key: objectKey,
                Body: protectedBody.body,
                ContentType: protectedBody.encrypted ? 'application/octet-stream' : 'application/gzip',
            }));
            this.setStatus(snapshotId, { status: 'success', objectKey, updatedAt: Date.now() });
            if (isDebugEnabled()) {
                console.log(`[CloudBackup:debug] Uploaded snapshot ${snapshotId} (${protectedBody.body.byteLength} bytes) to ${cfg.bucket}/${objectKey}`);
            }
        } catch (err) {
            const message = getErrorMessage(s3TimeoutError(err) ?? err, 'Cloud upload failed.');
            this.setStatus(snapshotId, { status: 'failed', objectKey, error: message, updatedAt: Date.now() });
            throw new Error(message);
        }
    }

    public async downloadSnapshot(objectKey: string, passphraseOverride: string | null = null): Promise<Buffer> {
        this.assertSnapshotObjectKey(objectKey);
        const raw = await this.fetchObject(objectKey);
        if (!isEncryptedArchive(raw)) return raw;
        const passphrase = passphraseOverride || this.storedArchivePassphrase();
        if (!passphrase) {
            throw new ArchiveFormatError('PASSPHRASE_REQUIRED', 'A passphrase is required to read this archive');
        }
        return decryptArchive(raw, passphrase);
    }

    public async importSnapshot(objectKey: string, passphraseOverride: string | null = null): Promise<number> {
        this.assertSnapshotObjectKey(objectKey);
        const raw = await this.fetchObject(objectKey);
        const passphrase = isEncryptedArchive(raw)
            ? (passphraseOverride || this.storedArchivePassphrase())
            : null;
        const parsed = await openSnapshotArchive(raw, passphrase);
        return DatabaseService.getInstance().importSnapshotArchive(parsed);
    }

    /**
     * Disaster recovery from a different installation. A fresh instance has a
     * new instance id and key, so its own prefix cannot reach the old
     * archives. This path may read any instance's snapshot object inside the
     * configured bucket prefix, but only a sealed archive with the matching
     * passphrase is accepted, and it never deletes or returns raw bytes.
     */
    public async importRecoveryArchive(objectKey: string, passphrase: string): Promise<number> {
        this.assertRecoveryObjectKey(objectKey);
        if (!passphrase) {
            throw new ArchiveFormatError('PASSPHRASE_REQUIRED', 'A passphrase is required to recover this archive');
        }
        const raw = await this.fetchObject(objectKey);
        if (!isEncryptedArchive(raw)) {
            throw new ArchiveFormatError(
                'BAD_ARCHIVE',
                'Only an encrypted archive can be recovered on another instance. Import a plaintext archive from this instance\'s own snapshots instead.',
            );
        }
        const parsed = await openSnapshotArchive(raw, passphrase);
        return DatabaseService.getInstance().importSnapshotArchive(parsed);
    }

    /**
     * Archives in this bucket that belong to other instances, so a fresh
     * installation can find what it is recovering. Read-only: recovery still
     * needs the passphrase, and delete/download stay confined to this
     * instance's prefix. The listing follows continuation tokens up to a
     * bounded number of pages and reports when it stopped early, so an
     * incomplete list is never presented as complete.
     */
    public async listRecoveryArchives(): Promise<{ entries: CloudSnapshotEntry[]; truncated: boolean }> {
        const cfg = this.getResolvedConfig();
        if (!cfg) return { entries: [], truncated: false };
        const { client, sdk } = await this.buildS3Client(cfg);
        const { objects, truncated } = await this.runBounded(async signal => {
            const found: Array<{ Key?: string; Size?: number; LastModified?: Date }> = [];
            let continuationToken: string | undefined;
            let truncated = false;
            for (let page = 0; page < RECOVERY_LIST_PAGE_LIMIT; page += 1) {
                const result = await client.send(new sdk.ListObjectsV2Command({
                    Bucket: cfg.bucket,
                    Prefix: `${cfg.pathPrefix}instances/`,
                    MaxKeys: 1000,
                    ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
                }), { abortSignal: signal });
                found.push(...(result.Contents || []));
                if (!result.IsTruncated) break;
                if (!result.NextContinuationToken) {
                    // A provider that truncates without a token cannot be followed;
                    // report the list as incomplete rather than as complete.
                    truncated = true;
                    break;
                }
                continuationToken = result.NextContinuationToken;
                truncated = page === RECOVERY_LIST_PAGE_LIMIT - 1;
            }
            return { objects: found, truncated };
        });
        const current = this.getInstanceId();
        const entries: CloudSnapshotEntry[] = [];
        for (const object of objects) {
            const key = object.Key;
            if (!key) continue;
            const parsed = this.parseRecoveryKey(key, cfg.pathPrefix);
            if (!parsed || parsed.instanceId === current) continue;
            const basename = key.split('/').pop() || key;
            const idMatch = basename.match(/^(\d+)_/);
            entries.push({
                objectKey: key,
                sizeBytes: object.Size ?? 0,
                lastModified: object.LastModified ? object.LastModified.toISOString() : null,
                snapshotId: idMatch ? parseInt(idMatch[1], 10) : null,
                encrypted: key.endsWith('.tar.gz.senc'),
            });
        }
        return {
            entries: entries.sort((a, b) => (b.lastModified || '').localeCompare(a.lastModified || '')),
            truncated,
        };
    }

    public async listCloudSnapshots(): Promise<CloudSnapshotEntry[]> {
        const cfg = this.getResolvedConfig();
        if (!cfg) return [];
        const { client, sdk } = await this.buildS3Client(cfg);
        const prefix = `${cfg.pathPrefix}instances/${this.getInstanceId()}/snapshots/`;
        const result = await this.runBounded(signal => client.send(new sdk.ListObjectsV2Command({
            Bucket: cfg.bucket,
            Prefix: prefix,
            MaxKeys: 1000,
        }), { abortSignal: signal }));
        const objects = result.Contents || [];
        return objects
            .filter(o => !!o.Key)
            .map(o => {
                const key = o.Key as string;
                const basename = key.split('/').pop() || key;
                const idMatch = basename.match(/^(\d+)_/);
                return {
                    objectKey: key,
                    sizeBytes: o.Size ?? 0,
                    lastModified: o.LastModified ? o.LastModified.toISOString() : null,
                    snapshotId: idMatch ? parseInt(idMatch[1], 10) : null,
                    encrypted: key.endsWith('.tar.gz.senc'),
                };
            })
            .sort((a, b) => (b.lastModified || '').localeCompare(a.lastModified || ''));
    }

    public async deleteCloudSnapshot(objectKey: string): Promise<void> {
        this.assertSnapshotObjectKey(objectKey);
        const cfg = this.getResolvedConfig();
        if (!cfg) throw new Error('Cloud backup is not configured.');
        const { client, sdk } = await this.buildS3Client(cfg);
        await this.runBounded(signal => client.send(new sdk.DeleteObjectCommand({ Bucket: cfg.bucket, Key: objectKey }), { abortSignal: signal }));
    }

    public assertSnapshotObjectKey(objectKey: string): void {
        const cfg = this.getResolvedConfig();
        if (!cfg) throw new Error('Cloud backup is not configured.');
        const prefix = `${cfg.pathPrefix}instances/${this.getInstanceId()}/snapshots/`;
        if (!objectKey.startsWith(prefix)) {
            throw new SnapshotKeyError('Object key is outside this instance snapshot prefix');
        }
    }

    /** Recovery may read any instance's archive inside the configured bucket prefix. */
    public assertRecoveryObjectKey(objectKey: string): void {
        const cfg = this.getResolvedConfig();
        if (!cfg) throw new Error('Cloud backup is not configured.');
        if (!this.parseRecoveryKey(objectKey, cfg.pathPrefix)) {
            throw new SnapshotKeyError('Object key is not a snapshot archive in this bucket');
        }
    }

    /** `<prefix>instances/<instance>/snapshots/<file>`, or null. */
    private parseRecoveryKey(objectKey: string, pathPrefix: string): { instanceId: string; basename: string } | null {
        if (objectKey.includes('\\') || objectKey.includes('..')) return null;
        const prefix = `${pathPrefix}instances/`;
        if (!objectKey.startsWith(prefix)) return null;
        const parts = objectKey.slice(prefix.length).split('/');
        if (parts.length !== 3 || parts[1] !== 'snapshots') return null;
        const [instanceId, , basename] = parts;
        if (!instanceId || instanceId === '.' || !basename) return null;
        return { instanceId, basename };
    }

    // ─── Status tracking ───────────────────────────────────────────────────────

    public getUploadStatus(snapshotId: number): UploadStatusEntry {
        return this.uploadStatus.get(snapshotId) || { status: 'idle', updatedAt: 0 };
    }

    private setStatus(snapshotId: number, entry: UploadStatusEntry): void {
        this.uploadStatus.set(snapshotId, entry);
    }

    private gcUploadStatus(): void {
        const now = Date.now();
        for (const [id, entry] of this.uploadStatus.entries()) {
            if (entry.status === 'success' && now - entry.updatedAt > SUCCESS_STATUS_TTL_MS) {
                this.uploadStatus.delete(id);
            }
        }
    }

    // ─── Internals ─────────────────────────────────────────────────────────────

    private async buildS3Client(cfg: ResolvedCloudConfig, maxAttempts?: number): Promise<{ client: S3Client; sdk: S3Sdk }> {
        const sdk = await loadS3Sdk();
        const client = new sdk.S3Client({
            endpoint: cfg.endpoint,
            region: cfg.region,
            credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
            forcePathStyle: true,
            // Without these an endpoint that accepts the connection and never
            // answers holds the request open indefinitely, and the Snapshot
            // Vault panel keeps its destination controls disabled meanwhile.
            requestHandler: { connectionTimeout: S3_TIMEOUTS.connectionMs, socketTimeout: S3_TIMEOUTS.socketMs },
            ...(maxAttempts !== undefined ? { maxAttempts } : {}),
        });
        return { client, sdk };
    }

    /**
     * Runs one S3 request (or a short sequence of them) under a single
     * deadline that also covers the response body, which the SDK's socket
     * timeout does not once headers have arrived. A timeout of any kind is
     * rethrown with a message that names the endpoint, not the SDK.
     */
    private async runBounded<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
        const signal = AbortSignal.timeout(S3_TIMEOUTS.operationMs);
        try {
            return await run(signal);
        } catch (err) {
            throw s3TimeoutError(err, signal) ?? err;
        }
    }

    private getInstanceId(): string {
        return DatabaseService.getInstance().getInstanceId();
    }

    private buildObjectKey(cfg: ResolvedCloudConfig, snapshotId: number, description: string, createdAt: number, encrypted: boolean): string {
        const ts = new Date(createdAt).toISOString().replace(/[:.]/g, '-');
        const slug = description.slice(0, 40).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'snapshot';
        const ext = encrypted ? '.tar.gz.senc' : '.tar.gz';
        return `${cfg.pathPrefix}instances/${this.getInstanceId()}/snapshots/${snapshotId}_${ts}_${slug}${ext}`;
    }

    private storedArchivePassphrase(): string | null {
        const raw = DatabaseService.getInstance().getGlobalSettings().cloud_backup_archive_passphrase;
        if (!raw) return null;
        try {
            return CryptoService.getInstance().decrypt(raw) || null;
        } catch (err) {
            console.error('[CloudBackup] Stored archive passphrase could not be decrypted:', err);
            return null;
        }
    }

    private async protectArchive(gzip: Buffer): Promise<{ body: Buffer; encrypted: boolean }> {
        if (!this.archivesAreEncrypted()) return { body: gzip, encrypted: false };
        const passphrase = this.storedArchivePassphrase();
        if (!passphrase) throw new Error('Archive encryption is on, but no passphrase is saved');
        const body = await encryptArchive(gzip, passphrase);
        // The provider stores the envelope, not the plaintext gzip, so the
        // object limit is measured on the sealed bytes.
        assertArchiveObjectSize(body.byteLength);
        return { body, encrypted: true };
    }

    private async fetchObject(objectKey: string): Promise<Buffer> {
        const cfg = this.getResolvedConfig();
        if (!cfg) throw new Error('Cloud backup is not configured.');
        const { client, sdk } = await this.buildS3Client(cfg);
        const result = await client.send(new sdk.GetObjectCommand({ Bucket: cfg.bucket, Key: objectKey }))
            .catch((err: unknown) => { throw s3TimeoutError(err) ?? err; });
        const body = result.Body as Readable | undefined;
        if (!body) throw new Error('Empty response body.');
        if (typeof result.ContentLength === 'number' && result.ContentLength > MAX_ARCHIVE_OBJECT_BYTES) {
            body.on('error', () => undefined);
            body.destroy();
            throw new ArchiveFormatError('TOO_LARGE', 'Archive is larger than the import limit');
        }
        return streamToBuffer(body, MAX_ARCHIVE_OBJECT_BYTES, S3_TIMEOUTS.bodyIdleMs);
    }

    private async buildArchive(
        snapshot: {
            id: number;
            description: string;
            created_by: string;
            node_count: number;
            stack_count: number;
            skipped_nodes: string;
            skipped_stacks: string;
            created_at: number;
            source_instance_id: string | null;
            origin: 'local' | 'imported';
            warnings_known: number;
        },
        files: AvailableSnapshotFile[],
        documentation = '',
    ): Promise<Buffer> {
        // A re-uploaded imported snapshot keeps the identity of the instance
        // that captured it; claiming this instance would let the next import
        // treat the source installation's node ids as local ones.
        const sourceInstanceId = snapshot.origin === 'imported'
            ? snapshot.source_instance_id
            : this.getInstanceId();
        const metadata = {
            id: snapshot.id,
            description: snapshot.description,
            created_by: snapshot.created_by,
            created_at: snapshot.created_at,
            node_count: snapshot.node_count,
            stack_count: snapshot.stack_count,
            skipped_nodes: safeParseJson(snapshot.skipped_nodes, []),
            // Partial-capture warnings travel with the archive so an import
            // never turns a known-partial snapshot into a complete-looking one.
            // A snapshot whose archive could not record them stays silent, so
            // the next import keeps the same uncertainty.
            ...(snapshot.warnings_known === 0
                ? {}
                : { skipped_stacks: safeParseJson(snapshot.skipped_stacks, []) }),
            has_documentation: documentation !== '',
            instance_id: sourceInstanceId,
            // Version 2 adds the optional documentation.json entry; readers of
            // version 1 archives simply will not find that file.
            archive_version: 2,
        };
        const metadataJson = JSON.stringify(metadata, null, 2);
        // Refuse before packing when the importer's limits would reject the
        // result: a successful upload must always be recoverable.
        assertArchiveFitsLimits({
            metadataBytes: Buffer.byteLength(metadataJson),
            documentationBytes: Buffer.byteLength(documentation),
            fileBytes: files.map(file => Buffer.byteLength(file.content)),
        });

        // Entry order is part of the format the importer walks. Packing and the
        // post-pack size checks live with the limits in cloudBackupArchive so
        // the producer and the reader cannot drift apart.
        const entries: ArchiveEntryPlan[] = [{ name: 'metadata.json', content: metadataJson }];
        // Captured Stack Dossier metadata travels with the archive when present.
        if (documentation !== '') {
            entries.push({ name: 'documentation.json', content: documentation });
        }
        for (const file of files) {
            const safeNodeName = sanitizePathSegment(file.node_name);
            const safeStackName = sanitizePathSegment(file.stack_name);
            const safeFilename = sanitizePathSegment(file.filename);
            entries.push({
                name: `nodes/${file.node_id}_${safeNodeName}/${safeStackName}/${safeFilename}`,
                content: file.content,
            });
        }
        return packSnapshotArchive(entries);
    }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function streamToBuffer(stream: Readable, maxBytes: number, idleMs: number): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        // The SDK arms no inactivity timer once headers have arrived, so a
        // body that stalls mid-archive is cut here.
        let idle: ReturnType<typeof setTimeout> | undefined;
        const armIdle = () => {
            clearTimeout(idle);
            idle = setTimeout(() => {
                stream.destroy();
                reject(new Error(`The storage endpoint stopped sending data for ${Math.round(idleMs / 1000)} seconds.`));
            }, idleMs);
        };
        armIdle();
        stream.on('data', (chunk: Buffer | string) => {
            armIdle();
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += buf.length;
            if (total > maxBytes) {
                clearTimeout(idle);
                stream.destroy();
                reject(new ArchiveFormatError('TOO_LARGE', 'Archive is larger than the import limit'));
                return;
            }
            chunks.push(buf);
        });
        stream.on('end', () => { clearTimeout(idle); resolve(Buffer.concat(chunks)); });
        stream.on('error', err => { clearTimeout(idle); reject(err); });
    });
}

/**
 * The SDK's timeout and abort errors name the library ("the request socket
 * timed out after 30000 ms of inactivity (configured by client
 * requestHandler)"). Returns an error an operator can act on, or null when
 * the failure is not a timeout.
 */
function s3TimeoutError(err: unknown, signal?: AbortSignal): Error | null {
    if (signal?.aborted) {
        return new Error(`The storage endpoint did not answer within ${Math.round(S3_TIMEOUTS.operationMs / 1000)} seconds.`, { cause: err });
    }
    if (err instanceof Error && err.name === 'TimeoutError') {
        return new Error('The storage endpoint stopped answering. Check that it is reachable from this host.', { cause: err });
    }
    return null;
}

function sanitizePathSegment(input: string): string {
    // Preserve dotfiles like `.env` while neutralising traversal (`..`) and path separators.
    const cleaned = input.replace(/\.\./g, '_').replace(/[\\/]/g, '_');
    if (/^\.+$/.test(cleaned)) return '_';
    return cleaned;
}

function safeParseJson<T>(value: string | null | undefined, fallback: T): T {
    if (!value) return fallback;
    try { return JSON.parse(value) as T; } catch { return fallback; }
}
