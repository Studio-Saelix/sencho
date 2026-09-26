/**
 * The posture read the Drift tab depends on.
 *
 * These cover the hook's own contract rather than the card it feeds: which
 * answer each outcome produces, that a slow answer cannot land as a newer one,
 * and that a GitOps announcement triggers a refetch. A hook defect here is
 * invisible to the component tests, because those drive a finished answer
 * straight in.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import { useGitOpsApplicationPosture } from './useGitOpsApplicationPosture';
import { portfolioRow } from '@/__tests__/gitopsFixtures';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/api';

function res(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, json: async () => body, text: async () => '' } as unknown as Response;
}

/** One deferred answer, so a test can decide when (and with what) it lands. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const postureCalls = () => vi.mocked(apiFetch).mock.calls.filter(([path]) => String(path).startsWith('/gitops/applications'));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useGitOpsApplicationPosture', () => {
  it('answers absent without reading anything when there is no application id', () => {
    const { result } = renderHook(() => useGitOpsApplicationPosture(null));
    expect(result.current.kind).toBe('absent');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('returns the row the detail route answered with', async () => {
    const row = portfolioRow({ posture: 'converged' });
    vi.mocked(apiFetch).mockResolvedValue(res({ application: row }));
    const { result } = renderHook(() => useGitOpsApplicationPosture('1:app-1'));

    await waitFor(() => expect(result.current.kind).toBe('row'));
    expect(result.current).toEqual({ kind: 'row', row });
    expect(apiFetch).toHaveBeenCalledWith('/gitops/applications/1%3Aapp-1', { localOnly: true });
  });

  it('reads the hub, never the active node', async () => {
    // The aggregator is hub-owned. A proxied read would ask a node that cannot
    // compute the posture to answer for it.
    vi.mocked(apiFetch).mockResolvedValue(res({ application: portfolioRow() }));
    renderHook(() => useGitOpsApplicationPosture('1:app-1'));
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(vi.mocked(apiFetch).mock.calls[0]?.[1]).toEqual({ localOnly: true });
  });

  it.each([
    ['a 403, which is a Blueprint read without the fleet-wide grant', 403],
    ['a 404, which is missing or outside this caller grants', 404],
  ])('treats %s as absent rather than as a fault', async (_why, status) => {
    vi.mocked(apiFetch).mockResolvedValue(res({}, false, status));
    const { result } = renderHook(() => useGitOpsApplicationPosture('bp:1'));
    await waitFor(() => expect(result.current.kind).toBe('absent'));
    expect(result.current.kind).not.toBe('unreadable');
  });

  it('treats a server fault as unreadable, because that one really is a fault', async () => {
    vi.mocked(apiFetch).mockResolvedValue(res({}, false, 500));
    const { result } = renderHook(() => useGitOpsApplicationPosture('1:app-1'));
    await waitFor(() => expect(result.current.kind).toBe('unreadable'));
  });

  it('treats a transport failure as unreadable', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useGitOpsApplicationPosture('1:app-1'));
    await waitFor(() => expect(result.current.kind).toBe('unreadable'));
  });

  it('discards a slow answer for a previous id rather than showing it as current', async () => {
    // The node switch case: the answer for the node the operator just left must
    // not land as the new node's posture, which would name another stack's state.
    const slow = deferred<Response>();
    vi.mocked(apiFetch)
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValue(res({ application: portfolioRow({ id: '2:app-2' }) }));

    const { result, rerender } = renderHook(({ id }) => useGitOpsApplicationPosture(id), {
      initialProps: { id: '1:app-1' },
    });
    rerender({ id: '2:app-2' });
    await waitFor(() => expect(result.current.kind).toBe('row'));

    // The first read finally lands, late. It must change nothing.
    await act(async () => {
      slow.resolve(res({ application: portfolioRow({ id: '1:app-1' }) }));
      await slow.promise;
    });
    expect(result.current).toEqual({ kind: 'row', row: portfolioRow({ id: '2:app-2' }) });
  });

  it('refetches when a GitOps transition is announced', async () => {
    vi.useFakeTimers();
    vi.mocked(apiFetch).mockResolvedValue(res({ application: portfolioRow() }));
    renderHook(() => useGitOpsApplicationPosture('1:app-1'));
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));

    await act(async () => {
      window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail: { scope: 'gitops' } }));
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('debounces a burst of announcements into one refetch', async () => {
    vi.useFakeTimers();
    vi.mocked(apiFetch).mockResolvedValue(res({ application: portfolioRow() }));
    renderHook(() => useGitOpsApplicationPosture('1:app-1'));
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));

    // One operation commits several transitions in a row.
    await act(async () => {
      for (let i = 0; i < 5; i += 1) {
        window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail: { scope: 'gitops' } }));
        await vi.advanceTimersByTimeAsync(20);
      }
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('ignores announcements for another scope', async () => {
    vi.useFakeTimers();
    vi.mocked(apiFetch).mockResolvedValue(res({ application: portfolioRow() }));
    renderHook(() => useGitOpsApplicationPosture('1:app-1'));
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));

    await act(async () => {
      window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail: { scope: 'stacks' } }));
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('reads the hub only, once per id', async () => {
    vi.mocked(apiFetch).mockResolvedValue(res({ application: portfolioRow() }));
    const { rerender } = renderHook(({ id }) => useGitOpsApplicationPosture(id), {
      initialProps: { id: '1:app-1' },
    });
    await waitFor(() => expect(postureCalls()).toHaveLength(1));
    // An unrelated re-render must not re-read.
    rerender({ id: '1:app-1' });
    expect(postureCalls()).toHaveLength(1);
  });
});
