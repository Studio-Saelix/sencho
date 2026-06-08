import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const apiFetchMock = vi.fn();
const fetchForNodeMock = vi.fn();

vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  fetchForNode: (...args: unknown[]) => fetchForNodeMock(...args),
}));

import { useFleetOverview } from '../useFleetOverview';
import type { FleetNode, FleetPreferences } from '../../types';

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function sys(cpu: string, mem = '40.0', disk = '30.0') {
  return {
    cpu: { usage: cpu, cores: 4 },
    memory: { total: 100, used: 40, free: 60, usagePercent: mem },
    disk: { total: 100, used: 30, free: 70, usagePercent: disk },
  };
}

const NODES: FleetNode[] = [
  { id: 1, name: 'Alpha', type: 'local', status: 'online', stats: { active: 2, managed: 2, unmanaged: 0, exited: 0, total: 2 }, systemStats: sys('10.0'), stacks: ['web'], cordoned: false, cordoned_at: null, cordoned_reason: null },
  { id: 2, name: 'Bravo', type: 'remote', status: 'online', stats: { active: 5, managed: 5, unmanaged: 0, exited: 0, total: 5 }, systemStats: sys('95.0'), stacks: ['db'], cordoned: false, cordoned_at: null, cordoned_reason: null },
  { id: 3, name: 'Charlie', type: 'remote', status: 'offline', stats: null, systemStats: null, stacks: null, cordoned: false, cordoned_at: null, cordoned_reason: null },
];

const DEFAULT_PREFS: FleetPreferences = { sortBy: 'name', sortDir: 'asc', filterStatus: 'all', filterType: 'all', filterCritical: false };

function setup(prefs: Partial<FleetPreferences> = {}) {
  const updatePrefs = vi.fn();
  const merged = { ...DEFAULT_PREFS, ...prefs };
  const hook = renderHook(
    (p: { prefs: FleetPreferences }) => useFleetOverview({ prefs: p.prefs, updatePrefs, updateStatuses: [] }),
    { initialProps: { prefs: merged } },
  );
  return { ...hook, updatePrefs };
}

beforeEach(() => {
  apiFetchMock.mockReset();
  fetchForNodeMock.mockReset();
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/fleet/overview') return Promise.resolve(okJson(NODES));
    if (path === '/node-labels') return Promise.resolve(okJson({}));
    return Promise.resolve(okJson({}));
  });
  fetchForNodeMock.mockResolvedValue(okJson([]));
});
afterEach(() => vi.clearAllMocks());

describe('useFleetOverview', () => {
  it('loads nodes and computes masthead stats', async () => {
    const { result } = setup();
    await act(async () => { await result.current.fetchOverview(); });

    expect(result.current.nodes).toHaveLength(3);
    expect(result.current.loading).toBe(false);
    expect(result.current.mastheadStats.nodeCount).toBe(3);
    expect(result.current.mastheadStats.onlineCount).toBe(2);
    // Bravo at 95% CPU is critical.
    expect(result.current.mastheadStats.criticalCount).toBe(1);
    expect(result.current.lastSyncAt).toBeTypeOf('number');
  });

  it('filters by search query across node name and stack names', async () => {
    const { result } = setup();
    await act(async () => { await result.current.fetchOverview(); });
    act(() => result.current.setSearchQuery('db'));
    await waitFor(() => expect(result.current.processedNodes).toHaveLength(1));
    expect(result.current.processedNodes[0].name).toBe('Bravo');
  });

  it('filters by status=offline', async () => {
    const { result } = setup({ filterStatus: 'offline' });
    await act(async () => { await result.current.fetchOverview(); });
    expect(result.current.processedNodes.map(n => n.name)).toEqual(['Charlie']);
  });

  it('filters critical-only to the high-CPU node', async () => {
    const { result } = setup({ filterCritical: true });
    await act(async () => { await result.current.fetchOverview(); });
    expect(result.current.processedNodes.map(n => n.name)).toEqual(['Bravo']);
  });

  it('sorts by cpu descending', async () => {
    const { result } = setup({ sortBy: 'cpu', sortDir: 'asc' });
    await act(async () => { await result.current.fetchOverview(); });
    // cpu sort is inherently descending (b - a); offline node reads 0.
    expect(result.current.processedNodes.map(n => n.name)).toEqual(['Bravo', 'Alpha', 'Charlie']);
  });

  it('ignores an aborted fetch without surfacing an error', async () => {
    const { result } = setup();
    apiFetchMock.mockImplementationOnce(() => Promise.reject(new DOMException('aborted', 'AbortError')));
    await act(async () => { await result.current.fetchOverview(); });
    // No throw; nodes stay empty, loading cleared.
    expect(result.current.nodes).toHaveLength(0);
    expect(result.current.loading).toBe(false);
  });

  it('clearFilters resets prefs and label filters', async () => {
    const { result, updatePrefs } = setup({ filterStatus: 'online' });
    await act(async () => { await result.current.fetchOverview(); });
    act(() => result.current.clearFilters());
    expect(updatePrefs).toHaveBeenCalledWith({ filterStatus: 'all', filterType: 'all', filterCritical: false });
  });
});
