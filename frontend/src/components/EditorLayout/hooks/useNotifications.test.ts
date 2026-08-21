import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { useNotifications } from './useNotifications';
import type { Node } from '@/context/NodeContext';
import type { NotificationItem } from '../../dashboard/types';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  fetchForNode: vi.fn(),
}));
vi.mock('@/components/ui/toast-store', () => ({ toast: { error: vi.fn() } }));

import { apiFetch, fetchForNode } from '@/lib/api';

const localNode: Node = { id: 1, name: 'Local', type: 'local', api_url: '', compose_dir: '', is_default: true, status: 'online', created_at: 0 };

const makeRemoteNode = (status: Node['status'], overrides: Partial<Node> = {}): Node => ({
  id: 2, name: 'Remote', type: 'remote', mode: 'proxy', api_url: '', compose_dir: '', is_default: false, status, created_at: 0, ...overrides,
});

const makeNotif = (overrides: Partial<NotificationItem> = {}): NotificationItem => ({
  id: 1, level: 'info', message: 'test', timestamp: 1000, is_read: 0, ...overrides,
});

const nodeMessageKeys = (items: NotificationItem[]): string[] =>
  items.map((n) => `${n.nodeId}:${n.message}`).sort();

class MockWS {
  static instances: MockWS[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  readyState = 1; // OPEN
  send = vi.fn();
  close = vi.fn();
  constructor() { MockWS.instances.push(this); }
  static reset() { MockWS.instances = []; }
}

beforeEach(() => {
  MockWS.reset();
  vi.stubGlobal('WebSocket', MockWS);
  (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, json: async () => [] });
  (fetchForNode as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, json: async () => [] });
});
afterEach(() => { 
  vi.unstubAllGlobals(); 
  vi.clearAllMocks(); 
});

describe('useNotifications', () => {
  let originalError: typeof console.error;

  beforeAll(() => {
    originalError = console.error;
    console.error = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].includes('was not wrapped in act')) {
        return;
      }
      originalError.call(console, ...args);
    };
  });

  afterAll(() => {
    console.error = originalError;
  });

  it('starts with empty notifications and disconnected state', () => {
    const { result } = renderHook(() =>
      useNotifications({ nodes: [localNode], onStateInvalidate: vi.fn(), onImageUpdatesChange: vi.fn(), onGitOpsChange: vi.fn() }),
    );
    expect(result.current.notifications).toEqual([]);
    expect(result.current.tickerConnected).toBe(false);
  });

  it('opens a local notification WebSocket on mount', () => {
    renderHook(() =>
      useNotifications({ nodes: [localNode], onStateInvalidate: vi.fn(), onImageUpdatesChange: vi.fn(), onGitOpsChange: vi.fn() }),
    );
    expect(MockWS.instances.length).toBeGreaterThanOrEqual(1);
    expect(MockWS.instances[0]).toBeDefined();
  });

  it('sets tickerConnected true when local WS opens', () => {
    const { result } = renderHook(() =>
      useNotifications({ nodes: [localNode], onStateInvalidate: vi.fn(), onImageUpdatesChange: vi.fn(), onGitOpsChange: vi.fn() }),
    );
    act(() => { MockWS.instances[0]?.onopen?.(); });
    expect(result.current.tickerConnected).toBe(true);
  });

  it('adds notification when local WS receives notification message', () => {
    const { result } = renderHook(() =>
      useNotifications({ nodes: [localNode], onStateInvalidate: vi.fn(), onImageUpdatesChange: vi.fn(), onGitOpsChange: vi.fn() }),
    );
    act(() => { MockWS.instances[0]?.onopen?.(); });
    act(() => {
      MockWS.instances[0]?.onmessage?.({
        data: JSON.stringify({ type: 'notification', payload: makeNotif({ id: 42, message: 'hello' }) }),
      });
    });
    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.notifications[0].message).toBe('hello');
  });

  it('clearAllNotifications empties the local state', async () => {
    const { result } = renderHook(() =>
      useNotifications({ nodes: [localNode], onStateInvalidate: vi.fn(), onImageUpdatesChange: vi.fn(), onGitOpsChange: vi.fn() }),
    );
    act(() => { MockWS.instances[0]?.onopen?.(); });
    act(() => {
      MockWS.instances[0]?.onmessage?.({
        data: JSON.stringify({ type: 'notification', payload: makeNotif({ id: 1 }) }),
      });
    });
    expect(result.current.notifications).toHaveLength(1);
    act(() => { result.current.clearAllNotifications(); });
    await waitFor(() => expect(result.current.notifications).toHaveLength(0));
  });

  it('fires onImageUpdatesChange on state-invalidate with action="stack-updated"', () => {
    const onStateInvalidate = vi.fn();
    const onImageUpdatesChange = vi.fn();
    renderHook(() =>
      useNotifications({ nodes: [localNode], onStateInvalidate, onImageUpdatesChange, onGitOpsChange: vi.fn() }),
    );
    act(() => { MockWS.instances[0]?.onopen?.(); });
    act(() => {
      MockWS.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'state-invalidate', scope: 'image-updates', nodeId: 1,
          stackName: 'foo', action: 'stack-updated', ts: 1000,
        }),
      });
    });
    expect(onImageUpdatesChange).toHaveBeenCalledTimes(1);
    expect(onStateInvalidate).toHaveBeenCalledTimes(1);
  });

  it('fires onImageUpdatesChange on update-status-reconciled', () => {
    const onImageUpdatesChange = vi.fn();
    renderHook(() =>
      useNotifications({ nodes: [localNode], onStateInvalidate: vi.fn(), onImageUpdatesChange, onGitOpsChange: vi.fn() }),
    );
    act(() => { MockWS.instances[0]?.onopen?.(); });
    act(() => {
      MockWS.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'state-invalidate', scope: 'image-updates', nodeId: 1,
          stackName: 'foo', action: 'update-status-reconciled', ts: 1000,
        }),
      });
    });
    expect(onImageUpdatesChange).toHaveBeenCalledTimes(1);
  });

  it('ignores unrelated image-updates actions for the refresh callback', () => {
    const onImageUpdatesChange = vi.fn();
    renderHook(() =>
      useNotifications({ nodes: [localNode], onStateInvalidate: vi.fn(), onImageUpdatesChange, onGitOpsChange: vi.fn() }),
    );
    act(() => { MockWS.instances[0]?.onopen?.(); });
    act(() => {
      MockWS.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'state-invalidate', scope: 'image-updates', nodeId: 1,
          stackName: 'foo', action: 'other', ts: 1000,
        }),
      });
    });
    expect(onImageUpdatesChange).not.toHaveBeenCalled();
  });

  it('does not fire onImageUpdatesChange on a generic state-invalidate', () => {
    const onStateInvalidate = vi.fn();
    const onImageUpdatesChange = vi.fn();
    renderHook(() =>
      useNotifications({ nodes: [localNode], onStateInvalidate, onImageUpdatesChange, onGitOpsChange: vi.fn() }),
    );
    act(() => { MockWS.instances[0]?.onopen?.(); });
    act(() => {
      MockWS.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'state-invalidate', scope: 'stack', nodeId: 1,
          stackName: 'foo', action: 'start', ts: 1000,
        }),
      });
    });
    expect(onStateInvalidate).toHaveBeenCalledTimes(1);
    expect(onImageUpdatesChange).not.toHaveBeenCalled();
  });

  it('fires onGitOpsChange for any gitops stage on the local socket', () => {
    const onGitOpsChange = vi.fn();
    renderHook(() =>
      useNotifications({
        nodes: [localNode],
        onStateInvalidate: vi.fn(), onImageUpdatesChange: vi.fn(), onGitOpsChange,
      }),
    );
    act(() => { MockWS.instances[0]?.onopen?.(); });
    // Two unrelated stages. Unlike image updates there is no action filter, so
    // both count: any transition can move the state the surfaces derive.
    act(() => {
      MockWS.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'state-invalidate', scope: 'gitops', action: 'fetch_started',
          applicationId: 'app-1', targetMode: 'direct', stackName: 'foo',
          blueprintId: null, nodeId: 1, ts: 1000,
        }),
      });
      MockWS.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'state-invalidate', scope: 'gitops', action: 'applied',
          applicationId: 'app-1', targetMode: 'direct', stackName: 'foo',
          blueprintId: null, nodeId: 1, ts: 1001,
        }),
      });
    });
    expect(onGitOpsChange).toHaveBeenCalledTimes(2);
  });

  it('does not fire onGitOpsChange for another scope', () => {
    const onGitOpsChange = vi.fn();
    renderHook(() =>
      useNotifications({
        nodes: [localNode],
        onStateInvalidate: vi.fn(), onImageUpdatesChange: vi.fn(), onGitOpsChange,
      }),
    );
    act(() => { MockWS.instances[0]?.onopen?.(); });
    act(() => {
      MockWS.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'state-invalidate', scope: 'stack', nodeId: 1,
          stackName: 'foo', action: 'start', ts: 1000,
        }),
      });
    });
    expect(onGitOpsChange).not.toHaveBeenCalled();
  });

  it('fires onGitOpsChange for a remote node transition', async () => {
    const onGitOpsChange = vi.fn();
    const remote = makeRemoteNode('online', { id: 2 });
    renderHook(() =>
      useNotifications({
        nodes: [localNode, remote],
        onStateInvalidate: vi.fn(), onImageUpdatesChange: vi.fn(), onGitOpsChange,
      }),
    );
    await waitFor(() => expect(MockWS.instances).toHaveLength(2));
    act(() => { MockWS.instances[1]?.onopen?.(); });
    act(() => {
      MockWS.instances[1]?.onmessage?.({
        data: JSON.stringify({
          type: 'state-invalidate', scope: 'gitops', action: 'deploy_started',
          applicationId: 'app-2', targetMode: 'direct', stackName: 'bar',
          // The remote's own numbering, which the hub never adopts.
          blueprintId: null, nodeId: 7, ts: 1000,
        }),
      });
    });
    expect(onGitOpsChange).toHaveBeenCalledTimes(1);
  });

  it('deleteNotification removes the matching item', async () => {
    const { result } = renderHook(() =>
      useNotifications({ nodes: [localNode], onStateInvalidate: vi.fn(), onImageUpdatesChange: vi.fn(), onGitOpsChange: vi.fn() }),
    );
    act(() => { MockWS.instances[0]?.onopen?.(); });
    const notif = makeNotif({ id: 5, nodeId: localNode.id });
    act(() => {
      MockWS.instances[0]?.onmessage?.({
        data: JSON.stringify({ type: 'notification', payload: notif }),
      });
    });
    act(() => { result.current.deleteNotification({ ...notif, nodeId: localNode.id }); });
    await waitFor(() => expect(result.current.notifications).toHaveLength(0));
  });

  it('does not open a WS or poll an offline remote node', async () => {
    renderHook(() =>
      useNotifications({ nodes: [localNode, makeRemoteNode('offline')], onStateInvalidate: vi.fn(), onImageUpdatesChange: vi.fn(), onGitOpsChange: vi.fn() }),
    );
    // Only the local notification socket is created; the offline node is skipped.
    expect(MockWS.instances).toHaveLength(1);
    // The mount poll never targets the offline node either.
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(fetchForNode).not.toHaveBeenCalled();
  });

  it('opens a WS and polls an online remote node', async () => {
    renderHook(() =>
      useNotifications({ nodes: [localNode, makeRemoteNode('online')], onStateInvalidate: vi.fn(), onImageUpdatesChange: vi.fn(), onGitOpsChange: vi.fn() }),
    );
    // Local socket plus a per-node socket for the online remote.
    expect(MockWS.instances).toHaveLength(2);
    await waitFor(() => expect(fetchForNode).toHaveBeenCalledWith('/notifications', 2));
  });

  it('stamps roster nodeName on remote REST notifications without rewriting the body', async () => {
    const remote = makeRemoteNode('online', { id: 2, name: 'sencho-sat-qa' });
    const neutralBody =
      'Scheduled task "qa-missing-container" (restart) failed: Container "web" not found on this node. It may have been renamed or removed.';
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => [] });
    (fetchForNode as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [{ id: 9, level: 'error', message: neutralBody, timestamp: 2000, is_read: 0 }],
    });

    const { result } = renderHook(() =>
      useNotifications({ nodes: [localNode, remote], onStateInvalidate: vi.fn(), onImageUpdatesChange: vi.fn(), onGitOpsChange: vi.fn() }),
    );

    await waitFor(() => expect(result.current.notifications).toHaveLength(1));
    expect(result.current.notifications[0].message).toBe(neutralBody);
    expect(result.current.notifications[0].nodeId).toBe(2);
    expect(result.current.notifications[0].nodeName).toBe('sencho-sat-qa');
    expect(result.current.notifications[0].message).not.toMatch(/\[Node:|Local/);
  });

  it('subscribes to the online node and skips the offline one in a mixed fleet', async () => {
    renderHook(() =>
      useNotifications({
        nodes: [localNode, makeRemoteNode('online', { id: 2 }), makeRemoteNode('offline', { id: 3, name: 'Dead' })],
        onStateInvalidate: vi.fn(), onImageUpdatesChange: vi.fn(), onGitOpsChange: vi.fn(),
      }),
    );
    // Local + online remote only; the offline node gets no socket.
    expect(MockWS.instances).toHaveLength(2);
    await waitFor(() => expect(fetchForNode).toHaveBeenCalledWith('/notifications', 2));
    expect(fetchForNode).not.toHaveBeenCalledWith('/notifications', 3);
  });

  it('closes the socket when a subscribed node transitions to offline', () => {
    const { rerender } = renderHook(
      ({ nodes }) => useNotifications({ nodes, onStateInvalidate: vi.fn(), onImageUpdatesChange: vi.fn(), onGitOpsChange: vi.fn() }),
      { initialProps: { nodes: [localNode, makeRemoteNode('online')] } },
    );
    // instances[0] is the local socket; instances[1] is the online remote's socket.
    expect(MockWS.instances).toHaveLength(2);
    const remoteWs = MockWS.instances[1];

    // Flip the node to offline: it leaves the active set, so the cleanup loop
    // must close its socket rather than reconnect to a dead node forever.
    act(() => { rerender({ nodes: [localNode, makeRemoteNode('offline')] }); });
    expect(remoteWs.close).toHaveBeenCalled();
  });

  it('still subscribes to and polls a remote node with unknown status', async () => {
    renderHook(() =>
      useNotifications({ nodes: [localNode, makeRemoteNode('unknown')], onStateInvalidate: vi.fn(), onImageUpdatesChange: vi.fn(), onGitOpsChange: vi.fn() }),
    );
    // 'unknown' is not yet probed, so it is treated as reachable (not filtered out)
    // on both the WS and the REST-poll surfaces.
    expect(MockWS.instances).toHaveLength(2);
    await waitFor(() => expect(fetchForNode).toHaveBeenCalledWith('/notifications', 2));
  });

  it('removeNotificationsForStack drops only the matching node and stack', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => [] });
    const remote = makeRemoteNode('online', { id: 2, name: 'Remote-B' });
    const { result } = renderHook(() =>
      useNotifications({ nodes: [localNode, remote], onStateInvalidate: vi.fn(), onImageUpdatesChange: vi.fn(), onGitOpsChange: vi.fn() }),
    );
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());

    act(() => {
      MockWS.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'notification',
          payload: makeNotif({ id: 1, stack_name: 'web', message: 'a-web' }),
        }),
      });
      MockWS.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'notification',
          payload: makeNotif({ id: 2, stack_name: 'db', message: 'a-db' }),
        }),
      });
      MockWS.instances[1]?.onmessage?.({
        data: JSON.stringify({
          type: 'notification',
          payload: makeNotif({ id: 3, stack_name: 'web', message: 'b-web' }),
        }),
      });
      MockWS.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'notification',
          payload: makeNotif({ id: 4, message: 'a-unattached' }),
        }),
      });
    });

    expect(result.current.notifications).toHaveLength(4);

    act(() => {
      result.current.removeNotificationsForStack(localNode.id, 'web');
    });

    expect(result.current.notifications.map((n) => `${n.nodeId}:${n.stack_name ?? ''}:${n.message}`).sort()).toEqual([
      '1::a-unattached',
      '1:db:a-db',
      '2:web:b-web',
    ]);

    act(() => {
      result.current.removeNotificationsForStack(localNode.id, 'web');
    });
    expect(result.current.notifications).toHaveLength(3);
  });

  it('refetches notifications on scope=notifications invalidate after mount fetch', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => [] });
    const nodes = [localNode];
    const onStateInvalidate = vi.fn();
    const onImageUpdatesChange = vi.fn();
    renderHook(() =>
      useNotifications({ nodes, onStateInvalidate, onImageUpdatesChange, onGitOpsChange: vi.fn() }),
    );
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const afterMount = (apiFetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === '/notifications',
    ).length;

    act(() => {
      MockWS.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'state-invalidate',
          scope: 'notifications',
          // No stack-deleted action: this case only asserts refetch delta.
          nodeId: 1,
          ts: 1000,
        }),
      });
    });

    await waitFor(() => {
      const after = (apiFetch as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === '/notifications',
      ).length;
      expect(after).toBe(afterMount + 1);
    });
  });

  it('remote notifications invalidate triggers one additional remote fetch', async () => {
    const remote = makeRemoteNode('online', { id: 2, name: 'sencho-sat-qa' });
    const nodes = [localNode, remote];
    const onStateInvalidate = vi.fn();
    const onImageUpdatesChange = vi.fn();
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => [] });
    (fetchForNode as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [{ id: 9, level: 'error', message: 'remote row', timestamp: 2000, is_read: 0, stack_name: 'db' }],
    });

    const { result } = renderHook(() =>
      useNotifications({ nodes, onStateInvalidate, onImageUpdatesChange, onGitOpsChange: vi.fn() }),
    );
    await waitFor(() => expect(fetchForNode).toHaveBeenCalledWith('/notifications', 2));
    const afterMount = (fetchForNode as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === '/notifications' && c[1] === 2,
    ).length;

    act(() => {
      MockWS.instances[1]?.onmessage?.({
        data: JSON.stringify({
          type: 'state-invalidate',
          scope: 'notifications',
          nodeId: 2,
          ts: 1000,
        }),
      });
    });

    await waitFor(() => {
      const after = (fetchForNode as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === '/notifications' && c[1] === 2,
      ).length;
      expect(after).toBe(afterMount + 1);
    });
    await waitFor(() => expect(result.current.notifications.some((n) => n.nodeId === 2 && n.nodeName === 'sencho-sat-qa')).toBe(true));
  });

  it('unrelated state-invalidate scopes do not refetch notifications', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => [] });
    const nodes = [localNode];
    renderHook(() =>
      useNotifications({ nodes, onStateInvalidate: vi.fn(), onImageUpdatesChange: vi.fn(), onGitOpsChange: vi.fn() }),
    );
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const afterMount = (apiFetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === '/notifications',
    ).length;

    act(() => {
      MockWS.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'state-invalidate',
          scope: 'stack',
          nodeId: 1,
          stackName: 'web',
          action: 'start',
          ts: 1000,
        }),
      });
    });

    expect(
      (apiFetch as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === '/notifications').length,
    ).toBe(afterMount);
  });

  it('remote stack-deleted purge uses hub rn.id when payload nodeId collides with local', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => [] });
    (fetchForNode as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => [] });
    const remote = makeRemoteNode('online', { id: 7, name: 'Remote-7' });
    const nodes = [localNode, remote];
    const { result } = renderHook(() =>
      useNotifications({ nodes, onStateInvalidate: vi.fn(), onImageUpdatesChange: vi.fn(), onGitOpsChange: vi.fn() }),
    );
    await waitFor(() => expect(fetchForNode).toHaveBeenCalledWith('/notifications', 7));

    act(() => {
      MockWS.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'notification',
          payload: makeNotif({ id: 1, stack_name: 'web', message: 'local-web' }),
        }),
      });
      MockWS.instances[1]?.onmessage?.({
        data: JSON.stringify({
          type: 'notification',
          payload: makeNotif({ id: 2, stack_name: 'web', message: 'remote-web' }),
        }),
      });
    });
    expect(nodeMessageKeys(result.current.notifications)).toEqual(['1:local-web', '7:remote-web']);

    // Production remotes broadcast their own local DB id (often 1), which collides
    // with the hub local node. The remote socket must purge hub rn.id=7 only.
    act(() => {
      MockWS.instances[1]?.onmessage?.({
        data: JSON.stringify({
          type: 'state-invalidate',
          scope: 'notifications',
          action: 'stack-deleted',
          nodeId: 1,
          stackName: 'web',
          ts: Date.now(),
        }),
      });
    });

    expect(nodeMessageKeys(result.current.notifications)).toEqual(['1:local-web']);
  });

  it('preserves cached notifications for a failed refetch leg after invalidate', async () => {
    const remote = makeRemoteNode('online', { id: 7, name: 'Remote-7' });
    // Stable identity so the nodes effect does not re-fetch on every render.
    const nodes = [localNode, remote];
    let remoteFail = false;
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [
        { id: 10, level: 'info', message: 'local-kept', timestamp: 5000, is_read: 0, stack_name: 'other' },
      ],
    });
    (fetchForNode as ReturnType<typeof vi.fn>).mockImplementation(() => {
      if (remoteFail) {
        return Promise.resolve({ ok: false, status: 502, json: async () => [] });
      }
      return Promise.resolve({
        ok: true,
        json: async () => [
          { id: 20, level: 'error', message: 'remote-web', timestamp: 4000, is_read: 0, stack_name: 'web' },
          { id: 21, level: 'info', message: 'remote-db', timestamp: 3000, is_read: 0, stack_name: 'db' },
        ],
      });
    });

    const { result } = renderHook(() =>
      useNotifications({ nodes, onStateInvalidate: vi.fn(), onImageUpdatesChange: vi.fn(), onGitOpsChange: vi.fn() }),
    );
    await waitFor(() => expect(result.current.notifications.some((n) => n.message === 'remote-web')).toBe(true));
    expect(nodeMessageKeys(result.current.notifications)).toEqual([
      '1:local-kept',
      '7:remote-db',
      '7:remote-web',
    ]);

    remoteFail = true;
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [
        { id: 11, level: 'info', message: 'local-kept-v2', timestamp: 6000, is_read: 0, stack_name: 'other' },
      ],
    });

    act(() => {
      MockWS.instances[1]?.onmessage?.({
        data: JSON.stringify({
          type: 'state-invalidate',
          scope: 'notifications',
          action: 'stack-deleted',
          nodeId: 1,
          stackName: 'web',
          ts: Date.now(),
        }),
      });
    });

    // Wait for post-invalidate merge (local slice replaced), not only optimistic purge.
    await waitFor(() => {
      expect(result.current.notifications.some((n) => n.message === 'local-kept-v2')).toBe(true);
    });
    expect(result.current.notifications.some((n) => n.message === 'remote-web')).toBe(false);
    expect(nodeMessageKeys(result.current.notifications)).toEqual([
      '1:local-kept-v2',
      '7:remote-db',
    ]);
  });

  it('does not restore a deleted stack notification from a stale pre-removal fetch', async () => {
    let resolveStale!: (value: { ok: boolean; status: number; json: () => Promise<unknown[]> }) => void;
    const stalePromise = new Promise<{ ok: boolean; status: number; json: () => Promise<unknown[]> }>((resolve) => {
      resolveStale = resolve;
    });
    let call = 0;
    let releaseStale = false;
    (apiFetch as ReturnType<typeof vi.fn>).mockImplementation(() => {
      call += 1;
      if (!releaseStale && call >= 2) return stalePromise;
      if (releaseStale) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [
            { id: 2, level: 'info', message: 'fresh-db', timestamp: 4000, is_read: 0, stack_name: 'db' },
          ],
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => [] });
    });

    // Stable identity so the nodes effect does not re-fetch on every render.
    const nodes = [localNode];
    const onStateInvalidate = vi.fn();
    const onImageUpdatesChange = vi.fn();
    const { result } = renderHook(() =>
      useNotifications({ nodes, onStateInvalidate, onImageUpdatesChange, onGitOpsChange: vi.fn() }),
    );
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const afterMount = call;

    act(() => {
      MockWS.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'notification',
          payload: makeNotif({ id: 1, stack_name: 'web', message: 'keep-until-remove' }),
        }),
      });
    });
    expect(result.current.notifications.some((n) => n.stack_name === 'web')).toBe(true);

    // Start an in-flight fetch without act: React's act waits on the deferred promise.
    MockWS.instances[0]?.onmessage?.({
      data: JSON.stringify({
        type: 'state-invalidate',
        scope: 'notifications',
        action: 'stack-deleted',
        nodeId: 1,
        stackName: 'other',
        ts: Date.now(),
      }),
    });
    await waitFor(() => expect(call).toBeGreaterThan(afterMount));

    act(() => {
      result.current.removeNotificationsForStack(localNode.id, 'web');
    });
    expect(result.current.notifications.some((n) => n.stack_name === 'web')).toBe(false);

    resolveStale({
      ok: true,
      status: 200,
      json: async () => [
        { id: 1, level: 'error', message: 'stale-web', timestamp: 3000, is_read: 0, stack_name: 'web' },
      ],
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.notifications.some((n) => n.stack_name === 'web')).toBe(false);

    releaseStale = true;
    act(() => {
      MockWS.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'state-invalidate',
          scope: 'notifications',
          action: 'stack-deleted',
          nodeId: 1,
          stackName: 'web',
          ts: Date.now(),
        }),
      });
    });

    await waitFor(() => {
      expect(result.current.notifications.some((n) => n.stack_name === 'db' && n.message === 'fresh-db')).toBe(true);
    });
    expect(result.current.notifications.some((n) => n.stack_name === 'web')).toBe(false);
  });
});
