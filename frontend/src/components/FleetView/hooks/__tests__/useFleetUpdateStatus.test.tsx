import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const apiFetchMock = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) },
}));

import { useFleetUpdateStatus } from '../useFleetUpdateStatus';
import type { NodeUpdateStatus } from '../../types';

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const STATUSES: NodeUpdateStatus[] = [
  { nodeId: 1, name: 'Local', type: 'local', version: '1.0.0', latestVersion: '1.1.0', updateAvailable: true, updateStatus: null },
  { nodeId: 2, name: 'Edge', type: 'remote', version: '1.0.0', latestVersion: '1.1.0', updateAvailable: true, updateStatus: null },
];

beforeEach(() => {
  apiFetchMock.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe('useFleetUpdateStatus', () => {
  it('fetchUpdateStatus populates updateStatuses from the response', async () => {
    apiFetchMock.mockResolvedValue(okJson({ nodes: STATUSES }));
    const { result } = renderHook(() => useFleetUpdateStatus());

    await act(async () => { await result.current.fetchUpdateStatus(); });
    expect(result.current.updateStatuses).toHaveLength(2);
    expect(result.current.updateStatuses[1].name).toBe('Edge');
  });

  it('logs (does not swallow) a failed update-status poll without toasting', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    apiFetchMock.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useFleetUpdateStatus());

    await act(async () => { await result.current.fetchUpdateStatus(); });

    expect(warnSpy).toHaveBeenCalledWith('[Fleet] Failed to fetch update status:', expect.any(Error));
    // Polled call must not toast on failure.
    expect(toastError).not.toHaveBeenCalled();
    expect(result.current.updateStatuses).toEqual([]);
    warnSpy.mockRestore();
  });

  it('logs a non-ok update-status response (HTTP error) without toasting', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    apiFetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
    const { result } = renderHook(() => useFleetUpdateStatus());

    await act(async () => { await result.current.fetchUpdateStatus(); });

    expect(warnSpy).toHaveBeenCalledWith('[Fleet] update-status returned HTTP', 500);
    expect(toastError).not.toHaveBeenCalled();
    expect(result.current.updateStatuses).toEqual([]);
    warnSpy.mockRestore();
  });

  it('preserves the last-known statuses when a later poll fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // First poll succeeds and seeds two statuses.
    apiFetchMock.mockResolvedValueOnce(okJson({ nodes: STATUSES }));
    const { result } = renderHook(() => useFleetUpdateStatus());
    await act(async () => { await result.current.fetchUpdateStatus(); });
    expect(result.current.updateStatuses).toHaveLength(2);

    // A subsequent poll fails; the table must keep the seeded statuses.
    apiFetchMock.mockRejectedValueOnce(new Error('network down'));
    await act(async () => { await result.current.fetchUpdateStatus(); });

    expect(result.current.updateStatuses).toHaveLength(2);
    expect(result.current.updateStatuses[0].name).toBe('Local');
    expect(warnSpy).toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('triggerNodeUpdate on a local node opens the confirm dialog instead of POSTing', async () => {
    apiFetchMock.mockResolvedValue(okJson({ nodes: STATUSES }));
    const { result } = renderHook(() => useFleetUpdateStatus());
    await act(async () => { await result.current.fetchUpdateStatus(); });
    apiFetchMock.mockClear();

    await act(async () => { await result.current.triggerNodeUpdate(1); });

    expect(result.current.localUpdateConfirm).toBe(1);
    // No update POST should have fired for the local node.
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('triggerNodeUpdate on a remote node POSTs and toasts success', async () => {
    apiFetchMock.mockResolvedValue(okJson({ nodes: STATUSES }));
    const { result } = renderHook(() => useFleetUpdateStatus());
    await act(async () => { await result.current.fetchUpdateStatus(); });

    apiFetchMock.mockResolvedValue(okJson({ message: 'ok' }));
    await act(async () => { await result.current.triggerNodeUpdate(2); });

    expect(apiFetchMock).toHaveBeenCalledWith('/fleet/nodes/2/update', expect.objectContaining({ method: 'POST', localOnly: true }));
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining('Edge'));
  });

  it('triggerNodeUpdate surfaces a server error message via toast', async () => {
    apiFetchMock.mockResolvedValue(okJson({ nodes: STATUSES }));
    const { result } = renderHook(() => useFleetUpdateStatus());
    await act(async () => { await result.current.fetchUpdateStatus(); });

    apiFetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'node busy' }), { status: 409 }));
    await act(async () => { await result.current.triggerNodeUpdate(2); });

    expect(toastError).toHaveBeenCalledWith('node busy');
  });

  it('dismissNodeUpdate issues a DELETE then refetches', async () => {
    apiFetchMock.mockResolvedValue(okJson({ nodes: [] }));
    const { result } = renderHook(() => useFleetUpdateStatus());

    await act(async () => { await result.current.dismissNodeUpdate(2); });

    expect(apiFetchMock).toHaveBeenCalledWith('/fleet/nodes/2/update-status', expect.objectContaining({ method: 'DELETE' }));
  });

  it('triggerUpdateAll reports the number of nodes updating', async () => {
    apiFetchMock.mockResolvedValue(okJson({ updating: ['a', 'b'], skipped: [] }));
    const { result } = renderHook(() => useFleetUpdateStatus());

    await act(async () => { await result.current.triggerUpdateAll(); });

    expect(apiFetchMock).toHaveBeenCalledWith('/fleet/update-all', expect.objectContaining({ method: 'POST' }));
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining('2 nodes'));
  });

  it('checkUpdates opens the modal and toggles the checking flag', async () => {
    apiFetchMock.mockResolvedValue(okJson({ nodes: STATUSES }));
    const { result } = renderHook(() => useFleetUpdateStatus());

    await act(async () => { await result.current.checkUpdates(); });

    expect(result.current.showUpdateModal).toBe(true);
    expect(result.current.checkingUpdates).toBe(false);
    await waitFor(() => expect(result.current.updateStatuses).toHaveLength(2));
  });
});
