import DockerController from '../services/DockerController';
import {
  buildNodeLabelInventory,
  type LabelInventoryOptions,
  type NodeLabelInventory,
} from '../services/LabelInventoryService';
import {
  FLEET_READ_BUDGET_MS,
  localLabelInventoryBudgetMs,
  withinFleetReadBudget,
} from './fleetReadBudget';

/**
 * Read the hub's own Docker label inventory inside the fleet-read budgets.
 *
 * Clearing entries costs real work per container, so a large hub cannot be held
 * to the transport budget without reporting a healthy node as timed out. The
 * listing is still the first contact with Docker: a wedged socket costs one
 * budget and nothing more. Once the node has said how many containers it holds,
 * the build that follows gets that budget plus the per-container allowance, so
 * the read is bounded by what it was asked to read instead of by how fast the
 * transport is.
 *
 * The listing is repeated when the inventory builds. That second list is one
 * cheap Docker call next to the per-container inspection it feeds, and sizing
 * the budget here keeps the decision in one place.
 *
 * `firstAnswerBudgetMs` is a seam for tests; callers use the fleet budget.
 */
export async function readLocalLabelInventory(
  nodeId: number,
  options: LabelInventoryOptions = {},
  firstAnswerBudgetMs: number = FLEET_READ_BUDGET_MS,
): Promise<NodeLabelInventory> {
  const docker = DockerController.getInstance(nodeId);
  const listed = await withinFleetReadBudget(
    docker.getAllContainers(),
    'container labels',
    firstAnswerBudgetMs,
  );
  const containerCount = Array.isArray(listed) ? listed.length : 0;
  return withinFleetReadBudget(
    buildNodeLabelInventory(nodeId, options),
    'container labels',
    localLabelInventoryBudgetMs(containerCount, firstAnswerBudgetMs),
  );
}
