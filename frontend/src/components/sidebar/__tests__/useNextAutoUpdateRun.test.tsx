import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Module-scope spy that the hook will hit through apiFetch.
const apiFetchMock = vi.fn();

vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

// The hook gates its poll on the admin role, mirroring the admin-only
// `/scheduled-tasks` route. A module-scope toggle the mock reads lazily lets
// each test set the effective role before rendering.
let mockIsAdmin = true;
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ isAdmin: mockIsAdmin }),
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
    mockIsAdmin = true;
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

  it('debounces rapid scheduled-tasks invalidations into a single refetch', async () => {
    renderHook(() => useNextAutoUpdateRun());
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    act(() => {
      fireInvalidate({ scope: 'scheduled-tasks' });
      fireInvalidate({ scope: 'scheduled-tasks' });
      fireInvalidate({ scope: 'scheduled-tasks' });
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
      fireInvalidate({ scope: 'unrelated' });
      fireInvalidate({ scope: 'stack' });
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
      fireInvalidate({ scope: 'scheduled-tasks' });
      vi.advanceTimersByTime(120_000);
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(0);
  });

  it('does not fetch when the user is not an admin', async () => {
    mockIsAdmin = false;
    const { result } = renderHook(() => useNextAutoUpdateRun());
    await act(async () => {
      fireInvalidate({ scope: 'scheduled-tasks' });
      vi.advanceTimersByTime(120_000);
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(0);
    expect(result.current).toBeNull();
  });

  it('clears the cached run and stops polling when admin is lost', async () => {
    apiFetchMock.mockImplementation(() => Promise.resolve(okResponse([
      { enabled: 1, next_run_at: 1_700 },
    ])));
    const { result, rerender } = renderHook(() => useNextAutoUpdateRun());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current).toBe(1_700);

    // A benign admin-to-admin rerender must keep the cached run, so the null
    // below is provably caused by losing admin, not by any rerender.
    act(() => { rerender(); });
    expect(result.current).toBe(1_700);

    apiFetchMock.mockClear();
    mockIsAdmin = false;
    act(() => { rerender(); });
    expect(result.current).toBeNull();

    await act(async () => {
      fireInvalidate({ scope: 'scheduled-tasks' });
      vi.advanceTimersByTime(120_000);
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(0);
  });

  it('starts polling once the user becomes an admin', async () => {
    mockIsAdmin = false;
    const { rerender } = renderHook(() => useNextAutoUpdateRun());
    expect(apiFetchMock).toHaveBeenCalledTimes(0);

    mockIsAdmin = true;
    act(() => { rerender(); });
    // The mount fetch fires immediately on promotion...
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/scheduled-tasks?action=update',
      expect.objectContaining({ localOnly: true }),
    );
    // ...and the 60s interval is armed again, so polling truly resumed.
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });
});
