import { afterEach, describe, expect, it, vi } from 'vitest';
import DockerController, { type LabelInventoryRow } from '../services/DockerController';
import {
  FLEET_READ_BUDGET_MS,
  FleetReadTimeoutError,
  LOCAL_FLEET_READ_DEADLINE_MS,
} from '../helpers/fleetReadBudget';
import {
  _resetLocalLabelInventoryShareForTests,
  LOCAL_LABEL_INVENTORY_SHARE_TTL_MS,
  readLocalLabelInventory,
  type LocalLabelInventoryBudget,
} from '../helpers/localLabelInventory';

/**
 * Scaled-down version of one overall deadline: 100 ms for the liveness check
 * inside a 400 ms deadline for the whole read. The 4:1 ping-to-deadline ratio
 * mirrors the production 5 s check inside an 18 s deadline; the build delays
 * below are chosen against that deadline, not against a separate ceiling.
 */
const TEST_BUDGET: LocalLabelInventoryBudget = { livenessBudgetMs: 100, deadlineMs: 400 };

afterEach(() => {
  vi.restoreAllMocks();
  _resetLocalLabelInventoryShareForTests();
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
  pingDelayMs?: number;
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
  const ping = vi.fn(() => {
    if (options.pingNeverSettles) return new Promise<never>(() => {});
    if (options.pingDelayMs) {
      return new Promise<void>((resolve) => setTimeout(resolve, options.pingDelayMs));
    }
    return Promise.resolve(undefined);
  });
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
  it('keeps the one deadline inside the tab timeout', () => {
    // The Docker Labels tab abandons a node after 20 s. The deadline is the
    // whole read, so the 5 s daemon check is spent inside it, not added to it.
    expect(LOCAL_FLEET_READ_DEADLINE_MS).toBe(18_000);
    expect(FLEET_READ_BUDGET_MS).toBeLessThan(LOCAL_FLEET_READ_DEADLINE_MS);
    expect(LOCAL_FLEET_READ_DEADLINE_MS).toBeLessThan(20_000);
  });
});

describe('readLocalLabelInventory', () => {
  it('returns a large hub when its listing and build outlast the transport budget', async () => {
    // The listing alone took 5.2 to 7.3 s at 455 containers. The old read
    // ran that listing as a pre-count under the 20 ms budget, so it timed out
    // before the scaled build could start. The build now owns the deadline and
    // the pre-count listing never runs.
    const docker = stubDocker({ containerCount: 455, buildDelayMs: 80 });

    const inventory = await readLocalLabelInventory(1, {}, TEST_BUDGET);

    expect(inventory.containers).toHaveLength(455);
    expect(docker.ping).toHaveBeenCalledTimes(1);
    expect(docker.getAllContainers).not.toHaveBeenCalled();
  });

  it('gives the build the rest of the one deadline, not a second budget after the ping', async () => {
    // At 458 containers the build alone needed more than the old fixed
    // 12 s slice (two thirds of an 18 s deadline) in the real tab. Here the
    // build takes 350 ms of the 400 ms deadline and still returns every row,
    // because the ping's fast answer leaves it that time instead of the ping
    // being an allowance the build also needs.
    const docker = stubDocker({ containerCount: 458, buildDelayMs: 350 });

    const inventory = await readLocalLabelInventory(1, {}, TEST_BUDGET);

    expect(inventory.containers).toHaveLength(458);
    expect(docker.ping).toHaveBeenCalledTimes(1);
  });

  it('counts the ping against the same deadline instead of starting it after the ping', async () => {
    // A ping that takes 150 ms of a 400 ms deadline must leave the build 250 ms,
    // so a stalled build ends the read at about 400 ms from the start, not at
    // 550 ms (ping plus a fresh build budget). The liveness cap is above the
    // ping's delay so this test exercises the deadline, not the ping stage.
    const budget: LocalLabelInventoryBudget = { livenessBudgetMs: 300, deadlineMs: 400 };
    const docker = stubDocker({ containerCount: 1, pingDelayMs: 150, buildNeverSettles: true });

    const started = Date.now();
    const error = await readLocalLabelInventory(1, {}, budget).catch((err: unknown) => err);
    const elapsedMs = Date.now() - started;

    expect(docker.ping).toHaveBeenCalledTimes(1);
    expect(docker.listContainersForLabelInventory).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(FleetReadTimeoutError);
    expect((error as FleetReadTimeoutError).budgetMs).toBe(budget.deadlineMs);
    expect(elapsedMs).toBeGreaterThanOrEqual(budget.deadlineMs - 20);
    expect(elapsedMs).toBeLessThan(budget.deadlineMs + 100);
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

  it('bounds a build that stalls after the ping by the overall deadline', async () => {
    const docker = stubDocker({ containerCount: 1, buildNeverSettles: true });

    const error = await readLocalLabelInventory(1, {}, TEST_BUDGET).catch((err: unknown) => err);

    expect(docker.ping).toHaveBeenCalledTimes(1);
    expect(docker.listContainersForLabelInventory).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(FleetReadTimeoutError);
    expect((error as FleetReadTimeoutError).budgetMs).toBe(TEST_BUDGET.deadlineMs);
  });

  it('surfaces a ping that rejects promptly instead of calling it a timeout', async () => {
    const docker = stubDocker({ containerCount: 1 });
    docker.ping.mockRejectedValueOnce(new Error('connect ECONNREFUSED /var/run/docker.sock'));

    const error = await readLocalLabelInventory(1, {}, TEST_BUDGET).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(FleetReadTimeoutError);
    expect((error as Error).message).toContain('ECONNREFUSED');
    expect(docker.listContainersForLabelInventory).not.toHaveBeenCalled();
  });
});

describe('readLocalLabelInventory sharing', () => {
  it('shares one hub build between concurrent readers', async () => {
    const docker = stubDocker({ containerCount: 458, buildDelayMs: 80 });

    const [first, second] = await Promise.all([
      readLocalLabelInventory(1, {}, TEST_BUDGET),
      readLocalLabelInventory(1, {}, TEST_BUDGET),
    ]);

    expect(docker.listContainersForLabelInventory).toHaveBeenCalledTimes(1);
    expect(first.containers).toHaveLength(458);
    expect(second.containers).toHaveLength(458);
  });

  it('serves a just-completed build to a retry without listing again', async () => {
    const docker = stubDocker({ containerCount: 3 });

    const first = await readLocalLabelInventory(1, {}, TEST_BUDGET);
    const retry = await readLocalLabelInventory(1, {}, TEST_BUDGET);

    expect(docker.listContainersForLabelInventory).toHaveBeenCalledTimes(1);
    expect(retry.generatedAt).toBe(first.generatedAt);
    expect(retry.containers).toHaveLength(3);
  });

  it('leaves a timed-out build running for the retry that follows it', async () => {
    // The tab's retry arrives after the first request was cut at its deadline.
    // It must join the build the first request left behind, not list the hub
    // again from the start.
    const docker = stubDocker({ containerCount: 4, buildDelayMs: 150 });

    const firstError = await readLocalLabelInventory(
      1,
      {},
      { livenessBudgetMs: 100, deadlineMs: 50 },
    ).catch((err: unknown) => err);
    expect(firstError).toBeInstanceOf(FleetReadTimeoutError);

    const retry = await readLocalLabelInventory(1, {}, TEST_BUDGET);

    expect(docker.listContainersForLabelInventory).toHaveBeenCalledTimes(1);
    expect(retry.containers).toHaveLength(4);
  });

  it('does not share a plain inventory with a reveal read', async () => {
    const docker = stubDocker({ containerCount: 1, buildDelayMs: 10 });

    await readLocalLabelInventory(1, {}, TEST_BUDGET);
    await readLocalLabelInventory(1, { revealSecrets: true }, TEST_BUDGET);

    expect(docker.listContainersForLabelInventory).toHaveBeenCalledTimes(2);
  });

  it('rebuilds after the completed-build share expires', async () => {
    const docker = stubDocker({ containerCount: 1 });
    const now = vi.spyOn(Date, 'now');
    let clock = 1_000_000;
    now.mockImplementation(() => clock);

    await readLocalLabelInventory(1, {}, TEST_BUDGET);
    clock += LOCAL_LABEL_INVENTORY_SHARE_TTL_MS + 1;
    await readLocalLabelInventory(1, {}, TEST_BUDGET);

    expect(docker.listContainersForLabelInventory).toHaveBeenCalledTimes(2);
  });
});
