import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { requireAdmin, requireUserSession, requireBody } from '../middleware/tierGates';
import {
    SecretsService,
    PushBusyError,
    RevealTargetError,
    SecretOpError,
    SecretPayloadError,
    SecretSourceChangedError,
    SecretSourceError,
    type SecretPatchOp,
} from '../services/SecretsService';
import { DatabaseService, SecretVersionConflictError, type BlueprintSelector } from '../services/DatabaseService';
import { isValidStackName } from '../utils/validation';
import { getErrorMessage, isSqliteUniqueViolation } from '../utils/errors';
import { parseIntParam } from '../utils/parseIntParam';
import { sanitizeForLog } from '../utils/safeLog';

export const secretsRouter = Router();

// Fleet Secrets holds operator-owned credentials, so every route requires a
// signed-in admin user. requireUserSession rejects API tokens and node_proxy /
// pilot_tunnel machine credentials (authMiddleware maps the latter to role
// 'admin'), then requireAdmin enforces the role.
//
// Bundle reads are always masked: key names and metadata only. Plaintext leaves
// the server only through one short-lived, single-use reveal per key.
secretsRouter.use((_req: Request, res: Response, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,62}[a-zA-Z0-9]$/;
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_PATCH_OPS = 500;

function isValidName(name: unknown): name is string {
    return typeof name === 'string' && NAME_PATTERN.test(name);
}

function isValidEnvFileBasename(name: unknown): name is string {
    if (typeof name !== 'string' || name.length === 0 || name.length > 64) return false;
    if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') return false;
    return /^[A-Za-z0-9._-]+$/.test(name);
}

function isValidKv(value: unknown): value is Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof k !== 'string' || typeof v !== 'string') return false;
    }
    return true;
}

function isValidKey(key: unknown): key is string {
    return typeof key === 'string' && KEY_PATTERN.test(key);
}

function isValidOpList(value: unknown): value is SecretPatchOp[] {
    if (!Array.isArray(value) || value.length > MAX_PATCH_OPS) return false;
    return value.every((entry) => {
        if (!entry || typeof entry !== 'object') return false;
        const op = entry as { op?: unknown; key?: unknown; value?: unknown; from?: unknown; to?: unknown };
        if (op.op === 'set') return isValidKey(op.key) && typeof op.value === 'string';
        if (op.op === 'remove') return isValidKey(op.key);
        if (op.op === 'rename') return isValidKey(op.from) && isValidKey(op.to) && op.from !== op.to;
        return false;
    });
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

/** Request bodies never carry a version as a string; keep the check in one place. */
function parseVersion(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null;
    return value;
}

function getActor(req: Request): string {
    return req.user?.username || 'unknown';
}

/** Grant binding uses the database id, so a recreated account cannot inherit a stale grant. */
function getActorId(req: Request): number {
    return req.user?.userId ?? 0;
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

interface ImportBody { nodeId: number; stackName: string; envFileBasename: string }

function parseImportBody(body: unknown): ImportBody | { error: string } {
    if (!body || typeof body !== 'object') return { error: 'Request body is required' };
    const { nodeId, stackName, envFileBasename } = body as { nodeId?: unknown; stackName?: unknown; envFileBasename?: unknown };
    if (typeof nodeId !== 'number' || !Number.isFinite(nodeId)) return { error: 'nodeId must be a number' };
    if (typeof stackName !== 'string' || !isValidStackName(stackName)) return { error: 'stackName is invalid' };
    const basename = envFileBasename === undefined ? '.env' : envFileBasename;
    if (!isValidEnvFileBasename(basename)) return { error: 'envFileBasename is invalid' };
    return { nodeId, stackName, envFileBasename: basename };
}

function sendVersionConflict(res: Response, err: SecretVersionConflictError): void {
    res.status(409).json({
        error: 'This bundle changed since you opened it. Reload it and apply your edit again.',
        code: 'VERSION_CONFLICT',
        currentVersion: err.currentVersion,
    });
}

/** Log which operation failed and its frames, never its message: an error can quote a secret or a request body. */
function logServiceError(operation: string, err: unknown): void {
    const name = err instanceof Error ? err.name : 'unknown error';
    const frames = err instanceof Error && err.stack
        ? err.stack.split('\n').slice(1, 4).map(line => line.trim()).join(' ')
        : '';
    console.error(`[Secrets] ${operation}: ${name}${frames ? ` (${frames})` : ''}`);
}

function sendServiceError(res: Response, err: unknown, fallback: string): void {
    if (err instanceof SecretVersionConflictError) {
        sendVersionConflict(res, err);
        return;
    }
    if (err instanceof RevealTargetError) {
        res.status(404).json({ error: err.message, code: 'REVEAL_TARGET_MISSING' });
        return;
    }
    if (err instanceof SecretOpError) {
        res.status(400).json({ error: err.message });
        return;
    }
    if (err instanceof SecretSourceError) {
        res.status(404).json({ error: err.message, code: 'IMPORT_SOURCE_NOT_FOUND' });
        return;
    }
    if (err instanceof SecretSourceChangedError) {
        res.status(409).json({ error: err.message, code: 'IMPORT_SOURCE_CHANGED' });
        return;
    }
    if (err instanceof SecretPayloadError) {
        console.error(`[Secrets] Unreadable bundle payload (${fallback})`);
        res.status(500).json({
            error: 'The stored bundle payload could not be read. Restore a version or re-save the bundle before editing it.',
            code: 'SECRET_PAYLOAD_UNREADABLE',
        });
        return;
    }
    logServiceError(fallback, err);
    res.status(500).json({ error: getErrorMessage(err, fallback) });
}

secretsRouter.get('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    if (!requireUserSession(req, res)) return;
    if (!requireAdmin(req, res)) return;
    try {
        const items = SecretsService.getInstance().list();
        res.json(items);
    } catch (err) {
        logServiceError('List error', err);
        res.status(500).json({ error: 'Failed to list secrets' });
    }
});

secretsRouter.post('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    if (!requireUserSession(req, res)) return;
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
        console.log(`[Secrets] Created bundle ${sanitizeForLog(name)} (v${result.version})`);
        res.status(201).json(result);
    } catch (err) {
        if (isSqliteUniqueViolation(err)) {
            res.status(409).json({ error: 'A secret with that name already exists' });
            return;
        }
        logServiceError('Create error', err);
        res.status(500).json({ error: getErrorMessage(err, 'Failed to create secret') });
    }
});

secretsRouter.get('/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    if (!requireUserSession(req, res)) return;
    if (!requireAdmin(req, res)) return;
    try {
        const id = parseIntParam(req, res, 'id', 'secret ID');
        if (id === null) return;
        const detail = SecretsService.getInstance().getDetail(id);
        if (!detail) {
            res.status(404).json({ error: 'Secret not found' });
            return;
        }
        res.json(detail);
    } catch (err) {
        if (err instanceof SecretPayloadError) {
            sendServiceError(res, err, 'read secret');
            return;
        }
        logServiceError('Get error', err);
        res.status(500).json({ error: 'Failed to read secret' });
    }
});

secretsRouter.patch('/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    if (!requireUserSession(req, res)) return;
    if (!requireAdmin(req, res)) return;
    if (!requireBody(req, res)) return;
    try {
        const id = parseIntParam(req, res, 'id', 'secret ID');
        if (id === null) return;
        const { expectedVersion, description, ops, note } = req.body as {
            expectedVersion?: unknown; description?: unknown; ops?: unknown; note?: unknown;
        };
        const version = parseVersion(expectedVersion);
        if (version === null) {
            res.status(400).json({ error: 'expectedVersion must be the version you loaded' });
            return;
        }
        if (description !== undefined && typeof description !== 'string') {
            res.status(400).json({ error: 'description must be a string' });
            return;
        }
        if (!isValidOpList(ops)) {
            res.status(400).json({ error: 'ops must be a list of set, remove, or rename operations' });
            return;
        }
        if (ops.length === 0 && typeof description !== 'string') {
            res.status(400).json({ error: 'Send at least one operation, or a description to change' });
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
        const result = SecretsService.getInstance().applyPatch(id, {
            expectedVersion: version,
            ops,
            description: typeof description === 'string' ? description : undefined,
            user: getActor(req),
            note: typeof note === 'string' ? note : undefined,
        });
        console.log(`[Secrets] Updated bundle ${sanitizeForLog(existing.name)} to v${result.version}`);
        res.json(result);
    } catch (err) {
        sendServiceError(res, err, 'Failed to update secret');
    }
});

secretsRouter.delete('/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    if (!requireUserSession(req, res)) return;
    if (!requireAdmin(req, res)) return;
    try {
        const id = parseIntParam(req, res, 'id', 'secret ID');
        if (id === null) return;
        const ok = SecretsService.getInstance().delete(id);
        if (!ok) {
            res.status(404).json({ error: 'Secret not found' });
            return;
        }
        console.log(`[Secrets] Deleted bundle id=${id}`);
        res.json({ ok: true });
    } catch (err) {
        logServiceError('Delete error', err);
        res.status(500).json({ error: 'Failed to delete secret' });
    }
});

secretsRouter.get('/:id/versions', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    if (!requireUserSession(req, res)) return;
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
        logServiceError('Versions error', err);
        res.status(500).json({ error: 'Failed to list versions' });
    }
});

secretsRouter.post('/:id/reveal-grant', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    if (!requireUserSession(req, res)) return;
    if (!requireAdmin(req, res)) return;
    if (!requireBody(req, res)) return;
    try {
        const id = parseIntParam(req, res, 'id', 'secret ID');
        if (id === null) return;
        const { key, version } = req.body as { key?: unknown; version?: unknown };
        if (!isValidKey(key)) {
            res.status(400).json({ error: 'key must be an env-var name' });
            return;
        }
        const targetVersion = version === undefined ? undefined : parseVersion(version);
        if (version !== undefined && targetVersion === null) {
            res.status(400).json({ error: 'version must be a positive integer' });
            return;
        }
        const grant = SecretsService.getInstance().createRevealGrant(id, key, getActorId(req), targetVersion ?? undefined);
        res.json(grant);
    } catch (err) {
        sendServiceError(res, err, 'Failed to authorize reveal');
    }
});

secretsRouter.post('/:id/reveal', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    if (!requireUserSession(req, res)) return;
    if (!requireAdmin(req, res)) return;
    if (!requireBody(req, res)) return;
    try {
        const id = parseIntParam(req, res, 'id', 'secret ID');
        if (id === null) return;
        const { grantId } = req.body as { grantId?: unknown };
        if (typeof grantId !== 'string' || grantId.length < 16 || grantId.length > 128) {
            res.status(400).json({ error: 'grantId is required' });
            return;
        }
        const result = SecretsService.getInstance().consumeRevealGrant(id, grantId, getActorId(req));
        if (!result.ok) {
            const code = result.reason === 'expired' ? 'REVEAL_EXPIRED' : result.reason === 'mismatch' ? 'REVEAL_MISMATCH' : 'REVEAL_GRANT_INVALID';
            res.status(403).json({ error: 'Reveal authorization is no longer valid. Reveal the value again.', code });
            return;
        }
        res.json(result.revealed);
    } catch (err) {
        sendServiceError(res, err, 'Failed to reveal value');
    }
});

secretsRouter.post('/:id/import-from-stack/preview', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    if (!requireUserSession(req, res)) return;
    if (!requireAdmin(req, res)) return;
    if (!requireBody(req, res)) return;
    try {
        const id = parseIntParam(req, res, 'id', 'secret ID');
        if (id === null) return;
        const parsed = parseImportBody(req.body);
        if ('error' in parsed) {
            res.status(400).json({ error: parsed.error });
            return;
        }
        if (!DatabaseService.getInstance().getSecret(id)) {
            res.status(404).json({ error: 'Secret not found' });
            return;
        }
        const preview = await SecretsService.getInstance().previewImport(id, parsed.nodeId, parsed.stackName, parsed.envFileBasename);
        res.json(preview);
    } catch (err) {
        sendServiceError(res, err, 'Failed to preview import');
    }
});

secretsRouter.post('/:id/import-from-stack', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    if (!requireUserSession(req, res)) return;
    if (!requireAdmin(req, res)) return;
    if (!requireBody(req, res)) return;
    try {
        const id = parseIntParam(req, res, 'id', 'secret ID');
        if (id === null) return;
        const parsed = parseImportBody(req.body);
        if ('error' in parsed) {
            res.status(400).json({ error: parsed.error });
            return;
        }
        const { expectedVersion, expectedFingerprint, note } = req.body as {
            expectedVersion?: unknown; expectedFingerprint?: unknown; note?: unknown;
        };
        const version = parseVersion(expectedVersion);
        if (version === null) {
            res.status(400).json({ error: 'expectedVersion must be the version you loaded' });
            return;
        }
        if (typeof expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(expectedFingerprint)) {
            res.status(400).json({ error: 'expectedFingerprint must be the digest the preview answered with' });
            return;
        }
        if (note !== undefined && typeof note !== 'string') {
            res.status(400).json({ error: 'note must be a string' });
            return;
        }
        const secret = DatabaseService.getInstance().getSecret(id);
        if (!secret) {
            res.status(404).json({ error: 'Secret not found' });
            return;
        }
        const result = await SecretsService.getInstance().applyImport(id, {
            nodeId: parsed.nodeId,
            stackName: parsed.stackName,
            envFileBasename: parsed.envFileBasename,
            expectedVersion: version,
            expectedFingerprint,
            user: getActor(req),
            note: typeof note === 'string' ? note : undefined,
        });
        console.log(`[Secrets] Imported env from stack into ${sanitizeForLog(secret.name)} (v${result.version})`);
        res.json(result);
    } catch (err) {
        sendServiceError(res, err, 'Failed to import env from stack');
    }
});

secretsRouter.post('/:id/push/preview', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    if (!requireUserSession(req, res)) return;
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
        logServiceError('Preview error', err);
        res.status(500).json({ error: getErrorMessage(err, 'Failed to preview push') });
    }
});

secretsRouter.post('/:id/push', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    if (!requireUserSession(req, res)) return;
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
            console.log(`[Secrets] Push ${sanitizeForLog(secret.name)} v${secret.current_version}: ${result.results.length} node(s), ${failedCount} failed`);
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
        logServiceError('Push error', err);
        res.status(500).json({ error: getErrorMessage(err, 'Failed to push secret') });
    }
});
