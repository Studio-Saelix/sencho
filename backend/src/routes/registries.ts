import { Router, type Request, type Response } from 'express';
import { RegistryService } from '../services/RegistryService';
import { listRegistryTagsResult, type TagListCode } from '../services/registry-api';
import { requirePaid } from '../middleware/tierGates';
import { requirePermission } from '../middleware/permissions';
import { rejectApiTokenScope } from '../middleware/apiTokenScope';
import { parseIntParam } from '../utils/parseIntParam';
import { sanitizeForLog } from '../utils/safeLog';

const VALID_REGISTRY_TYPES = ['dockerhub', 'ghcr', 'ecr', 'custom'] as const;
const REGISTRY_SCOPE_MESSAGE = 'API tokens cannot manage registry credentials.';

function isValidRegistryUrl(url: string, type: string): boolean {
  if (type === 'dockerhub') return true;
  const trimmed = url.trim();
  if (!trimmed) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (!parsed.hostname) return false;
  return true;
}

// Docker Hub, GHCR, and custom registry credentials are a Community capability.
// ECR (short-lived token refresh, AWS region) stays paid. Returns true when the
// request may proceed and false after sending the 403, mirroring the tier guards.
function allowRegistryType(type: string | undefined, req: Request, res: Response): boolean {
  if (type === 'ecr') return requirePaid(req, res);
  return true;
}


const REPO_MAX_LEN = 255;
const REPO_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/i;

/** Path-safe repository name only (no scheme, host, or tag). */
function parseRepositoryParam(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const repo = raw.trim();
  if (!repo || repo.length > REPO_MAX_LEN) return null;
  if (repo.includes('://') || repo.includes('@') || repo.startsWith('/') || repo.includes(':')) return null;
  const first = repo.split('/')[0];
  // Host-looking first segment (e.g. ghcr.io/org/name) is rejected; host comes from the registry row.
  if (first.includes('.')) return null;
  if (!REPO_PATTERN.test(repo)) return null;
  return repo;
}

function tagListHttpStatus(code: TagListCode): number {
  switch (code) {
    case 'REGISTRY_UNAUTHORIZED':
    case 'REGISTRY_FORBIDDEN':
    case 'REGISTRY_RATE_LIMITED':
    case 'REGISTRY_UNSUPPORTED':
      return 424;
    case 'REGISTRY_NOT_FOUND':
      return 404;
    case 'REGISTRY_INVALID_RESPONSE':
      return 400;
    case 'REGISTRY_UPSTREAM':
    default:
      return 502;
  }
}

export const registriesRouter = Router();

registriesRouter.get('/', (req: Request, res: Response): void => {
  if (rejectApiTokenScope(req, res, REGISTRY_SCOPE_MESSAGE)) return;
  if (!requirePermission(req, res, 'system:registries')) return;
  try {
    res.json(RegistryService.getInstance().getAll());
  } catch (error) {
    console.error('[Registries] List error:', error);
    res.status(500).json({ error: 'Failed to fetch registries' });
  }
});

registriesRouter.post('/', (req: Request, res: Response): void => {
  if (rejectApiTokenScope(req, res, REGISTRY_SCOPE_MESSAGE)) return;
  if (!requirePermission(req, res, 'system:registries')) return;
  try {
    const { name, url, type, username, secret, aws_region } = req.body;

    if (!name || typeof name !== 'string' || name.length > 100) {
      res.status(400).json({ error: 'Name is required (max 100 characters).' }); return;
    }
    if (!url || typeof url !== 'string' || url.length > 500) {
      res.status(400).json({ error: 'URL is required (max 500 characters).' }); return;
    }
    if (!type || !(VALID_REGISTRY_TYPES as readonly string[]).includes(type)) {
      res.status(400).json({ error: `Type must be one of: ${VALID_REGISTRY_TYPES.join(', ')}` }); return;
    }
    if (!allowRegistryType(type, req, res)) return;
    if (!isValidRegistryUrl(url, type)) {
      res.status(400).json({ error: 'Registry URL must use http:// or https:// (or no protocol).' }); return;
    }
    if (!username || typeof username !== 'string') {
      res.status(400).json({ error: 'Username is required.' }); return;
    }
    if (!secret || typeof secret !== 'string') {
      res.status(400).json({ error: 'Secret/token is required.' }); return;
    }
    if (type === 'ecr' && (!aws_region || typeof aws_region !== 'string')) {
      res.status(400).json({ error: 'AWS region is required for ECR registries.' }); return;
    }

    const id = RegistryService.getInstance().create({ name, url, type, username, secret, aws_region: aws_region ?? null });
    res.status(201).json({ id });
  } catch (error) {
    console.error('[Registries] Create error:', error);
    res.status(500).json({ error: 'Failed to create registry' });
  }
});

registriesRouter.put('/:id', (req: Request, res: Response): void => {
  if (rejectApiTokenScope(req, res, REGISTRY_SCOPE_MESSAGE)) return;
  if (!requirePermission(req, res, 'system:registries')) return;
  try {
    const id = parseIntParam(req, res, 'id', 'registry ID');
    if (id === null) return;

    const existing = RegistryService.getInstance().getById(id);
    if (!existing) { res.status(404).json({ error: 'Registry not found' }); return; }

    const { name, url, type, username, secret, aws_region } = req.body;

    if (name !== undefined && (typeof name !== 'string' || name.length > 100)) {
      res.status(400).json({ error: 'Name must be a string (max 100 characters).' }); return;
    }
    if (url !== undefined && (typeof url !== 'string' || url.length > 500)) {
      res.status(400).json({ error: 'URL must be a string (max 500 characters).' }); return;
    }
    if (type !== undefined && !(VALID_REGISTRY_TYPES as readonly string[]).includes(type)) {
      res.status(400).json({ error: `Type must be one of: ${VALID_REGISTRY_TYPES.join(', ')}` }); return;
    }
    const effectiveType = type ?? existing.type;
    if (!allowRegistryType(effectiveType, req, res)) return;
    if (url !== undefined && !isValidRegistryUrl(url, effectiveType)) {
      res.status(400).json({ error: 'Registry URL must use http:// or https:// (or no protocol).' }); return;
    }
    if (effectiveType === 'ecr' && aws_region !== undefined && (typeof aws_region !== 'string' || !aws_region)) {
      res.status(400).json({ error: 'AWS region is required for ECR registries.' }); return;
    }

    RegistryService.getInstance().update(id, { name, url, type, username, secret, aws_region });
    res.json({ success: true });
  } catch (error) {
    console.error('[Registries] Update error:', error);
    res.status(500).json({ error: 'Failed to update registry' });
  }
});

registriesRouter.delete('/:id', (req: Request, res: Response): void => {
  if (rejectApiTokenScope(req, res, REGISTRY_SCOPE_MESSAGE)) return;
  if (!requirePermission(req, res, 'system:registries')) return;
  try {
    const id = parseIntParam(req, res, 'id', 'registry ID');
    if (id === null) return;

    const existing = RegistryService.getInstance().getById(id);
    if (!existing) { res.status(404).json({ error: 'Registry not found' }); return; }

    RegistryService.getInstance().delete(id);
    res.json({ success: true });
  } catch (error) {
    console.error('[Registries] Delete error:', error);
    res.status(500).json({ error: 'Failed to delete registry' });
  }
});


// Browse tags for a configured registry + validated repository (hub-only).
// Upstream registry auth failures map to 424/502 — never HTTP 401 (that would
// log the browser session out via the frontend unauthorized handler).
registriesRouter.get('/:id/tags', async (req: Request, res: Response): Promise<void> => {
  if (rejectApiTokenScope(req, res, REGISTRY_SCOPE_MESSAGE)) return;
  if (!requirePermission(req, res, 'system:registries')) return;
  try {
    const id = parseIntParam(req, res, 'id', 'registry ID');
    if (id === null) return;

    const repository = parseRepositoryParam(req.query.repository);
    if (!repository) {
      res.status(400).json({ error: 'Query parameter repository is required and must be a path-safe repository name' });
      return;
    }

    const limitRaw = req.query.limit;
    let limit = 50;
    if (limitRaw !== undefined) {
      const n = typeof limitRaw === 'string' ? Number.parseInt(limitRaw, 10) : NaN;
      if (!Number.isFinite(n) || n < 1 || n > 100) {
        res.status(400).json({ error: 'limit must be an integer from 1 to 100' });
        return;
      }
      limit = n;
    }
    const cursor = typeof req.query.cursor === 'string' && req.query.cursor.trim()
      ? req.query.cursor.trim()
      : undefined;

    const auth = await RegistryService.getInstance().getAuthForRegistryId(id);
    if (!auth.ok) {
      if (auth.code === 'missing') {
        res.status(404).json({ error: auth.message, code: 'REGISTRY_NOT_FOUND' });
        return;
      }
      const code = auth.code === 'ecr_failed' || auth.code === 'decrypt_failed'
        ? 'REGISTRY_UNAUTHORIZED'
        : 'REGISTRY_UPSTREAM';
      res.status(424).json({ error: auth.message, code });
      return;
    }
    if (!allowRegistryType(auth.type, req, res)) return;

    // Docker Hub official images are often referenced as library/<name>.
    let repo = repository;
    if (auth.type === 'dockerhub' && !repo.includes('/')) {
      repo = `library/${repo}`;
    }

    const result = await listRegistryTagsResult(
      auth.registryHost,
      repo,
      { username: auth.username, password: auth.password },
      { limit, cursor },
    );
    if (!result.ok) {
      res.status(tagListHttpStatus(result.code)).json({ error: result.message, code: result.code });
      return;
    }
    res.json({
      tags: result.tags,
      nextCursor: result.nextCursor ?? null,
      registryId: id,
      registryName: auth.name,
      repository: repo,
    });
  } catch (error) {
    console.error('[Registries] Tag list error:', sanitizeForLog(error instanceof Error ? error.message : String(error)));
    res.status(500).json({ error: 'Failed to list registry tags' });
  }
});

registriesRouter.post('/:id/test', async (req: Request, res: Response): Promise<void> => {
  if (rejectApiTokenScope(req, res, REGISTRY_SCOPE_MESSAGE)) return;
  if (!requirePermission(req, res, 'system:registries')) return;
  try {
    const id = parseIntParam(req, res, 'id', 'registry ID');
    if (id === null) return;

    const existing = RegistryService.getInstance().getById(id);
    if (!existing) { res.status(404).json({ error: 'Registry not found' }); return; }
    if (!allowRegistryType(existing.type, req, res)) return;

    const result = await RegistryService.getInstance().testConnection(id);
    res.json(result);
  } catch (error) {
    console.error('[Registries] Test error:', error);
    res.status(500).json({ error: 'Failed to test registry connection' });
  }
});

registriesRouter.post('/test', async (req: Request, res: Response): Promise<void> => {
  if (rejectApiTokenScope(req, res, REGISTRY_SCOPE_MESSAGE)) return;
  if (!requirePermission(req, res, 'system:registries')) return;
  try {
    const { type, url, username, secret, aws_region } = req.body;

    if (!type || !(VALID_REGISTRY_TYPES as readonly string[]).includes(type)) {
      res.status(400).json({ error: `Type must be one of: ${VALID_REGISTRY_TYPES.join(', ')}` }); return;
    }
    if (!allowRegistryType(type, req, res)) return;
    if (typeof url !== 'string' || url.length === 0 || url.length > 500) {
      res.status(400).json({ error: 'URL is required (max 500 characters).' }); return;
    }
    if (!isValidRegistryUrl(url, type)) {
      res.status(400).json({ error: 'Registry URL must use http:// or https:// (or no protocol).' }); return;
    }
    if (typeof username !== 'string' || username.length === 0) {
      res.status(400).json({ error: 'Username is required.' }); return;
    }
    if (typeof secret !== 'string' || secret.length === 0) {
      res.status(400).json({ error: 'Secret/token is required.' }); return;
    }
    if (type === 'ecr' && (typeof aws_region !== 'string' || !aws_region)) {
      res.status(400).json({ error: 'AWS region is required for ECR registries.' }); return;
    }

    const result = await RegistryService.getInstance().testWithCredentials({
      type,
      url,
      username,
      secret,
      aws_region: aws_region ?? null,
    });
    res.json(result);
  } catch (error) {
    console.error('[Registries] Stateless test error:', error);
    res.status(500).json({ error: 'Failed to test registry connection' });
  }
});
