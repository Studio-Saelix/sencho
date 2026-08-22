/**
 * Announcing transitions after they commit.
 *
 * A history row that is inserted and still present when the drain runs produces
 * one metric increment and, when a sink is installed, one `state-invalidate`
 * event. Both have to happen *after* the transaction that wrote the row, and
 * neither may happen for a transaction that rolled back, which is why nothing
 * here runs inline.
 *
 * The mechanism is a buffer drained on `setImmediate`. better-sqlite3 is fully
 * synchronous, so by the time a macrotask runs, the transaction that enqueued
 * the row has committed or rolled back, and so has any outer transaction
 * wrapping it. That matters: several producers wrap a handful of transitions in
 * one outer transaction, and a publisher that fired when the innermost one
 * returned would announce work that a later statement then discarded. Waiting
 * for the macrotask covers both nesting depths without having to detect which
 * one it is in.
 *
 * Rollback needs no detection either. The drain checks that each row is still
 * there before announcing it, so a discarded transaction publishes nothing on
 * its own. A replay publishes nothing for a different reason: the dedupe index
 * means no row was inserted, so nothing was ever enqueued.
 *
 * The event sink is injected rather than imported. Reaching into
 * NotificationService from inside the GitOps layer would close a module cycle
 * of exactly the kind that once made an imported constant evaluate as
 * `undefined` here, and injection also lets the tests observe events without
 * standing up the notification stack.
 */
import type Database from 'better-sqlite3';
import { GitOpsMetricsService } from '../GitOpsMetricsService';
import type { GitOpsHistoryStage, HistoryOutcome } from './history';
import type { GitOpsTargetMode } from './types';

/**
 * The `state-invalidate` payload one committed transition produces.
 *
 * A type alias rather than an interface so it satisfies the broadcaster's
 * open envelope parameter: TypeScript infers an implicit index signature for
 * the former and not the latter.
 */
export type GitOpsInvalidateEvent = {
  type: 'state-invalidate';
  scope: 'gitops';
  /** The transition's stage, so a client can tell a fetch from a deploy. */
  action: GitOpsHistoryStage;
  applicationId: string;
  targetMode: GitOpsTargetMode;
  stackName: string | null;
  blueprintId: number | null;
  nodeId: number | null;
  ts: number;
};

/**
 * Pins the requirement the alias above exists to satisfy.
 *
 * Without this, switching `type` to `interface` compiles here and fails at the
 * startup wiring in another module, as an index-signature complaint that says
 * nothing about the cause. The failure belongs at the declaration.
 */
type AssertsOpenEnvelope =
  GitOpsInvalidateEvent extends { type: string; [key: string]: unknown } ? true : never;
const _openEnvelope: AssertsOpenEnvelope = true;
void _openEnvelope;

export type GitOpsEventSink = (event: GitOpsInvalidateEvent) => void;

/** What the drain needs to know, captured while it is still typed. */
interface PendingRow {
  db: Database.Database;
  id: string;
  stage: GitOpsHistoryStage;
  outcome: HistoryOutcome;
  applicationId: string;
  targetMode: GitOpsTargetMode;
  stackName: string | null;
  blueprintId: number | null;
  nodeId: number | null;
  at: number;
}

let sink: GitOpsEventSink | null = null;
let pending: PendingRow[] = [];
let scheduled = false;
let warnedUnannounced = false;

/**
 * Say once that transitions are committing with nobody to announce them to.
 *
 * A server that never installs the sink still counts every transition and
 * still writes every history row, so the only symptom is that no client ever
 * refreshes: the UI silently goes back to being as stale as it was before any
 * of this existed. That is precisely the kind of unwired producer this branch
 * has already shipped once, so it says so rather than being inferred from an
 * absence. Once, not per row: a boot migration would otherwise fill the log,
 * and the second occurrence tells a reader nothing the first did not.
 */
function warnUnannounced(): void {
  if (warnedUnannounced) return;
  warnedUnannounced = true;
  console.warn('[GitOps] Transitions are committing with no event sink installed; no client will be told about them.');
}

/**
 * Install the broadcaster. Called once at startup, and with null by tests that
 * want the metrics side without the event side.
 */
export function setGitOpsEventSink(next: GitOpsEventSink | null): void {
  sink = next;
}

/**
 * Queue one inserted history row for announcement.
 *
 * Called only where a row was genuinely inserted. The stage and outcome are
 * carried from the insert rather than read back, because they are already typed
 * there and re-reading them would turn a closed union into an unvalidated
 * column value.
 */
export function enqueueHistoryPublication(row: PendingRow): void {
  pending.push(row);
  if (scheduled) return;
  scheduled = true;
  setImmediate(drain);
}

function drain(): void {
  scheduled = false;
  const batch = pending;
  pending = [];
  const metrics = GitOpsMetricsService.getInstance();

  for (const row of batch) {
    if (!survived(row)) continue;
    metrics.record(row.stage, row.outcome);
    if (!sink) {
      warnUnannounced();
      continue;
    }
    announce(sink, row);
  }
}

/**
 * Hand one committed transition to the broadcaster.
 *
 * A throw is logged and swallowed: one client's broadcast must not cost the
 * rest of the batch their events, and none of this is worth failing a
 * committed transition over.
 */
function announce(to: GitOpsEventSink, row: PendingRow): void {
  try {
    to({
      type: 'state-invalidate',
      scope: 'gitops',
      action: row.stage,
      applicationId: row.applicationId,
      targetMode: row.targetMode,
      stackName: row.stackName,
      blueprintId: row.blueprintId,
      nodeId: row.nodeId,
      ts: row.at,
    });
  } catch (error) {
    console.error(
      '[GitOps] Could not announce %s for application %s:',
      row.stage, row.applicationId,
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
  }
}

/**
 * Whether the row is still in the table.
 *
 * A missing row means its transaction rolled back, which is an ordinary
 * outcome and not worth logging. A failed *query* is different: it means the
 * check itself could not be made, so the row is treated as gone rather than
 * announced on the strength of a lookup that did not answer.
 */
function survived(row: PendingRow): boolean {
  try {
    return row.db.prepare('SELECT 1 FROM gitops_history WHERE id = ?').get(row.id) !== undefined;
  } catch (error) {
    console.error(
      '[GitOps] Could not confirm history row %s before announcing it:',
      row.id,
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    return false;
  }
}

/** Drop anything queued and uninstall the sink, so one test cannot reach the next. */
export function resetGitOpsPublicationsForTests(): void {
  pending = [];
  sink = null;
  scheduled = false;
  warnedUnannounced = false;
}
