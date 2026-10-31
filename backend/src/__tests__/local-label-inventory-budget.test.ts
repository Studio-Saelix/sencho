import { afterEach, describe, expect, it, vi } from 'vitest';
import DockerController, { type LabelInventoryRow } from '../services/DockerController';
import {
  FLEET_READ_BUDGET_MS,
  FleetReadTimeoutError,
  LOCAL_LABEL_INVENTORY_BUDGET_CEILING_MS,
} from '../helpers/fleetReadBudget';
import { readLocalLabelInventory } from '../helpers/localLabelInventory';

/**
 * Scaled-down version of the fleet budget and the local ceiling: 20 ms for the
 * liveness check, 200 ms for the build. A 10x ratio keeps the stage the test is
 * exercising unambiguous without waiting the real 5 + 12 seconds.
 */
const TEST_BUDGET = { livenessBudgetMs: 20, ceilingMs: 200 };

afterEach(() => {
  vi.restoreAllMocks();
});

function row(index: number): LabelInventoryRow {
  return {
    id: `container-${index}`,
    name: `container-${index}`,
    state: 'running',
    stack: 'demo',
    service: 'web',
    labels: { 'traefik.enable': 'true' },
    imageId: 'sha256:image',
    inspectFailed: false,
  };
}

interface StubOptions {
  containerCount: number;
  buildDelayMs?: number;
  buildNeverSettles?: boolean;
  pingNeverSettles?: boolean;
}

/**
 * A Docker controller to read the hub's own inventory from. `getAllContainers`
 * is the pre-count listing the old read ran under the flat budget; it never
 * settles here so a regression that reintroduces it fails at the budget
 * instead of passing on a cheap stub.
 */
function stubDocker(options: StubOptions): {
  getAllContainers: ReturnType<typeof vi.fn>;
  ping: ReturnType<typeof vi.fn>;
  listContainersForLabelInventory: ReturnType<typeof vi.fn>;
} {
  const containers = Array.from({ length: options.containerCount }, (_, i) => ({ Id: `container-${i}` }));
  const getAllContainers = vi.fn(() => new Promise<never>(() => {}));
  const ping = vi.fn(() => (options.pingNeverSettles
    ? new Promise<never>(() => {})
    : Promise.resolve(undefined)));
  const listContainersForLabelInventory = vi.fn(() => {
    if (options.buildNeverSettles) return new Promise<never>(() => {});
    return new Promise<LabelInventoryRow[]>((resolve) => {
      setTimeout(() => resolve(containers.map((_, i) => row(i))), options.buildDelayMs ?? 0);
    });
  });
  vi.spyOn(DockerController, 'getInstance').mockReturnValue({
    ping,
    getAllContainers,
    listContainersForLabelInventory,
    inspectImageLabels: vi.fn().mockResolvedValue({ labels: {} }),
  } as unknown as DockerController);
  return { getAllContainers, ping, listContainersForLabelInventory };
}

describe('local label inventory budget', () => {
  it('keeps the liveness check plus the build ceiling inside the tab timeout', () => {
    // The Docker Labels tab abandons a node after 20 s; the two local stages
    // plus the transfer must fit inside it or a healthy hub has no row at all.
    expect(FLEET_READ_BUDGET_MS + LOCAL_LABEL_INVENTORY_BUDGET_CEILING_MS).toBeLessThan(20_000);
  });
});

describe('readLocalLabelInventory', () => {
  it('returns a large hub when its listing and build outlast the transport budget', async () => {
    // F2: the listing alone took 5.2 to 7.3 s at 455 containers. The old read
    // ran that listing as a pre-count under the 20 ms budget, so it timed out
    // before the scaled build could start. The build now owns the ceiling and
    // the pre-count listing never runs.
    const docker = stubDocker({ containerCount: 455, buildDelayMs: 80 });

    const inventory = await readLocalLabelInventory(1, {}, TEST_BUDGET);

    expect(inventory.containers).toHaveLength(455);
    expect(docker.ping).toHaveBeenCalledTimes(1);
    expect(docker.getAllContainers).not.toHaveBeenCalled();
  });

  it('cuts a Docker socket that never answers the liveness check at one budget', async () => {
    const docker = stubDocker({ containerCount: 455, pingNeverSettles: true });

    const started = Date.now();
    const error = await readLocalLabelInventory(1, {}, TEST_BUDGET).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(FleetReadTimeoutError);
    expect((error as FleetReadTimeoutError).budgetMs).toBe(TEST_BUDGET.livenessBudgetMs);
    expect(docker.listContainersForLabelInventory).not.toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('bounds a build that stalls after the ping by the local ceiling', async () => {
    stubDocker({ containerCount: 1, buildNeverSettles: true });

    const error = await readLocalLabelInventory(1, {}, TEST_BUDGET).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(FleetReadTimeoutError);
    expect((error as FleetReadTimeoutError).budgetMs).toBe(TEST_BUDGET.ceilingMs);
  });
});
