import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './AuthContext';

const authenticated = { user: { username: 'operator', role: 'admin' } };
const permissionData = {
  globalRole: 'viewer',
  globalPermissions: ['stack:read'],
  scopedPermissions: {},
};

function mockFetch(...responses: Array<Response | Promise<Response>>) {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ needsSetup: false }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(authenticated), { status: 200 }))
    .mockImplementationOnce(() => responses.shift()));
}

describe('AuthContext permission metadata', () => {
  it('keeps authorization unavailable until permissions load', async () => {
    let resolvePermissions: (response: Response) => void;
    const pendingPermissions = new Promise<Response>((resolve) => { resolvePermissions = resolve; });
    mockFetch(pendingPermissions);

    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });

    await waitFor(() => expect(result.current.appStatus).toBe('authenticated'));
    expect(result.current.permissionsStatus).toBe('loading');
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.can('stack:read')).toBe(false);

    await act(async () => resolvePermissions!(new Response(JSON.stringify(permissionData), { status: 200 })));

    await waitFor(() => expect(result.current.permissionsStatus).toBe('ready'));
    expect(result.current.can('stack:read')).toBe(true);
    expect(result.current.isAdmin).toBe(false);
  });

  it('fails closed and recovers after a retry', async () => {
    mockFetch(new Response(null, { status: 503 }));
    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });

    await waitFor(() => expect(result.current.permissionsStatus).toBe('error'));
    expect(result.current.can('stack:read')).toBe(false);
    expect(result.current.isAdmin).toBe(false);

    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(permissionData), { status: 200 }));
    await act(async () => result.current.retryPermissions());

    expect(result.current.permissionsStatus).toBe('ready');
    expect(result.current.can('stack:read')).toBe(true);
  });
});
