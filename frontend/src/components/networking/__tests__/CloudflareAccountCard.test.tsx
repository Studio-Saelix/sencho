/**
 * The control instance's Cloudflare account card: who sees it, that every
 * fetch stays on the hub, that consequential verbs preview first, and that the
 * token field is write-only.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConnectedAccountView, PublicExposureZone } from '@/lib/publicExposureApi';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const flags = { experimental: true, isAdmin: true };
vi.mock('@/hooks/useExperimental', () => ({
  useExperimental: () => ({ experimental: flags.experimental, experimentalReady: true }),
}));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ isAdmin: flags.isAdmin, can: () => flags.isAdmin }),
}));

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({ toast: toastMock }));

import { CloudflareAccountCard } from '../CloudflareAccountCard';

const ACCOUNT = 'a1'.repeat(16);
const ZONE = 'c3'.repeat(16);
const TOKEN = 'cf-test-token-0123456789abcdef';
const T = Date.UTC(2026, 10, 19);

function zone(overrides: Partial<PublicExposureZone> = {}): PublicExposureZone {
  return {
    zoneRef: ZONE, name: 'example.com', enabled: true, allowedSuffixes: [], dns: 'readable', dnsCheckedAt: null,
    seenAtLastCheck: true, cleanupPending: null, checkRecordName: '_sencho-check-0123456789abcdef.example.com', ...overrides,
  };
}

function connected(overrides: Partial<ConnectedAccountView> = {}): ConnectedAccountView {
  return {
    connected: true, provider: 'cloudflare-tunnel', accountId: ACCOUNT, accountName: 'Example',
    scopes: { zoneRead: 'confirmed', tunnel: 'unconfirmed' }, lastCheck: { outcome: 'ok', at: T, detail: null },
    verifiedAt: T, connectedBy: 'admin', connectedAt: T, zonesVisible: 1, zones: [zone()], nodeEndpointCount: 0,
    ...overrides,
  };
}

function json(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

beforeEach(() => {
  apiFetchMock.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  toastMock.warning.mockReset();
  flags.experimental = true;
  flags.isAdmin = true;
});

describe('CloudflareAccountCard', () => {
  it('renders nothing and fetches nothing without the experimental flag', () => {
    flags.experimental = false;
    const { container } = render(<CloudflareAccountCard />);
    expect(container).toBeEmptyDOMElement();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('renders nothing and fetches nothing for a non-admin', () => {
    flags.isAdmin = false;
    const { container } = render(<CloudflareAccountCard />);
    expect(container).toBeEmptyDOMElement();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('asks to connect, and the token field is write-only and cleared after submit', async () => {
    apiFetchMock.mockImplementation((path: string) => (path === '/public-exposure/account' ? json({ connected: false }) : json({})));
    const user = userEvent.setup();
    render(<CloudflareAccountCard />);
    const answer = await screen.findByTestId('cloudflare-account-answer');
    expect(answer).toHaveAttribute('data-state', 'not_connected');

    await user.click(within(answer).getByRole('button', { name: 'Connect account' }));
    const tokenInput = await screen.findByLabelText('API token');
    expect(tokenInput).toHaveAttribute('type', 'password');
    expect(tokenInput).toHaveAttribute('autocomplete', 'new-password');

    apiFetchMock.mockImplementation((_path: string, init?: RequestInit) => {
      if (init?.method === 'PUT') return json({ error: 'Cloudflare rejects this token.', code: 'TOKEN_INVALID' }, 422);
      return json({ connected: false });
    });
    await user.type(screen.getByLabelText('Account ID'), ACCOUNT);
    await user.type(tokenInput, TOKEN);
    await user.click(screen.getByRole('button', { name: 'Connect account' }));

    expect(await screen.findByTestId('cloudflare-token-error')).toHaveTextContent('Cloudflare rejects this token');
    expect(screen.getByLabelText('API token')).toHaveValue('');
    const put = apiFetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
    expect(JSON.parse(String((put?.[1] as RequestInit).body))).toEqual({ token: TOKEN, accountId: ACCOUNT });
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it('sends every request to the control instance', async () => {
    apiFetchMock.mockImplementation(() => json(connected({ lastCheck: { outcome: 'cloudflare_unreachable', at: T, detail: null } })));
    const user = userEvent.setup();
    render(<CloudflareAccountCard />);
    const answer = await screen.findByTestId('cloudflare-account-answer');
    await user.click(within(answer).getByRole('button', { name: 'Recheck' }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/public-exposure/account/verify', expect.objectContaining({ method: 'POST' })));
    for (const [, options] of apiFetchMock.mock.calls) {
      expect((options as { localOnly?: boolean }).localOnly).toBe(true);
    }
  });

  it('previews the DNS write check, naming the record, before calling the API', async () => {
    apiFetchMock.mockImplementation(() => json(connected()));
    const user = userEvent.setup();
    render(<CloudflareAccountCard />);
    const answer = await screen.findByTestId('cloudflare-account-answer');
    expect(answer).toHaveAttribute('data-state', 'dns_unconfirmed');
    await user.click(within(answer).getByRole('button', { name: 'Check DNS write' }));

    const preview = await screen.findByTestId('dns-check-preview');
    expect(preview).toHaveTextContent('_sencho-check-0123456789abcdef.example.com');
    expect(preview).toHaveTextContent('TXT · TTL 60');
    expect(preview).toHaveTextContent('Deleted right away');
    expect(apiFetchMock).not.toHaveBeenCalledWith('/public-exposure/account/dns-check', expect.anything());

    await user.click(screen.getByRole('button', { name: 'Check DNS write' }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith(
      '/public-exposure/account/dns-check',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ zoneRef: ZONE }), localOnly: true }),
    ));
  });

  it('warns when the DNS check did not finish and a record may be left', async () => {
    let state = connected();
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/public-exposure/account/dns-check') {
        state = connected({ zones: [zone({ cleanupPending: { recordName: '_sencho-check-0123456789abcdef.example.com' } })] });
        return Promise.resolve(new Response(JSON.stringify(state), { status: 202 }));
      }
      return json(state);
    });
    const user = userEvent.setup();
    render(<CloudflareAccountCard />);
    const answer = await screen.findByTestId('cloudflare-account-answer');
    await user.click(within(answer).getByRole('button', { name: 'Check DNS write' }));
    await screen.findByTestId('dns-check-preview');
    await user.click(screen.getByRole('button', { name: 'Check DNS write' }));
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalledWith(expect.stringContaining('may be left in example.com')));
    expect(await screen.findByTestId('cloudflare-account-answer')).toHaveAttribute('data-state', 'cleanup_pending');
  });

  it('previews enabling a zone with what stack editors may claim, and disables in one click', async () => {
    let state = connected({ zones: [zone({ enabled: false })] });
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path.startsWith('/public-exposure/zones/')) {
        const body = JSON.parse(String(init?.body)) as { enabled: boolean; allowedSuffixes: string[] };
        state = connected({ zones: [zone({ enabled: body.enabled, allowedSuffixes: body.allowedSuffixes })] });
      }
      return json(state);
    });
    const user = userEvent.setup();
    render(<CloudflareAccountCard />);
    const answer = await screen.findByTestId('cloudflare-account-answer');
    await user.click(within(answer).getByRole('button', { name: 'Choose zones' }));

    await user.click(await screen.findByRole('switch', { name: 'Enable example.com' }));
    expect(await screen.findByText(/any unclaimed name in example.com, including example.com itself/)).toBeInTheDocument();
    expect(apiFetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/public-exposure/zones/'), expect.anything());

    await user.click(screen.getByRole('button', { name: /add suffix/i }));
    await user.type(screen.getByLabelText('Suffix 1'), 'apps.example.org');
    expect(screen.getByText('Not in the zone example.com.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable zone' })).toBeDisabled();
    await user.clear(screen.getByLabelText('Suffix 1'));
    await user.type(screen.getByLabelText('Suffix 1'), 'Apps.Example.com');
    expect(screen.getByText(/names under: apps.example.com/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enable zone' }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith(
      `/public-exposure/zones/${ZONE}`,
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ enabled: true, allowedSuffixes: ['apps.example.com'] }) }),
    ));

    await user.click(await screen.findByRole('switch', { name: 'Disable example.com' }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith(
      `/public-exposure/zones/${ZONE}`,
      expect.objectContaining({ body: JSON.stringify({ enabled: false, allowedSuffixes: ['apps.example.com'] }) }),
    ));
  });

  it('says what stays in Cloudflare before disconnecting, then disconnects on confirm', async () => {
    apiFetchMock.mockImplementation((_path: string, init?: RequestInit) => (
      init?.method === 'DELETE' ? json({ connected: false }) : json(connected({ zones: [zone({ dns: 'confirmed', dnsCheckedAt: T })] }))
    ));
    const user = userEvent.setup();
    render(<CloudflareAccountCard />);
    await screen.findByTestId('cloudflare-account-answer');
    await user.click(screen.getByRole('button', { name: 'Manage account' }));
    await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText(/nothing else is deleted there, and the token stays valid until you revoke it/)).toBeInTheDocument();
    expect(apiFetchMock).not.toHaveBeenCalledWith('/public-exposure/account', expect.objectContaining({ method: 'DELETE' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/public-exposure/account', expect.objectContaining({ method: 'DELETE', localOnly: true })));
    expect(await screen.findByTestId('cloudflare-account-answer')).toHaveAttribute('data-state', 'not_connected');
  });

  it('shows the server sentence when disconnect is refused', async () => {
    apiFetchMock.mockImplementation((_path: string, init?: RequestInit) => (
      init?.method === 'DELETE'
        ? json({ error: 'Nodes still use this Cloudflare account. Remove their Cloudflare Tunnel endpoints first.', code: 'ENDPOINTS_EXIST' }, 409)
        : json(connected({ zones: [zone({ dns: 'confirmed', dnsCheckedAt: T })] }))
    ));
    const user = userEvent.setup();
    render(<CloudflareAccountCard />);
    await screen.findByTestId('cloudflare-account-answer');
    await user.click(screen.getByRole('button', { name: 'Manage account' }));
    await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Nodes still use this Cloudflare account. Remove their Cloudflare Tunnel endpoints first.'));
    expect(toastMock.error).toHaveBeenCalledTimes(1);
  });

  it('replaces the token with the account id prefilled and the token empty, and does not repeat the verb in the toolbar', async () => {
    let state = connected({ lastCheck: { outcome: 'token_invalid', at: T, detail: null } });
    apiFetchMock.mockImplementation((_path: string, init?: RequestInit) => {
      if (init?.method === 'PUT') state = connected({ zones: [zone({ dns: 'confirmed', dnsCheckedAt: T })] });
      return json(state);
    });
    const user = userEvent.setup();
    render(<CloudflareAccountCard />);
    const answer = await screen.findByTestId('cloudflare-account-answer');
    await user.click(within(answer).getByRole('button', { name: 'Replace token' }));
    expect(await screen.findByLabelText('Account ID')).toHaveValue(ACCOUNT);
    expect(screen.getByLabelText('API token')).toHaveValue('');
    expect(screen.getAllByRole('button', { name: 'Replace token' }).length).toBe(2);
    await user.type(screen.getByLabelText('API token'), TOKEN);
    await user.click(within(screen.getByTestId('cloudflare-token-form')).getByRole('button', { name: 'Replace token' }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/public-exposure/account', expect.objectContaining({ method: 'PUT', localOnly: true })));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Cloudflare token replaced.'));
  });

  it('names the wait when Cloudflare limits a connect', async () => {
    apiFetchMock.mockImplementation((_path: string, init?: RequestInit) => (
      init?.method === 'PUT' ? json({ error: 'Cloudflare is limiting requests. Try again shortly.', code: 'CLOUDFLARE_RATE_LIMITED', retryAfterSeconds: 40 }, 503) : json({ connected: false })
    ));
    const user = userEvent.setup();
    render(<CloudflareAccountCard />);
    const answer = await screen.findByTestId('cloudflare-account-answer');
    await user.click(within(answer).getByRole('button', { name: 'Connect account' }));
    await user.type(await screen.findByLabelText('Account ID'), ACCOUNT);
    await user.type(screen.getByLabelText('API token'), TOKEN);
    await user.click(within(screen.getByTestId('cloudflare-token-form')).getByRole('button', { name: 'Connect account' }));
    expect(await screen.findByTestId('cloudflare-token-error')).toHaveTextContent('Try again in 40 s.');
  });

  it('shows a load failure with Retry', async () => {
    apiFetchMock.mockImplementation(() => json({ error: 'boom' }, 500));
    const user = userEvent.setup();
    render(<CloudflareAccountCard />);
    const answer = await screen.findByTestId('status-answer');
    expect(answer).toHaveTextContent('Could not load the Cloudflare connection');
    apiFetchMock.mockImplementation(() => json({ connected: false }));
    await user.click(within(answer).getByRole('button', { name: /retry/i }));
    expect(await screen.findByTestId('cloudflare-account-answer')).toHaveAttribute('data-state', 'not_connected');
  });
});
