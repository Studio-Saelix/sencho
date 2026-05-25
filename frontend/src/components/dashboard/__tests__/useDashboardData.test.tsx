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

// `visibilityInterval` from the live utils library uses
// `document.visibilityState`, which jsdom treats as `prerender` until a
// listener is attached. The polling tests below assert mount-time fetches and
// the debounced refetch path; the long-running interval ticks themselves are
// covered by the existing useNextAutoUpdateRun suite. Replace with a no-op
// cleanup so the hook does not retain a real timer across tests.
vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/utils')>('@/lib/utils');
  return {
    ...actual,
    visibilityInterval: () => () => {},
  };
});

import { useDashboardData } from '../useDashboardData';

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
