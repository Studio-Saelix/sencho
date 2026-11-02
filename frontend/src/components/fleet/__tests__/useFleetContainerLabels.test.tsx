import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

import { useFleetContainerLabels, mergeLabelPieces, LABELS_NODE_TIMEOUT_MS, type LabelsNodeRef } from '../useFleetContainerLabels';
import type { FleetLabelInventoryResponse, LabelIndexRow } from '@/lib/labelInventory';

const NODES: LabelsNodeRef[] = [{ id: 1, name: 'Local' }, { id: 2, name: 'edge' }, { id: 3, name: 'pilot' }];

function labelRow(key: string, containerId: string, nodeId: number): LabelIndexRow {
  return {
    key,
    value: 'true',
    source: 'runtime',
    containers: [{ id: containerId, name: containerId, stack: 'demo', service: 'web', nodeId, nodeName: `node${nodeId}` }],
  };
}

function piece(nodeId: number, rows: LabelIndexRow[] = []): FleetLabelInventoryResponse {
  return {
    nodes: [{
      nodeId,
      nodeName: `node${nodeId}`,
      status: 'ok',
      inventory: { nodeId, partial: false, generatedAt: 1, containers: [], byLabel: rows },
      error: null,
    }],
    aggregatedByLabel: rows,
    nodeErrors: {},
    generatedAt: 1,
  };
}

/** The hub's real shape for a remote it could not read: 200, per-node error, no inventory. */
function hubNodeError(nodeId: number, reason = 'Timed out after 5s'): FleetLabelInventoryResponse {
  return {
    nodes: [{ nodeId, nodeName: `node${nodeId}`, status: 'error', inventory: null, error: reason }],
    aggregatedByLabel: [],
    nodeErrors: { [nodeId]: reason },
    generatedAt: 1,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** What the hub answers when it cut its own read at the deadline and kept the build. */
function keptBuildCut(nodeId: number): Response {
  const res = json(hubNodeError(nodeId, 'Timed out after 25s'));
  res.headers.set('X-Sencho-Build-Kept', '1');
  return res;
}

function nodeIdOf(path: string): number {
  return Number(/nodeId=(\d+)/.exec(path)?.[1]);
}

function answerBy(handlers: Record<number, () => Promise<Response> | Response>) {
  apiFetchMock.mockImplementation((path: string) => Promise.resolve(handlers[nodeIdOf(path)]()));
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe('labels node timeout', () => {
  it('stays above the hub\'s 25 s local read deadline so the server answers first', () => {
    expect(LABELS_NODE_TIMEOUT_MS).toBeGreaterThan(25_000);
  });
});

describe('mergeLabelPieces', () => {
  it('concatenates node slices in node order and folds one label across nodes into one row', () => {
    const merged = mergeLabelPieces(
      NODES,
      new Map([
        [2, piece(2, [labelRow('traefik.enable', 'web-2', 2)])],
        [1, piece(1, [labelRow('traefik.enable', 'web-1', 1)])],
      ]),
      new Map(),
    );
    expect(merged.nodes.map(n => n.nodeId)).toEqual([1, 2]);
    expect(merged.aggregatedByLabel).toHaveLength(1);
    expect(merged.aggregatedByLabel[0].containers.map(c => c.id).sort()).toEqual(['web-1', 'web-2']);
  });

  it('keeps a node\'s previous inventory when its refresh failed, and names it as the last result', () => {
    const merged = mergeLabelPieces(NODES, new Map([[2, piece(2)]]), new Map([[2, 'network down']]));
    expect(merged.nodes.map(n => n.nodeId)).toEqual([2]);
    expect(merged.nodeErrors[2]).toBe('network down, showing its last result');
  });

  it('does not claim a last result when the kept slice carried no inventory', () => {
    const errorOnly: FleetLabelInventoryResponse = {
      nodes: [{ nodeId: 2, nodeName: 'node2', status: 'error', inventory: null, error: 'no inventory' }],
      aggregatedByLabel: [],
      nodeErrors: { 2: 'no inventory' },
      generatedAt: 1,
    };
    const merged = mergeLabelPieces(NODES, new Map([[2, errorOnly]]), new Map([[2, 'network down']]));
    expect(merged.nodeErrors[2]).toBe('network down');
    expect(merged.nodes.filter(n => n.nodeId === 2)).toHaveLength(2);
  });

  it('lists a node that never answered as an error row instead of dropping it', () => {
    const merged = mergeLabelPieces(NODES, new Map([[1, piece(1)]]), new Map([[3, 'Timed out after 20s']]));
    expect(merged.nodes.find(n => n.nodeId === 3)).toMatchObject({ status: 'error', inventory: null, error: 'Timed out after 20s' });
    expect(merged.nodeErrors[3]).toBe('Timed out after 20s');
  });
});

describe('useFleetContainerLabels', () => {
  it('asks each node on its own and merges every answer', async () => {
    answerBy({ 1: () => json(piece(1)), 2: () => json(piece(2)), 3: () => json(piece(3)) });
    const { result } = renderHook(() => useFleetContainerLabels(NODES, false));

    await waitFor(() => expect(result.current.data?.nodes).toHaveLength(3));
    expect(apiFetchMock.mock.calls.map(c => c[0]).sort()).toEqual([
      '/fleet/container-labels?nodeId=1',
      '/fleet/container-labels?nodeId=2',
      '/fleet/container-labels?nodeId=3',
    ]);
    expect(apiFetchMock.mock.calls.every(c => (c[1] as { localOnly: boolean }).localOnly)).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.progress).toBeNull();
  });

  it('draws the nodes that answered while a slow one is still pending', async () => {
    let releaseSlow: (r: Response) => void = () => {};
    answerBy({
      1: () => json(piece(1)),
      2: () => new Promise<Response>((resolve) => { releaseSlow = resolve; }),
      3: () => json(piece(3)),
    });
    const { result } = renderHook(() => useFleetContainerLabels(NODES, false));

    await waitFor(() => expect(result.current.data?.nodes).toHaveLength(2));
    expect(result.current.loading).toBe(true);
    expect(result.current.progress).toEqual({ done: 2, total: 3 });

    releaseSlow(json(piece(2)));
    await waitFor(() => expect(result.current.data?.nodes).toHaveLength(3));
    expect(result.current.loading).toBe(false);
  });

  it('reports an unreachable node while the healthy ones keep their data', async () => {
    answerBy({
      1: () => json(piece(1)),
      2: () => Promise.reject(new Error('Failed to fetch')),
      3: () => json(piece(3)),
    });
    const { result } = renderHook(() => useFleetContainerLabels(NODES, false));

    await waitFor(() => expect(result.current.data?.nodeErrors[2]).toBe('Failed to fetch'));
    expect(result.current.data?.nodes.map(n => n.nodeId).sort()).toEqual([1, 2, 3]);
    expect(result.current.data?.nodes.find(n => n.nodeId === 2)?.status).toBe('error');
  });

  it('keeps a node\'s last inventory when a refresh fails, and retries only that node', async () => {
    let failNodeTwo = false;
    apiFetchMock.mockImplementation(async (path: string) => {
      const nodeId = nodeIdOf(path);
      if (nodeId === 2 && failNodeTwo) throw new Error('network down');
      return json(piece(nodeId));
    });
    const { result } = renderHook(() => useFleetContainerLabels(NODES, false));
    await waitFor(() => expect(result.current.data?.nodes).toHaveLength(3));

    failNodeTwo = true;
    act(() => { result.current.refresh(); });
    await waitFor(() => expect(result.current.data?.nodeErrors[2]).toBe('network down, showing its last result'));
    // The rows from its last answer stay on screen.
    expect(result.current.data?.nodes.find(n => n.nodeId === 2)?.status).toBe('ok');

    failNodeTwo = false;
    apiFetchMock.mockClear();
    act(() => { result.current.retryFailed(); });
    await waitFor(() => expect(result.current.data?.nodeErrors[2]).toBeUndefined());
    expect(apiFetchMock.mock.calls.map(c => nodeIdOf(String(c[0])))).toEqual([2]);
  });

  describe('a hub read cut at its deadline with the build kept', () => {
    it('asks once more, takes the answer, and never shows the cut', async () => {
      const asked: number[] = [];
      apiFetchMock.mockImplementation(async (path: string) => {
        const nodeId = nodeIdOf(path);
        asked.push(nodeId);
        if (nodeId === 1 && asked.filter(id => id === 1).length === 1) return keptBuildCut(1);
        return json(piece(nodeId, [labelRow('traefik.enable', `web-${nodeId}`, nodeId)]));
      });
      const { result } = renderHook(() => useFleetContainerLabels(NODES, false));

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(asked.filter(id => id === 1)).toHaveLength(2);
      expect(result.current.data?.nodeErrors).toEqual({});
      expect(result.current.data?.nodes.map(n => n.nodeId).sort()).toEqual([1, 2, 3]);
    });

    it('keeps the node pending between the two asks, so the tab never flashes the failure', async () => {
      let releaseRetry: (r: Response) => void = () => {};
      let asks = 0;
      apiFetchMock.mockImplementation((path: string) => {
        const nodeId = nodeIdOf(path);
        if (nodeId !== 1) return Promise.resolve(json(piece(nodeId)));
        asks += 1;
        return asks === 1 ? Promise.resolve(keptBuildCut(1)) : new Promise<Response>((res) => { releaseRetry = res; });
      });
      const { result } = renderHook(() => useFleetContainerLabels(NODES, false));

      await waitFor(() => expect(asks).toBe(2));
      expect(result.current.loading).toBe(true);
      expect(result.current.data?.nodeErrors[1]).toBeUndefined();
      await act(async () => { releaseRetry(json(piece(1))); });
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.data?.nodeErrors).toEqual({});
    });

    it('asks only once more when the build is still not ready, then reports the cut', async () => {
      apiFetchMock.mockImplementation(async (path: string) => {
        const nodeId = nodeIdOf(path);
        return nodeId === 1 ? keptBuildCut(1) : json(piece(nodeId));
      });
      const { result } = renderHook(() => useFleetContainerLabels(NODES, false));

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(apiFetchMock.mock.calls.filter(c => nodeIdOf(String(c[0])) === 1)).toHaveLength(2);
      expect(result.current.data?.nodeErrors[1]).toBe('Timed out after 25s');
    });

    it('does not ask again for a node the hub cut without keeping a build', async () => {
      answerBy({ 1: () => json(piece(1)), 2: () => json(hubNodeError(2, 'Timed out after 5s')), 3: () => json(piece(3)) });
      const { result } = renderHook(() => useFleetContainerLabels(NODES, false));

      await waitFor(() => expect(result.current.data?.nodeErrors[2]).toBe('Timed out after 5s'));
      expect(apiFetchMock.mock.calls.filter(c => nodeIdOf(String(c[0])) === 2)).toHaveLength(1);
    });

    it('asks again with the same reveal mode', async () => {
      let asks = 0;
      apiFetchMock.mockImplementation(async (path: string) => {
        const nodeId = nodeIdOf(path);
        if (nodeId === 1 && ++asks === 1) return keptBuildCut(1);
        return json(piece(nodeId));
      });
      renderHook(() => useFleetContainerLabels([NODES[0]], true));

      await waitFor(() => expect(asks).toBe(2));
      expect(apiFetchMock.mock.calls.map(c => c[0])).toEqual([
        '/fleet/container-labels?nodeId=1&reveal=1',
        '/fleet/container-labels?nodeId=1&reveal=1',
      ]);
    });

    it('stops asking when the tab unmounts between the two asks', async () => {
      let asks = 0;
      apiFetchMock.mockImplementation((_path: string, init: { signal: AbortSignal }) => {
        asks += 1;
        if (asks === 1) return Promise.resolve(keptBuildCut(1));
        return new Promise<Response>((_res, rej) => {
          init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
        });
      });
      const { unmount } = renderHook(() => useFleetContainerLabels([NODES[0]], false));
      await waitFor(() => expect(asks).toBe(2));
      unmount();
      await Promise.resolve();
      expect(asks).toBe(2);
    });
  });

  it('keeps a node\'s last inventory when the hub reports that node unreachable', async () => {
    let answerNodeTwo = () => json(piece(2, [labelRow('traefik.enable', 'web-2', 2)]));
    apiFetchMock.mockImplementation(async (path: string) => {
      const nodeId = nodeIdOf(path);
      return nodeId === 2 ? answerNodeTwo() : json(piece(nodeId));
    });
    const { result } = renderHook(() => useFleetContainerLabels(NODES, false));
    await waitFor(() => expect(result.current.data?.aggregatedByLabel).toHaveLength(1));

    // The common unreachable-remote path: HTTP 200 with a per-node error body.
    answerNodeTwo = () => json(hubNodeError(2));
    act(() => { result.current.refresh(); });
    await waitFor(() => expect(result.current.data?.nodeErrors[2]).toBe('Timed out after 5s, showing its last result'));
    // Its rows stay on screen, and the node is not reported as a fresh empty slice.
    expect(result.current.data?.nodes.find(n => n.nodeId === 2)?.status).toBe('ok');
    expect(result.current.data?.nodes.filter(n => n.nodeId === 2)).toHaveLength(1);
    expect(result.current.data?.aggregatedByLabel[0].containers.map(c => c.id)).toEqual(['web-2']);

    answerNodeTwo = () => json(piece(2, [labelRow('traefik.enable', 'web-2', 2)]));
    apiFetchMock.mockClear();
    act(() => { result.current.retryFailed(); });
    await waitFor(() => expect(result.current.data?.nodeErrors[2]).toBeUndefined());
    expect(result.current.data?.nodes.find(n => n.nodeId === 2)?.status).toBe('ok');
    expect(result.current.data?.aggregatedByLabel[0].containers.map(c => c.id)).toEqual(['web-2']);
    expect(apiFetchMock.mock.calls.map(c => nodeIdOf(String(c[0])))).toEqual([2]);
  });

  it.each([
    ['no node row at all', { nodes: [], aggregatedByLabel: [], nodeErrors: {}, generatedAt: 1 }, 'Unexpected response from the hub'],
    ['a row for a different node', piece(3), 'Unexpected response from the hub'],
    ['more than one node row', {
      nodes: [...piece(2).nodes, ...piece(3).nodes],
      aggregatedByLabel: [],
      nodeErrors: {},
      generatedAt: 1,
    }, 'Unexpected response from the hub'],
    ['an ok row with no inventory', {
      nodes: [{ nodeId: 2, nodeName: 'node2', status: 'ok', inventory: null, error: null }],
      aggregatedByLabel: [],
      nodeErrors: {},
      generatedAt: 1,
    }, 'Unexpected response from the hub'],
    ['an error row with no reason', {
      nodes: [{ nodeId: 2, nodeName: 'node2', status: 'error', inventory: null, error: null }],
      aggregatedByLabel: [],
      nodeErrors: {},
      generatedAt: 1,
    }, 'The hub could not read this node'],
    ['an error row whose reason is not text', {
      nodes: [{ nodeId: 2, nodeName: 'node2', status: 'error', inventory: null, error: { code: 'ETIMEDOUT' } }],
      aggregatedByLabel: [],
      nodeErrors: {},
      generatedAt: 1,
    }, 'Unexpected response from the hub'],
    ['a nodeErrors reason that is not text', {
      nodes: [{ nodeId: 2, nodeName: 'node2', status: 'error', inventory: null, error: 'Timed out after 5s' }],
      aggregatedByLabel: [],
      nodeErrors: { 2: { code: 'ETIMEDOUT' } },
      generatedAt: 1,
    }, 'Unexpected response from the hub'],
  ] as Array<[string, unknown, string]>)('keeps the last inventory when a refresh returns %s', async (_label, badBody, expected) => {
    let returnBadBody = false;
    apiFetchMock.mockImplementation(async (path: string) => {
      const nodeId = nodeIdOf(path);
      if (nodeId === 2) {
        return returnBadBody ? json(badBody) : json(piece(2, [labelRow('traefik.enable', 'web-2', 2)]));
      }
      return json(piece(nodeId));
    });
    const { result } = renderHook(() => useFleetContainerLabels(NODES, false));
    await waitFor(() => expect(result.current.data?.aggregatedByLabel).toHaveLength(1));

    returnBadBody = true;
    act(() => { result.current.refresh(); });
    await waitFor(() => expect(result.current.data?.nodeErrors[2]).toBe(`${expected}, showing its last result`));
    expect(result.current.data?.nodes.find(n => n.nodeId === 2)?.status).toBe('ok');
    expect(result.current.data?.nodes.filter(n => n.nodeId === 2)).toHaveLength(1);
    expect(result.current.data?.aggregatedByLabel[0].containers.map(c => c.id)).toEqual(['web-2']);
  });

  it('lists a node the hub reports unreachable before it ever answered, without claiming a last result', async () => {
    answerBy({ 1: () => json(piece(1)), 2: () => json(hubNodeError(2)), 3: () => json(piece(3)) });
    const { result } = renderHook(() => useFleetContainerLabels(NODES, false));

    await waitFor(() => expect(result.current.data?.nodeErrors[2]).toBe('Timed out after 5s'));
    expect(result.current.data?.nodes.find(n => n.nodeId === 2)).toMatchObject({ status: 'error', inventory: null });
    expect(result.current.data?.nodes.filter(n => n.nodeId === 2)).toHaveLength(1);

    apiFetchMock.mockClear();
    act(() => { result.current.retryFailed(); });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(apiFetchMock.mock.calls.map(c => nodeIdOf(String(c[0])))).toEqual([2]);
  });

  it('reports a body the tab cannot trust as that node\'s failure', async () => {
    answerBy({ 1: () => json({ nodes: [{ nodeId: 1 }], aggregatedByLabel: [], nodeErrors: {}, generatedAt: 1 }) });
    const { result } = renderHook(() => useFleetContainerLabels([{ id: 1, name: 'Local' }], false));
    await waitFor(() => expect(result.current.data?.nodeErrors[1]).toBe('Unexpected response from the hub'));
    expect(result.current.data?.nodes.find(n => n.nodeId === 1)?.status).toBe('error');
  });

  it('aborts in-flight node reads when the tab unmounts', async () => {
    let signal: AbortSignal | undefined;
    apiFetchMock.mockImplementation((_path: string, init: { signal?: AbortSignal }) => {
      signal = init.signal;
      return new Promise<Response>(() => {});
    });
    const { unmount } = renderHook(() => useFleetContainerLabels([{ id: 1, name: 'Local' }], false));
    await waitFor(() => expect(signal).toBeDefined());
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('asks for unredacted values once reveal is on', async () => {
    answerBy({ 1: () => json(piece(1)) });
    renderHook(() => useFleetContainerLabels([{ id: 1, name: 'Local' }], true));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith(
      '/fleet/container-labels?nodeId=1&reveal=1',
      expect.objectContaining({ localOnly: true }),
    ));
  });
});
