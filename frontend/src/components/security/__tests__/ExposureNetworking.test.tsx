/**
 * The Network exposed popover names the tunnel that makes a service exposed, so
 * a service with no published port is not left unexplained.
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
