import { afterEach, describe, expect, it, vi } from 'vitest';
import DockerController, { type LabelInventoryRow } from '../services/DockerController';
import { buildNodeLabelInventory } from '../services/LabelInventoryService';
import {
  FLEET_READ_BUDGET_MS,
  FleetReadTimeoutError,
  LOCAL_LABEL_INVENTORY_BUDGET_CEILING_MS,
  localLabelInventoryBudgetMs,
  withinFleetReadBudget,
} from '../helpers/fleetReadBudget';
import { readLocalLabelInventory } from '../helpers/localLabelInventory';

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

/** A Docker controller whose label inventory answers after `buildDelayMs`. */
function stubDocker(options: {
  containerCount: number;
  buildDelayMs?: number;
  buildNeverSettles?: boolean;
  listNeverSettles?: boolean;
}): void {
  const containers = Array.from({ length: options.containerCount }, (_, i) => ({ Id: `container-${i}` }));
  vi.spyOn(DockerController, 'getInstance').mockReturnValue({
    getAllContainers: vi.fn(() => (options.listNeverSettles
      ? new Promise(() => {})
      : Promise.resolve(containers))),
    listContainersForLabelInventory: vi.fn(() => {
      if (options.buildNeverSettles) return new Promise(() => {});
      return new Promise<LabelInventoryRow[]>((resolve) => {
        setTimeout(() => resolve(containers.map((_, i) => row(i))), options.buildDelayMs ?? 0);
      });
    }),
    inspectImageLabels: vi.fn().mockResolvedValue({ labels: {} }),
  } as unknown as DockerController);
}

describe('local label inventory budget', () => {
  it('keeps the transport budget for a node that does not answer', () => {
    expect(localLabelInventoryBudgetMs(0)).toBe(FLEET_READ_BUDGET_MS);
    expect(localLabelInventoryBudgetMs(-5)).toBe(FLEET_READ_BUDGET_MS);
    expect(localLabelInventoryBudgetMs(0, 20)).toBe(20);
  });

  it('grows the allowance with the containers the node reports', () => {
    // The hub that filled the QA run: about 455 containers, 6.5 to 7.3 s to build.
    expect(localLabelInventoryBudgetMs(455)).toBeGreaterThan(7_300);
    expect(localLabelInventoryBudgetMs(455)).toBeGreaterThan(localLabelInventoryBudgetMs(150));
  });

  it('caps the growth so a wedged socket still yields a row', () => {
    expect(localLabelInventoryBudgetMs(1_000_000)).toBe(LOCAL_LABEL_INVENTORY_BUDGET_CEILING_MS);
    expect(localLabelInventoryBudgetMs(1_000_000, 20)).toBe(LOCAL_LABEL_INVENTORY_BUDGET_CEILING_MS);
  });
});

describe('readLocalLabelInventory', () => {
  it('does not cut a large healthy hub at the transport budget', async () => {
    // 40 ms of real work against a 20 ms first-answer budget: the same cut the
    // 5 s budget made on a big hub. The per-container allowance must cover it.
    stubDocker({ containerCount: 500, buildDelayMs: 40 });
    await expect(withinFleetReadBudget(
      buildNodeLabelInventory(1),
      'container labels',
      20,
    )).rejects.toBeInstanceOf(FleetReadTimeoutError);

    const inventory = await readLocalLabelInventory(1, {}, 20);
    expect(inventory.containers).toHaveLength(500);
  });

  it('still reports a Docker that never answers the listing as a timeout', async () => {
    stubDocker({ containerCount: 500, listNeverSettles: true });
    const started = Date.now();
    const error = await readLocalLabelInventory(1, {}, 20).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(FleetReadTimeoutError);
    expect((error as FleetReadTimeoutError).budgetMs).toBe(20);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('bounds a build that stalls after the listing by the scaled allowance', async () => {
    stubDocker({ containerCount: 1, buildNeverSettles: true });
    const error = await readLocalLabelInventory(1, {}, 20).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(FleetReadTimeoutError);
    expect((error as FleetReadTimeoutError).budgetMs).toBe(localLabelInventoryBudgetMs(1, 20));
  });
});
