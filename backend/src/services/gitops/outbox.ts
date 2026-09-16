import type Database from 'better-sqlite3';
import { DatabaseService } from '../DatabaseService';
import { NodeRegistry } from '../NodeRegistry';
import { classifyHistoryRow } from './readAuth';
import { GitOpsStore } from './store';
import {
  SETTLED_ATTEMPT_PAYLOAD_VERSION,
  decodeSettledAttemptPayload,
  encodeSettledAttemptPayload,
  type SettledAttemptPayload,
} from './attemptPayload';
import { sanitizeForLog } from '../../utils/safeLog';
import type { NotificationCategory } from '../NotificationService';

type OutboxRow = {
  settled_history_id: string;
  payload_json: string;
  payload_version: number;
  created_at: number;
  updated_at: number;
  drained_at: number | null;
};

export function settledNotificationDedupeKey(settledHistoryId: string): string {
  return `gitops:settled:${settledHistoryId}`;
}

export function insertSettledOutbox(
  db: Database.Database,
  payload: SettledAttemptPayload,
): void {
  const now = payload.at;
  db.prepare(
    `INSERT INTO gitops_settled_outbox (
      settled_history_id, payload_json, payload_version, created_at, updated_at, drained_at
    ) VALUES (?, ?, ?, ?, ?, NULL)
    ON CONFLICT(settled_history_id) DO NOTHING`,
  ).run(
    payload.settledHistoryId,
    encodeSettledAttemptPayload(payload),
    SETTLED_ATTEMPT_PAYLOAD_VERSION,
    now,
    now,
  );
}

function listUndrained(db: Database.Database): OutboxRow[] {
  return db.prepare(
    `SELECT * FROM gitops_settled_outbox WHERE drained_at IS NULL ORDER BY created_at ASC, settled_history_id ASC`,
  ).all() as OutboxRow[];
}

function markDrained(db: Database.Database, settledHistoryId: string, at: number): void {
  db.prepare(
    `UPDATE gitops_settled_outbox SET drained_at = ?, updated_at = ? WHERE settled_history_id = ? AND drained_at IS NULL`,
  ).run(at, at, settledHistoryId);
}

function categoryForOutcome(outcome: string): NotificationCategory {
  if (outcome === 'blocked') return 'git_plan_blocked';
  if (outcome === 'failed_previous_intact' || outcome === 'recovery_required' || outcome === 'unknown') {
    return 'git_pull_failed';
  }
  return 'git_pull_ready';
}

function levelForOutcome(outcome: string): 'info' | 'warning' | 'error' {
  if (outcome === 'blocked') return 'warning';
  if (outcome === 'failed_previous_intact' || outcome === 'recovery_required' || outcome === 'unknown') {
    return 'error';
  }
  return 'info';
}

function fanoutNotification(payload: SettledAttemptPayload): void {
  const app = GitOpsStore.getInstance().getApplication(payload.applicationId);
  const requirement = classifyHistoryRow({
    stackName: payload.stackName,
    applicationLifecycleStatus: app?.lifecycle_status ?? null,
    stackResourcePresent: true,
  });
  const visibleStack = requirement.kind === 'stack_read' ? requirement.stackName : null;
  const label = visibleStack ?? payload.applicationId;
  const reason = payload.reason ? `: ${payload.reason}` : '';
  DatabaseService.getInstance().addNotificationHistory(
    payload.nodeId ?? NodeRegistry.getInstance().getDefaultNodeId(),
    {
      level: levelForOutcome(payload.outcome),
      category: categoryForOutcome(payload.outcome),
      message: `GitOps ${payload.outcome} for ${label}${reason}`,
      timestamp: payload.at,
      stack_name: visibleStack ?? undefined,
      actor_username: payload.actor,
      gitops_operation_id: payload.operationId,
      dedupe_key: settledNotificationDedupeKey(payload.settledHistoryId),
    },
  );
}

/**
 * Project one settled outbox row into notification_history. Idempotent:
 * already-drained rows are skipped, and the notification unique key makes a
 * replay after a crash-between-notify-and-mark a no-op insert.
 */
export function drainSettledOutboxRow(db: Database.Database, settledHistoryId: string): void {
  const row = db.prepare(
    `SELECT * FROM gitops_settled_outbox WHERE settled_history_id = ?`,
  ).get(settledHistoryId) as OutboxRow | undefined;
  if (!row || row.drained_at !== null) return;
  const decoded = decodeSettledAttemptPayload(row.payload_json, row.payload_version);
  if (!decoded.ok) {
    console.warn(
      `[GitOps] settled outbox ${sanitizeForLog(settledHistoryId)} ${decoded.limitation}; leaving undrained with no invented evidence`,
    );
    return;
  }
  try {
    fanoutNotification(decoded.payload);
  } catch (err) {
    console.error(
      `[GitOps] settled outbox notification failed for ${sanitizeForLog(settledHistoryId)}:`,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }
  markDrained(db, settledHistoryId, Date.now());
}

/**
 * Startup repair: drain every undrained settled outbox row. A second call
 * is a no-op because drained_at is set and the notification unique key
 * rejects duplicates. Unknown payload versions stay undrained so a later
 * decoder can repair them; they must not be marked drained.
 */
export function repairGitOpsSettledOutbox(db: Database.Database = DatabaseService.getInstance().getDb()): void {
  for (const row of listUndrained(db)) {
    drainSettledOutboxRow(db, row.settled_history_id);
  }
}
