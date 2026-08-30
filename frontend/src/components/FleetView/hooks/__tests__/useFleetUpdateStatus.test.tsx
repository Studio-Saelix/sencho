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

const BLOCKED_STATUS: NodeUpdateStatus = {
  nodeId: 3, name: 'Pinned', type: 'remote', version: '1.0.0', latestVersion: '1.1.0',
  updateAvailable: true, updateStatus: null, updateBlocked: true, updateBlockedReason: 'Digest pin blocks update.',
};

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

  it('reports failed remote nodes separately after an update-all request', async () => {
    apiFetchMock.mockResolvedValue(okJson({
      updating: [],
      skipped: [],
      failed: [{ name: 'Edge', error: 'Hardened Build updates require a signed-in admin on that node.' }],
    }));
    const { result } = renderHook(() => useFleetUpdateStatus());

    await act(async () => { await result.current.triggerUpdateAll(); });

    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('Edge'));
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('Hardened Build'));
  });

  it('triggerNodeUpdate on a blocked node toasts and does not POST', async () => {
    apiFetchMock.mockResolvedValue(okJson({ nodes: [...STATUSES, BLOCKED_STATUS] }));
    const { result } = renderHook(() => useFleetUpdateStatus());
    await act(async () => { await result.current.fetchUpdateStatus(); });
    apiFetchMock.mockClear();

    await act(async () => { await result.current.triggerNodeUpdate(3); });

    expect(toastError).toHaveBeenCalledWith('Digest pin blocks update.');
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('triggerNodeReapply on a remote node opens confirm and does not POST until confirmed', async () => {
    apiFetchMock.mockResolvedValue(okJson({ nodes: STATUSES }));
    const { result } = renderHook(() => useFleetUpdateStatus());
    await act(async () => { await result.current.fetchUpdateStatus(); });
    apiFetchMock.mockClear();

    await act(async () => { await result.current.triggerNodeReapply(2); });

    expect(result.current.reapplyConfirm).toBe(2);
    expect(apiFetchMock).not.toHaveBeenCalled();

    apiFetchMock.mockResolvedValue(okJson({ message: 'ok' }));
    await act(async () => { await result.current.confirmReapply(); });

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/fleet/nodes/2/reapply-compose',
      expect.objectContaining({ method: 'POST', localOnly: true }),
    );
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining('Edge'));
    expect(result.current.reapplyConfirm).toBeNull();
  });

  it('triggerNodeReapply on a local node opens confirm then starts local reconnect flow', async () => {
    apiFetchMock.mockResolvedValue(okJson({ nodes: STATUSES }));
    const { result } = renderHook(() => useFleetUpdateStatus());
    await act(async () => { await result.current.fetchUpdateStatus(); });
    apiFetchMock.mockClear();

    await act(async () => { await result.current.triggerNodeReapply(1); });
    expect(result.current.reapplyConfirm).toBe(1);
    expect(apiFetchMock).not.toHaveBeenCalled();

    apiFetchMock.mockResolvedValue(okJson({ message: 'ok' }));
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(
      new Response(JSON.stringify({ startedAt: 1000 }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )));

    await act(async () => { await result.current.confirmReapply(); });

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/fleet/nodes/1/reapply-compose',
      expect.objectContaining({ method: 'POST', localOnly: true }),
    );
    expect(result.current.reconnecting).toBe(true);
    expect(result.current.reconnectMode).toBe('reapply');
    vi.unstubAllGlobals();
  });

  it('confirmLocalUpdate forwards targetVersion when latestVersion is valid', async () => {
    apiFetchMock.mockResolvedValue(okJson({ nodes: STATUSES }));
    const { result } = renderHook(() => useFleetUpdateStatus());
    await act(async () => { await result.current.fetchUpdateStatus(); });

    await act(async () => { await result.current.triggerNodeUpdate(1); });
    expect(result.current.localUpdateConfirm).toBe(1);

    apiFetchMock.mockResolvedValue(okJson({ message: 'ok' }));
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(
      new Response(JSON.stringify({ startedAt: 1000 }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )));

    await act(async () => { await result.current.confirmLocalUpdate(); });

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/fleet/nodes/1/update',
      expect.objectContaining({
        method: 'POST',
        localOnly: true,
        body: JSON.stringify({ targetVersion: '1.1.0' }),
      }),
    );
    expect(result.current.reconnecting).toBe(true);
    vi.unstubAllGlobals();
  });

  it('confirmLocalUpdate omits targetVersion for a dev image even when latestVersion is a valid stable version', async () => {
    const devStatuses: NodeUpdateStatus[] = [
      { ...STATUSES[0], isDevImage: true },
      STATUSES[1],
    ];
    apiFetchMock.mockResolvedValue(okJson({ nodes: devStatuses }));
    const { result } = renderHook(() => useFleetUpdateStatus());
    await act(async () => { await result.current.fetchUpdateStatus(); });

    await act(async () => { await result.current.triggerNodeUpdate(1); });
    expect(result.current.localUpdateConfirm).toBe(1);

    apiFetchMock.mockResolvedValue(okJson({ message: 'ok' }));
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(
      new Response(JSON.stringify({ startedAt: 1000 }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )));

    await act(async () => { await result.current.confirmLocalUpdate(); });

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/fleet/nodes/1/update',
      expect.objectContaining({ method: 'POST', localOnly: true }),
    );
    const call = apiFetchMock.mock.calls.find(([url]) => url === '/fleet/nodes/1/update');
    expect(call![1]).not.toHaveProperty('body');
    vi.unstubAllGlobals();
  });

  it('confirmLocalUpdate still omits targetVersion for a dev image with no valid latestVersion', async () => {
    const devStatuses: NodeUpdateStatus[] = [
      { ...STATUSES[0], isDevImage: true, latestVersion: null },
      STATUSES[1],
    ];
    apiFetchMock.mockResolvedValue(okJson({ nodes: devStatuses }));
    const { result } = renderHook(() => useFleetUpdateStatus());
    await act(async () => { await result.current.fetchUpdateStatus(); });

    await act(async () => { await result.current.triggerNodeUpdate(1); });
    apiFetchMock.mockResolvedValue(okJson({ message: 'ok' }));
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(
      new Response(JSON.stringify({ startedAt: 1000 }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )));

    await act(async () => { await result.current.confirmLocalUpdate(); });

    const call = apiFetchMock.mock.calls.find(([url]) => url === '/fleet/nodes/1/update');
    expect(call![1]).not.toHaveProperty('body');
    vi.unstubAllGlobals();
  });

  it('dismisses the reconnecting overlay when the local update resolves failed', async () => {
    apiFetchMock.mockResolvedValue(okJson({ nodes: STATUSES }));
    const { result } = renderHook(() => useFleetUpdateStatus());
    await act(async () => { await result.current.fetchUpdateStatus(); });

    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(
        new Response(JSON.stringify({ startedAt: 1000 }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      )));
      apiFetchMock.mockResolvedValueOnce(okJson({ message: 'ok' }));

      await act(async () => { await result.current.triggerNodeUpdate(1); });
      await act(async () => { await result.current.confirmLocalUpdate(); });
      expect(result.current.reconnecting).toBe(true);

      const failedLocal = {
        ...STATUSES[0],
        updateStatus: 'failed' as const,
        error: 'Pull failed',
      };
      apiFetchMock.mockResolvedValue(okJson({ nodes: [failedLocal, STATUSES[1]] }));

      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });

      expect(result.current.reconnecting).toBe(false);
      expect(toastError).toHaveBeenCalledWith('Pull failed');
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
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
