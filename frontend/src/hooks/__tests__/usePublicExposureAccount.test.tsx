/**
 * The public exposure account hook keeps a view on screen across a failed
 * refresh, so it must say the view may be stale until something fresh arrives.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ConnectedAccountView } from '@/lib/publicExposureApi';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({ toast: toastMock }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ isAdmin: true }) }));
vi.mock('@/hooks/useExperimental', () => ({ useExperimental: () => ({ experimental: true }) }));

import { usePublicExposureAccount } from '../usePublicExposureAccount';

const T = Date.UTC(2026, 10, 19);
const account: ConnectedAccountView = {
  connected: true, provider: 'cloudflare-tunnel', accountId: 'a1'.repeat(16), accountName: 'Example',
  scopes: { zoneRead: 'confirmed', tunnel: 'unconfirmed' }, lastCheck: { outcome: 'ok', at: T, detail: null },
  verifiedAt: T, connectedBy: 'admin', connectedAt: T, zonesVisible: 0, zones: [], nodeEndpointCount: 0,
};

const answer = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  apiFetchMock.mockReset();
  toastMock.error.mockReset();
});

describe('usePublicExposureAccount freshness', () => {
  it('keeps the last view and records the failure when a reload fails, then clears it when a reload succeeds', async () => {
    apiFetchMock.mockImplementation(() => answer(account));
    const { result } = renderHook(() => usePublicExposureAccount(true));
    await waitFor(() => expect(result.current.view).toEqual(account));
    expect(result.current.loadError).toBeNull();

    apiFetchMock.mockImplementation(() => answer({ error: 'down' }, 500));
    await act(() => result.current.reload());
    expect(result.current.view).toEqual(account);
    expect(result.current.loadError).toBe('down');

    apiFetchMock.mockImplementation(() => answer(account));
    await act(() => result.current.reload());
    expect(result.current.loadError).toBeNull();
  });

  it.each([
    ['a recheck', (r: ReturnType<typeof usePublicExposureAccount>) => r.recheck(), account],
    ['a zone change', (r: ReturnType<typeof usePublicExposureAccount>) => r.setZone('c3'.repeat(16), true, []), account],
    ['a token replacement', (r: ReturnType<typeof usePublicExposureAccount>) => r.connect('t'.repeat(30), 'a1'.repeat(16)), account],
    ['a DNS check', (r: ReturnType<typeof usePublicExposureAccount>) => r.dnsCheck('c3'.repeat(16)), account],
    ['a disconnect', (r: ReturnType<typeof usePublicExposureAccount>) => r.disconnect(), { leftInCloudflare: [] }],
  ])('clears a failed refresh once %s is answered with a fresh view', async (_label, verb, body) => {
    apiFetchMock.mockImplementation(() => answer(account));
    const { result } = renderHook(() => usePublicExposureAccount(true));
    await waitFor(() => expect(result.current.view).toEqual(account));
    apiFetchMock.mockImplementation(() => answer({ error: 'down' }, 500));
    await act(() => result.current.reload());
    expect(result.current.loadError).toBe('down');

    apiFetchMock.mockImplementation(() => answer(body));
    await act(async () => { await verb(result.current); });
    expect(result.current.loadError).toBeNull();
  });

  it('keeps a failed refresh when a verb itself fails', async () => {
    apiFetchMock.mockImplementation(() => answer(account));
    const { result } = renderHook(() => usePublicExposureAccount(true));
    await waitFor(() => expect(result.current.view).toEqual(account));
    apiFetchMock.mockImplementation(() => answer({ error: 'down' }, 500));
    await act(() => result.current.reload());

    await act(() => result.current.recheck());
    expect(result.current.loadError).toBe('down');
  });

  it.each([
    ['a refused DNS check', (r: ReturnType<typeof usePublicExposureAccount>) => r.dnsCheck('c3'.repeat(16))],
    ['a refused disconnect', (r: ReturnType<typeof usePublicExposureAccount>) => r.disconnect()],
  ])('records the failure of the refetch that follows %s over a view on screen, with one toast', async (_label, verb) => {
    apiFetchMock.mockImplementation(() => answer(account));
    const { result } = renderHook(() => usePublicExposureAccount(true));
    await waitFor(() => expect(result.current.view).toEqual(account));
    expect(result.current.loadError).toBeNull();

    apiFetchMock.mockImplementation(() => answer({ error: 'down' }, 500));
    toastMock.error.mockReset();
    await act(async () => { await verb(result.current); });
    expect(result.current.view).toEqual(account);
    expect(result.current.loadError).toBe('down');
    // The verb's own failure is the one toast; its quiet refetch adds none.
    expect(toastMock.error).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh first load when the gate turns on late, and clears an earlier failure when it answers', async () => {
    apiFetchMock.mockImplementation(() => answer({ error: 'down' }, 500));
    const { result, rerender } = renderHook(({ on }) => usePublicExposureAccount(on), { initialProps: { on: false } });
    expect(apiFetchMock).not.toHaveBeenCalled();
    rerender({ on: true });
    await waitFor(() => expect(result.current.loadError).toBe('down'));

    apiFetchMock.mockImplementation(() => answer(account));
    rerender({ on: false });
    rerender({ on: true });
    await waitFor(() => expect(result.current.view).toEqual(account));
    expect(result.current.loadError).toBeNull();
  });
});
