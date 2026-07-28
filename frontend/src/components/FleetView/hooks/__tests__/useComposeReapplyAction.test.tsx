import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useComposeReapplyAction } from '../useComposeReapplyAction';

const apiFetchMock = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('@/components/ui/toast-store', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('useComposeReapplyAction', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('openConfirm does not POST until confirmReapply', async () => {
    const { result } = renderHook(() => useComposeReapplyAction());
    act(() => {
      result.current.openConfirm({ nodeId: 2, type: 'remote', name: 'Edge' });
    });
    expect(result.current.confirmTarget?.nodeId).toBe(2);
    expect(apiFetchMock).not.toHaveBeenCalled();

    apiFetchMock.mockResolvedValue(okJson({ message: 'ok' }));
    await act(async () => { await result.current.confirmReapply(); });
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/fleet/nodes/2/reapply-compose',
      expect.objectContaining({ method: 'POST', localOnly: true }),
    );
    expect(toastSuccess).toHaveBeenCalled();
    expect(result.current.confirmTarget).toBeNull();
  });

  it('cancelConfirm clears without POST', () => {
    const { result } = renderHook(() => useComposeReapplyAction());
    act(() => {
      result.current.openConfirm({ nodeId: 1, type: 'local', name: 'Local' });
      result.current.cancelConfirm();
    });
    expect(result.current.confirmTarget).toBeNull();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('starts local reconnect after a successful local POST', async () => {
    apiFetchMock.mockResolvedValue(okJson({ message: 'ok' }));
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(
      new Response(JSON.stringify({ startedAt: 42 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )));
    const { result } = renderHook(() => useComposeReapplyAction());
    await act(async () => {
      await result.current.runReapply({ nodeId: 1, type: 'local', name: 'Local' });
    });
    expect(result.current.reconnecting).toBe(true);
    expect(result.current.preUpdateStartedAt).toBe(42);
  });

  it('clears reconnect when tracker reports local failure', async () => {
    vi.useFakeTimers();
    apiFetchMock
      .mockResolvedValueOnce(okJson({ message: 'ok' }))
      .mockResolvedValue(okJson({
        nodes: [{
          type: 'local',
          updateStatus: 'failed',
          operationKind: 'reapply_configuration',
          error: 'Compose config invalid',
        }],
      }));
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(
      new Response(JSON.stringify({ startedAt: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )));
    const { result } = renderHook(() => useComposeReapplyAction());
    await act(async () => {
      await result.current.runReapply({ nodeId: 1, type: 'local', name: 'Local' });
    });
    expect(result.current.reconnecting).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(result.current.reconnecting).toBe(false);
    expect(toastError).toHaveBeenCalledWith('Compose config invalid');
  });

  it('ignores a second confirm while dispatch is pending', async () => {
    let release!: (value: Response) => void;
    const held = new Promise<Response>((resolve) => { release = resolve; });
    apiFetchMock.mockImplementation(() => held);
    const { result } = renderHook(() => useComposeReapplyAction());

    const first = act(async () => {
      await result.current.runReapply({ nodeId: 2, type: 'remote', name: 'Edge' });
    });
    await act(async () => {
      await result.current.runReapply({ nodeId: 2, type: 'remote', name: 'Edge' });
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    release(okJson({ message: 'ok' }));
    await first;
  });
});
