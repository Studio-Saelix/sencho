import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));
vi.mock('@/components/ui/toast-store', () => ({ toast: { success: vi.fn(), error: vi.fn(), loading: vi.fn(() => 'toast-1'), dismiss: vi.fn() } }));

import { useFleetUpdateStatus } from '../useFleetUpdateStatus';
import { useComposeReapplyAction } from '../useComposeReapplyAction';
import type { NodeUpdateStatus } from '../../types';

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

const STATUSES: NodeUpdateStatus[] = [
  { nodeId: 1, name: 'Local', type: 'local', version: '1.0.0', latestVersion: '1.1.0', online: true, updateAvailable: true, updateStatus: null },
  { nodeId: 2, name: 'Edge', type: 'remote', version: '1.0.0', latestVersion: '1.1.0', online: true, updateAvailable: true, updateStatus: null },
];

/** Answers update-status with STATUSES, the option endpoint with `option`, and anything else with 202. */
function route(option: unknown) {
  apiFetchMock.mockImplementation(async (path: string) => {
    if (path === '/fleet/update-status') return json({ nodes: STATUSES });
    if (path.endsWith('/endpoint-provider')) return json(option);
    return json({ message: 'ok' }, 202);
  });
}

function posts(path: string) {
  return apiFetchMock.mock.calls.filter(call => call[0] === path).map(call => call[1] as { body?: string });
}

beforeEach(() => { apiFetchMock.mockReset(); });

describe('remote update with a Docker endpoint', () => {
  async function loaded() {
    const hook = renderHook(() => useFleetUpdateStatus());
    await act(async () => { await hook.result.current.fetchUpdateStatus(); });
    return hook;
  }

  it('opens the confirm instead of posting when the node offers its Docker endpoint', async () => {
    route({ state: 'available', service: 'socket-proxy', containerName: 'c' });
    const { result } = await loaded();
    await act(async () => { await result.current.triggerNodeUpdate(2); });
    expect(result.current.localUpdateConfirm).toBe(2);
    expect(posts('/fleet/nodes/2/update')).toEqual([]);

    await act(async () => { await result.current.confirmLocalUpdate({ replaceEndpointProvider: true, endpointProviderOnly: false }); });
    expect(JSON.parse(posts('/fleet/nodes/2/update')[0].body!)).toEqual({ targetVersion: '1.1.0', replaceEndpointProvider: true });
    expect(result.current.reconnecting).toBe(false);
  });

  it('keeps the one-click update when the node has no Docker endpoint to recreate', async () => {
    route({ state: 'none' });
    const { result } = await loaded();
    await act(async () => { await result.current.triggerNodeUpdate(2); });
    expect(result.current.localUpdateConfirm).toBeNull();
    expect(JSON.parse(posts('/fleet/nodes/2/update')[0].body!)).toEqual({ targetVersion: '1.1.0' });
  });

  it('falls back to the one-click update when the option check fails', async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/fleet/update-status') return json({ nodes: STATUSES });
      if (path.endsWith('/endpoint-provider')) throw new Error('network down');
      return json({ message: 'ok' }, 202);
    });
    const { result } = await loaded();
    await act(async () => { await result.current.triggerNodeUpdate(2); });
    expect(posts('/fleet/nodes/2/update')).toHaveLength(1);
  });

  it('sends the flag for a confirmed local update', async () => {
    route({ state: 'available', service: 'socket-proxy', containerName: 'c' });
    vi.stubGlobal('fetch', vi.fn(async () => json({ startedAt: 1 })));
    const { result } = await loaded();
    await act(async () => { await result.current.triggerNodeUpdate(1); });
    await act(async () => { await result.current.confirmLocalUpdate({ replaceEndpointProvider: true, endpointProviderOnly: false }); });
    expect(JSON.parse(posts('/fleet/nodes/1/update')[0].body!)).toMatchObject({ replaceEndpointProvider: true });
    vi.unstubAllGlobals();
  });
});

describe('reapply with a Docker endpoint', () => {
  it('sends the flag only when chosen', async () => {
    route({});
    const { result } = renderHook(() => useComposeReapplyAction());
    act(() => { result.current.openConfirm({ nodeId: 2, type: 'remote', name: 'Edge' }); });
    await act(async () => { await result.current.confirmReapply({ replaceEndpointProvider: true, endpointProviderOnly: false }); });
    expect(posts('/fleet/nodes/2/reapply-compose')[0]).toMatchObject({ method: 'POST', body: JSON.stringify({ replaceEndpointProvider: true }) });

    act(() => { result.current.openConfirm({ nodeId: 2, type: 'remote', name: 'Edge' }); });
    await act(async () => { await result.current.confirmReapply({ replaceEndpointProvider: false, endpointProviderOnly: false }); });
    expect(posts('/fleet/nodes/2/reapply-compose')[1].body).toBeUndefined();
  });

  it('sends the endpoint-only choice and never shows the reconnect overlay', async () => {
    route({});
    const { result } = renderHook(() => useComposeReapplyAction());
    act(() => { result.current.openConfirm({ nodeId: 2, type: 'remote', name: 'Edge' }); });
    await act(async () => { await result.current.confirmReapply({ replaceEndpointProvider: true, endpointProviderOnly: true }); });
    expect(JSON.parse(posts('/fleet/nodes/2/reapply-compose')[0].body!)).toEqual({
      replaceEndpointProvider: true,
      endpointProviderOnly: true,
    });
    expect(result.current.reconnecting).toBe(false);
  });
});
