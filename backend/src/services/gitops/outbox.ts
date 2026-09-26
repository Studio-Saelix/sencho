/**
 * Crash-safe fanout from a committed history row to the notification history.
 *
 * One row per notifiable transition, written in the same transaction as the
 * history row it announces (`history.ts`), so a transaction that rolls back
 * leaves no notification intent behind and a committed one can be repaired
 * after a crash. The row carries a versioned payload: v1 is a settled source
 * attempt (outcome-dependent mapping), v2 is one notifiable decision or hold
 * (stage-dependent mapping). Unknown versions and unreadable payloads stay
 * undrained rather than being guessed at.
 *
 * The table keeps its original name. It is one outbox carrying two payload
 * kinds, and renaming it would be a migration with no behavior behind it.
 */
import type Database from 'better-sqlite3';
import { DatabaseService } from '../DatabaseService';
import { NodeRegistry } from '../NodeRegistry';
import { classifyHistoryRow } from './readAuth';
import { GitOpsStore } from './store';
import {
  GITOPS_EVENT_PAYLOAD_VERSION,
  SETTLED_ATTEMPT_PAYLOAD_VERSION,
  decodeGitOpsEventPayload,
  decodeSettledAttemptPayload,
  encodeGitOpsEventPayload,
  encodeSettledAttemptPayload,
  type GitOpsDecodeResult,
  type GitOpsEventPayload,
  type SettledAttemptPayload,
} from './attemptPayload';
import { GITOPS_NOTIFICATION_META } from './notifications';
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

/**
 * Dedupe key for one event notification.
 *
 * Distinct from the settled prefix so the two kinds stay tellable apart in
 * `notification_history`, and stable per history row so a replay after a crash
 * between insert and mark-drained collides with the first notification instead
 * of producing a second.
 */
export function gitOpsEventNotificationDedupeKey(historyId: string): string {
  return `gitops:event:${historyId}`;
}

function insertOutboxRow(
  db: Database.Database,
  historyId: string,
  payloadJson: string,
  payloadVersion: number,
  at: number,
): void {
  db.prepare(
    `INSERT INTO gitops_settled_outbox (
      settled_history_id, payload_json, payload_version, created_at, updated_at, drained_at
    ) VALUES (?, ?, ?, ?, ?, NULL)
    ON CONFLICT(settled_history_id) DO NOTHING`,
  ).run(historyId, payloadJson, payloadVersion, at, at);
}

export function insertSettledOutbox(
  db: Database.Database,
  payload: SettledAttemptPayload,
): void {
  insertOutboxRow(
    db,
    payload.settledHistoryId,
    encodeSettledAttemptPayload(payload),
    SETTLED_ATTEMPT_PAYLOAD_VERSION,
    payload.at,
  );
}

export function insertGitOpsEventOutbox(
  db: Database.Database,
  payload: GitOpsEventPayload,
): void {
  insertOutboxRow(
    db,
    payload.historyId,
    encodeGitOpsEventPayload(payload),
    GITOPS_EVENT_PAYLOAD_VERSION,
    payload.at,
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

/**
 * Resolve the name a notification is allowed to show.
 *
 * Shared by both payload kinds so a GitOps notification never names a stack
 * the classifier would refuse: lifecycle comes from the application row and
 * stack presence is asserted, because the fanout runs after the transition
 * that committed the fact and has no stack resource list to consult.
 *
 * A Git-managed Blueprint application carries no stack name of its own (its
 * deploy stack is derived per target), so every other surface names it by its
 * Blueprint. Falling straight through to the application id here would leave
 * an operator reading a UUID in the bell, so the Blueprint name is resolved
 * for the same reason the portfolio resolves it, with the application id as
 * the last resort when even the Blueprint row is gone.
 */
function notificationLabel(applicationId: string, stackName: string | null): {
  visibleStack: string | null;
  label: string;
} {
  const app = GitOpsStore.getInstance().getApplication(applicationId);
  const requirement = classifyHistoryRow({
    stackName,
    applicationLifecycleStatus: app?.lifecycle_status ?? null,
    stackResourcePresent: true,
  });
  const visibleStack = requirement.kind === 'stack_read' ? requirement.stackName : null;
  if (visibleStack) return { visibleStack, label: visibleStack };
  const blueprint = app?.blueprint_id != null
    ? DatabaseService.getInstance().getBlueprint(app.blueprint_id)
    : undefined;
  return {
    visibleStack: null,
    label: blueprint ? `Blueprint "${blueprint.name}"` : applicationId,
  };
}

function fanoutSettledNotification(payload: SettledAttemptPayload): void {
  const { visibleStack, label } = notificationLabel(payload.applicationId, payload.stackName);
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
 * Project one authority or lifecycle decision into notification_history.
 *
 * The message takes its fixed text from the closed stage mapping; the payload
 * contributes only the reason suffix and the stack name the label may use, so
 * a rewritten payload cannot produce a phrase the mapping does not define.
 */
function fanoutGitOpsEvent(payload: GitOpsEventPayload): void {
  const { visibleStack, label } = notificationLabel(payload.applicationId, payload.stackName);
  const meta = GITOPS_NOTIFICATION_META[payload.stage];
  const reason = payload.reason ? `: ${payload.reason}` : '';
  DatabaseService.getInstance().addNotificationHistory(
    payload.nodeId ?? NodeRegistry.getInstance().getDefaultNodeId(),
    {
      level: meta.level,
      category: meta.category,
      message: `GitOps ${meta.phrase} for ${label}${reason}`,
      timestamp: payload.at,
      stack_name: visibleStack ?? undefined,
      actor_username: payload.actor,
      gitops_operation_id: payload.operationId,
      dedupe_key: gitOpsEventNotificationDedupeKey(payload.historyId),
    },
  );
}

/**
 * Decode, fan out, and mark one outbox row, in that order.
 *
 * A payload that cannot be decoded is left undrained with its limitation
 * logged, so a later decoder can repair it rather than the row being dropped
 * or notified from a guess. A fanout that throws is left undrained too: the
 * notification was not written, and marking it drained would lose it.
 */
function drainDecodedRow<T>(
  db: Database.Database,
  historyId: string,
  decoded: GitOpsDecodeResult<T>,
  fanout: (payload: T) => void,
): void {
  if (!decoded.ok) {
    console.warn(
      `[GitOps] outbox ${sanitizeForLog(historyId)} ${decoded.limitation}; leaving undrained with no invented evidence`,
    );
    return;
  }
  try {
    fanout(decoded.payload);
  } catch (err) {
    console.error(
      `[GitOps] outbox notification failed for ${sanitizeForLog(historyId)}:`,
      sanitizeForLog(err instanceof Error ? err.message : String(err)),
    );
    return;
  }
  markDrained(db, historyId, Date.now());
}

/**
 * Project one outbox row into notification_history, by payload version.
 * Idempotent: already-drained rows are skipped, and the notification unique
 * key makes a replay after a crash-between-notify-and-mark a no-op insert.
 *
 * The body is total on purpose. The live drain runs on a macrotask with no
 * caller, so a storage error escaping here would be an uncaught exception
 * that ends the process; the row stays undrained and the next boot's repair
 * retries it. An unrecognized version logs a kind-neutral code rather than
 * being handed to the v1 decoder, whose limitation string would name the
 * wrong payload kind.
 */
export function drainGitOpsOutboxRow(db: Database.Database, historyId: string): void {
  try {
    const row = db.prepare(
      `SELECT * FROM gitops_settled_outbox WHERE settled_history_id = ?`,
    ).get(historyId) as OutboxRow | undefined;
    if (!row || row.drained_at !== null) return;
    if (row.payload_version === GITOPS_EVENT_PAYLOAD_VERSION) {
      drainDecodedRow(
        db,
        historyId,
        decodeGitOpsEventPayload(row.payload_json, row.payload_version),
        fanoutGitOpsEvent,
      );
      return;
    }
    if (row.payload_version === SETTLED_ATTEMPT_PAYLOAD_VERSION) {
      drainDecodedRow(
        db,
        historyId,
        decodeSettledAttemptPayload(row.payload_json, row.payload_version),
        fanoutSettledNotification,
      );
      return;
    }
    console.warn(
      `[GitOps] outbox ${sanitizeForLog(historyId)} gitops_outbox_payload_version_unsupported:${row.payload_version}; leaving undrained with no invented evidence`,
    );
  } catch (err) {
    console.error(
      `[GitOps] outbox drain failed for ${sanitizeForLog(historyId)}:`,
      sanitizeForLog(err instanceof Error ? err.message : String(err)),
    );
  }
}

/**
 * Startup repair: drain every undrained outbox row. A second call is a no-op
 * because drained_at is set and the notification unique key rejects
 * duplicates. Unknown payload versions stay undrained so a later decoder can
 * repair them; they must not be marked drained.
 */
export function repairGitOpsOutbox(db: Database.Database = DatabaseService.getInstance().getDb()): void {
  for (const row of listUndrained(db)) {
    drainGitOpsOutboxRow(db, row.settled_history_id);
  }
}
