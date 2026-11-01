import { describe, expect, it, vi } from 'vitest';
import {
  FLEET_READ_BUDGET_MS,
  FleetReadTimeoutError,
  LOCAL_FLEET_READ_DEADLINE_MS,
  describeFleetReadFailure,
  fleetReadSignal,
  withinFleetReadBudget,
  withinLocalFleetReadBudget,
} from '../helpers/fleetReadBudget';

describe('fleet read budget', () => {
  it('is one number for every interactive remote fleet read', () => {
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
    expect(describeFleetReadFailure(new FleetReadTimeoutError(LOCAL_FLEET_READ_DEADLINE_MS, 'labels'))).toBe('Timed out after 18s');
    expect(describeFleetReadFailure(new DOMException('aborted', 'TimeoutError'))).toBe('Timed out after 5s');
    expect(describeFleetReadFailure(new Error('connect ECONNREFUSED'))).toBe('connect ECONNREFUSED');
    expect(describeFleetReadFailure('boom')).toBe('Failed to reach node');
  });
});

describe('local fleet read budget', () => {
  const SHORT_BUDGET = { livenessBudgetMs: 100, deadlineMs: 300 };

  it('pings first, then returns work that fits the local deadline', async () => {
    let pinged = false;
    await expect(withinLocalFleetReadBudget(
      'dependency graph',
      async () => { pinged = true; },
      () => new Promise<string>((resolve) => setTimeout(() => resolve('graph'), 50)),
      SHORT_BUDGET,
    )).resolves.toBe('graph');
    expect(pinged).toBe(true);
  });

  it('cuts a wedged daemon at the liveness budget, not the local deadline', async () => {
    const started = Date.now();
    const error = await withinLocalFleetReadBudget(
      'networking summary',
      () => new Promise<void>(() => {}),
      async () => 'never runs',
      { livenessBudgetMs: 40, deadlineMs: 500 },
    ).catch((err: unknown) => err);
    const elapsed = Date.now() - started;

    expect(error).toBeInstanceOf(FleetReadTimeoutError);
    expect((error as FleetReadTimeoutError).budgetMs).toBe(40);
    expect(elapsed).toBeGreaterThanOrEqual(30);
    expect(elapsed).toBeLessThan(300);
  });

  it('cuts a build that stalls after a good ping at the local deadline', async () => {
    const started = Date.now();
    const error = await withinLocalFleetReadBudget(
      'dependency graph',
      async () => undefined,
      () => new Promise<string>(() => {}),
      { livenessBudgetMs: 40, deadlineMs: 100 },
    ).catch((err: unknown) => err);
    const elapsed = Date.now() - started;

    expect(error).toBeInstanceOf(FleetReadTimeoutError);
    expect((error as FleetReadTimeoutError).budgetMs).toBe(100);
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(400);
  });

  it('counts a slow ping against the same deadline instead of adding a second one', async () => {
    // Fake timers make the boundary exact: the ping finishes at 80 ms, the
    // build would finish at 130 ms, and the 120 ms deadline must fire first.
    // A deadline restarted after the ping would let the build resolve at
    // 130 ms instead, which the sentinel catches without wall-clock waits.
    vi.useFakeTimers();
    try {
      const outcome: { result: { value: string } | { error: unknown } | null } = { result: null };
      const read = withinLocalFleetReadBudget(
        'container labels',
        () => new Promise<void>((resolve) => setTimeout(resolve, 80)),
        () => new Promise<string>((resolve) => setTimeout(() => resolve('late'), 50)),
        { livenessBudgetMs: 100, deadlineMs: 120 },
      ).then(
        (value) => { outcome.result = { value }; },
        (error: unknown) => { outcome.result = { error }; },
      );

      await vi.advanceTimersByTimeAsync(80);
      await vi.advanceTimersByTimeAsync(40);

      expect(outcome.result).not.toBeNull();
      const error = (outcome.result as { error?: unknown }).error;
      expect(error).toBeInstanceOf(FleetReadTimeoutError);
      expect((error as FleetReadTimeoutError).budgetMs).toBe(120);
      await read;
    } finally {
      vi.useRealTimers();
    }
  });
});
