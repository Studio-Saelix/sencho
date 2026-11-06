/**
 * The Network exposed control names the tunnel that makes a service exposed (on
 * the badge for one context, in the list for several), so a service with no
 * published port is not left unexplained. Where the session may edit the stack
 * it also sets the exposure intent in place, and names the stack's networking
 * as the way out for work that lives there.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NetworkExposedControl, ViewNetworkingAction } from '../ExposureNetworking';
import { SENCHO_OPEN_STACK_EVENT, type SenchoOpenStackDetail } from '@/lib/events';
import type { ImageExposureContext } from '@/types/security';

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));
const auth = vi.hoisted(() => ({ can: vi.fn() }));
vi.mock('@/lib/api', () => ({ apiFetch: api.apiFetch }));
vi.mock('@/components/ui/toast-store', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ can: auth.can }) }));

const json = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;

beforeEach(() => {
  api.apiFetch.mockReset();
  auth.can.mockReset();
  auth.can.mockReturnValue(false);
});

const contexts: ImageExposureContext[] = [
  {
    stackName: 'web', serviceName: 'app', exposureReason: 'tunnel', intentStatus: 'unset',
    tunnel: { connector: 'cloudflared', provider: 'cloudflared', scope: 'public-edge', path: 'shared-network' },
  },
  {
    stackName: 'vpn', serviceName: 'admin', exposureReason: 'tunnel', intentStatus: 'set', exposureIntent: 'internal', intentConflict: true,
    tunnel: { connector: 'tailscale', provider: 'tailscale', scope: 'private-overlay', path: 'shared-namespace' },
  },
  { stackName: 'web', serviceName: 'proxy', exposureReason: 'published-port', intentStatus: 'set', exposureIntent: 'public' },
];

describe('NetworkExposedControl with tunnel contexts', () => {
  it('lists the tunnel path under each tunnel-exposed service', async () => {
    render(<NetworkExposedControl contexts={contexts} nodeId={1} />);
    fireEvent.click(screen.getByRole('button', { name: 'View networking contexts' }));
    expect(await screen.findByText('via Cloudflare Tunnel (cloudflared), routing unverified')).toBeInTheDocument();
    expect(screen.getByText('via Tailscale (tailscale)')).toBeInTheDocument();
    expect(screen.getByText('Intent mismatch')).toBeInTheDocument();
    expect(screen.queryAllByText(/^via /)).toHaveLength(2);
  });
});

describe('NetworkExposedControl with one context', () => {
  it('marks the badge as a tunnel and names the path in its label', () => {
    render(<NetworkExposedControl contexts={[contexts[0]!]} nodeId={1} />);
    const button = screen.getByRole('button', { name: 'View networking for web/app, via Cloudflare Tunnel (cloudflared), routing unverified' });
    expect(button).toHaveTextContent('Network exposed · tunnel');
    expect(button).toHaveAttribute('title', 'via Cloudflare Tunnel (cloudflared), routing unverified');
  });

  it('keeps the plain badge for a published port', () => {
    render(<NetworkExposedControl contexts={[contexts[2]!]} nodeId={1} />);
    expect(screen.getByRole('button', { name: 'View networking for web/proxy' })).toHaveTextContent(/^Network exposed$/);
  });
});

describe('exposure intent in place', () => {
  const unset: ImageExposureContext = { stackName: 'web', serviceName: 'app', exposureReason: 'published-port', intentStatus: 'unset' };
  const conflict: ImageExposureContext = {
    stackName: 'vpn', serviceName: 'admin', exposureReason: 'published-port', intentStatus: 'set', exposureIntent: 'internal', intentConflict: true,
  };

  it('saves the intent from the badge with the second click and reports it', async () => {
    auth.can.mockReturnValue(true);
    api.apiFetch.mockResolvedValueOnce(json({ intents: [] }));
    api.apiFetch.mockResolvedValueOnce(json({ intents: [{ service: 'app', intent: 'lan' }] }));
    const onIntentSaved = vi.fn();
    render(<NetworkExposedControl contexts={[unset]} nodeId={3} onIntentSaved={onIntentSaved} />);

    await userEvent.click(screen.getByRole('button', { name: 'Set intent for web/app' }));
    await userEvent.click(await screen.findByRole('button', { name: 'lan' }));

    await waitFor(() => expect(onIntentSaved).toHaveBeenCalledTimes(1));
    const [path, init] = api.apiFetch.mock.calls[1] as [string, RequestInit & { nodeId?: number }];
    expect(path).toBe('/stacks/web/exposure');
    expect(init.nodeId).toBe(3);
    expect(JSON.parse(init.body as string)).toEqual({ service: 'app', intent: 'lan' });
    expect(auth.can).toHaveBeenCalledWith('stack:edit', 'stack', 'web', 3);
  });

  it('offers Change intent for a conflict and names the stack networking as a link', async () => {
    auth.can.mockReturnValue(true);
    api.apiFetch.mockResolvedValueOnce(json({ intents: [{ service: 'admin', intent: 'internal' }] }));
    const opened: SenchoOpenStackDetail[] = [];
    const listener = (e: Event) => opened.push((e as CustomEvent<SenchoOpenStackDetail>).detail);
    window.addEventListener(SENCHO_OPEN_STACK_EVENT, listener);
    render(<ViewNetworkingAction contexts={[conflict]} nodeId={3} />);

    await userEvent.click(screen.getByRole('button', { name: 'Change intent' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Open stack networking' }));
    window.removeEventListener(SENCHO_OPEN_STACK_EVENT, listener);

    expect(opened).toEqual([{ nodeId: 3, stackName: 'vpn', destination: 'anatomy-networking' }]);
  });

  it('puts a verb on each row of the list and leaves the name as the navigation', async () => {
    auth.can.mockReturnValue(true);
    render(<NetworkExposedControl contexts={[unset, conflict]} nodeId={3} />);
    await userEvent.click(screen.getByRole('button', { name: 'View networking contexts' }));
    expect(await screen.findByRole('button', { name: 'Set intent for web/app' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change intent for vpn/admin' })).toBeInTheDocument();
  });

  it('keeps the navigation when the session cannot edit the stack', () => {
    render(<NetworkExposedControl contexts={[unset]} nodeId={3} />);
    expect(screen.getByRole('button', { name: 'View networking for web/app' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /intent/i })).toBeNull();
  });

  it('keeps the navigation when the intent could not be read', () => {
    auth.can.mockReturnValue(true);
    render(<ViewNetworkingAction contexts={[{ ...unset, intentStatus: 'unavailable' }]} nodeId={3} />);
    expect(screen.getByRole('button', { name: 'View networking' })).toBeInTheDocument();
  });
});
