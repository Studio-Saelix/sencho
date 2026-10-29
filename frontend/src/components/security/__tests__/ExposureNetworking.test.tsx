/**
 * The Network exposed control names the tunnel that makes a service exposed (on
 * the badge for one context, in the list for several), so a service with no
 * published port is not left unexplained.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NetworkExposedControl } from '../ExposureNetworking';
import type { ImageExposureContext } from '@/types/security';

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
