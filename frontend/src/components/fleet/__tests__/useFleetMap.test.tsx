import { StrictMode, type ReactNode } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

import { useFleetMap, mergeMapPieces, MAP_STALE_MS, MAP_NODE_TIMEOUT_MS, type MapNodeRef } from '../useFleetMap';
import type { FleetDependencyMap } from '@/lib/dependency-map-layout';

const NODES: MapNodeRef[] = [{ id: 1, name: 'Local' }, { id: 2, name: 'edge' }, { id: 3, name: 'pilot' }];

function piece(nodeId: number, extra: Partial<FleetDependencyMap> = {}): FleetDependencyMap {
  return {
    nodes: [{ id: `n${nodeId}:host`, kind: 'host', label: `host${nodeId}`, nodeId, nodeName: `node${nodeId}`, stack: null, state: null, flags: [] }],
    edges: [], flags: [], nodeErrors: [], parseErrors: [], ...extra,
  } as FleetDependencyMap;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Answers `/fleet/dependency-map?nodeId=N` from a per-node handler. */
function nodeIdOf(path: string): number {
  return Number(/nodeId=(\d+)/.exec(path)?.[1]);
}

function answerBy(handlers: Record<number, () => Promise<Response> | Response>) {
  apiFetchMock.mockImplementation((path: string) => Promise.resolve(handlers[nodeIdOf(path)]()));
}

const allOk = () => answerBy({ 1: () => json(piece(1)), 2: () => json(piece(2)), 3: () => json(piece(3)) });

// A block body: returning the mock would make the runner call it as a cleanup hook.
beforeEach(() => { apiFetchMock.mockReset(); });
afterEach(() => vi.useRealTimers());

describe('mergeMapPieces', () => {
  it('concatenates slices in node order and appends request failures as node errors', () => {
    const merged = mergeMapPieces(NODES, new Map([[2, piece(2)], [1, piece(1)]]), new Map([[3, 'Timed out after 8s']]));
    expect(merged.nodes.map(n => n.nodeId)).toEqual([1, 2]);
    expect(merged.nodeErrors).toEqual([{ nodeId: 3, nodeName: 'pilot', error: 'Timed out after 8s' }]);
  });

  it('keeps a node\'s previous slice when its refresh failed, and says the slice is the last result', () => {
    const merged = mergeMapPieces(NODES, new Map([[2, piece(2)]]), new Map([[2, 'network down']]));
    expect(merged.nodes).toHaveLength(1);
    expect(merged.nodeErrors.map(e => e.error)).toEqual(['network down, showing its last result']);
  });

  it('lets a fresh request failure replace the error an older slice carried for the same node', () => {
    const old = piece(2, { nodeErrors: [{ nodeId: 2, nodeName: 'edge', error: 'no tunnel' }] });
    const merged = mergeMapPieces(NODES, new Map([[2, old]]), new Map([[2, 'network down']]));
    expect(merged.nodeErrors).toHaveLength(1);
    expect(merged.nodeErrors[0].error).toMatch(/^network down/);
  });
});

describe('useFleetMap', () => {
  it('does not fetch until the Map tab is first opened', () => {
    renderHook(() => useFleetMap(false, NODES));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('asks each node on its own and merges the answers', async () => {
    allOk();
    const { result } = renderHook(() => useFleetMap(true, NODES));
    await waitFor(() => expect(result.current.data?.nodes).toHaveLength(3));
    expect(apiFetchMock.mock.calls.map(c => c[0]).sort()).toEqual([
      '/fleet/dependency-map?nodeId=1', '/fleet/dependency-map?nodeId=2', '/fleet/dependency-map?nodeId=3',
    ]);
    expect(apiFetchMock.mock.calls.every(c => (c[1] as { localOnly: boolean }).localOnly)).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.progress).toBeNull();
  });

  it('draws the nodes that answered while a slow one is still pending, with progress', async () => {
    let releaseSlow: (r: Response) => void = () => {};
    answerBy({
      1: () => json(piece(1)),
      2: () => new Promise<Response>((res) => { releaseSlow = res; }),
      3: () => json(piece(3)),
    });
    const { result } = renderHook(() => useFleetMap(true, NODES));
    await waitFor(() => expect(result.current.data?.nodes.map(n => n.nodeId)).toEqual([1, 3]));
    expect(result.current.loading).toBe(true);
    expect(result.current.progress).toEqual({ done: 2, total: 3 });

    await act(async () => { releaseSlow(json(piece(2))); });
    await waitFor(() => expect(result.current.data?.nodes.map(n => n.nodeId)).toEqual([1, 2, 3]));
    expect(result.current.loading).toBe(false);
  });

  it('never has more than four requests in flight', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: i + 1, name: `n${i + 1}` }));
    let inFlight = 0;
    let peak = 0;
    apiFetchMock.mockImplementation(async (path: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight -= 1;
      return json(piece(nodeIdOf(path)));
    });
    const { result } = renderHook(() => useFleetMap(true, many));
    await waitFor(() => expect(result.current.data?.nodes).toHaveLength(9));
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it('reports a node whose request failed as that node\'s error and still draws the rest', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    answerBy({
      1: () => json(piece(1)),
      2: () => json({ error: 'Failed to build fleet dependency map' }, 500),
      3: () => { throw new Error('network down'); },
    });
    const { result } = renderHook(() => useFleetMap(true, NODES));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.nodes.map(n => n.nodeId)).toEqual([1]);
    expect(result.current.data?.nodeErrors.map(e => [e.nodeId, e.error])).toEqual([
      [2, 'Failed to build fleet dependency map'],
      [3, 'network down'],
    ]);
    spy.mockRestore();
  });

  it('retries only the failed nodes', async () => {
    let attempts = 0;
    answerBy({
      1: () => json(piece(1)),
      2: () => (attempts++ === 0 ? json({ error: 'down' }, 502) : json(piece(2))),
      3: () => json(piece(3)),
    });
    const { result } = renderHook(() => useFleetMap(true, NODES));
    await waitFor(() => expect(result.current.data?.nodeErrors).toHaveLength(1));
    apiFetchMock.mockClear();
    await act(async () => { result.current.retryFailed(); });
    await waitFor(() => expect(result.current.data?.nodeErrors).toHaveLength(0));
    expect(apiFetchMock.mock.calls.map(c => c[0])).toEqual(['/fleet/dependency-map?nodeId=2']);
    expect(result.current.data?.nodes.map(n => n.nodeId)).toEqual([1, 2, 3]);
  });

  it('treats a node that reports its own error as retryable', async () => {
    const reported = piece(2, { nodes: [], nodeErrors: [{ nodeId: 2, nodeName: 'edge', error: 'no tunnel' }] });
    answerBy({ 1: () => json(piece(1)), 2: () => json(reported), 3: () => json(piece(3)) });
    const { result } = renderHook(() => useFleetMap(true, NODES));
    await waitFor(() => expect(result.current.data?.nodeErrors).toHaveLength(1));
    apiFetchMock.mockClear();
    await act(async () => { result.current.retryFailed(); });
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the drawn map while a refresh runs, replacing each node as its new answer lands', async () => {
    allOk();
    const { result } = renderHook(() => useFleetMap(true, NODES));
    await waitFor(() => expect(result.current.data?.nodes).toHaveLength(3));

    let releaseTwo: (r: Response) => void = () => {};
    answerBy({
      1: () => json(piece(1)),
      2: () => new Promise<Response>((res) => { releaseTwo = res; }),
      3: () => json(piece(3)),
    });
    await act(async () => { result.current.refresh(); });
    await waitFor(() => expect(result.current.progress).toEqual({ done: 2, total: 3 }));
    // Node 2's old slice is still drawn while its new answer is pending.
    expect(result.current.data?.nodes.map(n => n.nodeId)).toEqual([1, 2, 3]);
    await act(async () => { releaseTwo(json(piece(2, { flags: [] }))); });
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it('reuses a fresh map when the tab is reopened and reloads a stale one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    allOk();
    const { result, rerender } = renderHook(({ active }) => useFleetMap(active, NODES), { initialProps: { active: true } });
    await waitFor(() => expect(result.current.data?.nodes).toHaveLength(3));
    expect(apiFetchMock).toHaveBeenCalledTimes(3);

    rerender({ active: false });
    rerender({ active: true });
    expect(apiFetchMock).toHaveBeenCalledTimes(3);

    rerender({ active: false });
    vi.setSystemTime(Date.now() + MAP_STALE_MS + 1);
    rerender({ active: true });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(6));
  });

  it('reloads when the set of nodes changed since the last load', async () => {
    allOk();
    const { result, rerender } = renderHook(({ nodes }) => useFleetMap(true, nodes), { initialProps: { nodes: NODES.slice(0, 2) } });
    await waitFor(() => expect(result.current.data?.nodes).toHaveLength(2));
    rerender({ nodes: NODES });
    await waitFor(() => expect(result.current.data?.nodes).toHaveLength(3));
  });

  it('loads under StrictMode replay and does not stay blank', async () => {
    allOk();
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const { result } = renderHook(() => useFleetMap(true, NODES), { wrapper });
    await waitFor(() => expect(result.current.data?.nodes).toHaveLength(3));
    expect(result.current.loading).toBe(false);
  });

  it('aborts every in-flight request on unmount without reporting an error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const signals: AbortSignal[] = [];
    apiFetchMock.mockImplementation((_p: string, init?: { signal?: AbortSignal }) => new Promise((_res, rej) => {
      if (init?.signal) {
        signals.push(init.signal);
        init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
      }
    }));
    const { unmount } = renderHook(() => useFleetMap(true, NODES));
    await waitFor(() => expect(signals).toHaveLength(3));
    unmount();
    expect(signals.every(sig => sig.aborted)).toBe(true);
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('says a node that answers with something that is not a map failed, instead of drawing nothing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    answerBy({ 1: () => json(piece(1)), 2: () => json(null), 3: () => json({ nodes: 'x' }) });
    const { result } = renderHook(() => useFleetMap(true, NODES));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.nodes.map(n => n.nodeId)).toEqual([1]);
    expect(result.current.data?.nodeErrors.map(e => e.error)).toEqual(['Unexpected response from the hub', 'Unexpected response from the hub']);
    spy.mockRestore();
  });

  it('reports an unreadable body as an invalid response, not a parser message', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    answerBy({ 1: () => new Response('<html>', { status: 200 }), 2: () => json(piece(2)), 3: () => json(piece(3)) });
    const { result } = renderHook(() => useFleetMap(true, NODES));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.nodeErrors.map(e => e.error)).toEqual(['Invalid response from the hub']);
    spy.mockRestore();
  });

  it('gives up on a node that never answers, so Refresh and Retry are never locked behind it', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // AbortSignal.timeout is native and ignores fake timers, so stand in a signal we fire ourselves.
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout.signal);
    apiFetchMock.mockImplementation((path: string, init?: { signal?: AbortSignal }) => {
      if (nodeIdOf(path) !== 2) return Promise.resolve(json(piece(nodeIdOf(path))));
      return new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(init.signal?.reason));
      });
    });
    const { result } = renderHook(() => useFleetMap(true, NODES));
    await waitFor(() => expect(result.current.progress).toEqual({ done: 2, total: 3 }));
    expect(timeoutSpy).toHaveBeenCalledWith(MAP_NODE_TIMEOUT_MS);
    await act(async () => { timeout.abort(new DOMException('timed out', 'TimeoutError')); });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.nodeErrors.map(e => [e.nodeId, e.error])).toEqual([[2, 'Timed out reading this node']]);
    timeoutSpy.mockRestore();
    spy.mockRestore();
  });

  it('lets an in-flight first load finish when the tab is flipped away and back', async () => {
    const releases: ((r: Response) => void)[] = [];
    apiFetchMock.mockImplementation(() => new Promise<Response>((res) => { releases.push(res); }));
    const { result, rerender } = renderHook(({ active }) => useFleetMap(active, NODES), { initialProps: { active: true } });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(3));
    rerender({ active: false });
    rerender({ active: true });
    expect(apiFetchMock).toHaveBeenCalledTimes(3);
    await act(async () => { releases.forEach((r, i) => r(json(piece(i + 1)))); });
    await waitFor(() => expect(result.current.data?.nodes).toHaveLength(3));
  });

  it('does not start a second request for a node already being retried', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let attempt = 0;
    const releases: ((r: Response) => void)[] = [];
    apiFetchMock.mockImplementation((path: string) => {
      const id = nodeIdOf(path);
      if (id === 2 && attempt++ === 0) return Promise.resolve(json({ error: 'down' }, 502));
      if (id === 2) return new Promise<Response>((res) => { releases.push(res); });
      return Promise.resolve(json(piece(id)));
    });
    const { result, rerender } = renderHook(({ active }) => useFleetMap(active, NODES), { initialProps: { active: true } });
    await waitFor(() => expect(result.current.data?.nodeErrors).toHaveLength(1));
    rerender({ active: false });
    rerender({ active: true });
    await waitFor(() => expect(result.current.loading).toBe(true));
    rerender({ active: false });
    rerender({ active: true });
    await act(async () => { result.current.retryFailed(); });
    expect(releases).toHaveLength(1);
    await act(async () => { releases[0](json(piece(2))); });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.nodeErrors).toHaveLength(0);
    spy.mockRestore();
  });

  it('waits for the node registry instead of recording an empty load as finished', async () => {
    allOk();
    const { result, rerender } = renderHook(({ nodes }) => useFleetMap(true, nodes), { initialProps: { nodes: [] as MapNodeRef[] } });
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(result.current.data).toBeNull();
    rerender({ nodes: NODES });
    await waitFor(() => expect(result.current.data?.nodes).toHaveLength(3));
  });
});
