import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Node } from '@/context/NodeContext';
import type { StackStatusEntry } from '../types';
import {
  REMOTE_METRICS_INTERVAL_MS,
  REMOTE_STATUS_INTERVAL_MS,
  useStackHealthScope,
  type UseStackHealthScopeArgs,
} from '../useStackHealthScope';
import { sourceRevision } from '@/__tests__/gitopsFixtures';
import { __resetStackStatusesFetchForTests } from '@/lib/stackStatusesFetch';

const apiFetchMock = vi.fn();
const useNodesMock = vi.fn();

vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/context/NodeContext', () => ({
  useNodes: () => useNodesMock(),
}));

function okJson(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeNode(id: number, name: string, status: Node['status'] = 'online'): Node {
  return {
    id,
    name,
    type: id === 1 ? 'local' : 'remote',
    api_url: '',
    compose_dir: '',
    is_default: id === 1,
    status,
    created_at: 0,
  };
}

const local = makeNode(1, 'Local');
const remote = makeNode(2, 'Remote');

function baseArgs(overrides: Partial<UseStackHealthScopeArgs> = {}): UseStackHealthScopeArgs {
  return {
    scope: 'this-node',
    stackStatuses: {},
    stackStatusesFreshness: 'current',
    stackStatusesLoadStatus: 'success',
    stackStatusesLoadError: null,
    retryStackStatuses: vi.fn(),
    metrics: [],
    stackCpuSeries: {},
    gitopsSourceStates: {},
    stackUpdates: {},
    ...overrides,
  };
}

function countCalls(endpoint: string, nodeId?: number): number {
  return apiFetchMock.mock.calls.filter((call) => {
    if (call[0] !== endpoint) return false;
    if (nodeId === undefined) return true;
    const opts = call[1] as { nodeId?: number } | undefined;
    return opts?.nodeId === nodeId;
  }).length;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useStackHealthScope', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __resetStackStatusesFetchForTests();
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({}));
      if (endpoint === '/metrics/historical') return Promise.resolve(okJson([]));
      if (endpoint === '/git-sources') return Promise.resolve(okJson([]));
      return Promise.resolve(okJson(null));
    });
    useNodesMock.mockReturnValue({ activeNode: local, nodes: [local] });
  });

  afterEach(() => {
    __resetStackStatusesFetchForTests();
    vi.useRealTimers();
  });

  it('projects this-node rows from active inputs without remote fetches', async () => {
    const statuses: Record<string, StackStatusEntry> = {
      'web.yml': { status: 'running', networks: ['bridge'] },
    };
    const { result } = renderHook(() => useStackHealthScope(baseArgs({
      stackStatuses: statuses,
    })));
    await flush();
    expect(result.current.view).toBe('ready');
    expect(result.current.rows).toHaveLength(1);
    expect(result.current.rows[0]?.key).toBe('1:web.yml');
    expect(result.current.rows[0]?.networks).toEqual(['bridge']);
    expect(countCalls('/stacks/statuses', 2)).toBe(0);
  });

  it('paints a fast remote before a deferred remote', async () => {
    const resolvers: Record<number, Array<(r: Response) => void>> = { 2: [], 3: [] };
    const nodeB = makeNode(2, 'B');
    const nodeC = makeNode(3, 'C');
    useNodesMock.mockReturnValue({ activeNode: local, nodes: [local, nodeB, nodeC] });
    apiFetchMock.mockImplementation((endpoint: string, opts?: { nodeId?: number }) => {
      if (endpoint === '/stacks/statuses') {
        const id = opts?.nodeId ?? 0;
        return new Promise<Response>((resolve) => {
          (resolvers[id] ??= []).push(resolve);
        });
      }
      return Promise.resolve(okJson([]));
    });

    const { result } = renderHook(() => useStackHealthScope(baseArgs({
      scope: 'all-nodes',
      stackStatusesLoadStatus: 'success',
    })));
    await flush();
    expect(result.current.view).toBe('loading');

    await act(async () => {
      resolvers[2][0](okJson({ 'fast.yml': { status: 'running' } }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.rows.map((r) => r.key)).toEqual(['2:fast.yml']);
    expect(result.current.coverage.k).toBe(2); // local confirmed empty + B

    await act(async () => {
      resolvers[3][0](okJson({ 'slow.yml': { status: 'exited' } }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.rows.map((r) => r.file).sort()).toEqual(['fast.yml', 'slow.yml']);
    expect(result.current.coverage.k).toBe(3);
  });

  it('counts confirmed-empty remotes toward K with zero rows', async () => {
    useNodesMock.mockReturnValue({ activeNode: local, nodes: [local, remote] });
    const { result } = renderHook(() => useStackHealthScope(baseArgs({
      scope: 'all-nodes',
      stackStatusesLoadStatus: 'success',
    })));
    await flush();
    expect(result.current.view).toBe('empty');
    expect(result.current.coverage).toEqual({ k: 2, m: 2, n: 0 });
  });

  it('shows unavailable with retry when every node failed', async () => {
    useNodesMock.mockReturnValue({ activeNode: local, nodes: [local, remote] });
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({ error: 'nope' }, 500));
      return Promise.resolve(okJson([]));
    });
    const retryActive = vi.fn();
    const { result } = renderHook(() => useStackHealthScope(baseArgs({
      scope: 'all-nodes',
      stackStatusesLoadStatus: 'error',
      stackStatusesLoadError: 'down',
      retryStackStatuses: retryActive,
    })));
    await flush();
    expect(result.current.view).toBe('unavailable');
    expect(result.current.rows).toHaveLength(0);
    const before = countCalls('/stacks/statuses', 2);
    act(() => { result.current.retry(); });
    await flush();
    expect(retryActive).toHaveBeenCalled();
    expect(countCalls('/stacks/statuses', 2)).toBeGreaterThan(before);
  });

  it('keeps partial coverage rows and retries only failed remotes', async () => {
    const nodeOk = makeNode(2, 'Ok');
    const nodeBad = makeNode(3, 'Bad');
    useNodesMock.mockReturnValue({ activeNode: local, nodes: [local, nodeOk, nodeBad] });
    apiFetchMock.mockImplementation((endpoint: string, opts?: { nodeId?: number }) => {
      if (endpoint === '/stacks/statuses') {
        if (opts?.nodeId === 3) return Promise.resolve(okJson({ error: 'nope' }, 403));
        return Promise.resolve(okJson({ 'ok.yml': { status: 'running' } }));
      }
      return Promise.resolve(okJson([]));
    });
    const { result } = renderHook(() => useStackHealthScope(baseArgs({
      scope: 'all-nodes',
      stackStatuses: { 'local.yml': { status: 'running' } },
    })));
    await flush();
    expect(result.current.view).toBe('ready');
    expect(result.current.incomplete).toBe(true);
    expect(result.current.coverage.k).toBe(2);
    expect(result.current.coverage.m).toBe(3);
    const okBefore = countCalls('/stacks/statuses', 2);
    const badBefore = countCalls('/stacks/statuses', 3);
    act(() => { result.current.retryFailedOrStale(); });
    await flush();
    expect(countCalls('/stacks/statuses', 2)).toBe(okBefore);
    expect(countCalls('/stacks/statuses', 3)).toBeGreaterThan(badBefore);
  });

  it('marks retained remote status rows stale after a later failure', async () => {
    const resolvers: Array<(r: Response) => void> = [];
    useNodesMock.mockReturnValue({ activeNode: local, nodes: [local, remote] });
    apiFetchMock.mockImplementation((endpoint: string, opts?: { nodeId?: number }) => {
      if (endpoint === '/stacks/statuses' && opts?.nodeId === 2) {
        return new Promise<Response>((resolve) => { resolvers.push(resolve); });
      }
      if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({}));
      return Promise.resolve(okJson([]));
    });
    const { result } = renderHook(() => useStackHealthScope(baseArgs({ scope: 'all-nodes' })));
    await flush();
    await act(async () => {
      resolvers[0](okJson({ 'web.yml': { status: 'running' } }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.rows[0]?.freshness).toBe('current');

    await act(async () => { vi.advanceTimersByTime(REMOTE_STATUS_INTERVAL_MS); });
    await act(async () => {
      resolvers[1](new Response('nope', { status: 500 }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.rows[0]?.key).toBe('2:web.yml');
    expect(result.current.rows[0]?.freshness).toBe('stale');
  });

  it('polls remote statuses and metrics only while All nodes is selected', async () => {
    useNodesMock.mockReturnValue({ activeNode: local, nodes: [local, remote] });
    const { result, rerender } = renderHook(
      (props: UseStackHealthScopeArgs) => useStackHealthScope(props),
      { initialProps: baseArgs({ scope: 'all-nodes' }) },
    );
    await flush();
    const statusStart = countCalls('/stacks/statuses', 2);
    const metricsStart = countCalls('/metrics/historical', 2);
    const gitStart = countCalls('/git-sources', 2);

    await act(async () => { vi.advanceTimersByTime(REMOTE_STATUS_INTERVAL_MS); });
    expect(countCalls('/stacks/statuses', 2)).toBe(statusStart + 1);
    expect(countCalls('/metrics/historical', 2)).toBe(metricsStart);

    await act(async () => { vi.advanceTimersByTime(REMOTE_METRICS_INTERVAL_MS - REMOTE_STATUS_INTERVAL_MS); });
    expect(countCalls('/metrics/historical', 2)).toBe(metricsStart + 1);
    expect(countCalls('/git-sources', 2)).toBe(gitStart);

    rerender(baseArgs({ scope: 'this-node' }));
    await flush();
    const statusAfter = countCalls('/stacks/statuses', 2);
    await act(async () => { vi.advanceTimersByTime(REMOTE_METRICS_INTERVAL_MS); });
    expect(countCalls('/stacks/statuses', 2)).toBe(statusAfter);
    expect(result.current.showScopeControl).toBe(true);
  });

  it('rejects late remote data after that node becomes active', async () => {
    let releaseRemote: ((r: Response) => void) | null = null;
    useNodesMock.mockReturnValue({ activeNode: local, nodes: [local, remote] });
    apiFetchMock.mockImplementation((endpoint: string, opts?: { nodeId?: number }) => {
      if (endpoint === '/stacks/statuses' && opts?.nodeId === 2) {
        return new Promise<Response>((resolve) => { releaseRemote = resolve; });
      }
      return Promise.resolve(okJson({}));
    });
    const nodes = [local, remote];
    const { result, rerender } = renderHook(
      (props: { active: Node; args: UseStackHealthScopeArgs }) => {
        useNodesMock.mockReturnValue({ activeNode: props.active, nodes });
        return useStackHealthScope(props.args);
      },
      { initialProps: { active: local, args: baseArgs({ scope: 'all-nodes' }) } },
    );
    await flush();

    rerender({
      active: remote,
      args: baseArgs({
        scope: 'all-nodes',
        stackStatuses: { 'active.yml': { status: 'running' } },
      }),
    });
    await flush();
    await act(async () => {
      releaseRemote?.(okJson({ 'stale-remote.yml': { status: 'running' } }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.rows.filter((r) => r.node.id === 2).map((r) => r.file)).toEqual(['active.yml']);
    expect(result.current.rows.filter((r) => r.node.id === 2)).toHaveLength(1);
  });

  it('clears remote metrics and gitops on later facet failure', async () => {
    let metricsRound = 0;
    let gitRound = 0;
    useNodesMock.mockReturnValue({ activeNode: local, nodes: [local, remote] });
    apiFetchMock.mockImplementation((endpoint: string, opts?: { nodeId?: number }) => {
      if (endpoint === '/stacks/statuses') {
        return Promise.resolve(okJson(
          opts?.nodeId === 2 ? { 'web.yml': { status: 'running' } } : {},
        ));
      }
      if (endpoint === '/metrics/historical') {
        metricsRound += 1;
        if (metricsRound === 1) {
          return Promise.resolve(okJson([{
            container_id: 'c1',
            stack_name: 'web',
            timestamp: Date.now(),
            cpu_percent: 12,
            memory_mb: 40,
            net_rx_mb: 0,
            net_tx_mb: 0,
          }]));
        }
        return Promise.resolve(okJson({ error: 'nope' }, 500));
      }
      if (endpoint === '/git-sources') {
        gitRound += 1;
        if (gitRound === 1) {
          return Promise.resolve(okJson([{
            stack_name: 'web',
            gitopsRevision: sourceRevision('candidate_ready'),
          }]));
        }
        return Promise.resolve(okJson({ error: 'nope' }, 500));
      }
      return Promise.resolve(okJson(null));
    });

    const { result } = renderHook(() => useStackHealthScope(baseArgs({ scope: 'all-nodes' })));
    await flush();
    const web = result.current.rows.find((r) => r.file === 'web.yml');
    expect(web?.cpu).not.toBeNull();
    expect(web?.gitopsSourceState).toBeDefined();

    await act(async () => { vi.advanceTimersByTime(REMOTE_METRICS_INTERVAL_MS); });
    await flush();
    window.dispatchEvent(new CustomEvent('sencho:state-invalidate', {
      detail: { scope: 'gitops', nodeId: 2 },
    }));
    await act(async () => { vi.advanceTimersByTime(300); });
    await flush();

    const after = result.current.rows.find((r) => r.file === 'web.yml');
    expect(after?.file).toBe('web.yml');
    expect(after?.cpu).toBeNull();
    expect(after?.gitopsSourceState).toBeUndefined();
  });

  it('keeps a valid status row when remote networks are malformed', async () => {
    useNodesMock.mockReturnValue({ activeNode: local, nodes: [local, remote] });
    apiFetchMock.mockImplementation((endpoint: string, opts?: { nodeId?: number }) => {
      if (endpoint === '/stacks/statuses' && opts?.nodeId === 2) {
        return Promise.resolve(okJson({ 'web.yml': { status: 'running', networks: 'bad' } }));
      }
      if (endpoint === '/stacks/statuses') return Promise.resolve(okJson({}));
      return Promise.resolve(okJson([]));
    });
    const { result } = renderHook(() => useStackHealthScope(baseArgs({ scope: 'all-nodes' })));
    await flush();
    const web = result.current.rows.find((r) => r.file === 'web.yml');
    expect(web?.status).toBe('running');
    expect(web?.networks).toBeUndefined();
  });

  it('ignores a missing invalidate nodeId', async () => {
    useNodesMock.mockReturnValue({ activeNode: remote, nodes: [local, remote] });
    const { result } = renderHook(() => useStackHealthScope(baseArgs({ scope: 'all-nodes' })));
    await flush();
    const before = countCalls('/stacks/statuses', 1);
    act(() => {
      window.dispatchEvent(new CustomEvent('sencho:state-invalidate', {
        detail: { scope: 'container' },
      }));
    });
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(countCalls('/stacks/statuses', 1)).toBe(before);
    expect(result.current.rows.some((r) => r.node.id === 2 && r.file === 'web.yml')).toBe(false);
  });
});
