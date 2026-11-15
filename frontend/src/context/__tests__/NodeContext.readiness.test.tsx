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
      if (path === '/nodes') return Promise.resolve({ ok: true, json: async () => [LOCAL_NODE, bootstrapped(state)] });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    const { result } = renderHook(() => useNodes(), { wrapper });
    await waitFor(() => expect(result.current.nodes.find((node) => node.id === 2)?.readiness?.state).toBe('provisional'));
    const listCalls = () => apiFetch.mock.calls.filter(([path]) => path === '/nodes').length;
    const before = listCalls();

    act(() => { window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail: { scope: 'gitops' } })); });
    expect(listCalls()).toBe(before);

    state = 'ready';
    act(() => { window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail: { scope: 'node-readiness', nodeId: 2 } })); });
    await waitFor(() => expect(result.current.nodes.find((node) => node.id === 2)?.readiness?.state).toBe('ready'));
    expect(listCalls()).toBe(before + 1);
  });
});
