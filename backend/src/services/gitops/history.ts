import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { encodeGitOpsJson } from './json';
import type { GitOpsApplicationRow, GitOpsHistoryRow, GitOpsTargetMode } from './types';

export type HistoryOutcome = GitOpsHistoryRow['outcome'];

export type HistoryInsert = {
  application: GitOpsApplicationRow;
  nodeId: number | null;
  dedupeTarget: string;
  operationId: string;
  stage: string;
  outcome: HistoryOutcome;
  trigger: string;
  actor: string | null;
  before: unknown;
  after: unknown;
  generationId?: string | null;
  artifactSetId?: string | null;
  commitSha?: string | null;
  intentRevisionId?: string | null;
  rolloutCandidateId?: string | null;
  sourceAcceptanceRef?: string | null;
  placementApprovalRef?: string | null;
  rolloutAuthorizationRef?: string | null;
  legacyCombinedApprovalRef?: string | null;
  requiredTargetsJson?: string | null;
  recoveryRef?: string | null;
  redactedReasonClass?: string | null;
  at: number;
};

/**
 * Append one history row, returning null when this exact operation already
 * wrote its row (a replay).
 *
 * The conflict clause names the dedupe index deliberately rather than using
 * `INSERT OR IGNORE`: `OR IGNORE` also swallows NOT NULL and CHECK violations,
 * which would drop an audit row while the state change committed and report it
 * to the caller as a harmless replay. Only a duplicate of the dedupe tuple is
 * tolerated here; every other constraint failure throws and rolls the
 * transaction back. Callers turn a null return into `replayed: true`, so the
 * dedupe index is load-bearing for idempotency, not just for storage hygiene.
 */
export function insertHistory(db: Database.Database, row: HistoryInsert): string | null {
  const id = randomUUID();
  const result = db.prepare(
    `INSERT INTO gitops_history (
      id, created_at, application_id, target_mode, lifecycle_key, stack_name, blueprint_id,
      node_id, dedupe_target, repo_url, configured_ref, repo_identity_json, commit_sha,
      generation_id, artifact_set_id, intent_revision_id, rollout_candidate_id, rollout_generation_id,
      source_acceptance_ref, placement_approval_ref, rollout_authorization_ref,
      legacy_combined_approval_ref, operation_id, stage, outcome, trigger, actor,
      before_json, after_json, required_targets_json, validation_json, per_target_results_json,
      health_run_id, health_snapshot_json, invocation_observed_json, recovery_ref, redacted_reason_class
    ) VALUES (${Array(37).fill('?').join(', ')})
    ON CONFLICT(application_id, operation_id, stage, dedupe_target) DO NOTHING`,
  ).run(
    id,
    row.at,
    row.application.id,
    row.application.target_mode as GitOpsTargetMode,
    row.application.lifecycle_key,
    row.application.stack_name,
    row.application.blueprint_id,
    row.nodeId,
    row.dedupeTarget,
    row.application.configured_repo_url,
    row.application.configured_ref,
    row.application.repo_identity_json,
    row.commitSha ?? row.application.desired_commit_sha,
    row.generationId ?? null,
    row.artifactSetId ?? null,
    row.intentRevisionId ?? row.application.intent_revision_id,
    row.rolloutCandidateId ?? row.application.rollout_candidate_id,
    row.application.rollout_generation_id,
    row.sourceAcceptanceRef ?? row.application.source_acceptance_ref,
    row.placementApprovalRef ?? row.application.placement_approval_ref,
    row.rolloutAuthorizationRef ?? row.application.rollout_authorization_ref,
    row.legacyCombinedApprovalRef ?? row.application.legacy_combined_approval_ref,
    row.operationId,
    row.stage,
    row.outcome,
    row.trigger,
    row.actor,
    encodeGitOpsJson(row.before),
    encodeGitOpsJson(row.after),
    row.requiredTargetsJson ?? null,
    null,
    null,
    null,
    null,
    null,
    row.recoveryRef ?? null,
    row.redactedReasonClass ?? null,
  );
  return result.changes === 1 ? id : null;
}
