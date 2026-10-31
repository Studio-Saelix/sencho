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
 * 5 s is the shared ceiling for every interactive fleet read. A healthy LAN node
 * answers in milliseconds and a WAN node in a few hundred, while a node that
 * builds a full container/network/volume snapshot needs a second or two on a
 * busy host, so a ~3 s ceiling would drop truthful data from healthy nodes to
 * shave two seconds off the one bad node. 5 s also matches the cap the fleet
 * image-update reads already used, so one number now covers every tab instead of
 * 5 s, 8 s, 15 s and 30 s depending on which one is open.
 *
 * Long-running fleet actions (deploy, prune, update, refresh) are not
 * interactive reads and keep their own, longer budgets.
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

/** The signal a remote fleet read runs under: the shared budget, nothing else. */
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
  const budget = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new FleetReadTimeoutError(budgetMs, label)), budgetMs);
  });
  try {
    return await Promise.race([work, budget]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * How a failed node read reads beside the node. A budget overrun says so (a
 * retry may succeed) instead of surfacing the runtime's abort text.
 */
export function describeFleetReadFailure(error: unknown, budgetMs: number = FLEET_READ_BUDGET_MS): string {
  if (isFleetReadTimeout(error)) return `Timed out after ${budgetMs / 1000}s`;
  return getErrorMessage(error, 'Failed to reach node');
}
