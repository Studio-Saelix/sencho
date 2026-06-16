import { Router, type Request, type Response } from 'express';
import { GitSourceService } from '../services/GitSourceService';
import { FileSystemService } from '../services/FileSystemService';
import { DatabaseService } from '../services/DatabaseService';
import { CryptoService } from '../services/CryptoService';
import { checkPermission, requirePermission } from '../middleware/permissions';
import { invalidateNodeCaches } from '../helpers/cacheInvalidation';
import { triggerPostDeployScan } from '../helpers/policyGate';
import { parseComposeSelection, defaultEnvPath } from '../helpers/gitSourceSelection';
import { isValidGitSourcePath, isValidStackName } from '../utils/validation';
import { sendGitSourceError, webhookPullStatus } from '../utils/gitSourceHttp';
import { sanitizeForLog } from '../utils/safeLog';

// Reasonable upper bounds so a caller cannot flood the service with huge
// payloads. Generous compared to anything a real Git provider emits.
const MAX_REPO_URL_LENGTH = 2048;
const MAX_BRANCH_LENGTH = 256;
const MAX_ENV_PATH_LENGTH = 1024;
const MAX_TOKEN_LENGTH = 8192;

/**
 * Shared handler for the "browse repository" compose-file picker: validate the
 * repo target, clone it, and list its files. `storedToken` (already decrypted)
 * is reused when the request omits a token, so the edit-mode flow does not force
 * re-entering a stored PAT.
 */
async function handleBrowse(req: Request, res: Response, storedToken: string | null): Promise<void> {
  const { repo_url, branch, auth_type, token } = req.body ?? {};
  if (typeof repo_url !== 'string' || !repo_url.trim()) {
    res.status(400).json({ error: 'repo_url is required' });
    return;
  }
  if (typeof branch !== 'string' || !branch.trim()) {
    res.status(400).json({ error: 'branch is required' });
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
  if (auth_type !== undefined && auth_type !== 'none' && auth_type !== 'token') {
    res.status(400).json({ error: 'auth_type must be "none" or "token"' });
    return;
  }
  if (typeof token === 'string' && token.length > MAX_TOKEN_LENGTH) {
    res.status(400).json({ error: 'token is too long' });
    return;
  }
  const explicitToken = typeof token === 'string' && token.trim() ? token : null;
  const effectiveToken = auth_type === 'none' ? null : (explicitToken ?? storedToken);
  try {
    const result = await GitSourceService.getInstance().listRepoTree({
      repoUrl: repo_url.trim(),
      branch: branch.trim(),
      token: effectiveToken,
    });
    res.json(result);
  } catch (error) {
    sendGitSourceError(res, error);
  }
}

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

// Create-mode repo browse (no stack yet): gated by the same permission as
// creating a stack from Git.
gitSourcesRouter.post('/browse', async (req: Request, res: Response): Promise<void> => {
  if (!requirePermission(req, res, 'stack:create')) return;
  await handleBrowse(req, res, null);
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
    if (source) {
      res.json(source);
      return;
    }
    // No source row. A non-existent stack is a genuine 404, but an existing
    // stack with no Git source attached is a normal, non-error state. The
    // dashboard probes this endpoint for every stack, so returning 404 here
    // would paint a console error for every unlinked stack; answer 200 with
    // a discriminator instead and reserve 404 for the stack-not-found case.
    const stacks = await FileSystemService.getInstance(req.nodeId).getStacks();
    if (!stacks.includes(stackName)) {
      res.status(404).json({ error: 'Stack not found' });
      return;
    }
    res.json({ linked: false });
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
    const selection = parseComposeSelection(req.body);
    if (!selection.ok) {
      res.status(400).json({ error: selection.error });
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
    if (typeof env_path === 'string' && env_path.length > MAX_ENV_PATH_LENGTH) {
      res.status(400).json({ error: 'env_path is too long' });
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
      ? defaultEnvPath(selection.value.composePaths[0], env_path)
      : null;

    const source = await GitSourceService.getInstance().upsert({
      stackName,
      repoUrl: repo_url.trim(),
      branch: branch.trim(),
      composePaths: selection.value.composePaths,
      contextDir: selection.value.contextDir,
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
    const source = DatabaseService.getInstance().getGitSource(stackName);
    const willDeploy = typeof deploy === 'boolean' ? deploy : source?.auto_deploy_on_apply === true;
    if (willDeploy && !requirePermission(req, res, 'stack:deploy', 'stack', stackName)) return;
    const result = await GitSourceService.getInstance().apply(
      stackName,
      commitSha.trim(),
      {
        deploy: typeof deploy === 'boolean' ? deploy : undefined,
        actor: req.user?.username ?? 'unknown',
        bypassPolicy: req.query.ignorePolicy === 'true' && req.user?.role === 'admin',
      },
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
    if (!source) {
      res.status(404).json({ error: 'No Git source configured for this stack', status: 'error' });
      return;
    }
    if (source.auto_apply_on_webhook && source.auto_deploy_on_apply && !requirePermission(req, res, 'stack:deploy', 'stack', stackName)) return;
    const result = await GitSourceService.getInstance().handleWebhookPull(stackName);
    // Map the outcome to a real HTTP status so a Git provider sees a 4xx on
    // failure instead of a 200 with an error body (which it would read as
    // "delivered fine, stop retrying").
    res.status(webhookPullStatus(result.status)).json(result);
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

// Edit-mode repo browse for an existing stack: gated by stack:edit so a user who
// can edit (but not create) stacks can re-pick files, and reuses the stored token
// when the request omits one.
stackGitSourceRouter.post('/:stackName/git-source/browse', async (req: Request, res: Response): Promise<void> => {
  const stackName = req.params.stackName as string;
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return;
  }
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
  const src = DatabaseService.getInstance().getGitSource(stackName);
  const storedToken = src?.encrypted_token ? CryptoService.getInstance().decrypt(src.encrypted_token) : null;
  await handleBrowse(req, res, storedToken);
});
