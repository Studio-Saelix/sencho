import { getErrorMessage } from '../utils/errors';

/**
 * Budget one node's answer may cost an interactive fleet read.
 *
 * Fleet tabs fan out across nodes and draw what came back. One unreachable node
 * (a dead Distributed API Proxy host, a Pilot agent that stopped while its
 * tunnel has not been reaped yet) must cost this budget at most, so the hub and
 * the healthy nodes stay usable instead of the tab waiting out the slowest
 * node's transport timeout.
 *
 * 5 s covers these node-data reads: the dependency map, the Docker label
 * inventory, the networking summary, and the fleet image-update status. A
 * healthy LAN node answers in milliseconds and a WAN node in a few hundred,
 * while a node that builds a full container/network/volume snapshot can need a
 * second or two on a busy host, so a ~3 s ceiling would drop truthful data from
 * healthy nodes to shave two seconds off the one bad node. 5 s also matches the
 * cap the fleet image-update reads already used, so one number replaces the
 * 8 s the map and networking summary carried and the 30 s the Docker Labels
 * inventory carried. The hub's label inventory and dependency graph also cap
 * their cheap daemon check with it, but the whole read runs under
 * {@link LOCAL_FLEET_READ_DEADLINE_MS}, because those reads do host-sized
 * work rather than one round trip. The networking summary runs under that
 * deadline without a daemon check, because it keeps its declared signals when
 * Docker fails.
 *
 * Two neighbouring reads keep their own budgets on purpose, because they are a
 * different contract: the Overview card probe stays at 3 s (it reads three small
 * endpoints and must not hold the primary Fleet loading state), and the
 * Readiness aggregate keeps its evidence and summary budgets.
 *
 * Long-running fleet actions are not interactive reads and keep their own
 * budgets: the remote image-update refresh still starts its scan on a 5 s
 * request, while deploys, prune and update run on much longer ones.
 */
export const FLEET_READ_BUDGET_MS = 5_000;

/**
 * How long an interactive Fleet read the hub builds on its own host may hold
 * the caller, measured from the start of the read.
 *
 * A local read is different from a remote: the hub lists the host's containers,
 * networks and volumes and reads its stacks, so its cost grows with the node,
 * and a host with a few hundred containers needs several seconds even when
 * Docker answers every call. The listing cannot be used to size that budget,
 * because it is the slow part and would have to run under the flat transport
 * budget first. A fixed deadline is independent of the read: it sits inside the
 * 28 s per-node client timeout the Docker Labels tab and the Map use
 * (`LABELS_NODE_TIMEOUT_MS`, `MAP_NODE_TIMEOUT_MS`), with room for the
 * transfer, so a large hub is not cut off before it can build its answer. The
 * networking summary has no per-node client timeout; this deadline bounds it on
 * its own.
 *
 * 25 s is sized from a measured hub: 461 containers on one vCPU build the map
 * in 5 to 9 s alone, and 15 to 17.5 s while a browser has the dashboard open,
 * so an 18 s deadline cut a share of loads. The deadline leaves that worst case
 * about 40% headroom; a build that still outlives it is kept for the retry,
 * and the Labels and Map tabs make that retry themselves once
 * ({@link FLEET_BUILD_KEPT_HEADER}; see `LocalFleetBuildShare` in
 * `localFleetBuildShare.ts`).
 *
 * The deadline bounds the caller's wait, not the work. The local builders
 * cannot be cancelled, so a build that outlives the deadline finishes on its
 * own; the hub's label inventory, dependency graph and networking summary
 * share that build with a Retry instead of starting it again. Where a local
 * read checks the daemon first, that check is a maximum inside the deadline
 * rather than an allowance added on top: the ping normally answers in
 * milliseconds, so the build gets almost the full deadline. A build allowed only a fixed slice after a ping that can itself
 * cost 5 s is what left a 458-container hub timing out in the real tab.
 *
 * It applies to the hub's own label inventory, dependency graph and networking
 * summary. The hub waits {@link FLEET_READ_BUDGET_MS} for a remote or Pilot
 * read even though that node does the same host-sized work; the remote's own
 * build is not bounded by this constant.
 */
export const LOCAL_FLEET_READ_DEADLINE_MS = 25_000;

/** The two caps of a local Fleet read: one liveness check, then one deadline. */
export interface LocalFleetReadBudget {
  /** Budget for the cheap daemon check; a wedged socket costs this and no more. */
  livenessBudgetMs: number;
  /** How long the caller waits for the whole read, measured from its start. */
  deadlineMs: number;
}

export const LOCAL_FLEET_READ_BUDGET: Readonly<LocalFleetReadBudget> = Object.freeze({
  livenessBudgetMs: FLEET_READ_BUDGET_MS,
  deadlineMs: LOCAL_FLEET_READ_DEADLINE_MS,
});

/** A read that outlived the fleet-read budget, so a caller can tell it from a transport failure. */
export class FleetReadTimeoutError extends Error {
  public readonly budgetMs: number;
  /**
   * Set by a hub-local build share when the read gave up on a build that is
   * still running (or finished unread) in this process, so asking again joins
   * that build instead of paying for it twice. A daemon check that timed out
   * never started a build and leaves this false.
   */
  public buildKept = false;

  public constructor(budgetMs: number, label: string) {
    super(`Fleet read "${label}" exceeded its ${budgetMs}ms budget`);
    this.name = 'FleetReadTimeoutError';
    this.budgetMs = budgetMs;
  }
}

/**
 * Response header a Fleet read sets when the hub's own read was cut at its
 * deadline with the build kept. A tab that asked for one node (`?nodeId=`) asks
 * once more on seeing it, which joins that build, so a large hub's slow cold
 * read is not reported as failed. Only the labels and dependency-map reads set
 * it; the networking summary does not.
 */
export const FLEET_BUILD_KEPT_HEADER = 'X-Sencho-Build-Kept';

/** Flag `res` when any settled read was cut at its deadline with its build kept. */
export function flagKeptBuilds(
  res: { setHeader(name: string, value: string): unknown },
  results: readonly PromiseSettledResult<unknown>[],
): void {
  if (results.some(r => r.status === 'rejected' && r.reason instanceof FleetReadTimeoutError && r.reason.buildKept)) {
    res.setHeader(FLEET_BUILD_KEPT_HEADER, '1');
  }
}

export function isFleetReadTimeout(error: unknown): boolean {
  return error instanceof FleetReadTimeoutError
    || (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'));
}

/** The signal a remote fleet read runs under. */
export function fleetReadSignal(budgetMs: number = FLEET_READ_BUDGET_MS): AbortSignal {
  return AbortSignal.timeout(budgetMs);
}

/**
 * Bound work that runs in this process (the hub's own node) by the same budget
 * as a remote read. A local Docker or filesystem call cannot be aborted, so this
 * stops waiting on it rather than cancelling it: the work finishes on its own,
 * and its settlement is already handled by the race.
 */
export async function withinFleetReadBudget<T>(
  work: Promise<T>,
  label: string,
  budgetMs: number = FLEET_READ_BUDGET_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let overBudget = false;
  const budget = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      overBudget = true;
      reject(new FleetReadTimeoutError(budgetMs, label));
    }, budgetMs);
  });
  try {
    return await Promise.race([work, budget]);
  } catch (error) {
    if (overBudget) {
      // The abandoned work still ran, and its own failure is the line an
      // operator needs when the hub's reads keep timing out.
      void work.catch((lateError: unknown) => {
        console.warn(
          `Fleet read "${label}" failed after its ${budgetMs}ms budget:`,
          getErrorMessage(lateError, 'unknown error'),
        );
      });
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Bound a hub-local Fleet read by one deadline, with a cheap daemon check
 * inside it.
 *
 * The check proves Docker answers at all before the expensive build starts; a
 * socket that never answers costs one transport budget instead of the whole
 * local deadline. Both stages share the deadline, measured from the start, so a
 * slow build is not given a second allowance after a slow check. The deadline
 * bounds the caller's wait: work that cannot be cancelled may finish after it.
 *
 * `ping` and `work` are thunks so a caller that joins an already-running build
 * still gets its own deadline around that shared work.
 */
export async function withinLocalFleetReadBudget<T>(
  label: string,
  ping: () => Promise<unknown>,
  work: () => Promise<T>,
  budget: LocalFleetReadBudget = LOCAL_FLEET_READ_BUDGET,
): Promise<T> {
  return withinFleetReadBudget(
    (async () => {
      // The check can never own more time than the whole read; a caller that
      // inverts the two numbers still gets the outer deadline's answer.
      await withinFleetReadBudget(ping(), label, Math.min(budget.livenessBudgetMs, budget.deadlineMs));
      return work();
    })(),
    label,
    budget.deadlineMs,
  );
}

/**
 * How a failed node read reads beside the node. A budget overrun says so (a
 * retry may succeed) instead of surfacing the runtime's abort text.
 */
export function describeFleetReadFailure(error: unknown, budgetMs: number = FLEET_READ_BUDGET_MS): string {
  if (error instanceof FleetReadTimeoutError) return `Timed out after ${error.budgetMs / 1000}s`;
  if (isFleetReadTimeout(error)) return `Timed out after ${budgetMs / 1000}s`;
  return getErrorMessage(error, 'Failed to reach node');
}
