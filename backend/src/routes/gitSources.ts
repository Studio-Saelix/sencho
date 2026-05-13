import { Router, type Request, type Response } from 'express';
import path from 'path';
import { GitSourceService } from '../services/GitSourceService';
import { FileSystemService } from '../services/FileSystemService';
import { checkPermission, requirePermission } from '../middleware/permissions';
import { invalidateNodeCaches } from '../helpers/cacheInvalidation';
import { triggerPostDeployScan } from '../helpers/policyGate';
import { isValidGitSourcePath, isValidStackName } from '../utils/validation';
import { sendGitSourceError } from '../utils/gitSourceHttp';
import { sanitizeForLog } from '../utils/safeLog';

// Reasonable upper bounds so a caller cannot flood the service with huge
// payloads. Generous compared to anything a real Git provider emits.
const MAX_REPO_URL_LENGTH = 2048;
const MAX_BRANCH_LENGTH = 256;
const MAX_COMPOSE_PATH_LENGTH = 1024;
const MAX_ENV_PATH_LENGTH = 1024;
const MAX_TOKEN_LENGTH = 8192;

/** Router for listing git-source configuration: `GET /api/git-sources`. */
export const gitSourcesRouter = Router();

gitSourcesRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const all = GitSourceService.getInstance().list();
    // Filter to the subset of stacks the caller can read. Keeps scoped
    // Admiral roles from discovering git config for stacks outside their grant.
    const visible = all.filter(src => checkPermission(req, 'stack:read', 'stack', src.stack_name));
    res.json(visible);
  } catch (error) {
    sendGitSourceError(res, error);
  }
});

/**
 * Router for per-stack git-source endpoints. Mount at `/api/stacks` so the
 * `/:stackName/git-source*` paths work alongside other stack-scoped routes
 * (such as the label-assignments router extracted in Phase 4A-1).
 */
export const stackGitSourceRouter = Router();

stackGitSourceRouter.get('/:stackName/git-source', async (req: Request, res: Response): Promise<void> => {
  const stackName = req.params.stackName as string;
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return;
  }
  if (!requirePermission(req, res, 'stack:read', 'stack', stackName)) return;
  try {
    const source = GitSourceService.getInstance().get(stackName);
    if (!source) {
      res.status(404).json({ error: 'No Git source configured for this stack' });
      return;
    }
    res.json(source);
  } catch (error) {
    sendGitSourceError(res, error);
  }
});

stackGitSourceRouter.put('/:stackName/git-source', async (req: Request, res: Response): Promise<void> => {
  const stackName = req.params.stackName as string;
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return;
  }
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
  try {
    const {
      repo_url,
      branch,
      compose_path,
      sync_env,
      env_path,
      auth_type,
      token,
      auto_apply_on_webhook,
      auto_deploy_on_apply,
    } = req.body ?? {};

    if (typeof repo_url !== 'string' || !repo_url.trim()) {
      res.status(400).json({ error: 'repo_url is required' });
      return;
    }
    if (typeof branch !== 'string' || !branch.trim()) {
      res.status(400).json({ error: 'branch is required' });
      return;
    }
    if (typeof compose_path !== 'string' || !compose_path.trim()) {
      res.status(400).json({ error: 'compose_path is required' });
      return;
    }
    if (auth_type !== 'none' && auth_type !== 'token') {
      res.status(400).json({ error: 'auth_type must be "none" or "token"' });
      return;
    }
    if (auto_apply_on_webhook !== undefined && typeof auto_apply_on_webhook !== 'boolean') {
      res.status(400).json({ error: 'auto_apply_on_webhook must be a boolean' });
      return;
    }
    if (auto_deploy_on_apply !== undefined && typeof auto_deploy_on_apply !== 'boolean') {
      res.status(400).json({ error: 'auto_deploy_on_apply must be a boolean' });
      return;
    }
    if (!/^https:\/\//i.test(repo_url)) {
      res.status(400).json({ error: 'Only HTTPS repository URLs are supported' });
      return;
    }
    if (repo_url.length > MAX_REPO_URL_LENGTH) {
      res.status(400).json({ error: 'repo_url is too long' });
      return;
    }
    if (branch.length > MAX_BRANCH_LENGTH) {
      res.status(400).json({ error: 'branch is too long' });
      return;
    }
    if (compose_path.length > MAX_COMPOSE_PATH_LENGTH) {
      res.status(400).json({ error: 'compose_path is too long' });
      return;
    }
    if (typeof env_path === 'string' && env_path.length > MAX_ENV_PATH_LENGTH) {
      res.status(400).json({ error: 'env_path is too long' });
      return;
    }
    if (!isValidGitSourcePath(compose_path.trim())) {
      res.status(400).json({ error: 'compose_path must be a relative repository file path' });
      return;
    }
    if (typeof env_path === 'string' && env_path.trim() && !isValidGitSourcePath(env_path.trim())) {
      res.status(400).json({ error: 'env_path must be a relative repository file path' });
      return;
    }
    if (typeof token === 'string' && token.length > MAX_TOKEN_LENGTH) {
      res.status(400).json({ error: 'token is too long' });
      return;
    }
    const autoApplyOnWebhook = auto_apply_on_webhook === true;
    const autoDeployOnApply = auto_deploy_on_apply === true;
    if (autoDeployOnApply && !requirePermission(req, res, 'stack:deploy', 'stack', stackName)) return;

    // Confirm the stack actually exists on the active node. Without this guard
    // a caller could stash a git-source row for a name that does not exist
    // yet and have it auto-link when a stack with that name is later created.
    const stacks = await FileSystemService.getInstance(req.nodeId).getStacks();
    if (!stacks.includes(stackName)) {
      res.status(404).json({ error: 'Stack not found' });
      return;
    }

    const syncEnv = Boolean(sync_env);
    const resolvedEnvPath = syncEnv
      ? (typeof env_path === 'string' && env_path.trim()
        ? env_path
        : path.posix.join(path.posix.dirname(compose_path.replace(/\\/g, '/')) || '.', '.env'))
      : null;

    const source = await GitSourceService.getInstance().upsert({
      stackName,
      repoUrl: repo_url.trim(),
      branch: branch.trim(),
      composePath: compose_path.trim(),
      syncEnv,
      envPath: resolvedEnvPath,
      authType: auth_type,
      token: typeof token === 'string' ? token : undefined,
      autoApplyOnWebhook,
      autoDeployOnApply,
    });

    console.log(`[GitSource] Configured git source for ${stackName}`);
    res.json(source);
  } catch (error) {
    sendGitSourceError(res, error);
  }
});

stackGitSourceRouter.delete('/:stackName/git-source', async (req: Request, res: Response): Promise<void> => {
  const stackName = req.params.stackName as string;
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return;
  }
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
  try {
    GitSourceService.getInstance().delete(stackName);
    console.log(`[GitSource] Removed git source for ${stackName}`);
    res.json({ success: true });
  } catch (error) {
    sendGitSourceError(res, error);
  }
});

stackGitSourceRouter.post('/:stackName/git-source/pull', async (req: Request, res: Response): Promise<void> => {
  const stackName = req.params.stackName as string;
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return;
  }
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
  try {
    const result = await GitSourceService.getInstance().pull(stackName);
    res.json(result);
  } catch (error) {
    sendGitSourceError(res, error);
  }
});

stackGitSourceRouter.post('/:stackName/git-source/apply', async (req: Request, res: Response): Promise<void> => {
  const stackName = req.params.stackName as string;
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return;
  }
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
  try {
    const { commitSha, deploy } = req.body ?? {};
    if (typeof commitSha !== 'string' || !commitSha.trim()) {
      res.status(400).json({ error: 'commitSha is required' });
      return;
    }
    if (deploy === true && !requirePermission(req, res, 'stack:deploy', 'stack', stackName)) return;
    const result = await GitSourceService.getInstance().apply(
      stackName,
      commitSha.trim(),
      { deploy: typeof deploy === 'boolean' ? deploy : undefined },
    );
    invalidateNodeCaches(req.nodeId);
    const shortSha = commitSha.trim().slice(0, 7);
    if (result.deployed) {
      console.log('[GitSource] Applied commit %s to %s (deployed)', sanitizeForLog(shortSha), sanitizeForLog(stackName));
    } else if (result.deployError) {
      console.warn('[GitSource] Applied commit %s to %s, deploy failed: %s', sanitizeForLog(shortSha), sanitizeForLog(stackName), sanitizeForLog(result.deployError));
    } else {
      console.log('[GitSource] Applied commit %s to %s', sanitizeForLog(shortSha), sanitizeForLog(stackName));
    }
    res.json(result);
    if (result.deployed) {
      triggerPostDeployScan(stackName, req.nodeId).catch(err =>
        console.error(`[Security] Post-deploy scan failed for ${sanitizeForLog(stackName)}:`, err),
      );
    }
  } catch (error) {
    sendGitSourceError(res, error);
  }
});

stackGitSourceRouter.post('/:stackName/git-source/webhook-pull', async (req: Request, res: Response): Promise<void> => {
  const stackName = req.params.stackName as string;
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return;
  }
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
  try {
    const source = GitSourceService.getInstance().get(stackName);
    if (source?.auto_apply_on_webhook && source.auto_deploy_on_apply && !requirePermission(req, res, 'stack:deploy', 'stack', stackName)) return;
    const result = await GitSourceService.getInstance().handleWebhookPull(stackName);
    res.json(result);
  } catch (error) {
    sendGitSourceError(res, error);
  }
});

stackGitSourceRouter.post('/:stackName/git-source/dismiss-pending', async (req: Request, res: Response): Promise<void> => {
  const stackName = req.params.stackName as string;
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return;
  }
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
  try {
    GitSourceService.getInstance().dismissPending(stackName);
    res.json({ success: true });
  } catch (error) {
    sendGitSourceError(res, error);
  }
});
