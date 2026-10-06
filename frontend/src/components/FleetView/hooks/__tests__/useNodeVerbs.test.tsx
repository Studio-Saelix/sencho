import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const apiFetchMock = vi.fn();
const useAuthMock = vi.fn();
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => useAuthMock() }));
vi.mock('@/components/ui/toast-store', () => ({ toast: toastMock }));

import { useNodeVerbs, type NodeVerbHandlers } from '../useNodeVerbs';
import { GITOPS_PORTFOLIO_SCOPE_EVENT } from '@/components/gitops/portfolio/portfolioNavigation';
import type { NodeVerb } from '../../nodeStatus';
import type { FleetNode } from '../../types';

const NODE: FleetNode = {
  id: 2, name: 'Edge', type: 'remote', status: 'offline', stats: null, systemStats: null, stacks: null,
  cordoned: false, cordoned_at: null, cordoned_reason: null,
};
const TEST: NodeVerb = { id: 'test-connection', label: 'Test connection' };

function setup(handlers: NodeVerbHandlers = {}, openCordon = vi.fn()) {
  return { openCordon, ...renderHook(() => useNodeVerbs({ node: NODE, handlers, openCordon })) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  useAuthMock.mockReturnValue({ isAdmin: true, can: vi.fn(() => true) });
});
afterEach(() => vi.clearAllMocks());

describe('useNodeVerbs permissions', () => {
  it('scopes manage verbs to node:manage on this node and keeps update verbs admin-only', () => {
    const can = vi.fn((action: string) => action === 'node:manage');
    useAuthMock.mockReturnValue({ isAdmin: false, can });
    const { result } = setup({ onUpdate: vi.fn(), onRetryUpdate: vi.fn() });
    expect(can).toHaveBeenCalledWith('node:manage', 'node', '2');
    expect(result.current.isAllowed(TEST)).toBe(true);
    expect(result.current.isAllowed({ id: 'uncordon', label: 'Uncordon node' })).toBe(true);
    expect(result.current.isAllowed({ id: 'update', label: 'Update' })).toBe(false);
    expect(result.current.isAllowed({ id: 'retry-update', label: 'Retry update' })).toBe(false);
  });

  it('offers network and update verbs only when the shell supplied a handler', () => {
    const none = setup();
    expect(none.result.current.isAllowed({ id: 'view-networking', label: 'View networking' })).toBe(false);
    expect(none.result.current.isAllowed({ id: 'update', label: 'Update' })).toBe(false);
    const some = setup({ onUpdate: vi.fn(), onOpenNetworking: vi.fn() });
    expect(some.result.current.isAllowed({ id: 'view-networking', label: 'View networking' })).toBe(true);
    expect(some.result.current.isAllowed({ id: 'update', label: 'Update' })).toBe(true);
  });

  it('does nothing when asked to run a verb the session may not run', () => {
    useAuthMock.mockReturnValue({ isAdmin: false, can: vi.fn(() => false) });
    const { result, openCordon } = setup();
    act(() => result.current.run({ id: 'uncordon', label: 'Uncordon node' }));
    act(() => result.current.run(TEST));
    expect(openCordon).not.toHaveBeenCalled();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('useNodeVerbs running', () => {
  it('runs each verb through its shared handler', () => {
    const handlers = { onUpdate: vi.fn(), onRetryUpdate: vi.fn(), onOpenNetworking: vi.fn() };
    const { result, openCordon } = setup(handlers);
    act(() => result.current.run({ id: 'update', label: 'Update' }));
    act(() => result.current.run({ id: 'update-dev', label: 'Update dev build' }));
    act(() => result.current.run({ id: 'retry-update', label: 'Retry update' }));
    act(() => result.current.run({ id: 'view-networking', label: 'View networking' }));
    act(() => result.current.run({ id: 'uncordon', label: 'Uncordon node' }));
    expect(handlers.onUpdate).toHaveBeenCalledTimes(2);
    expect(handlers.onUpdate).toHaveBeenCalledWith(2);
    expect(handlers.onRetryUpdate).toHaveBeenCalledWith(2);
    expect(handlers.onOpenNetworking).toHaveBeenCalledWith(2);
    expect(openCordon).toHaveBeenCalledTimes(1);
  });

  it('opens the GitOps applications needing attention on this node', () => {
    const scopes: unknown[] = [];
    const onScope = (e: Event) => scopes.push((e as CustomEvent).detail);
    window.addEventListener(GITOPS_PORTFOLIO_SCOPE_EVENT, onScope);
    try {
      const { result } = setup();
      act(() => result.current.run({ id: 'open-gitops', label: 'Open GitOps' }));
    } finally {
      window.removeEventListener(GITOPS_PORTFOLIO_SCOPE_EVENT, onScope);
    }
    expect(scopes).toEqual([{ nodeId: 2, attention: true }]);
  });

  it('reports pending only for an update verb on the node being updated', () => {
    const idle = setup({ updatingNodeId: 7 });
    expect(idle.result.current.isPending({ id: 'update', label: 'Update' })).toBe(false);
    const busy = setup({ updatingNodeId: 2 });
    expect(busy.result.current.isPending({ id: 'update', label: 'Update' })).toBe(true);
    expect(busy.result.current.isPending({ id: 'update-dev', label: 'Update dev build' })).toBe(true);
    expect(busy.result.current.isPending(TEST)).toBe(false);
  });
});

describe('useNodeVerbs connection test', () => {
  it('toasts success, locks the verb while it runs, and refreshes the overview after', async () => {
    let release: (r: Response) => void = () => {};
    apiFetchMock.mockImplementation(() => new Promise<Response>((res) => { release = res; }));
    const onTested = vi.fn();
    const { result } = setup({ onTested });
    act(() => result.current.run(TEST));
    await waitFor(() => expect(result.current.isPending(TEST)).toBe(true));
    await act(async () => { release(json({ success: true })); });
    await waitFor(() => expect(result.current.isPending(TEST)).toBe(false));
    expect(apiFetchMock).toHaveBeenCalledWith('/nodes/2/test', expect.objectContaining({ method: 'POST', localOnly: true }));
    expect(toastMock.success).toHaveBeenCalledWith('Connected to "Edge"');
    expect(onTested).toHaveBeenCalledTimes(1);
  });

  it('shows the backend reason when the test fails', async () => {
    apiFetchMock.mockResolvedValue(json({ success: false, error: 'Pilot agent is not connected.' }));
    const { result } = setup();
    act(() => result.current.run(TEST));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Pilot agent is not connected.'));
  });

  it('does not call the node unreachable when the hub itself refused or errored', async () => {
    apiFetchMock.mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }));
    const { result } = setup();
    act(() => result.current.run(TEST));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Connection test failed for "Edge" (502)'));
  });

  it('logs and reports a thrown request with its reason, and still refreshes the overview', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    apiFetchMock.mockRejectedValue(new Error('network down'));
    const onTested = vi.fn();
    const { result } = setup({ onTested });
    act(() => result.current.run(TEST));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Connection test failed for "Edge": network down'));
    expect(spy).toHaveBeenCalled();
    expect(onTested).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('runs without an onTested callback', async () => {
    apiFetchMock.mockResolvedValue(json({ success: true }));
    const { result } = setup();
    act(() => result.current.run(TEST));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled());
  });
});
