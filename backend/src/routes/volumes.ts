import { Router, type Request, type Response } from 'express';
import { VolumeBrowserService, isValidVolumeName, PathTraversalError, VolumeNotFoundError, HelperImageError, ExecError } from '../services/VolumeBrowserService';
import { DatabaseService } from '../services/DatabaseService';
import { requireAdmin } from '../middleware/tierGates';
import { sanitizeForLog } from '../utils/safeLog';
import { isDebugEnabled } from '../utils/debug';

export const volumesRouter = Router();

function readPathParam(req: Request): string {
  const raw = req.query.path;
  if (typeof raw !== 'string') return '';
  return raw;
}

function mapServiceError(error: unknown, res: Response, fallback: string): Response {
  if (error instanceof PathTraversalError) return res.status(400).json({ error: error.message });
  if (error instanceof VolumeNotFoundError) return res.status(404).json({ error: error.message });
  if (error instanceof HelperImageError) return res.status(503).json({ error: error.message });
  if (error instanceof ExecError) return res.status(error.status).json({ error: error.message });
  console.error(`[Volumes] ${fallback}:`, error);
  return res.status(500).json({ error: fallback });
}

volumesRouter.get('/:name/list', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const name = req.params.name as string;
    if (!isValidVolumeName(name)) return res.status(400).json({ error: 'Invalid volume name' });
    const path = readPathParam(req);
    const startedAt = Date.now();
    const entries = await VolumeBrowserService.getInstance(req.nodeId).listDir(name, path);
    if (isDebugEnabled()) {
      console.debug('[Volumes:debug] list', {
        volume: sanitizeForLog(name), path: sanitizeForLog(path || '/'), entries: entries.length, ms: Date.now() - startedAt,
      });
    }
    res.json(entries);
  } catch (error: unknown) {
    mapServiceError(error, res, 'Failed to list volume directory');
  }
});

volumesRouter.get('/:name/stat', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const name = req.params.name as string;
    if (!isValidVolumeName(name)) return res.status(400).json({ error: 'Invalid volume name' });
    const path = readPathParam(req);
    const meta = await VolumeBrowserService.getInstance(req.nodeId).stat(name, path);
    res.json(meta);
  } catch (error: unknown) {
    mapServiceError(error, res, 'Failed to stat volume path');
  }
});

volumesRouter.get('/:name/read', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const name = req.params.name as string;
  const requestPath = readPathParam(req);
  let outcome: 'success' | 'error' = 'error';
  try {
    if (!isValidVolumeName(name)) return res.status(400).json({ error: 'Invalid volume name' });
    const startedAt = Date.now();
    const result = await VolumeBrowserService.getInstance(req.nodeId).readFile(name, requestPath);
    outcome = 'success';
    if (isDebugEnabled()) {
      // Never log the file body; only its shape.
      console.debug('[Volumes:debug] read', {
        volume: sanitizeForLog(name), path: sanitizeForLog(requestPath || '/'),
        size: result.size, binary: result.binary, truncated: result.truncated, ms: Date.now() - startedAt,
      });
    }
    res.json(result);
  } catch (error: unknown) {
    mapServiceError(error, res, 'Failed to read volume file');
  } finally {
    try {
      DatabaseService.getInstance().insertAuditLog({
        timestamp: Date.now(),
        username: req.user?.username ?? 'unknown',
        method: 'GET',
        path: req.path,
        status_code: res.statusCode,
        node_id: req.nodeId ?? null,
        ip_address: req.ip ?? 'unknown',
        summary: `${outcome === 'success' ? 'Read' : 'Failed read of'} volume file: ${sanitizeForLog(name)}:${sanitizeForLog(requestPath || '/')}`,
      });
    } catch (auditErr) {
      console.error('[Volumes] Audit log insert failed:', auditErr);
    }
  }
});
