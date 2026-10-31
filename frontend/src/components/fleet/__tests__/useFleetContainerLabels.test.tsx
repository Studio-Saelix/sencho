import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

import { useFleetContainerLabels, mergeLabelPieces, type LabelsNodeRef } from '../useFleetContainerLabels';
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
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
