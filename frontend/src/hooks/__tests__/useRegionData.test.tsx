/**
 * useRegionData owns one page region's hydration: its own request, its own
 * loading status, and its last good payload. These lock the properties the
 * Resources and Security pages rely on: a region never presents another scope's
 * data, a refresh keeps the visible payload until the new one lands, and a
 * failed refresh does not blank a region the operator was already reading.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useRegionData } from '../useRegionData';

interface Deferred<T> {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

/** A loader whose promises the test settles by hand, in arrival order. */
function deferredLoader<T>() {
  const pending: Deferred<T>[] = [];
  const load = vi.fn(() => new Promise<T>((resolve, reject) => {
    pending.push({ resolve, reject });
  }));
  return { load, pending };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useRegionData', () => {
  it('reads as loading, then ready with the payload', async () => {
    const { load, pending } = deferredLoader<string>();
    const { result } = renderHook(() => useRegionData(1, load));

    expect(result.current.status).toBe('loading');
    expect(result.current.data).toBeNull();

    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => pending[0].resolve('images'));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.data).toBe('images');
  });

  it('drops a response for a scope the operator already left', async () => {
    const { load, pending } = deferredLoader<string>();
    const { result, rerender } = renderHook(
      ({ scope }: { scope: number }) => useRegionData(scope, load),
      { initialProps: { scope: 1 } },
    );

    await waitFor(() => expect(pending).toHaveLength(1));
    rerender({ scope: 2 });
    await waitFor(() => expect(pending).toHaveLength(2));

    // The node the operator left answers late; it must not become visible.
    act(() => pending[0].resolve('node-1'));
    expect(result.current.data).toBeNull();
    expect(result.current.status).toBe('loading');

    act(() => pending[1].resolve('node-2'));
    await waitFor(() => expect(result.current.data).toBe('node-2'));
  });

  it('keeps the visible payload while a refresh is in flight', async () => {
    const { load, pending } = deferredLoader<string>();
    const { result } = renderHook(() => useRegionData(1, load));

    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => pending[0].resolve('first'));
    await waitFor(() => expect(result.current.data).toBe('first'));

    act(() => { void result.current.refresh(); });
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(result.current.status).toBe('ready');
    expect(result.current.data).toBe('first');

    act(() => pending[1].resolve('second'));
    await waitFor(() => expect(result.current.data).toBe('second'));
  });

  it('resolves a refresh only once the read it started succeeds', async () => {
    const { load, pending } = deferredLoader<string>();
    const { result } = renderHook(() => useRegionData(1, load));

    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => pending[0].resolve('first'));
    await waitFor(() => expect(result.current.data).toBe('first'));

    let settled = false;
    act(() => {
      void result.current.refresh().then(() => { settled = true; });
    });
    await waitFor(() => expect(pending).toHaveLength(2));
    // The new read is still in flight: callers that keep a destructive action
    // busy until the refreshed payload lands must not be released yet.
    await act(async () => { await Promise.resolve(); });
    expect(settled).toBe(false);

    act(() => pending[1].resolve('second'));
    await waitFor(() => expect(settled).toBe(true));
    expect(result.current.data).toBe('second');
  });

  it('resolves a refresh when the read it started fails', async () => {
    const onError = vi.fn();
    const { load, pending } = deferredLoader<string>();
    const { result } = renderHook(() => useRegionData(1, load, 0, { onError }));

    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => pending[0].resolve('first'));
    await waitFor(() => expect(result.current.data).toBe('first'));

    let settled = false;
    act(() => {
      void result.current.refresh().then(() => { settled = true; });
    });
    await waitFor(() => expect(pending).toHaveLength(2));
    act(() => pending[1].reject(new Error('refresh failed')));

    // A failed refresh still settles its caller, so a mutation cannot stay busy
    // forever when the follow-up read fails.
    await waitFor(() => expect(settled).toBe(true));
    expect(result.current.data).toBe('first');
  });

  it('resolves a refresh when a scope change supersedes the read it started', async () => {
    const { load, pending } = deferredLoader<string>();
    const { result, rerender } = renderHook(
      ({ scope }: { scope: number }) => useRegionData(scope, load),
      { initialProps: { scope: 1 } },
    );

    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => pending[0].resolve('node-1'));
    await waitFor(() => expect(result.current.data).toBe('node-1'));

    let settled = false;
    act(() => {
      void result.current.refresh().then(() => { settled = true; });
    });
    await waitFor(() => expect(pending).toHaveLength(2));

    // The operator switches nodes before the refresh answers. The abandoned
    // read must settle its caller even though its response is dropped.
    rerender({ scope: 2 });
    await waitFor(() => expect(pending).toHaveLength(3));
    expect(settled).toBe(true);
    act(() => pending[2].resolve('node-2'));
    await waitFor(() => expect(result.current.data).toBe('node-2'));
  });

  it('keeps the visible payload when a refresh fails, and reports it as a refresh', async () => {
    const onError = vi.fn();
    const { load, pending } = deferredLoader<string>();
    const { result } = renderHook(() => useRegionData(1, load, 0, { onError }));

    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => pending[0].resolve('first'));
    await waitFor(() => expect(result.current.data).toBe('first'));

    act(() => { void result.current.refresh(); });
    await waitFor(() => expect(pending).toHaveLength(2));
    act(() => pending[1].reject(new Error('/system/resources responded 500')));

    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0][1]).toBe(true);
    expect(result.current.data).toBe('first');
    expect(result.current.status).toBe('ready');
  });

  it('records a failed first read as failed, and reports it as a first read', async () => {
    const onError = vi.fn();
    const { load, pending } = deferredLoader<string>();
    const { result } = renderHook(() => useRegionData(1, load, 0, { onError }));

    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => pending[0].reject(new Error('boom')));

    await waitFor(() => expect(result.current.status).toBe('failed'));
    expect(result.current.data).toBeNull();
    expect(onError.mock.calls[0][1]).toBe(false);
  });

  it('exposes what a failed first read threw, and clears it when the retry starts', async () => {
    const failure = new Error('/system/orphans responded 504');
    const { load, pending } = deferredLoader<string>();
    const { result } = renderHook(() => useRegionData(1, load));

    expect(result.current.error).toBeNull();
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => pending[0].reject(failure));
    await waitFor(() => expect(result.current.status).toBe('failed'));
    expect(result.current.error).toBe(failure);

    act(() => { void result.current.refresh(); });
    await waitFor(() => expect(result.current.status).toBe('loading'));
    expect(result.current.error).toBeNull();

    await waitFor(() => expect(pending).toHaveLength(2));
    act(() => pending[1].resolve('recovered'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.error).toBeNull();
  });

  it('adopts a payload fetched elsewhere for the scope on screen', async () => {
    const { load, pending } = deferredLoader<string[]>();
    const { result } = renderHook(() => useRegionData(1, load));

    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => pending[0].resolve(['a']));
    await waitFor(() => expect(result.current.data).toEqual(['a']));

    act(() => result.current.apply(['a', 'b']));
    expect(result.current.data).toEqual(['a', 'b']);
    expect(result.current.status).toBe('ready');
    // Adopting a payload must not start a request of its own.
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps an adopted payload when a read that started earlier answers later', async () => {
    const { load, pending } = deferredLoader<string[]>();
    const { result } = renderHook(() => useRegionData(1, load));

    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => pending[0].resolve(['a']));
    await waitFor(() => expect(result.current.data).toEqual(['a']));

    // A read is in flight when a scan result arrives and is adopted.
    act(() => { void result.current.refresh(); });
    await waitFor(() => expect(pending).toHaveLength(2));
    act(() => result.current.apply(['a', 'b']));

    // The read that started before the adoption is older than the payload
    // already on screen, so it must not overwrite it.
    await act(async () => { pending[1].resolve(['a']); });
    expect(result.current.data).toEqual(['a', 'b']);
    expect(result.current.status).toBe('ready');
  });

  it('ignores an adopted payload that belongs to another scope', async () => {
    const { load, pending } = deferredLoader<string[]>();
    const { result, rerender } = renderHook(
      ({ scope }: { scope: number }) => useRegionData(scope, load),
      { initialProps: { scope: 1 } },
    );

    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => pending[0].resolve(['node-1']));
    await waitFor(() => expect(result.current.data).toEqual(['node-1']));

    // A handler captured on node 1 (a scan completing) runs after the switch.
    const applyNodeOne = result.current.apply;
    rerender({ scope: 2 });
    await waitFor(() => expect(pending).toHaveLength(2));
    act(() => pending[1].resolve(['node-2']));
    await waitFor(() => expect(result.current.data).toEqual(['node-2']));

    act(() => applyNodeOne(['late-node-1']));
    // Writing another scope's payload would blank the scope on screen and,
    // because no new read starts, leave it blank.
    expect(result.current.data).toEqual(['node-2']);
    expect(result.current.status).toBe('ready');
  });

  it('builds each change on the payload on screen when it runs, not on the closure that made it', async () => {
    const { load, pending } = deferredLoader<string[]>();
    const { result } = renderHook(() => useRegionData(1, load));

    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => pending[0].resolve(['a']));
    await waitFor(() => expect(result.current.data).toEqual(['a']));

    // Two changes are made from the same render; the second runs after the first.
    const first = result.current.update;
    const second = result.current.update;
    act(() => first((current) => [...current, 'b']));
    act(() => second((current) => [...current, 'c']));
    expect(result.current.data).toEqual(['a', 'b', 'c']);
    expect(load).toHaveBeenCalledTimes(1);

    // Two changes landing in one tick each still build on the other.
    act(() => {
      first((current) => [...current, 'd']);
      second((current) => [...current, 'e']);
    });
    expect(result.current.data).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('abandons a read that started before a change, like an adopted payload', async () => {
    const { load, pending } = deferredLoader<string[]>();
    const { result } = renderHook(() => useRegionData(1, load));

    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => pending[0].resolve(['a']));
    await waitFor(() => expect(result.current.data).toEqual(['a']));

    act(() => { void result.current.refresh(); });
    await waitFor(() => expect(pending).toHaveLength(2));
    act(() => result.current.update((current) => [...current, 'b']));
    await act(async () => { pending[1].resolve(['a']); });
    expect(result.current.data).toEqual(['a', 'b']);
  });

  it('does nothing before a first payload or for another scope', async () => {
    const { load, pending } = deferredLoader<string[]>();
    const { result, rerender } = renderHook(
      ({ scope }: { scope: number }) => useRegionData(scope, load),
      { initialProps: { scope: 1 } },
    );

    await waitFor(() => expect(pending).toHaveLength(1));
    const change = vi.fn((current: string[]) => [...current, 'x']);
    act(() => result.current.update(change));
    expect(change).not.toHaveBeenCalled();
    // The first read is still the one that answers.
    act(() => pending[0].resolve(['node-1']));
    await waitFor(() => expect(result.current.data).toEqual(['node-1']));

    const updateNodeOne = result.current.update;
    rerender({ scope: 2 });
    await waitFor(() => expect(pending).toHaveLength(2));
    act(() => pending[1].resolve(['node-2']));
    await waitFor(() => expect(result.current.data).toEqual(['node-2']));

    act(() => updateNodeOne(change));
    expect(change).not.toHaveBeenCalled();
    expect(result.current.data).toEqual(['node-2']);
  });

  it('leaves the read of the scope on screen alone when another scope changes it', async () => {
    const { load, pending } = deferredLoader<string[]>();
    const { result, rerender } = renderHook(
      ({ scope }: { scope: number }) => useRegionData(scope, load),
      { initialProps: { scope: 1 } },
    );

    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => pending[0].resolve(['node-1']));
    await waitFor(() => expect(result.current.data).toEqual(['node-1']));
    const updateNodeOne = result.current.update;
    rerender({ scope: 2 });
    await waitFor(() => expect(pending).toHaveLength(2));
    act(() => pending[1].resolve(['node-2']));
    await waitFor(() => expect(result.current.data).toEqual(['node-2']));

    // Node 2 refreshes, and a node 1 change arrives while that read is in flight.
    act(() => { void result.current.refresh(); });
    await waitFor(() => expect(pending).toHaveLength(3));
    act(() => updateNodeOne((current) => [...current, 'late']));
    await act(async () => { pending[2].resolve(['node-2 fresh']); });
    expect(result.current.data).toEqual(['node-2 fresh']);
  });
});
