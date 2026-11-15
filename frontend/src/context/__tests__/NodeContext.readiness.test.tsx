import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { NodeProvider, useNodes } from '../NodeContext';

const apiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (path: string, opts?: unknown) => apiFetch(path, opts),
}));

const LOCAL_NODE = { id: 1, name: 'local', type: 'local' as const, compose_dir: '/compose', is_default: true, status: 'online' as const, created_at: 0, readiness: null };

function bootstrapped(state: 'provisional' | 'ready') {
  return { id: 2, name: 'media', type: 'remote' as const, compose_dir: '/opt/docker/sencho', is_default: false, status: 'online' as const, created_at: 0,
    readiness: { state, checkedAt: null, operationId: 'op-1', operationState: 'enrolled' as const } };
}

function wrapper({ children }: { children: ReactNode }) {
  return <NodeProvider>{children}</NodeProvider>;
}

describe('NodeContext readiness refresh', () => {
  beforeEach(() => {
    localStorage.clear();
    apiFetch.mockReset();
  });

  it('refetches the node list when the hub announces a changed readiness verdict, and only then', async () => {
    let state: 'provisional' | 'ready' = 'provisional';
    apiFetch.mockImplementation((path: string) => {
      if (path === '/nodes') return Promise.resolve({ ok: true, json: async () => [{ ...LOCAL_NODE }, bootstrapped(state)] });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    const { result } = renderHook(() => useNodes(), { wrapper });
    await waitFor(() => expect(result.current.nodes.find((node) => node.id === 2)?.readiness?.state).toBe('provisional'));
    const listCalls = () => apiFetch.mock.calls.filter(([path]) => path === '/nodes').length;
    const before = listCalls();

    act(() => { window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail: { scope: 'gitops' } })); });
    expect(listCalls()).toBe(before);

    const activeBefore = result.current.activeNode;
    state = 'ready';
    // Two announcements inside one window: one refetch.
    act(() => {
      window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail: { scope: 'node-readiness', nodeId: 2 } }));
      window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail: { scope: 'node-readiness', nodeId: 2 } }));
    });
    await waitFor(() => expect(result.current.nodes.find((node) => node.id === 2)?.readiness?.state).toBe('ready'), { timeout: 3000 });
    expect(listCalls()).toBe(before + 1);
    // Another node's readiness changed; the active local node is the same object, so its effects do not rerun.
    expect(result.current.activeNode).toBe(activeBefore);

    // A later announcement, after the window closed, refetches again.
    state = 'provisional';
    act(() => { window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail: { scope: 'node-readiness', nodeId: 2 } })); });
    await waitFor(() => expect(result.current.nodes.find((node) => node.id === 2)?.readiness?.state).toBe('provisional'), { timeout: 3000 });
    expect(listCalls()).toBe(before + 2);
  });
  it('ignores a node list that arrives after a newer one, so a replaced verdict does not come back', async () => {
    const pending: Array<(state: 'provisional' | 'ready') => void> = [];
    let first = true;
    apiFetch.mockImplementation((path: string) => {
      if (path !== '/nodes') return Promise.resolve({ ok: true, json: async () => ({}) });
      if (first) {
        first = false;
        return Promise.resolve({ ok: true, json: async () => [{ ...LOCAL_NODE }, bootstrapped('provisional')] });
      }
      return new Promise((resolve) => {
        pending.push((state) => resolve({ ok: true, json: async () => [{ ...LOCAL_NODE }, bootstrapped(state)] }));
      });
    });
    const { result } = renderHook(() => useNodes(), { wrapper });
    await waitFor(() => expect(result.current.nodes.find((node) => node.id === 2)?.readiness?.state).toBe('provisional'));

    // Two refetches start; the older one answers last with a verdict the newer one already replaced.
    act(() => { window.dispatchEvent(new Event('node-not-found')); });
    act(() => { window.dispatchEvent(new Event('node-not-found')); });
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => { pending[1]('provisional'); });
    await act(async () => { pending[0]('ready'); });
    expect(result.current.nodes.find((node) => node.id === 2)?.readiness?.state).toBe('provisional');
  });
});
