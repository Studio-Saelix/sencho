import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const apiFetchMock = vi.fn();

vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/components/ui/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const useNodesMock = vi.fn();
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => useNodesMock(),
}));

const useImageUpdatesMock = vi.fn();
vi.mock('@/hooks/useImageUpdates', () => ({
  useImageUpdates: (...args: unknown[]) => useImageUpdatesMock(...args),
}));

import { useStackListState } from './useStackListState';
import { __resetStackStatusesFetchForTests } from '@/lib/stackStatusesFetch';

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function notFound(): Response {
  return new Response('not found', { status: 404 });
}

beforeEach(() => {
  __resetStackStatusesFetchForTests();
  apiFetchMock.mockReset();
  useNodesMock.mockReset();
  useImageUpdatesMock.mockReset();
  useNodesMock.mockReturnValue({
    activeNode: { id: 1, name: 'Local', type: 'local' },
    nodes: [{ id: 1, name: 'Local', type: 'local' }],
  });
  useImageUpdatesMock.mockReturnValue({
    stackUpdates: {},
    refresh: vi.fn(),
    sidebarIndicators: true,
  });
});

describe('useStackListState.refreshStacks failure classification', () => {
  it('rejects a malformed (non-array) successful /stacks response as an error, not confirmed-empty', async () => {
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(okJson({}));
      return Promise.resolve(notFound());
    });

    const { result } = renderHook(() => useStackListState());
    await act(async () => {
      await result.current.refreshStacks();
    });

    expect(result.current.stacksLoadStatus).toBe('error');
    expect(result.current.files).toEqual([]);
  });

  it('surfaces a recoverable error on a background failure after the list was already confirmed empty', async () => {
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(okJson([]));
      if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({}));
      return Promise.resolve(notFound());
    });

    const { result } = renderHook(() => useStackListState());
    await act(async () => {
      await result.current.refreshStacks();
    });
    expect(result.current.stacksLoadStatus).toBe('success');
    expect(result.current.files).toEqual([]);

    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(new Response('fail', { status: 500 }));
      return Promise.resolve(notFound());
    });

    await act(async () => {
      await result.current.refreshStacks(true);
    });

    expect(result.current.stacksLoadStatus).toBe('error');
  });

  it('preserves a non-empty list on a background failure (soft-refresh semantics unchanged)', async () => {
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(okJson(['web.yml']));
      if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({ 'web.yml': { status: 'running' } }));
      return Promise.resolve(notFound());
    });

    const { result } = renderHook(() => useStackListState());
    await act(async () => {
      await result.current.refreshStacks();
    });
    expect(result.current.stacksLoadStatus).toBe('success');
    expect(result.current.files).toEqual(['web.yml']);

    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(new Response('fail', { status: 500 }));
      return Promise.resolve(notFound());
    });

    await act(async () => {
      await result.current.refreshStacks(true);
    });

    expect(result.current.stacksLoadStatus).toBe('success');
    expect(result.current.files).toEqual(['web.yml']);
    expect(result.current.stacksLoadError).toBe('Could not load stacks (500)');
  });

  it('keeps a list that just loaded non-empty when the follow-up statuses fetch throws in the same background refresh', async () => {
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(okJson([]));
      if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({}));
      return Promise.resolve(notFound());
    });

    const { result } = renderHook(() => useStackListState());
    await act(async () => {
      await result.current.refreshStacks();
    });
    expect(result.current.files).toEqual([]);

    // A background refresh discovers a real stack, but decoding the
    // follow-up /stacks/statuses call throws. The just-committed non-empty
    // list must survive: only the closure-stale `files` from before this
    // call was empty, not the list this attempt just fetched.
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(okJson(['web.yml']));
      if (endpoint === '/stacks/statuses') return Promise.reject(new Error('network error'));
      return Promise.resolve(notFound());
    });

    await act(async () => {
      await result.current.refreshStacks(true);
    });

    expect(result.current.files).toEqual(['web.yml']);
  });
});

describe('useStackListState Updates chip confirmed-only', () => {
  async function loadStacks() {
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') {
        return Promise.resolve(okJson(['ok.yml', 'partial.yml', 'failed.yml']));
      }
      if (endpoint === '/stacks/statuses') {
        return Promise.resolve(okJson({
          'ok.yml': { status: 'running' },
          'partial.yml': { status: 'running' },
          'failed.yml': { status: 'running' },
        }));
      }
      return Promise.resolve(notFound());
    });

    useImageUpdatesMock.mockReturnValue({
      stackUpdates: {
        'ok.yml': { hasUpdate: true, checkStatus: 'ok', lastError: null, checkedAt: 1 },
        'partial.yml': { hasUpdate: true, checkStatus: 'partial', lastError: 'timeout', checkedAt: 1 },
        'failed.yml': { hasUpdate: true, checkStatus: 'failed', lastError: 'unreachable', checkedAt: 1 },
      },
      refresh: vi.fn(),
      sidebarIndicators: true,
    });

    const { result } = renderHook(() => useStackListState());
    await act(async () => {
      await result.current.refreshStacks();
    });
    return result;
  }

  it('counts only ok+true stacks under Updates', async () => {
    const result = await loadStacks();
    expect(result.current.filterCounts.updates).toBe(1);
  });

  it('filters the Updates chip to confirmed stacks only', async () => {
    const result = await loadStacks();
    await act(async () => {
      result.current.setFilterChip('updates');
    });
    expect(result.current.chipFilteredFiles).toEqual(['ok.yml']);
  });
});

describe('useStackListState.hydration concurrency and evidence', () => {
  it('starts the statuses request before the list resolves (concurrent dispatch)', async () => {
    let resolveList: (r: Response) => void;
    const listGate = new Promise<Response>((r) => { resolveList = r; });
    const statusCalls: string[] = [];
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return listGate;
      if (endpoint === '/stacks/statuses') { statusCalls.push(endpoint); return Promise.resolve(okJson({})); }
      return Promise.resolve(notFound());
    });
    const { result } = renderHook(() => useStackListState());
    let p: Promise<string[]> | undefined;
    await act(async () => {
      p = result.current.refreshStacks();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(statusCalls).toContain('/stacks/statuses');
    await act(async () => {
      resolveList!(okJson(['web.yml']));
      await p;
    });
    expect(result.current.files).toEqual(['web.yml']);
  });

  it('clears isLoading at list commit while the status request is still pending', async () => {
    let resolveStatus: (r: Response) => void;
    const statusGate = new Promise<Response>((r) => { resolveStatus = r; });
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(okJson(['web.yml']));
      if (endpoint === '/stacks/statuses') return statusGate;
      return Promise.resolve(notFound());
    });
    const { result } = renderHook(() => useStackListState());
    await act(async () => {
      const p = result.current.refreshStacks();
      await new Promise((r) => setTimeout(r, 0));
      expect(result.current.isLoading).toBe(false);
      expect(result.current.hydrationStatus).toBe('pending');
      resolveStatus!(okJson({ 'web.yml': { status: 'running' } }));
      await p;
    });
    expect(result.current.hydrationStatus).toBe('ok');
    expect(result.current.actionsReady).toBe(true);
  });

  it('holds a status-first result provisional until the list validates', async () => {
    let resolveList: (r: Response) => void;
    const listGate = new Promise<Response>((r) => { resolveList = r; });
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return listGate;
      if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({ 'web.yml': { status: 'running' } }));
      return Promise.resolve(notFound());
    });
    const { result } = renderHook(() => useStackListState());
    let p: Promise<string[]> | undefined;
    await act(async () => {
      p = result.current.refreshStacks();
      await new Promise((r) => setTimeout(r, 0));
      expect(result.current.hydrationStatus).toBe('pending');
    });
    await act(async () => {
      resolveList!(okJson(['web.yml']));
      await p;
    });
    expect(result.current.hydrationStatus).toBe('ok');
  });

  it('transfers loading ownership to a superseding background refresh', async () => {
    let resolveList1: (r: Response) => void;
    const gate1 = new Promise<Response>((r) => { resolveList1 = r; });
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return gate1;
      if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({ 'web.yml': { status: 'running' } }));
      return Promise.resolve(notFound());
    });
    const { result } = renderHook(() => useStackListState());
    let fg: Promise<string[]> | undefined;
    await act(async () => {
      fg = result.current.refreshStacks();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.isLoading).toBe(true);

    let resolveList2: (r: Response) => void;
    const gate2 = new Promise<Response>((r) => { resolveList2 = r; });
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return gate2;
      if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({ 'web.yml': { status: 'running' } }));
      return Promise.resolve(notFound());
    });
    let bg: Promise<string[]> | undefined;
    await act(async () => {
      bg = result.current.refreshStacks(true);
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      resolveList1!(okJson(['web.yml']));
      await fg;
    });
    expect(result.current.isLoading).toBe(true);
    await act(async () => {
      resolveList2!(okJson(['web.yml']));
      await bg;
    });
    expect(result.current.isLoading).toBe(false);
  });

  it('never commits a completed status result when the list fails', async () => {
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(new Response('fail', { status: 500 }));
      if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({ 'web.yml': { status: 'running' } }));
      return Promise.resolve(notFound());
    });
    const { result } = renderHook(() => useStackListState());
    await act(async () => {
      await result.current.refreshStacks();
    });
    expect(result.current.stacksLoadStatus).toBe('error');
    expect(result.current.hydrationStatus).toBe('pending');
    expect(result.current.actionsReady).toBe(false);
  });

  it('keeps the list visible with error evidence when the status promise rejects', async () => {
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(okJson(['web.yml']));
      if (endpoint === '/stacks/statuses') return Promise.reject(new Error('network down'));
      return Promise.resolve(notFound());
    });
    const { result } = renderHook(() => useStackListState());
    await act(async () => {
      await result.current.refreshStacks();
    });
    expect(result.current.stacksLoadStatus).toBe('success');
    expect(result.current.files).toEqual(['web.yml']);
    expect(result.current.hydrationStatus).toBe('error');
    expect(result.current.actionsReady).toBe(false);
  });

  it('blocks readiness when the status payload misses a list file even with extra keys', async () => {
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(okJson(['web.yml', 'db.yml']));
      if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({
        'web.yml': { status: 'running' },
        'unrelated.yml': { status: 'exited' },
      }));
      return Promise.resolve(notFound());
    });
    const { result } = renderHook(() => useStackListState());
    await act(async () => {
      await result.current.refreshStacks();
    });
    expect(result.current.hydrationStatus).toBe('ok');
    expect(result.current.actionsReady).toBe(false);
    expect(result.current.hydrationDisplay).toBe('incomplete');
  });

  it('treats malformed status payloads as errors without per-stack fallback', async () => {
    const calls: string[] = [];
    apiFetchMock.mockImplementation((endpoint: string) => {
      calls.push(endpoint);
      if (endpoint === '/stacks') return Promise.resolve(okJson(['web.yml']));
      if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({ 'web.yml': { status: 'bogus' } }));
      return Promise.resolve(notFound());
    });
    const { result } = renderHook(() => useStackListState());
    await act(async () => {
      await result.current.refreshStacks();
    });
    expect(result.current.hydrationStatus).toBe('error');
    expect(result.current.actionsReady).toBe(false);
    expect(calls.filter(c => c.includes('/containers'))).toEqual([]);
  });

  it('does not treat arbitrary string maps as legacy status payloads', async () => {
    const calls: string[] = [];
    apiFetchMock.mockImplementation((endpoint: string) => {
      calls.push(endpoint);
      if (endpoint === '/stacks') return Promise.resolve(okJson(['web.yml']));
      if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({ error: 'failed' }));
      return Promise.resolve(notFound());
    });
    const { result } = renderHook(() => useStackListState());
    await act(async () => {
      await result.current.refreshStacks();
    });
    expect(result.current.hydrationStatus).toBe('error');
    expect(calls.filter(c => c.includes('/containers'))).toEqual([]);
  });

  it('re-derives statuses from per-stack containers for a valid legacy payload', async () => {
    const calls: string[] = [];
    apiFetchMock.mockImplementation((endpoint: string) => {
      calls.push(endpoint);
      if (endpoint === '/stacks') return Promise.resolve(okJson(['web.yml']));
      if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({ 'web.yml': 'running' }));
      if (endpoint === '/stacks/web.yml/containers') return Promise.resolve(okJson([{ State: 'running', Status: 'Up 2 hours' }]));
      return Promise.resolve(notFound());
    });
    const { result } = renderHook(() => useStackListState());
    await act(async () => {
      await result.current.refreshStacks();
    });
    expect(calls).toContain('/stacks/web.yml/containers');
    expect(result.current.hydrationStatus).toBe('ok');
    expect(result.current.actionsReady).toBe(true);
    expect(result.current.stackStatuses['web.yml']).toBe('running');
  });

  it('does not count failed per-stack derivations as coverage', async () => {
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(okJson(['web.yml', 'db.yml']));
      if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({ 'web.yml': 'running' }));
      if (endpoint === '/stacks/web.yml/containers') return Promise.resolve(okJson([{ State: 'running', Status: 'Up 2 hours' }]));
      if (endpoint === '/stacks/db.yml/containers') return Promise.resolve(new Response('boom', { status: 500 }));
      return Promise.resolve(notFound());
    });
    const { result } = renderHook(() => useStackListState());
    await act(async () => {
      await result.current.refreshStacks();
    });
    expect(result.current.hydrationStatus).toBe('ok');
    expect(result.current.actionsReady).toBe(false);
    expect(result.current.hydrationDisplay).toBe('incomplete');
  });

  it('restores prior evidence as stale when a same-list foreground status fetch fails', async () => {
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(okJson(['web.yml']));
      if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({ 'web.yml': { status: 'running' } }));
      return Promise.resolve(notFound());
    });
    const { result } = renderHook(() => useStackListState());
    await act(async () => {
      await result.current.refreshStacks();
    });
    expect(result.current.actionsReady).toBe(true);

    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(okJson(['web.yml']));
      if (endpoint === '/stacks/statuses') return Promise.resolve(new Response('boom', { status: 500 }));
      return Promise.resolve(notFound());
    });
    await act(async () => {
      await result.current.refreshStacks();
    });
    expect(result.current.hydrationStatus).toBe('ok');
    expect(result.current.actionsReady).toBe(false);
    expect(result.current.hydrationDisplay).toBe('stale');
  });

  it('marks prior evidence stale on a same-list background failure', async () => {
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(okJson(['web.yml']));
      if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({ 'web.yml': { status: 'running' } }));
      return Promise.resolve(notFound());
    });
    const { result } = renderHook(() => useStackListState());
    await act(async () => {
      await result.current.refreshStacks();
    });
    expect(result.current.actionsReady).toBe(true);

    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(okJson(['web.yml']));
      if (endpoint === '/stacks/statuses') return Promise.resolve(new Response('boom', { status: 500 }));
      return Promise.resolve(notFound());
    });
    await act(async () => {
      await result.current.refreshStacks(true);
    });
    expect(result.current.hydrationDisplay).toBe('stale');
    expect(result.current.actionsReady).toBe(false);
  });

  it('establishes ok evidence with zero coverage on an empty list', async () => {
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(okJson([]));
      if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({}));
      return Promise.resolve(notFound());
    });
    const { result } = renderHook(() => useStackListState());
    await act(async () => {
      await result.current.refreshStacks();
    });
    expect(result.current.stacksLoadStatus).toBe('success');
    expect(result.current.hydrationStatus).toBe('ok');
    expect(result.current.actionsReady).toBe(true);
  });

  it('fails closed on the first render after a node switch', async () => {
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(okJson(['web.yml']));
      if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({ 'web.yml': { status: 'running' } }));
      return Promise.resolve(notFound());
    });
    const { result, rerender } = renderHook(() => useStackListState());
    await act(async () => {
      await result.current.refreshStacks();
    });
    expect(result.current.actionsReady).toBe(true);

    useNodesMock.mockReturnValue({
      activeNode: { id: 2, name: 'Other', type: 'remote' },
      nodes: [{ id: 2, name: 'Other', type: 'remote' }],
    });
    rerender();
    expect(result.current.actionsReady).toBe(false);
    expect(result.current.hydrationDisplay).toBe('pending');
  });

  it('zeroes Up/Down filter counts while hydration is pending and restores them after', async () => {
    let resolveStatus: (r: Response) => void;
    const statusGate = new Promise<Response>((r) => { resolveStatus = r; });
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(okJson(['web.yml']));
      if (endpoint === '/stacks/statuses') return statusGate;
      return Promise.resolve(notFound());
    });
    const { result } = renderHook(() => useStackListState());
    await act(async () => {
      const p = result.current.refreshStacks();
      await new Promise((r) => setTimeout(r, 0));
      expect(result.current.filterCounts.up).toBe(0);
      expect(result.current.filterCounts.down).toBe(0);
      resolveStatus!(okJson({ 'web.yml': { status: 'running' } }));
      await p;
    });
    expect(result.current.filterCounts.up).toBe(1);
    act(() => result.current.setFilterChip('up'));
    expect(result.current.chipFilteredFiles).toEqual(['web.yml']);
  });
});

describe('useStackListState delayed prior-node arbitration', () => {
  it('never lets a delayed prior-node list response replace the current node state', async () => {
    let resolveListA: (r: Response) => void;
    const gateA = new Promise<Response>((r) => { resolveListA = r; });
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return gateA;
      if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({ 'a.yml': { status: 'running' } }));
      return Promise.resolve(notFound());
    });
    const { result, rerender } = renderHook(() => useStackListState());
    let fgA: Promise<string[]> | undefined;
    await act(async () => {
      fgA = result.current.refreshStacks();
      await new Promise((r) => setTimeout(r, 0));
    });

    // Switch to node B and complete a full foreground refresh.
    useNodesMock.mockReturnValue({
      activeNode: { id: 2, name: 'B', type: 'remote' },
      nodes: [{ id: 2, name: 'B', type: 'remote' }],
    });
    rerender();
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(okJson(['b.yml']));
      if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({ 'b.yml': { status: 'running' } }));
      return Promise.resolve(notFound());
    });
    await act(async () => {
      await result.current.refreshStacks();
    });
    expect(result.current.files).toEqual(['b.yml']);
    expect(result.current.filesNodeId).toBe(2);
    expect(result.current.hydrationStatus).toBe('ok');
    expect(result.current.actionsReady).toBe(true);

    // Node A's delayed list finally resolves: it must not overwrite B.
    await act(async () => {
      resolveListA!(okJson(['a.yml']));
      await fgA;
    });
    expect(result.current.files).toEqual(['b.yml']);
    expect(result.current.filesNodeId).toBe(2);
    expect(result.current.hydrationStatus).toBe('ok');
    expect(result.current.actionsReady).toBe(true);
    expect(result.current.isLoading).toBe(false);
  });

  it('never lets a delayed prior-node status response replace the current node state', async () => {
    let resolveStatusA: (r: Response) => void;
    const gateStatusA = new Promise<Response>((r) => { resolveStatusA = r; });
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(okJson(['a.yml']));
      if (endpoint === '/stacks/statuses') return gateStatusA;
      return Promise.resolve(notFound());
    });
    const { result, rerender } = renderHook(() => useStackListState());
    let fgA: Promise<string[]> | undefined;
    await act(async () => {
      fgA = result.current.refreshStacks();
      await new Promise((r) => setTimeout(r, 0));
    });

    // Node B completes fully while A's statuses are still pending.
    useNodesMock.mockReturnValue({
      activeNode: { id: 2, name: 'B', type: 'remote' },
      nodes: [{ id: 2, name: 'B', type: 'remote' }],
    });
    rerender();
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(okJson(['b.yml']));
      if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({ 'b.yml': { status: 'running' } }));
      return Promise.resolve(notFound());
    });
    await act(async () => {
      await result.current.refreshStacks();
    });
    expect(result.current.files).toEqual(['b.yml']);
    expect(result.current.hydrationStatus).toBe('ok');

    // A's delayed statuses resolve: the stale check must discard them.
    await act(async () => {
      resolveStatusA!(okJson({ 'a.yml': { status: 'exited' } }));
      await fgA;
    });
    expect(result.current.files).toEqual(['b.yml']);
    expect(result.current.filesNodeId).toBe(2);
    expect(result.current.hydrationStatus).toBe('ok');
    expect(result.current.stackStatuses).toEqual({ 'b.yml': 'running' });
    expect(result.current.actionsReady).toBe(true);
  });
});

describe('useStackListState legacy fallback payload validation', () => {
  it('fails closed when a legacy per-stack response is a 200 non-array body', async () => {
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(okJson(['web.yml']));
      if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({ 'web.yml': 'running' }));
      if (endpoint === '/stacks/web.yml/containers') return Promise.resolve(okJson({ error: 'boom' }));
      return Promise.resolve(notFound());
    });
    const { result } = renderHook(() => useStackListState());
    await act(async () => {
      await result.current.refreshStacks();
    });
    expect(result.current.hydrationStatus).toBe('error');
    expect(result.current.actionsReady).toBe(false);
  });

  it('fails closed when a legacy per-stack response is a 200 malformed array', async () => {
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(okJson(['web.yml']));
      if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({ 'web.yml': 'running' }));
      if (endpoint === '/stacks/web.yml/containers') return Promise.resolve(okJson([{ id: 'no-state-field' }]));
      return Promise.resolve(notFound());
    });
    const { result } = renderHook(() => useStackListState());
    await act(async () => {
      await result.current.refreshStacks();
    });
    expect(result.current.hydrationStatus).toBe('error');
    expect(result.current.actionsReady).toBe(false);
  });

  it('keeps partial coverage incomplete when one legacy per-stack response is malformed', async () => {
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(okJson(['web.yml', 'db.yml']));
      if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({ 'web.yml': 'running' }));
      if (endpoint === '/stacks/web.yml/containers') return Promise.resolve(okJson([{ State: 'running', Status: 'Up 2 hours' }]));
      if (endpoint === '/stacks/db.yml/containers') return Promise.resolve(okJson({ error: 'boom' }));
      return Promise.resolve(notFound());
    });
    const { result } = renderHook(() => useStackListState());
    await act(async () => {
      await result.current.refreshStacks();
    });
    expect(result.current.hydrationStatus).toBe('ok');
    expect(result.current.actionsReady).toBe(false);
    expect(result.current.hydrationDisplay).toBe('incomplete');
  });
});

describe('useStackListState stale callback node targeting', () => {
  it('refreshes the current node when a callback captured on another node is invoked late', async () => {
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(okJson(['a.yml']));
      if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({ 'a.yml': { status: 'running' } }));
      return Promise.resolve(notFound());
    });
    const { result, rerender } = renderHook(() => useStackListState());
    await act(async () => {
      await result.current.refreshStacks();
    });
    expect(result.current.files).toEqual(['a.yml']);
    // The function from the node-A render, captured like an action's finally
    // block would capture it.
    const capturedRefresh = result.current.refreshStacks;

    // Switch to node B and fully hydrate it.
    useNodesMock.mockReturnValue({
      activeNode: { id: 2, name: 'B', type: 'remote' },
      nodes: [{ id: 2, name: 'B', type: 'remote' }],
    });
    rerender();
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(okJson(['b.yml']));
      if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({ 'b.yml': { status: 'running' } }));
      return Promise.resolve(notFound());
    });
    await act(async () => {
      await result.current.refreshStacks();
    });
    expect(result.current.files).toEqual(['b.yml']);
    expect(result.current.hydrationStatus).toBe('ok');
    expect(result.current.actionsReady).toBe(true);

    // Invoke the OLD callback: both requests must target node B (the current
    // node), and B's state must remain authoritative.
    await act(async () => {
      await capturedRefresh();
    });
    const stacksTargets = apiFetchMock.mock.calls
      .filter(c => c[0] === '/stacks')
      .map(c => (c[1] as { nodeId?: number | null } | undefined)?.nodeId);
    const statusTargets = apiFetchMock.mock.calls
      .filter(c => c[0] === '/stacks/statuses')
      .map(c => (c[1] as { nodeId?: number | null } | undefined)?.nodeId);
    expect(stacksTargets.at(-1)).toBe(2);
    expect(statusTargets.at(-1)).toBe(2);
    expect(result.current.files).toEqual(['b.yml']);
    expect(result.current.filesNodeId).toBe(2);
    expect(result.current.hydrationStatus).toBe('ok');
    expect(result.current.actionsReady).toBe(true);
  });
});
