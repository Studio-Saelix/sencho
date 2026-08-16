import fs from 'fs/promises';
import path from 'path';
import { DatabaseService, type GitSourceAppliedSpec } from '../DatabaseService';
import { FileSystemService } from '../FileSystemService';
import { GitProjectManifestService } from '../GitProjectManifestService';
import { sanitizeForLog } from '../../utils/safeLog';
import { removeOperationOwnedPaths } from './createCleanup';
import { deleteStagingMarker } from './createStagingMarker';
import { newGitOpsId, stackManagedRoot } from './directApplication';
import { GitOpsStore } from './store';
import { GitOpsTransitions } from './transitions';
import type { GitOpsCreateCheckpointRow } from './types';

/** What the sweep decided about one interrupted create. */
export type CreateRecoveryOutcome =
  | 'completed'
  | 'tombstoned'
  | 'checkpoint_cleared'
  | 'source_preserved'
  | 'retained';

export type CreateRecoveryResult = {
  stackName: string;
  applicationId: string;
  outcome: CreateRecoveryOutcome;
};

function envelopeFor(checkpoint: GitOpsCreateCheckpointRow) {
  return {
    operationId: checkpoint.operation_id,
    actor: 'system:startup',
    trigger: 'create_recovery',
    at: Date.now(),
  };
}

/**
 * Three states, because the two callers need opposite fail-safe directions.
 *
 * Teardown must not treat "cannot tell" as absent, or it would skip a directory
 * that is really there. Completion must not treat it as present, or it would
 * mark a create live on the strength of a failed stat.
 */
async function stackDirState(stackName: string): Promise<'present' | 'absent' | 'unknown'> {
  try {
    const base = FileSystemService.getInstance().getBaseDir();
    await fs.stat(path.join(base, stackName));
    return 'present';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    console.warn(
      `[GitOps] Cannot determine whether stack ${sanitizeForLog(stackName)} exists on disk:`,
      error instanceof Error ? error.message : String(error),
    );
    return 'unknown';
  }
}

/**
 * Settle every create that a previous process left in flight.
 *
 * Runs at boot, before any mutation service, and is idempotent: each row is
 * decided from the durable checkpoint phase plus what is actually on disk, so
 * a crash during recovery itself just replays on the next boot.
 *
 * The two rules that shape every branch: a create is only finished when its
 * manifest is already committed on disk, and it is only torn down after its
 * files are gone. A create whose files cannot be removed keeps its checkpoint
 * rather than being recorded as cleanly failed.
 */
export async function resolveInterruptedCreates(): Promise<CreateRecoveryResult[]> {
  const store = GitOpsStore.getInstance();
  const db = DatabaseService.getInstance();
  const results: CreateRecoveryResult[] = [];

  for (const checkpoint of store.listCreateCheckpoints()) {
    try {
      results.push(await resolveOne(checkpoint));
    } catch (error) {
      console.error(
        `[GitOps] Could not settle the interrupted create for ${sanitizeForLog(checkpoint.stack_name)}; retrying next boot:`,
        error instanceof Error ? error.stack ?? error.message : String(error),
      );
      results.push({
        stackName: checkpoint.stack_name,
        applicationId: checkpoint.application_id,
        outcome: 'retained',
      });
    }
  }

  // A creating application with no checkpoint at all cannot be finished: the
  // facts needed to complete it are gone. Tombstone it so the stack name is
  // usable again, and never touch a source row that outlived it, because the
  // conservative migration can still build a live application from that row.
  for (const app of store.listCreatingDirectApplications()) {
    if (store.getCreateCheckpoint(app.id)) continue;
    const stackName = app.stack_name ?? '';
    // Guarded per row for the same reason as the loop above: one application
    // that cannot be tombstoned must not strand the rest. A creating row that
    // survives keeps matching the live-application lookup, so every later
    // create for that name would fail until it is cleared.
    try {
      const sourceRow = stackName ? db.getGitSource(stackName) : null;
      GitOpsTransitions.getInstance().createFailed(app.id, 'create_checkpoint_missing', {
        operationId: app.latest_operation_id ?? newGitOpsId(),
        actor: 'system:startup',
        trigger: 'create_recovery',
        at: Date.now(),
      });
      results.push({
        stackName,
        applicationId: app.id,
        outcome: sourceRow ? 'source_preserved' : 'tombstoned',
      });
    } catch (error) {
      console.error(
        `[GitOps] Could not tombstone the checkpointless create for ${sanitizeForLog(stackName)}; retrying next boot:`,
        error instanceof Error ? error.stack ?? error.message : String(error),
      );
      results.push({ stackName, applicationId: app.id, outcome: 'retained' });
    }
  }

  return results;
}

async function resolveOne(checkpoint: GitOpsCreateCheckpointRow): Promise<CreateRecoveryResult> {
  const store = GitOpsStore.getInstance();
  const db = DatabaseService.getInstance();
  const app = store.getApplication(checkpoint.application_id);
  const stackName = checkpoint.stack_name;
  const managedRoot = stackManagedRoot(stackName);

  // The checkpoint outlived its application, or the create already reached its
  // success boundary. Either way there is nothing to decide: drop the
  // bookkeeping and clear any marker the last process could not.
  if (!app || app.lifecycle_status === 'active' || checkpoint.phase === 'pointers_committed') {
    store.deleteCreateCheckpoint(checkpoint.application_id);
    await deleteStagingMarker(managedRoot);
    return { stackName, applicationId: checkpoint.application_id, outcome: 'checkpoint_cleared' };
  }

  if (app.lifecycle_status !== 'creating') {
    store.deleteCreateCheckpoint(checkpoint.application_id);
    return { stackName, applicationId: checkpoint.application_id, outcome: 'checkpoint_cleared' };
  }

  // The manifest is committed on disk, so the authored project the operator
  // asked for exists. Finish the create rather than destroying it: this is the
  // same source-row plus acceptance commit the live path performs.
  if (
    checkpoint.phase === 'manifest_committed'
    && checkpoint.generation_id
    && await stackDirState(stackName) === 'present'
  ) {
    const generationId = checkpoint.generation_id;
    const appliedSpec = checkpoint.applied_spec_json
      ? JSON.parse(checkpoint.applied_spec_json) as GitSourceAppliedSpec
      : null;
    const manifest = await GitProjectManifestService.getInstance().readManifest(
      stackName, checkpoint.repo_url, checkpoint.branch,
    );
    db.getDb().transaction(() => {
      if (!db.getGitSource(stackName)) {
        db.upsertGitSource({
          stack_name: stackName,
          repo_url: checkpoint.repo_url,
          branch: checkpoint.branch,
          compose_path: checkpoint.compose_path,
          compose_paths: JSON.parse(checkpoint.compose_paths_json) as string[],
          context_dir: checkpoint.context_dir,
          sync_env: checkpoint.sync_env === 1,
          env_path: checkpoint.env_path,
          auth_type: checkpoint.auth_type as 'none' | 'token',
          encrypted_token: checkpoint.encrypted_token,
          auto_apply_on_webhook: checkpoint.auto_apply_on_webhook === 1,
          auto_deploy_on_apply: checkpoint.auto_deploy_on_apply === 1,
          last_applied_commit_sha: checkpoint.commit_sha,
          last_applied_content_hash: null,
          pending_commit_sha: null,
          pending_compose_content: null,
          pending_env_content: null,
          pending_fetched_at: null,
          last_debounce_at: null,
        });
      }
      // The insert does not carry the applied pointers, so stamp them the way
      // the live create path does. The content hash is left empty because the
      // bytes that produced it belonged to the process that crashed; the first
      // pull after recovery re-establishes it.
      db.markGitSourceApplied(stackName, checkpoint.commit_sha ?? '', '');
      // The live path also stamps the deploy spec and the manifest cache. Both
      // are load-bearing: a null spec silently reverts a multi-file stack to
      // single-file auto-discovery, and an unset manifest state makes a managed
      // stack render as unmanaged and suppresses its rollback disclosure.
      if (appliedSpec) db.setGitSourceAppliedSpec(stackName, appliedSpec);
      if (manifest && 'manifestVersion' in manifest) {
        db.setGitSourceManifestState(
          stackName,
          manifest.manifestVersion,
          manifest.state,
          manifest.generation.appliedDir,
        );
      }
      GitOpsTransitions.getInstance().applied({
        applicationId: checkpoint.application_id,
        generationId,
        artifactSetId: newGitOpsId(),
        sourceAcceptanceId: newGitOpsId(),
        authority: 'operator',
        envelope: envelopeFor(checkpoint),
        activateCreating: true,
      });
      store.updateCreateCheckpoint(checkpoint.application_id, { phase: 'pointers_committed' }, Date.now());
    })();
    store.deleteCreateCheckpoint(checkpoint.application_id);
    await deleteStagingMarker(managedRoot);
    return { stackName, applicationId: checkpoint.application_id, outcome: 'completed' };
  }

  // Everything else stopped before the project was durable. Remove exactly what
  // this operation put on disk, then record the failure. Filesystem first: if it
  // throws, the checkpoint survives and the next boot retries.
  const generation = checkpoint.generation_id ? store.getGeneration(checkpoint.generation_id) : undefined;
  // `pre_stack` is durable proof that createStack had not returned, so a
  // directory present now was not necessarily made by this operation. It could
  // be the operator's own stack that appeared while the create was fetching.
  // Removing it on that evidence is the one mistake this path cannot take back,
  // so an orphaned directory is left behind instead.
  const stackDir = await stackDirState(stackName);
  if (checkpoint.phase === 'pre_stack') {
    if (stackDir === 'present') {
      console.warn(
        `[GitOps] Leaving the directory for ${sanitizeForLog(stackName)} in place: the interrupted create never recorded creating it.`,
      );
    }
  } else if (stackDir === 'present') {
    await FileSystemService.getInstance().deleteStack(stackName);
  }
  await removeOperationOwnedPaths({
    stackManagedRoot: managedRoot,
    candidateRelPath: generation?.candidate_dir ?? null,
    appliedRelPath: generation?.applied_dir ?? null,
    ownsManagedRoot: checkpoint.created_managed_root === 1,
  });

  GitOpsTransitions.getInstance().createFailed(
    checkpoint.application_id,
    'interrupted_create',
    envelopeFor(checkpoint),
  );
  return { stackName, applicationId: checkpoint.application_id, outcome: 'tombstoned' };
}
