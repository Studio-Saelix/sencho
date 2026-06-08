/**
 * CloudBackupService — off-site replication for fleet snapshots.
 *
 * Two providers share the same S3-compatible code path:
 *   - 'sencho' : managed Sencho Cloud Backup. Credentials provisioned by
 *                sencho.io/api/cloud-backup/provision and stored in system_state.
 *   - 'custom' : bring-your-own-bucket. Credentials user-configured in global_settings.
 *
 * Routes call this service after a snapshot is persisted to SQLite. The service
 * reads snapshot rows from DatabaseService, packs them into a tar.gz archive,
 * and uploads via @aws-sdk/client-s3.
 */

import { Readable } from 'stream';
import * as zlib from 'zlib';
import * as tar from 'tar-stream';
import axios from 'axios';
import { DatabaseService, type FleetSnapshotFile } from './DatabaseService';
import { CryptoService } from './CryptoService';
import { LicenseService } from './LicenseService';
import { getErrorMessage } from '../utils/errors';
import { isDebugEnabled } from '../utils/debug';

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

    // ─── Sencho Cloud Backup lifecycle ─────────────────────────────────────────

    public async provisionSenchoCloudBackup(): Promise<ProvisionResult> {
        const db = DatabaseService.getInstance();
        const crypto = CryptoService.getInstance();
        const licenseKey = db.getSystemState('license_key');
        if (!licenseKey) return { success: false, error: 'No license key found. Activate an Admiral license first.' };

        if (LicenseService.getInstance().getTier() !== 'paid') {
            return { success: false, error: 'Sencho Cloud Backup requires the Admiral tier.' };
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
            return { success: false, error: responseError || getErrorMessage(err, 'Failed to provision Sencho Cloud Backup.') };
        }
    }

    public async refreshSenchoCloudBackupCredentials(): Promise<void> {
        const result = await this.provisionSenchoCloudBackup();
        if (!result.success) throw new Error(result.error || 'Failed to refresh Sencho Cloud Backup credentials.');
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
            const { client, sdk } = await this.buildS3Client(cfg);
            await client.send(new sdk.HeadBucketCommand({ Bucket: cfg.bucket }));
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
        const objectKey = this.buildObjectKey(cfg, snapshot.id, snapshot.description, snapshot.created_at);

        this.setStatus(snapshotId, { status: 'uploading', objectKey, updatedAt: Date.now() });
        try {
            const archive = await this.buildArchive(snapshot, files, documentation);
            const { client, sdk } = await this.buildS3Client(cfg);
            await client.send(new sdk.PutObjectCommand({
                Bucket: cfg.bucket,
                Key: objectKey,
                Body: archive,
                ContentType: 'application/gzip',
            }));
            this.setStatus(snapshotId, { status: 'success', objectKey, updatedAt: Date.now() });
            if (isDebugEnabled()) {
                console.log(`[CloudBackup:debug] Uploaded snapshot ${snapshotId} (${archive.byteLength} bytes) to ${cfg.bucket}/${objectKey}`);
            }
        } catch (err) {
            const message = getErrorMessage(err, 'Cloud upload failed.');
            this.setStatus(snapshotId, { status: 'failed', objectKey, error: message, updatedAt: Date.now() });
            throw new Error(message);
        }
    }

    public async downloadSnapshot(objectKey: string): Promise<Buffer> {
        const cfg = this.getResolvedConfig();
        if (!cfg) throw new Error('Cloud backup is not configured.');
        const { client, sdk } = await this.buildS3Client(cfg);
        const result = await client.send(new sdk.GetObjectCommand({ Bucket: cfg.bucket, Key: objectKey }));
        const body = result.Body as Readable | undefined;
        if (!body) throw new Error('Empty response body.');
        return await streamToBuffer(body);
    }

    public async listCloudSnapshots(): Promise<CloudSnapshotEntry[]> {
        const cfg = this.getResolvedConfig();
        if (!cfg) return [];
        const { client, sdk } = await this.buildS3Client(cfg);
        const prefix = `${cfg.pathPrefix}instances/${this.getInstanceId()}/snapshots/`;
        const result = await client.send(new sdk.ListObjectsV2Command({
            Bucket: cfg.bucket,
            Prefix: prefix,
            MaxKeys: 1000,
        }));
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
                };
            })
            .sort((a, b) => (b.lastModified || '').localeCompare(a.lastModified || ''));
    }

    public async deleteCloudSnapshot(objectKey: string): Promise<void> {
        const cfg = this.getResolvedConfig();
        if (!cfg) throw new Error('Cloud backup is not configured.');
        const { client, sdk } = await this.buildS3Client(cfg);
        await client.send(new sdk.DeleteObjectCommand({ Bucket: cfg.bucket, Key: objectKey }));
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

    private async buildS3Client(cfg: ResolvedCloudConfig): Promise<{ client: S3Client; sdk: S3Sdk }> {
        const sdk = await loadS3Sdk();
        const client = new sdk.S3Client({
            endpoint: cfg.endpoint,
            region: cfg.region,
            credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
            forcePathStyle: true,
        });
        return { client, sdk };
    }

    private getInstanceId(): string {
        return DatabaseService.getInstance().getSystemState('instance_id') || 'unknown';
    }

    private buildObjectKey(cfg: ResolvedCloudConfig, snapshotId: number, description: string, createdAt: number): string {
        const ts = new Date(createdAt).toISOString().replace(/[:.]/g, '-');
        const slug = description.slice(0, 40).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'snapshot';
        return `${cfg.pathPrefix}instances/${this.getInstanceId()}/snapshots/${snapshotId}_${ts}_${slug}.tar.gz`;
    }

    private async buildArchive(
        snapshot: { id: number; description: string; created_by: string; node_count: number; stack_count: number; skipped_nodes: string; created_at: number },
        files: FleetSnapshotFile[],
        documentation = '',
    ): Promise<Buffer> {
        const pack = tar.pack();
        const metadata = {
            id: snapshot.id,
            description: snapshot.description,
            created_by: snapshot.created_by,
            created_at: snapshot.created_at,
            node_count: snapshot.node_count,
            stack_count: snapshot.stack_count,
            skipped_nodes: safeParseJson(snapshot.skipped_nodes, []),
            has_documentation: documentation !== '',
            instance_id: this.getInstanceId(),
            // Version 2 adds the optional documentation.json entry; readers of
            // version 1 archives simply will not find that file.
            archive_version: 2,
        };
        pack.entry({ name: 'metadata.json' }, JSON.stringify(metadata, null, 2));

        // Captured Stack Dossier metadata travels with the archive when present.
        if (documentation !== '') {
            pack.entry({ name: 'documentation.json' }, documentation);
        }

        for (const file of files) {
            const safeNodeName = sanitizePathSegment(file.node_name);
            const safeStackName = sanitizePathSegment(file.stack_name);
            const safeFilename = sanitizePathSegment(file.filename);
            const entryPath = `nodes/${file.node_id}_${safeNodeName}/${safeStackName}/${safeFilename}`;
            pack.entry({ name: entryPath }, file.content);
        }
        pack.finalize();

        const gzip = zlib.createGzip();
        const chunks: Buffer[] = [];
        return await new Promise<Buffer>((resolve, reject) => {
            gzip.on('data', (chunk: Buffer) => chunks.push(chunk));
            gzip.on('end', () => resolve(Buffer.concat(chunks)));
            gzip.on('error', reject);
            pack.on('error', reject);
            pack.pipe(gzip);
        });
    }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function streamToBuffer(stream: Readable): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
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
