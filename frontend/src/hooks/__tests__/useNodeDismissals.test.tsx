import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useNodeDismissals } from '../useNodeDismissals';

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api', () => ({ apiFetch: api.apiFetch }));
vi.mock('@/components/ui/toast-store', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
const row = { id: 1, nodeId: 3, surface: 'security', findingKey: 'security:3:needs_review:all', fingerprint: 'fp', severity: 'review', count: 1, mode: 'until_change', expiresAt: null, createdBy: 'a', createdAt: 1 };

beforeEach(() => {
  api.apiFetch.mockReset();
});

describe('useNodeDismissals', () => {
  it('reads the security list for the node from this instance', async () => {
    api.apiFetch.mockResolvedValue(reply({ dismissals: [row] }));
    const { result } = renderHook(() => useNodeDismissals('security', 3, 0, vi.fn()));
    await waitFor(() => expect(result.current.dismissals).toHaveLength(1));
    const [path, init] = api.apiFetch.mock.calls[0] as [string, { localOnly?: boolean }];
    expect(path).toBe('/fleet/dismissals/security?nodeId=3');
    expect(init.localOnly).toBe(true);
  });

  it('reads nothing for an account the route would refuse', async () => {
    const { result } = renderHook(() => useNodeDismissals('security', 3, 0, vi.fn(), false));
    await Promise.resolve();
    expect(api.apiFetch).not.toHaveBeenCalled();
    expect(result.current.dismissals).toEqual([]);
  });
});
