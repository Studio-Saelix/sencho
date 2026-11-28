import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const { apiFetchMock, toastMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));
vi.mock('@/components/ui/toast-store', () => ({ toast: toastMock }));

import { resetNodeSealingKeyPin, useNodeSealingKey, type NodeSealingKeyView } from '../useNodeSealingKey';

function json(status: number, body: unknown) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
}

const unconfirmed: NodeSealingKeyView = {
  kind: 'remote',
  readiness: 'pin_unconfirmed',
  pinned: null,
  presented: { fingerprint: 'presented-fp' },
};
const ready: NodeSealingKeyView = {
  kind: 'remote',
  readiness: 'ready',
  pinned: { fingerprint: 'presented-fp', registeredAt: 1, confidential: true, confirmedBy: 'admin', confirmedAt: 2 },
  presented: { fingerprint: 'presented-fp' },
};
const node = { id: 7, name: 'edge' };

beforeEach(() => {
  apiFetchMock.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
});

describe('useNodeSealingKey', () => {
  it('makes no request while disabled', () => {
    renderHook(() => useNodeSealingKey(node, false));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('reads the status from the instance the browser is signed into', async () => {
    apiFetchMock.mockReturnValueOnce(json(200, unconfirmed));
    const { result } = renderHook(() => useNodeSealingKey(node, true));
    await waitFor(() => expect(result.current.view).toEqual(unconfirmed));
    expect(apiFetchMock).toHaveBeenCalledWith('/nodes/7/sealing-key', { localOnly: true });
    expect(result.current.loading).toBe(false);
  });

  it('refuses an answer it cannot show instead of rendering it', async () => {
    apiFetchMock.mockReturnValueOnce(json(200, { kind: 'remote', readiness: 'something_new', pinned: null, presented: null }));
    const { result } = renderHook(() => useNodeSealingKey(node, true));
    await waitFor(() => expect(result.current.loadError).toMatch(/cannot show/));
    expect(result.current.view).toBeNull();
  });

  it('keeps the last view on a failed refetch and reports why', async () => {
    apiFetchMock.mockReturnValueOnce(json(200, unconfirmed));
    const { result } = renderHook(() => useNodeSealingKey(node, true));
    await waitFor(() => expect(result.current.view).toEqual(unconfirmed));
    apiFetchMock.mockReturnValueOnce(json(503, { error: 'Node unreachable right now' }));
    await act(() => result.current.reload());
    expect(result.current.view).toEqual(unconfirmed);
    expect(result.current.loadError).toBe('Node unreachable right now');
  });

  it('confirms the presented fingerprint and adopts the answer', async () => {
    apiFetchMock.mockReturnValueOnce(json(200, unconfirmed));
    const { result } = renderHook(() => useNodeSealingKey(node, true));
    await waitFor(() => expect(result.current.view).not.toBeNull());
    apiFetchMock.mockReturnValueOnce(json(200, ready));
    let ok = false;
    await act(async () => { ok = await result.current.confirm('presented-fp'); });
    expect(ok).toBe(true);
    const [path, init] = apiFetchMock.mock.calls[1];
    expect(path).toBe('/nodes/7/sealing-key/confirm');
    expect(init).toMatchObject({ method: 'POST', localOnly: true, body: JSON.stringify({ fingerprint: 'presented-fp' }) });
    expect(result.current.view).toEqual(ready);
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBeNull();
  });

  it('shows the refusal and rereads the status when a confirm is refused', async () => {
    apiFetchMock.mockReturnValueOnce(json(200, unconfirmed));
    const { result } = renderHook(() => useNodeSealingKey(node, true));
    await waitFor(() => expect(result.current.view).not.toBeNull());
    apiFetchMock
      .mockReturnValueOnce(json(409, { error: 'The node presents a different key.', code: 'SEAL_KEY_MISMATCH' }))
      .mockReturnValueOnce(json(200, { ...unconfirmed, readiness: 'key_mismatch' }));
    let ok = true;
    await act(async () => { ok = await result.current.confirm('presented-fp'); });
    expect(ok).toBe(false);
    expect(toastMock.error).toHaveBeenCalledWith('The node presents a different key.');
    await waitFor(() => expect(result.current.view).toMatchObject({ readiness: 'key_mismatch' }));
  });

  it('resets through the shared request and tells the caller', async () => {
    apiFetchMock.mockReturnValueOnce(json(200, ready));
    const onCleared = vi.fn();
    const { result } = renderHook(() => useNodeSealingKey(node, true, onCleared));
    await waitFor(() => expect(result.current.view).not.toBeNull());
    apiFetchMock
      .mockReturnValueOnce(json(200, {}))
      .mockReturnValueOnce(json(200, unconfirmed));
    let ok = false;
    await act(async () => { ok = await result.current.reset(); });
    expect(ok).toBe(true);
    expect(apiFetchMock.mock.calls[1]).toEqual(['/nodes/7/sealing-key', { method: 'DELETE', localOnly: true }]);
    expect(onCleared).toHaveBeenCalledTimes(1);
    expect(result.current.view).toEqual(unconfirmed);
  });

  it('reports a failed reset without clearing anything', async () => {
    apiFetchMock.mockReturnValueOnce(json(200, ready));
    const onCleared = vi.fn();
    const { result } = renderHook(() => useNodeSealingKey(node, true, onCleared));
    await waitFor(() => expect(result.current.view).not.toBeNull());
    apiFetchMock.mockReturnValueOnce(json(403, { error: 'Permission denied' }));
    let ok = true;
    await act(async () => { ok = await result.current.reset(); });
    expect(ok).toBe(false);
    expect(toastMock.error).toHaveBeenCalledWith('Permission denied');
    expect(onCleared).not.toHaveBeenCalled();
    expect(result.current.view).toEqual(ready);
  });
});

describe('resetNodeSealingKeyPin', () => {
  it('throws the server message on failure', async () => {
    apiFetchMock.mockReturnValueOnce(json(500, { error: 'boom' }));
    await expect(resetNodeSealingKeyPin(3)).rejects.toThrow('boom');
  });

  it('falls back to a fixed message when the body has none', async () => {
    apiFetchMock.mockReturnValueOnce(Promise.resolve({ ok: false, status: 500, json: () => Promise.reject(new Error('no body')) }));
    await expect(resetNodeSealingKeyPin(3)).rejects.toThrow('Failed to reset sealing key pin');
  });
});
