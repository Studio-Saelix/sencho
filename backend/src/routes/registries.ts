import { Router, type Request, type Response } from 'express';
import { RegistryService } from '../services/RegistryService';
import { requireAdmin, requirePaid } from '../middleware/tierGates';
import { rejectApiTokenScope } from '../middleware/apiTokenScope';
import { parseIntParam } from '../utils/parseIntParam';

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

export const registriesRouter = Router();

registriesRouter.get('/', (req: Request, res: Response): void => {
  if (rejectApiTokenScope(req, res, REGISTRY_SCOPE_MESSAGE)) return;
  if (!requireAdmin(req, res)) return;
  try {
    res.json(RegistryService.getInstance().getAll());
  } catch (error) {
    console.error('[Registries] List error:', error);
    res.status(500).json({ error: 'Failed to fetch registries' });
  }
});

registriesRouter.post('/', (req: Request, res: Response): void => {
  if (rejectApiTokenScope(req, res, REGISTRY_SCOPE_MESSAGE)) return;
  if (!requireAdmin(req, res)) return;
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
  if (!requireAdmin(req, res)) return;
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
  if (!requireAdmin(req, res)) return;
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

registriesRouter.post('/:id/test', async (req: Request, res: Response): Promise<void> => {
  if (rejectApiTokenScope(req, res, REGISTRY_SCOPE_MESSAGE)) return;
  if (!requireAdmin(req, res)) return;
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
  if (!requireAdmin(req, res)) return;
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
