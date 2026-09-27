/**
 * Caps every `withTimeout` budget at a few milliseconds for route tests that
 * only need a hung promise to time out. Route handlers run behind supertest,
 * so vi.useFakeTimers cannot advance their timers; without this, each timeout
 * test waits the real production budget (12s). The timeout path itself is
 * unchanged: the real `withTimeout` still races and rejects with the real
 * `TimeoutError`. The budget each call asked for is recorded, so tests assert
 * the production value directly instead of inferring it from elapsed time.
 *
 * Usage (vi.mock is hoisted, so the helper is imported inside the factory):
 *   vi.mock('../utils/withTimeout', async (importOriginal) =>
 *     (await import('./helpers/fastTimeouts')).withFastTimeouts(await importOriginal()));
 */
import type * as WithTimeoutModule from '../../utils/withTimeout';

const TEST_TIMEOUT_CAP_MS = 100;

const requestedBudgets: number[] = [];

/** Budgets requested since the last reset, one entry per withTimeout call. */
export function requestedTimeoutBudgets(): number[] {
  return [...requestedBudgets];
}

export function resetRequestedTimeoutBudgets(): void {
  requestedBudgets.length = 0;
}

export function withFastTimeouts(actual: typeof WithTimeoutModule): typeof WithTimeoutModule {
  return {
    ...actual,
    withTimeout: <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
      requestedBudgets.push(ms);
      return actual.withTimeout(promise, Math.min(ms, TEST_TIMEOUT_CAP_MS), label);
    },
  };
}
