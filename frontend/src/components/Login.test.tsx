import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Login } from './Login';

const loginMock = vi.fn().mockResolvedValue({ success: true });
const ssoLdapLoginMock = vi.fn().mockResolvedValue({ success: true });

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ login: loginMock, ssoLdapLogin: ssoLdapLoginMock }),
}));

function mockAuthDiscovery(providers: Array<{ provider: string; displayName: string; type: string }> = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/auth/status')) {
        return { ok: true, json: async () => ({ localLoginEnabled: true }) };
      }
      if (url.includes('/api/auth/sso/providers')) {
        return { ok: true, json: async () => providers };
      }
      return { ok: false, json: async () => ({}) };
    }),
  );
}

beforeEach(() => {
  loginMock.mockClear();
  ssoLdapLoginMock.mockClear();
  mockAuthDiscovery();
});

async function waitForPasswordForm() {
  await waitFor(() => expect(screen.getByLabelText('Username')).toBeInTheDocument());
}

async function fillCredentials() {
  await waitForPasswordForm();
  await userEvent.type(screen.getByLabelText('Username'), 'admin');
  await userEvent.type(screen.getByLabelText('Password'), 'password123');
}

describe('Login "Stay signed in"', () => {
  it('submits remember=false by default', async () => {
    render(<Login />);
    await fillCredentials();
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(loginMock).toHaveBeenCalledWith('admin', 'password123', false));
  });

  it('submits remember=true when the checkbox is checked', async () => {
    render(<Login />);
    await fillCredentials();
    await userEvent.click(screen.getByLabelText('Stay signed in'));
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(loginMock).toHaveBeenCalledWith('admin', 'password123', true));
  });

  it('threads remember=true through the LDAP form too', async () => {
    mockAuthDiscovery([{ provider: 'ldap', displayName: 'Directory', type: 'ldap' }]);
    render(<Login />);
    await waitFor(() => expect(screen.getByText('LDAP')).toBeInTheDocument());
    await userEvent.click(screen.getByText('LDAP'));
    await fillCredentials();
    await userEvent.click(screen.getByLabelText('Stay signed in'));
    await userEvent.click(screen.getByRole('button', { name: /sign in with ldap/i }));

    await waitFor(() => expect(ssoLdapLoginMock).toHaveBeenCalledWith('admin', 'password123', true));
  });
});
