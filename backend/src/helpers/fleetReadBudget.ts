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
 * inventory carried.
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

/** A read that outlived the fleet-read budget, so a caller can tell it from a transport failure. */
export class FleetReadTimeoutError extends Error {
  public readonly budgetMs: number;

  public constructor(budgetMs: number, label: string) {
    super(`Fleet read "${label}" exceeded its ${budgetMs}ms budget`);
    this.name = 'FleetReadTimeoutError';
    this.budgetMs = budgetMs;
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
 * How a failed node read reads beside the node. A budget overrun says so (a
 * retry may succeed) instead of surfacing the runtime's abort text.
 */
export function describeFleetReadFailure(error: unknown, budgetMs: number = FLEET_READ_BUDGET_MS): string {
  if (error instanceof FleetReadTimeoutError) return `Timed out after ${error.budgetMs / 1000}s`;
  if (isFleetReadTimeout(error)) return `Timed out after ${budgetMs / 1000}s`;
  return getErrorMessage(error, 'Failed to reach node');
}
