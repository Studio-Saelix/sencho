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
import { __resetStackStatusesFetchForTests } from '@/lib/stackStatusesFetch';

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
  __resetStackStatusesFetchForTests();
  apiFetchMock.mockReset();
  useNodesMock.mockReset();
  useNodesMock.mockReturnValue({
    activeNode: { id: 1, name: 'Local', type: 'local' },
    nodes: [{ id: 1, name: 'Local', type: 'local' }],
  });
});

afterEach(() => {
  __resetStackStatusesFetchForTests();
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
    expect(result.current.metricsUnreadable).toBe(false);

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

  it('trips on the first bounded read deadline instead of waiting for three polls', async () => {
    // A node that missed the gateway read deadline is not a transient hiccup:
    // it is reported as unavailable on the first answer, so the gauges stop
    // reading as zeros while the node stays silent.
    apiFetchMock.mockImplementation((requested: string) => {
      if (requested === '/stats') {
        return Promise.resolve(new Response(
          JSON.stringify({ code: 'remote_read_timeout' }),
          { status: 504, headers: { 'x-sencho-read-timeout': '1' } },
        ));
      }
      if (requested === '/system/stats') return Promise.resolve(okJson(SYS_PAYLOAD));
      if (requested === '/stacks/statuses') return Promise.resolve(okJson({}));
      if (requested === '/metrics/historical') return Promise.resolve(okJson([]));
      return Promise.resolve(okJson(null));
    });

    const { result } = renderHook(() => useDashboardData());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(result.current.metricsStale).toBe(true);
  });

  it('marks metrics unreadable only when the node did not answer', async () => {
    apiFetchMock.mockImplementation((requested: string) => {
      if (requested === '/stats') {
        return Promise.resolve(new Response(
          JSON.stringify({ code: 'remote_read_timeout' }),
          { status: 504, headers: { 'x-sencho-read-timeout': '1' } },
        ));
      }
      if (requested === '/system/stats') return Promise.resolve(okJson(SYS_PAYLOAD));
      if (requested === '/stacks/statuses') return Promise.resolve(okJson({}));
      if (requested === '/metrics/historical') return Promise.resolve(okJson([]));
      return Promise.resolve(okJson(null));
    });

    const { result } = renderHook(() => useDashboardData());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(result.current.metricsStale).toBe(true);
    expect(result.current.metricsUnreadable).toBe(true);

    // A later success on the same endpoint clears the unreadable state; the
    // node answered again.
    setEndpointOutcome('/stats', true);
    await tickStats();
    expect(result.current.metricsUnreadable).toBe(false);
  });

  it('names a disconnected Pilot from the first failed metrics read, not a healthy level', async () => {
    // A Pilot agent that is stopped answers instantly with a marked 503. That
    // is the hub having no readable path to the node, so the headline must not
    // wait for three polls and must not call it "not answering".
    apiFetchMock.mockImplementation((requested: string) => {
      if (requested === '/stats') {
        return Promise.resolve(new Response(
          JSON.stringify({ error: 'Pilot tunnel disconnected.' }),
          { status: 503, headers: { 'x-sencho-read-failure': 'pilot-disconnected' } },
        ));
      }
      if (requested === '/system/stats') return Promise.resolve(okJson(SYS_PAYLOAD));
      if (requested === '/stacks/statuses') return Promise.resolve(okJson({}));
      if (requested === '/metrics/historical') return Promise.resolve(okJson([]));
      return Promise.resolve(okJson(null));
    });

    const { result } = renderHook(() => useDashboardData());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(result.current.metricsUnreadable).toBe(true);
    expect(result.current.unreadableCause).toBe('pilot-disconnected');
    expect(result.current.metricsStale).toBe(true);
  });

  it('carries a disconnected Pilot from the stack-statuses read before the metrics answer', async () => {
    apiFetchMock.mockImplementation((requested: string) => {
      if (requested === '/stacks/statuses') {
        return Promise.resolve(new Response(
          JSON.stringify({ error: 'Pilot tunnel disconnected.' }),
          { status: 503, headers: { 'x-sencho-read-failure': 'pilot-disconnected' } },
        ));
      }
      return new Promise<Response>(() => {});
    });

    const { result } = renderHook(() => useDashboardData());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(result.current.metricsSettled).toBe(false);
    expect(result.current.metricsUnreadable).toBe(true);
    expect(result.current.unreadableCause).toBe('pilot-disconnected');
  });

  it('clears the cause when the node answers again', async () => {
    setEndpointOutcome('/stats', true);
    const { result } = renderHook(() => useDashboardData());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(result.current.unreadableCause).toBeNull();
    expect(result.current.metricsUnreadable).toBe(false);
  });

  it('does not treat an ordinary HTTP failure as an unavailable node', async () => {
    setEndpointOutcome('/stats', false);
    const { result } = renderHook(() => useDashboardData());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(result.current.metricsStale).toBe(false);
    expect(result.current.metricsUnreadable).toBe(false);
  });

  it('reads the node as unreadable from the first failed read while the metrics are still queued', async () => {
    // The browser allows six connections per origin, so the metrics requests
    // can be queued behind other node-scoped reads. The stack-statuses deadline
    // has already proved the node is silent; waiting for the queued metrics
    // would leave the headline on its healthy default for several more rounds.
    apiFetchMock.mockImplementation((requested: string) => {
      if (requested === '/stacks/statuses') {
        return Promise.resolve(new Response(
          JSON.stringify({ code: 'remote_read_timeout' }),
          { status: 504, headers: { 'x-sencho-read-timeout': '1' } },
        ));
      }
      // The metrics endpoints have not answered yet (queued or slow).
      return new Promise<Response>(() => {});
    });

    const { result } = renderHook(() => useDashboardData());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(result.current.metricsSettled).toBe(false);
    expect(result.current.metricsUnreadable).toBe(true);
    expect(result.current.metricsStale).toBe(true);
  });

  it('does not read an HTTP stack-statuses failure as a silent node', async () => {
    apiFetchMock.mockImplementation((requested: string) => {
      if (requested === '/stacks/statuses') return Promise.resolve(failJson());
      return new Promise<Response>(() => {});
    });

    const { result } = renderHook(() => useDashboardData());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(result.current.metricsUnreadable).toBe(false);
  });

  it('does not blame the node when a route fails after the metrics answered', async () => {
    let releaseStatuses: (() => void) | null = null;
    apiFetchMock.mockImplementation((requested: string) => {
      if (requested === '/stacks/statuses') {
        return new Promise<Response>((resolve) => {
          releaseStatuses = () => resolve(new Response(
            JSON.stringify({ code: 'remote_read_timeout' }),
            { status: 504, headers: { 'x-sencho-read-timeout': '1' } },
          ));
        });
      }
      if (requested === '/stats') return Promise.resolve(okJson(STATS_PAYLOAD));
      if (requested === '/system/stats') return Promise.resolve(okJson(SYS_PAYLOAD));
      if (requested === '/metrics/historical') return Promise.resolve(okJson([]));
      return Promise.resolve(okJson(null));
    });

    const { result } = renderHook(() => useDashboardData());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.metricsUnreadable).toBe(false);

    await act(async () => {
      releaseStatuses?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.metricsUnreadable).toBe(false);
  });

  it('aborts its in-flight reads when the dashboard goes away', async () => {
    // A read for a surface the operator has left must release its connection
    // slot, or the next page's reads queue behind it.
    const ownReadSignals: AbortSignal[] = [];
    apiFetchMock.mockImplementation((requested: string, options?: { signal?: AbortSignal }) => {
      // The stack-statuses read is shared with the persistent sidebar, so its
      // lifetime belongs to the shared coalescer, not this hook.
      if (options?.signal && requested !== '/stacks/statuses') ownReadSignals.push(options.signal);
      return new Promise<Response>(() => {});
    });

    const { unmount } = renderHook(() => useDashboardData());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(ownReadSignals.length).toBeGreaterThanOrEqual(3);
    expect(ownReadSignals.some((signal) => signal.aborted)).toBe(false);
    unmount();
    expect(ownReadSignals.every((signal) => signal.aborted)).toBe(true);
  });
});
