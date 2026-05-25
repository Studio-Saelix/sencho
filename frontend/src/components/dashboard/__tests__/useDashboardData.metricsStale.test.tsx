import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const apiFetchMock = vi.fn();

vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const useNodesMock = vi.fn();
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => useNodesMock(),
}));

// Capture every visibilityInterval registration so each polling cycle can
// be driven on demand from the test without leaning on real setInterval
// timers (which fight with vi.useFakeTimers and the await-then-setState
// sequence inside the polling callbacks).
type PollEntry = { fn: () => void; intervalMs: number };
let pollCallbacks: PollEntry[] = [];
vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/utils')>('@/lib/utils');
  return {
    ...actual,
    visibilityInterval: (fn: () => void, intervalMs: number) => {
      pollCallbacks.push({ fn, intervalMs });
      return () => { pollCallbacks = pollCallbacks.filter((c) => c.fn !== fn); };
    },
  };
});

import { useDashboardData } from '../useDashboardData';

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function failJson(): Response {
  return new Response(JSON.stringify({ error: 'down' }), { status: 500 });
}

const STATS_PAYLOAD = { active: 0, managed: 0, unmanaged: 0, exited: 0, total: 0 };
const SYS_PAYLOAD = {
  cpu: { usage: '0', cores: 4 },
  memory: { total: 0, used: 0, free: 0, usagePercent: '0' },
  disk: null,
};

function setEndpointOutcome(endpoint: '/stats' | '/system/stats', ok: boolean): void {
  apiFetchMock.mockImplementation((requested: string) => {
    if (requested === '/stats') {
      if (endpoint === '/stats' && !ok) return Promise.resolve(failJson());
      return Promise.resolve(okJson(STATS_PAYLOAD));
    }
    if (requested === '/system/stats') {
      if (endpoint === '/system/stats' && !ok) return Promise.resolve(failJson());
      return Promise.resolve(okJson(SYS_PAYLOAD));
    }
    if (requested === '/stacks/statuses') return Promise.resolve(okJson({}));
    if (requested === '/metrics/historical') return Promise.resolve(okJson([]));
    return Promise.resolve(okJson(null));
  });
}

// Drive the next /stats poll (it is the first 5 s interval registered).
async function tickStats(): Promise<void> {
  const stats = pollCallbacks.find((c) => c.intervalMs === 5000);
  if (!stats) throw new Error('stats poll callback not registered');
  await act(async () => {
    stats.fn();
    // Two microtask drains: one for the apiFetch promise, one for the await
    // on res.json() inside fetchJson.
    await Promise.resolve();
    await Promise.resolve();
  });
}

// Drive the next /system/stats poll (the second 5 s interval registered).
async function tickSys(): Promise<void> {
  const sys = pollCallbacks.filter((c) => c.intervalMs === 5000)[1];
  if (!sys) throw new Error('system-stats poll callback not registered');
  await act(async () => {
    sys.fn();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  pollCallbacks = [];
  apiFetchMock.mockReset();
  useNodesMock.mockReset();
  useNodesMock.mockReturnValue({
    activeNode: { id: 1, name: 'Local', type: 'local' },
    nodes: [{ id: 1, name: 'Local', type: 'local' }],
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useDashboardData metricsStale threshold', () => {
  it('trips after three consecutive /stats failures and clears on the next success', async () => {
    // Stats fails from the very first poll; system-stats keeps succeeding.
    setEndpointOutcome('/stats', false);
    const { result } = renderHook(() => useDashboardData());
    // Drain mount-time fetches.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    // Mount fired one failed /stats poll (counter = 1) and one successful
    // /system/stats poll. Two more failed stats polls cross the threshold.
    expect(result.current.metricsStale).toBe(false);
    await tickStats();
    expect(result.current.metricsStale).toBe(false);
    await tickStats();
    expect(result.current.metricsStale).toBe(true);

    // The first successful /stats poll resets the counter; with the
    // /system/stats endpoint still below threshold, the indicator clears.
    setEndpointOutcome('/stats', true);
    await tickStats();
    expect(result.current.metricsStale).toBe(false);
  });

  it('trips after three consecutive /system/stats failures as well', async () => {
    setEndpointOutcome('/system/stats', false);
    const { result } = renderHook(() => useDashboardData());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(result.current.metricsStale).toBe(false);
    await tickSys();
    expect(result.current.metricsStale).toBe(false);
    await tickSys();
    expect(result.current.metricsStale).toBe(true);
  });

  it('keeps the indicator set when one endpoint recovers but the other is still failing', async () => {
    // Both fail; trip on stats first, then recover stats only.
    setEndpointOutcome('/stats', false);
    const { result } = renderHook(() => useDashboardData());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    // Now break /system/stats too so its counter starts climbing.
    apiFetchMock.mockImplementation((requested: string) => {
      if (requested === '/stats') return Promise.resolve(failJson());
      if (requested === '/system/stats') return Promise.resolve(failJson());
      if (requested === '/stacks/statuses') return Promise.resolve(okJson({}));
      if (requested === '/metrics/historical') return Promise.resolve(okJson([]));
      return Promise.resolve(okJson(null));
    });

    // Three failing sys polls trip the indicator.
    await tickSys();
    await tickSys();
    await tickSys();
    expect(result.current.metricsStale).toBe(true);

    // Stats recovers but /system/stats is still failing: indicator stays set
    // because the sys counter is still above the threshold.
    apiFetchMock.mockImplementation((requested: string) => {
      if (requested === '/stats') return Promise.resolve(okJson(STATS_PAYLOAD));
      if (requested === '/system/stats') return Promise.resolve(failJson());
      if (requested === '/stacks/statuses') return Promise.resolve(okJson({}));
      if (requested === '/metrics/historical') return Promise.resolve(okJson([]));
      return Promise.resolve(okJson(null));
    });
    await tickStats();
    expect(result.current.metricsStale).toBe(true);
  });
});
