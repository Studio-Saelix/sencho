import { describe, expect, it } from 'vitest';
import {
  FLEET_READ_BUDGET_MS,
  FleetReadTimeoutError,
  LOCAL_LABEL_INVENTORY_DEADLINE_MS,
  describeFleetReadFailure,
  fleetReadSignal,
  withinFleetReadBudget,
} from '../helpers/fleetReadBudget';

describe('fleet read budget', () => {
  it('is one number for every interactive fleet read', () => {
    expect(FLEET_READ_BUDGET_MS).toBe(5_000);
  });

  it('gives a remote read a signal that aborts when the budget runs out', async () => {
    const signal = fleetReadSignal(10);
    expect(signal.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(signal.aborted).toBe(true);
  });

  it('stops waiting on in-process work that outlives the budget', async () => {
    const work = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 100));
    await expect(withinFleetReadBudget(work, 'dependency graph', 10)).rejects.toBeInstanceOf(FleetReadTimeoutError);
  });

  it('returns in-process work that settles inside the budget', async () => {
    await expect(withinFleetReadBudget(Promise.resolve('ok'), 'dependency graph')).resolves.toBe('ok');
  });

  it('names a budget overrun instead of surfacing the runtime abort text', () => {
    expect(describeFleetReadFailure(new FleetReadTimeoutError(FLEET_READ_BUDGET_MS, 'labels'))).toBe('Timed out after 5s');
    expect(describeFleetReadFailure(new FleetReadTimeoutError(LOCAL_LABEL_INVENTORY_DEADLINE_MS, 'labels'))).toBe('Timed out after 18s');
    expect(describeFleetReadFailure(new DOMException('aborted', 'TimeoutError'))).toBe('Timed out after 5s');
    expect(describeFleetReadFailure(new Error('connect ECONNREFUSED'))).toBe('connect ECONNREFUSED');
    expect(describeFleetReadFailure('boom')).toBe('Failed to reach node');
  });
});
