import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const fetchForNodeMock = vi.fn();

vi.mock('@/lib/api', () => ({
  fetchForNode: (...args: unknown[]) => fetchForNodeMock(...args),
}));

import { useFleetLabels, labelPaletteKey } from '../useFleetLabels';
import type { FleetNode } from '../../types';

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function node(id: number, status: FleetNode['status'] = 'online'): FleetNode {
  return {
    id, name: `node-${id}`, type: id === 1 ? 'local' : 'remote', status,
    stats: null, systemStats: null, stacks: ['web'],
    cordoned: false, cordoned_at: null, cordoned_reason: null,
  };
}

// Route the mock by the requested path so a node returns both its labels and
// its assignments.
function routeByPath(labels: unknown, assignments: unknown) {
  return (path: string) => {
    if (path === '/labels') return Promise.resolve(okJson(labels));
    if (path === '/labels/assignments') return Promise.resolve(okJson(assignments));
    return Promise.resolve(new Response('{}', { status: 404 }));
  };
}

beforeEach(() => {
  fetchForNodeMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useFleetLabels (stack labels are a Community feature)', () => {
  it('fetches labels for online nodes without any tier gate', async () => {
    fetchForNodeMock.mockImplementation(
      routeByPath(
        [{ id: 1, name: 'prod', color: 'rose' }],
        { web: [{ id: 1, name: 'prod', color: 'rose' }] },
      ),
    );

    const { result } = renderHook(() => useFleetLabels({ nodes: [node(2)] }));

    await waitFor(() => expect(result.current.fleetPalette.length).toBe(1));
    expect(result.current.fleetPalette[0]).toMatchObject({ name: 'prod', color: 'rose' });
    expect(result.current.fleetStackLabelMap[2]).toEqual({ web: [{ id: 1, name: 'prod', color: 'rose' }] });
    // Both endpoints hit for the one online node.
    const paths = fetchForNodeMock.mock.calls.map(c => c[0]);
    expect(paths).toContain('/labels');
    expect(paths).toContain('/labels/assignments');
  });

  it('skips offline nodes but still aggregates online ones', async () => {
    fetchForNodeMock.mockImplementation(
      routeByPath([{ id: 1, name: 'edge', color: 'blue' }], { web: [{ id: 1, name: 'edge', color: 'blue' }] }),
    );

    const { result } = renderHook(() =>
      useFleetLabels({ nodes: [node(2, 'offline'), node(3, 'online')] }),
    );

    await waitFor(() => expect(result.current.fleetPalette.length).toBe(1));
    // Only node 3 (online) was queried.
    const queriedNodeIds = new Set(fetchForNodeMock.mock.calls.map(c => c[1]));
    expect(queriedNodeIds.has(3)).toBe(true);
    expect(queriedNodeIds.has(2)).toBe(false);
    expect(result.current.fleetStackLabelMap[2]).toBeUndefined();
  });

  it('dedupes the palette across nodes that share a label name+color', async () => {
    fetchForNodeMock.mockImplementation(
      routeByPath([{ id: 9, name: 'prod', color: 'rose' }], { web: [{ id: 9, name: 'prod', color: 'rose' }] }),
    );

    const { result } = renderHook(() => useFleetLabels({ nodes: [node(2), node(3)] }));

    await waitFor(() => expect(Object.keys(result.current.fleetStackLabelMap).length).toBe(2));
    // Same name+color from two nodes collapses to a single palette entry.
    expect(result.current.fleetPalette).toHaveLength(1);
    expect(result.current.fleetPalette[0].key).toBe(labelPaletteKey('prod', 'rose'));
  });

  it('does not fetch when there are no nodes', () => {
    renderHook(() => useFleetLabels({ nodes: [] }));
    expect(fetchForNodeMock).not.toHaveBeenCalled();
  });

  it('tolerates an unreachable node without losing the others', async () => {
    fetchForNodeMock.mockImplementation((path: string, nodeId: number) => {
      if (nodeId === 2) return Promise.reject(new Error('timeout'));
      if (path === '/labels') return Promise.resolve(okJson([{ id: 1, name: 'ok', color: 'green' }]));
      return Promise.resolve(okJson({ web: [{ id: 1, name: 'ok', color: 'green' }] }));
    });

    const { result } = renderHook(() => useFleetLabels({ nodes: [node(2), node(3)] }));

    await waitFor(() => expect(result.current.fleetPalette.length).toBe(1));
    expect(result.current.fleetStackLabelMap[3]).toBeDefined();
    expect(result.current.fleetStackLabelMap[2]).toBeUndefined();
  });
});
