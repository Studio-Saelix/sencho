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
const mockedToast = toast as unknown as { error: ReturnType<typeof vi.fn> };

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
