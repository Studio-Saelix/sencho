/**
 * Coverage for SSOSection error surfacing.
 *
 * Locks the three handlers that previously swallowed failures silently:
 * the config load on mount, the connection test, and provider removal now
 * each surface the backend message (or a fallback) through toast.error
 * instead of leaving the admin with no feedback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('@/components/ui/toast-store', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}));

vi.mock('@/context/LicenseContext', () => ({
  useLicense: () => ({ isPaid: true }),
}));

// Render the gated cards directly; tier/capability gating is exercised in the
// backend suite and is not what this test is about.
vi.mock('../CapabilityGate', () => ({
  CapabilityGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../PaidGate', () => ({
  PaidGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../settings/MastheadStatsContext', () => ({
  useMastheadStats: () => undefined,
}));

import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { SSOSection } from '../SSOSection';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;
const mockedToast = toast as unknown as { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; };

function res(ok: boolean, body: unknown): { ok: boolean; json: () => Promise<unknown> } {
  return { ok, json: () => Promise.resolve(body) };
}

beforeEach(() => {
  mockedFetch.mockReset();
  mockedToast.error.mockReset();
});

describe('SSOSection error surfacing', () => {
  it('toasts the backend message when the config load returns a non-ok response', async () => {
    mockedFetch.mockResolvedValue(res(false, { error: 'config store offline' }));
    render(<SSOSection />);
    await waitFor(() => {
      expect(mockedToast.error).toHaveBeenCalledWith('config store offline');
    });
  });

  it('toasts a fallback when the config load throws (network failure)', async () => {
    mockedFetch.mockRejectedValue(new Error('Failed to fetch'));
    render(<SSOSection />);
    await waitFor(() => {
      expect(mockedToast.error).toHaveBeenCalledWith('Failed to fetch');
    });
  });

  it('toasts the literal fallback when a non-ok config load has an unparseable body', async () => {
    mockedFetch.mockResolvedValue({ ok: false, json: () => Promise.reject(new Error('no body')) });
    render(<SSOSection />);
    await waitFor(() => {
      expect(mockedToast.error).toHaveBeenCalledWith('Failed to load SSO configuration');
    });
  });

  it('toasts the backend message when a connection test returns a non-ok response', async () => {
    const user = userEvent.setup();
    mockedFetch.mockImplementation((path: string) => {
      if (path === '/sso/config') return Promise.resolve(res(true, []));
      if (path.endsWith('/test')) return Promise.resolve(res(false, { error: 'provider tier locked' }));
      return Promise.resolve(res(true, {}));
    });
    render(<SSOSection />);

    await user.click(await screen.findByText('Custom OIDC'));
    await user.click(screen.getByRole('button', { name: /Test Connection/i }));

    await waitFor(() => {
      expect(mockedToast.error).toHaveBeenCalledWith('provider tier locked');
    });
  });

  it('toasts the backend message when removing a provider returns a non-ok response', async () => {
    const user = userEvent.setup();
    mockedFetch.mockImplementation((path: string, opts?: { method?: string }) => {
      if (path === '/sso/config') {
        return Promise.resolve(res(true, [{ provider: 'oidc_custom', enabled: true, displayName: 'Custom OIDC' }]));
      }
      if (path === '/sso/auth-mode') {
        return Promise.resolve(res(true, { authenticationMode: 'local_and_sso', localLoginEnabled: true }));
      }
      if (opts?.method === 'DELETE') return Promise.resolve(res(false, { error: 'delete rejected' }));
      return Promise.resolve(res(true, {}));
    });
    render(<SSOSection />);

    await waitFor(() => {
      expect(screen.getByText('Active')).toBeInTheDocument();
    });
    await user.click(screen.getByText('Custom OIDC'));
    await user.click(screen.getByRole('button', { name: /Remove/i }));

    await waitFor(() => {
      expect(mockedToast.error).toHaveBeenCalledWith('delete rejected');
    });
  });

  it('keeps the Active badge and ON toggle in sync after an enabled config loads', async () => {
    mockedFetch.mockImplementation((path: string) => {
      if (path === '/sso/config') {
        return Promise.resolve(res(true, [{
          provider: 'oidc_github',
          enabled: true,
          displayName: 'GitHub',
          oidcClientId: 'client',
        }]));
      }
      if (path === '/sso/auth-mode') {
        return Promise.resolve(res(true, { authenticationMode: 'local_and_sso', localLoginEnabled: true }));
      }
      return Promise.resolve(res(true, {}));
    });
    render(<SSOSection />);

    await waitFor(() => {
      expect(screen.getByText('Active')).toBeInTheDocument();
    });
    const onSwitches = screen.getAllByRole('switch').filter(
      (el) => el.getAttribute('aria-checked') === 'true',
    );
    expect(onSwitches).toHaveLength(1);
    expect(onSwitches[0]).toHaveTextContent('ON');
  });
});

describe('SSOSection role sync toggle', () => {
  // Helper: mock all the base SSO section loads with an empty provider list
  function mockBaseSsoLoad(extraMock?: (path: string) => unknown) {
    mockedFetch.mockImplementation((path: string) => {
      if (path === '/sso/config') return Promise.resolve(res(true, []));
      if (path === '/sso/auth-mode') return Promise.resolve(res(true, { authenticationMode: 'local_and_sso', localLoginEnabled: true }));
      if (extraMock) {
        const result = extraMock(path);
        if (result !== undefined) return Promise.resolve(result) as unknown;
        return Promise.resolve(res(true, {}));
      }
      return Promise.resolve(res(true, {}));
    });
  }

  // The role-sync TogglePill carries aria-label="IdP role synchronization" so
  // it is discoverable by role and setting name; queryByRole returns null when
  // the switch is absent (the unknown/loading state).
  function getRoleSyncSwitch(): Element | null {
    return screen.queryByRole('switch', { name: 'IdP role synchronization' });
  }

  it('default-off load: toggle shows OFF and is a confirmed state', async () => {
    mockBaseSsoLoad((path: string) => {
      if (path === '/sso/config/role-sync') return res(true, { enabled: false });
      return undefined;
    });
    render(<SSOSection />);
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledWith('/sso/config/role-sync', { localOnly: true });
    });
    await waitFor(() => {
      const roleSyncToggle = getRoleSyncSwitch();
      expect(roleSyncToggle).not.toBeNull();
      expect(roleSyncToggle).toHaveTextContent('OFF');
      expect(roleSyncToggle?.hasAttribute('disabled')).toBeFalsy();
    });
  });

  it('enabled load: toggle shows ON', async () => {
    mockBaseSsoLoad((path: string) => {
      if (path === '/sso/config/role-sync') return res(true, { enabled: true });
      return undefined;
    });
    render(<SSOSection />);
    await waitFor(() => {
      const onToggle = getRoleSyncSwitch();
      expect(onToggle).not.toBeNull();
      expect(onToggle).toHaveTextContent('ON');
    });
  });

  it('load failure: toasts error, toggle not presented as a confirmed OFF', async () => {
    mockBaseSsoLoad((path: string) => {
      if (path === '/sso/config/role-sync') return Promise.reject(new Error('Network timeout'));
      return undefined;
    });
    render(<SSOSection />);
    await waitFor(() => {
      expect(mockedToast.error).toHaveBeenCalledWith('Network timeout');
    });
    // On load failure the role-sync control stays in its unknown (null) state,
    // so no role-sync switch is rendered; "off" must not appear as confirmed.
    expect(getRoleSyncSwitch()).toBeNull();
  });

  it('load HTTP error: toasts backend message, toggle not presented as confirmed', async () => {
    mockBaseSsoLoad((path: string) => {
      if (path === '/sso/config/role-sync') return res(false, { error: 'Role sync unavailable' });
      return undefined;
    });
    render(<SSOSection />);
    await waitFor(() => {
      expect(mockedToast.error).toHaveBeenCalledWith('Role sync unavailable');
    });
    expect(getRoleSyncSwitch()).toBeNull();
  });

  it('save success: PUT sends { enabled: true }, toast.success shown', async () => {
    const user = userEvent.setup();
    let putBody: unknown;
    mockBaseSsoLoad((path: string) => {
      if (path === '/sso/config/role-sync') return res(true, { enabled: false });
      return undefined;
    });
    mockedFetch.mockImplementation((path: string, opts?: { method?: string; body?: string }) => {
      if (path === '/sso/config') return Promise.resolve(res(true, []));
      if (path === '/sso/auth-mode') return Promise.resolve(res(true, { authenticationMode: 'local_and_sso', localLoginEnabled: true }));
      if (path === '/sso/config/role-sync' && (!opts?.method || opts?.method === 'GET')) return Promise.resolve(res(true, { enabled: false }));
      if (path === '/sso/config/role-sync' && opts?.method === 'PUT') {
        putBody = opts.body;
        return Promise.resolve(res(true, { success: true }));
      }
      return Promise.resolve(res(true, {}));
    });

    render(<SSOSection />);
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledWith('/sso/config/role-sync', { localOnly: true });
    });

    // Wait for the toggle to load, then click it
    await waitFor(() => {
      expect(getRoleSyncSwitch()).not.toBeNull();
    });

    await user.click(getRoleSyncSwitch()!);

    await waitFor(() => {
      expect(mockedToast.success).toHaveBeenCalledWith('IdP role synchronization enabled');
    });
    // Verify exact payload
    expect(JSON.parse(putBody as string)).toEqual({ enabled: true });
  });

  it('save failure: reverts to last confirmed value, toast.error shown, control re-enabled', async () => {
    const user = userEvent.setup();
    mockBaseSsoLoad((path: string) => {
      if (path === '/sso/config/role-sync') return res(true, { enabled: false });
      return undefined;
    });
    mockedFetch.mockImplementation((path: string, opts?: { method?: string }) => {
      if (path === '/sso/config') return Promise.resolve(res(true, []));
      if (path === '/sso/auth-mode') return Promise.resolve(res(true, { authenticationMode: 'local_and_sso', localLoginEnabled: true }));
      if (path === '/sso/config/role-sync' && (!opts?.method || opts?.method === 'GET')) return Promise.resolve(res(true, { enabled: false }));
      if (path === '/sso/config/role-sync' && opts?.method === 'PUT') return Promise.reject(new Error('Save failed'));
      return Promise.resolve(res(true, {}));
    });

    render(<SSOSection />);
    await waitFor(() => {
      expect(getRoleSyncSwitch()).not.toBeNull();
    });

    await user.click(getRoleSyncSwitch()!);

    await waitFor(() => {
      expect(mockedToast.error).toHaveBeenCalledWith('Save failed');
    });
    // Should still show OFF (last confirmed value), not ON, and be re-enabled
    await waitFor(() => {
      const roleSyncSwitch = getRoleSyncSwitch();
      expect(roleSyncSwitch).not.toBeNull();
      expect(roleSyncSwitch).toHaveTextContent('OFF');
      expect(roleSyncSwitch?.hasAttribute('disabled')).toBeFalsy();
    });
  });

  it('save HTTP error: toasts backend message, reverts to last confirmed value', async () => {
    const user = userEvent.setup();
    mockBaseSsoLoad((path: string) => {
      if (path === '/sso/config/role-sync') return res(true, { enabled: false });
      return undefined;
    });
    mockedFetch.mockImplementation((path: string, opts?: { method?: string; body?: string }) => {
      if (path === '/sso/config') return Promise.resolve(res(true, []));
      if (path === '/sso/auth-mode') return Promise.resolve(res(true, { authenticationMode: 'local_and_sso', localLoginEnabled: true }));
      if (path === '/sso/config/role-sync' && (!opts?.method || opts?.method === 'GET')) return Promise.resolve(res(true, { enabled: false }));
      if (path === '/sso/config/role-sync' && opts?.method === 'PUT') return Promise.resolve(res(false, { error: 'Save rejected' }));
      return Promise.resolve(res(true, {}));
    });

    render(<SSOSection />);
    await waitFor(() => {
      expect(getRoleSyncSwitch()).not.toBeNull();
    });

    await user.click(getRoleSyncSwitch()!);

    await waitFor(() => {
      expect(mockedToast.error).toHaveBeenCalledWith('Save rejected');
    });
    await waitFor(() => {
      const roleSyncSwitch = getRoleSyncSwitch();
      expect(roleSyncSwitch).not.toBeNull();
      expect(roleSyncSwitch).toHaveTextContent('OFF');
      expect(roleSyncSwitch?.hasAttribute('disabled')).toBeFalsy();
    });
  });

  it('hub-local targeting: every apiFetch call passes localOnly: true', async () => {
    mockBaseSsoLoad((path: string) => {
      if (path === '/sso/config/role-sync') return res(true, { enabled: false });
      return undefined;
    });
    render(<SSOSection />);
    await waitFor(() => {
      expect(mockedFetch.mock.calls.length).toBeGreaterThan(0);
    });
    for (const [, opts] of mockedFetch.mock.calls) {
      expect((opts as { localOnly?: boolean } | undefined)?.localOnly).toBe(true);
    }
  });

  it('exact payload: PUT sends only { enabled: boolean }', async () => {
    const user = userEvent.setup();
    let putBody: string | undefined;
    mockBaseSsoLoad((path: string) => {
      if (path === '/sso/config/role-sync') return res(true, { enabled: true });
      return undefined;
    });
    mockedFetch.mockImplementation((path: string, opts?: { method?: string; body?: string }) => {
      if (path === '/sso/config') return Promise.resolve(res(true, []));
      if (path === '/sso/auth-mode') return Promise.resolve(res(true, { authenticationMode: 'local_and_sso', localLoginEnabled: true }));
      if (path === '/sso/config/role-sync' && (!opts?.method || opts?.method === 'GET')) return Promise.resolve(res(true, { enabled: true }));
      if (path === '/sso/config/role-sync' && opts?.method === 'PUT') {
        putBody = opts.body;
        return Promise.resolve(res(true, { success: true }));
      }
      return Promise.resolve(res(true, {}));
    });

    render(<SSOSection />);
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledWith('/sso/config/role-sync', { localOnly: true });
    });

    // Wait for the ON toggle to load, then click to turn off
    await waitFor(() => {
      expect(getRoleSyncSwitch()).not.toBeNull();
    });

    await user.click(getRoleSyncSwitch()!);

    await waitFor(() => {
      expect(putBody).toBeDefined();
      expect(JSON.parse(putBody as string)).toEqual({ enabled: false });
    });
  });
});
