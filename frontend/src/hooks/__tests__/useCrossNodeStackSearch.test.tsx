import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Node } from '@/context/NodeContext';

const fetchForNodeMock = vi.fn();
vi.mock('@/lib/api', () => ({
  fetchForNode: (...args: unknown[]) => fetchForNodeMock(...args),
}));

const useNodesMock = vi.fn();
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => useNodesMock(),
}));

import { useCrossNodeStackSearch } from '../useCrossNodeStackSearch';

function node(id: number, name: string, status: Node['status'] = 'online'): Node {
  return {
    id,
    name,
    type: id === 1 ? 'local' : 'remote',
    compose_dir: '/compose',
    is_default: id === 1,
    status,
    created_at: 0,
  };
}

function res(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface NodeFixture {
  files?: string[];
  statuses?: Record<string, unknown>;
  listStatus?: number;
  statusStatus?: number;
  throwOn?: 'list' | 'both';
}

function mockFleet(map: Record<number, NodeFixture>) {
  fetchForNodeMock.mockImplementation((endpoint: string, nodeId: number) => {
    const cfg = map[nodeId] ?? {};
    if (cfg.throwOn === 'both' || (cfg.throwOn === 'list' && endpoint === '/stacks')) {
      return Promise.reject(new Error('boom'));
    }
    if (endpoint === '/stacks') {
      return Promise.resolve(res(cfg.listStatus ?? 200, cfg.files ?? []));
    }
    if (endpoint === '/stacks/statuses') {
      return Promise.resolve(res(cfg.statusStatus ?? 200, cfg.statuses ?? {}));
    }
    return Promise.resolve(res(404, {}));
  });
}

async function flushDebounce(ms = 260) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  fetchForNodeMock.mockReset();
  useNodesMock.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('useCrossNodeStackSearch', () => {
  it('does not fetch while the query is empty', async () => {
    useNodesMock.mockReturnValue({ nodes: [node(1, 'local'), node(2, 'opsix')] });
    const { result } = renderHook(() => useCrossNodeStackSearch({ query: '', enabled: true }));

    await flushDebounce(300);

    expect(fetchForNodeMock).not.toHaveBeenCalled();
    expect(result.current.hits).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('does not fetch when disabled even with a query', async () => {
    useNodesMock.mockReturnValue({ nodes: [node(1, 'local')] });
    const { result } = renderHook(() => useCrossNodeStackSearch({ query: 'db', enabled: false }));

    await flushDebounce();

    expect(fetchForNodeMock).not.toHaveBeenCalled();
    expect(result.current.hits).toEqual([]);
  });

  it('fans out once per search session and filters cached inventory on refine (no refetch)', async () => {
    useNodesMock.mockReturnValue({ nodes: [node(1, 'local'), node(2, 'opsix')] });
    mockFleet({
      1: { files: ['db.yml', 'web.yml'], statuses: { 'db.yml': { status: 'running' }, 'web.yml': { status: 'exited' } } },
      2: { files: ['mariadb.yml', 'cache.yml'], statuses: { 'mariadb.yml': 'running' } },
    });

    const { result, rerender } = renderHook(
      ({ query }) => useCrossNodeStackSearch({ query, enabled: true }),
      { initialProps: { query: 'd' } },
    );

    await flushDebounce();

    // /stacks + /stacks/statuses for each of 2 nodes = 4 calls.
    expect(fetchForNodeMock).toHaveBeenCalledTimes(4);
    expect(result.current.hits.map(h => h.file).sort()).toEqual(['db.yml', 'mariadb.yml']);
    expect(result.current.hits.find(h => h.file === 'db.yml')?.status).toBe('running');
    expect(result.current.hits.find(h => h.file === 'mariadb.yml')?.status).toBe('running');

    // Refining to a term that matches a different file must be served from the
    // cached inventory without any new network calls.
    rerender({ query: 'web' });
    await flushDebounce();

    expect(fetchForNodeMock).toHaveBeenCalledTimes(4);
    expect(result.current.hits.map(h => h.file)).toEqual(['web.yml']);
    expect(result.current.hits[0]?.status).toBe('exited');
  });

  it('skips offline nodes and the excluded node', async () => {
    useNodesMock.mockReturnValue({
      nodes: [node(1, 'local'), node(2, 'opsix', 'offline'), node(3, 'edge')],
    });
    mockFleet({ 1: { files: ['a.yml'] }, 3: { files: ['a.yml'] } });

    const { result } = renderHook(() =>
      useCrossNodeStackSearch({ query: 'a', enabled: true, excludeNodeId: 1 }),
    );

    await flushDebounce();

    // node 1 excluded, node 2 offline, only node 3 queried = 2 calls.
    expect(fetchForNodeMock).toHaveBeenCalledTimes(2);
    const queriedNodeIds = new Set(fetchForNodeMock.mock.calls.map(c => c[1]));
    expect(queriedNodeIds).toEqual(new Set([3]));
    expect(result.current.hits.every(h => h.nodeId === 3)).toBe(true);
  });

  it('does not fetch when every node is offline', async () => {
    useNodesMock.mockReturnValue({ nodes: [node(1, 'local', 'offline')] });
    const { result } = renderHook(() => useCrossNodeStackSearch({ query: 'db', enabled: true }));

    await flushDebounce();

    expect(fetchForNodeMock).not.toHaveBeenCalled();
    expect(result.current.hits).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('records a failed node when the stack list response is not ok, keeping other nodes', async () => {
    useNodesMock.mockReturnValue({ nodes: [node(1, 'local'), node(2, 'opsix')] });
    mockFleet({
      1: { files: ['db.yml'], statuses: { 'db.yml': 'running' } },
      2: { listStatus: 502 },
    });

    const { result } = renderHook(() => useCrossNodeStackSearch({ query: 'db', enabled: true }));

    await flushDebounce();

    expect(result.current.failedNodes).toEqual([
      { nodeId: 2, nodeName: 'opsix', reason: 'list returned HTTP 502' },
    ]);
    expect(result.current.hits.map(h => h.file)).toEqual(['db.yml']);
  });

  it('records a failed node with the error message when the request throws', async () => {
    useNodesMock.mockReturnValue({ nodes: [node(2, 'opsix')] });
    mockFleet({ 2: { throwOn: 'both' } });

    const { result } = renderHook(() => useCrossNodeStackSearch({ query: 'x', enabled: true }));

    await flushDebounce();

    expect(result.current.failedNodes).toEqual([
      { nodeId: 2, nodeName: 'opsix', reason: 'boom' },
    ]);
    expect(result.current.hits).toEqual([]);
  });

  it('still lists stacks as unknown when only the status endpoint fails', async () => {
    useNodesMock.mockReturnValue({ nodes: [node(1, 'local')] });
    mockFleet({ 1: { files: ['db.yml'], statusStatus: 500 } });

    const { result } = renderHook(() => useCrossNodeStackSearch({ query: 'db', enabled: true }));

    await flushDebounce();

    // A status-endpoint failure is graceful degradation, not a node failure.
    expect(result.current.failedNodes).toEqual([]);
    expect(result.current.hits).toEqual([
      { nodeId: 1, nodeName: 'local', file: 'db.yml', status: 'unknown' },
    ]);
  });

  it('clears results when the search is disabled', async () => {
    useNodesMock.mockReturnValue({ nodes: [node(1, 'local')] });
    mockFleet({ 1: { files: ['db.yml'], statuses: { 'db.yml': 'running' } } });

    const { result, rerender } = renderHook(
      ({ enabled }) => useCrossNodeStackSearch({ query: 'db', enabled }),
      { initialProps: { enabled: true } },
    );

    await flushDebounce();
    expect(result.current.hits.length).toBe(1);

    rerender({ enabled: false });
    await flushDebounce(10);

    expect(result.current.hits).toEqual([]);
  });

  it('starts a fresh fanout after the query is cleared and re-entered', async () => {
    useNodesMock.mockReturnValue({ nodes: [node(1, 'local')] });
    mockFleet({ 1: { files: ['db.yml', 'web.yml'], statuses: { 'db.yml': 'running' } } });

    const { result, rerender } = renderHook(
      ({ query }) => useCrossNodeStackSearch({ query, enabled: true }),
      { initialProps: { query: 'db' } },
    );
    await flushDebounce();
    expect(fetchForNodeMock).toHaveBeenCalledTimes(2);
    expect(result.current.hits.map(h => h.file)).toEqual(['db.yml']);

    // Clearing the query ends the session and clears results.
    rerender({ query: '' });
    await flushDebounce(10);
    expect(result.current.hits).toEqual([]);

    // Re-entering a query starts a new session, so the fleet is queried again.
    rerender({ query: 'web' });
    await flushDebounce();
    expect(fetchForNodeMock).toHaveBeenCalledTimes(4);
    expect(result.current.hits.map(h => h.file)).toEqual(['web.yml']);
  });

  it('re-fans-out when excludeNodeId changes (active node switch)', async () => {
    useNodesMock.mockReturnValue({ nodes: [node(1, 'local'), node(2, 'opsix')] });
    mockFleet({ 1: { files: ['a.yml'] }, 2: { files: ['a.yml'] } });

    const { rerender } = renderHook(
      ({ excludeNodeId }) => useCrossNodeStackSearch({ query: 'a', enabled: true, excludeNodeId }),
      { initialProps: { excludeNodeId: 1 } },
    );
    await flushDebounce();
    expect(new Set(fetchForNodeMock.mock.calls.map(c => c[1]))).toEqual(new Set([2]));

    fetchForNodeMock.mockClear();
    rerender({ excludeNodeId: 2 });
    await flushDebounce();
    expect(new Set(fetchForNodeMock.mock.calls.map(c => c[1]))).toEqual(new Set([1]));
  });

  it('degrades to unknown when the status endpoint is 200 with an unparseable body', async () => {
    useNodesMock.mockReturnValue({ nodes: [node(1, 'local')] });
    fetchForNodeMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(res(200, ['db.yml']));
      // 200 OK but a non-JSON body, so statusRes.json() throws.
      return Promise.resolve(new Response('<html>not json</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }));
    });

    const { result } = renderHook(() => useCrossNodeStackSearch({ query: 'db', enabled: true }));
    await flushDebounce();

    // The successful stack list must survive a bad status body.
    expect(result.current.failedNodes).toEqual([]);
    expect(result.current.hits).toEqual([
      { nodeId: 1, nodeName: 'local', file: 'db.yml', status: 'unknown' },
    ]);
  });
});
