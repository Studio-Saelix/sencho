import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { requirePaid, requireAdmin, requireBody } from '../middleware/tierGates';
import { rejectApiTokenScope } from '../middleware/apiTokenScope';
import { SecretsService, PushBusyError, type SecretKv } from '../services/SecretsService';
import { DatabaseService, type BlueprintSelector } from '../services/DatabaseService';
import { isValidStackName } from '../utils/validation';
import { getErrorMessage, isSqliteUniqueViolation } from '../utils/errors';
import { parseIntParam } from '../utils/parseIntParam';
import { sanitizeForLog } from '../utils/safeLog';

export const secretsRouter = Router();

// Fleet Secrets reveals decrypted values and writes credentials fleet-wide, so
// it is a session-admin surface only: long-lived API tokens are rejected outright
// (same posture as registry credentials), before any tier/role gate.
const SECRETS_SCOPE_MESSAGE = 'API tokens cannot manage Fleet Secrets.';

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,62}[a-zA-Z0-9]$/;

function isValidName(name: unknown): name is string {
    return typeof name === 'string' && NAME_PATTERN.test(name);
}

function isValidEnvFileBasename(name: unknown): name is string {
    if (typeof name !== 'string' || name.length === 0 || name.length > 64) return false;
    if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') return false;
    return /^[A-Za-z0-9._-]+$/.test(name);
}

function isValidKv(value: unknown): value is SecretKv {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof k !== 'string' || typeof v !== 'string') return false;
    }
    return true;
}

function isValidSelector(value: unknown): value is BlueprintSelector {
    if (!value || typeof value !== 'object') return false;
    const sel = value as { type?: unknown; ids?: unknown; any?: unknown; all?: unknown };
    if (sel.type === 'nodes') {
        return Array.isArray(sel.ids) && sel.ids.every(id => typeof id === 'number');
    }
    if (sel.type === 'labels') {
        const isStringArr = (a: unknown) => Array.isArray(a) && a.every(s => typeof s === 'string');
        return isStringArr(sel.any) && isStringArr(sel.all);
    }
    return false;
}

function getActor(req: Request): string {
    return req.user?.username || 'unknown';
}

interface PushBody { selector: BlueprintSelector; stackName: string; envFileBasename: string }

function parsePushBody(body: unknown): PushBody | { error: string } {
    if (!body || typeof body !== 'object') return { error: 'Request body is required' };
    const { selector, stackName, envFileBasename } = body as { selector?: unknown; stackName?: unknown; envFileBasename?: unknown };
    if (!isValidSelector(selector)) return { error: 'selector is invalid' };
    if (typeof stackName !== 'string' || !isValidStackName(stackName)) return { error: 'stackName is invalid' };
    const basename = envFileBasename === undefined ? '.env' : envFileBasename;
    if (!isValidEnvFileBasename(basename)) return { error: 'envFileBasename is invalid' };
    return { selector, stackName, envFileBasename: basename };
}

secretsRouter.get('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    if (rejectApiTokenScope(req, res, SECRETS_SCOPE_MESSAGE)) return;
    if (!requirePaid(req, res)) return;
    if (!requireAdmin(req, res)) return;
    try {
        const items = SecretsService.getInstance().list();
        res.json(items);
    } catch (err) {
        console.error('[Secrets] List error:', err);
        res.status(500).json({ error: 'Failed to list secrets' });
    }
});

secretsRouter.post('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    if (rejectApiTokenScope(req, res, SECRETS_SCOPE_MESSAGE)) return;
    if (!requirePaid(req, res)) return;
    if (!requireAdmin(req, res)) return;
    if (!requireBody(req, res)) return;
    try {
        const { name, description, kv, note } = req.body as { name?: unknown; description?: unknown; kv?: unknown; note?: unknown };
        if (!isValidName(name)) {
            res.status(400).json({ error: 'name is required (letters, digits, spaces, dot, dash, underscore; 2-64 chars)' });
            return;
        }
        if (description !== undefined && typeof description !== 'string') {
            res.status(400).json({ error: 'description must be a string' });
            return;
        }
        if (!isValidKv(kv)) {
            res.status(400).json({ error: 'kv must be an object of string values' });
            return;
        }
        if (note !== undefined && typeof note !== 'string') {
            res.status(400).json({ error: 'note must be a string' });
            return;
        }
        const result = SecretsService.getInstance().create({
            name,
            description: typeof description === 'string' ? description : undefined,
            kv,
            user: getActor(req),
            note: typeof note === 'string' ? note : undefined,
        });
        console.log(`[Secrets] Created bundle ${sanitizeForLog(name)} (v${result.version}) by ${sanitizeForLog(getActor(req))}`);
        res.status(201).json(result);
    } catch (err) {
        if (isSqliteUniqueViolation(err)) {
            res.status(409).json({ error: 'A secret with that name already exists' });
            return;
        }
        console.error('[Secrets] Create error:', err);
        res.status(500).json({ error: getErrorMessage(err, 'Failed to create secret') });
    }
});

secretsRouter.get('/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    if (rejectApiTokenScope(req, res, SECRETS_SCOPE_MESSAGE)) return;
    if (!requirePaid(req, res)) return;
    if (!requireAdmin(req, res)) return;
    try {
        const id = parseIntParam(req, res, 'id', 'secret ID');
        if (id === null) return;
        const summary = SecretsService.getInstance().getCurrent(id);
        if (!summary) {
            res.status(404).json({ error: 'Secret not found' });
            return;
        }
        const kv = SecretsService.getInstance().getDecryptedKv(id);
        res.json({ ...summary, kv });
    } catch (err) {
        console.error('[Secrets] Get error:', err);
        res.status(500).json({ error: 'Failed to read secret' });
    }
});

secretsRouter.put('/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    if (rejectApiTokenScope(req, res, SECRETS_SCOPE_MESSAGE)) return;
    if (!requirePaid(req, res)) return;
    if (!requireAdmin(req, res)) return;
    if (!requireBody(req, res)) return;
    try {
        const id = parseIntParam(req, res, 'id', 'secret ID');
        if (id === null) return;
        const { description, kv, note } = req.body as { description?: unknown; kv?: unknown; note?: unknown };
        if (description !== undefined && typeof description !== 'string') {
            res.status(400).json({ error: 'description must be a string' });
            return;
        }
        if (!isValidKv(kv)) {
            res.status(400).json({ error: 'kv must be an object of string values' });
            return;
        }
        if (note !== undefined && typeof note !== 'string') {
            res.status(400).json({ error: 'note must be a string' });
            return;
        }
        const existing = DatabaseService.getInstance().getSecret(id);
        if (!existing) {
            res.status(404).json({ error: 'Secret not found' });
            return;
        }
        const result = SecretsService.getInstance().update(id, {
            description: typeof description === 'string' ? description : undefined,
            kv,
            user: getActor(req),
            note: typeof note === 'string' ? note : undefined,
        });
        console.log(`[Secrets] Updated bundle ${sanitizeForLog(existing.name)} to v${result.version} by ${sanitizeForLog(getActor(req))}`);
        res.json(result);
    } catch (err) {
        console.error('[Secrets] Update error:', err);
        res.status(500).json({ error: getErrorMessage(err, 'Failed to update secret') });
    }
});

secretsRouter.delete('/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    if (rejectApiTokenScope(req, res, SECRETS_SCOPE_MESSAGE)) return;
    if (!requirePaid(req, res)) return;
    if (!requireAdmin(req, res)) return;
    try {
        const id = parseIntParam(req, res, 'id', 'secret ID');
        if (id === null) return;
        const ok = SecretsService.getInstance().delete(id);
        if (!ok) {
            res.status(404).json({ error: 'Secret not found' });
            return;
        }
        console.log(`[Secrets] Deleted bundle id=${id} by ${sanitizeForLog(getActor(req))}`);
        res.json({ ok: true });
    } catch (err) {
        console.error('[Secrets] Delete error:', err);
        res.status(500).json({ error: 'Failed to delete secret' });
    }
});

secretsRouter.get('/:id/versions', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    if (rejectApiTokenScope(req, res, SECRETS_SCOPE_MESSAGE)) return;
    if (!requirePaid(req, res)) return;
    if (!requireAdmin(req, res)) return;
    try {
        const id = parseIntParam(req, res, 'id', 'secret ID');
        if (id === null) return;
        if (!DatabaseService.getInstance().getSecret(id)) {
            res.status(404).json({ error: 'Secret not found' });
            return;
        }
        res.json(SecretsService.getInstance().listVersions(id));
    } catch (err) {
        console.error('[Secrets] Versions error:', err);
        res.status(500).json({ error: 'Failed to list versions' });
    }
});

secretsRouter.post('/:id/import-from-stack', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    if (rejectApiTokenScope(req, res, SECRETS_SCOPE_MESSAGE)) return;
    if (!requirePaid(req, res)) return;
    if (!requireAdmin(req, res)) return;
    if (!requireBody(req, res)) return;
    try {
        const id = parseIntParam(req, res, 'id', 'secret ID');
        if (id === null) return;
        const { nodeId, stackName, envFileBasename } = req.body as { nodeId?: unknown; stackName?: unknown; envFileBasename?: unknown };
        if (typeof nodeId !== 'number' || !Number.isFinite(nodeId)) {
            res.status(400).json({ error: 'nodeId must be a number' });
            return;
        }
        if (typeof stackName !== 'string' || !isValidStackName(stackName)) {
            res.status(400).json({ error: 'stackName is invalid' });
            return;
        }
        const basename = envFileBasename === undefined ? '.env' : envFileBasename;
        if (!isValidEnvFileBasename(basename)) {
            res.status(400).json({ error: 'envFileBasename is invalid' });
            return;
        }
        const kv = await SecretsService.getInstance().importFromStack(nodeId, stackName, basename);
        res.json({ kv });
    } catch (err) {
        console.error('[Secrets] Import error:', err);
        res.status(500).json({ error: getErrorMessage(err, 'Failed to import env from stack') });
    }
});

secretsRouter.post('/:id/push/preview', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    if (rejectApiTokenScope(req, res, SECRETS_SCOPE_MESSAGE)) return;
    if (!requirePaid(req, res)) return;
    if (!requireAdmin(req, res)) return;
    if (!requireBody(req, res)) return;
    try {
        const id = parseIntParam(req, res, 'id', 'secret ID');
        if (id === null) return;
        const parsed = parsePushBody(req.body);
        if ('error' in parsed) {
            res.status(400).json({ error: parsed.error });
            return;
        }
        if (!DatabaseService.getInstance().getSecret(id)) {
            res.status(404).json({ error: 'Secret not found' });
            return;
        }
        const plan = await SecretsService.getInstance().previewPushDiff(id, parsed.selector, parsed.stackName, parsed.envFileBasename);
        res.json(plan);
    } catch (err) {
        console.error('[Secrets] Preview error:', err);
        res.status(500).json({ error: getErrorMessage(err, 'Failed to preview push') });
    }
});

secretsRouter.post('/:id/push', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    if (rejectApiTokenScope(req, res, SECRETS_SCOPE_MESSAGE)) return;
    if (!requirePaid(req, res)) return;
    if (!requireAdmin(req, res)) return;
    if (!requireBody(req, res)) return;
    try {
        const id = parseIntParam(req, res, 'id', 'secret ID');
        if (id === null) return;
        const parsed = parsePushBody(req.body);
        if ('error' in parsed) {
            res.status(400).json({ error: parsed.error });
            return;
        }
        const secret = DatabaseService.getInstance().getSecret(id);
        if (!secret) {
            res.status(404).json({ error: 'Secret not found' });
            return;
        }
        try {
            const result = await SecretsService.getInstance().executePush(id, parsed.selector, parsed.stackName, parsed.envFileBasename, getActor(req));
            const failedCount = result.results.filter(r => r.status === 'failed').length;
            console.log(`[Secrets] Push ${sanitizeForLog(secret.name)} v${secret.current_version}: ${result.results.length} node(s), ${failedCount} failed (by ${sanitizeForLog(getActor(req))})`);
            if (failedCount > 0) console.warn(`[Secrets] Push ${sanitizeForLog(secret.name)} v${secret.current_version}: ${failedCount} node(s) failed`);
            res.json(result);
        } catch (err) {
            if (err instanceof PushBusyError) {
                res.status(409).json({ error: 'A push for this secret is already running' });
                return;
            }
            throw err;
        }
    } catch (err) {
        console.error('[Secrets] Push error:', err);
        res.status(500).json({ error: getErrorMessage(err, 'Failed to push secret') });
    }
});
