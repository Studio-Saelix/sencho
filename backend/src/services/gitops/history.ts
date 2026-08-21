import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { decodeGitOpsJson, encodeGitOpsJson, isRecord, GitOpsJsonError } from './json';
import { enqueueHistoryPublication } from './publish';
import { sanitizeForLog } from '../../utils/safeLog';
import type {
  GitOpsApplicationRow,
  GitOpsApprovalRefs,
  GitOpsHistoryRow,
  GitOpsLimitation,
  GitOpsTargetMode,
} from './types';

export type HistoryOutcome = GitOpsHistoryRow['outcome'];

/**
 * Every stage a transition can record.
 *
 * The column itself is open TEXT, because a stage is an audit label rather than
 * a state and a future producer must be able to add one without a migration.
 * This union constrains the *writers*: it is what makes the set finite at
 * compile time, so the metrics keyspace is bounded by the type rather than by
 * whatever strings happen to reach the insert. Adding a producer stage without
 * adding it here fails the build, which is the point.
 */
export type GitOpsHistoryStage =
  | 'application_activated'
  | 'application_tombstoned'
  | 'applied'
  | 'apply_failed'
  | 'apply_started'
  | 'artifact_evidence_recorded'
  | 'artifact_expectation_accepted'
  | 'blueprint_ack_recorded'
  | 'blueprint_correcting'
  | 'blueprint_deploy_failed'
  | 'blueprint_deploy_started'
  | 'blueprint_drifted'
  | 'blueprint_evict_blocked'
  | 'blueprint_state_review'
  | 'blueprint_withdraw_failed'
  | 'blueprint_withdraw_started'
  | 'blueprint_withdrawn'
  | 'candidate_ready'
  | 'candidate_superseded'
  | 'config_changed_pending_cleared'
  | 'create_failed'
  | 'deploy_bound'
  | 'deploy_failed'
  | 'deploy_started'
  | 'deploy_unbound'
  | 'dismissed'
  | 'fetch_failed'
  | 'fetch_started'
  | 'fetched'
  | 'fetched_invalid'
  | 'health_finalized'
  | 'intent_revised'
  | 'operation_interrupted'
  | 'partial_cleared'
  | 'partially_rolled_out'
  | 'recovery_failed'
  | 'recovery_started'
  | 'recovery_succeeded'
  | 'rollback_completed'
  | 'rollback_in_progress'
  | 'rollback_partial_failed'
  | 'rollout_candidate_opened'
  | 'rollout_paused'
  | 'rollout_unpaused'
  | 'source_conflict_blocker'
  | 'source_retry_scheduled'
  | 'source_suspended'
  | 'source_unsuspended'
  | 'target_tombstoned';

export type HistoryInsert = {
  application: GitOpsApplicationRow;
  nodeId: number | null;
  dedupeTarget: string;
  operationId: string;
  stage: GitOpsHistoryStage;
  outcome: HistoryOutcome;
  trigger: string;
  actor: string | null;
  // Objects, not `unknown`: the read path reports a non-object payload as an
  // unreadable audit record, so a producer must not be able to author one.
  before: Record<string, unknown>;
  after: Record<string, unknown>;
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
 *
 * An inserted row is also queued for announcement here rather than at the
 * transition call sites, because this is the only place that can tell an
 * insert from a replay: the callers see a null and turn it into `replayed`,
 * by which point the distinction has already been made once.
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
  if (result.changes !== 1) return null;
  enqueueHistoryPublication({
    db,
    id,
    stage: row.stage,
    outcome: row.outcome,
    applicationId: row.application.id,
    targetMode: row.application.target_mode,
    stackName: row.application.stack_name,
    blueprintId: row.application.blueprint_id,
    nodeId: row.nodeId,
    at: row.at,
  });
  return id;
}

/** Page size when the caller does not ask for one. */
export const HISTORY_DEFAULT_LIMIT = 50;
/** Hard ceiling on page size, whatever the caller asks for. */
export const HISTORY_MAX_LIMIT = 100;
/**
 * Rows examined per request before the page is cut short.
 *
 * Authorization runs per row after the query, so a caller with narrow grants
 * could otherwise walk the whole table looking for rows they may read. This
 * bounds that per-row loop, and the cursor still advances past every examined
 * row so the next request resumes rather than rescanning. It is not a bound on
 * database work: the query itself is bounded by the index over
 * `(created_at, id)`, not by this constant.
 */
export const HISTORY_SCAN_CAP = 1000;

export type GitOpsHistoryFilters = {
  applicationId?: string;
  stackName?: string;
  /** Secret-free `repo_url`. Credentials never reach this column. */
  repoIdentity?: string;
  configuredRef?: string;
  commitSha?: string;
  generationId?: string;
  artifactSetId?: string;
  blueprintId?: number;
  rolloutCandidateId?: string;
  rolloutGenerationId?: string;
  nodeId?: number;
  trigger?: string;
  actor?: string;
  outcome?: HistoryOutcome;
};

/**
 * One history row as the API returns it.
 *
 * `before` and `after` are the producer's delta for that transition, not a full
 * revision projection: each transition records only the fields it moved. They
 * are display evidence. Authorization never reads them, so a row whose JSON is
 * unreadable still returns its identity, stage, and outcome alongside a
 * `history_json_invalid` limitation rather than vanishing from the audit trail.
 */
export type GitOpsHistoryItem = {
  id: string;
  createdAt: number;
  applicationId: string;
  targetMode: GitOpsTargetMode;
  stackName: string | null;
  blueprintId: number | null;
  nodeId: number | null;
  commitSha: string | null;
  generationId: string | null;
  artifactSetId: string | null;
  intentRevisionId: string | null;
  rolloutCandidateId: string | null;
  rolloutGenerationId: string | null;
  approvals: GitOpsApprovalRefs;
  operationId: string;
  stage: string;
  outcome: HistoryOutcome;
  trigger: string;
  actor: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  limitations: GitOpsLimitation[];
};

/**
 * Page cursor over the `(created_at, id)` ordering.
 *
 * Both halves are needed: rows written by one transaction share a single
 * timestamp by construction, so paginating on the timestamp alone would drop or
 * repeat rows at a page boundary.
 *
 * Encoded in plain text, so treat it as readable and forgeable rather than
 * opaque. That is tolerable because it only picks a start position in a scan
 * whose rows are authorized individually afterwards, but it does mean the
 * cursor discloses one row's timestamp and id to a caller who may not read that
 * row.
 */
export type GitOpsHistoryCursor = { createdAt: number; id: string };

export function encodeHistoryCursor(cursor: GitOpsHistoryCursor): string {
  return `${cursor.createdAt}.${cursor.id}`;
}

/** History ids are minted with `randomUUID()`, so anything else is not one. */
const HISTORY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Parse a caller-supplied cursor, returning null for anything malformed.
 *
 * Both halves are validated. The id half matters as much as the timestamp: it
 * is compared as a string in the page query, so an unvalidated one would not
 * fail, it would silently include or exclude an arbitrary slice of the rows
 * sharing that millisecond. Callers turn null into a 400 rather than starting
 * over, because quietly serving page one to someone who asked to resume is the
 * kind of wrong answer an audit reader cannot detect.
 */
export function decodeHistoryCursor(raw: string): GitOpsHistoryCursor | null {
  const separator = raw.indexOf('.');
  if (separator <= 0 || separator === raw.length - 1) return null;
  const createdAt = Number(raw.slice(0, separator));
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) return null;
  const id = raw.slice(separator + 1);
  if (!HISTORY_ID_RE.test(id)) return null;
  return { createdAt, id };
}

/**
 * Decode one history JSON column into its delta object.
 *
 * `null` means the column could not be read as an object. The caller turns that
 * into the row's `history_json_invalid` limitation so the entry survives, and
 * the reason is logged here because a corrupt audit column is a storage problem
 * an operator needs to see rather than a routine response variation.
 */
function decodeHistoryDelta(rowId: string, column: string, raw: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = decodeGitOpsJson(raw);
  } catch (error) {
    if (!(error instanceof GitOpsJsonError)) throw error;
    console.error(`[GitOps] history ${sanitizeForLog(rowId)}.${column} is not decodable JSON: ${error.message}`);
    return null;
  }
  if (!isRecord(value)) {
    console.error(`[GitOps] history ${sanitizeForLog(rowId)}.${column} decoded to ${typeof value}, expected an object`);
    return null;
  }
  return value;
}

export function toHistoryItem(row: GitOpsHistoryRow): GitOpsHistoryItem {
  const before = decodeHistoryDelta(row.id, 'before', row.before_json);
  const after = decodeHistoryDelta(row.id, 'after', row.after_json);
  const limitations: GitOpsLimitation[] = [];
  if (before === null || after === null) {
    limitations.push({
      code: 'history_json_invalid',
      message: 'Recorded change detail for this entry could not be read.',
      evidence: { before: before === null, after: after === null },
    });
  }
  return {
    id: row.id,
    createdAt: row.created_at,
    applicationId: row.application_id,
    targetMode: row.target_mode,
    stackName: row.stack_name,
    blueprintId: row.blueprint_id,
    nodeId: row.node_id,
    commitSha: row.commit_sha,
    generationId: row.generation_id,
    artifactSetId: row.artifact_set_id,
    intentRevisionId: row.intent_revision_id,
    rolloutCandidateId: row.rollout_candidate_id,
    rolloutGenerationId: row.rollout_generation_id,
    approvals: {
      sourceAcceptanceRef: row.source_acceptance_ref,
      placementApprovalRef: row.placement_approval_ref,
      rolloutAuthorizationRef: row.rollout_authorization_ref,
      legacyCombinedApprovalRef: row.legacy_combined_approval_ref,
    },
    operationId: row.operation_id,
    stage: row.stage,
    outcome: row.outcome,
    trigger: row.trigger,
    actor: row.actor,
    before,
    after,
    limitations,
  };
}

/**
 * Read one scan window of history rows, newest first.
 *
 * Returns raw rows rather than a finished page because authorization is decided
 * per row by the caller, which owns the permission context. The caller stops
 * once its page is full and uses the last row it *examined* (not the last it
 * kept) as the next cursor, so skipped rows are never revisited.
 */
export function queryHistoryRows(
  db: Database.Database,
  filters: GitOpsHistoryFilters,
  cursor: GitOpsHistoryCursor | null,
  scanLimit: number,
): GitOpsHistoryRow[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  const eq = (column: string, value: string | number | undefined): void => {
    if (value === undefined) return;
    clauses.push(`${column} = ?`);
    params.push(value);
  };

  eq('application_id', filters.applicationId);
  eq('stack_name', filters.stackName);
  eq('repo_url', filters.repoIdentity);
  eq('configured_ref', filters.configuredRef);
  eq('commit_sha', filters.commitSha);
  eq('generation_id', filters.generationId);
  eq('artifact_set_id', filters.artifactSetId);
  eq('blueprint_id', filters.blueprintId);
  eq('rollout_candidate_id', filters.rolloutCandidateId);
  // Distinct columns on purpose: a candidate is a proposal, a generation is a
  // rollout that ran. Answering one filter from the other's column would report
  // a proposal as executed.
  eq('rollout_generation_id', filters.rolloutGenerationId);
  eq('node_id', filters.nodeId);
  eq('trigger', filters.trigger);
  eq('actor', filters.actor);
  eq('outcome', filters.outcome);

  if (cursor) {
    clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(scanLimit);
  return db.prepare(
    `SELECT * FROM gitops_history ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
  ).all(...params) as GitOpsHistoryRow[];
}
