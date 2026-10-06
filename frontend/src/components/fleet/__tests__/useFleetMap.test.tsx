import { StrictMode, type ReactNode } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const apiFetchMock = vi.fn();
const toastError = vi.fn();

vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));
vi.mock('@/components/ui/toast-store', () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }));

import { useFleetMap, MAP_STALE_MS } from '../useFleetMap';

const MAP = { nodes: [], edges: [], flags: [], nodeErrors: [], parseErrors: [] };

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  apiFetchMock.mockReset();
  toastError.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('useFleetMap', () => {
  it('does not fetch until the Map tab is first opened', () => {
    renderHook(() => useFleetMap(false));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('loads on first open and keeps the result when the tab is left and reopened fresh', async () => {
    apiFetchMock.mockResolvedValue(okJson(MAP));
    const { result, rerender } = renderHook(({ active }) => useFleetMap(active), { initialProps: { active: true } });
    await waitFor(() => expect(result.current.data).toEqual(MAP));
    expect(result.current.loading).toBe(false);

    rerender({ active: false });
    rerender({ active: true });
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual(MAP);
  });

  it('revalidates a stale result on reopen without dropping the old data', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    apiFetchMock.mockResolvedValue(okJson(MAP));
    const { result, rerender } = renderHook(({ active }) => useFleetMap(active), { initialProps: { active: true } });
    await waitFor(() => expect(result.current.data).toEqual(MAP));

    rerender({ active: false });
    vi.setSystemTime(Date.now() + MAP_STALE_MS + 1);
    let release: (r: Response) => void = () => {};
    apiFetchMock.mockImplementationOnce(() => new Promise<Response>((res) => { release = res; }));
    rerender({ active: true });

    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(result.current.data).toEqual(MAP);
    await act(async () => { release(okJson({ ...MAP, nodeErrors: [{ nodeId: 2, nodeName: 'x', error: 'down' }] })); });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.nodeErrors).toHaveLength(1);
  });

  it('surfaces a failure, toasts once, and retries on reopen', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('boom'));
    const { result, rerender } = renderHook(({ active }) => useFleetMap(active), { initialProps: { active: true } });
    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect(toastError).toHaveBeenCalledTimes(1);

    apiFetchMock.mockResolvedValue(okJson(MAP));
    rerender({ active: false });
    rerender({ active: true });
    await waitFor(() => expect(result.current.data).toEqual(MAP));
    expect(result.current.error).toBeNull();
  });

  it('aborts the in-flight request on unmount without a toast', async () => {
    let signal: AbortSignal | undefined;
    apiFetchMock.mockImplementation((_p: string, init?: { signal?: AbortSignal }) => new Promise((_res, rej) => {
      signal = init?.signal;
      signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    }));
    const { unmount } = renderHook(() => useFleetMap(true));
    await waitFor(() => expect(signal).toBeDefined());
    unmount();
    expect(signal?.aborted).toBe(true);
    // Let the rejection travel through the hook's catch before asserting.
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(toastError).not.toHaveBeenCalled();
  });

  it('loads once under StrictMode replay and does not stay blank', async () => {
    apiFetchMock.mockResolvedValue(okJson(MAP));
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const { result } = renderHook(() => useFleetMap(true), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(MAP));
    expect(result.current.loading).toBe(false);
  });

  it('reports the server error text for a non-ok response', async () => {
    apiFetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'Failed to build fleet dependency map' }), { status: 500, headers: { 'Content-Type': 'application/json' } }));
    const { result } = renderHook(() => useFleetMap(true));
    await waitFor(() => expect(result.current.error).toBe('Failed to build fleet dependency map'));
  });

  it('falls back to the status when a non-ok response has no error body', async () => {
    apiFetchMock.mockResolvedValue(new Response('', { status: 502 }));
    const { result } = renderHook(() => useFleetMap(true));
    await waitFor(() => expect(result.current.error).toBe('Request failed (502)'));
  });

  it('keeps the previous map and flags the error when a revalidation fails', async () => {
    apiFetchMock.mockResolvedValueOnce(okJson(MAP));
    const { result } = renderHook(() => useFleetMap(true));
    await waitFor(() => expect(result.current.data).toEqual(MAP));

    apiFetchMock.mockRejectedValueOnce(new Error('network down'));
    await act(async () => { result.current.refresh(); });
    await waitFor(() => expect(result.current.error).toBe('network down'));
    expect(result.current.data).toEqual(MAP);
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it('lets only the newest of two overlapping refreshes own the loading flag', async () => {
    const resolvers: ((r: Response) => void)[] = [];
    apiFetchMock.mockImplementation((_p: string, init?: { signal?: AbortSignal }) => new Promise<Response>((res, rej) => {
      resolvers.push(res);
      init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    }));
    const { result } = renderHook(() => useFleetMap(false));
    act(() => { result.current.refresh(); });
    act(() => { result.current.refresh(); });
    // The first request was aborted; the second still owns the flag.
    await act(async () => { await Promise.resolve(); });
    expect(result.current.loading).toBe(true);
    await act(async () => { resolvers[1](okJson(MAP)); });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual(MAP);
  });
});
