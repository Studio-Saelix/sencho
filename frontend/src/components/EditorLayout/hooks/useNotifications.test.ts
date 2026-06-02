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

import { apiFetch } from '@/lib/api';

const localNode: Node = { id: 1, name: 'Local', type: 'local', api_url: '', compose_dir: '', is_default: true, status: 'online', created_at: 0 };

const makeNotif = (overrides: Partial<NotificationItem> = {}): NotificationItem => ({
  id: 1, level: 'info', message: 'test', timestamp: 1000, is_read: 0, ...overrides,
});

class MockWS {
  static instances: MockWS[] = [];
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
      useNotifications({ nodes: [localNode], onStateInvalidate: vi.fn(), onImageUpdatesChange: vi.fn() }),
    );
    expect(result.current.notifications).toEqual([]);
    expect(result.current.tickerConnected).toBe(false);
  });

  it('opens a local notification WebSocket on mount', () => {
    renderHook(() =>
      useNotifications({ nodes: [localNode], onStateInvalidate: vi.fn(), onImageUpdatesChange: vi.fn() }),
    );
    expect(MockWS.instances.length).toBeGreaterThanOrEqual(1);
    expect(MockWS.instances[0]).toBeDefined();
  });

  it('sets tickerConnected true when local WS opens', () => {
    const { result } = renderHook(() =>
      useNotifications({ nodes: [localNode], onStateInvalidate: vi.fn(), onImageUpdatesChange: vi.fn() }),
    );
    act(() => { MockWS.instances[0]?.onopen?.(); });
    expect(result.current.tickerConnected).toBe(true);
  });

  it('adds notification when local WS receives notification message', () => {
    const { result } = renderHook(() =>
      useNotifications({ nodes: [localNode], onStateInvalidate: vi.fn(), onImageUpdatesChange: vi.fn() }),
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
      useNotifications({ nodes: [localNode], onStateInvalidate: vi.fn(), onImageUpdatesChange: vi.fn() }),
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
      useNotifications({ nodes: [localNode], onStateInvalidate, onImageUpdatesChange }),
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

  it('does not fire onImageUpdatesChange on a generic state-invalidate', () => {
    const onStateInvalidate = vi.fn();
    const onImageUpdatesChange = vi.fn();
    renderHook(() =>
      useNotifications({ nodes: [localNode], onStateInvalidate, onImageUpdatesChange }),
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

  it('deleteNotification removes the matching item', async () => {
    const { result } = renderHook(() =>
      useNotifications({ nodes: [localNode], onStateInvalidate: vi.fn(), onImageUpdatesChange: vi.fn() }),
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
});
