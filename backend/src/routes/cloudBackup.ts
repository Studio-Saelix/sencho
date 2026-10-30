import { Router, type Request, type Response } from 'express';
import { CloudBackupService, SnapshotKeyError } from '../services/CloudBackupService';
import { DatabaseService } from '../services/DatabaseService';
import { CryptoService } from '../services/CryptoService';
import { ArchiveFormatError, passphraseIsLongEnough } from '../services/cloudBackupArchive';
import { requireAdmin, requirePaid } from '../middleware/tierGates';
import { rejectApiTokenScope } from '../middleware/apiTokenScope';
import { getErrorMessage } from '../utils/errors';

const SCOPE_MESSAGE = 'API tokens cannot manage cloud backup configuration.';
const SECRET_REDACTED = '***';
const VALID_PROVIDERS = new Set(['disabled', 'sencho', 'custom']);

// Provider-aware tier gates. The managed Sencho Cloud Backup target requires
// a paid license; the bring-your-own-bucket Custom S3 target is available on
// every tier. These wrappers short-circuit to requirePaid only when the
// operation actually touches the 'sencho' provider.

function gateForCurrentProvider(req: Request, res: Response): boolean {
    const provider = CloudBackupService.getInstance().getProvider();
    if (provider === 'sencho') return requirePaid(req, res);
    return true;
}

function gateForRequestedProvider(req: Request, res: Response, requested: string): boolean {
    if (requested === 'sencho') return requirePaid(req, res);
    return true;
}

function parseSnapshotIdParam(req: Request, res: Response): number | null {
    const raw = req.params.id as string | undefined;
    const parsed = parseInt(raw ?? '', 10);
    if (isNaN(parsed) || parsed <= 0) {
        res.status(400).json({ error: 'Invalid snapshot ID' });
        return null;
    }
    return parsed;
}

function decodeObjectKey(req: Request, res: Response): string | null {
    const raw = req.params.keyB64 as string | undefined;
    if (!raw) {
        res.status(400).json({ error: 'Missing object key' });
        return null;
    }
    try {
        const decoded = Buffer.from(raw, 'base64url').toString('utf-8');
        if (!decoded || decoded.includes('..') || decoded.startsWith('/')) {
            res.status(400).json({ error: 'Invalid object key' });
            return null;
        }
        return decoded;
    } catch {
        res.status(400).json({ error: 'Invalid object key encoding' });
        return null;
    }
}

function passphraseFromBody(req: Request): string | null {
    const value = req.body?.passphrase;
    if (typeof value !== 'string' || value === '') return null;
    return value;
}

function sendArchiveFailure(res: Response, error: unknown, fallback: string): void {
    if (error instanceof SnapshotKeyError) {
        res.status(400).json({ error: error.message });
        return;
    }
    if (error instanceof ArchiveFormatError) {
        const status = error.code === 'PASSPHRASE_REQUIRED' ? 409 : error.code === 'TOO_LARGE' ? 413 : 400;
        res.status(status).json({ error: error.message, code: error.code });
        return;
    }
    console.error('[CloudBackup] object error:', error);
    res.status(502).json({ error: getErrorMessage(error, fallback) });
}

type ArchiveWrite = { enabling: boolean; hasFlag: boolean; passphrase: string | null };

function planArchiveSettings(body: Record<string, unknown>): ArchiveWrite | string | null {
    const settings = DatabaseService.getInstance().getGlobalSettings();
    const hasFlag = typeof body.encrypt_archives === 'boolean';
    const rawPass = body.archive_passphrase;
    if (!hasFlag && typeof rawPass !== 'string') return null;

    const stored = !!settings.cloud_backup_archive_passphrase;
    const enabling = hasFlag ? body.encrypt_archives === true : settings.cloud_backup_encrypt_archives === '1';
    const passphrase = typeof rawPass === 'string' && rawPass !== '' && rawPass !== SECRET_REDACTED
        ? rawPass
        : null;
    if (passphrase && !passphraseIsLongEnough(passphrase)) return 'Archive passphrase must be at least 12 characters';
    if (enabling && !passphrase && !stored) return 'Save an archive passphrase before enabling encryption';
    return { enabling, hasFlag, passphrase };
}

function writeArchiveSettings(plan: ArchiveWrite): void {
    const db = DatabaseService.getInstance();
    if (plan.passphrase) {
        db.updateGlobalSetting('cloud_backup_archive_passphrase', CryptoService.getInstance().encrypt(plan.passphrase));
    }
    if (plan.hasFlag) db.updateGlobalSetting('cloud_backup_encrypt_archives', plan.enabling ? '1' : '0');
}

function archiveDownloadName(objectKey: string): string {
    const base = objectKey.split('/').pop() || 'snapshot.tar.gz';
    const stripped = base.endsWith('.senc') ? base.slice(0, -'.senc'.length) : base;
    return /^[A-Za-z0-9._-]+$/.test(stripped) ? stripped : 'snapshot.tar.gz';
}

export const cloudBackupRouter = Router();

cloudBackupRouter.get('/config', (req: Request, res: Response): void => {
    if (rejectApiTokenScope(req, res, SCOPE_MESSAGE)) return;
    try {
        const db = DatabaseService.getInstance();
        const settings = db.getGlobalSettings();
        const provider = CloudBackupService.getInstance().getProvider();
        const senchoProvisioned = !!db.getSystemState('sencho_cloud_backup_provisioned_at');
        res.json({
            provider,
            sencho_provisioned: senchoProvisioned,
            sencho_provisioned_at: db.getSystemState('sencho_cloud_backup_provisioned_at'),
            custom: {
                endpoint: settings.cloud_backup_endpoint || '',
                region: settings.cloud_backup_region || '',
                bucket: settings.cloud_backup_bucket || '',
                access_key: settings.cloud_backup_access_key || '',
                secret_key: settings.cloud_backup_secret_key ? SECRET_REDACTED : '',
                path_prefix: settings.cloud_backup_path_prefix || 'sencho/',
                auto_upload: settings.cloud_backup_auto_upload === '1',
            },
            encrypt_archives: settings.cloud_backup_encrypt_archives === '1',
            archive_passphrase: settings.cloud_backup_archive_passphrase ? SECRET_REDACTED : '',
        });
    } catch (error) {
        console.error('[CloudBackup] config get error:', error);
        res.status(500).json({ error: 'Failed to load cloud backup config' });
    }
});

cloudBackupRouter.put('/config', (req: Request, res: Response): void => {
    if (rejectApiTokenScope(req, res, SCOPE_MESSAGE)) return;
    if (!requireAdmin(req, res)) return;
    try {
        const body = req.body ?? {};
        const provider = body.provider as string | undefined;
        if (provider !== undefined && (typeof provider !== 'string' || !VALID_PROVIDERS.has(provider))) {
            res.status(400).json({ error: 'provider must be one of: disabled, sencho, custom' });
            return;
        }
        if (provider !== undefined && !gateForRequestedProvider(req, res, provider)) return;
        const archivePlan = planArchiveSettings(body as Record<string, unknown>);
        if (typeof archivePlan === 'string') {
            res.status(400).json({ error: archivePlan });
            return;
        }
        // An encryption-only write must not touch the destination: saving a
        // passphrase never carries unsaved S3 form drafts with it.
        if (provider === undefined && !archivePlan) {
            res.status(400).json({ error: 'No cloud backup changes were supplied' });
            return;
        }
        const db = DatabaseService.getInstance();
        const crypto = CryptoService.getInstance();

        // Validate the whole destination before writing anything, so a rejected
        // field cannot leave a half-applied provider change behind.
        let custom: { endpoint: string; region: string; bucket: string; accessKey: string; pathPrefix: string; autoUpload: string; secretKey: string } | null = null;
        if (provider === 'custom') {
            const c = body.custom ?? {};
            custom = {
                endpoint: typeof c.endpoint === 'string' ? c.endpoint.trim() : '',
                region: typeof c.region === 'string' ? c.region.trim() : '',
                bucket: typeof c.bucket === 'string' ? c.bucket.trim() : '',
                accessKey: typeof c.access_key === 'string' ? c.access_key.trim() : '',
                pathPrefix: typeof c.path_prefix === 'string' ? c.path_prefix.trim() : 'sencho/',
                autoUpload: c.auto_upload === true || c.auto_upload === '1' ? '1' : '0',
                secretKey: typeof c.secret_key === 'string' ? c.secret_key : '',
            };
            if (!custom.endpoint || !custom.bucket || !custom.accessKey) {
                res.status(400).json({ error: 'endpoint, bucket, and access_key are required for custom S3.' });
                return;
            }
            if (!/^https?:\/\//i.test(custom.endpoint)) {
                res.status(400).json({ error: 'endpoint must start with http:// or https://' });
                return;
            }
        }

        if (provider !== undefined) db.updateGlobalSetting('cloud_backup_provider', provider);

        if (custom) {
            db.updateGlobalSetting('cloud_backup_endpoint', custom.endpoint);
            db.updateGlobalSetting('cloud_backup_region', custom.region);
            db.updateGlobalSetting('cloud_backup_bucket', custom.bucket);
            db.updateGlobalSetting('cloud_backup_access_key', custom.accessKey);
            db.updateGlobalSetting('cloud_backup_path_prefix', custom.pathPrefix);
            db.updateGlobalSetting('cloud_backup_auto_upload', custom.autoUpload);

            if (custom.secretKey && custom.secretKey !== SECRET_REDACTED) {
                db.updateGlobalSetting('cloud_backup_secret_key', crypto.encrypt(custom.secretKey));
            }
        }

        if (archivePlan) writeArchiveSettings(archivePlan);

        res.status(204).send();
    } catch (error) {
        console.error('[CloudBackup] config update error:', error);
        res.status(500).json({ error: 'Failed to save cloud backup config' });
    }
});

cloudBackupRouter.post('/test', async (req: Request, res: Response): Promise<void> => {
    if (rejectApiTokenScope(req, res, SCOPE_MESSAGE)) return;
    if (!requireAdmin(req, res)) return;
    if (!gateForCurrentProvider(req, res)) return;
    try {
        const result = await CloudBackupService.getInstance().testConnection();
        res.json(result);
    } catch (error) {
        console.error('[CloudBackup] test error:', error);
        res.status(500).json({ success: false, error: getErrorMessage(error, 'Connection test failed') });
    }
});

cloudBackupRouter.post('/provision', async (req: Request, res: Response): Promise<void> => {
    if (rejectApiTokenScope(req, res, SCOPE_MESSAGE)) return;
    if (!requireAdmin(req, res)) return;
    if (!requirePaid(req, res)) return;
    try {
        const result = await CloudBackupService.getInstance().provisionSenchoCloudBackup();
        if (!result.success) {
            res.status(400).json({ error: result.error || 'Provisioning failed' });
            return;
        }
        res.json({ success: true, quota_bytes: result.quotaBytes });
    } catch (error) {
        console.error('[CloudBackup] provision error:', error);
        res.status(500).json({ error: 'Failed to provision Recovery Vault' });
    }
});

cloudBackupRouter.get('/usage', async (req: Request, res: Response): Promise<void> => {
    if (rejectApiTokenScope(req, res, SCOPE_MESSAGE)) return;
    if (!requirePaid(req, res)) return;
    try {
        const svc = CloudBackupService.getInstance();
        if (svc.getProvider() !== 'sencho') {
            res.status(400).json({ error: 'Usage is only available for Recovery Vault' });
            return;
        }
        const usage = await svc.getSenchoCloudBackupUsage();
        res.json(usage);
    } catch (error) {
        console.error('[CloudBackup] usage error:', error);
        res.status(502).json({ error: getErrorMessage(error, 'Failed to fetch usage') });
    }
});

cloudBackupRouter.get('/snapshots', async (req: Request, res: Response): Promise<void> => {
    if (rejectApiTokenScope(req, res, SCOPE_MESSAGE)) return;
    if (!requireAdmin(req, res)) return;
    if (!gateForCurrentProvider(req, res)) return;
    try {
        const entries = await CloudBackupService.getInstance().listCloudSnapshots();
        res.json(entries);
    } catch (error) {
        console.error('[CloudBackup] list error:', error);
        res.status(502).json({ error: getErrorMessage(error, 'Failed to list cloud snapshots') });
    }
});

// Archives from other instances, so a fresh installation can find what it is
// recovering. Read-only: recovery still needs the passphrase.
cloudBackupRouter.get('/recovery-archives', async (req: Request, res: Response): Promise<void> => {
    if (rejectApiTokenScope(req, res, SCOPE_MESSAGE)) return;
    if (!requireAdmin(req, res)) return;
    if (!gateForCurrentProvider(req, res)) return;
    try {
        const entries = await CloudBackupService.getInstance().listRecoveryArchives();
        res.json(entries);
    } catch (error) {
        console.error('[CloudBackup] recovery list error:', error);
        res.status(502).json({ error: getErrorMessage(error, 'Failed to list recovery archives') });
    }
});

cloudBackupRouter.post('/upload/:id', async (req: Request, res: Response): Promise<void> => {
    if (rejectApiTokenScope(req, res, SCOPE_MESSAGE)) return;
    if (!requireAdmin(req, res)) return;
    if (!gateForCurrentProvider(req, res)) return;
    const id = parseSnapshotIdParam(req, res);
    if (id == null) return;
    try {
        const db = DatabaseService.getInstance();
        if (!db.getSnapshot(id)) {
            res.status(404).json({ error: 'Snapshot not found' });
            return;
        }
        await CloudBackupService.getInstance().uploadSnapshot(id);
        res.status(202).json({ status: 'success', snapshot_id: id });
    } catch (error) {
        console.error('[CloudBackup] upload error:', error);
        res.status(502).json({ error: getErrorMessage(error, 'Cloud upload failed') });
    }
});

cloudBackupRouter.get('/status/:id', (req: Request, res: Response): void => {
    if (rejectApiTokenScope(req, res, SCOPE_MESSAGE)) return;
    if (!requireAdmin(req, res)) return;
    if (!gateForCurrentProvider(req, res)) return;
    const id = parseSnapshotIdParam(req, res);
    if (id == null) return;
    res.json(CloudBackupService.getInstance().getUploadStatus(id));
});

cloudBackupRouter.get('/object/:keyB64/download', async (req: Request, res: Response): Promise<void> => {
    if (rejectApiTokenScope(req, res, SCOPE_MESSAGE)) return;
    if (!requireAdmin(req, res)) return;
    if (!gateForCurrentProvider(req, res)) return;
    const objectKey = decodeObjectKey(req, res);
    if (!objectKey) return;
    try {
        const buffer = await CloudBackupService.getInstance().downloadSnapshot(objectKey, null);
        sendArchive(res, objectKey, buffer);
    } catch (error) {
        sendArchiveFailure(res, error, 'Failed to download cloud snapshot');
    }
});

cloudBackupRouter.post('/object/:keyB64/download', async (req: Request, res: Response): Promise<void> => {
    if (rejectApiTokenScope(req, res, SCOPE_MESSAGE)) return;
    if (!requireAdmin(req, res)) return;
    if (!gateForCurrentProvider(req, res)) return;
    const objectKey = decodeObjectKey(req, res);
    if (!objectKey) return;
    try {
        const buffer = await CloudBackupService.getInstance().downloadSnapshot(objectKey, passphraseFromBody(req));
        sendArchive(res, objectKey, buffer);
    } catch (error) {
        sendArchiveFailure(res, error, 'Failed to download cloud snapshot');
    }
});

cloudBackupRouter.post('/object/:keyB64/import', async (req: Request, res: Response): Promise<void> => {
    if (rejectApiTokenScope(req, res, SCOPE_MESSAGE)) return;
    if (!requireAdmin(req, res)) return;
    if (!gateForCurrentProvider(req, res)) return;
    const objectKey = decodeObjectKey(req, res);
    if (!objectKey) return;
    try {
        const snapshotId = await CloudBackupService.getInstance().importSnapshot(objectKey, passphraseFromBody(req));
        res.status(201).json({ snapshot_id: snapshotId });
    } catch (error) {
        sendArchiveFailure(res, error, 'Failed to import cloud snapshot');
    }
});

// Disaster recovery from another installation. A fresh instance has a new
// instance id, so its own prefix cannot reach the old archives; this path reads
// any instance's archive in the configured bucket and accepts only a sealed
// archive opened with the supplied passphrase.
cloudBackupRouter.post('/recover', async (req: Request, res: Response): Promise<void> => {
    if (rejectApiTokenScope(req, res, SCOPE_MESSAGE)) return;
    if (!requireAdmin(req, res)) return;
    if (!gateForCurrentProvider(req, res)) return;
    const objectKey = typeof req.body?.object_key === 'string' ? req.body.object_key.trim() : '';
    if (!objectKey) {
        res.status(400).json({ error: 'object_key is required' });
        return;
    }
    const passphrase = passphraseFromBody(req);
    if (!passphrase) {
        res.status(409).json({ error: 'A passphrase is required to recover an archive', code: 'PASSPHRASE_REQUIRED' });
        return;
    }
    try {
        const snapshotId = await CloudBackupService.getInstance().importRecoveryArchive(objectKey, passphrase);
        res.status(201).json({ snapshot_id: snapshotId });
    } catch (error) {
        sendArchiveFailure(res, error, 'Failed to recover cloud snapshot');
    }
});

function sendArchive(res: Response, objectKey: string, buffer: Buffer): void {
    const filename = archiveDownloadName(objectKey);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.byteLength));
    res.end(buffer);
}

cloudBackupRouter.delete('/object/:keyB64', async (req: Request, res: Response): Promise<void> => {
    if (rejectApiTokenScope(req, res, SCOPE_MESSAGE)) return;
    if (!requireAdmin(req, res)) return;
    if (!gateForCurrentProvider(req, res)) return;
    const objectKey = decodeObjectKey(req, res);
    if (!objectKey) return;
    try {
        await CloudBackupService.getInstance().deleteCloudSnapshot(objectKey);
        res.status(204).send();
    } catch (error) {
        sendArchiveFailure(res, error, 'Failed to delete cloud snapshot');
    }
});
