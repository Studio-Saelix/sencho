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
import type { ImageExposureContextRef } from '../imagesTargeting';

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

const contexts: ImageExposureContextRef[] = [
  {
    imageRef: 'exp:1', stackName: 'web', serviceName: 'app', exposureReason: 'tunnel', intentStatus: 'unset',
    tunnel: { connector: 'cloudflared', provider: 'cloudflared', scope: 'public-edge', path: 'shared-network' },
  },
  {
    imageRef: 'exp:1', stackName: 'vpn', serviceName: 'admin', exposureReason: 'tunnel', intentStatus: 'set', exposureIntent: 'internal', intentConflict: true,
    tunnel: { connector: 'tailscale', provider: 'tailscale', scope: 'private-overlay', path: 'shared-namespace' },
  },
  { imageRef: 'exp:1', stackName: 'web', serviceName: 'proxy', exposureReason: 'published-port', intentStatus: 'set', exposureIntent: 'public' },
];

describe('NetworkExposedControl with tunnel contexts', () => {
  it('lists the tunnel path under each tunnel-exposed service', async () => {
    render(<NetworkExposedControl contexts={contexts} imageRef="exp:1" nodeId={1} onIntentSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'View networking contexts' }));
    expect(await screen.findByText('via Cloudflare Tunnel (cloudflared), routing unverified')).toBeInTheDocument();
    expect(screen.getByText('via Tailscale (tailscale)')).toBeInTheDocument();
    expect(screen.getByText('Intent mismatch')).toBeInTheDocument();
    expect(screen.queryAllByText(/^via /)).toHaveLength(2);
  });
});

describe('NetworkExposedControl with one context', () => {
  it('marks the badge as a tunnel and names the path in its label', () => {
    render(<NetworkExposedControl contexts={[contexts[0]!]} imageRef="exp:1" nodeId={1} onIntentSaved={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'View networking for web/app, via Cloudflare Tunnel (cloudflared), routing unverified' });
    expect(button).toHaveTextContent('Network exposed · tunnel');
    expect(button).toHaveAttribute('title', 'via Cloudflare Tunnel (cloudflared), routing unverified');
  });

  it('keeps the plain badge for a published port', () => {
    render(<NetworkExposedControl contexts={[contexts[2]!]} imageRef="exp:1" nodeId={1} onIntentSaved={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'View networking for web/proxy' })).toHaveTextContent(/^Network exposed$/);
  });
});

describe('exposure intent in place', () => {
  const unset: ImageExposureContextRef = { imageRef: 'exp:1', stackName: 'web', serviceName: 'app', exposureReason: 'published-port', intentStatus: 'unset' };
  const conflict: ImageExposureContextRef = {
    imageRef: 'exp:1', stackName: 'vpn', serviceName: 'admin', exposureReason: 'published-port', intentStatus: 'set', exposureIntent: 'internal', intentConflict: true,
  };

  it('saves the intent from the badge with the second click and reports it', async () => {
    auth.can.mockReturnValue(true);
    api.apiFetch.mockResolvedValueOnce(json({ intents: [] }));
    api.apiFetch.mockResolvedValueOnce(json({ intents: [{ service: 'app', intent: 'lan' }] }));
    const onIntentSaved = vi.fn();
    render(<NetworkExposedControl contexts={[unset]} imageRef="exp:1" nodeId={3} onIntentSaved={onIntentSaved} />);

    await userEvent.click(screen.getByRole('button', { name: 'Network exposed: set intent for web/app' }));
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
    render(<ViewNetworkingAction contexts={[conflict]} nodeId={3} onIntentSaved={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: 'Change intent' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Open stack networking' }));
    window.removeEventListener(SENCHO_OPEN_STACK_EVENT, listener);

    expect(opened).toEqual([{ nodeId: 3, stackName: 'vpn', destination: 'anatomy-networking' }]);
  });

  it('puts a verb on each row of the list and leaves the name as the navigation', async () => {
    auth.can.mockReturnValue(true);
    render(<NetworkExposedControl contexts={[unset, conflict]} imageRef="exp:1" nodeId={3} onIntentSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Network exposed: choose a service' }));
    expect(await screen.findByRole('button', { name: 'Set intent for web/app' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change intent for vpn/admin' })).toBeInTheDocument();
  });

  it('keeps the navigation when the session cannot edit the stack', () => {
    render(<NetworkExposedControl contexts={[unset]} imageRef="exp:1" nodeId={3} onIntentSaved={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'View networking for web/app' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /intent/i })).toBeNull();
  });

  it('keeps the navigation when the intent could not be read', () => {
    auth.can.mockReturnValue(true);
    render(<ViewNetworkingAction contexts={[{ ...unset, intentStatus: 'unavailable' }]} nodeId={3} onIntentSaved={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'View networking' })).toBeInTheDocument();
  });
});

describe('multi-context trigger names', () => {
  const a: ImageExposureContextRef = { imageRef: 'exp:1', stackName: 'web', serviceName: 'app', exposureReason: 'published-port', intentStatus: 'unset' };
  const b: ImageExposureContextRef = { imageRef: 'exp:1', stackName: 'jobs', serviceName: 'worker', exposureReason: 'published-port', intentStatus: 'unset' };

  it('reads as choosing a service on the banner when the rows carry a verb', () => {
    auth.can.mockReturnValue(true);
    render(<ViewNetworkingAction contexts={[a, b]} nodeId={3} onIntentSaved={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Choose service' })).toBeInTheDocument();
  });

  it('keeps the networking wording on the banner when no row can set an intent', () => {
    render(<ViewNetworkingAction contexts={[a, b]} nodeId={3} onIntentSaved={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'View networking' })).toBeInTheDocument();
  });
});

describe('phone touch targets', () => {
  const PHONE = /max-md:min-h-11/;
  const a: ImageExposureContextRef = { imageRef: 'exp:1', stackName: 'web', serviceName: 'app', exposureReason: 'published-port', intentStatus: 'unset' };
  const b: ImageExposureContextRef = { imageRef: 'exp:1', stackName: 'jobs', serviceName: 'worker', exposureReason: 'published-port', intentStatus: 'unset' };

  it.each([
    ['a single context that sets its intent in place', true],
    ['a single context that only names the networking', false],
  ])('gives the badge of %s the phone height', (_name, canEdit) => {
    auth.can.mockReturnValue(canEdit);
    render(<NetworkExposedControl contexts={[a]} imageRef="exp:1" nodeId={3} onIntentSaved={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^(Network exposed: set intent|View networking) for web\/app$/ }).className).toMatch(PHONE);
  });

  it.each([
    ['the rows carry a verb', true, 'Network exposed: choose a service'],
    ['no row can set an intent', false, 'View networking contexts'],
  ])('gives the multi-context badge the phone height when %s', (_name, canEdit, label) => {
    auth.can.mockReturnValue(canEdit);
    render(<NetworkExposedControl contexts={[a, b]} imageRef="exp:1" nodeId={3} onIntentSaved={vi.fn()} />);
    expect(screen.getByRole('button', { name: label }).className).toMatch(PHONE);
  });

  it('keeps the height and the flex layout phone-only on the badge', () => {
    render(<NetworkExposedControl contexts={[a]} imageRef="exp:1" nodeId={3} onIntentSaved={vi.fn()} />);
    const badge = screen.getByRole('button', { name: 'View networking for web/app' });
    expect(badge).toHaveClass('hover:underline', 'max-md:inline-flex', 'max-md:items-center');
    expect(badge.className).not.toMatch(/(^|\s)(min-h-11|inline-flex)/);
  });

  it('gives the popover footer link and the list-row navigation the phone height', async () => {
    auth.can.mockReturnValue(true);
    render(<NetworkExposedControl contexts={[a, b]} imageRef="exp:1" nodeId={3} onIntentSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Network exposed: choose a service' }));
    const rowNav = (await screen.findAllByTitle('Open stack networking'))[0]!;
    expect(rowNav.className).toMatch(PHONE);
    await userEvent.click(await screen.findByRole('button', { name: 'Set intent for web/app' }));
    expect((await screen.findByRole('button', { name: 'Open stack networking' })).className).toMatch(PHONE);
  });
});
