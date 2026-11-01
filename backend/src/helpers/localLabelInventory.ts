import DockerController from '../services/DockerController';
import {
  buildNodeLabelInventory,
  type LabelInventoryOptions,
  type NodeLabelInventory,
} from '../services/LabelInventoryService';
import {
  FLEET_READ_BUDGET_MS,
  LOCAL_LABEL_INVENTORY_DEADLINE_MS,
  withinFleetReadBudget,
} from './fleetReadBudget';

export interface LocalLabelInventoryBudget {
  /** Budget for the cheap daemon check; a wedged socket costs this and no more. */
  livenessBudgetMs: number;
  /** Deadline for the whole read, measured from its start. */
  deadlineMs: number;
}

const DEFAULT_BUDGET: LocalLabelInventoryBudget = {
  livenessBudgetMs: FLEET_READ_BUDGET_MS,
  deadlineMs: LOCAL_LABEL_INVENTORY_DEADLINE_MS,
};

/**
 * Read the hub's own Docker label inventory inside the fleet-read budgets.
 *
 * The listing (`/containers/json`) scales with the host: on a busy hub with
 * hundreds of containers it alone can outlast the transport budget, so it
 * cannot also be the first-contact check. A cheap ping proves the daemon
 * answers at all, and the build that follows (its own listing plus the
 * per-container inspections) runs under the local deadline.
 *
 * The two stages share one deadline rather than each getting a fixed
 * allowance: the ping normally answers in milliseconds, so the build gets
 * almost the whole deadline. Giving the build a separate slice after a ping
 * that may itself cost the transport budget left a 458-container hub timing
 * out in the real tab. A socket that never answers the ping still
 * costs one transport budget, and one that wedges mid-build is held to the
 * deadline, while a healthy large hub is not cut off before it has said how
 * many containers it holds.
 *
 * `budget` is a seam for tests; callers use the fleet budget and the deadline.
 */
export async function readLocalLabelInventory(
  nodeId: number,
  options: LabelInventoryOptions = {},
  budget: LocalLabelInventoryBudget = DEFAULT_BUDGET,
): Promise<NodeLabelInventory> {
  return withinFleetReadBudget(
    readLocalLabelInventoryStages(nodeId, options, budget),
    'container labels',
    budget.deadlineMs,
  );
}

async function readLocalLabelInventoryStages(
  nodeId: number,
  options: LabelInventoryOptions,
  budget: LocalLabelInventoryBudget,
): Promise<NodeLabelInventory> {
  const docker = DockerController.getInstance(nodeId);
  await withinFleetReadBudget(docker.ping(), 'container labels', budget.livenessBudgetMs);
  return buildNodeLabelInventory(nodeId, options);
}
