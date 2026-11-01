import DockerController from '../services/DockerController';
import {
  buildNodeLabelInventory,
  type LabelInventoryOptions,
  type NodeLabelInventory,
} from '../services/LabelInventoryService';
import { LocalFleetBuildShare } from './localFleetBuildShare';
import {
  LOCAL_FLEET_READ_BUDGET,
  withinLocalFleetReadBudget,
  type LocalFleetReadBudget,
} from './fleetReadBudget';

/** Compatibility name for the local Fleet budget this read uses. */
export type LocalLabelInventoryBudget = LocalFleetReadBudget;

const shares = {
  plain: new LocalFleetBuildShare<NodeLabelInventory>(),
  reveal: new LocalFleetBuildShare<NodeLabelInventory>(),
};

/**
 * Read the hub's own Docker label inventory inside the local Fleet budget.
 *
 * The listing (`/containers/json`) scales with the host: on a busy hub with
 * hundreds of containers it alone can outlast the transport budget, so it
 * cannot also be the first-contact check. A cheap ping proves the daemon
 * answers at all, and the build that follows runs under the local deadline.
 *
 * The two stages share one deadline rather than each getting a fixed
 * allowance: the ping normally answers in milliseconds, so the build gets
 * almost the whole deadline. A socket that never answers the ping still
 * costs one transport budget, and one that wedges mid-build is cut off for
 * the caller at the deadline while the build stays available to a Retry. A
 * healthy large hub is not cut off before it has said how many containers it
 * holds.
 *
 * `budget` is a seam for tests; callers use the Fleet budget and the deadline.
 */
export async function readLocalLabelInventory(
  nodeId: number,
  options: LabelInventoryOptions = {},
  budget: LocalLabelInventoryBudget = LOCAL_FLEET_READ_BUDGET,
): Promise<NodeLabelInventory> {
  // A reveal read never shares with a plain one: the plain inventory redacts.
  const share = options.revealSecrets === true ? shares.reveal : shares.plain;
  return share.read(
    String(nodeId),
    () => buildNodeLabelInventory(nodeId, options),
    (work) => withinLocalFleetReadBudget(
      'container labels',
      () => DockerController.getInstance(nodeId).ping(),
      work,
      budget,
    ),
  );
}
