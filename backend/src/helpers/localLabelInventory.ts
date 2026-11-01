import DockerController from '../services/DockerController';
import {
  buildNodeLabelInventory,
  type LabelInventoryOptions,
  type NodeLabelInventory,
} from '../services/LabelInventoryService';
import {
  LOCAL_FLEET_READ_BUDGET,
  LOCAL_FLEET_READ_DEADLINE_MS,
  withinLocalFleetReadBudget,
  type LocalFleetReadBudget,
} from './fleetReadBudget';

/** Compatibility name for the local Fleet budget this read uses. */
export type LocalLabelInventoryBudget = LocalFleetReadBudget;

/**
 * How long a completed hub build stays available to another reader.
 *
 * A tab load that reaches the deadline still leaves its build running in this
 * process. Keeping that finished inventory briefly lets Retry answer from it
 * instead of paying for the same listing again. A still-existing container's
 * labels cannot change, but the share can add this window on top of the
 * build's own age, so a container removed or recreated just before a Refresh
 * may still appear until the share expires.
 */
export const LOCAL_LABEL_INVENTORY_SHARE_TTL_MS = 10_000;

/**
 * How long a never-settling build is still joinable. A Docker call that hangs
 * forever must not poison every later read: once a build is older than this, a
 * new reader starts a fresh build instead of joining the old one. The check
 * runs on the next read; there is no background timer.
 */
export const LOCAL_LABEL_INVENTORY_MAX_BUILD_AGE_MS =
  LOCAL_FLEET_READ_DEADLINE_MS + LOCAL_LABEL_INVENTORY_SHARE_TTL_MS;

class SharedLabelBuild {
  public settledAt: number | null = null;
  public readonly promise: Promise<NodeLabelInventory>;

  public constructor(
    public readonly startedAt: number,
    build: Promise<NodeLabelInventory>,
  ) {
    this.promise = build.then((inventory) => {
      this.settledAt = Date.now();
      return inventory;
    });
  }

  /** Time the freshness check counts from: completion once settled, start while running. */
  public get ageFrom(): number {
    return this.settledAt ?? this.startedAt;
  }
}

const sharedBuilds = new Map<string, SharedLabelBuild>();

function shareKey(nodeId: number, options: LabelInventoryOptions): string {
  return `${nodeId}:${options.revealSecrets === true ? 'reveal' : 'plain'}`;
}

/**
 * Share one in-flight (or just-completed) hub build between readers.
 *
 * The build runs outside the caller's deadline so a reader that times out does
 * not cancel the work: the next request, which is usually the tab's Retry,
 * pings as usual and then waits only for the remainder of the shared build.
 */
function readSharedLabelBuild(nodeId: number, options: LabelInventoryOptions): Promise<NodeLabelInventory> {
  const key = shareKey(nodeId, options);
  const now = Date.now();
  const existing = sharedBuilds.get(key);
  if (existing) {
    const age = now - existing.ageFrom;
    const stillFresh = existing.settledAt === null
      ? age < LOCAL_LABEL_INVENTORY_MAX_BUILD_AGE_MS
      : age < LOCAL_LABEL_INVENTORY_SHARE_TTL_MS;
    if (stillFresh) return existing.promise;
    sharedBuilds.delete(key);
  }

  const entry = new SharedLabelBuild(now, buildNodeLabelInventory(nodeId, options));
  entry.promise.catch(() => {
    // A failed build has no result to share; the next reader tries again.
    if (sharedBuilds.get(key) === entry) sharedBuilds.delete(key);
  });
  sharedBuilds.set(key, entry);
  return entry.promise;
}

/** Drop in-flight and cached builds. Tests call this between isolated cases. */
export function _resetLocalLabelInventoryShareForTests(): void {
  sharedBuilds.clear();
}

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
  return withinLocalFleetReadBudget(
    'container labels',
    () => DockerController.getInstance(nodeId).ping(),
    () => readSharedLabelBuild(nodeId, options),
    budget,
  );
}
