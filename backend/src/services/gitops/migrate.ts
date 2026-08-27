import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { DatabaseService, type Blueprint, type StackGitSource } from '../DatabaseService';
import { FileSystemService } from '../FileSystemService';
import { GitProjectManifestService } from '../GitProjectManifestService';
import { NodeRegistry } from '../NodeRegistry';
import { sanitizeForLog } from '../../utils/safeLog';
import { encodeGitOpsEvidenceLimitations, type GitOpsEvidenceLimitation } from './json';
import { buildDirectApplicationRow, migrationDirectSourceIdentity, newGitOpsId } from './directApplication';
import { emptyTargetRow, GitOpsStore } from './store';
import { GitOpsTransitions, type EventEnvelope } from './transitions';
import { blankInlineApplication } from './blueprintProducers';
import { evaluateEffectiveApproval, intentFingerprint } from '../blueprintApproval';
import type { GitOpsApplicationRow, GitOpsGenerationRow, GitOpsTargetCurrentRow } from './types';

/** Schema version this migration writes. Bumping it replays every scope. */
const MIGRATION_SCHEMA_VERSION = 1;

/**
 * What the on-disk manifest proves about a stack.
 *
 * `trusted` is the only classification that licenses a canonical commit
 * pointer, and it means the manifest parsed, validated, carries an identity
 * stamp matching the repository and ref the source row configures *now*, and
 * names the same commit the source row records as applied. The five failure
 * kinds are kept apart because they tell an operator different things, and
 * each implies a different next step: nothing was ever written, something was
 * written and is unreadable, something was written for a different repository,
 * the manifest records no commit at all, or the two records name different
 * commits.
 *
 * The last two are deliberately separate. A manifest adopted from an existing
 * directory is written with an empty commit and `state: 'migrated'`, which the
 * validator permits, so "no commit yet" is an ordinary state for a stack that
 * has never been fetched. Reporting it as a disagreement would name a commit
 * the manifest does not contain.
 */
type ManifestTrust =
  | { kind: 'trusted'; commitSha: string; manifestVersion: number; appliedDir: string }
  | { kind: 'absent' }
  | { kind: 'corrupt'; reason: string }
  | { kind: 'identity_invalid'; reason: string }
  | { kind: 'commit_unresolved' }
  | { kind: 'commit_mismatch'; manifestCommitSha: string };

export type MigrationOutcome =
  | 'skipped_current'
  | 'skipped_live_application'
  | 'migrated_accepted'
  | 'migrated_unreconciled'
  | 'tombstoned_missing_stack'
  | 'migrated_inline'
  | 'failed';

export type MigrationResult = { stackName: string; outcome: MigrationOutcome };

/**
 * Bring Git stacks that predate the revision state model into it.
 *
 * The governing rule is that a pointer is written only when the evidence proves
 * that exact generation under the repository and ref configured now. A legacy
 * applied commit is not that proof on its own: the manifest may be gone, may be
 * unreadable, may be stamped for a repository the stack no longer points at, or
 * may name a different commit than the one the source row records as applied.
 * In every one of those cases the canonical pointers stay null and the legacy
 * commit survives as recorded limitation evidence, so the projection asks for a
 * fetch instead of asserting a state nobody verified.
 *
 * Idempotent by checkpoint. Replay after a configuration change re-runs the
 * matrix but never upgrades an already-justified pointer to a stronger claim.
 */
export function migrateDirectGitStacks(): MigrationResult[] {
  const db = DatabaseService.getInstance();
  const results: MigrationResult[] = [];
  for (const source of db.getGitSources()) {
    try {
      results.push(migrateOne(source));
    } catch (error) {
      console.error(
        `[GitOps] Could not migrate the Git stack ${sanitizeForLog(source.stack_name)}; retrying next boot:`,
        error instanceof Error ? error.stack ?? error.message : String(error),
      );
      results.push({ stackName: source.stack_name, outcome: 'failed' });
    }
  }
  return results;
}

function migrateOne(source: StackGitSource): MigrationResult {
  const store = GitOpsStore.getInstance();
  const stackName = source.stack_name;
  // Migration-only identity derivation: a legacy operational URL may still
  // carry userinfo or a query string that fetch needs, so the storable
  // identity strips them and the source row is never rewritten.
  const identity = migrationDirectSourceIdentity({
    repoUrl: source.repo_url,
    branch: source.branch,
    composePaths: source.compose_paths,
    contextDir: source.context_dir,
    syncEnv: source.sync_env,
    envPath: source.env_path,
  });

  const scope = `direct:${stackName}`;
  const checkpoint = store.getMigrationCheckpoint(scope);
  if (
    checkpoint
    && checkpoint.schema_version === MIGRATION_SCHEMA_VERSION
    && checkpoint.fingerprint === identity.fingerprint
  ) {
    return { stackName, outcome: 'skipped_current' };
  }

  // A stack created through the new path already describes itself. Migration
  // never touches it: its pointers were written with proof this pass does not
  // have.
  if (store.getLiveDirectApplication(stackName)) {
    store.upsertMigrationCheckpoint(scope, MIGRATION_SCHEMA_VERSION, identity.fingerprint, Date.now());
    return { stackName, outcome: 'skipped_live_application' };
  }

  const trust = classifyManifest(stackName, source);
  const limitations = collectLimitations(source, trust);
  const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
  const stackPresent = stackDirectoryPresent(stackName, nodeId);
  const at = Date.now();
  const envelope: EventEnvelope = {
    operationId: newGitOpsId(),
    actor: 'system:migration',
    trigger: 'migrate',
    at,
  };

  const application = buildDirectApplicationRow({
    id: newGitOpsId(),
    stackName,
    config: {
      repoUrl: source.repo_url,
      branch: source.branch,
      composePaths: source.compose_paths,
      contextDir: source.context_dir,
      syncEnv: source.sync_env,
      envPath: source.env_path,
    },
    identity,
    // A stack whose directory is gone is recorded as detached rather than live:
    // it describes something that no longer exists, and a live application
    // would go on claiming the name.
    lifecycleStatus: 'active',
    at,
  });

  return DatabaseService.getInstance().getDb().transaction((): MigrationResult => {
    if (trust.kind === 'trusted' && stackPresent) {
      migrateAccepted(application, source, trust, identity.fingerprint, limitations, envelope, nodeId);
      store.upsertMigrationCheckpoint(scope, MIGRATION_SCHEMA_VERSION, identity.fingerprint, at);
      return { stackName, outcome: 'migrated_accepted' };
    }

    application.evidence_limitations_json = encodeLimitations(limitations);
    GitOpsTransitions.getInstance().activateDirect({ application, nodeId, envelope });
    if (!stackPresent) {
      GitOpsTransitions.getInstance().targetTombstoned(application.id, nodeId, envelope);
      GitOpsTransitions.getInstance().applicationTombstoned(application.id, 'deleted', envelope);
      store.upsertMigrationCheckpoint(scope, MIGRATION_SCHEMA_VERSION, identity.fingerprint, at);
      return { stackName, outcome: 'tombstoned_missing_stack' };
    }
    store.upsertMigrationCheckpoint(scope, MIGRATION_SCHEMA_VERSION, identity.fingerprint, at);
    return { stackName, outcome: 'migrated_unreconciled' };
  })();
}

/**
 * The one path that writes canonical pointers, because the manifest proves the
 * applied commit under the configuration in force now.
 *
 * Deployed, healthy, and last-known-good stay null regardless: a manifest
 * proves what was materialized, not what is running, and inventing those is how
 * a migration would claim a health record nobody observed. No source acceptance
 * is written either, because nobody approved this generation through the model.
 */
function migrateAccepted(
  application: GitOpsApplicationRow,
  source: StackGitSource,
  trust: Extract<ManifestTrust, { kind: 'trusted' }>,
  fingerprint: string,
  limitations: GitOpsEvidenceLimitation[],
  envelope: EventEnvelope,
  nodeId: number,
): void {
  const store = GitOpsStore.getInstance();
  const generationId = newGitOpsId();
  const artifactSetId = newGitOpsId();

  application.desired_commit_sha = trust.commitSha;
  application.fetched_commit_sha = trust.commitSha;
  application.accepted_generation_id = generationId;
  application.artifact_set_id = artifactSetId;
  application.latest_artifact_set_id = artifactSetId;
  application.evidence_limitations_json = encodeLimitations(limitations);

  GitOpsTransitions.getInstance().activateDirect({ application, nodeId, envelope });

  const generation: GitOpsGenerationRow = {
    id: generationId,
    application_id: application.id,
    commit_sha: trust.commitSha,
    repo_url: application.configured_repo_url ?? '',
    configured_ref: source.branch,
    repo_identity_json: application.repo_identity_json ?? '{}',
    manifest_version: trust.manifestVersion,
    candidate_dir: `generations/candidate-${trust.commitSha}`,
    applied_dir: trust.appliedDir,
    expected_invocation_json: '{"composeFileOrder":[],"projectName":null,"projectDirectory":null,"envFileOrder":[]}',
    // Equal to the application's, so the accepted generation is not immediately
    // reported as stale against its own configuration.
    materialization_fingerprint: fingerprint,
    validation_ok: 1,
    plan_blocked: 0,
    change_plan_fingerprint: null,
    operation_id: envelope.operationId,
    trigger: envelope.trigger,
    actor: envelope.actor,
    previous_generation_id: null,
    redacted_limitations_json: '[]',
    created_at: envelope.at,
  };
  store.insertGeneration(generation);
  store.insertArtifactSet({
    id: artifactSetId,
    generation_id: generationId,
    evidence_version: 1,
    authoritative: 0,
    qualification: 'unresolved',
    evidence_json: '{"kind":"unresolved"}',
    created_at: envelope.at,
  });

  const target: GitOpsTargetCurrentRow = {
    ...emptyTargetRow(application.id, nodeId, envelope.at),
    desired_generation_id: generationId,
    applied_generation_id: generationId,
    expected_artifact_set_id: artifactSetId,
    latest_artifact_set_id: artifactSetId,
  };
  store.upsertTarget(target);
  store.writeApplicationPointers(application);
}

/** Whether the manifest licenses a canonical commit pointer. */
function classifyManifest(stackName: string, source: StackGitSource): ManifestTrust {
  if (!source.last_applied_commit_sha) return { kind: 'absent' };
  const read = readManifestSync(stackName, source);
  if (read === null) return { kind: 'absent' };
  if ('corrupt' in read) {
    // An identity mismatch is not the same fault as unreadable content: the
    // file is fine, it just belongs to a different repository or ref.
    return read.corrupt.toLowerCase().includes('identity') || read.corrupt.toLowerCase().includes('mismatch')
      ? { kind: 'identity_invalid', reason: read.corrupt }
      : { kind: 'corrupt', reason: read.corrupt };
  }
  // The two records must name the same commit. The applied directory comes from
  // the manifest and the commit from the source row, so trusting them together
  // while they disagree would mint a generation that claims one commit and
  // points at another's files, which is the exact false proof this migration
  // exists to avoid. An adopted manifest carries no commit at all, which is a
  // different fact about a different situation and gets its own answer.
  if (read.resolvedRevision.commitSha.length === 0) return { kind: 'commit_unresolved' };
  if (read.resolvedRevision.commitSha !== source.last_applied_commit_sha) {
    return { kind: 'commit_mismatch', manifestCommitSha: read.resolvedRevision.commitSha };
  }
  return {
    kind: 'trusted',
    commitSha: source.last_applied_commit_sha,
    manifestVersion: read.manifestVersion,
    appliedDir: read.generation.appliedDir,
  };
}

/**
 * The manifest read, resolved synchronously.
 *
 * Migration runs inside one transaction per stack, and better-sqlite3
 * transactions cannot await, so the read is performed before the transaction
 * opens and passed in.
 */
let manifestReader: (stackName: string, source: StackGitSource) => ManifestReadResult = () => null;
type ManifestReadResult =
  | { manifestVersion: number; generation: { appliedDir: string }; resolvedRevision: { commitSha: string } }
  | { corrupt: string }
  | null;

export function primeMigrationManifests(
  read: (stackName: string, source: StackGitSource) => ManifestReadResult,
): void {
  manifestReader = read;
}

function readManifestSync(stackName: string, source: StackGitSource): ManifestReadResult {
  return manifestReader(stackName, source);
}

/** Read every manifest up front, so the per-stack transaction stays synchronous. */
export async function loadMigrationManifests(): Promise<void> {
  const manifestSvc = GitProjectManifestService.getInstance();
  const cache = new Map<string, ManifestReadResult>();
  for (const source of DatabaseService.getInstance().getGitSources()) {
    try {
      cache.set(source.stack_name, await manifestSvc.readManifest(source.stack_name, source.repo_url, source.branch));
    } catch (error) {
      cache.set(source.stack_name, { corrupt: error instanceof Error ? error.message : String(error) });
    }
  }
  primeMigrationManifests((stackName) => cache.get(stackName) ?? null);
}

/**
 * Every reason this stack could not be fully described, as recorded evidence.
 *
 * A legacy applied commit that could not be proven appears here and nowhere
 * else. Putting it on a canonical pointer would assert that the stack is at
 * that commit under the current configuration, which is exactly what could not
 * be established.
 */
function collectLimitations(source: StackGitSource, trust: ManifestTrust): GitOpsEvidenceLimitation[] {
  const limitations: GitOpsEvidenceLimitation[] = [];
  const legacySha = source.last_applied_commit_sha;
  if (legacySha) {
    if (trust.kind === 'absent') limitations.push({ code: 'manifest_absent', detail: legacySha });
    if (trust.kind === 'corrupt') limitations.push({ code: 'manifest_corrupt', detail: legacySha });
    if (trust.kind === 'identity_invalid') limitations.push({ code: 'manifest_identity_invalid', detail: legacySha });
    if (trust.kind === 'commit_unresolved') {
      limitations.push({ code: 'manifest_commit_unresolved', detail: legacySha });
    }
    // Both commits are named: which record is right cannot be decided here, and
    // an operator reading one of them alone has no way to see the disagreement.
    if (trust.kind === 'commit_mismatch') {
      limitations.push({
        code: 'manifest_commit_mismatch',
        detail: `${legacySha} (recorded) vs ${trust.manifestCommitSha} (manifest)`,
      });
    }
  }
  // A pending pull proves nothing about the current repository or ref: the blob
  // predates any configuration change and carries no identity stamp.
  if (source.pending_commit_sha && source.pending_commit_sha !== legacySha) {
    limitations.push({ code: 'legacy_pending', detail: source.pending_commit_sha });
  }
  return limitations;
}

function encodeLimitations(limitations: GitOpsEvidenceLimitation[]): string | null {
  let encoded: string | null = null;
  for (const limitation of limitations) {
    encoded = encodeGitOpsEvidenceLimitations(
      encoded ? JSON.parse(encoded) as GitOpsEvidenceLimitation[] : [],
      limitation.code,
      limitation,
    );
  }
  return encoded;
}

function stackDirectoryPresent(stackName: string, nodeId: number): boolean {
  try {
    const base = path.resolve(FileSystemService.getInstance(nodeId).getBaseDir());
    const resolved = path.resolve(base, stackName);
    if (!resolved.startsWith(base + path.sep)) return false;
    return fs.statSync(resolved).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    // Cannot prove it is gone, so treat it as present: tombstoning a stack that
    // is actually there is the unrecoverable mistake.
    return true;
  }
}

/**
 * Bring Blueprints that predate the revision state model into it.
 *
 * Every Blueprint gets an application, an intent describing what it currently
 * asks for, and a candidate marked as coming from the legacy inline record.
 * None of that is an acknowledgement. The Blueprint revision and the
 * deployment's applied revision are carried as display only, because neither
 * proves a node is running the intent this pass just minted, and recording them
 * as agreement would report convergence nobody verified.
 */
export function migrateInlineBlueprints(): MigrationResult[] {
  const db = DatabaseService.getInstance();
  const results: MigrationResult[] = [];
  for (const blueprint of db.listBlueprints()) {
    try {
      results.push(migrateOneBlueprint(blueprint));
    } catch (error) {
      console.error(
        `[GitOps] Could not migrate the blueprint ${sanitizeForLog(blueprint.name)}; retrying next boot:`,
        error instanceof Error ? error.stack ?? error.message : String(error),
      );
      results.push({ stackName: blueprint.name, outcome: 'failed' });
    }
  }
  return results;
}

function migrateOneBlueprint(blueprint: Blueprint): MigrationResult {
  const store = GitOpsStore.getInstance();
  const fingerprint = intentFingerprint(blueprint);
  const scope = `inline_blueprint:${blueprint.id}`;

  const checkpoint = store.getMigrationCheckpoint(scope);
  if (
    checkpoint
    && checkpoint.schema_version === MIGRATION_SCHEMA_VERSION
    && checkpoint.fingerprint === fingerprint
  ) {
    return { stackName: blueprint.name, outcome: 'skipped_current' };
  }

  // A Blueprint created through the new path already describes itself, and its
  // rows were written with proof this pass does not have.
  if (store.getLiveBlueprintApplication(blueprint.id)) {
    store.upsertMigrationCheckpoint(scope, MIGRATION_SCHEMA_VERSION, fingerprint, Date.now());
    return { stackName: blueprint.name, outcome: 'skipped_live_application' };
  }

  const at = Date.now();
  const envelope: EventEnvelope = {
    operationId: newGitOpsId(),
    actor: 'system:migration',
    trigger: 'migrate',
    at,
  };
  const applicationId = newGitOpsId();
  const intentId = newGitOpsId();

  return DatabaseService.getInstance().getDb().transaction((): MigrationResult => {
    const tx = GitOpsTransitions.getInstance();
    tx.activateInlineBlueprint({
      application: {
        ...blankInlineApplication(applicationId, blueprint.id, at),
        evidence_limitations_json: encodeLimitations(inlineApprovalLimitations(blueprint)),
      },
      envelope,
    });

    tx.intentRevised({
      applicationId,
      intent: {
        id: intentId,
        application_id: applicationId,
        blueprint_id: blueprint.id,
        compose_content_sha256: createHash('sha256').update(blueprint.compose_content, 'utf8').digest('hex'),
        // Display only. A revision is not an acknowledgement: nothing here
        // proves a node is running what this intent describes.
        blueprint_revision: blueprint.revision,
        deploy_stack_name: blueprint.name,
        selector_json: JSON.stringify(blueprint.selector),
        pinned_node_id: blueprint.pinned_node_id,
        cordon_implications_json: JSON.stringify({ pinnedOverridesCordon: blueprint.pinned_node_id !== null }),
        rollout_strategy_json: JSON.stringify({ driftMode: blueprint.drift_mode, enabled: blueprint.enabled }),
        runtime_drift_policy: blueprint.drift_mode,
        stateful_policy_json: null,
        health_failure_rollback_policy_json: null,
        operation_id: envelope.operationId,
        actor: envelope.actor,
        created_at: at,
      },
      envelope,
    });

    tx.rolloutCandidateOpened({
      applicationId,
      candidate: {
        id: newGitOpsId(),
        application_id: applicationId,
        intent_revision_id: intentId,
        compose_content_sha256: createHash('sha256').update(blueprint.compose_content, 'utf8').digest('hex'),
        accepted_generation_id: null,
        artifact_set_id: null,
        // Placement is not resolved here. Migration records what the Blueprint
        // asks for, never which nodes currently satisfy it.
        required_targets_json: JSON.stringify({ nodeIds: [] }),
        authoritative: 1,
        provenance: 'legacy_inline',
        operation_id: envelope.operationId,
        created_at: at,
      },
      envelope,
    });

    store.upsertMigrationCheckpoint(scope, MIGRATION_SCHEMA_VERSION, fingerprint, at);
    return { stackName: blueprint.name, outcome: 'migrated_inline' };
  })();
}

/**
 * Why an approval could not be carried across.
 *
 * An approval authorizes the intent it was given for. A Blueprint edited since
 * then, or never approved, has nothing this pass can record as authority, and
 * saying so is what stops the gap reading as an approval that is simply absent.
 */
function inlineApprovalLimitations(blueprint: Blueprint): GitOpsEvidenceLimitation[] {
  const { effectiveApproval } = evaluateEffectiveApproval(blueprint, []);
  if (effectiveApproval === 'approved') return [];
  return [{ code: 'blueprint_reapproval_required', detail: String(blueprint.id) }];
}
