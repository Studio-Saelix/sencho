import { Router, type Request, type Response } from 'express';
import { CloudBackupService } from '../services/CloudBackupService';
import { DatabaseService } from '../services/DatabaseService';
import { CryptoService } from '../services/CryptoService';
import { requireAdmin, requireAdmiral } from '../middleware/tierGates';
import { rejectApiTokenScope } from '../middleware/apiTokenScope';
import { getErrorMessage } from '../utils/errors';

const SCOPE_MESSAGE = 'API tokens cannot manage cloud backup configuration.';
const SECRET_REDACTED = '***';
const VALID_PROVIDERS = new Set(['disabled', 'sencho', 'custom']);

// Provider-aware tier gates. The managed Sencho Cloud Backup target requires
// Admiral; the bring-your-own-bucket Custom S3 target is available on every
// tier. These wrappers short-circuit to requireAdmiral only when the operation
// actually touches the 'sencho' provider.

function gateForCurrentProvider(req: Request, res: Response): boolean {
    const provider = CloudBackupService.getInstance().getProvider();
    if (provider === 'sencho') return requireAdmiral(req, res);
    return true;
}

function gateForRequestedProvider(req: Request, res: Response, requested: string): boolean {
    if (requested === 'sencho') return requireAdmiral(req, res);
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
        if (!provider || !VALID_PROVIDERS.has(provider)) {
            res.status(400).json({ error: 'provider must be one of: disabled, sencho, custom' });
            return;
        }
        if (!gateForRequestedProvider(req, res, provider)) return;
        const db = DatabaseService.getInstance();
        const crypto = CryptoService.getInstance();
        db.updateGlobalSetting('cloud_backup_provider', provider);

        if (provider === 'custom') {
            const c = body.custom ?? {};
            const endpoint = typeof c.endpoint === 'string' ? c.endpoint.trim() : '';
            const region = typeof c.region === 'string' ? c.region.trim() : '';
            const bucket = typeof c.bucket === 'string' ? c.bucket.trim() : '';
            const accessKey = typeof c.access_key === 'string' ? c.access_key.trim() : '';
            const pathPrefix = typeof c.path_prefix === 'string' ? c.path_prefix.trim() : 'sencho/';
            const autoUpload = c.auto_upload === true || c.auto_upload === '1' ? '1' : '0';

            if (!endpoint || !bucket || !accessKey) {
                res.status(400).json({ error: 'endpoint, bucket, and access_key are required for custom S3.' });
                return;
            }
            if (!/^https?:\/\//i.test(endpoint)) {
                res.status(400).json({ error: 'endpoint must start with http:// or https://' });
                return;
            }

            db.updateGlobalSetting('cloud_backup_endpoint', endpoint);
            db.updateGlobalSetting('cloud_backup_region', region);
            db.updateGlobalSetting('cloud_backup_bucket', bucket);
            db.updateGlobalSetting('cloud_backup_access_key', accessKey);
            db.updateGlobalSetting('cloud_backup_path_prefix', pathPrefix);
            db.updateGlobalSetting('cloud_backup_auto_upload', autoUpload);

            const incomingSecret = typeof c.secret_key === 'string' ? c.secret_key : '';
            if (incomingSecret && incomingSecret !== SECRET_REDACTED) {
                db.updateGlobalSetting('cloud_backup_secret_key', crypto.encrypt(incomingSecret));
            }
        }

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
    if (!requireAdmiral(req, res)) return;
    try {
        const result = await CloudBackupService.getInstance().provisionSenchoCloudBackup();
        if (!result.success) {
            res.status(400).json({ error: result.error || 'Provisioning failed' });
            return;
        }
        res.json({ success: true, quota_bytes: result.quotaBytes });
    } catch (error) {
        console.error('[CloudBackup] provision error:', error);
        res.status(500).json({ error: 'Failed to provision Sencho Cloud Backup' });
    }
});

cloudBackupRouter.get('/usage', async (req: Request, res: Response): Promise<void> => {
    if (rejectApiTokenScope(req, res, SCOPE_MESSAGE)) return;
    if (!requireAdmiral(req, res)) return;
    try {
        const svc = CloudBackupService.getInstance();
        if (svc.getProvider() !== 'sencho') {
            res.status(400).json({ error: 'Usage is only available for Sencho Cloud Backup' });
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
    if (!gateForCurrentProvider(req, res)) return;
    try {
        const entries = await CloudBackupService.getInstance().listCloudSnapshots();
        res.json(entries);
    } catch (error) {
        console.error('[CloudBackup] list error:', error);
        res.status(502).json({ error: getErrorMessage(error, 'Failed to list cloud snapshots') });
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
    if (!gateForCurrentProvider(req, res)) return;
    const id = parseSnapshotIdParam(req, res);
    if (id == null) return;
    res.json(CloudBackupService.getInstance().getUploadStatus(id));
});

cloudBackupRouter.get('/object/:keyB64/download', async (req: Request, res: Response): Promise<void> => {
    if (rejectApiTokenScope(req, res, SCOPE_MESSAGE)) return;
    if (!gateForCurrentProvider(req, res)) return;
    const objectKey = decodeObjectKey(req, res);
    if (!objectKey) return;
    try {
        const buffer = await CloudBackupService.getInstance().downloadSnapshot(objectKey);
        const filename = objectKey.split('/').pop() || 'snapshot.tar.gz';
        res.setHeader('Content-Type', 'application/gzip');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Length', String(buffer.byteLength));
        res.end(buffer);
    } catch (error) {
        console.error('[CloudBackup] download error:', error);
        res.status(502).json({ error: getErrorMessage(error, 'Failed to download cloud snapshot') });
    }
});

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
        console.error('[CloudBackup] delete error:', error);
        res.status(502).json({ error: getErrorMessage(error, 'Failed to delete cloud snapshot') });
    }
});
