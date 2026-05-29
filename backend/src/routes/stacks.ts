import { Router, type Request, type Response, type NextFunction } from 'express';
import path from 'path';
import YAML from 'yaml';
import multer from 'multer';
import { FileSystemService } from '../services/FileSystemService';
import { ComposeService, getComposeRollbackInfo } from '../services/ComposeService';
import DockerController from '../services/DockerController';
import { DatabaseService } from '../services/DatabaseService';
import { MeshService } from '../services/MeshService';
import { CacheService } from '../services/CacheService';
import { UpdatePreviewService } from '../services/UpdatePreviewService';
import { GitSourceService, GitSourceError, repoHost as gitRepoHost } from '../services/GitSourceService';
import { enforcePolicyPreDeploy } from '../services/PolicyEnforcement';
import { requirePermission, checkPermission } from '../middleware/permissions';
import { requirePaid, effectiveTier } from '../middleware/tierGates';
import { NotificationService, type NotificationCategory } from '../services/NotificationService';
import { StackOpLockService, type StackOpAction } from '../services/StackOpLockService';
import { StackOpMetricsService, type StackOpAction as StackMetricAction } from '../services/StackOpMetricsService';
import { FileExplorerMetricsService, type FileExplorerOp } from '../services/FileExplorerMetricsService';
import { isValidGitSourcePath, isValidStackName, isValidServiceName, isPathWithinBase, isValidRelativeStackPath } from '../utils/validation';
import { getErrorMessage } from '../utils/errors';
import { isDebugEnabled } from '../utils/debug';
import { sanitizeForLog } from '../utils/safeLog';
import { sendGitSourceError } from '../utils/gitSourceHttp';
import { buildPolicyGateOptions, runPolicyGate, triggerPostDeployScan } from '../helpers/policyGate';
import { invalidateNodeCaches } from '../helpers/cacheInvalidation';
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

export async function resolveAllEnvFilePaths(nodeId: number, stackName: string): Promise<string[]> {
  const fsService = FileSystemService.getInstance(nodeId);
  const stackDir = path.join(fsService.getBaseDir(), stackName);
  const defaultEnvPath = path.join(stackDir, '.env');

  try {
    const composeFiles = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
    let composeContent: string | null = null;

    for (const file of composeFiles) {
      try {
        composeContent = await fsService.readFile(path.join(stackDir, file), 'utf-8');
        break;
      } catch {
        // Try next file
      }
    }

    if (!composeContent) return [defaultEnvPath];

    if (composeContent.length > MAX_COMPOSE_PARSE_BYTES) {
      console.warn(`[Stacks] Compose for ${sanitizeForLog(stackName)} exceeds ${MAX_COMPOSE_PARSE_BYTES} bytes; skipping env_file resolution`);
      return [defaultEnvPath];
    }

    const parsed = YAML.parse(composeContent);
    if (!parsed?.services) return [defaultEnvPath];

    const envFiles = new Set<string>();

    for (const serviceName of Object.keys(parsed.services)) {
      const service = parsed.services[serviceName];
      if (!service?.env_file) continue;

      const addEnvPath = (rawPath: string) => {
        const resolved = path.resolve(stackDir, rawPath);
        if (!isPathWithinBase(resolved, stackDir)) return;
        envFiles.add(resolved);
      };

      if (typeof service.env_file === 'string') {
        addEnvPath(service.env_file);
      } else if (Array.isArray(service.env_file)) {
        for (const entry of service.env_file) {
          const entryPath = typeof entry === 'string' ? entry : (entry?.path || '');
          if (entryPath) addEnvPath(entryPath);
        }
      }
    }

    if (envFiles.size === 0) {
      envFiles.add(defaultEnvPath);
    }

    const existing: string[] = [];
    for (const f of envFiles) {
      try {
        await fsService.access(f);
        existing.push(f);
      } catch {
        // File does not exist, skip
      }
    }
    return existing;
  } catch (error) {
    console.warn('Could not parse compose.yaml for env_file resolution in stack "%s":', sanitizeForLog(stackName), error);
  }

  try {
    await fsService.access(defaultEnvPath);
    return [defaultEnvPath];
  } catch {
    return [];
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  preservePath: true,
});

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

type BulkLifecycleAction = 'start' | 'stop' | 'restart' | 'update';
const VALID_BULK_ACTIONS: ReadonlySet<BulkLifecycleAction> = new Set(['start', 'stop', 'restart', 'update']);
const BULK_PARALLELISM = 4;
const BULK_MAX_STACKS = 100;

interface BulkResultItem {
  stackName: string;
  ok: boolean;
  error?: string;
  code?: string;
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
      const atomic = effectiveTier(req) === 'paid';
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

  // Bulk update is paid-only by deliberate asymmetry with the single-stack
  // POST /:stackName/update, which is open to all tiers (atomic backup is
  // separately gated by effectiveTier inside the route). The bulk fan-out
  // amplifies blast radius enough that we want a hard tier check here even
  // though the per-stack route does not.
  if (action === 'update' && !requirePaid(req, res)) return;

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
    const envFileName = path.basename(envPath);
    dlog(`[Stacks] Env file saved: ${sanitizeForLog(stackName)}/${sanitizeForLog(envFileName)}`);
    res.setHeader('ETag', stackFileEtag(result.mtimeMs));
    res.json({ message: 'Env file saved successfully', mtimeMs: result.mtimeMs });
  } catch (error) {
    console.error('[Stacks] Failed to save env file:', error);
    res.status(500).json({ error: 'Failed to save env file' });
  }
});

stacksRouter.post('/', async (req: Request, res: Response) => {
  if (!requirePermission(req, res, 'stack:create')) return;
  try {
    const { stackName } = req.body;
    if (!stackName || typeof stackName !== 'string') {
      return res.status(400).json({ error: 'Stack name is required and must be a string' });
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
      compose_path,
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
    if (typeof compose_path !== 'string' || !compose_path.trim()) {
      return res.status(400).json({ error: 'compose_path is required' });
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
    if (compose_path.length > 1024) {
      return res.status(400).json({ error: 'compose_path is too long' });
    }
    if (typeof env_path === 'string' && env_path.length > 1024) {
      return res.status(400).json({ error: 'env_path is too long' });
    }
    if (typeof token === 'string' && token.length > 8192) {
      return res.status(400).json({ error: 'token is too long' });
    }
    if (!isValidGitSourcePath(compose_path.trim())) {
      return res.status(400).json({ error: 'compose_path must be a relative repository file path' });
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
      ? (typeof env_path === 'string' && env_path.trim()
        ? env_path
        : path.posix.join(path.posix.dirname(compose_path.replace(/\\/g, '/')) || '.', '.env'))
      : null;

    if (fromGitDiag) {
      dlog(
        `[Stacks:diag] from-git start stack=${sanitizeForLog(stack_name)} nodeId=${req.nodeId ?? 'local'} host=${sanitizeForLog(gitRepoHost(repo_url))} branch=${sanitizeForLog(branch)} composePath=${sanitizeForLog(compose_path)} envPath=${sanitizeForLog(resolvedEnvPath ?? 'none')} authType=${sanitizeForLog(resolvedAuthType)} autoApplyOnWebhook=${autoApplyOnWebhook} autoDeployOnApply=${autoDeployOnApply} deployNow=${deploy_now === true}`
      );
    }

    const result = await GitSourceService.getInstance().createStackFromGit({
      stackName: stack_name.trim(),
      repoUrl: repo_url.trim(),
      branch: branch.trim(),
      composePath: compose_path.trim(),
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
    const atomic = effectiveTier(req) === 'paid';
    if (debug) console.debug('[Stacks:debug] Deploy starting', { stackName, atomic, nodeId: req.nodeId });
    await ComposeService.getInstance(req.nodeId).deployStack(stackName, getTerminalWs(req.get(DEPLOY_SESSION_HEADER)), atomic);
    invalidateNodeCaches(req.nodeId);
    dlog(`[Stacks] Deploy completed: ${sanitizeForLog(stackName)}`);
    if (debug) console.debug(`[Stacks:debug] Deploy finished in ${Date.now() - t0}ms`);
    ok = true;
    res.json({ message: 'Deployed successfully' });
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
    notifyActionFailure('deploy', stackName, error, req.user?.username ?? 'system');
    if (!res.headersSent) {
      if (isDockerUnavailableError(error)) {
        res.status(503).json({ error: message, code: 'docker_unavailable', rolledBack });
      } else {
        res.status(500).json({ error: message, rolledBack });
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
    const atomic = effectiveTier(req) === 'paid';
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
    res.json({ status: 'Update completed' });
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
      if (isDockerUnavailableError(error)) {
        res.status(503).json({ error: getErrorMessage(error, 'Docker daemon is unreachable'), code: 'docker_unavailable', rolledBack });
      } else {
        res.status(500).json({ error: getErrorMessage(error, 'Failed to update'), rolledBack });
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
  if (!requirePaid(req, res)) return;
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
    await fsSvc.restoreStackFiles(stackName);
    if (!(await runPolicyGate(req, res, stackName, req.nodeId))) return;
    await ComposeService.getInstance(req.nodeId).deployStack(stackName, getTerminalWs(req.get(DEPLOY_SESSION_HEADER)), false);
    invalidateNodeCaches(req.nodeId);
    dlog(`[Stacks] Rollback completed: ${sanitizeForLog(stackName)}`);
    res.json({ message: 'Stack rolled back successfully.' });
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
  // Backup metadata exists only to drive the paid-only Rollback affordance, so
  // the read is gated to paid to match the frontend, which only fetches it when
  // the instance is licensed.
  if (!requirePaid(req, res)) return;
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
  | 'IS_DIRECTORY'
  | 'NOT_EMPTY'
  | 'NOT_FOUND'
  | 'TOO_LARGE'
  | 'ALREADY_EXISTS'
  | 'FILE_EXISTS'
  | 'DIR_EXISTS'
  | 'PROTECTED_FILE'
  | 'LINK_CHMOD_UNSUPPORTED';

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
  if (e.code === 'ENOTDIR') {
    return res.status(400).json({ error: 'Target path is not a directory', code: 'INVALID_PATH' satisfies FsErrorCode });
  }
  if (e.code === 'ENOENT') {
    return res.status(404).json({ error: opts.notFoundMessage ?? 'File not found', code: 'NOT_FOUND' });
  }
  console.error(`[files] ${fallback}:`, sanitizeForLog(e.message));
  return res.status(500).json({ error: fallback });
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

stacksRouter.get('/:stackName/files', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:read', 'stack', stackName)) return;
  const relPath = getRelPath(req);
  if (relPath !== '' && !isValidRelativeStackPath(relPath)) {
    return res.status(400).json({ error: 'Invalid path', code: 'INVALID_PATH' });
  }
  const startedAt = Date.now();
  logFileDiag('list start', { stackName, relPath, nodeId: req.nodeId });
  try {
    const result = await FileSystemService.getInstance(req.nodeId).listStackDirectoryPage(stackName, relPath, { limit: DIR_LIST_LIMIT });
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
  const startedAt = Date.now();
  logFileDiag('read start', { stackName, relPath, nodeId: req.nodeId, forceText });
  try {
    const result = await FileSystemService.getInstance(req.nodeId).readStackFile(stackName, relPath, undefined, { forceText });
    // ETag is the integer mtimeMs the file was stat'd with, so the matching
    // PUT can compare millisecond-equal even though some filesystems return
    // float mtimeMs.
    res.setHeader('ETag', stackFileEtag(result.mtimeMs));
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
  const startedAt = Date.now();
  logFileDiag('download start', { stackName, relPath, nodeId: req.nodeId });
  try {
    const result = await FileSystemService.getInstance(req.nodeId).streamStackFile(stackName, relPath);
    res.setHeader('Content-Type', result.mime);
    res.setHeader('Content-Length', result.size);
    const encodedFilename = encodeURIComponent(result.filename);
    const safeFilename = result.filename.replace(/[\\"]/g, '');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`);
    // Track normal download completion off the file stream's lifecycle, not
    // the request lifecycle. Under the in-process supertest transport, request
    // close events can race ahead of normal stream completion; response close
    // is handled below only as delayed abort cleanup.
    // End/error are the durable completion signals, and close can still count
    // as success only when the stream reports it read the full file.
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
      if (downloadRecorded || hasReadFullFile()) return;
      // At this point, response close is treated as an abort signal. It can
      // beat the source stream's final events in the in-process test transport.
      // Give a same-turn clean source completion a chance to win before cleanup.
      abortCleanupHandle = setImmediate(() => {
        abortCleanupHandle = null;
        if (downloadRecorded || hasReadFullFile()) return;
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

type UploadStartedReq = Request & { _fileUploadStartedAt?: number };

stacksRouter.post(
  '/:stackName/files/upload',
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
        return res.status(413).json({ error: 'File exceeds 25 MB limit', code: 'TOO_LARGE' });
      }
      if (err) {
        logFileOperation('warn', 'upload failed', {
          nodeId: req.nodeId,
          op: 'upload',
          stack: req.params.stackName,
          errorCode: 'MULTER_ERROR',
        });
        recordFileOp(req.nodeId, 'upload', startedAt, false);
        return res.status(500).json({ error: 'Upload failed' });
      }
      next();
    });
  },
  async (req: Request, res: Response) => {
    const stackName = req.params.stackName as string;
    if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }
    const relPath = getRelPath(req);
    if (relPath !== '' && !isValidRelativeStackPath(relPath)) {
      return res.status(400).json({ error: 'Invalid path', code: 'INVALID_PATH' });
    }
    const originalName = req.file.originalname;
    if (!isSafeUploadFilename(originalName)) {
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
      const existing = await FileSystemService.getInstance(req.nodeId).pathKind(stackName, targetRelPath);
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
      await FileSystemService.getInstance(req.nodeId).writeStackFileBuffer(stackName, targetRelPath, req.file.buffer);
      logFileOperation('info', 'mutate', {
        nodeId: req.nodeId,
        op: 'upload',
        stack: stackName,
        path: targetRelPath,
        bytes: req.file.size,
        overwrite,
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
  const expectedMtimeMs = parseIfMatchMtime(req.header('if-match'));
  const startedAt = Date.now();
  logFileDiag('write start', { stackName, relPath, nodeId: req.nodeId, bytes: Buffer.byteLength(content, 'utf-8'), hasIfMatch: expectedMtimeMs !== null });
  try {
    const result = await FileSystemService.getInstance(req.nodeId).writeStackFileIfUnchanged(
      stackName,
      relPath,
      content,
      expectedMtimeMs,
    );
    if (!result.ok) {
      // Stale ETag: surface the current content + mtime so the client can
      // show a "file changed elsewhere" diff and let the user reconcile.
      // Real FS work ran (the if-unchanged stat compare); record the
      // attempted-and-rejected write so operators chasing concurrent-edit
      // patterns can see them in the snapshot.
      res.setHeader('ETag', stackFileEtag(result.currentMtimeMs));
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
        },
      });
    }
    res.setHeader('ETag', stackFileEtag(result.mtimeMs));
    logFileOperation('info', 'mutate', {
      nodeId: req.nodeId,
      op: 'write',
      stack: stackName,
      path: relPath,
      bytes: Buffer.byteLength(content, 'utf-8'),
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
  const startedAt = Date.now();
  logFileDiag('delete start', { stackName, relPath, recursive, nodeId: req.nodeId });
  try {
    await FileSystemService.getInstance(req.nodeId).deleteStackPath(stackName, relPath, recursive);
    logFileOperation('info', 'mutate', {
      nodeId: req.nodeId,
      op: 'delete',
      stack: stackName,
      path: relPath,
      recursive,
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
  const startedAt = Date.now();
  logFileDiag('mkdir start', { stackName, relPath, nodeId: req.nodeId });
  try {
    await FileSystemService.getInstance(req.nodeId).mkdirStackPath(stackName, relPath);
    logFileOperation('info', 'mutate', {
      nodeId: req.nodeId,
      op: 'mkdir',
      stack: stackName,
      path: relPath,
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
  const startedAt = Date.now();
  logFileDiag('rename start', { stackName, from, to, nodeId: req.nodeId });
  try {
    await FileSystemService.getInstance(req.nodeId).renameStackPath(stackName, from, to);
    logFileOperation('info', 'mutate', {
      nodeId: req.nodeId,
      op: 'rename',
      stack: stackName,
      path: from,
      toPath: to,
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

stacksRouter.get('/:stackName/files/permissions', async (req: Request, res: Response) => {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:read', 'stack', stackName)) return;
  const relPath = getRelPath(req);
  if (!relPath) return res.status(400).json({ error: 'path query parameter is required', code: 'INVALID_PATH' });
  if (!isValidRelativeStackPath(relPath)) {
    return res.status(400).json({ error: 'Invalid path', code: 'INVALID_PATH' });
  }
  const startedAt = Date.now();
  logFileDiag('permissions read start', { stackName, relPath, nodeId: req.nodeId });
  try {
    const result = await FileSystemService.getInstance(req.nodeId).getStackEntryMode(stackName, relPath);
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
  const startedAt = Date.now();
  logFileDiag('chmod start', { stackName, relPath, nodeId: req.nodeId, mode });
  try {
    await FileSystemService.getInstance(req.nodeId).chmodStackPath(stackName, relPath, mode);
    logFileOperation('info', 'mutate', {
      nodeId: req.nodeId,
      op: 'chmod',
      stack: stackName,
      path: relPath,
      mode: mode.toString(8).padStart(3, '0'),
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

