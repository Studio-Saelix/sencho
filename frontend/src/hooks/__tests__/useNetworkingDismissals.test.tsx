import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useNetworkingDismissals } from '../useNetworkingDismissals';

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api', () => ({ apiFetch: api.apiFetch }));
vi.mock('@/components/ui/toast-store', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const reply = (ok: boolean, body: unknown) => ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response;
const row = { id: 1, nodeId: 3, surface: 'networking', findingKey: 'networking:3:x', fingerprint: 'fp', severity: 'medium', count: 1, mode: 'until_change', expiresAt: null, createdBy: 'a', createdAt: 1 };

beforeEach(() => {
  api.apiFetch.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('useNetworkingDismissals', () => {
  it('reads the hub list for the node, addressed to this instance', async () => {
    api.apiFetch.mockResolvedValue(reply(true, { dismissals: [row] }));
    const { result } = renderHook(() => useNetworkingDismissals(3, 0, vi.fn()));
    await waitFor(() => expect(result.current.dismissals).toHaveLength(1));
    const [path, init] = api.apiFetch.mock.calls[0] as [string, { localOnly?: boolean }];
    expect(path).toBe('/fleet/dismissals/networking?nodeId=3');
    expect(init.localOnly).toBe(true);
  });

  it.each([
    ['a refused read', reply(false, { error: 'no' })],
    ['a body with no list', reply(true, null)],
    ['a list that is not an array', reply(true, { dismissals: 'x' })],
  ])('leaves findings listed after %s', async (_name, response) => {
    api.apiFetch.mockResolvedValue(response);
    const { result } = renderHook(() => useNetworkingDismissals(3, 0, vi.fn()));
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalled());
    expect(result.current.dismissals).toEqual([]);
  });

  it('leaves findings listed when the request throws', async () => {
    api.apiFetch.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useNetworkingDismissals(3, 0, vi.fn()));
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalled());
    expect(result.current.dismissals).toEqual([]);
  });

  it('makes no request without a node, and reads again when the node or reload key changes', async () => {
    api.apiFetch.mockResolvedValue(reply(true, { dismissals: [] }));
    const { rerender } = renderHook(({ node, key }) => useNetworkingDismissals(node, key, vi.fn()), { initialProps: { node: undefined as number | undefined, key: 0 } });
    expect(api.apiFetch).not.toHaveBeenCalled();
    rerender({ node: 3, key: 0 });
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledTimes(1));
    rerender({ node: 3, key: 1 });
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledTimes(2));
  });

  it('applies a dismissal made after the node became known', async () => {
    api.apiFetch.mockResolvedValueOnce(reply(true, { dismissals: [] }));
    const { result, rerender } = renderHook(({ node }) => useNetworkingDismissals(node, 0, vi.fn()), { initialProps: { node: undefined as number | undefined } });
    rerender({ node: 3 });
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledTimes(1));
    api.apiFetch.mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ dismissal: row, kept: false }) } as Response);
    await result.current.dismiss({ id: 'networking:3:x', fingerprint: 'fp', count: 1, severity: 'medium' }, 'until_change');
    await waitFor(() => expect(result.current.dismissals).toHaveLength(1));
  });
});
