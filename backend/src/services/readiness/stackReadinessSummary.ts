import { CacheService } from '../CacheService';
import { DatabaseService, type StackUpdateDetail } from '../DatabaseService';
import { FileSystemService } from '../FileSystemService';
import { UpdateGuardService } from '../UpdateGuardService';
import { mapWithConcurrency } from '../../utils/mapWithConcurrency';
import { withTimeout, TimeoutError } from '../../utils/withTimeout';
import { redactSensitiveText, sanitizeForLog } from '../../utils/safeLog';
import { getErrorMessage } from '../../utils/errors';
import type { ReadinessSignal, RollbackReadinessItem } from '../updateGuard/types';
import type { NodeStackReadinessSummary, ReadinessReasonCode, StackReadinessRow } from './types';

/**
 * What one pass produces. Excludes `stale`: a pass cannot know whether its own
 * verdicts will still be the newest when they are served, so the served
 * boundary derives that field rather than the pass asserting it.
 */
type StackReadinessPass = Omit<NodeStackReadinessSummary, 'stale'>;

/**
 * Ceiling on one pass, started before the stack list is read so the scan's cost
 * comes out of the same budget. It bounds the pass rather than each stack:
 * concurrent stacks each get whatever is left, so the ceiling holds however many
 * are in flight. Deliberately under the hub's budget for this route so the node
 * answers with partial results instead of the hub timing out and learning
 * nothing about any stack.
 */
const PASS_DEADLINE_MS = 6_000;
const CONCURRENCY = 3;
/**
 * Stacks evaluated live in one pass. Stacks past this bound are omitted from
 * `stacks` rather than emitted as placeholder rows, so the payload stays
 * bounded by the cap however large the node is. The omission is reported by
 * `truncated`; a caller that wants the unevaluated count compares the row count
 * against the stack count it read for the same node, which is a different read
 * and can disagree if the compose directory changed in between.
 */
const MAX_STACKS = 25;
const CACHE_TTL_MS = 120_000;

/**
 * Worst-first, mirroring `aggregateVerdict` (`updateGuard/readiness.ts`):
 * blocked, then attention, then a verdict-affecting unknown, then warning. The
 * unknown-over-warning order is the canonical one and is not the same as
 * reading the verdict names alphabetically; getting it backwards would quote a
 * warning as the reason for an `unknown` verdict.
 */
const SIGNAL_RANK: Record<ReadinessSignal['status'], number> = {
  blocked: 4,
  attention: 3,
  unknown: 2,
  warning: 1,
  ok: 0,
};

/**
 * The rollback items that can move `aggregateRollbackOverall`
 * (`updateGuard/readiness.ts`), which is the only reason to consider them here.
 * `volume_data`, `healthchecks`, `last_deploy`, `managed_inputs`, and
 * `recovery_generation` are disclosures that never gate the overall state, so a
 * stack whose rollback is not ready must not be explained by the paragraph about
 * application data not being included in recovery generations.
 *
 * Worst-first within that set: a known problem (blocked, missing) outranks a
 * not-knowable one (unknown), which outranks a caveat (warning).
 */
const ROLLBACK_GATING_IDS: ReadonlySet<RollbackReadinessItem['id']> = new Set([
  'policy_eligibility',
  'sops_keys',
  'compose_source',
  'env_keys',
  'previous_images',
]);

const ROLLBACK_RANK: Record<RollbackReadinessItem['state'], number> = {
  blocked: 4,
  missing: 3,
  unknown: 2,
  warning: 1,
  not_covered: 0,
  ready: 0,
};

/**
 * The signal that moved the verdict. Only signals flagged `affectsVerdict` are
 * considered: an informational signal did not produce the verdict, so quoting
 * it here would explain something the verdict does not rest on. Ties go to the
 * first signal in canonical order, so the answer is stable across passes.
 *
 * A detail that redacts to nothing is indistinguishable from a signal that
 * carried no detail, which is why both return null rather than an empty string.
 */
function strongestUpdateReason(signals: ReadinessSignal[]): string | null {
  let best: ReadinessSignal | null = null;
  for (const signal of signals) {
    if (!signal.affectsVerdict || signal.status === 'ok') continue;
    if (best === null || SIGNAL_RANK[signal.status] > SIGNAL_RANK[best.status]) best = signal;
  }
  return best ? redactSensitiveText(best.detail) || null : null;
}

/**
 * The strongest rollback gap among the items that can move the overall state.
 * Ties go to the first item in canonical order.
 *
 * Every non-`ready` overall leaves something here, so a verdict that needs
 * explaining always has a reason. The converse does not hold, and `sops_keys` is
 * the one item that breaks it: `aggregateRollbackOverall` reacts to
 * `sops_keys === 'blocked'` alone, so a stack whose age identity could not be
 * read reports `ready` overall while this field names that unreadable item. The
 * filter reports what is there rather than second-guessing the overall, because
 * a gate invented here would be a second opinion about a verdict that already
 * has one owner.
 */
function strongestRollbackReason(items: RollbackReadinessItem[]): string | null {
  let best: RollbackReadinessItem | null = null;
  for (const item of items) {
    if (!ROLLBACK_GATING_IDS.has(item.id) || item.state === 'ready') continue;
    if (best === null || ROLLBACK_RANK[item.state] > ROLLBACK_RANK[best.state]) best = item;
  }
  return best ? redactSensitiveText(best.detail) || null : null;
}

function unavailableRow(stack: string, reason: ReadinessReasonCode): StackReadinessRow {
  return { stack, update: null, rollback: null, unavailableReason: reason };
}

/**
 * Order stacks so the cap keeps the most operationally interesting ones: those
 * whose stored check failed, then those with an update available, then those
 * with open drift findings, then alphabetical. The first two come from the
 * node's own stored rows; the third is one indexed read per stack, which is
 * cheap enough to earn its place because it decides what survives the cap.
 *
 * Ranks are resolved once per stack, before the sort, rather than inside the
 * comparator: a comparator that queried drift per comparison would run that
 * query about `2n log n` times instead of `n`, blocking the event loop on
 * synchronous SQLite the whole way.
 */
function orderStacks(
  stackNames: string[],
  updateDetail: Record<string, StackUpdateDetail>,
  nodeId: number,
): string[] {
  const db = DatabaseService.getInstance();
  const ranked = stackNames.map((stack) => {
    const stored = updateDetail[stack];
    if (stored?.checkStatus === 'failed') return { stack, rank: 0 };
    if (stored?.hasUpdate) return { stack, rank: 1 };
    if (db.getOpenDriftFindings(nodeId, stack).length > 0) return { stack, rank: 2 };
    return { stack, rank: 3 };
  });
  return ranked
    .sort((a, b) => a.rank - b.rank || a.stack.localeCompare(b.stack))
    .map((row) => row.stack);
}

/**
 * Read every stack's canonical update and rollback verdicts on one node,
 * bounded by a deadline, a concurrency limit, and a stack cap.
 *
 * This adds no scoring: it selects, bounds, and reports what
 * `UpdateGuardService` already computes. The two verdicts are settled
 * independently so a rollback failure cannot erase a good update verdict, and a
 * stack whose work throws degrades to an unavailable row rather than failing
 * the pass.
 */
async function computeStackReadinessSummary(nodeId: number): Promise<StackReadinessPass> {
  const db = DatabaseService.getInstance();
  // Started before the directory read so the scan is charged to the same
  // budget: the scan is a directory read plus file probes per entry with no
  // interruption point, so charging it here is what keeps the per-stack work
  // bounded once it starts.
  const deadline = Date.now() + PASS_DEADLINE_MS;
  // Propagating rather than returning an empty list: a failed directory read
  // must not look like a node with nothing to report.
  const stackNames = await FileSystemService.getInstance(nodeId).getStacksStrict();
  const updateDetail = db.getStackUpdateDetail(nodeId);
  const selected = orderStacks(stackNames, updateDetail, nodeId).slice(0, MAX_STACKS);
  const guard = UpdateGuardService.getInstance();

  const stacks = await mapWithConcurrency(selected, CONCURRENCY, async (stack): Promise<StackReadinessRow> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return unavailableRow(stack, 'summary_truncated');
    const safeStack = sanitizeForLog(stack);
    try {
      const [update, rollback] = await withTimeout(
        Promise.allSettled([
          guard.computeUpdateReadiness(nodeId, stack),
          guard.computeRollbackReadiness(nodeId, stack),
        ]),
        remaining,
        `readiness summary for ${stack}`,
      );
      const updateRow = update.status === 'fulfilled'
        ? {
            verdict: update.value.verdict,
            topReason: strongestUpdateReason(update.value.signals),
            computedAt: update.value.computedAt,
          }
        : null;
      const rollbackRow = rollback.status === 'fulfilled'
        ? {
            overall: rollback.value.overall,
            topReason: strongestRollbackReason(rollback.value.items),
            computedAt: rollback.value.computedAt,
          }
        : null;
      if (update.status === 'rejected') {
        console.error(
          `Readiness summary: update verdict failed for stack ${safeStack}:`,
          sanitizeForLog(getErrorMessage(update.reason, 'unknown')),
        );
      }
      if (rollback.status === 'rejected') {
        console.error(
          `Readiness summary: rollback verdict failed for stack ${safeStack}:`,
          sanitizeForLog(getErrorMessage(rollback.reason, 'unknown')),
        );
      }
      // One slot surviving is a partial row, not an unavailable one, so the
      // reason code is reserved for the case where neither verdict exists.
      return {
        stack,
        update: updateRow,
        rollback: rollbackRow,
        unavailableReason: updateRow === null && rollbackRow === null ? 'domain_error' : null,
      };
    } catch (error) {
      // In practice only `withTimeout` reaches here: both guard calls are
      // async, so the array literal cannot throw synchronously and
      // `Promise.allSettled` never rejects. Both outcomes are logged rather
      // than swallowed, because the row's reason code is the only other trace
      // and it does not say what went wrong.
      const timedOut = error instanceof TimeoutError;
      if (timedOut) {
        console.warn(`Readiness summary: deadline reached for stack ${safeStack}:`, sanitizeForLog(error.message));
      } else {
        console.error(
          `Readiness summary: pass failed for stack ${safeStack}:`,
          sanitizeForLog(getErrorMessage(error, 'unknown')),
        );
      }
      return unavailableRow(stack, timedOut ? 'summary_truncated' : 'domain_error');
    }
  });

  return {
    generatedAt: Date.now(),
    truncated: selected.length < stackNames.length
      || stacks.some((row) => row.unavailableReason === 'summary_truncated'),
    stacks,
  };
}

/**
 * Cache key for the rollup. Exported so the mutation path invalidates the same
 * key this producer writes, rather than a second literal that can drift.
 */
export function stackReadinessSummaryKey(nodeId: number): string {
  return `stack-readiness-summary:${nodeId}`;
}

/**
 * Node-scoped per-stack readiness rollup, served by
 * `GET /api/stacks/readiness-summary`. Cached so a hub fan-out across a fleet
 * does not re-run the Docker-heavy pass on every request.
 */
export async function buildStackReadinessSummary(nodeId: number): Promise<NodeStackReadinessSummary> {
  const result = await CacheService.getInstance().getOrFetchWithMeta(
    stackReadinessSummaryKey(nodeId),
    CACHE_TTL_MS,
    () => computeStackReadinessSummary(nodeId),
  );
  // Age rather than the cache outcome, because the outcome is not truthful for
  // a caller that joined someone else's in-flight fetch: when that fetch fails
  // and the cache serves an expired entry, the caller that ran it is told
  // `stale` while every joiner is told `inflight`, on the same old bytes. An
  // expired entry is by definition older than the TTL, so its own `generatedAt`
  // is too, which names the condition for every reader.
  const stale = Date.now() - result.value.generatedAt >= CACHE_TTL_MS;
  // `CacheService` discards the fetch error when it serves an expired entry and
  // only bumps a counter, so without this line a failed pass is visible nowhere:
  // every caller is handed the expired one as a 200 carrying `stale: true`, and
  // the ones that joined the failed fetch are told `inflight` on the same bytes.
  // Only a failure on a cold cache reaches the route's own error path. Callers
  // joining the failed fetch log this too, the price of not being able to tell
  // them apart.
  if (stale) {
    console.warn(`Readiness summary: serving an expired pass for node ${nodeId}; the fresh pass failed`);
  }
  return { ...result.value, stale };
}
