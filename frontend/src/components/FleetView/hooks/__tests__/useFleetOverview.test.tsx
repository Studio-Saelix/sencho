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

const DEFAULT_PREFS: FleetPreferences = { sortBy: 'name', sortDir: 'asc', filterStatus: 'all', filterType: 'all', filterCritical: false, filterNetworking: 'all' };

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
    if (path === '/fleet/networking-summary') return Promise.resolve(okJson({
      nodes: [
        // Alpha (1) is exposed only; Bravo (2) has a summary but is unknown + drift, not exposed.
        { nodeId: 1, summary: { exposed: { count: 1, stacks: ['web'] }, unknownExposure: { count: 0, stacks: [] }, networkDrift: { count: 0, stacks: [] } } },
        { nodeId: 2, summary: { exposed: { count: 0, stacks: [] }, unknownExposure: { count: 1, stacks: ['db'] }, networkDrift: { count: 1, stacks: ['db'] } } },
      ],
    }));
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

  it('does not clear loading from an aborted call that a newer call replaced', async () => {
    const { result } = setup();
    let release: (r: Response) => void = () => {};
    apiFetchMock.mockImplementationOnce((_path: string, init?: { signal?: AbortSignal }) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    }));
    apiFetchMock.mockImplementationOnce(() => new Promise<Response>((res) => { release = res; }));
    let first: Promise<void> = Promise.resolve();
    let second: Promise<void> = Promise.resolve();
    act(() => { first = result.current.fetchOverview(); });
    act(() => { second = result.current.fetchOverview(); });
    await act(async () => { await first; });
    // The aborted first call must not have flipped loading off: no empty-fleet flash.
    expect(result.current.loading).toBe(true);
    await act(async () => { release(okJson(NODES)); await second; });
    expect(result.current.loading).toBe(false);
    expect(result.current.nodes).toHaveLength(3);
  });

  it('retries the GitOps attention request after it was aborted', async () => {
    const { result } = setup();
    let gitopsCalls = 0;
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/fleet/overview') return Promise.resolve(okJson(NODES));
      if (path.startsWith('/gitops/applications')) {
        gitopsCalls += 1;
        if (gitopsCalls === 1) return Promise.reject(new DOMException('aborted', 'AbortError'));
        return Promise.resolve(okJson({ summary: { attentionByNode: { '2': 3 } }, coverage: [{ nodeId: 2, state: 'ok' }] }));
      }
      return Promise.resolve(okJson({ nodes: [] }));
    });
    await act(async () => { await result.current.fetchOverview(); });
    await act(async () => { await result.current.fetchOverview(); });
    expect(gitopsCalls).toBe(2);
    expect(result.current.gitopsAttentionByNode.get(2)).toBe(3);
  });

  it('does not request GitOps attention again after it loaded', async () => {
    const { result } = setup();
    await act(async () => { await result.current.fetchOverview(); });
    await act(async () => { await result.current.fetchOverview(); });
    const gitopsCalls = apiFetchMock.mock.calls.filter(([path]) => String(path).startsWith('/gitops/applications'));
    expect(gitopsCalls).toHaveLength(1);
  });

  it('lets an in-flight networking summary finish when the next overview starts', async () => {
    const { result } = setup();
    const signals: AbortSignal[] = [];
    let releaseSummary: (r: Response) => void = () => {};
    apiFetchMock.mockImplementation((path: string, init?: { signal?: AbortSignal }) => {
      if (path === '/fleet/overview') return Promise.resolve(okJson(NODES));
      if (path === '/fleet/networking-summary') {
        if (init?.signal) signals.push(init.signal);
        return new Promise<Response>((res) => { releaseSummary = res; });
      }
      return Promise.resolve(okJson({}));
    });
    await act(async () => { await result.current.fetchOverview(); });
    await act(async () => { await result.current.fetchOverview(); });
    // One request, never aborted by the second overview, and not restarted.
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);
    await act(async () => {
      releaseSummary(okJson({ nodes: [{ nodeId: 1, summary: { exposed: { count: 1, stacks: ['web'] }, unknownExposure: { count: 0, stacks: [] }, networkDrift: { count: 0, stacks: [] } } }] }));
    });
    await waitFor(() => expect(result.current.networkingByNode.get(1)?.exposed).toBe(true));
  });

  it('aborts every in-flight request on unmount', async () => {
    const { result, unmount } = setup();
    const signals: AbortSignal[] = [];
    apiFetchMock.mockImplementation((_path: string, init?: { signal?: AbortSignal }) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>(() => {});
    });
    act(() => { void result.current.fetchOverview(); });
    unmount();
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every(sig => sig.aborted)).toBe(true);
  });

  it('clearFilters resets prefs and label filters', async () => {
    const { result, updatePrefs } = setup({ filterStatus: 'online' });
    await act(async () => { await result.current.fetchOverview(); });
    act(() => result.current.clearFilters());
    expect(updatePrefs).toHaveBeenCalledWith({ filterStatus: 'all', filterType: 'all', filterCritical: false, filterNetworking: 'all' });
  });

  it('narrows to nodes with an exposed stack when the networking filter is set', async () => {
    const { result } = setup({ filterNetworking: 'exposed' });
    await act(async () => { await result.current.fetchOverview(); });
    // Bravo has a summary but exposed.count is 0, so it is excluded, proving the
    // filter checks the signal rather than just presence of a summary.
    await waitFor(() => expect(result.current.processedNodes.map(n => n.name)).toEqual(['Alpha']));
  });

  it('narrows by the unknown-exposure and network-drift signals', async () => {
    const unknown = setup({ filterNetworking: 'unknown' });
    await act(async () => { await unknown.result.current.fetchOverview(); });
    await waitFor(() => expect(unknown.result.current.processedNodes.map(n => n.name)).toEqual(['Bravo']));

    const drift = setup({ filterNetworking: 'drift' });
    await act(async () => { await drift.result.current.fetchOverview(); });
    await waitFor(() => expect(drift.result.current.processedNodes.map(n => n.name)).toEqual(['Bravo']));
  });

  it('keeps the overview loaded when the networking summary fetch fails', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/fleet/overview') return Promise.resolve(okJson(NODES));
      if (path === '/fleet/networking-summary') return Promise.reject(new Error('summary down'));
      return Promise.resolve(okJson({}));
    });
    // With no networking filter active, the overview must render all nodes even
    // though the summary fetch threw (fail-soft, detached from the load path).
    const { result } = setup({ filterNetworking: 'all' });
    await act(async () => { await result.current.fetchOverview(); });
    expect(result.current.processedNodes.length).toBe(3);
  });
});
