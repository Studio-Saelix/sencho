import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const apiFetchMock = vi.fn();

vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

// Stable mock for the node context: ID `1` is the active node so the hook can
// resolve a nodeId on mount without rendering the full provider tree.
const useNodesMock = vi.fn();
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => useNodesMock(),
}));

// Statuses soft-poll uses visibilityInterval (setInterval). Use a real timer so
// tests can advance past the 10s cadence; skip document.visibility wiring.
vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/utils')>('@/lib/utils');
  return {
    ...actual,
    visibilityInterval: (fn: () => void, ms: number) => {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
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

function fireInvalidate(detail: { scope?: string; action?: string } = {}) {
  window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail }));
}

const STATS_PAYLOAD = { active: 0, managed: 0, unmanaged: 0, exited: 0, total: 0 };
const SYS_PAYLOAD = {
  cpu: { usage: '0', cores: 4 },
  memory: { total: 0, used: 0, free: 0, usagePercent: '0' },
  disk: null,
};

beforeEach(() => {
  vi.useFakeTimers();
  __resetStackStatusesFetchForTests();
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((endpoint: string) => {
    if (endpoint === '/stats') return Promise.resolve(okJson(STATS_PAYLOAD));
    if (endpoint === '/system/stats') return Promise.resolve(okJson(SYS_PAYLOAD));
    if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({}));
    if (endpoint === '/metrics/historical') return Promise.resolve(okJson([]));
    return Promise.resolve(okJson(null));
  });
  useNodesMock.mockReset();
  useNodesMock.mockReturnValue({
    activeNode: { id: 1, name: 'Local', type: 'local' },
    nodes: [{ id: 1, name: 'Local', type: 'local' }],
  });
});

afterEach(() => {
  __resetStackStatusesFetchForTests();
  vi.useRealTimers();
});

function countFetchCalls(endpoint: string): number {
  return apiFetchMock.mock.calls.filter((call) => call[0] === endpoint).length;
}

describe('useDashboardData state-invalidate handling', () => {
  it('debounces a burst of state-invalidate events into a single refetch', async () => {
    renderHook(() => useDashboardData());
    // Drain mount-time polls.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const baselineStats = countFetchCalls('/stats');
    const baselineSys = countFetchCalls('/system/stats');
    const baselineStatuses = countFetchCalls('/stacks/statuses');

    act(() => {
      // Burst: 10 container events in rapid succession.
      for (let i = 0; i < 10; i += 1) fireInvalidate({ scope: 'container' });
    });

    // Before debounce window elapses, no new fetches.
    expect(countFetchCalls('/stats') - baselineStats).toBe(0);
    expect(countFetchCalls('/system/stats') - baselineSys).toBe(0);
    expect(countFetchCalls('/stacks/statuses') - baselineStatuses).toBe(0);

    await act(async () => { vi.advanceTimersByTime(300); });

    // After debounce: exactly one refetch per endpoint, regardless of burst size.
    expect(countFetchCalls('/stats') - baselineStats).toBe(1);
    expect(countFetchCalls('/system/stats') - baselineSys).toBe(1);
    expect(countFetchCalls('/stacks/statuses') - baselineStatuses).toBe(1);
  });

  it('cleans up the debounce timer on unmount so no late refetch fires', async () => {
    const { unmount } = renderHook(() => useDashboardData());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    apiFetchMock.mockClear();

    act(() => { fireInvalidate({ scope: 'container' }); });
    unmount();
    await act(async () => { vi.advanceTimersByTime(500); });

    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('useDashboardData stackStatuses load states', () => {
  it('reaches success with an empty map without treating deferral as empty UI state', async () => {
    let resolveStatuses: ((r: Response) => void) | null = null;
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stats') return Promise.resolve(okJson(STATS_PAYLOAD));
      if (endpoint === '/system/stats') return Promise.resolve(okJson(SYS_PAYLOAD));
      if (endpoint === '/metrics/historical') return Promise.resolve(okJson([]));
      if (endpoint === '/stacks/statuses') {
        return new Promise<Response>((resolve) => { resolveStatuses = resolve; });
      }
      return Promise.resolve(okJson(null));
    });

    const { result } = renderHook(() => useDashboardData());
    await act(async () => { await Promise.resolve(); });
    expect(result.current.stackStatusesLoadStatus).toBe('loading');

    await act(async () => {
      resolveStatuses?.(okJson({}));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.stackStatusesLoadStatus).toBe('success');
    expect(result.current.stackStatuses).toEqual({});
  });

  it('surfaces error on failed statuses fetch and recovers on retry', async () => {
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stats') return Promise.resolve(okJson(STATS_PAYLOAD));
      if (endpoint === '/system/stats') return Promise.resolve(okJson(SYS_PAYLOAD));
      if (endpoint === '/metrics/historical') return Promise.resolve(okJson([]));
      if (endpoint === '/stacks/statuses') {
        return Promise.resolve(new Response('nope', { status: 500 }));
      }
      return Promise.resolve(okJson(null));
    });

    const { result } = renderHook(() => useDashboardData());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.stackStatusesLoadStatus).toBe('error');

    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stats') return Promise.resolve(okJson(STATS_PAYLOAD));
      if (endpoint === '/system/stats') return Promise.resolve(okJson(SYS_PAYLOAD));
      if (endpoint === '/metrics/historical') return Promise.resolve(okJson([]));
      if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({}));
      return Promise.resolve(okJson(null));
    });

    await act(async () => {
      result.current.retryStackStatuses();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.stackStatusesLoadStatus).toBe('success');
  });

  it('joins a foreground retry onto an in-flight soft statuses fetch', async () => {
    const resolvers: Array<(r: Response) => void> = [];
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stats') return Promise.resolve(okJson(STATS_PAYLOAD));
      if (endpoint === '/system/stats') return Promise.resolve(okJson(SYS_PAYLOAD));
      if (endpoint === '/metrics/historical') return Promise.resolve(okJson([]));
      if (endpoint === '/stacks/statuses') {
        return new Promise<Response>((resolve) => { resolvers.push(resolve); });
      }
      return Promise.resolve(okJson(null));
    });

    const { result } = renderHook(() => useDashboardData());
    await act(async () => { await Promise.resolve(); });
    expect(resolvers).toHaveLength(1);

    await act(async () => {
      resolvers[0](okJson({}));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.stackStatusesLoadStatus).toBe('success');

    act(() => { fireInvalidate({ scope: 'container' }); });
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(resolvers).toHaveLength(2);

    await act(async () => {
      result.current.retryStackStatuses();
      await Promise.resolve();
    });
    // Soft and foreground share one in-flight /stacks/statuses.
    expect(resolvers).toHaveLength(2);

    const sharedMap = { 'web.yml': { status: 'running' as const } };
    await act(async () => {
      resolvers[1](okJson(sharedMap));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.stackStatusesLoadStatus).toBe('success');
    expect(result.current.stackStatuses).toEqual(sharedMap);
  });

  it('lets the newer foreground generation commit a shared in-flight failure', async () => {
    const resolvers: Array<(r: Response) => void> = [];
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stats') return Promise.resolve(okJson(STATS_PAYLOAD));
      if (endpoint === '/system/stats') return Promise.resolve(okJson(SYS_PAYLOAD));
      if (endpoint === '/metrics/historical') return Promise.resolve(okJson([]));
      if (endpoint === '/stacks/statuses') {
        return new Promise<Response>((resolve) => { resolvers.push(resolve); });
      }
      return Promise.resolve(okJson(null));
    });

    const { result } = renderHook(() => useDashboardData());
    await act(async () => { await Promise.resolve(); });
    expect(resolvers).toHaveLength(1);

    await act(async () => {
      resolvers[0](okJson({ 'web.yml': { status: 'running' } }));
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => { fireInvalidate({ scope: 'container' }); });
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(resolvers).toHaveLength(2);

    await act(async () => {
      result.current.retryStackStatuses();
      await Promise.resolve();
    });
    expect(resolvers).toHaveLength(2);

    await act(async () => {
      resolvers[1](new Response('nope', { status: 500 }));
      await Promise.resolve();
      await Promise.resolve();
    });
    // Soft's older generation is ignored; the foreground generation commits
    // the shared failure as an error status (rows are not cleared on failure).
    expect(result.current.stackStatusesLoadStatus).toBe('error');
  });

  it('lets a slow foreground statuses response commit after soft poll and invalidate ticks', async () => {
    const resolvers: Array<(r: Response) => void> = [];
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stats') return Promise.resolve(okJson(STATS_PAYLOAD));
      if (endpoint === '/system/stats') return Promise.resolve(okJson(SYS_PAYLOAD));
      if (endpoint === '/metrics/historical') return Promise.resolve(okJson([]));
      if (endpoint === '/stacks/statuses') {
        return new Promise<Response>((resolve) => { resolvers.push(resolve); });
      }
      return Promise.resolve(okJson(null));
    });

    const { result } = renderHook(() => useDashboardData());
    await act(async () => { await Promise.resolve(); });
    expect(resolvers).toHaveLength(1);
    expect(result.current.stackStatusesLoadStatus).toBe('loading');

    act(() => { fireInvalidate({ scope: 'container' }); });
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(resolvers).toHaveLength(1);

    await act(async () => { vi.advanceTimersByTime(10000); });
    expect(resolvers).toHaveLength(1);
    await act(async () => { vi.advanceTimersByTime(10000); });
    expect(resolvers).toHaveLength(1);

    const settled = { 'web.yml': { status: 'running' as const } };
    await act(async () => {
      resolvers[0](okJson(settled));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.stackStatusesLoadStatus).toBe('success');
    expect(result.current.stackStatuses).toEqual(settled);
  });

  it('turns a soft poll failure into a recoverable error when the prior success was empty', async () => {
    const resolvers: Array<(r: Response) => void> = [];
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stats') return Promise.resolve(okJson(STATS_PAYLOAD));
      if (endpoint === '/system/stats') return Promise.resolve(okJson(SYS_PAYLOAD));
      if (endpoint === '/metrics/historical') return Promise.resolve(okJson([]));
      if (endpoint === '/stacks/statuses') {
        return new Promise<Response>((resolve) => { resolvers.push(resolve); });
      }
      return Promise.resolve(okJson(null));
    });

    const { result } = renderHook(() => useDashboardData());
    await act(async () => { await Promise.resolve(); });
    expect(resolvers).toHaveLength(1);

    // Foreground load settles on confirmed-empty.
    await act(async () => {
      resolvers[0](okJson({}));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.stackStatusesLoadStatus).toBe('success');
    expect(result.current.stackStatuses).toEqual({});

    // A subsequent soft poll fails: this must not stay a silent empty state.
    act(() => { fireInvalidate({ scope: 'container' }); });
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(resolvers).toHaveLength(2);

    await act(async () => {
      resolvers[1](new Response('nope', { status: 500 }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.stackStatusesLoadStatus).toBe('error');
  });

  it('drops a malformed per-stack entry instead of crashing, keeping the rest of a valid response', async () => {
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stats') return Promise.resolve(okJson(STATS_PAYLOAD));
      if (endpoint === '/system/stats') return Promise.resolve(okJson(SYS_PAYLOAD));
      if (endpoint === '/metrics/historical') return Promise.resolve(okJson([]));
      if (endpoint === '/stacks/statuses') {
        return Promise.resolve(okJson({
          'web.yml': { status: 'running' },
          'broken.yml': null,
          'also-broken.yml': 'running',
        }));
      }
      return Promise.resolve(okJson(null));
    });

    const { result } = renderHook(() => useDashboardData());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(result.current.stackStatusesLoadStatus).toBe('success');
    expect(result.current.stackStatuses).toEqual({ 'web.yml': { status: 'running' } });
  });

  it('treats a non-empty response where every entry is malformed as an error, not confirmed-empty', async () => {
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stats') return Promise.resolve(okJson(STATS_PAYLOAD));
      if (endpoint === '/system/stats') return Promise.resolve(okJson(SYS_PAYLOAD));
      if (endpoint === '/metrics/historical') return Promise.resolve(okJson([]));
      if (endpoint === '/stacks/statuses') {
        return Promise.resolve(okJson({ 'a.yml': null, 'b.yml': 'running' }));
      }
      return Promise.resolve(okJson(null));
    });

    const { result } = renderHook(() => useDashboardData());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(result.current.stackStatusesLoadStatus).toBe('error');
    expect(result.current.stackStatuses).toEqual({});
  });

  it('does not fetch statuses while activeNode is unresolved and stays loading', async () => {
    useNodesMock.mockReturnValue({
      activeNode: undefined,
      nodes: [],
    });

    const { result, rerender } = renderHook(() => useDashboardData());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(countFetchCalls('/stacks/statuses')).toBe(0);
    expect(result.current.stackStatusesLoadStatus).toBe('loading');
    expect(result.current.stackStatuses).toEqual({});

    useNodesMock.mockReturnValue({
      activeNode: { id: 7, name: 'Remote', type: 'remote' },
      nodes: [{ id: 7, name: 'Remote', type: 'remote' }],
    });
    rerender();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(countFetchCalls('/stacks/statuses')).toBe(1);
    expect(apiFetchMock.mock.calls.some(
      (call) => call[0] === '/stacks/statuses' && call[1]?.nodeId === 7,
    )).toBe(true);
  });
});
