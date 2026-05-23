import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Module-scope spy that the hook will hit through apiFetch.
const apiFetchMock = vi.fn();

vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { useNextAutoUpdateRun } from '../useNextAutoUpdateRun';

function okResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fireInvalidate(detail: { action?: string; scope?: string }) {
  window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail }));
}

describe('useNextAutoUpdateRun', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(() => Promise.resolve(okResponse([])));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once on mount', () => {
    renderHook(() => useNextAutoUpdateRun());
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/scheduled-tasks?action=update',
      expect.objectContaining({ localOnly: true }),
    );
  });

  it('returns the earliest enabled next_run_at across tasks', async () => {
    apiFetchMock.mockImplementationOnce(() => Promise.resolve(okResponse([
      { enabled: 1, next_run_at: 1_900 },
      { enabled: 1, next_run_at: 1_700 },
      { enabled: 0, next_run_at: 1_500 },
      { enabled: 1, next_run_at: null },
    ])));

    const { result } = renderHook(() => useNextAutoUpdateRun());
    // Drain microtasks from the in-flight fetch without advancing fake timers
    // (vi.runAllTimersAsync would loop forever on the 60s poll interval).
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current).toBe(1_700);
  });

  it('debounces rapid invalidations into a single refetch', async () => {
    renderHook(() => useNextAutoUpdateRun());
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    act(() => {
      fireInvalidate({ action: 'auto-update-settings-changed' });
      fireInvalidate({ action: 'auto-update-settings-changed' });
      fireInvalidate({ action: 'auto-update-settings-changed' });
    });
    // Debounce window not yet elapsed: still only the mount call.
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    await act(async () => { vi.advanceTimersByTime(260); });
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it('ignores unrelated state-invalidate events', () => {
    renderHook(() => useNextAutoUpdateRun());
    apiFetchMock.mockClear();
    act(() => {
      fireInvalidate({ action: 'something-else' });
      fireInvalidate({ scope: 'unrelated' });
    });
    vi.advanceTimersByTime(500);
    expect(apiFetchMock).toHaveBeenCalledTimes(0);
  });

  it('polls every 60s', async () => {
    renderHook(() => useNextAutoUpdateRun());
    await act(async () => { await vi.runAllTicks(); });
    apiFetchMock.mockClear();
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it('cleans up listener and interval on unmount (no further fetches)', async () => {
    const { unmount } = renderHook(() => useNextAutoUpdateRun());
    apiFetchMock.mockClear();
    unmount();
    await act(async () => {
      fireInvalidate({ action: 'auto-update-settings-changed' });
      vi.advanceTimersByTime(120_000);
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(0);
  });
});
