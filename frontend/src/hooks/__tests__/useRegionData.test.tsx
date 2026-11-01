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
});
