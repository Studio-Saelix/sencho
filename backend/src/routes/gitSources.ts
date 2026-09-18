import { Router, type Request, type Response } from 'express';
import { GitSourceService, type PublicGitSource, type SourcePolicy } from '../services/GitSourceService';
import type { EncryptedSourcePolicy } from '../services/gitops/sops/types';
import { SopsIdentityStore, getEncryptedSourcePolicy, setEncryptedSourcePolicy } from '../services/gitops/sops/identityStore';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsBindingError, GitOpsBindingService } from '../services/gitops/binding';
import { SourceController } from '../services/gitops/SourceController';
import type { GitOpsRevisionProjection } from '../services/gitops/types';
import { GitProjectManifestService } from '../services/GitProjectManifestService';
import { FileSystemService } from '../services/FileSystemService';
import { DatabaseService } from '../services/DatabaseService';
import { CryptoService } from '../services/CryptoService';
import { checkPermission, requirePermission } from '../middleware/permissions';
import { classifySourceRow, satisfiesGitOpsRead } from '../services/gitops/readAuth';
import { NOT_APPLICABLE_REVISION, projectStackRevision, stackResourceSet } from '../helpers/gitopsResponse';
import { respondWithHistory } from '../helpers/gitopsHistoryPage';
import { invalidateNodeCaches } from '../helpers/cacheInvalidation';
import { parseComposeSelection, defaultEnvPath } from '../helpers/gitSourceSelection';
import { isValidGitSourcePath, isValidStackName } from '../utils/validation';
import { sendGitSourceError, webhookPullStatus } from '../utils/gitSourceHttp';
import { sanitizeForLog } from '../utils/safeLog';
import { parseStorableRepoUrl, repoUrlRejectionMessage } from '../services/gitops/repoIdentity';
import { REF_MAX_LEN } from '../services/git/nativeGitTransport';
import { validateCaBundlePem } from '../services/git/caBundle';
import { auditActorUsername } from '../helpers/auditActor';
import { assertSafeOutboundHostname, resolveSafeOutboundHostname, UnsafeOutboundTargetError } from '../utils/outboundTarget';
import { ProviderWebhookService } from '../services/gitops/providerWebhooks/ProviderWebhookService';
import { GitProviderWebhookStore } from '../services/gitops/providerWebhooks/store';
import type { GitProviderEventScope, GitProviderKind } from '../services/gitops/providerWebhooks/types';

// Reasonable upper bounds so a caller cannot flood the service with huge
// payloads. Generous compared to anything a real Git provider emits.
// The branch bound comes from the transport that ultimately fetches the ref,
// so a branch this route accepts can never be refused later as too long.
const MAX_BRANCH_LENGTH = REF_MAX_LEN;
const MAX_ENV_PATH_LENGTH = 1024;
const MAX_TOKEN_LENGTH = 8192;
const MAX_SUSPEND_REASON_LENGTH = 512;
const MAX_WEBHOOK_DELIVERY_ID_LENGTH = 512;

const VALID_PROVIDER_KINDS: readonly GitProviderKind[] = [
  'github',
  'gitlab',
  'gitea',
  'forgejo',
  'bitbucket_cloud',
];

const VALID_PROVIDER_EVENT_SCOPES: readonly GitProviderEventScope[] = [
  'configured_ref',
  'configured_ref_and_prs',
];

function isGitProviderKind(value: unknown): value is GitProviderKind {
  return typeof value === 'string' && (VALID_PROVIDER_KINDS as readonly string[]).includes(value);
}

function isGitProviderEventScope(value: unknown): value is GitProviderEventScope {
  return typeof value === 'string' && (VALID_PROVIDER_EVENT_SCOPES as readonly string[]).includes(value);
}

function directGitSourceAvailable(stackName: string): boolean {
  const app = GitOpsStore.getInstance().getLiveDirectApplication(stackName);
  return !!app && app.lifecycle_status === 'active';
}

function getProviderHookEndpoint(stackName: string, endpointId: string) {
  const endpoint = GitProviderWebhookStore.getInstance().getEndpoint(endpointId);
  if (!endpoint || endpoint.stack_name !== stackName) return undefined;
  return endpoint;
}

/**
 * Shared handler for the "browse repository" compose-file picker: validate the
 * repo target, clone it, and list its files. `storedToken` (already decrypted)
 * is reused when the request omits a token, so the edit-mode flow does not force
 * re-entering a stored PAT.
 */
const MAX_DEPLOY_KEY_LENGTH = 16384;
const MAX_CA_BUNDLE_LENGTH = 65536;

async function handleBrowse(
  req: Request,
  res: Response,
  storedToken: string | null,
  storedDeployKey: string | null,
  storedKnownHosts: string | null,
  storedCaBundle: string | null,
): Promise<void> {
  const { repo_url, branch, auth_type, token, deploy_key, ssh_known_hosts_entry, ca_bundle } = req.body ?? {};
  if (typeof repo_url !== 'string' || !repo_url.trim()) {
    res.status(400).json({ error: 'repo_url is required' });
    return;
  }
  if (typeof branch !== 'string' || !branch.trim()) {
    res.status(400).json({ error: 'A branch, tag, or commit SHA is required.' });
    return;
  }
  const repoUrlError = repoUrlRejectionMessage(repo_url);
  if (repoUrlError) {
    res.status(400).json({ error: repoUrlError });
    return;
  }
  const parsedRepo = parseStorableRepoUrl(repo_url);
  if (!parsedRepo.ok) {
    res.status(400).json({ error: 'Repository URL is invalid' });
    return;
  }
  const repoHostname = parsedRepo.kind === 'https' ? parsedRepo.url.hostname : parsedRepo.ssh.host;
  try {
    await assertSafeOutboundHostname(repoHostname);
  } catch (error: unknown) {
    if (error instanceof UnsafeOutboundTargetError) {
      res.status(400).json({
        error: error.reason === 'blocked'
          ? 'Repository host is not allowed'
          : 'Repository host could not be resolved',
      });
      return;
    }
    throw error;
  }
  if (branch.length > MAX_BRANCH_LENGTH) {
    res.status(400).json({ error: 'The branch, tag, or commit SHA is too long.' });
    return;
  }
  if (auth_type !== undefined && auth_type !== 'none' && auth_type !== 'token' && auth_type !== 'deploy_key') {
    res.status(400).json({ error: 'auth_type must be "none", "token", or "deploy_key"' });
    return;
  }
  if (typeof token === 'string' && token.length > MAX_TOKEN_LENGTH) {
    res.status(400).json({ error: 'token is too long' });
    return;
  }
  if (typeof deploy_key === 'string' && deploy_key.length > MAX_DEPLOY_KEY_LENGTH) {
    res.status(400).json({ error: 'deploy_key is too long' });
    return;
  }
  if (typeof ca_bundle === 'string' && ca_bundle.length > MAX_CA_BUNDLE_LENGTH) {
    res.status(400).json({ error: 'ca_bundle is too long' });
    return;
  }
  const explicitToken = typeof token === 'string' && token.trim() ? token : null;
  const effectiveToken = auth_type === 'token' ? (explicitToken ?? storedToken) : null;
  const explicitDeployKey = typeof deploy_key === 'string' && deploy_key.trim() ? deploy_key : null;
  const effectiveDeployKey = auth_type === 'deploy_key' ? (explicitDeployKey ?? storedDeployKey) : null;
  const effectiveKnownHosts = auth_type === 'deploy_key'
    ? (typeof ssh_known_hosts_entry === 'string' && ssh_known_hosts_entry.trim()
      ? ssh_known_hosts_entry.trim()
      : storedKnownHosts)
    : null;
  const explicitCaBundle = typeof ca_bundle === 'string' && ca_bundle.trim() ? ca_bundle.trim() : null;
  const effectiveCaBundle = explicitCaBundle ?? storedCaBundle;
  if (explicitCaBundle && !validateCaBundlePem(explicitCaBundle)) {
    res.status(400).json({ error: 'ca_bundle must contain one or more PEM certificates' });
    return;
  }
  const listParams: {
    repoUrl: string;
    branch: string;
    token?: string | null;
    sshAuth?: { privateKey: string; knownHostsEntry: string };
    caBundlePem?: string | null;
  } = {
    repoUrl: repo_url.trim(),
    branch: branch.trim(),
  };
  if (auth_type === 'token') {
    listParams.token = effectiveToken;
  } else if (auth_type === 'deploy_key' && effectiveDeployKey && effectiveKnownHosts) {
    listParams.sshAuth = { privateKey: effectiveDeployKey, knownHostsEntry: effectiveKnownHosts };
  }
  if (effectiveCaBundle) {
    listParams.caBundlePem = effectiveCaBundle;
  }
  try {
    const result = await GitSourceService.getInstance().listRepoTree(listParams);
    res.json(result);
  } catch (error) {
    sendGitSourceError(res, error);
  }
}

/** Router for listing git-source configuration: `GET /api/git-sources`. */
export const gitSourcesRouter = Router();

gitSourcesRouter.post('/ssh-host-key', async (req: Request, res: Response): Promise<void> => {
  const { repo_url, stack_name } = req.body ?? {};
  if (typeof stack_name === 'string' && stack_name.trim()) {
    if (!isValidStackName(stack_name.trim())) {
      res.status(400).json({ error: 'Invalid stack name' });
      return;
    }
    if (!requirePermission(req, res, 'stack:edit', 'stack', stack_name.trim())) return;
  } else if (!requirePermission(req, res, 'stack:create')) {
    return;
  }
  if (typeof repo_url !== 'string' || !repo_url.trim()) {
    res.status(400).json({ error: 'repo_url is required' });
    return;
  }
  const repoUrlError = repoUrlRejectionMessage(repo_url);
  if (repoUrlError) {
    res.status(400).json({ error: repoUrlError });
    return;
  }
  try {
    const { parseSshUrl, scanHostKeys } = await import('../services/git/sshTrust');
    const parsed = parseSshUrl(repo_url.trim());
    if (!parsed) {
      res.status(400).json({ error: 'Host key probe requires an SSH repository URL' });
      return;
    }
    const [{ address }] = await resolveSafeOutboundHostname(parsed.host);
    const keys = await scanHostKeys(parsed.host, parsed.port, address);
    res.json({
      host: parsed.host,
      port: parsed.port,
      keys,
    });
  } catch (error) {
    if (error instanceof UnsafeOutboundTargetError) {
      res.status(400).json({
        error: error.reason === 'blocked'
          ? 'Repository host is not allowed'
          : 'Repository host could not be resolved',
      });
      return;
    }
    sendGitSourceError(res, error);
  }
});

gitSourcesRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const all = GitSourceService.getInstance().list();
    const present = await stackResourceSet(req.nodeId);
    // Filter to the subset of stacks the caller can read. Keeps scoped
    // roles from discovering git config for stacks outside their grant.
    // A row we cannot tie to a live, on-disk stack falls back to Admin, so a
    // source whose application is missing or half-created is never authorized
    // by a stack grant that may since have been reassigned.
    const visible: Array<PublicGitSource & {
      gitopsRevision: GitOpsRevisionProjection;
      stackResourcePresent: boolean;
    }> = [];
    for (const src of all) {
      const gitopsRevision = projectStackRevision(src.stack_name);
      const stackResourcePresent = present.has(src.stack_name);
      const requirement = classifySourceRow({
        stackName: src.stack_name,
        gitopsRevision,
        stackResourcePresent,
      });
      if (!satisfiesGitOpsRead(req, requirement)) continue;
      visible.push({ ...src, gitopsRevision, stackResourcePresent });
    }
    res.json(visible);
  } catch (error) {
    sendGitSourceError(res, error);
  }
});

/**
 * Cross-stack GitOps history for this instance.
 *
 * Every row is authorized on its own, so this returns the operator's own
 * stacks for a scoped role and every row on this instance for an Admin.
 * History is instance-local: a remote node's rows are read by proxying this
 * same route to that node.
 */
gitSourcesRouter.get('/history', async (req: Request, res: Response): Promise<void> => {
  try {
    await respondWithHistory(req, res, { kind: 'per_row' });
  } catch (error) {
    sendGitSourceError(res, error);
  }
});

// Create-mode repo browse (no stack yet): gated by the same permission as
// creating a stack from Git.
gitSourcesRouter.post('/browse', async (req: Request, res: Response): Promise<void> => {
  if (!requirePermission(req, res, 'stack:create')) return;
  await handleBrowse(req, res, null, null, null, null);
});

/**
 * Strict parser for the global poll interval (minutes, 0..10080). Accepts
 * integer numbers or digit strings only; rejects null, booleans, decimals,
 * whitespace, and out-of-range values without coercion, so a malformed value
 * cannot silently disable polling the operator meant to arm.
 */
export function parsePollIntervalMins(raw: unknown): number | null {
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < 0 || raw > 10080) return null;
    return raw;
  }
  if (typeof raw === 'string') {
    if (!/^\d{1,5}$/.test(raw)) return null;
    const value = Number(raw);
    return value <= 10080 ? value : null;
  }
  return null;
}

function requireNodeManage(req: Request, res: Response): boolean {
  if (typeof req.nodeId === 'number') {
    return requirePermission(req, res, 'node:manage', 'node', String(req.nodeId));
  }
  return requirePermission(req, res, 'node:manage');
}

function pollingSettingsPayload(): {
  poll_interval_mins: number;
  per_source: Array<{
    stack_name: string;
    poll_interval_secs: number | null;
    next_poll_at: number | null;
    source_policy: string;
  }>;
} {
  return {
    poll_interval_mins: DatabaseService.getInstance().getGitOpsPollIntervalMins(),
    per_source: GitOpsStore.getInstance().listActiveSourceApplications().map((app) => ({
      stack_name: app.stack_name ?? app.configured_source_stack_name ?? '',
      poll_interval_secs: app.poll_interval_secs,
      next_poll_at: app.next_poll_at,
      source_policy: app.source_policy,
    })),
  };
}

/**
 * Node-scoped polling configuration. The GET projects the global interval and
 * each live source's own cadence; the PATCH stores the interval and
 * reschedules every non-manual source, both gated by node:manage because the
 * cadence governs unattended fetches against the node.
 */
gitSourcesRouter.get('/polling', async (req: Request, res: Response): Promise<void> => {
  if (!requireNodeManage(req, res)) return;
  try {
    res.json(pollingSettingsPayload());
  } catch (error) {
    console.error('[GitSources] polling settings read failed:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Could not read polling settings.' });
  }
});

gitSourcesRouter.patch('/polling', async (req: Request, res: Response): Promise<void> => {
  if (!requireNodeManage(req, res)) return;
  const value = parsePollIntervalMins((req.body ?? {}).poll_interval_mins);
  if (value === null) {
    res.status(400).json({ error: 'poll_interval_mins must be an integer between 0 and 10080' });
    return;
  }
  try {
    DatabaseService.getInstance().updateGlobalSetting('gitops_poll_interval_mins', String(value));
    SourceController.getInstance().rescheduleAll('system:git-source');
    SourceController.getInstance().restartPolling();
    res.json(pollingSettingsPayload());
  } catch (error) {
    console.error('[GitSources] polling settings write failed:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Could not save polling settings.' });
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
    const gitSources = GitSourceService.getInstance();
    const source = gitSources.get(stackName);
    // Only this instance can say whether the stack's directory is really here,
    // so the answer travels with the response rather than being inferred by a
    // hub that has never seen the filesystem.
    const stackResourcePresent = (await stackResourceSet(req.nodeId)).has(stackName);
    if (source) {
      // The managed-project manifest summary rides the source branch; the
      // unlinked {linked:false} shape below is unchanged. Heal-on-read may
      // rewrite the DB cache, so re-read the flat row for same-response parity.
      const manifest = await gitSources.getManifestSummary(stackName);
      const refreshed = gitSources.get(stackName) ?? source;
      res.json({
        ...refreshed,
        manifest_state: manifest?.state ?? refreshed.manifest_state,
        manifest,
        gitopsRevision: projectStackRevision(stackName),
        stackResourcePresent,
      });
      return;
    }
    // No source row. A non-existent stack is a genuine 404, but an existing
    // stack with no Git source attached is a normal, non-error state. The
    // dashboard probes this endpoint for every stack, so returning 404 here
    // would paint a console error for every unlinked stack; answer 200 with
    // a discriminator instead and reserve 404 for the stack-not-found case.
    if (!stackResourcePresent) {
      res.status(404).json({ error: 'Stack not found' });
      return;
    }
    res.json({
      linked: false,
      gitopsRevision: NOT_APPLICABLE_REVISION,
      stackResourcePresent,
    });
  } catch (error) {
    sendGitSourceError(res, error);
  }
});

/**
 * GitOps history for one stack.
 *
 * The stack read below covers the application holding this name now. Rows from
 * an application that held it earlier are a different resource and are
 * authorized per row, so a reused stack name cannot expose its predecessor.
 */
stackGitSourceRouter.get('/:stackName/git-source/history', async (req: Request, res: Response): Promise<void> => {
  const stackName = req.params.stackName as string;
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return;
  }
  if (!requirePermission(req, res, 'stack:read', 'stack', stackName)) return;
  try {
    await respondWithHistory(req, res, { kind: 'authorized_stack', stackName });
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
      deploy_key,
      ssh_known_hosts_entry,
      ssh_host_key_fingerprint,
      ca_bundle,
      remove_ca_bundle,
      auto_apply_on_webhook,
      auto_deploy_on_apply,
      source_policy,
    } = req.body ?? {};

    if (typeof repo_url !== 'string' || !repo_url.trim()) {
      res.status(400).json({ error: 'repo_url is required' });
      return;
    }
    if (typeof branch !== 'string' || !branch.trim()) {
      res.status(400).json({ error: 'A branch, tag, or commit SHA is required.' });
      return;
    }
    const selection = parseComposeSelection(req.body);
    if (!selection.ok) {
      res.status(400).json({ error: selection.error });
      return;
    }
    if (auth_type !== 'none' && auth_type !== 'token' && auth_type !== 'deploy_key') {
      res.status(400).json({ error: 'auth_type must be "none", "token", or "deploy_key"' });
      return;
    }
    if (auto_apply_on_webhook !== undefined && typeof auto_apply_on_webhook !== 'boolean') {
      res.status(400).json({ error: 'auto_apply_on_webhook must be a boolean' });
      return;
    }
    if (
      source_policy !== undefined &&
      source_policy !== 'manual' &&
      source_policy !== 'review' &&
      source_policy !== 'automatic'
    ) {
      res.status(400).json({ error: 'source_policy must be "manual", "review", or "automatic"' });
      return;
    }
    if (auto_deploy_on_apply !== undefined && typeof auto_deploy_on_apply !== 'boolean') {
      res.status(400).json({ error: 'auto_deploy_on_apply must be a boolean' });
      return;
    }
    const encryptedSourcePolicyRaw = (req.body ?? {}).encrypted_source_policy;
    if (
      encryptedSourcePolicyRaw !== undefined
      && encryptedSourcePolicyRaw !== 'allow_plaintext'
      && encryptedSourcePolicyRaw !== 'require_encrypted'
    ) {
      res.status(400).json({ error: 'encrypted_source_policy must be "allow_plaintext" or "require_encrypted"' });
      return;
    }
    const repoUrlError = repoUrlRejectionMessage(repo_url);
    if (repoUrlError) {
      res.status(400).json({ error: repoUrlError });
      return;
    }
    if (branch.length > MAX_BRANCH_LENGTH) {
      res.status(400).json({ error: 'The branch, tag, or commit SHA is too long.' });
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
    if (typeof deploy_key === 'string' && deploy_key.length > MAX_DEPLOY_KEY_LENGTH) {
      res.status(400).json({ error: 'deploy_key is too long' });
      return;
    }
    if (typeof ca_bundle === 'string' && ca_bundle.length > MAX_CA_BUNDLE_LENGTH) {
      res.status(400).json({ error: 'ca_bundle is too long' });
      return;
    }
    if (typeof ca_bundle === 'string' && ca_bundle.trim() && !validateCaBundlePem(ca_bundle)) {
      res.status(400).json({ error: 'ca_bundle must contain one or more PEM certificates' });
      return;
    }
    if (remove_ca_bundle !== undefined && typeof remove_ca_bundle !== 'boolean') {
      res.status(400).json({ error: 'remove_ca_bundle must be a boolean' });
      return;
    }
    const autoApplyOnWebhook = auto_apply_on_webhook === true;
    const autoDeployOnApply = auto_deploy_on_apply === true;
    // The permission gate is unconditional: arming auto-deploy always demands
    // stack:deploy. Whether the policy matrix lets the arming through is a
    // separate service-side decision (only an automatic policy qualifies), so
    // no authorization decision depends on policy state read from the DB here.
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
      deployKey: typeof deploy_key === 'string' ? deploy_key : undefined,
      sshKnownHostsEntry: typeof ssh_known_hosts_entry === 'string' ? ssh_known_hosts_entry : undefined,
      sshHostKeyFingerprint: typeof ssh_host_key_fingerprint === 'string' ? ssh_host_key_fingerprint : undefined,
      caBundle: typeof ca_bundle === 'string' ? ca_bundle : undefined,
      removeCaBundle: remove_ca_bundle === true,
      autoApplyOnWebhook,
      autoDeployOnApply,
      // Type-safe only because the validation above 400s on anything outside
      // the three-value union before this point.
      sourcePolicy: source_policy as SourcePolicy | undefined,
      auditContext: {
        username: auditActorUsername(req),
        method: req.method,
        path: req.originalUrl,
        ipAddress: req.ip || 'unknown',
      },
    });

    if (encryptedSourcePolicyRaw !== undefined) {
      setEncryptedSourcePolicy(stackName, encryptedSourcePolicyRaw as EncryptedSourcePolicy);
    }

    // The cached /stacks/statuses payload carries the source label; drop it
    // before responding so a client refetch on this response recomputes. The
    // full invalidateNodeCaches helper is deliberate here (matching every
    // other mutation route): link/unlink is a low-frequency user action, so
    // dropping the project-name map and file-root allowlists alongside is
    // harmless, unlike the high-frequency container-event path.
    invalidateNodeCaches(req.nodeId);
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
    // Detach with the export contract: the effective compose model is rendered
    // into a single compose.yaml and the materialized files are kept, so a
    // multi-file / project-directory stack stays deployable after unlinking.
    // A render failure aborts with 409 and the row is left intact.
    await GitSourceService.getInstance().detach(stackName);
    // The cached /stacks/statuses payload carries the source label; drop it
    // before responding so a client refetch on this response recomputes. The
    // full invalidateNodeCaches helper is deliberate here (matching every
    // other mutation route): link/unlink is a low-frequency user action, so
    // dropping the project-name map and file-root allowlists alongside is
    // harmless, unlike the high-frequency container-event path.
    invalidateNodeCaches(req.nodeId);
    console.log(`[GitSource] Detached git source for ${stackName}`);
    res.json({ success: true });
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === 'RENDER_FAILED') {
      res.status(409).json({ error: (error as Error).message });
      return;
    }
    sendGitSourceError(res, error);
  }
});

stackGitSourceRouter.get('/:stackName/git-source/manifest', async (req: Request, res: Response): Promise<void> => {
  const stackName = req.params.stackName as string;
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return;
  }
  if (!requirePermission(req, res, 'stack:read', 'stack', stackName)) return;
  try {
    const manifest = await GitSourceService.getInstance().getManifest(stackName);
    if (!manifest) {
      res.status(404).json({ error: 'No managed-project manifest for this stack' });
      return;
    }
    // The public projection: no content hashes, size metadata, provenance, or
    // deletion authority, and high-sensitivity input paths are redacted.
    res.json({ manifest: GitProjectManifestService.getInstance().toPublicManifest(manifest) });
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
    const result = await GitSourceService.getInstance().pull(stackName, {
      actor: req.user?.username ?? 'unknown',
    });
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
    const { commitSha, deploy, planFingerprint } = req.body ?? {};
    if (typeof commitSha !== 'string' || !commitSha.trim()) {
      res.status(400).json({ error: 'commitSha is required' });
      return;
    }
    if (typeof planFingerprint !== 'string' || !planFingerprint.trim()) {
      res.status(400).json({ error: 'planFingerprint is required', code: 'PLAN_FINGERPRINT_REQUIRED' });
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
        planFingerprint: planFingerprint.trim(),
        requirePlanFingerprint: true,
      },
    );
    // Cache invalidation and the post-deploy scan now run inside GitSourceService.apply() itself.
    const shortSha = commitSha.trim().slice(0, 7);
    if (result.deployed) {
      console.log('[GitSource] Applied commit %s to %s (deployed)', sanitizeForLog(shortSha), sanitizeForLog(stackName));
    } else if (result.deployError) {
      console.warn('[GitSource] Applied commit %s to %s, deploy failed: %s', sanitizeForLog(shortSha), sanitizeForLog(stackName), sanitizeForLog(result.deployError));
    } else {
      console.log('[GitSource] Applied commit %s to %s', sanitizeForLog(shortSha), sanitizeForLog(stackName));
    }
    res.json(result);
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
  const deliveryId = req.body?.deliveryId;
  if (
    deliveryId !== undefined
    && (typeof deliveryId !== 'string' || !deliveryId.trim() || deliveryId.length > MAX_WEBHOOK_DELIVERY_ID_LENGTH)
  ) {
    res.status(400).json({ error: 'deliveryId must be a non-empty string of at most 512 characters' });
    return;
  }
  try {
    const service = GitSourceService.getInstance();
    const source = service.get(stackName);
    if (!source) {
      res.status(404).json({ error: 'No Git source configured for this stack', status: 'error' });
      return;
    }
    const normalizedDeliveryId = deliveryId?.trim();
    const deployAuthorized = checkPermission(req, 'stack:deploy', 'stack', stackName);
    if (service.webhookDeliveryRequiresDeploy(stackName, normalizedDeliveryId) && !deployAuthorized) {
      requirePermission(req, res, 'stack:deploy', 'stack', stackName);
      return;
    }
    const result = await service.handleWebhookPull(stackName, deployAuthorized, normalizedDeliveryId);
    // Map the outcome to a real HTTP status so a Git provider sees a 4xx on
    // failure instead of a 200 with an error body (which it would read as
    // "delivered fine, stop retrying").
    res.status(webhookPullStatus(result.status)).json(result);
  } catch (error) {
    sendGitSourceError(res, error);
  }
});

stackGitSourceRouter.get('/:stackName/git-source/provider-hooks', async (req: Request, res: Response): Promise<void> => {
  const stackName = req.params.stackName as string;
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return;
  }
  if (!requirePermission(req, res, 'stack:read', 'stack', stackName)) return;
  try {
    const store = GitProviderWebhookStore.getInstance();
    const endpoints = store.listEndpoints(stackName).map((endpoint) => ({
      id: endpoint.id,
      provider: endpoint.provider,
      enabled: endpoint.enabled === 1,
      event_scope: endpoint.event_scope,
      created_at: endpoint.created_at,
      updated_at: endpoint.updated_at,
      deliveries: store.listDeliveries(endpoint.id, 10).map((row) => ({
        delivery_id: row.delivery_id,
        state: row.state,
        event_type: row.event_type,
        event_action: row.event_action,
        ref: row.ref,
        outcome_class: row.outcome_class,
        received_at: row.received_at,
        updated_at: row.updated_at,
      })),
    }));
    res.json({
      endpoints,
      direct_source: directGitSourceAvailable(stackName),
    });
  } catch (error) {
    console.error('[GitSource] List provider hooks error:', error);
    res.status(500).json({ error: 'Failed to list provider hooks' });
  }
});

stackGitSourceRouter.post('/:stackName/git-source/provider-hooks', async (req: Request, res: Response): Promise<void> => {
  const stackName = req.params.stackName as string;
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return;
  }
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
  const { provider, event_scope } = req.body ?? {};
  if (!isGitProviderKind(provider)) {
    res.status(400).json({ error: `provider must be one of: ${VALID_PROVIDER_KINDS.join(', ')}` });
    return;
  }
  if (event_scope !== undefined && !isGitProviderEventScope(event_scope)) {
    res.status(400).json({ error: `event_scope must be one of: ${VALID_PROVIDER_EVENT_SCOPES.join(', ')}` });
    return;
  }
  try {
    const service = GitSourceService.getInstance();
    if (!service.get(stackName)) {
      res.status(404).json({ error: 'No Git source configured for this stack' });
      return;
    }
    if (!directGitSourceAvailable(stackName)) {
      res.status(400).json({ error: 'Provider hooks apply to direct Git sources only' });
      return;
    }
    const existing = GitProviderWebhookStore.getInstance().listEndpoints(stackName)
      .find((row) => row.provider === provider);
    if (existing) {
      res.status(409).json({ error: `A ${provider} endpoint already exists for this source` });
      return;
    }
    const created = ProviderWebhookService.getInstance().createEndpoint({
      stackName,
      provider,
      eventScope: event_scope ?? 'configured_ref',
    });
    res.status(201).json({ id: created.id, secret: created.secret });
  } catch (error) {
    console.error('[GitSource] Create provider hook error:', error);
    res.status(500).json({ error: 'Failed to create provider hook' });
  }
});

stackGitSourceRouter.post('/:stackName/git-source/provider-hooks/:id/rotate', async (req: Request, res: Response): Promise<void> => {
  const stackName = req.params.stackName as string;
  const endpointId = req.params.id as string;
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return;
  }
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
  try {
    const endpoint = getProviderHookEndpoint(stackName, endpointId);
    if (!endpoint) {
      res.status(404).json({ error: 'Provider hook not found' });
      return;
    }
    const rotated = ProviderWebhookService.getInstance().rotateEndpoint(endpointId);
    res.json({ secret: rotated.secret });
  } catch (error) {
    console.error('[GitSource] Rotate provider hook error:', error);
    res.status(500).json({ error: 'Failed to rotate provider hook secret' });
  }
});

stackGitSourceRouter.post('/:stackName/git-source/provider-hooks/:id/test-result', async (req: Request, res: Response): Promise<void> => {
  const stackName = req.params.stackName as string;
  const endpointId = req.params.id as string;
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return;
  }
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
  try {
    const endpoint = getProviderHookEndpoint(stackName, endpointId);
    if (!endpoint) {
      res.status(404).json({ error: 'Provider hook not found' });
      return;
    }
    const deliveries = GitProviderWebhookStore.getInstance().listDeliveries(endpointId, 5);
    res.json({ deliveries });
  } catch (error) {
    console.error('[GitSource] Provider hook test-result error:', error);
    res.status(500).json({ error: 'Failed to load provider hook test results' });
  }
});

stackGitSourceRouter.patch('/:stackName/git-source/provider-hooks/:id', async (req: Request, res: Response): Promise<void> => {
  const stackName = req.params.stackName as string;
  const endpointId = req.params.id as string;
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return;
  }
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
  const { enabled, event_scope } = req.body ?? {};
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be a boolean' });
    return;
  }
  if (event_scope !== undefined && !isGitProviderEventScope(event_scope)) {
    res.status(400).json({ error: `event_scope must be one of: ${VALID_PROVIDER_EVENT_SCOPES.join(', ')}` });
    return;
  }
  if (enabled === undefined && event_scope === undefined) {
    res.status(400).json({ error: 'No supported fields to update' });
    return;
  }
  try {
    const endpoint = getProviderHookEndpoint(stackName, endpointId);
    if (!endpoint) {
      res.status(404).json({ error: 'Provider hook not found' });
      return;
    }
    GitProviderWebhookStore.getInstance().updateEndpoint(endpointId, {
      ...(enabled !== undefined ? { enabled: enabled ? 1 : 0 } : {}),
      ...(event_scope !== undefined ? { event_scope } : {}),
    });
    const updated = GitProviderWebhookStore.getInstance().getEndpoint(endpointId)!;
    res.json({
      id: updated.id,
      provider: updated.provider,
      enabled: updated.enabled === 1,
      event_scope: updated.event_scope,
      created_at: updated.created_at,
      updated_at: updated.updated_at,
    });
  } catch (error) {
    console.error('[GitSource] Update provider hook error:', error);
    res.status(500).json({ error: 'Failed to update provider hook' });
  }
});

stackGitSourceRouter.delete('/:stackName/git-source/provider-hooks/:id', async (req: Request, res: Response): Promise<void> => {
  const stackName = req.params.stackName as string;
  const endpointId = req.params.id as string;
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return;
  }
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
  try {
    const endpoint = getProviderHookEndpoint(stackName, endpointId);
    if (!endpoint) {
      res.status(404).json({ error: 'Provider hook not found' });
      return;
    }
    GitProviderWebhookStore.getInstance().deleteEndpoint(endpointId);
    res.json({ success: true });
  } catch (error) {
    console.error('[GitSource] Delete provider hook error:', error);
    res.status(500).json({ error: 'Failed to delete provider hook' });
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
    GitSourceService.getInstance().dismissPending(stackName, req.user?.username ?? 'unknown');
    res.json({ success: true });
  } catch (error) {
    sendGitSourceError(res, error);
  }
});

stackGitSourceRouter.post('/:stackName/git-source/suspend', async (req: Request, res: Response): Promise<void> => {
  const stackName = req.params.stackName as string;
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return;
  }
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
  const { reason: rawReason } = req.body ?? {};
  const reason = typeof rawReason === 'string' ? rawReason : undefined;
  if (reason !== undefined && reason.length > MAX_SUSPEND_REASON_LENGTH) {
    res.status(400).json({ error: 'reason is too long' });
    return;
  }
  try {
    const result = await GitSourceService.getInstance().suspend(stackName, {
      actor: req.user?.username ?? 'unknown',
      reason,
    });
    res.json(result);
  } catch (error) {
    sendGitSourceError(res, error);
  }
});

stackGitSourceRouter.post('/:stackName/git-source/resume', async (req: Request, res: Response): Promise<void> => {
  const stackName = req.params.stackName as string;
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return;
  }
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
  try {
    const result = await GitSourceService.getInstance().resume(stackName, {
      actor: req.user?.username ?? 'unknown',
    });
    // A resumed source is re-evaluated immediately rather than idling
    // until its next poll or retry cursor: the controller's resume trigger
    // re-resolves source state and, for an automatic source, target
    // binding through the shared acceptance/dispatch arm. Fire-and-forget
    // by design: this response reports that suspension was cleared, not
    // the outcome of a reconcile that has not finished yet, and the
    // durable row plus the next tick are the authority on the latter.
    // The wake has its own guard: a failure starting it must not
    // retroactively fail a resume that already committed, so it is
    // logged, never sent to sendGitSourceError. evaluateNow absorbs its
    // evaluation failures itself; the rejection arm catches anything
    // before its own try exists (evaluateNow is async, so even its
    // synchronous prologue, a store error before any evaluation could
    // run, surfaces as a rejection) and any future escape, and the
    // try/catch covers a getInstance()-level failure only.
    const logWakeFailure = (error: unknown): void => {
      console.error(
        `[GitSources] Resume re-evaluation could not start for ${sanitizeForLog(stackName)}:`,
        error instanceof Error ? error.message : String(error),
      );
    };
    try {
      SourceController.getInstance().evaluateNow(stackName).catch(logWakeFailure);
    } catch (error) {
      logWakeFailure(error);
    }
    res.json(result);
  } catch (error) {
    sendGitSourceError(res, error);
  }
});

stackGitSourceRouter.post('/:stackName/git-source/retry', async (req: Request, res: Response): Promise<void> => {
  const stackName = req.params.stackName as string;
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return;
  }
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
  try {
    const result = await GitSourceService.getInstance().retry(stackName, {
      actor: req.user?.username ?? 'unknown',
    });
    res.json(result);
  } catch (error) {
    sendGitSourceError(res, error);
  }
});

function respondBindingFailure(res: Response, error: unknown, context: string, clientMessage: string): void {
  if (error instanceof GitOpsBindingError) {
    const status = error.code === 'blueprint_not_found' || error.code === 'application_not_found' ? 404 : 409;
    res.status(status).json({ error: error.message, code: error.code });
    return;
  }
  console.error(`[GitSources] ${context}:`, error);
  res.status(500).json({ error: clientMessage });
}

function loadAdoptTarget(req: Request, res: Response): { blueprintId: number; applicationId: string } | null {
  const stackName = req.params.stackName as string;
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return null;
  }
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return null;
  if (!requirePermission(req, res, 'stack:deploy', 'stack', stackName)) return null;
  const raw = (req.body ?? {}).blueprintId;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    res.status(400).json({ error: 'blueprintId must be a positive integer' });
    return null;
  }
  const blueprint = DatabaseService.getInstance().getBlueprint(raw);
  if (!blueprint) {
    res.status(404).json({ error: 'Blueprint not found' });
    return null;
  }
  if (!requirePermission(req, res, 'stack:edit', 'stack', blueprint.name)) return null;
  const application = GitOpsStore.getInstance().getLiveDirectApplication(stackName);
  if (!application) {
    res.status(409).json({
      error: 'No live Direct GitOps application for this stack',
      code: 'application_not_direct',
    });
    return null;
  }
  return { blueprintId: raw, applicationId: application.id };
}

stackGitSourceRouter.post('/:stackName/git-source/adopt-blueprint/preview', async (req: Request, res: Response): Promise<void> => {
  const target = loadAdoptTarget(req, res);
  if (!target) return;
  try {
    const preview = await GitOpsBindingService.getInstance().previewAdoptDirectToBlueprint(target);
    res.json(preview);
  } catch (error) {
    respondBindingFailure(res, error, 'Adopt-blueprint preview error', 'Failed to preview Blueprint adoption');
  }
});

stackGitSourceRouter.post('/:stackName/git-source/adopt-blueprint', (req: Request, res: Response): void => {
  const target = loadAdoptTarget(req, res);
  if (!target) return;
  try {
    const service = GitOpsBindingService.getInstance();
    service.adoptDirectToBlueprint({ ...target, actor: auditActorUsername(req) });
    res.json(service.describeContentBinding(target.blueprintId));
  } catch (error) {
    respondBindingFailure(res, error, 'Adopt-blueprint error', 'Failed to adopt Blueprint from Git source');
  }
});

function resolveSopsApplicationId(stackName: string): string {
  return GitOpsStore.getInstance().getLiveDirectApplication(stackName)?.id ?? stackName;
}

stackGitSourceRouter.put('/:stackName/git-source/encrypted-source-policy', async (req: Request, res: Response): Promise<void> => {
  const stackName = req.params.stackName as string;
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return;
  }
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
  if (!DatabaseService.getInstance().getGitSource(stackName)) {
    res.status(404).json({ error: 'Git source not found' });
    return;
  }
  const policy = (req.body ?? {}).encrypted_source_policy;
  if (policy !== 'allow_plaintext' && policy !== 'require_encrypted') {
    res.status(400).json({ error: 'encrypted_source_policy must be "allow_plaintext" or "require_encrypted"' });
    return;
  }
  setEncryptedSourcePolicy(stackName, policy);
  res.json({ encrypted_source_policy: getEncryptedSourcePolicy(stackName) });
});

stackGitSourceRouter.get('/:stackName/git-source/sops-identities', async (req: Request, res: Response): Promise<void> => {
  const stackName = req.params.stackName as string;
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return;
  }
  if (!requirePermission(req, res, 'stack:read', 'stack', stackName)) return;
  if (!DatabaseService.getInstance().getGitSource(stackName)) {
    res.status(404).json({ error: 'Git source not found' });
    return;
  }
  const applicationId = resolveSopsApplicationId(stackName);
  const policy = getEncryptedSourcePolicy(stackName);
  const identities = SopsIdentityStore.getInstance().listPublic(applicationId, stackName);
  const { resolveActiveRequiredRecipients } = await import('../services/gitops/sops/capability');
  const requiredRecipients = resolveActiveRequiredRecipients({
    stackName,
    nodeId: req.nodeId ?? 0,
  });
  const readiness = SopsIdentityStore.getInstance().computeReadiness({
    applicationId,
    stackName,
    policy,
    requiredRecipients,
  });
  res.json({
    encrypted_source_policy: policy,
    identities,
    readiness,
  });
});

stackGitSourceRouter.post('/:stackName/git-source/sops-identities', async (req: Request, res: Response): Promise<void> => {
  const stackName = req.params.stackName as string;
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return;
  }
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
  if (!DatabaseService.getInstance().getGitSource(stackName)) {
    res.status(404).json({ error: 'Git source not found' });
    return;
  }
  try {
    const label = typeof req.body?.label === 'string' ? req.body.label : null;
    const identity = await SopsIdentityStore.getInstance().generateIdentity({
      applicationId: resolveSopsApplicationId(stackName),
      stackName,
      label,
    });
    res.status(201).json(identity);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || 'Could not generate identity' });
  }
});

stackGitSourceRouter.post('/:stackName/git-source/sops-identities/import', async (req: Request, res: Response): Promise<void> => {
  const stackName = req.params.stackName as string;
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return;
  }
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
  if (!DatabaseService.getInstance().getGitSource(stackName)) {
    res.status(404).json({ error: 'Git source not found' });
    return;
  }
  const identity = typeof req.body?.identity === 'string' ? req.body.identity : '';
  if (!identity.trim()) {
    res.status(400).json({ error: 'identity is required' });
    return;
  }
  try {
    const label = typeof req.body?.label === 'string' ? req.body.label : null;
    const imported = await SopsIdentityStore.getInstance().importIdentity({
      applicationId: resolveSopsApplicationId(stackName),
      stackName,
      identity,
      label,
    });
    res.status(201).json(imported);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || 'Could not import identity' });
  }
});

stackGitSourceRouter.post('/:stackName/git-source/sops-identities/:id/rotate', async (req: Request, res: Response): Promise<void> => {
  const stackName = req.params.stackName as string;
  const id = req.params.id as string;
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return;
  }
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
  if (!DatabaseService.getInstance().getGitSource(stackName)) {
    res.status(404).json({ error: 'Git source not found' });
    return;
  }
  try {
    const label = typeof req.body?.label === 'string' ? req.body.label : null;
    const result = await SopsIdentityStore.getInstance().rotateIdentity({
      id,
      applicationId: resolveSopsApplicationId(stackName),
      stackName,
      label,
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || 'Could not rotate identity' });
  }
});

stackGitSourceRouter.delete('/:stackName/git-source/sops-identities/:id', async (req: Request, res: Response): Promise<void> => {
  const stackName = req.params.stackName as string;
  const id = req.params.id as string;
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return;
  }
  if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
  try {
    const acknowledge = req.body?.acknowledge_destructive === true;
    const result = SopsIdentityStore.getInstance().deleteIdentity({
      id,
      applicationId: resolveSopsApplicationId(stackName),
      stackName,
      acknowledgeDestructive: acknowledge,
    });
    if (!result.deleted) {
      res.status(409).json({ error: 'Identity is in use', impact: result.impact });
      return;
    }
    res.json({ deleted: true, impact: result.impact });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || 'Could not delete identity' });
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
  const storedDeployKey = src?.encrypted_deploy_key ? CryptoService.getInstance().decrypt(src.encrypted_deploy_key) : null;
  const storedKnownHosts = src?.ssh_known_hosts_entry ?? null;
  const storedCaBundle = src?.encrypted_ca_bundle ? CryptoService.getInstance().decrypt(src.encrypted_ca_bundle) : null;
  await handleBrowse(req, res, storedToken, storedDeployKey, storedKnownHosts, storedCaBundle);
});
