import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const apiFetchMock = vi.fn();

vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const useNodesMock = vi.fn();
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => useNodesMock(),
}));

vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/utils')>('@/lib/utils');
  return {
    ...actual,
    visibilityInterval: () => () => {},
  };
});

import { useFleetHeartbeat } from '../useFleetHeartbeat';

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const FLEET_PAYLOAD = [
  { id: 1, name: 'Local', type: 'local', status: 'online', stats: { active: 3, managed: 3, unmanaged: 0, exited: 0, total: 3 } },
  { id: 2, name: 'Edge', type: 'remote', status: 'online', stats: { active: 1, managed: 1, unmanaged: 0, exited: 0, total: 1 } },
];

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(() => Promise.resolve(okJson(FLEET_PAYLOAD)));
  useNodesMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useFleetHeartbeat node-switch behavior', () => {
  it('does not reset state when the active local node changes', async () => {
    useNodesMock.mockReturnValue({
      activeNode: { id: 1, name: 'Local', type: 'local' },
      nodes: [{ id: 1, name: 'Local', type: 'local' }, { id: 2, name: 'Edge', type: 'remote' }],
    });
    const { result, rerender } = renderHook(() => useFleetHeartbeat());

    // Wait for the mount-time fetch to land.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.loading).toBe(false);
    expect(result.current.nodes).toHaveLength(2);
    const fetchCountAfterMount = apiFetchMock.mock.calls.length;

    // Switch the active node. Fleet data is fleet-wide so the card should
    // keep its current rows and not flicker back to a skeleton state.
    useNodesMock.mockReturnValue({
      activeNode: { id: 2, name: 'Edge', type: 'remote' },
      nodes: [{ id: 1, name: 'Local', type: 'local' }, { id: 2, name: 'Edge', type: 'remote' }],
    });
    rerender();
    await act(async () => { await Promise.resolve(); });

    expect(result.current.loading).toBe(false);
    expect(result.current.nodes).toHaveLength(2);
    // No new fetch should fire on the node switch; the data is fleet-wide.
    expect(apiFetchMock.mock.calls.length).toBe(fetchCountAfterMount);
  });
});
