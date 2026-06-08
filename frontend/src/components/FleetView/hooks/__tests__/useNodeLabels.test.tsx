import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const apiFetchMock = vi.fn();

vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { useNodeLabels } from '../useNodeLabels';
import type { FleetNode } from '../../types';

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function node(id: number): FleetNode {
  return {
    id, name: `node-${id}`, type: 'remote', status: 'online',
    stats: null, systemStats: null, stacks: null,
    cordoned: false, cordoned_at: null, cordoned_reason: null,
  };
}

beforeEach(() => apiFetchMock.mockReset());
afterEach(() => vi.clearAllMocks());

describe('useNodeLabels (Community node-tag aggregation)', () => {
  it('fetches and normalizes string keys to numbers on every tier', async () => {
    apiFetchMock.mockResolvedValue(okJson({ '2': ['prod', 'edge'], '3': ['db'] }));

    const { result } = renderHook(() => useNodeLabels({ nodes: [node(2), node(3)] }));

    await waitFor(() => expect(Object.keys(result.current.labelsByNodeId).length).toBe(2));
    expect(result.current.labelsByNodeId[2]).toEqual(['prod', 'edge']);
    expect(result.current.labelsByNodeId[3]).toEqual(['db']);
    // distinctLabels is the sorted union.
    expect(result.current.distinctLabels).toEqual(['db', 'edge', 'prod']);
    expect(apiFetchMock).toHaveBeenCalledWith('/node-labels', expect.objectContaining({ localOnly: true }));
  });

  it('clears the map on a non-ok response', async () => {
    apiFetchMock.mockResolvedValue(new Response('nope', { status: 403 }));
    const { result } = renderHook(() => useNodeLabels({ nodes: [node(2)] }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(result.current.labelsByNodeId).toEqual({});
  });
});
