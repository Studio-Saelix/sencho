/**
 * A fleet-health observation read must not mutate stored state.
 *
 * The canonical aggregate attaches dismissals by reading them and retiring the
 * ones the evidence proves obsolete. That is correct for the operator surface
 * and wrong for an observation read, which is why the route passes
 * `withDismissals: false`. This case pins the wiring: with the flag off, the
 * retire path is never entered at all, rather than entered and skipped.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { READINESS_DOMAINS } from '../services/readiness/types';

const attach = vi.fn((_input: unknown) => []);

vi.mock('../services/readiness/readinessDismissals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/readiness/readinessDismissals')>();
  return {
    ...actual,
    attachReadinessDismissals: (input: unknown) => attach(input),
  };
});

let tmpDir: string;
let buildFleetReadiness: typeof import('../services/readiness/readinessAggregator').buildFleetReadiness;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ buildFleetReadiness } = await import('../services/readiness/readinessAggregator'));
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  attach.mockClear();
});

function request(withDismissals: boolean) {
  return buildFleetReadiness({
    domains: READINESS_DOMAINS,
    nodeIds: null,
    includeControl: false,
    signal: new AbortController().signal,
    withDismissals,
  });
}

describe('fleet health dismissal attachment', () => {
  it('never enters the retire path for an observation read', async () => {
    const response = await request(false);
    expect(attach).not.toHaveBeenCalled();
    expect(response.dismissals).toEqual([]);
  }, 30_000);

  it('enters it for the operator surface, which is what makes the flag meaningful', async () => {
    await request(true);
    expect(attach).toHaveBeenCalledTimes(1);
  }, 30_000);
});
