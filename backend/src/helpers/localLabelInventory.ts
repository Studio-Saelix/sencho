import DockerController from '../services/DockerController';
import {
  buildNodeLabelInventory,
  type LabelInventoryOptions,
  type NodeLabelInventory,
} from '../services/LabelInventoryService';
import {
  FLEET_READ_BUDGET_MS,
  LOCAL_LABEL_INVENTORY_BUDGET_CEILING_MS,
  withinFleetReadBudget,
} from './fleetReadBudget';

export interface LocalLabelInventoryBudget {
  /** Budget for the cheap daemon check; a wedged socket costs this and no more. */
  livenessBudgetMs?: number;
  /** Ceiling on the inventory build once Docker has answered. */
  ceilingMs?: number;
}

/**
 * Read the hub's own Docker label inventory inside the fleet-read budgets.
 *
 * The listing (`/containers/json`) scales with the host: on a busy hub with
 * hundreds of containers it alone can outlast the transport budget, so it
 * cannot also be the first-contact check. A cheap ping proves the daemon
 * answers at all, and the build that follows (its own listing plus the
 * per-container inspections) gets the local ceiling. A wedged socket still
 * costs one transport budget, while a healthy large hub is not cut off before
 * it has said how many containers it holds.
 *
 * The ping and the build are the only two stages; there is no pre-count
 * listing, because learning the count would require the listing that is too
 * slow to run under the flat budget in the first place.
 *
 * `budget` is a seam for tests; callers use the fleet budget and the ceiling.
 */
export async function readLocalLabelInventory(
  nodeId: number,
  options: LabelInventoryOptions = {},
  budget: LocalLabelInventoryBudget = {},
): Promise<NodeLabelInventory> {
  const docker = DockerController.getInstance(nodeId);
  const livenessBudgetMs = budget.livenessBudgetMs ?? FLEET_READ_BUDGET_MS;
  const ceilingMs = budget.ceilingMs ?? LOCAL_LABEL_INVENTORY_BUDGET_CEILING_MS;
  await withinFleetReadBudget(docker.ping(), 'container labels', livenessBudgetMs);
  return withinFleetReadBudget(
    buildNodeLabelInventory(nodeId, options),
    'container labels',
    ceilingMs,
  );
}
