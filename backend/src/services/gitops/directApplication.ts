import { randomUUID } from 'crypto';
import path from 'path';
import { NodeRegistry } from '../NodeRegistry';
import { MANAGED_ROOT_NAME } from './managedPaths';
import { encodeGitOpsJson } from './json';
import { materializationFingerprint } from './fingerprint';
import { parseLegacyRepoUrl, parseStorableRepoUrl, secretFreeRepoUrl, secretFreeRepoUrlFromStorable, serializeRepoIdentity, serializeRepoIdentityFromStorable, type RepoIdentity } from './repoIdentity';
import type { RefKind } from '../git/types';
import type {
  GitOpsApplicationRow,
  GitOpsCreateCheckpointRow,
  GitOpsGenerationRow,
} from './types';

/** The material source configuration a Direct application is bound to. */
export type DirectSourceConfig = {
  repoUrl: string;
  branch: string;
  composePaths: readonly string[];
  contextDir: string | null;
  syncEnv: boolean;
  envPath: string | null;
};

export type DirectSourceIdentity = {
  /** Secret-free `https://host/pathname`, safe to persist and to project. */
  repoUrl: string;
  identity: RepoIdentity;
  fingerprint: string;
};

export class GitOpsIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitOpsIdentityError';
  }
}

/**
 * Derive the storable identity and materialization fingerprint for a source.
 *
 * The fingerprint is what later decides whether a staged candidate still
 * matches the configuration it was built from, so it is computed from the same
 * secret-free identity that gets persisted, never from the raw operational URL.
 */
export function directSourceIdentity(config: DirectSourceConfig): DirectSourceIdentity {
  const parsed = parseStorableRepoUrl(config.repoUrl);
  if (!parsed.ok) throw new GitOpsIdentityError(`repository URL is not storable: ${parsed.reason}`);
  const identity = serializeRepoIdentityFromStorable(parsed);
  const repoUrl = secretFreeRepoUrlFromStorable(parsed);
  const fingerprint = materializationFingerprint({
    repoIdentity: identity,
    configuredRef: config.branch,
    composePaths: config.composePaths,
    contextDir: config.contextDir,
    syncEnv: config.syncEnv,
    envPath: config.envPath,
  });
  return { repoUrl, identity, fingerprint };
}

/**
 * The same derivation, for URLs that predate strict ingress.
 *
 * Migration is its only caller. A legacy operational row may still carry
 * userinfo or a query string that fetch needs, so the storable identity strips
 * them instead of refusing the stack; the strict helper above stays the gate
 * for every path a user can drive.
 */
export function migrationDirectSourceIdentity(config: DirectSourceConfig): DirectSourceIdentity {
  const parsed = parseLegacyRepoUrl(config.repoUrl);
  if (!parsed.ok) throw new GitOpsIdentityError(`repository URL is not storable: ${parsed.reason}`);
  return directSourceIdentityFromUrl(config, parsed.url);
}

function directSourceIdentityFromUrl(config: DirectSourceConfig, url: URL): DirectSourceIdentity {
  const identity = serializeRepoIdentity(url);
  const material = {
    repoIdentity: identity,
    configuredRef: config.branch,
    composePaths: config.composePaths,
    contextDir: config.contextDir,
    syncEnv: config.syncEnv,
    envPath: config.envPath,
  };
  return {
    repoUrl: secretFreeRepoUrl(identity),
    identity,
    fingerprint: materializationFingerprint(material),
  };
}

/** Absolute managed root for one stack on the local node. */
export function stackManagedRoot(stackName: string): string {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
  return path.join(dataDir, MANAGED_ROOT_NAME, String(nodeId), stackName);
}

export function newGitOpsId(): string {
  return randomUUID();
}

/**
 * Build a Direct application row.
 *
 * `creating` is for create-from-Git, where the stack does not exist yet and the
 * checkpoint decides what happens if the process dies. `active` is for linking
 * a stack that already exists: there is nothing to recover, so it is live from
 * the moment the source row commits.
 */
export function buildDirectApplicationRow(args: {
  id: string;
  stackName: string;
  config: DirectSourceConfig;
  identity: DirectSourceIdentity;
  lifecycleStatus: 'creating' | 'active';
  at: number;
}): GitOpsApplicationRow {
  return {
    id: args.id,
    lifecycle_key: `direct:${args.stackName}`,
    lifecycle_status: args.lifecycleStatus,
    target_mode: 'direct',
    stack_name: args.stackName,
    blueprint_id: null,
    configured_repo_url: args.identity.repoUrl,
    repo_identity_json: encodeGitOpsJson(args.identity.identity),
    configured_ref: args.config.branch,
    compose_paths_json: encodeGitOpsJson([...args.config.composePaths]),
    context_dir: args.config.contextDir,
    sync_env: args.config.syncEnv ? 1 : 0,
    env_path: args.config.syncEnv ? args.config.envPath : null,
    materialization_fingerprint: args.identity.fingerprint,
    desired_commit_sha: null,
    fetched_commit_sha: null,
    fetched_resolved_ref_kind: null,
    candidate_generation_id: null,
    accepted_generation_id: null,
    candidate_plan_blocked: 0,
    review_required: 0,
    artifact_set_id: null,
    latest_artifact_set_id: null,
    intent_revision_id: null,
    rollout_candidate_id: null,
    rollout_generation_id: null,
    source_acceptance_ref: null,
    placement_approval_ref: null,
    rollout_authorization_ref: null,
    legacy_combined_approval_ref: null,
    preflight_fingerprint: null,
    latest_operation_id: null,
    active_operation_id: null,
    active_operation_stage: null,
    active_operation_at: null,
    active_generation_id: null,
    pause_at: null,
    pause_reason: null,
    partial_json: null,
    failure_stage: null,
    failure_class: null,
    failure_at: null,
    retry_at: null,
    retry_count: 0,
    suspended_at: null,
    recovery_ref: null,
    recovery_phase: null,
    interruption_stage: null,
    interruption_at: null,
    interruption_operation_id: null,
    interruption_generation_id: null,
    evidence_fresh_at: null,
    evidence_limitations_json: null,
    created_at: args.at,
    updated_at: args.at,
  };
}

export function buildGenerationRow(args: {
  id: string;
  applicationId: string;
  commitSha: string;
  identity: DirectSourceIdentity;
  configuredRef: string;
  resolvedRefKind: RefKind;
  candidateRelPath: string;
  appliedRelPath: string;
  manifestVersion: number;
  expectedInvocation: unknown;
  changePlanFingerprint: string | null;
  operationId: string;
  trigger: string;
  actor: string | null;
  at: number;
  /** A blocked change plan is recorded, but such a generation can never apply. */
  planBlocked?: boolean;
}): GitOpsGenerationRow {
  return {
    id: args.id,
    application_id: args.applicationId,
    commit_sha: args.commitSha,
    repo_url: args.identity.repoUrl,
    configured_ref: args.configuredRef,
    resolved_ref_kind: args.resolvedRefKind,
    repo_identity_json: encodeGitOpsJson(args.identity.identity),
    manifest_version: args.manifestVersion,
    candidate_dir: args.candidateRelPath,
    applied_dir: args.appliedRelPath,
    expected_invocation_json: encodeGitOpsJson(args.expectedInvocation),
    materialization_fingerprint: args.identity.fingerprint,
    validation_ok: 1,
    plan_blocked: args.planBlocked ? 1 : 0,
    change_plan_fingerprint: args.changePlanFingerprint,
    operation_id: args.operationId,
    trigger: args.trigger,
    actor: args.actor,
    previous_generation_id: null,
    redacted_limitations_json: '[]',
    created_at: args.at,
  };
}

export function buildCreateCheckpointRow(args: {
  applicationId: string;
  stackName: string;
  operationId: string;
  config: DirectSourceConfig;
  identity: DirectSourceIdentity;
  authType: string;
  encryptedToken: string | null;
  autoApplyOnWebhook: boolean;
  autoDeployOnApply: boolean;
  commitSha: string;
  createdManagedRoot: boolean;
  at: number;
}): GitOpsCreateCheckpointRow {
  return {
    application_id: args.applicationId,
    stack_name: args.stackName,
    phase: 'pre_stack',
    generation_id: null,
    operation_id: args.operationId,
    // Operational URL for fetch compatibility during create. Copies into
    // generations and history always go through the secret-free identity.
    repo_url: args.config.repoUrl,
    branch: args.config.branch,
    compose_path: args.config.composePaths[0] ?? '',
    compose_paths_json: encodeGitOpsJson([...args.config.composePaths]),
    context_dir: args.config.contextDir,
    sync_env: args.config.syncEnv ? 1 : 0,
    env_path: args.config.syncEnv ? args.config.envPath : null,
    auth_type: args.authType,
    encrypted_token: args.encryptedToken,
    auto_apply_on_webhook: args.autoApplyOnWebhook ? 1 : 0,
    auto_deploy_on_apply: args.autoDeployOnApply ? 1 : 0,
    commit_sha: args.commitSha,
    applied_spec_json: null,
    created_managed_root: args.createdManagedRoot ? 1 : 0,
    created_at: args.at,
    updated_at: args.at,
  };
}
