import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import zlib from 'zlib';
import { promises as fsp } from 'fs';
import * as tar from 'tar-stream';
import { inspect } from 'node:util';
import YAML from 'yaml';
import multer from 'multer';
import { FileSystemService } from '../services/FileSystemService';
import { StackFileRootsService, STACK_SOURCE_ROOT_ID, stackSourceFileRoot, type StackFileRoot } from '../services/StackFileRootsService';
import { FileRootGateway } from '../services/FileRootGateway';
import { ComposeService, getComposeRollbackInfo } from '../services/ComposeService';
import DockerController from '../services/DockerController';
import { DatabaseService, type StackDossierFields } from '../services/DatabaseService';
import { MeshService } from '../services/MeshService';
import { CacheService } from '../services/CacheService';
import { UpdatePreviewService } from '../services/UpdatePreviewService';
import { GitSourceService, GitSourceError, repoHost as gitRepoHost } from '../services/GitSourceService';
import { enforcePolicyPreDeploy } from '../services/PolicyEnforcement';
import { buildStackDriftReport, type DriftFindingKind, type StackDriftReport } from '../services/DriftDetectionService';
import { DriftLedgerService, type DriftTemporal } from '../services/DriftLedgerService';
import { ComposeDoctorService } from '../services/ComposeDoctorService';
import { buildStackNetworkFacts } from '../services/network/composeNetworkInspector';
import { buildStorageInventory } from '../services/storage/inventory';
import { buildEffectiveAnatomy } from '../services/effectiveAnatomy';
import { buildEnvInventory } from '../services/EnvInventoryService';
import { EXPOSURE_INTENTS, type ExposureIntent } from '../services/network/types';
import { UpdateGuardService } from '../services/UpdateGuardService';
import { HealthGateService } from '../services/HealthGateService';
import { classifyFailure } from '../services/updateGuard/failureClassifier';
import { requirePermission, checkPermission } from '../middleware/permissions';
import { NotificationService, type NotificationCategory } from '../services/NotificationService';
import { StackOpLockService, type StackOpAction } from '../services/StackOpLockService';
import { StackOpMetricsService, type StackOpAction as StackMetricAction } from '../services/StackOpMetricsService';
import { FileExplorerMetricsService, type FileExplorerOp } from '../services/FileExplorerMetricsService';
import { isValidGitSourcePath, isValidStackName, isValidServiceName, isValidRelativeStackPath } from '../utils/validation';
import { normalizeBulkPaths, destWithinAnySource } from '../utils/bulkPaths';
import { getErrorMessage } from '../utils/errors';
import { isDebugEnabled } from '../utils/debug';
import { sanitizeForLog } from '../utils/safeLog';
import { sendGitSourceError } from '../utils/gitSourceHttp';
import { buildPolicyGateOptions, runPolicyGate, triggerPostDeployScan } from '../helpers/policyGate';
import { parseComposePreview, type ComposePreview } from '../helpers/composePreview';
import { invalidateNodeCaches } from '../helpers/cacheInvalidation';
import { parseComposeSelection, defaultEnvPath } from '../helpers/gitSourceSelection';
import { resolveStackEnvSources } from '../helpers/envFileResolution';
import { STACK_STATUSES_CACHE_TTL_MS } from '../helpers/constants';
import { getTerminalWs, DEPLOY_SESSION_HEADER } from '../websocket/generic';

// Authenticated users with edit permission can write arbitrarily large compose
// files. Refuse to YAML.parse anything beyond this bound so a malformed (or
// adversarial) file cannot exhaust heap during an env or service lookup.
const MAX_COMPOSE_PARSE_BYTES = 1_048_576; // 1 MiB

/**
 * Diagnostic-mode log helper. Wraps console.log so non-essential informational
 * lines (deploys completed, files saved, stacks created) stay silent in
 * production and only appear when developer_mode is on. console.warn and
 * console.error remain unconditional - they are operational signal, not noise.
 */
function dlog(...args: Parameters<typeof console.log>): void {
  if (isDebugEnabled()) console.log(...args);
}
function notifyActionFailure(action: string, stackName: string, error: unknown, actor: string): void {
  const message = getErrorMessage(error, `Failed to ${action} stack`);
  NotificationService.getInstance()
    .dispatchAlert('error', 'deploy_failure', message, { stackName, actor })
    .catch(err => console.error('[Stacks] Failed to dispatch failure notification for %s:', sanitizeForLog(stackName), err));
}

function notifyActionSuccess(category: NotificationCategory, message: string, stackName: string, actor: string): void {
  NotificationService.getInstance()
    .dispatchAlert('info', category, message, { stackName, actor })
    .catch(err => console.error('[Stacks] Failed to dispatch activity for %s:', sanitizeForLog(stackName), err));
}

const STACK_OP_PRESENT_PARTICIPLE: Record<StackOpAction, string> = {
  deploy: 'deploying',
  down: 'stopping',
  restart: 'restarting',
  stop: 'stopping',
  start: 'starting',
  update: 'updating',
  rollback: 'rolling back',
  backup: 'backing up',
};

function tryAcquireStackOpLock(
  req: Request,
  res: Response,
  stackName: string,
  action: StackOpAction,
): boolean {
  const user = req.user?.username ?? 'system';
  const result = StackOpLockService.getInstance().tryAcquire(req.nodeId, stackName, action, user);
  if (!result.acquired) {
    res.status(409).json({
      error: `${stackName} is already ${STACK_OP_PRESENT_PARTICIPLE[result.existing.action]}`,
      code: 'stack_op_in_progress',
      inProgress: {
        action: result.existing.action,
        startedAt: result.existing.startedAt,
        user: result.existing.user,
      },
    });
    return false;
  }
  return true;
}

function releaseStackOpLock(req: Request, stackName: string): void {
  StackOpLockService.getInstance().release(req.nodeId, stackName);
}

function stackFileEtag(mtimeMs: number): string {
  return `W/"${Math.floor(mtimeMs)}"`;
}

function parseIfMatchMtime(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = /(?:W\/)?"(\d+)"/.exec(raw);
  if (!m) return null;
  const value = Number(m[1]);
  return Number.isFinite(value) ? value : null;
}

async function requireStackExists(nodeId: number, stackName: string, res: Response): Promise<boolean> {
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return false;
  }
  const fsSvc = FileSystemService.getInstance(nodeId);
  const stackDir = path.join(fsSvc.getBaseDir(), stackName);
  try {
    if (!(await fsSvc.hasComposeFile(stackDir))) {
      res.status(404).json({ error: 'Stack not found' });
      return false;
    }
  } catch {
    res.status(404).json({ error: 'Stack not found' });
    return false;
  }
  return true;
}

// Thin wrapper over the shared env-source resolver. Returns the absolute paths of
// the env files Compose would consult for this stack: the existing declared
// `env_file:` paths when any are declared (no project `.env` fallback in that
// case), otherwise the project `.env` when it exists. The multi-file Git case and
// path validation live in resolveStackEnvSources so every consumer agrees.
export async function resolveAllEnvFilePaths(nodeId: number, stackName: string): Promise<string[]> {
  const sources = await resolveStackEnvSources(nodeId, stackName);
  const injection = sources.envFiles.filter(f => f.isInjectionSource);
  if (injection.length > 0) {
    return injection
      .filter(f => f.existence === 'present' && f.resolvedPath)
      .map(f => f.resolvedPath as string);
  }
  const dotenv = sources.envFiles.find(f => f.isInterpolationSource && f.existence === 'present' && f.resolvedPath);
  return dotenv ? [dotenv.resolvedPath as string] : [];
}

// Uploads spool to disk (not memory) so a 25 MB upload is never held in RAM.
// The temp dir lives under the OS temp root, deliberately outside COMPOSE_DIR and
// any browsable volume, so a running container never observes a half-written
// spool. SENCHO_UPLOAD_DIR relocates it (e.g. onto a larger volume).
const UPLOAD_TMP_DIR = process.env.SENCHO_UPLOAD_DIR
  ? path.resolve(process.env.SENCHO_UPLOAD_DIR)
  : path.join(os.tmpdir(), 'sencho-uploads');
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fsp.mkdir(UPLOAD_TMP_DIR, { recursive: true })
        .then(() => cb(null, UPLOAD_TMP_DIR))
        .catch((err: Error) => cb(err, UPLOAD_TMP_DIR));
    },
    filename: (_req, _file, cb) => {
      cb(null, `up-${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  preservePath: true,
});

/**
 * Best-effort cleanup of a spooled upload temp file; never throws (a failed
 * cleanup must not turn a successful upload into an error). A persistent failure
 * would silently grow the spool dir, so log it at diagnostic level rather than
 * swallowing it blind.
 */
async function cleanupUploadTemp(req: Request): Promise<void> {
  const tmp = req.file?.path;
  if (!tmp) return;
  // Canonical js/path-injection barrier inline with the unlink sink: the spool
  // path is multer-generated within UPLOAD_TMP_DIR (a random filename), but
  // static analysis taints req.file.*, so confirm containment before unlinking.
  const baseResolved = path.resolve(UPLOAD_TMP_DIR);
  const resolved = path.resolve(tmp);
  if (!resolved.startsWith(baseResolved + path.sep)) return;
  await fsp.unlink(resolved).catch((err: unknown) => {
    logFileDiag('upload temp cleanup failed', { path: resolved, errorCode: fsErrorCode(err) });
  });
}

function getRelPath(req: Request): string {
  return typeof req.query.path === 'string' ? req.query.path : '';
}

export const stacksRouter = Router();

stacksRouter.param('stackName', (req, res, next, stackName) => {
  if (typeof stackName !== 'string' || !isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return;
  }
  next();
});

stacksRouter.get('/', async (req: Request, res: Response) => {
  if (!requirePermission(req, res, 'stack:read')) return;
  try {
    const stacks = await FileSystemService.getInstance(req.nodeId).getStacks();
    res.json(stacks);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stacks' });
  }
});

stacksRouter.get('/statuses', async (req: Request, res: Response) => {
  if (!requirePermission(req, res, 'stack:read')) return;
  try {
    const result = await CacheService.getInstance().getOrFetch(
      `stack-statuses:${req.nodeId}`,
      STACK_STATUSES_CACHE_TTL_MS,
      async () => {
        const stacks = await FileSystemService.getInstance(req.nodeId).getStacks();
        const stackNames = stacks.map((s: string) => s.replace(/\.(yml|yaml)$/, ''));
        const dockerController = DockerController.getInstance(req.nodeId);
        const bulkInfo = await dockerController.getBulkStackStatuses(stackNames);
        const data: Record<string, { status: 'running' | 'exited' | 'unknown'; mainPort?: number; runningSince?: number }> = {};
        for (const stack of stacks) {
          const name = stack.replace(/\.(yml|yaml)$/, '');
          data[stack] = bulkInfo[name] ?? { status: 'unknown' };
        }
        return data;
      },
    );
    res.json(result);
  } catch (error) {
    console.error('Failed to fetch stack statuses:', error);
    res.status(500).json({ error: 'Failed to fetch stack statuses' });
  }
});

// Read-only scan of the compose directory for the guided first-import flow.
// Surfaces compose files that are not yet stacks (loose at the root, or one
// directory too deep) with a dry preview so a new user can land their first
// stack without reading the docs first. Performs no writes.
stacksRouter.get('/import/scan', async (req: Request, res: Response) => {
  if (!requirePermission(req, res, 'stack:read')) return;
  try {
    const fsSvc = FileSystemService.getInstance(req.nodeId);
    const raw = await fsSvc.findImportCandidates();
    const candidates = raw.map((c) => {
      let preview: ComposePreview;
      if (c.oversized) {
        preview = { services: [], warnings: [], parseError: 'Compose file is too large to preview.' };
      } else if (c.content !== null) {
        preview = parseComposePreview(c.content);
      } else {
        preview = { services: [], warnings: [], parseError: 'Could not read compose file.' };
      }
      return {
        name: c.name,
        composeFile: c.composeFile,
        location: c.location,
        status: c.status,
        services: preview.services,
        warnings: preview.warnings,
        parseError: preview.parseError,
      };
    });
    res.json({ composeDir: fsSvc.getBaseDir(), candidates });
  } catch (error) {
    console.error('Failed to scan compose directory:', error);
    res.status(500).json({ error: 'Failed to scan compose directory' });
  }
});

// Move a discovered import candidate into its own stack directory so Sencho
// picks it up. The single write path of the guided import flow: it relocates a
// loose or nested compose file on disk and never captures it into a store. The
// source is re-derived from a fresh scan and matched by location, so the client
// cannot point the move at an arbitrary path.
stacksRouter.post('/import/move', async (req: Request, res: Response) => {
  if (!requirePermission(req, res, 'stack:create')) return;
  const { location, name } = req.body as { location?: unknown; name?: unknown };
  if (typeof location !== 'string' || !location) {
    return res.status(400).json({ error: 'A candidate location is required' });
  }
  if (typeof name !== 'string' || !isValidStackName(name.trim())) {
    return res.status(400).json({ error: 'Name must be alphanumeric, hyphens, or underscores only' });
  }
  const destName = name.trim();
  try {
    const fsSvc = FileSystemService.getInstance(req.nodeId);
    const match = (await fsSvc.findImportCandidates()).find((c) => c.location === location);
    if (!match) {
      return res.status(404).json({ error: 'That compose file was not found. Rescan and try again.' });
    }
    await fsSvc.importCandidateIntoStack(match, destName);
    invalidateNodeCaches(req.nodeId);
    dlog(`[Stacks] Imported compose file into stack: ${sanitizeForLog(destName)}`);
    res.json({ name: destName });
  } catch (error) {
    const code = (error as { code?: string })?.code;
    // A destination that already exists (our own DEST_EXISTS) or that appeared
    // between the existence check and the rename (EEXIST/ENOTEMPTY) is a clean
    // conflict, not a server error.
    if (code === 'DEST_EXISTS' || code === 'EEXIST' || code === 'ENOTEMPTY') {
      return res.status(409).json({ error: `A stack named "${destName}" already exists` });
    }
    if (code === 'INVALID_PATH' || code === 'INVALID_STACK_NAME') {
      return res.status(400).json({ error: 'Invalid path' });
    }
    // The candidate vanished between the scan above and the move (e.g. deleted
    // on disk): treat it like a stale candidate rather than a server fault.
    if (code === 'ENOENT') {
      return res.status(404).json({ error: 'That compose file was not found. Rescan and try again.' });
    }
    console.error('Failed to import compose file into stack:', sanitizeForLog((error as Error)?.message ?? String(error)));
    res.status(500).json({ error: 'Failed to move the compose file into place' });
  }
});

type BulkLifecycleAction = 'start' | 'stop' | 'restart' | 'update';
const VALID_BULK_ACTIONS: ReadonlySet<BulkLifecycleAction> = new Set(['start', 'stop', 'restart', 'update']);
const BULK_PARALLELISM = 4;
const BULK_MAX_STACKS = 100;

interface BulkResultItem {
  stackName: string;
  ok: boolean;
  error?: string;
  code?: string;
  /** Health gate run started for a successful update, when gating is enabled. */
  healthGateId?: string | null;
}

async function runStackBulkOp(
  req: Request,
  stackName: string,
  action: BulkLifecycleAction,
): Promise<BulkResultItem> {
  if (!isValidStackName(stackName)) {
    return { stackName, ok: false, error: 'Invalid stack name', code: 'invalid_name' };
  }
  if (!checkPermission(req, 'stack:deploy', 'stack', stackName)) {
    return { stackName, ok: false, error: 'Permission denied', code: 'PERMISSION_DENIED' };
  }

  const fsSvc = FileSystemService.getInstance(req.nodeId);
  const stackDir = path.join(fsSvc.getBaseDir(), stackName);
  try {
    if (!(await fsSvc.hasComposeFile(stackDir))) {
      return { stackName, ok: false, error: 'Stack not found', code: 'not_found' };
    }
  } catch {
    return { stackName, ok: false, error: 'Stack not found', code: 'not_found' };
  }

  const user = req.user?.username ?? 'system';
  const lockAction: StackOpAction = action;
  const lockResult = StackOpLockService.getInstance().tryAcquire(req.nodeId, stackName, lockAction, user);
  if (!lockResult.acquired) {
    return {
      stackName,
      ok: false,
      error: `${stackName} is already ${STACK_OP_PRESENT_PARTICIPLE[lockResult.existing.action]}`,
      code: 'stack_op_in_progress',
    };
  }

  try {
    if (action === 'update') {
      const gate = await enforcePolicyPreDeploy(stackName, req.nodeId, buildPolicyGateOptions(req));
      if (!gate.ok) {
        return {
          stackName,
          ok: false,
          error: `Policy "${gate.policy?.name}" blocked update`,
          code: 'policy_blocked',
        };
      }
      const atomic = true;
      await ComposeService.getInstance(req.nodeId).updateStack(stackName, getTerminalWs(req.get(DEPLOY_SESSION_HEADER)), atomic);
      DatabaseService.getInstance().clearStackUpdateStatus(req.nodeId, stackName);
      NotificationService.getInstance().broadcastEvent({
        type: 'state-invalidate',
        scope: 'image-updates',
        nodeId: req.nodeId,
        stackName,
        action: 'stack-updated',
        ts: Date.now(),
      });
      notifyActionSuccess('image_update_applied', `${stackName} updated`, stackName, user);
      triggerPostDeployScan(stackName, req.nodeId).catch(err =>
        console.error('[Security] Post-deploy scan failed for %s:', sanitizeForLog(stackName), err),
      );
      const healthGateId = HealthGateService.getInstance().begin(req.nodeId, stackName, 'update', req.user?.username ?? null);
      return { stackName, ok: true, healthGateId };
    } else {
      const outcome = await containerActionForStack(req.nodeId, stackName, action);
      if (outcome.kind === 'no-containers') {
        return { stackName, ok: false, error: 'No containers found for this stack', code: 'no_containers' };
      }
      if (outcome.kind === 'error') {
        if (action !== 'start') notifyActionFailure(action, stackName, new Error(outcome.message), user);
        return { stackName, ok: false, error: outcome.message, code: 'op_failed' };
      }
      const meta = CONTAINER_ACTION_META[action];
      notifyActionSuccess(meta.category, `${stackName} ${meta.pastTense}`, stackName, user);
    }
    return { stackName, ok: true };
  } catch (err) {
    if (action !== 'start') notifyActionFailure(action, stackName, err, user);
    return { stackName, ok: false, error: getErrorMessage(err, `${action} failed`), code: 'op_failed' };
  } finally {
    StackOpLockService.getInstance().release(req.nodeId, stackName);
  }
}

async function runWithBoundedParallelism<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const idx = next;
      next += 1;
      results[idx] = await task(items[idx]);
    }
  };
  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

stacksRouter.post('/bulk', async (req: Request, res: Response) => {
  const body = req.body as { action?: unknown; stackNames?: unknown } | undefined;
  const action = body?.action;
  const stackNames = body?.stackNames;

  if (typeof action !== 'string' || !VALID_BULK_ACTIONS.has(action as BulkLifecycleAction)) {
    return res.status(400).json({
      error: `Invalid action. Must be one of: ${[...VALID_BULK_ACTIONS].join(', ')}`,
    });
  }
  if (!Array.isArray(stackNames) || stackNames.length === 0) {
    return res.status(400).json({ error: 'stackNames must be a non-empty array' });
  }
  if (stackNames.length > BULK_MAX_STACKS) {
    return res.status(400).json({ error: `Bulk operations are limited to ${BULK_MAX_STACKS} stacks per request` });
  }
  if (!stackNames.every(s => typeof s === 'string')) {
    return res.status(400).json({ error: 'stackNames must be an array of strings' });
  }

  const typedAction = action as BulkLifecycleAction;
  const typedNames = Array.from(new Set(stackNames as string[]));

  const results = await runWithBoundedParallelism(
    typedNames,
    BULK_PARALLELISM,
    name => runStackBulkOp(req, name, typedAction),
  );

  invalidateNodeCaches(req.nodeId);
  const okCount = results.filter(r => r.ok).length;
  console.log(
    `[Stacks] Bulk ${sanitizeForLog(action)} completed: ${okCount}/${results.length} on node ${req.nodeId}`,
  );

  res.json({ action: typedAction, results });
});

stacksRouter.get('/:stackName', async (req: Request, res: Response) => {
  try {
    const stackName = req.params.stackName as string;
    const { content, mtimeMs } = await FileSystemService.getInstance(req.nodeId).getStackContentWithMtime(stackName);
    res.setHeader('ETag', stackFileEtag(mtimeMs));
    res.send(content);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read stack' });
  }
});

stacksRouter.put('/:stackName', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
  try {
    const { content } = req.body;
    if (typeof content !== 'string') {
      console.error('Content is not a string, got:', typeof content);
      return res.status(400).json({ error: 'Content must be a string' });
    }
    if (isDebugEnabled()) console.debug(`[Stacks:debug] Save starting`, { stackName: sanitizeForLog(stackName), bytes: content.length, nodeId: req.nodeId });
    const expectedMtimeMs = parseIfMatchMtime(req.header('if-match'));
    const result = await FileSystemService.getInstance(req.nodeId)
      .saveStackContentIfUnchanged(stackName, content, expectedMtimeMs);
    if (!result.ok) {
      res.setHeader('ETag', stackFileEtag(result.currentMtimeMs));
      return res.status(412).json({
        error: `${stackName}'s compose file changed since you opened it.`,
        code: 'stack_file_changed',
        currentMtimeMs: result.currentMtimeMs,
        currentContent: result.currentContent,
      });
    }
    invalidateNodeCaches(req.nodeId);
    StackFileRootsService.invalidate(req.nodeId, stackName);
    dlog(`[Stacks] Compose file saved: ${sanitizeForLog(stackName)}`);
    res.setHeader('ETag', stackFileEtag(result.mtimeMs));
    res.json({ message: 'Stack saved successfully', mtimeMs: result.mtimeMs });
  } catch (error) {
    console.error('Failed to save stack:', sanitizeForLog(getErrorMessage(error, 'unknown')));
    res.status(500).json({ error: 'Failed to save stack' });
  }
});

stacksRouter.get('/:stackName/envs', async (req: Request, res: Response) => {
  try {
    const stackName = req.params.stackName as string;
    const envPaths = await resolveAllEnvFilePaths(req.nodeId, stackName);
    res.json({ envFiles: envPaths });
  } catch (error) {
    res.status(500).json({ error: 'Failed to resolve env files' });
  }
});

stacksRouter.get('/:stackName/env', async (req: Request, res: Response) => {
  try {
    const stackName = req.params.stackName as string;
    const requestedFile = req.query.file as string | undefined;
    const envPaths = await resolveAllEnvFilePaths(req.nodeId, stackName);

    let envPath: string | undefined = envPaths[0];

    if (requestedFile) {
      if (envPaths.includes(requestedFile)) {
        envPath = requestedFile;
      } else {
        return res.status(400).json({ error: 'Requested env file not allowed' });
      }
    }

    // Default path with no env files yet: reply 200 with an empty body and a
    // header the frontend can read. This avoids surfacing a 404 for the
    // legitimate "stack has no .env yet" case, which previous flows
    // sometimes echoed back to the user as a confusing error string.
    if (!envPath) {
      res.setHeader('X-Env-Exists', 'false');
      return res.send('');
    }

    const fsService = FileSystemService.getInstance(req.nodeId);

    try {
      await fsService.access(envPath);
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        console.error('[Sencho] Unexpected error checking env file existence:', (e as Error).message);
      }
      // No env file at the resolved path. For an explicit ?file= query we
      // surface a 404 (the caller asked for something specific). Otherwise
      // treat it as the empty-stack case above.
      if (requestedFile) {
        return res.status(404).json({ error: 'Env file not found' });
      }
      res.setHeader('X-Env-Exists', 'false');
      return res.send('');
    }

    try {
      const content = await fsService.readFile(envPath, 'utf-8');
      const mtimeMs = await fsService.statMtime(envPath);
      if (mtimeMs !== null) res.setHeader('ETag', stackFileEtag(mtimeMs));
      res.setHeader('X-Env-Exists', 'true');
      return res.send(content);
    } catch (e: unknown) {
      // TOCTOU: the file existed at access() but vanished before readFile().
      // Return the same friendly empty-body shape rather than a generic 500
      // that the frontend would otherwise echo as an opaque error.
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT' && !requestedFile) {
        res.setHeader('X-Env-Exists', 'false');
        return res.send('');
      }
      throw e;
    }
  } catch (error) {
    console.error('Failed to read env file:', error);
    res.status(500).json({ error: 'Failed to read env file' });
  }
});

stacksRouter.put('/:stackName/env', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
  try {
    const { content } = req.body;
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'Content must be a string' });
    }

    const requestedFile = req.query.file as string | undefined;
    const envPaths = await resolveAllEnvFilePaths(req.nodeId, stackName);

    let envPath = envPaths[0];

    if (requestedFile) {
      if (envPaths.includes(requestedFile)) {
        envPath = requestedFile;
      } else {
        return res.status(400).json({ error: 'Requested env file not allowed' });
      }
    }

    // No env file resolved: the stack has no .env yet and the editor only edits
    // an existing env file. GET treats this same case as an empty 200; PUT cannot,
    // since there is no resolved path to write. Reply with a clean, handled response
    // instead of writing to an undefined path, which would otherwise surface as an opaque 500.
    if (!envPath) {
      return res.status(404).json({ error: 'No env file exists for this stack' });
    }

    const fsService = FileSystemService.getInstance(req.nodeId);
    const expectedMtimeMs = parseIfMatchMtime(req.header('if-match'));
    const result = await fsService.writeFileIfUnchanged(envPath, content, expectedMtimeMs);
    if (!result.ok) {
      res.setHeader('ETag', stackFileEtag(result.currentMtimeMs));
      return res.status(412).json({
        error: `${stackName}'s env file changed since you opened it.`,
        code: 'stack_file_changed',
        currentMtimeMs: result.currentMtimeMs,
        currentContent: result.currentContent,
      });
    }
    invalidateNodeCaches(req.nodeId);
    StackFileRootsService.invalidate(req.nodeId, stackName);
    const envFileName = path.basename(envPath);
    dlog(`[Stacks] Env file saved: ${sanitizeForLog(stackName)}/${sanitizeForLog(envFileName)}`);
    res.setHeader('ETag', stackFileEtag(result.mtimeMs));
    res.json({ message: 'Env file saved successfully', mtimeMs: result.mtimeMs });
  } catch (error) {
    console.error('[Stacks] Failed to save env file:', error);
    res.status(500).json({ error: 'Failed to save env file' });
  }
});

// Stack Dossier: operator-authored documentation persisted per (node, stack).
// All fields default to '' so a PUT is a full-document save (an omitted field
// clears it) and a GET for a stack with no dossier yet returns a clean blank.
const dossierField = (max: number) => z.string().max(max).default('');
const StackDossierUpdateSchema = z.object({
  purpose: dossierField(1000),
  owner: dossierField(1000),
  access_urls: dossierField(2000),
  static_ip: dossierField(255),
  vlan: dossierField(255),
  firewall_notes: dossierField(8000),
  reverse_proxy_notes: dossierField(8000),
  backup_notes: dossierField(8000),
  upgrade_notes: dossierField(8000),
  recovery_notes: dossierField(8000),
  custom_notes: dossierField(8000),
});
const emptyDossierFields = (): StackDossierFields => StackDossierUpdateSchema.parse({});

stacksRouter.get('/:stackName/dossier', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:read', 'stack', stackName)) return;
  if (!(await requireStackExists(req.nodeId, stackName, res))) return;
  try {
    const row = DatabaseService.getInstance().getStackDossier(req.nodeId, stackName);
    // No dossier yet: answer 200 with a blank document so the editor loads clean
    // rather than forcing the client to special-case a 404.
    res.json(row ?? { node_id: req.nodeId, stack_name: stackName, ...emptyDossierFields(), created_at: 0, updated_at: 0 });
  } catch (error) {
    console.error('[Stacks] Failed to read dossier:', sanitizeForLog(getErrorMessage(error, 'unknown')));
    res.status(500).json({ error: 'Failed to read dossier' });
  }
});

stacksRouter.put('/:stackName/dossier', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
  if (!(await requireStackExists(req.nodeId, stackName, res))) return;
  const parsed = StackDossierUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
    return;
  }
  try {
    const row = DatabaseService.getInstance().upsertStackDossier(req.nodeId, stackName, parsed.data);
    res.json(row);
  } catch (error) {
    console.error('[Stacks] Failed to save dossier:', sanitizeForLog(getErrorMessage(error, 'unknown')));
    res.status(500).json({ error: 'Failed to save dossier' });
  }
});

stacksRouter.post('/', async (req: Request, res: Response) => {
  if (!requirePermission(req, res, 'stack:create')) return;
  try {
    const { stackName } = req.body;
    if (!stackName || typeof stackName !== 'string') {
      return res.status(400).json({ error: "Field 'stackName' is required and must be a string" });
    }
    if (!isValidStackName(stackName)) {
      return res.status(400).json({ error: 'Stack name can only contain alphanumeric characters, hyphens, and underscores' });
    }
    await FileSystemService.getInstance(req.nodeId).createStack(stackName);
    invalidateNodeCaches(req.nodeId);
    dlog(`[Stacks] Stack created: ${sanitizeForLog(stackName)}`);
    res.json({ message: 'Stack created successfully', name: stackName });
  } catch (error: unknown) {
    const message = getErrorMessage(error, '');
    if (message.includes('already exists')) {
      return res.status(409).json({ error: 'Stack already exists' });
    }
    console.error('Failed to create stack:', error);
    res.status(500).json({ error: 'Failed to create stack' });
  }
});

stacksRouter.post('/from-git', async (req: Request, res: Response) => {
  if (!requirePermission(req, res, 'stack:create')) return;
  const fromGitStartedAt = Date.now();
  const fromGitDiag = isDebugEnabled();
  let fromGitStackName = '';
  try {
    const {
      stack_name,
      repo_url,
      branch,
      sync_env,
      env_path,
      auth_type,
      token,
      auto_apply_on_webhook,
      auto_deploy_on_apply,
      deploy_now,
      skip_scan,
    } = req.body ?? {};
    fromGitStackName = typeof stack_name === 'string' ? stack_name : '';

    if (typeof stack_name !== 'string' || !stack_name.trim()) {
      return res.status(400).json({ error: 'stack_name is required' });
    }
    if (!isValidStackName(stack_name)) {
      return res.status(400).json({ error: 'Stack name can only contain alphanumeric characters, hyphens, and underscores' });
    }
    if (typeof repo_url !== 'string' || !repo_url.trim()) {
      return res.status(400).json({ error: 'repo_url is required' });
    }
    if (typeof branch !== 'string' || !branch.trim()) {
      return res.status(400).json({ error: 'branch is required' });
    }
    const selection = parseComposeSelection(req.body);
    if (!selection.ok) {
      return res.status(400).json({ error: selection.error });
    }
    if (auto_apply_on_webhook !== undefined && typeof auto_apply_on_webhook !== 'boolean') {
      return res.status(400).json({ error: 'auto_apply_on_webhook must be a boolean' });
    }
    if (auto_deploy_on_apply !== undefined && typeof auto_deploy_on_apply !== 'boolean') {
      return res.status(400).json({ error: 'auto_deploy_on_apply must be a boolean' });
    }
    const resolvedAuthType = auth_type === 'token' ? 'token' : 'none';
    if (!/^https:\/\//i.test(repo_url)) {
      return res.status(400).json({ error: 'Only HTTPS repository URLs are supported' });
    }
    if (repo_url.length > 2048) {
      return res.status(400).json({ error: 'repo_url is too long' });
    }
    if (branch.length > 256) {
      return res.status(400).json({ error: 'branch is too long' });
    }
    if (typeof env_path === 'string' && env_path.length > 1024) {
      return res.status(400).json({ error: 'env_path is too long' });
    }
    if (typeof token === 'string' && token.length > 8192) {
      return res.status(400).json({ error: 'token is too long' });
    }
    if (typeof env_path === 'string' && env_path.trim() && !isValidGitSourcePath(env_path.trim())) {
      return res.status(400).json({ error: 'env_path must be a relative repository file path' });
    }
    const autoApplyOnWebhook = auto_apply_on_webhook === true;
    const autoDeployOnApply = auto_deploy_on_apply === true;
    if (autoDeployOnApply && !requirePermission(req, res, 'stack:deploy', 'stack', stack_name)) return;
    if (deploy_now === true && !requirePermission(req, res, 'stack:deploy', 'stack', stack_name)) return;

    const stacks = await FileSystemService.getInstance(req.nodeId).getStacks();
    if (stacks.includes(stack_name)) {
      return res.status(409).json({ error: 'Stack already exists' });
    }

    const syncEnv = Boolean(sync_env);
    const resolvedEnvPath = syncEnv
      ? defaultEnvPath(selection.value.composePaths[0], env_path)
      : null;

    if (fromGitDiag) {
      dlog(
        `[Stacks:diag] from-git start stack=${sanitizeForLog(stack_name)} nodeId=${req.nodeId ?? 'local'} host=${sanitizeForLog(gitRepoHost(repo_url))} branch=${sanitizeForLog(branch)} files=${selection.value.composePaths.length} envPath=${sanitizeForLog(resolvedEnvPath ?? 'none')} authType=${sanitizeForLog(resolvedAuthType)} autoApplyOnWebhook=${autoApplyOnWebhook} autoDeployOnApply=${autoDeployOnApply} deployNow=${deploy_now === true}`
      );
    }

    const result = await GitSourceService.getInstance().createStackFromGit({
      stackName: stack_name.trim(),
      repoUrl: repo_url.trim(),
      branch: branch.trim(),
      composePaths: selection.value.composePaths,
      contextDir: selection.value.contextDir,
      syncEnv,
      envPath: resolvedEnvPath,
      authType: resolvedAuthType,
      token: resolvedAuthType === 'token' && typeof token === 'string' && token !== '' ? token : null,
      autoApplyOnWebhook,
      autoDeployOnApply,
    });

    invalidateNodeCaches(req.nodeId);

    let deployed = false;
    let deployError: string | undefined;
    if (deploy_now === true) {
      const gate = await enforcePolicyPreDeploy(
        stack_name,
        req.nodeId,
        buildPolicyGateOptions(req),
      );
      if (!gate.ok) {
        deployError = `Policy "${gate.policy?.name}" blocked deploy: ${gate.violations.length} image(s) exceed ${gate.policy?.max_severity}`;
      } else {
        try {
          await ComposeService.getInstance(req.nodeId).deployStack(stack_name);
          deployed = true;
          invalidateNodeCaches(req.nodeId);
        } catch (e) {
          deployError = getErrorMessage(e, 'Deploy failed');
          console.error(`[Stacks] Deploy after create-from-git failed for ${sanitizeForLog(stack_name)}:`, deployError);
        }
      }
    }

    dlog(`[Stacks] Stack created from Git: ${sanitizeForLog(stack_name)} at ${result.commitSha.slice(0, 7)}`);
    if (fromGitDiag) {
      dlog(
        `[Stacks:diag] from-git ok stack=${sanitizeForLog(stack_name)} sha=${result.commitSha.slice(0, 7)} deployed=${deployed} envWritten=${result.envWritten} warnings=${result.warnings.length} elapsedMs=${Date.now() - fromGitStartedAt}`
      );
    }
    res.json({
      name: stack_name,
      source: result.source,
      commitSha: result.commitSha,
      envWritten: result.envWritten,
      warnings: result.warnings,
      deployed,
      deployError,
    });
    if (deployed && skip_scan !== true) {
      triggerPostDeployScan(stack_name, req.nodeId).catch(err =>
        console.error(`[Security] Post-deploy scan failed for ${sanitizeForLog(stack_name)}:`, err),
      );
    }
  } catch (error) {
    if (fromGitDiag) {
      const code = error instanceof GitSourceError ? error.code : 'UNKNOWN';
      dlog(
        `[Stacks:diag] from-git fail stack=${sanitizeForLog(fromGitStackName)} code=${code} elapsedMs=${Date.now() - fromGitStartedAt}`
      );
    }
    sendGitSourceError(res, error);
  }
});

stacksRouter.delete('/:stackName', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:delete', 'stack', stackName)) return;
  const pruneVolumes = req.query.pruneVolumes === 'true';
  const debug = isDebugEnabled();
  const sanitizedName = sanitizeForLog(stackName);
  if (debug) console.debug(`[Stacks:debug] Delete starting`, { stackName: sanitizedName, pruneVolumes, nodeId: req.nodeId });

  // Step 1: compose down. Best-effort: a stack with corrupt compose files or
  // a temporarily-unreachable daemon should still be removable. Logged so the
  // operator can investigate orphaned containers separately.
  try {
    await ComposeService.getInstance(req.nodeId).downStack(stackName);
    if (debug) console.debug(`[Stacks:debug] Delete: down OK`, { stackName: sanitizedName });
  } catch (downErr) {
    console.warn('[Stacks] Compose down failed or no-op for %s:', sanitizeForLog(stackName), downErr);
  }

  // Step 2: volume prune (only if requested). Best-effort.
  if (pruneVolumes) {
    try {
      const result = await DockerController.getInstance().pruneManagedOnly('volumes', [stackName]);
      dlog(`[Stacks] Pruned volumes for ${sanitizeForLog(stackName)}: ${result.reclaimedBytes} bytes reclaimed`);
    } catch (pruneErr) {
      console.warn('[Stacks] Volume prune failed for %s, continuing delete:', sanitizeForLog(stackName), pruneErr);
    }
  }

  // Step 3: filesystem delete. If this fails the on-disk compose files are
  // still present, so we abort BEFORE touching the database — keeping DB and
  // FS in sync so the operator can retry. Otherwise a half-deleted stack
  // (rows gone, files remain) becomes invisible to the UI.
  try {
    await FileSystemService.getInstance(req.nodeId).deleteStack(stackName);
    if (debug) console.debug(`[Stacks:debug] Delete: fs OK`, { stackName: sanitizedName });
  } catch (fsErr) {
    console.error('[Stacks] File deletion failed for %s; database state untouched:', sanitizeForLog(stackName), fsErr);
    const message = getErrorMessage(fsErr, 'Failed to remove stack files');
    res.status(500).json({
      error: `${message}. Stack containers may have been stopped but on-disk files remain. Retry the delete or clean the files manually.`,
    });
    return;
  }

  // Step 4: database cleanup. Per-call idempotent; safe to run sequentially.
  try {
    DatabaseService.getInstance().clearStackUpdateStatus(req.nodeId, stackName);
    DatabaseService.getInstance().clearStackScanAttempts(req.nodeId, stackName);
    DatabaseService.getInstance().deleteRoleAssignmentsByResource('stack', stackName);
    DatabaseService.getInstance().deleteGitSource(stackName);
    DatabaseService.getInstance().deleteStackDossier(req.nodeId, stackName);
    DatabaseService.getInstance().deleteStackDriftFindings(req.nodeId, stackName);
    DatabaseService.getInstance().deleteStackExposureIntents(req.nodeId, stackName);
    if (debug) console.debug(`[Stacks:debug] Delete: db OK`, { stackName: sanitizedName });
  } catch (dbErr) {
    console.error('[Stacks] Database cleanup failed for %s; files already removed:', sanitizeForLog(stackName), dbErr);
    const message = getErrorMessage(dbErr, 'Failed to clear stack database state');
    res.status(500).json({
      error: `${message}. Stack files have been removed; some database rows for this stack may remain. Recreating the stack with the same name will reuse those rows.`,
    });
    return;
  }

  // Step 5: mesh opt-out cascade. Idempotent; best-effort cleanup of derived
  // aliases / override files. A mesh failure here must not flip the delete
  // result, since the stack itself is already gone.
  try {
    await MeshService.getInstance().optOutStack(
      req.nodeId,
      stackName,
      req.user?.username ?? 'system',
    );
  } catch (meshErr) {
    console.warn(
      '[Stacks] Mesh opt-out cascade failed for %s, continuing delete:',
      sanitizeForLog(stackName),
      meshErr,
    );
  }

  invalidateNodeCaches(req.nodeId);
  dlog(`[Stacks] Stack deleted: ${sanitizeForLog(stackName)}`);
  res.json({ success: true });
});

stacksRouter.get('/:stackName/containers', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return;
  }
  try {
    const dockerController = DockerController.getInstance(req.nodeId);
    const containers = await dockerController.getContainersByStack(stackName);
    res.json(containers);
  } catch (error) {
    console.error('[Stacks] Failed to fetch containers for %s:', sanitizeForLog(stackName), error);
    res.status(500).json({ error: 'Failed to fetch containers' });
  }
});

stacksRouter.get('/:stackName/services', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return;
  }
  try {
    const content = await FileSystemService.getInstance(req.nodeId).getStackContent(stackName);
    if (content.length > MAX_COMPOSE_PARSE_BYTES) {
      console.warn(`[Stacks] Compose for ${sanitizeForLog(stackName)} exceeds ${MAX_COMPOSE_PARSE_BYTES} bytes; refusing to parse services`);
      res.status(413).json({ error: 'Compose file too large to parse' });
      return;
    }
    const parsed = YAML.parse(content);
    const services = parsed?.services ? Object.keys(parsed.services) : [];
    res.json(services);
  } catch (error) {
    console.error('[Stacks] Failed to fetch services:', sanitizeForLog(getErrorMessage(error, 'unknown')));
    res.status(500).json({ error: 'Failed to fetch services' });
  }
});

/** A persisted finding as the Drift tab consumes it (no internal column names). */
interface DriftLedgerEntry {
  service: string;
  kind: DriftFindingKind;
  message: string;
  detectedAt: number;
  resolvedAt: number | null;
}

/**
 * Assemble the full Drift tab payload: the spatial report (compose vs runtime),
 * the temporal overlay (source changed since last deploy), and the persisted
 * ledger history. When `reconcile` is set, the current findings are persisted
 * into the ledger (new ones recorded, cleared ones resolved) before the ledger
 * is read back, so the returned history reflects the just-observed state.
 */
async function buildDriftPayload(
  nodeId: number,
  stackName: string,
  reconcile: boolean,
): Promise<StackDriftReport & { temporal: DriftTemporal; ledger: DriftLedgerEntry[]; lastCheckedAt: number | null }> {
  const report = await buildStackDriftReport(nodeId, stackName);
  // Only the on-disk read is best-effort: an unreadable compose is already surfaced
  // by the report as a parse error, so temporal degrades to neutral. computeTemporal
  // runs outside the try so a real ledger fault (a DB or hashing error) surfaces as a
  // 500 instead of being hidden behind a misleading "no baseline".
  let content: string | null = null;
  try {
    content = await FileSystemService.getInstance(nodeId).getStackContent(stackName);
  } catch {
    // Unreadable compose: the report carries the parseError; temporal stays neutral.
  }
  const temporal: DriftTemporal = content !== null
    ? DriftLedgerService.getInstance().computeTemporal(nodeId, stackName, content)
    : { hasBaseline: false, sourceChanged: false, renderedChanged: false };
  if (reconcile) {
    DriftLedgerService.getInstance().reconcile(nodeId, stackName, report);
  }
  // finding_type is a free-text column, but reconcile only ever writes a DriftFindingKind.
  const ledger: DriftLedgerEntry[] = DatabaseService.getInstance()
    .getRecentDriftFindings(nodeId, stackName, 20)
    .map(r => ({ service: r.service, kind: r.finding_type as DriftFindingKind, message: r.message, detectedAt: r.detected_at, resolvedAt: r.resolved_at }));
  // The ledger reflects the last reconcile (re-check, deploy, or background scan),
  // not this passive read, so surface when that was: the Drift tab labels the history
  // "checked {time ago}" and a stale finding reads as history, not current truth.
  const lastCheckedAt = DatabaseService.getInstance().getStackDossier(nodeId, stackName)?.last_drift_check_at ?? null;
  return { ...report, temporal, ledger, lastCheckedAt };
}

stacksRouter.get('/:stackName/drift', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!(await requireStackExists(req.nodeId, stackName, res))) return;
  try {
    res.json(await buildDriftPayload(req.nodeId, stackName, false));
  } catch (error) {
    console.error('[Stacks] Failed to build drift report for %s:', sanitizeForLog(stackName),
      sanitizeForLog(inspect(error, { depth: 4 })));
    res.status(500).json({ error: 'Failed to build drift report' });
  }
});

// Re-check is the one place a passive drift view becomes a ledger write: it
// reconciles the current findings into stack_drift_findings (recording newly
// detected and newly resolved ones) before returning the fresh payload, so the
// GET above can stay a side-effect-free read.
stacksRouter.post('/:stackName/drift/recheck', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:read', 'stack', stackName)) return;
  if (!(await requireStackExists(req.nodeId, stackName, res))) return;
  try {
    res.json(await buildDriftPayload(req.nodeId, stackName, true));
  } catch (error) {
    console.error('[Stacks] Failed to re-check drift for %s:', sanitizeForLog(stackName),
      sanitizeForLog(inspect(error, { depth: 4 })));
    res.status(500).json({ error: 'Failed to re-check drift' });
  }
});

// Compose Doctor: GET returns the last stored preflight run (or a never-run
// sentinel); it is a side-effect-free read. Both routes auto-proxy to the active
// node, so a remote stack is preflighted on the node that actually owns it.
stacksRouter.get('/:stackName/preflight', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:read', 'stack', stackName)) return;
  if (!(await requireStackExists(req.nodeId, stackName, res))) return;
  try {
    res.json(ComposeDoctorService.getInstance().getLatest(req.nodeId, stackName));
  } catch (error) {
    console.error('[Stacks] Failed to load preflight for %s:', sanitizeForLog(stackName),
      sanitizeForLog(inspect(error, { depth: 4 })));
    res.status(500).json({ error: 'Failed to load preflight report' });
  }
});

// Running preflight renders the effective model and stores the result, replacing
// any prior run. It is advisory and never blocks a deploy; stack:read is the
// correct gate since it mutates only the preflight tables, never the stack.
stacksRouter.post('/:stackName/preflight/run', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:read', 'stack', stackName)) return;
  if (!(await requireStackExists(req.nodeId, stackName, res))) return;
  try {
    const report = await ComposeDoctorService.getInstance().runPreflight(req.nodeId, stackName, req.user?.username ?? null);
    res.json(report);
  } catch (error) {
    console.error('[Stacks] Failed to run preflight for %s:', sanitizeForLog(stackName),
      sanitizeForLog(inspect(error, { depth: 4 })));
    res.status(500).json({ error: 'Failed to run preflight' });
  }
});

// Compose Network Inspector: per-stack networking facts (network map, service
// membership, published ports/bindings, network_mode, extra_hosts, runtime
// drift) derived from the authored effective model + live snapshot. Read-only
// and advisory; auto-proxies to the active node. Never returns raw render
// stderr, env values, or label values.
stacksRouter.get('/:stackName/networking', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:read', 'stack', stackName)) return;
  if (!(await requireStackExists(req.nodeId, stackName, res))) return;
  try {
    res.json(await buildStackNetworkFacts(req.nodeId, stackName));
  } catch (error) {
    console.error('[Stacks] Failed to build networking facts for %s:', sanitizeForLog(stackName),
      sanitizeForLog(inspect(error, { depth: 4 })));
    res.status(500).json({ error: 'Failed to build networking facts' });
  }
});

// Storage inventory: per-stack mount inventory (binds, named/anonymous volumes,
// tmpfs, docker socket; read-only vs read-write; host-path existence/type/owner)
// and a portability verdict derived from the effective model + within-stack
// host-path probes. Read-only and advisory; auto-proxies to the active node.
// Never returns raw render stderr or any environment value.
stacksRouter.get('/:stackName/storage', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:read', 'stack', stackName)) return;
  if (!(await requireStackExists(req.nodeId, stackName, res))) return;
  try {
    res.json(await buildStorageInventory(req.nodeId, stackName));
  } catch (error) {
    console.error('[Stacks] Failed to build storage inventory for %s:', sanitizeForLog(stackName),
      sanitizeForLog(inspect(error, { depth: 4 })));
    res.status(500).json({ error: 'Failed to build storage inventory' });
  }
});

// Effective Stack Anatomy: structural facts (services, ports, volumes, networks,
// restart) from the fully-merged effective model, so a multi-file Git source's
// dossier and doc-drift reflect every override file, not just the root compose.
// Read-only and advisory; auto-proxies to the active node. Secret-safe: the
// response carries only structural fields; resolved env, label, and command
// values in the rendered model are never extracted into the payload.
stacksRouter.get('/:stackName/effective-anatomy', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:read', 'stack', stackName)) return;
  if (!(await requireStackExists(req.nodeId, stackName, res))) return;
  try {
    res.json(await buildEffectiveAnatomy(req.nodeId, stackName));
  } catch (error) {
    console.error('[Stacks] Failed to build effective anatomy for %s:', sanitizeForLog(stackName),
      sanitizeForLog(inspect(error, { depth: 4 })));
    res.status(500).json({ error: 'Failed to build effective anatomy' });
  }
});

// Environment inventory: per-stack env vars with their source, scope (Compose
// interpolation vs container injection), and status (present/missing/unused/
// duplicate/unpersisted), plus likely-secret classification. Read-only and
// advisory; auto-proxies to the active node. Names only: an env value is never
// read into the payload, so stack:read is the correct gate.
stacksRouter.get('/:stackName/env-inventory', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:read', 'stack', stackName)) return;
  if (!(await requireStackExists(req.nodeId, stackName, res))) return;
  try {
    res.json(await buildEnvInventory(req.nodeId, stackName));
  } catch (error) {
    console.error('[Stacks] Failed to build env inventory for %s:', sanitizeForLog(stackName),
      sanitizeForLog(inspect(error, { depth: 4 })));
    res.status(500).json({ error: 'Failed to build env inventory' });
  }
});

// Exposure intent: the user's per-stack (service '') and per-service exposure
// classification, stored separately from generated facts so mismatches stay
// detectable. Rows are stored independently; precedence (a service row taking
// priority over the stack row, an absent service row inheriting the stack
// intent) is applied by the consumers that read these rows, not enforced here.
// Clearing a row (intent null) deletes it, returning that scope to unset.
const ExposurePutSchema = z.object({
  service: z.string().max(255).optional().default(''),
  intent: z.enum(EXPOSURE_INTENTS).nullable(),
});

function exposurePayload(nodeId: number, stackName: string): {
  intents: { service: string; intent: ExposureIntent; updatedAt: number; updatedBy: string | null }[];
} {
  return {
    intents: DatabaseService.getInstance().getStackExposureIntents(nodeId, stackName).map(r => ({
      service: r.service, intent: r.intent, updatedAt: r.updated_at, updatedBy: r.updated_by,
    })),
  };
}

stacksRouter.get('/:stackName/exposure', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:read', 'stack', stackName)) return;
  if (!(await requireStackExists(req.nodeId, stackName, res))) return;
  try {
    res.json(exposurePayload(req.nodeId, stackName));
  } catch (error) {
    console.error('[Stacks] Failed to read exposure intent for %s:', sanitizeForLog(stackName),
      sanitizeForLog(getErrorMessage(error, 'unknown')));
    res.status(500).json({ error: 'Failed to read exposure intent' });
  }
});

stacksRouter.put('/:stackName/exposure', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
  if (!(await requireStackExists(req.nodeId, stackName, res))) return;
  const parsed = ExposurePutSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid exposure intent' });
    return;
  }
  const { service, intent } = parsed.data;
  try {
    if (intent === null) {
      DatabaseService.getInstance().deleteStackExposureIntent(req.nodeId, stackName, service);
    } else {
      DatabaseService.getInstance().setStackExposureIntent(req.nodeId, stackName, service, intent, req.user?.username ?? null);
    }
    res.json(exposurePayload(req.nodeId, stackName));
  } catch (error) {
    console.error('[Stacks] Failed to save exposure intent for %s:', sanitizeForLog(stackName),
      sanitizeForLog(getErrorMessage(error, 'unknown')));
    res.status(500).json({ error: 'Failed to save exposure intent' });
  }
});

// Update guard: readiness reports computed on demand from existing stores
// (preflight runs, drift findings, backup slot, update preview, live Docker
// state). Node-scoped like preflight: a remote stack is evaluated on the node
// that owns it. Read-only, so stack:read is the correct gate.
stacksRouter.get('/:stackName/update-readiness', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:read', 'stack', stackName)) return;
  if (!(await requireStackExists(req.nodeId, stackName, res))) return;
  try {
    const report = await UpdateGuardService.getInstance().computeUpdateReadiness(req.nodeId, stackName);
    res.json(report);
  } catch (error) {
    console.error('[Stacks] Failed to compute update readiness for %s:', sanitizeForLog(stackName),
      sanitizeForLog(getErrorMessage(error, 'unknown')));
    res.status(500).json({ error: 'Failed to compute update readiness' });
  }
});

stacksRouter.get('/:stackName/rollback-readiness', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:read', 'stack', stackName)) return;
  if (!(await requireStackExists(req.nodeId, stackName, res))) return;
  try {
    const report = await UpdateGuardService.getInstance().computeRollbackReadiness(req.nodeId, stackName);
    res.json(report);
  } catch (error) {
    console.error('[Stacks] Failed to compute rollback readiness for %s:', sanitizeForLog(stackName),
      sanitizeForLog(getErrorMessage(error, 'unknown')));
    res.status(500).json({ error: 'Failed to compute rollback readiness' });
  }
});

// Post-update health gate result. `gateId` returns that specific run so a
// superseded gate still resolves to its terminal state; without it, the
// latest run (or a never-run sentinel).
stacksRouter.get('/:stackName/health-gate', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:read', 'stack', stackName)) return;
  if (!(await requireStackExists(req.nodeId, stackName, res))) return;
  try {
    const gateId = typeof req.query.gateId === 'string' && req.query.gateId.trim() ? req.query.gateId : undefined;
    res.json(HealthGateService.getInstance().getReport(req.nodeId, stackName, gateId));
  } catch (error) {
    console.error('[Stacks] Failed to load health gate for %s:', sanitizeForLog(stackName),
      sanitizeForLog(getErrorMessage(error, 'unknown')));
    res.status(500).json({ error: 'Failed to load health gate' });
  }
});

stacksRouter.post('/:stackName/deploy', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:deploy', 'stack', stackName)) return;
  if (!(await requireStackExists(req.nodeId, stackName, res))) return;
  // Lock held below. All early-returns must stay inside the try so finally fires.
  if (!tryAcquireStackOpLock(req, res, stackName, 'deploy')) return;
  const t0 = Date.now();
  let ok = false;
  try {
    if (!(await runPolicyGate(req, res, stackName, req.nodeId))) return;
    const skipScan = req.body?.skip_scan === true;
    const debug = isDebugEnabled();
    const atomic = true;
    if (debug) console.debug('[Stacks:debug] Deploy starting', { stackName, atomic, nodeId: req.nodeId });
    await ComposeService.getInstance(req.nodeId).deployStack(stackName, getTerminalWs(req.get(DEPLOY_SESSION_HEADER)), atomic);
    invalidateNodeCaches(req.nodeId);
    dlog(`[Stacks] Deploy completed: ${sanitizeForLog(stackName)}`);
    if (debug) console.debug(`[Stacks:debug] Deploy finished in ${Date.now() - t0}ms`);
    ok = true;
    const healthGateId = HealthGateService.getInstance().begin(req.nodeId, stackName, 'deploy', req.user?.username ?? null);
    res.json({ message: 'Deployed successfully', healthGateId });
    notifyActionSuccess('deploy_success', `${stackName} deployed`, stackName, req.user?.username ?? 'system');
    if (!skipScan) {
      triggerPostDeployScan(stackName, req.nodeId).catch(err =>
        console.error('[Security] Post-deploy scan failed for %s:', sanitizeForLog(stackName), err),
      );
    }
  } catch (error: unknown) {
    console.error('[Stacks] Deploy failed: %s', sanitizeForLog(stackName), error);
    const rollbackInfo = getComposeRollbackInfo(error);
    const rolledBack = rollbackInfo?.rolledBack ?? false;
    if (rolledBack) {
      console.warn('[Stacks] Deploy failed, rolled back: %s', sanitizeForLog(stackName));
    } else if (rollbackInfo?.attempted) {
      console.warn('[Stacks] Deploy failed, rollback did not complete: %s', sanitizeForLog(stackName));
    }
    const message = getErrorMessage(error, 'Failed to deploy stack');
    // ComposeRollbackError already carries the cause's message; see classifyFailure.
    const failure = classifyFailure(message, { dockerUnavailable: isDockerUnavailableError(error) });
    notifyActionFailure('deploy', stackName, error, req.user?.username ?? 'system');
    if (!res.headersSent) {
      if (isDockerUnavailableError(error)) {
        res.status(503).json({ error: message, code: 'docker_unavailable', rolledBack, failure });
      } else {
        res.status(500).json({ error: message, rolledBack, failure });
      }
    }
  } finally {
    releaseStackOpLock(req, stackName);
    StackOpMetricsService.getInstance().record(req.nodeId, 'deploy', Date.now() - t0, ok);
  }
});

stacksRouter.post('/:stackName/down', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:deploy', 'stack', stackName)) return;
  if (!(await requireStackExists(req.nodeId, stackName, res))) return;
  // Lock held below. All early-returns must stay inside the try so finally fires.
  if (!tryAcquireStackOpLock(req, res, stackName, 'down')) return;
  const t0 = Date.now();
  let ok = false;
  try {
    if (isDebugEnabled()) console.debug(`[Stacks:debug] Down starting`, { stackName: sanitizeForLog(stackName), nodeId: req.nodeId });
    await ComposeService.getInstance(req.nodeId).runCommand(stackName, 'down', getTerminalWs(req.get(DEPLOY_SESSION_HEADER)));
    invalidateNodeCaches(req.nodeId);
    dlog(`[Stacks] Down completed: ${sanitizeForLog(stackName)}`);
    ok = true;
    res.json({ status: 'Command started' });
  } catch (error: unknown) {
    console.error('[Stacks] Down failed: %s', sanitizeForLog(stackName), error);
    notifyActionFailure('down', stackName, error, req.user?.username ?? 'system');
    if (!res.headersSent) {
      if (isDockerUnavailableError(error)) {
        res.status(503).json({ error: getErrorMessage(error, 'Docker daemon is unreachable'), code: 'docker_unavailable' });
      } else {
        res.status(500).json({ error: 'Failed to start command' });
      }
    }
  } finally {
    releaseStackOpLock(req, stackName);
    StackOpMetricsService.getInstance().record(req.nodeId, 'down', Date.now() - t0, ok);
  }
});

export type StackContainerAction = 'restart' | 'stop' | 'start';

const CONTAINER_ACTION_META: Record<StackContainerAction, { category: NotificationCategory; pastTense: string }> = {
  restart: { category: 'stack_restarted', pastTense: 'restarted' },
  stop:    { category: 'stack_stopped',   pastTense: 'stopped'   },
  start:   { category: 'stack_started',   pastTense: 'started'   },
};

export type ContainerActionOutcome =
  | { kind: 'ok'; count: number }
  | { kind: 'no-containers' }
  | { kind: 'docker-unavailable'; message: string }
  | { kind: 'error'; message: string };

/**
 * Returns true when the error looks like a Docker-engine reachability
 * failure (socket gone, daemon down, connection refused). The string match
 * is intentionally permissive: Dockerode wraps the underlying Node error
 * differently depending on the transport (unix socket vs tcp vs ssh) and
 * the OS, so a code-only check (`err.code === 'ECONNREFUSED'`) would miss
 * some shapes.
 */
export function isDockerUnavailableError(error: unknown): boolean {
  if (!error) return false;
  const err = error as NodeJS.ErrnoException & { errno?: number };
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT' && /docker\.sock/i.test(err.message ?? '')) {
    return true;
  }
  const message = String(err.message ?? '').toLowerCase();
  return (
    message.includes('econnrefused') ||
    message.includes('cannot connect to the docker daemon') ||
    message.includes('docker.sock') && (message.includes('connect') || message.includes('no such'))
  );
}

export async function containerActionForStack(
  nodeId: number,
  stackName: string,
  action: StackContainerAction,
): Promise<ContainerActionOutcome> {
  try {
    const dockerController = DockerController.getInstance(nodeId);
    const containers = await dockerController.getContainersByStack(stackName);
    if (!containers || containers.length === 0) return { kind: 'no-containers' };
    const op =
      action === 'restart' ? (id: string) => dockerController.restartContainer(id)
        : action === 'stop' ? (id: string) => dockerController.stopContainer(id)
          : (id: string) => dockerController.startContainer(id);
    await Promise.all(containers.map(c => op(c.Id)));
    return { kind: 'ok', count: containers.length };
  } catch (error: unknown) {
    if (isDockerUnavailableError(error)) {
      return { kind: 'docker-unavailable', message: getErrorMessage(error, 'Docker daemon is unreachable') };
    }
    return { kind: 'error', message: getErrorMessage(error, `Failed to ${action} containers`) };
  }
}

async function bulkContainerOp(
  req: Request,
  res: Response,
  action: StackContainerAction,
): Promise<void> {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:deploy', 'stack', stackName)) return;
  // Lock held below. All early-returns must stay inside the try so finally fires.
  if (!tryAcquireStackOpLock(req, res, stackName, action)) return;
  const t0 = Date.now();
  let ok = false;
  try {
    const titleCase = action.charAt(0).toUpperCase() + action.slice(1);
    if (isDebugEnabled()) console.debug(`[Stacks:debug] ${titleCase} starting`, { stackName: sanitizeForLog(stackName), nodeId: req.nodeId });
    const outcome = await containerActionForStack(req.nodeId, stackName, action);

    if (outcome.kind === 'no-containers') {
      res.status(404).json({ error: 'No containers found for this stack.' });
      return;
    }
    if (outcome.kind === 'docker-unavailable') {
      console.error('[Stacks] %s failed: docker unavailable for %s', sanitizeForLog(titleCase), sanitizeForLog(stackName));
      if (action !== 'start') notifyActionFailure(action, stackName, new Error(outcome.message), req.user?.username ?? 'system');
      res.status(503).json({ error: outcome.message, code: 'docker_unavailable' });
      return;
    }
    if (outcome.kind === 'error') {
      console.error('[Stacks] %s failed: %s %s', sanitizeForLog(titleCase), sanitizeForLog(stackName), sanitizeForLog(outcome.message));
      if (action !== 'start') notifyActionFailure(action, stackName, new Error(outcome.message), req.user?.username ?? 'system');
      res.status(500).json({ error: outcome.message });
      return;
    }

    invalidateNodeCaches(req.nodeId);
    dlog(`[Stacks] ${titleCase} completed: ${sanitizeForLog(stackName)} (${outcome.count} containers)`);
    ok = true;
    res.json({ success: true, message: `${titleCase} completed via Engine API.` });
    const { category, pastTense } = CONTAINER_ACTION_META[action];
    notifyActionSuccess(category, `${stackName} ${pastTense}`, stackName, req.user?.username ?? 'system');
  } catch (error: unknown) {
    console.error('[Stacks] %s threw unexpectedly: %s', sanitizeForLog(action), sanitizeForLog(stackName), error);
    if (!res.headersSent) {
      res.status(500).json({ error: getErrorMessage(error, `Failed to ${action} stack`) });
    }
  } finally {
    releaseStackOpLock(req, stackName);
    StackOpMetricsService.getInstance().record(req.nodeId, action as StackMetricAction, Date.now() - t0, ok);
  }
}

stacksRouter.post('/:stackName/restart', (req, res) => bulkContainerOp(req, res, 'restart'));
stacksRouter.post('/:stackName/stop', (req, res) => bulkContainerOp(req, res, 'stop'));
stacksRouter.post('/:stackName/start', (req, res) => bulkContainerOp(req, res, 'start'));

type ServiceAction = 'start' | 'stop' | 'restart';

async function handleServiceAction(
  req: Request,
  res: Response,
  action: ServiceAction,
): Promise<void> {
  const stackName = req.params.stackName as string;
  const serviceName = req.params.serviceName as string;
  if (!requirePermission(req, res, 'stack:deploy', 'stack', stackName)) return;
  if (!isValidServiceName(serviceName)) {
    res.status(400).json({ error: 'Invalid service name' });
    return;
  }
  try {
    const dockerController = DockerController.getInstance(req.nodeId);
    const all = await dockerController.getContainersByStack(stackName);
    if (!all || all.length === 0) {
      res.status(404).json({ error: 'No containers found for this stack.' });
      return;
    }
    const matching = all.filter(c => c.Service === serviceName);
    if (matching.length === 0) {
      res.status(404).json({ error: `Service '${serviceName}' not found in stack '${stackName}'.` });
      return;
    }
    const op =
      action === 'start'
        ? (id: string) => dockerController.startContainer(id)
        : action === 'stop'
          ? (id: string) => dockerController.stopContainer(id)
          : (id: string) => dockerController.restartContainer(id);
    await Promise.all(matching.map(c => op(c.Id)));
    invalidateNodeCaches(req.nodeId);
    dlog(
      `[Stacks] Service ${sanitizeForLog(action)} completed: ${sanitizeForLog(stackName)}/${sanitizeForLog(serviceName)} (${matching.length} containers)`,
    );
    res.json({
      success: true,
      message: `Service ${action} completed via Engine API.`,
      count: matching.length,
    });
  } catch (error: unknown) {
    console.error('[Stacks] Service %s failed: %s/%s', sanitizeForLog(action), sanitizeForLog(stackName), sanitizeForLog(serviceName), error);
    res.status(500).json({ error: getErrorMessage(error, `Failed to ${action} service`) });
  }
}

stacksRouter.post('/:stackName/services/:serviceName/restart', (req, res) =>
  handleServiceAction(req, res, 'restart'));
stacksRouter.post('/:stackName/services/:serviceName/stop', (req, res) =>
  handleServiceAction(req, res, 'stop'));
stacksRouter.post('/:stackName/services/:serviceName/start', (req, res) =>
  handleServiceAction(req, res, 'start'));

stacksRouter.get('/:stackName/update-preview', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  try {
    const preview = await UpdatePreviewService.getInstance().getPreview(req.nodeId, stackName);
    res.json(preview);
  } catch (error) {
    console.error('[Stacks] Update preview failed: %s', sanitizeForLog(stackName), sanitizeForLog(getErrorMessage(error, 'unknown')));
    res.status(500).json({ error: 'Failed to compute update preview' });
  }
});

stacksRouter.post('/:stackName/update', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:deploy', 'stack', stackName)) return;
  if (!(await requireStackExists(req.nodeId, stackName, res))) return;
  // Lock held below. All early-returns must stay inside the try so finally fires.
  if (!tryAcquireStackOpLock(req, res, stackName, 'update')) return;
  const t0 = Date.now();
  let ok = false;
  try {
    if (!(await runPolicyGate(req, res, stackName, req.nodeId))) return;
    const skipScan = req.body?.skip_scan === true;
    const debug = isDebugEnabled();
    const atomic = true;
    if (debug) console.debug('[Stacks:debug] Update starting', { stackName, atomic, nodeId: req.nodeId });
    await ComposeService.getInstance(req.nodeId).updateStack(stackName, getTerminalWs(req.get(DEPLOY_SESSION_HEADER)), atomic);
    DatabaseService.getInstance().clearStackUpdateStatus(req.nodeId, stackName);
    invalidateNodeCaches(req.nodeId);
    NotificationService.getInstance().broadcastEvent({
      type: 'state-invalidate',
      scope: 'image-updates',
      nodeId: req.nodeId,
      stackName,
      action: 'stack-updated',
      ts: Date.now(),
    });
    dlog(`[Stacks] Update completed: ${sanitizeForLog(stackName)}`);
    if (debug) console.debug(`[Stacks:debug] Update finished in ${Date.now() - t0}ms`);
    ok = true;
    const healthGateId = HealthGateService.getInstance().begin(req.nodeId, stackName, 'update', req.user?.username ?? null);
    res.json({ status: 'Update completed', healthGateId });
    notifyActionSuccess('image_update_applied', `${stackName} updated`, stackName, req.user?.username ?? 'system');
    if (!skipScan) {
      triggerPostDeployScan(stackName, req.nodeId).catch(err =>
        console.error('[Security] Post-deploy scan failed for %s:', sanitizeForLog(stackName), err),
      );
    }
  } catch (error: unknown) {
    console.error('[Stacks] Update failed: %s', sanitizeForLog(stackName), error);
    const rollbackInfo = getComposeRollbackInfo(error);
    const rolledBack = rollbackInfo?.rolledBack ?? false;
    if (rolledBack) {
      console.warn(`[Stacks] Update failed, rolled back: ${sanitizeForLog(stackName)}`);
    } else if (rollbackInfo?.attempted) {
      console.warn(`[Stacks] Update failed, rollback did not complete: ${sanitizeForLog(stackName)}`);
    }
    notifyActionFailure('update', stackName, error, req.user?.username ?? 'system');
    if (!res.headersSent) {
      const message = getErrorMessage(error, 'Failed to update');
      // ComposeRollbackError already carries the cause's message; see classifyFailure.
      const failure = classifyFailure(message, { dockerUnavailable: isDockerUnavailableError(error) });
      if (isDockerUnavailableError(error)) {
        res.status(503).json({ error: message, code: 'docker_unavailable', rolledBack, failure });
      } else {
        res.status(500).json({ error: message, rolledBack, failure });
      }
    }
  } finally {
    releaseStackOpLock(req, stackName);
    StackOpMetricsService.getInstance().record(req.nodeId, 'update', Date.now() - t0, ok);
  }
});

stacksRouter.post('/:stackName/rollback', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:deploy', 'stack', stackName)) return;
  // Rollback restores files and re-deploys, so it must hold the same per-stack
  // lock deploy/update use. Without it a rollback racing an in-flight deploy
  // would mutate the compose files and run a second `docker compose up` against
  // the same project. Lock held below: all early-returns stay inside the try so
  // finally fires.
  if (!tryAcquireStackOpLock(req, res, stackName, 'rollback')) return;
  try {
    const fsSvc = FileSystemService.getInstance(req.nodeId);
    const backupInfo = await fsSvc.getBackupInfo(stackName);
    if (!backupInfo.exists) {
      res.status(404).json({ error: 'No backup available for this stack.' });
      return;
    }
    dlog(`[Stacks] Rollback initiated: ${sanitizeForLog(stackName)}`);
    // Snapshot the current files before restoring so a policy gate that blocks
    // the restored target can be undone: restoreStackFiles commits to disk, and
    // without this a blocked rollback would leave disk rolled back while the
    // deployed state is unchanged.
    const revertRestore = await fsSvc.snapshotStackFiles(stackName);
    await fsSvc.restoreStackFiles(stackName);
    if (!(await runPolicyGate(req, res, stackName, req.nodeId))) {
      try {
        await revertRestore();
      } catch (revertError) {
        console.error('[Stacks] Failed to revert files after a policy-blocked rollback: %s', sanitizeForLog(stackName), revertError);
        // The 409 is already sent and the on-disk config now diverges from the
        // running stack; surface it on the persistent alert feed so the operator
        // can repair it rather than discovering it on the next deploy.
        notifyActionFailure('rollback', stackName, revertError, req.user?.username ?? 'system');
      }
      return;
    }
    await ComposeService.getInstance(req.nodeId).deployStack(stackName, getTerminalWs(req.get(DEPLOY_SESSION_HEADER)), false);
    invalidateNodeCaches(req.nodeId);
    dlog(`[Stacks] Rollback completed: ${sanitizeForLog(stackName)}`);
    res.json({ message: 'Stack rolled back: compose and env files restored.' });
    notifyActionSuccess('deploy_success', `${stackName} rolled back`, stackName, req.user?.username ?? 'system');
  } catch (error: unknown) {
    console.error('[Stacks] Rollback failed: %s', sanitizeForLog(stackName), error);
    const message = getErrorMessage(error, 'Rollback failed.');
    notifyActionFailure('rollback', stackName, error, req.user?.username ?? 'system');
    if (!res.headersSent) {
      res.status(500).json({ error: message });
    }
  } finally {
    releaseStackOpLock(req, stackName);
  }
});

stacksRouter.get('/:stackName/backup', async (req: Request, res: Response) => {
  try {
    const stackName = req.params.stackName as string;
    const fsSvc = FileSystemService.getInstance(req.nodeId);
    const info = await fsSvc.getBackupInfo(stackName);
    res.json(info);
  } catch (error: unknown) {
    console.error('Failed to get backup info:', error);
    const message = getErrorMessage(error, 'Failed to get backup info.');
    res.status(500).json({ error: message });
  }
});

stacksRouter.post('/:stackName/backup', async (req: Request, res: Response) => {
  // Triggers a server-side backup of the stack's managed files: the same
  // rollback snapshot a deploy takes. Exposed so a scheduled backup can run on
  // a remote node through the proxy path, and so an operator can capture an
  // on-demand snapshot.
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:deploy', 'stack', stackName)) return;
  if (!(await requireStackExists(req.nodeId, stackName, res))) return;
  // The backup slot is shared with the pre-deploy rollback snapshot, so hold the
  // stack-op lock to keep a backup from interleaving with a concurrent
  // deploy/update/rollback on the same stack. All early-returns stay inside the
  // try so finally always releases.
  if (!tryAcquireStackOpLock(req, res, stackName, 'backup')) return;
  try {
    await FileSystemService.getInstance(req.nodeId).backupStackFiles(stackName);
    dlog(`[Stacks] Backup completed: ${sanitizeForLog(stackName)}`);
    res.json({ success: true });
  } catch (error: unknown) {
    console.error('[Stacks] Backup failed: %s', sanitizeForLog(stackName), error);
    res.status(500).json({ error: getErrorMessage(error, 'Failed to back up stack files') });
  } finally {
    releaseStackOpLock(req, stackName);
  }
});

/**
 * Returns the latest post-deploy scan attempt for this stack, or null if
 * no scan has been attempted yet. Used by the editor UI to flag stacks
 * whose latest deploy did not trigger a successful scan (Trivy missing,
 * registry rejection, etc).
 */
stacksRouter.get('/:stackName/scan-status', (req: Request, res: Response): void => {
  const stackName = req.params.stackName as string;
  const row = DatabaseService.getInstance().getStackScanAttempt(req.nodeId, stackName);
  if (!row) {
    res.json({ status: null });
    return;
  }
  res.json({
    status: row.status,
    attemptedAt: row.attempted_at,
    errorMessage: row.error_message,
  });
});

// ── File explorer endpoints ──

type FsErrorCode =
  | 'INVALID_PATH'
  | 'SYMLINK_ESCAPE'
  | 'INVALID_ROOT'
  | 'READONLY_ROOT'
  | 'ROOT_UNAVAILABLE'
  | 'UNSUPPORTED_ON_ROOT'
  | 'IS_DIRECTORY'
  | 'NOT_EMPTY'
  | 'NOT_FOUND'
  | 'TOO_LARGE'
  | 'ALREADY_EXISTS'
  | 'FILE_EXISTS'
  | 'DIR_EXISTS'
  | 'PROTECTED_FILE'
  | 'LINK_CHMOD_UNSUPPORTED'
  | 'EXDEV';

function sendFsError(
  res: Response,
  err: unknown,
  fallback: string,
  opts: { notFoundMessage?: string } = {},
): Response {
  const e = err as NodeJS.ErrnoException & { code?: string };
  if (e.code === 'INVALID_PATH' || e.code === 'SYMLINK_ESCAPE') {
    return res.status(400).json({ error: e.message, code: e.code as FsErrorCode });
  }
  if (e.code === 'IS_DIRECTORY') {
    return res.status(400).json({ error: e.message, code: e.code as FsErrorCode });
  }
  if (e.code === 'NOT_EMPTY') {
    return res.status(409).json({ error: e.message, code: e.code as FsErrorCode });
  }
  if (e.code === 'PROTECTED_FILE') {
    return res.status(409).json({ error: e.message, code: 'PROTECTED_FILE' satisfies FsErrorCode });
  }
  if (e.code === 'LINK_CHMOD_UNSUPPORTED') {
    return res.status(409).json({ error: e.message, code: 'LINK_CHMOD_UNSUPPORTED' satisfies FsErrorCode });
  }
  if (e.code === 'EEXIST') {
    return res.status(409).json({ error: e.message, code: 'ALREADY_EXISTS' satisfies FsErrorCode });
  }
  if (e.code === 'EXDEV') {
    return res.status(409).json({ error: 'Cannot move across a storage boundary', code: 'EXDEV' satisfies FsErrorCode });
  }
  if (e.code === 'ENOTDIR') {
    return res.status(400).json({ error: 'Target path is not a directory', code: 'INVALID_PATH' satisfies FsErrorCode });
  }
  if (e.code === 'ENOENT') {
    return res.status(404).json({ error: opts.notFoundMessage ?? 'File not found', code: 'NOT_FOUND' });
  }
  if (e.code === 'UNSUPPORTED_ON_ROOT') {
    return res.status(400).json({ error: e.message, code: 'UNSUPPORTED_ON_ROOT' satisfies FsErrorCode });
  }
  if (e.code === 'FILE_EXISTS') {
    return res.status(409).json({ error: e.message, code: 'FILE_EXISTS' satisfies FsErrorCode });
  }
  // Helper-backed (named-volume) ops throw an ExecError carrying an HTTP status;
  // honour it (403 permission-denied, 409 conflict, 413 too-large, 504 timeout).
  // A 4xx message is a self-explanatory client error and is forwarded as-is; a
  // 5xx is a server-side failure, so log the detail and return a clean message.
  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number' && status >= 400 && status < 600) {
    if (status >= 500) {
      // Constant format string + sanitized args (the status is already carried by
      // the HTTP response, so it is not repeated in the log).
      console.error('[files] %s (helper failure): %s', sanitizeForLog(fallback), sanitizeForLog(e.message));
      return res.status(status).json({ error: fallback });
    }
    return res.status(status).json({ error: e.message });
  }
  console.error(`[files] ${fallback}:`, sanitizeForLog(e.message));
  return res.status(500).json({ error: fallback });
}

const ROOT_ID_RE = /^[A-Za-z0-9:_-]{1,80}$/;

function readRootId(req: Request): string {
  const raw = req.query.rootId;
  return typeof raw === 'string' && raw ? raw : STACK_SOURCE_ROOT_ID;
}

/**
 * Resolve the client's rootId to a server-derived root, enforcing browsability
 * for reads and writability for writes. Sends the error response and returns
 * null when the root is unknown, read-only, or not browsable, so the caller
 * just does `if (!root) return;`. Writes resolve fresh (cache bypass) so a
 * removed mount cannot be written through a stale allowlist.
 */
async function resolveRootForOp(
  req: Request,
  res: Response,
  stackName: string,
  mode: 'read' | 'write',
): Promise<StackFileRoot | null> {
  const rootId = readRootId(req);
  // Back-compat fast path: no rootId (or the stack-source root) is exactly the
  // legacy behaviour. Return a synthetic stack-source root without touching the
  // roots service, so plain stack-source ops never trigger a compose render.
  if (rootId === STACK_SOURCE_ROOT_ID) {
    return stackSourceFileRoot();
  }
  if (!ROOT_ID_RE.test(rootId)) {
    res.status(400).json({ error: 'Invalid root', code: 'INVALID_ROOT' satisfies FsErrorCode });
    return null;
  }
  let root: StackFileRoot;
  try {
    root = await StackFileRootsService.getInstance(req.nodeId).resolveRoot(stackName, rootId, { fresh: mode === 'write' });
  } catch (err) {
    if ((err as { code?: string }).code === 'INVALID_ROOT') {
      res.status(400).json({ error: 'Unknown file root', code: 'INVALID_ROOT' satisfies FsErrorCode });
      return null;
    }
    sendFsError(res, err, 'Failed to resolve file root');
    return null;
  }
  if (mode === 'write' && !root.writable) {
    res.status(403).json({ error: root.warning ?? 'This location is read-only.', code: 'READONLY_ROOT' satisfies FsErrorCode });
    return null;
  }
  if (mode === 'read' && !root.browsable) {
    res.status(400).json({ error: root.warning ?? 'This location cannot be browsed.', code: 'ROOT_UNAVAILABLE' satisfies FsErrorCode });
    return null;
  }
  return root;
}

/** Drop the cached root allowlist after a stack-source mutation that can change declared mounts. */
function afterStackMutation(req: Request, stackName: string): void {
  StackFileRootsService.invalidate(req.nodeId, stackName);
}

function logFileOperation(level: 'info' | 'warn', message: string, details: Record<string, unknown>): void {
  const cleaned = Object.fromEntries(
    Object.entries(details).map(([key, value]) => [key, sanitizeForLog(value)]),
  );
  const log = level === 'warn' ? console.warn : console.log;
  log(`[Files] ${message}`, cleaned);
}

function fsErrorCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

function logFileDiag(message: string, details: Record<string, unknown>): void {
  if (DatabaseService.getInstance().getGlobalSettings().developer_mode !== '1') return;
  const cleaned = Object.fromEntries(
    Object.entries(details).map(([key, value]) => [key, sanitizeForLog(value)]),
  );
  console.debug(`[Files:diag] ${message}`, cleaned);
}

/**
 * Records one file-explorer op into the in-process metrics service. Always
 * called once per request from the route layer, regardless of success or
 * failure, so the counts in the `/api/file-explorer-metrics` snapshot stay
 * in step with the INFO log line emitted in the same handler.
 */
function recordFileOp(nodeId: number, op: FileExplorerOp, startedAt: number, ok: boolean): void {
  FileExplorerMetricsService.getInstance().record(nodeId, op, Date.now() - startedAt, ok);
}

/**
 * Emits the warn log, records the metric, and sends the JSON response for a
 * mutation rejected with a known error code (e.g. DIR_EXISTS, FILE_EXISTS,
 * PRECONDITION_FAILED). Centralizes the three-step shape so a future rejection
 * site cannot skip the metric and drift from the log.
 */
function rejectFileMutation(
  req: Request,
  res: Response,
  args: {
    op: FileExplorerOp;
    stack: string;
    path: string;
    startedAt: number;
    status: number;
    code: string;
    body: Record<string, unknown>;
  },
): Response {
  logFileOperation('warn', 'mutate rejected', {
    nodeId: req.nodeId,
    op: args.op,
    stack: args.stack,
    path: args.path,
    errorCode: args.code,
  });
  recordFileOp(req.nodeId, args.op, args.startedAt, false);
  return res.status(args.status).json({ ...args.body, code: args.code });
}

function isSafeUploadFilename(rawName: string): boolean {
  if (!rawName || rawName === '.' || rawName === '..') return false;
  if (rawName.includes('\0') || rawName.includes('/') || rawName.includes('\\')) return false;
  if (/^[a-zA-Z]:/.test(rawName) || path.isAbsolute(rawName)) return false;
  return path.basename(rawName) === rawName;
}

const DIR_LIST_LIMIT = 1000;

stacksRouter.get('/:stackName/file-roots', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:read', 'stack', stackName)) return;
  try {
    const roots = await StackFileRootsService.getInstance(req.nodeId).listRoots(stackName);
    return res.json(roots);
  } catch (err: unknown) {
    return sendFsError(res, err, 'Failed to list file roots');
  }
});

stacksRouter.get('/:stackName/files', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:read', 'stack', stackName)) return;
  const relPath = getRelPath(req);
  if (relPath !== '' && !isValidRelativeStackPath(relPath)) {
    return res.status(400).json({ error: 'Invalid path', code: 'INVALID_PATH' });
  }
  const root = await resolveRootForOp(req, res, stackName, 'read');
  if (!root) return;
  const startedAt = Date.now();
  logFileDiag('list start', { stackName, relPath, nodeId: req.nodeId, rootKind: root.kind });
  try {
    const result = await FileRootGateway.getInstance(req.nodeId).listDir(root, stackName, relPath, DIR_LIST_LIMIT);
    // Expose pagination context via headers; the JSON body stays
    // FileEntry[] for backward compatibility with any direct API caller.
    res.setHeader('X-Total-Count', String(result.total));
    res.setHeader('X-Returned-Count', String(result.entries.length));
    if (result.truncated) res.setHeader('X-Truncated', 'true');
    logFileDiag('list complete', {
      stackName,
      relPath,
      nodeId: req.nodeId,
      returned: result.entries.length,
      total: result.total,
      truncated: result.truncated,
      elapsedMs: Date.now() - startedAt,
    });
    recordFileOp(req.nodeId, 'list', startedAt, true);
    return res.json(result.entries);
  } catch (err: unknown) {
    logFileOperation('warn', 'list failed', { nodeId: req.nodeId, errorCode: fsErrorCode(err) });
    recordFileOp(req.nodeId, 'list', startedAt, false);
    return sendFsError(res, err, 'Failed to list directory');
  }
});

stacksRouter.get('/:stackName/files/content', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:read', 'stack', stackName)) return;
  const relPath = getRelPath(req);
  if (!relPath) return res.status(400).json({ error: 'path query parameter is required', code: 'INVALID_PATH' });
  if (!isValidRelativeStackPath(relPath)) {
    return res.status(400).json({ error: 'Invalid path', code: 'INVALID_PATH' });
  }
  const forceText = req.query.force === 'text';
  const root = await resolveRootForOp(req, res, stackName, 'read');
  if (!root) return;
  const startedAt = Date.now();
  logFileDiag('read start', { stackName, relPath, nodeId: req.nodeId, forceText, rootKind: root.kind });
  try {
    const result = await FileRootGateway.getInstance(req.nodeId).read(root, stackName, relPath, forceText);
    // ETag carries the opaque version token the matching PUT compares. For fs
    // roots it is the weak ETag over the integer mtimeMs (unchanged); for helper
    // roots it is a composite token. The body also carries `version` so the
    // client round-trips it verbatim as If-Match.
    res.setHeader('ETag', result.version);
    logFileDiag('read complete', {
      stackName,
      relPath,
      nodeId: req.nodeId,
      binary: result.binary,
      oversized: result.oversized,
      size: result.size,
      elapsedMs: Date.now() - startedAt,
    });
    recordFileOp(req.nodeId, 'read', startedAt, true);
    return res.json(result);
  } catch (err: unknown) {
    logFileOperation('warn', 'read failed', { nodeId: req.nodeId, errorCode: fsErrorCode(err) });
    recordFileOp(req.nodeId, 'read', startedAt, false);
    return sendFsError(res, err, 'Failed to read file');
  }
});

stacksRouter.get('/:stackName/files/download', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:read', 'stack', stackName)) return;
  const relPath = getRelPath(req);
  if (!relPath) return res.status(400).json({ error: 'path query parameter is required', code: 'INVALID_PATH' });
  if (!isValidRelativeStackPath(relPath)) {
    return res.status(400).json({ error: 'Invalid path', code: 'INVALID_PATH' });
  }
  const root = await resolveRootForOp(req, res, stackName, 'read');
  if (!root) return;
  const startedAt = Date.now();
  logFileDiag('download start', { stackName, relPath, nodeId: req.nodeId, rootKind: root.kind });
  try {
    const result = await FileRootGateway.getInstance(req.nodeId).download(root, stackName, relPath);
    const setDownloadHeaders = (filename: string, size: number, mime: string): void => {
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Length', size);
      const encodedFilename = encodeURIComponent(filename);
      const safeFilename = filename.replace(/[\\"]/g, '');
      res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`);
    };
    // Helper-backed (named-volume) downloads come back as a bounded buffer; send
    // it directly rather than through the file-stream lifecycle below.
    if (result.kind === 'buffer') {
      setDownloadHeaders(result.filename, result.size, 'application/octet-stream');
      recordFileOp(req.nodeId, 'download', startedAt, true);
      return res.end(result.buffer);
    }
    setDownloadHeaders(result.filename, result.size, result.mime);
    // Track download completion off both the file stream's lifecycle and the
    // response close. Under the in-process supertest transport, request close
    // events can race ahead of normal stream completion. End/error are the
    // durable source signals; a close (source or response) counts as success
    // only when the stream reports it read the full file, and as an abort
    // otherwise.
    let downloadRecorded = false;
    const streamWithBytes = result.stream as typeof result.stream & { bytesRead?: number };
    const hasReadFullFile = (): boolean => (
      result.size === 0 ||
      (typeof streamWithBytes.bytesRead === 'number' && streamWithBytes.bytesRead >= result.size)
    );
    let abortCleanupHandle: NodeJS.Immediate | null = null;
    const clearAbortCleanup = (): void => {
      if (!abortCleanupHandle) return;
      clearImmediate(abortCleanupHandle);
      abortCleanupHandle = null;
    };
    const recordDownloadOnce = (ok: boolean): void => {
      if (downloadRecorded) return;
      downloadRecorded = true;
      clearAbortCleanup();
      recordFileOp(req.nodeId, 'download', startedAt, ok);
    };
    result.stream.on('error', (streamErr) => {
      console.error('[files] stream error:', sanitizeForLog(getErrorMessage(streamErr, 'unknown')));
      if (!res.headersSent) {
        res.removeHeader('Content-Length');
        res.status(500).end();
      } else {
        res.destroy();
      }
      recordDownloadOnce(false);
    });
    result.stream.on('end', () => recordDownloadOnce(hasReadFullFile()));
    result.stream.on('close', () => recordDownloadOnce(hasReadFullFile()));
    res.on('close', () => {
      if (downloadRecorded) return;
      // This op measures a server-side file read, so once the source has
      // streamed the whole file a response close is a successful completion.
      // Record it here rather than waiting on the source stream's end/close,
      // which can be dropped once the response consumer is gone, leaving the
      // op unrecorded.
      if (hasReadFullFile()) { recordDownloadOnce(true); return; }
      // Otherwise response close is an abort signal. It can beat the source
      // stream's final events in the in-process test transport, so give a
      // same-turn clean source completion a chance to win before cleanup.
      abortCleanupHandle = setImmediate(() => {
        abortCleanupHandle = null;
        if (downloadRecorded) return;
        if (hasReadFullFile()) { recordDownloadOnce(true); return; }
        recordDownloadOnce(false);
        result.stream.destroy();
      });
      abortCleanupHandle.unref?.();
    });
    logFileDiag('download stream opened', { stackName, relPath, nodeId: req.nodeId, size: result.size, elapsedMs: Date.now() - startedAt });
    result.stream.pipe(res);
    return;
  } catch (err: unknown) {
    logFileOperation('warn', 'download failed', { nodeId: req.nodeId, errorCode: fsErrorCode(err) });
    recordFileOp(req.nodeId, 'download', startedAt, false);
    return sendFsError(res, err, 'Failed to download file');
  }
});

type UploadStartedReq = Request & { _fileUploadStartedAt?: number; _fileUploadRoot?: StackFileRoot };

stacksRouter.post(
  '/:stackName/files/upload',
  // Authorize BEFORE multer touches the body, so an unauthorized caller or a
  // read-only/non-existent root is rejected without ever spooling a temp file.
  // The resolved root is stashed for the handler so it is not resolved twice.
  async (req: Request, res: Response, next: NextFunction) => {
    const stackName = req.params.stackName as string;
    if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
    const root = await resolveRootForOp(req, res, stackName, 'write');
    if (!root) return;
    (req as UploadStartedReq)._fileUploadRoot = root;
    next();
  },
  (req: Request, res: Response, next: NextFunction) => {
    // Capture the time the upload entered the route so every downstream
    // metric reports the same latency window: the body-transfer +
    // parser-buffer time on success, plus the multer rejection branches
    // below. Reading a fresh Date.now() after multer would hide the
    // multipart upload's network and buffering cost from the histogram.
    const startedAt = Date.now();
    (req as UploadStartedReq)._fileUploadStartedAt = startedAt;
    upload.single('file')(req, res, (err) => {
      if (err && (err as multer.MulterError).code === 'LIMIT_FILE_SIZE') {
        logFileOperation('warn', 'mutate rejected', {
          nodeId: req.nodeId,
          op: 'upload',
          stack: req.params.stackName,
          errorCode: 'TOO_LARGE',
        });
        recordFileOp(req.nodeId, 'upload', startedAt, false);
        // diskStorage may have spooled a partial file before the limit fired.
        void cleanupUploadTemp(req).finally(() =>
          res.status(413).json({ error: 'File exceeds 25 MB limit', code: 'TOO_LARGE' }),
        );
        return;
      }
      if (err) {
        logFileOperation('warn', 'upload failed', {
          nodeId: req.nodeId,
          op: 'upload',
          stack: req.params.stackName,
          errorCode: 'MULTER_ERROR',
        });
        recordFileOp(req.nodeId, 'upload', startedAt, false);
        void cleanupUploadTemp(req).finally(() => res.status(500).json({ error: 'Upload failed' }));
        return;
      }
      next();
    });
  },
  async (req: Request, res: Response) => {
    const stackName = req.params.stackName as string;
    // The pre-multer middleware already authorized and resolved the root.
    const root = (req as UploadStartedReq)._fileUploadRoot;
    if (!root) {
      await cleanupUploadTemp(req);
      return res.status(500).json({ error: 'Upload failed' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }
    const relPath = getRelPath(req);
    if (relPath !== '' && !isValidRelativeStackPath(relPath)) {
      await cleanupUploadTemp(req);
      return res.status(400).json({ error: 'Invalid path', code: 'INVALID_PATH' });
    }
    const originalName = req.file.originalname;
    if (!isSafeUploadFilename(originalName)) {
      await cleanupUploadTemp(req);
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const targetRelPath = relPath ? `${relPath}/${originalName}` : originalName;
    const overwrite = String(req.query.overwrite) === '1';
    // The multer wrapper stashed the route-entry timestamp on the request so
    // the success path and the rejection paths share one window. Fall back to
    // Date.now() defensively in case the wrapper was bypassed in a test.
    const startedAt = (req as UploadStartedReq)._fileUploadStartedAt ?? Date.now();
    logFileDiag('upload start', { stackName, relPath: targetRelPath, nodeId: req.nodeId, size: req.file.size, overwrite });
    try {
      const gateway = FileRootGateway.getInstance(req.nodeId);
      const existing = await gateway.pathKind(root, stackName, targetRelPath);
      if (existing === 'directory') {
        // A directory can never be replaced by an upload; surface a distinct code
        // so the UI does not offer a useless "Replace" button.
        return rejectFileMutation(req, res, {
          op: 'upload',
          stack: stackName,
          path: targetRelPath,
          startedAt,
          status: 409,
          code: 'DIR_EXISTS',
          body: {
            error: `A folder named ${originalName} already exists in this folder. Rename the upload or remove the folder first.`,
          },
        });
      }
      if (existing === 'file' && !overwrite) {
        // Real FS work ran (pathKind) and the operator was rejected; surface
        // the conflict in metrics so a node with a hot overwrite-confirm
        // pattern shows up in the snapshot rather than disappearing.
        return rejectFileMutation(req, res, {
          op: 'upload',
          stack: stackName,
          path: targetRelPath,
          startedAt,
          status: 409,
          code: 'FILE_EXISTS',
          body: {
            error: `${originalName} already exists in this folder. Confirm to replace.`,
          },
        });
      }
      // Canonical js/path-injection barrier: the spool path is multer-generated
      // within UPLOAD_TMP_DIR (a random filename), but static analysis taints
      // req.file.*; confirm containment so the value handed to the gateway and
      // FileSystemService streaming sinks is credited as safe.
      const spoolBase = path.resolve(UPLOAD_TMP_DIR);
      const tempPath = path.resolve(req.file.path);
      if (!tempPath.startsWith(spoolBase + path.sep)) {
        return res.status(400).json({ error: 'Upload failed' });
      }
      // Copy the spooled temp file into place (the spool survives; the finally
      // removes it). The atomic exclusive create for the non-overwrite case means
      // a file created by another writer after the pathKind check above is not
      // silently clobbered (a race surfaces as FILE_EXISTS -> 409, same as the
      // pre-emptive check). overwrite=true intentionally allows the clobber.
      await gateway.writeFromTemp(root, stackName, targetRelPath, tempPath, !overwrite);
      afterStackMutation(req, stackName);
      logFileOperation('info', 'mutate', {
        nodeId: req.nodeId,
        op: 'upload',
        stack: stackName,
        path: targetRelPath,
        bytes: req.file.size,
        overwrite,
        rootKind: root.kind,
        backend: root.backend,
      });
      logFileDiag('upload timing', { stackName, relPath: targetRelPath, nodeId: req.nodeId, elapsedMs: Date.now() - startedAt });
      recordFileOp(req.nodeId, 'upload', startedAt, true);
      FileExplorerMetricsService.getInstance().recordUploadBytes(req.nodeId, req.file.size);
      return res.status(204).send();
    } catch (err: unknown) {
      logFileOperation('warn', 'upload failed', {
        nodeId: req.nodeId,
        op: 'upload',
        stack: stackName,
        path: targetRelPath,
        errorCode: fsErrorCode(err),
      });
      recordFileOp(req.nodeId, 'upload', startedAt, false);
      return sendFsError(res, err, 'Failed to upload file', { notFoundMessage: 'Target directory not found' });
    } finally {
      // writeFromTemp streams (copies) the spool into place, so the temp file
      // always remains and must be removed on every exit (success, conflict, error).
      await cleanupUploadTemp(req);
    }
  },
);

stacksRouter.put('/:stackName/files/content', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
  const relPath = getRelPath(req);
  if (!relPath) return res.status(400).json({ error: 'path query parameter is required', code: 'INVALID_PATH' });
  if (!isValidRelativeStackPath(relPath)) {
    return res.status(400).json({ error: 'Invalid path', code: 'INVALID_PATH' });
  }
  const { content } = req.body as { content?: unknown };
  if (typeof content !== 'string') {
    return res.status(400).json({ error: '"content" must be a string' });
  }
  const expectedVersion = req.header('if-match') || undefined;
  const root = await resolveRootForOp(req, res, stackName, 'write');
  if (!root) return;
  const startedAt = Date.now();
  logFileDiag('write start', { stackName, relPath, nodeId: req.nodeId, bytes: Buffer.byteLength(content, 'utf-8'), hasIfMatch: expectedVersion !== undefined, rootKind: root.kind });
  try {
    const result = await FileRootGateway.getInstance(req.nodeId).writeIfUnchanged(root, stackName, relPath, content, expectedVersion);
    if (!result.ok) {
      // Stale version: surface the current content + token so the client can
      // show a "file changed elsewhere" diff and retry with the fresh version.
      // Real work ran (the if-unchanged compare); record the attempted-and-
      // rejected write so concurrent-edit patterns show in the snapshot.
      res.setHeader('ETag', result.currentVersion);
      return rejectFileMutation(req, res, {
        op: 'write',
        stack: stackName,
        path: relPath,
        startedAt,
        status: 412,
        code: 'PRECONDITION_FAILED',
        body: {
          error: 'File has been modified since you last read it. Reload to see the current version.',
          currentMtimeMs: result.currentMtimeMs,
          currentContent: result.currentContent,
          currentVersion: result.currentVersion,
        },
      });
    }
    res.setHeader('ETag', result.version);
    afterStackMutation(req, stackName);
    logFileOperation('info', 'mutate', {
      nodeId: req.nodeId,
      op: 'write',
      stack: stackName,
      path: relPath,
      bytes: Buffer.byteLength(content, 'utf-8'),
      rootKind: root.kind,
      backend: root.backend,
    });
    logFileDiag('write timing', { stackName, relPath, nodeId: req.nodeId, elapsedMs: Date.now() - startedAt });
    recordFileOp(req.nodeId, 'write', startedAt, true);
    return res.status(204).send();
  } catch (err: unknown) {
    logFileOperation('warn', 'write failed', {
      nodeId: req.nodeId,
      op: 'write',
      stack: stackName,
      path: relPath,
      errorCode: fsErrorCode(err),
    });
    recordFileOp(req.nodeId, 'write', startedAt, false);
    return sendFsError(res, err, 'Failed to write file');
  }
});

stacksRouter.delete('/:stackName/files', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
  const relPath = getRelPath(req);
  if (relPath === '') return res.status(400).json({ error: 'Path is required for delete' });
  if (!isValidRelativeStackPath(relPath)) {
    return res.status(400).json({ error: 'Invalid path', code: 'INVALID_PATH' });
  }
  const recursive = req.query.recursive === '1';
  const root = await resolveRootForOp(req, res, stackName, 'write');
  if (!root) return;
  const startedAt = Date.now();
  logFileDiag('delete start', { stackName, relPath, recursive, nodeId: req.nodeId, rootKind: root.kind });
  try {
    await FileRootGateway.getInstance(req.nodeId).deletePath(root, stackName, relPath, recursive);
    afterStackMutation(req, stackName);
    logFileOperation('info', 'mutate', {
      nodeId: req.nodeId,
      op: 'delete',
      stack: stackName,
      path: relPath,
      recursive,
      rootKind: root.kind,
      backend: root.backend,
    });
    logFileDiag('delete timing', { stackName, relPath, recursive, nodeId: req.nodeId, elapsedMs: Date.now() - startedAt });
    recordFileOp(req.nodeId, 'delete', startedAt, true);
    return res.status(204).send();
  } catch (err: unknown) {
    logFileOperation('warn', 'delete failed', {
      nodeId: req.nodeId,
      op: 'delete',
      stack: stackName,
      path: relPath,
      recursive,
      errorCode: fsErrorCode(err),
    });
    recordFileOp(req.nodeId, 'delete', startedAt, false);
    return sendFsError(res, err, 'Failed to delete path');
  }
});

stacksRouter.post('/:stackName/files/folder', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
  const relPath = getRelPath(req);
  if (relPath === '') return res.status(400).json({ error: 'Path is required to create a folder' });
  if (!isValidRelativeStackPath(relPath)) {
    return res.status(400).json({ error: 'Invalid path', code: 'INVALID_PATH' });
  }
  const root = await resolveRootForOp(req, res, stackName, 'write');
  if (!root) return;
  const startedAt = Date.now();
  logFileDiag('mkdir start', { stackName, relPath, nodeId: req.nodeId, rootKind: root.kind });
  try {
    await FileRootGateway.getInstance(req.nodeId).mkdir(root, stackName, relPath);
    afterStackMutation(req, stackName);
    logFileOperation('info', 'mutate', {
      nodeId: req.nodeId,
      op: 'mkdir',
      stack: stackName,
      path: relPath,
      rootKind: root.kind,
      backend: root.backend,
    });
    logFileDiag('mkdir timing', { stackName, relPath, nodeId: req.nodeId, elapsedMs: Date.now() - startedAt });
    recordFileOp(req.nodeId, 'mkdir', startedAt, true);
    return res.status(204).send();
  } catch (err: unknown) {
    logFileOperation('warn', 'mkdir failed', {
      nodeId: req.nodeId,
      op: 'mkdir',
      stack: stackName,
      path: relPath,
      errorCode: fsErrorCode(err),
    });
    recordFileOp(req.nodeId, 'mkdir', startedAt, false);
    return sendFsError(res, err, 'Failed to create folder');
  }
});

stacksRouter.patch('/:stackName/files/rename', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
  const { from, to } = req.body as { from?: unknown; to?: unknown };
  if (typeof from !== 'string' || !from) {
    return res.status(400).json({ error: '"from" must be a non-empty string' });
  }
  if (typeof to !== 'string' || !to) {
    return res.status(400).json({ error: '"to" must be a non-empty string' });
  }
  if (!isValidRelativeStackPath(from)) {
    return res.status(400).json({ error: 'Invalid source path', code: 'INVALID_PATH' });
  }
  if (!isValidRelativeStackPath(to)) {
    return res.status(400).json({ error: 'Invalid destination path', code: 'INVALID_PATH' });
  }
  const root = await resolveRootForOp(req, res, stackName, 'write');
  if (!root) return;
  const startedAt = Date.now();
  logFileDiag('rename start', { stackName, from, to, nodeId: req.nodeId, rootKind: root.kind });
  try {
    await FileRootGateway.getInstance(req.nodeId).rename(root, stackName, from, to);
    afterStackMutation(req, stackName);
    logFileOperation('info', 'mutate', {
      nodeId: req.nodeId,
      op: 'rename',
      stack: stackName,
      path: from,
      toPath: to,
      rootKind: root.kind,
      backend: root.backend,
    });
    logFileDiag('rename timing', { stackName, from, to, nodeId: req.nodeId, elapsedMs: Date.now() - startedAt });
    recordFileOp(req.nodeId, 'rename', startedAt, true);
    return res.status(204).send();
  } catch (err: unknown) {
    logFileOperation('warn', 'rename failed', {
      nodeId: req.nodeId,
      op: 'rename',
      stack: stackName,
      path: from,
      toPath: to,
      errorCode: fsErrorCode(err),
    });
    recordFileOp(req.nodeId, 'rename', startedAt, false);
    return sendFsError(res, err, 'Failed to rename');
  }
});

stacksRouter.post('/:stackName/files/copy', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
  const { from, to } = req.body as { from?: unknown; to?: unknown };
  if (typeof from !== 'string' || !from) {
    return res.status(400).json({ error: '"from" must be a non-empty string' });
  }
  if (typeof to !== 'string' || !to) {
    return res.status(400).json({ error: '"to" must be a non-empty string' });
  }
  if (!isValidRelativeStackPath(from)) {
    return res.status(400).json({ error: 'Invalid source path', code: 'INVALID_PATH' });
  }
  if (!isValidRelativeStackPath(to)) {
    return res.status(400).json({ error: 'Invalid destination path', code: 'INVALID_PATH' });
  }
  const root = await resolveRootForOp(req, res, stackName, 'write');
  if (!root) return;
  const startedAt = Date.now();
  logFileDiag('copy start', { stackName, from, to, nodeId: req.nodeId, rootKind: root.kind });
  try {
    await FileRootGateway.getInstance(req.nodeId).copy(root, stackName, from, to);
    afterStackMutation(req, stackName);
    logFileOperation('info', 'mutate', {
      nodeId: req.nodeId,
      op: 'copy',
      stack: stackName,
      path: from,
      toPath: to,
      rootKind: root.kind,
      backend: root.backend,
    });
    logFileDiag('copy timing', { stackName, from, to, nodeId: req.nodeId, elapsedMs: Date.now() - startedAt });
    recordFileOp(req.nodeId, 'copy', startedAt, true);
    return res.status(204).send();
  } catch (err: unknown) {
    logFileOperation('warn', 'copy failed', {
      nodeId: req.nodeId,
      op: 'copy',
      stack: stackName,
      path: from,
      toPath: to,
      errorCode: fsErrorCode(err),
    });
    recordFileOp(req.nodeId, 'copy', startedAt, false);
    return sendFsError(res, err, 'Failed to copy');
  }
});

// ── Bulk file operations (delete / move / download) ─────────────────────────

const MAX_BULK = 100; // selected paths accepted per bulk request
const MAX_ARCHIVE_ENTRIES = 5000; // files packed into one bulk-download archive
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024; // 1 GiB uncompressed cap

/**
 * Helper-backed named volumes are Linux containers (case-sensitive). Filesystem
 * roots follow the host: Windows/macOS fold case, Linux does not.
 */
function rootCaseSensitive(root: StackFileRoot): boolean {
  if (root.backend === 'helper') return true;
  return process.platform !== 'win32' && process.platform !== 'darwin';
}

/** Validate a bulk path array; sends the 400 and returns null on any problem. */
function parseBulkPaths(value: unknown, res: Response): string[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    res.status(400).json({ error: 'A non-empty list of paths is required' });
    return null;
  }
  if (value.length > MAX_BULK) {
    res.status(400).json({ error: `Select at most ${MAX_BULK} items at once`, code: 'TOO_MANY' });
    return null;
  }
  const out: string[] = [];
  for (const p of value) {
    if (typeof p !== 'string' || p === '' || !isValidRelativeStackPath(p)) {
      res.status(400).json({ error: 'Invalid path in selection', code: 'INVALID_PATH' satisfies FsErrorCode });
      return null;
    }
    out.push(p);
  }
  return out;
}

/** A clean per-item failure message for a bulk result, mapping the opaque
 *  filesystem codes that carry no friendly message of their own. */
function bulkItemError(err: unknown): string {
  const e = err as Error & { code?: string };
  switch (e.code) {
    case 'EXDEV': return 'Cannot move across a storage boundary';
    case 'EEXIST': return 'A file or folder with that name already exists';
    case 'ENOENT': return 'No longer exists';
    case 'EISDIR': case 'ENOTDIR': return 'Path type changed';
    default: return e.message || e.code || 'Operation failed';
  }
}

function archiveTooLargeError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'ARCHIVE_TOO_LARGE' });
}

/**
 * Walk the normalized selection and return every file to pack, enforcing the
 * entry and byte caps. Throws ARCHIVE_TOO_LARGE if either cap is exceeded (or an
 * fs directory listing is truncated), so the caller can 413 before any archive
 * byte is streamed. File sizes come from listDir; every directory is stat-ed once
 * (the walk recurses into each), but individual files in a listing are not re-stat-ed.
 */
async function enumerateArchiveFiles(
  gateway: FileRootGateway,
  root: StackFileRoot,
  stackName: string,
  selection: string[],
): Promise<string[]> {
  const files: string[] = [];
  let totalBytes = 0;
  const addFile = (relPath: string, size: number): void => {
    files.push(relPath);
    totalBytes += size;
    if (files.length > MAX_ARCHIVE_ENTRIES) throw archiveTooLargeError('The selection has too many files to download');
    if (totalBytes > MAX_ARCHIVE_BYTES) throw archiveTooLargeError('The selection is too large to download');
  };
  const visit = async (relPath: string): Promise<void> => {
    const st = await gateway.stat(root, stackName, relPath);
    if (st.type !== 'directory') {
      gateway.assertArchivable(root, relPath, st);
      addFile(relPath, st.size);
      return;
    }
    // Request one over the remaining budget so a directory that would push us one
    // entry past the cap is detected: the overflow entry reaches addFile (which
    // throws on >), or for larger directories the fs listing reports truncated.
    const remaining = MAX_ARCHIVE_ENTRIES - files.length + 1;
    const { entries, truncated } = await gateway.listDir(root, stackName, relPath, remaining);
    if (truncated) throw archiveTooLargeError('A selected folder has too many files to download');
    for (const entry of entries) {
      const childRel = `${relPath}/${entry.name}`;
      if (entry.type === 'directory') await visit(childRel);
      else {
        gateway.assertArchivable(root, childRel, entry);
        addFile(childRel, entry.size);
      }
    }
  };
  for (const p of selection) await visit(p);
  return files;
}

stacksRouter.post('/:stackName/files/bulk-delete', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
  const parsed = parseBulkPaths((req.body as { paths?: unknown }).paths, res);
  if (!parsed) return;
  const root = await resolveRootForOp(req, res, stackName, 'write');
  if (!root) return;
  const normalized = normalizeBulkPaths(parsed, rootCaseSensitive(root));
  const gateway = FileRootGateway.getInstance(req.nodeId);
  const deleted: string[] = [];
  const failed: { path: string; error: string }[] = [];
  for (const relPath of normalized) {
    const startedAt = Date.now();
    try {
      await gateway.deletePath(root, stackName, relPath, true);
      deleted.push(relPath);
      recordFileOp(req.nodeId, 'delete', startedAt, true);
    } catch (err: unknown) {
      failed.push({ path: relPath, error: bulkItemError(err) });
      recordFileOp(req.nodeId, 'delete', startedAt, false);
    }
  }
  // Partial-success: invalidate the roots cache if anything actually changed.
  if (deleted.length > 0) afterStackMutation(req, stackName);
  logFileOperation('info', 'mutate', { nodeId: req.nodeId, op: 'bulkDelete', stack: stackName, deleted: deleted.length, failed: failed.length, rootKind: root.kind, backend: root.backend });
  return res.json({ deleted, failed });
});

stacksRouter.post('/:stackName/files/bulk-move', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
  const body = req.body as { from?: unknown; toDir?: unknown };
  const parsed = parseBulkPaths(body.from, res);
  if (!parsed) return;
  if (typeof body.toDir !== 'string') {
    return res.status(400).json({ error: '"toDir" must be a string (use "" for the root)' });
  }
  const toDir = body.toDir;
  if (toDir !== '' && !isValidRelativeStackPath(toDir)) {
    return res.status(400).json({ error: 'Invalid destination', code: 'INVALID_PATH' satisfies FsErrorCode });
  }
  const root = await resolveRootForOp(req, res, stackName, 'write');
  if (!root) return;
  const caseSensitive = rootCaseSensitive(root);
  const normalized = normalizeBulkPaths(parsed, caseSensitive);
  // Reject the whole request if the destination is one of the moved folders or
  // sits inside one (which would move a folder into its own subtree).
  if (destWithinAnySource(toDir, normalized, caseSensitive)) {
    return res.status(400).json({ error: 'Cannot move the selection into itself', code: 'INVALID_PATH' satisfies FsErrorCode });
  }
  const gateway = FileRootGateway.getInstance(req.nodeId);
  const moved: string[] = [];
  const failed: { path: string; error: string }[] = [];
  for (const fromRel of normalized) {
    const startedAt = Date.now();
    const name = fromRel.split('/').pop() as string;
    const toRel = toDir ? `${toDir}/${name}` : name;
    try {
      await gateway.rename(root, stackName, fromRel, toRel);
      moved.push(fromRel);
      recordFileOp(req.nodeId, 'rename', startedAt, true);
    } catch (err: unknown) {
      failed.push({ path: fromRel, error: bulkItemError(err) });
      recordFileOp(req.nodeId, 'rename', startedAt, false);
    }
  }
  if (moved.length > 0) afterStackMutation(req, stackName);
  logFileOperation('info', 'mutate', { nodeId: req.nodeId, op: 'bulkMove', stack: stackName, moved: moved.length, failed: failed.length, rootKind: root.kind, backend: root.backend });
  return res.json({ moved, failed });
});

stacksRouter.get('/:stackName/files/bulk-download', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:read', 'stack', stackName)) return;
  const raw = req.query.path;
  const list = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
  const parsed = parseBulkPaths(list, res);
  if (!parsed) return;
  const root = await resolveRootForOp(req, res, stackName, 'read');
  if (!root) return;
  const gateway = FileRootGateway.getInstance(req.nodeId);
  const normalized = normalizeBulkPaths(parsed, rootCaseSensitive(root));
  const startedAt = Date.now();

  // Prewalk + cap enforcement BEFORE any response header is sent, so a too-large
  // selection fails as a clean 413 rather than a truncated archive.
  let files: string[];
  try {
    files = await enumerateArchiveFiles(gateway, root, stackName, normalized);
  } catch (err: unknown) {
    recordFileOp(req.nodeId, 'download', startedAt, false);
    const code = (err as { code?: string }).code;
    if (code === 'ARCHIVE_TOO_LARGE') {
      return res.status(413).json({ error: (err as Error).message, code: 'TOO_LARGE' });
    }
    if (code === 'ARCHIVE_UNSUPPORTED') {
      return res.status(400).json({ error: (err as Error).message, code: 'UNSUPPORTED' });
    }
    return sendFsError(res, err, 'Failed to prepare download');
  }
  if (files.length === 0) {
    recordFileOp(req.nodeId, 'download', startedAt, false);
    return res.status(404).json({ error: 'Nothing to download', code: 'NOT_FOUND' satisfies FsErrorCode });
  }

  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${stackName}-files.tar.gz"`);
  const pack = tar.pack();
  const gzip = zlib.createGzip();
  const onStreamError = (err: Error): void => {
    logFileOperation('warn', 'bulk download stream error', { nodeId: req.nodeId, stack: stackName, errorCode: fsErrorCode(err) });
    if (!res.writableEnded) res.destroy();
  };
  pack.on('error', onStreamError);
  gzip.on('error', onStreamError);
  // If the client aborts mid-download, stop fetching the remaining files (each
  // helper-volume read is a container exec) instead of streaming into a dead pipe.
  let aborted = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      aborted = true;
      pack.destroy();
    }
  });
  pack.pipe(gzip).pipe(res);

  try {
    for (const relPath of files) {
      if (aborted) break;
      const dl = await gateway.download(root, stackName, relPath);
      if (dl.kind === 'buffer') {
        await new Promise<void>((resolve, reject) => {
          pack.entry({ name: relPath }, dl.buffer, (err) => (err ? reject(err) : resolve()));
        });
      } else {
        await new Promise<void>((resolve, reject) => {
          const entry = pack.entry({ name: relPath, size: dl.size }, (err) => (err ? reject(err) : resolve()));
          dl.stream.on('error', reject);
          entry.on('error', reject);
          dl.stream.pipe(entry);
        });
      }
    }
    pack.finalize();
    recordFileOp(req.nodeId, 'download', startedAt, true);
  } catch (err: unknown) {
    // Headers are already sent, so surface the failure by tearing the stream
    // down rather than trying to change the status.
    logFileOperation('warn', 'bulk download failed mid-stream', { nodeId: req.nodeId, stack: stackName, errorCode: fsErrorCode(err) });
    recordFileOp(req.nodeId, 'download', startedAt, false);
    pack.destroy();
    if (!res.writableEnded) res.destroy();
  }
});

stacksRouter.get('/:stackName/files/permissions', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:read', 'stack', stackName)) return;
  const relPath = getRelPath(req);
  if (!relPath) return res.status(400).json({ error: 'path query parameter is required', code: 'INVALID_PATH' });
  if (!isValidRelativeStackPath(relPath)) {
    return res.status(400).json({ error: 'Invalid path', code: 'INVALID_PATH' });
  }
  const root = await resolveRootForOp(req, res, stackName, 'read');
  if (!root) return;
  const startedAt = Date.now();
  logFileDiag('permissions read start', { stackName, relPath, nodeId: req.nodeId, rootKind: root.kind });
  try {
    const result = await FileRootGateway.getInstance(req.nodeId).getMode(root, stackName, relPath);
    logFileDiag('permissions read complete', { stackName, relPath, nodeId: req.nodeId, mode: result.octal, elapsedMs: Date.now() - startedAt });
    recordFileOp(req.nodeId, 'permissionsRead', startedAt, true);
    return res.json(result);
  } catch (err: unknown) {
    logFileOperation('warn', 'permissions read failed', { nodeId: req.nodeId, errorCode: fsErrorCode(err) });
    recordFileOp(req.nodeId, 'permissionsRead', startedAt, false);
    return sendFsError(res, err, 'Failed to read permissions');
  }
});

stacksRouter.put('/:stackName/files/permissions', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
  const relPath = getRelPath(req);
  if (!relPath) return res.status(400).json({ error: 'path query parameter is required', code: 'INVALID_PATH' });
  if (!isValidRelativeStackPath(relPath)) {
    return res.status(400).json({ error: 'Invalid path', code: 'INVALID_PATH' });
  }
  const { mode } = req.body as { mode?: unknown };
  if (typeof mode !== 'number') {
    return res.status(400).json({ error: '"mode" must be a number' });
  }
  const root = await resolveRootForOp(req, res, stackName, 'write');
  if (!root) return;
  const startedAt = Date.now();
  logFileDiag('chmod start', { stackName, relPath, nodeId: req.nodeId, mode, rootKind: root.kind });
  try {
    await FileRootGateway.getInstance(req.nodeId).chmod(root, stackName, relPath, mode);
    afterStackMutation(req, stackName);
    logFileOperation('info', 'mutate', {
      nodeId: req.nodeId,
      op: 'chmod',
      stack: stackName,
      path: relPath,
      mode: mode.toString(8).padStart(3, '0'),
      rootKind: root.kind,
      backend: root.backend,
    });
    logFileDiag('chmod timing', { stackName, relPath, nodeId: req.nodeId, elapsedMs: Date.now() - startedAt });
    recordFileOp(req.nodeId, 'chmod', startedAt, true);
    return res.status(204).send();
  } catch (err: unknown) {
    logFileOperation('warn', 'chmod failed', {
      nodeId: req.nodeId,
      op: 'chmod',
      stack: stackName,
      path: relPath,
      mode: mode.toString(8).padStart(3, '0'),
      errorCode: fsErrorCode(err),
    });
    recordFileOp(req.nodeId, 'chmod', startedAt, false);
    return sendFsError(res, err, 'Failed to set permissions');
  }
});

