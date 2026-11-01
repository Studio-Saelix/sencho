import { describe, expect, it } from 'vitest';
import { isRoutingUnverified, tunnelPathLabel, tunnelProviderLabel, tunnelScopeLabel } from './tunnelExposure';

describe('tunnel display helpers', () => {
  it('falls back to the raw provider or scope instead of an inherited object property', () => {
    expect(tunnelProviderLabel('constructor' as never)).toBe('constructor');
    expect(tunnelProviderLabel('toString' as never)).toBe('toString');
    expect(tunnelScopeLabel('hasOwnProperty' as never)).toBe('hasOwnProperty');
  });

  it('treats a Tailscale or WireGuard namespace reach as certain and a cloudflared one as unverified', () => {
    expect(isRoutingUnverified({ provider: 'tailscale', path: 'shared-namespace' })).toBe(false);
    expect(isRoutingUnverified({ provider: 'wireguard', path: 'shared-namespace' })).toBe(false);
    expect(isRoutingUnverified({ provider: 'cloudflared', path: 'shared-namespace' })).toBe(true);
    expect(isRoutingUnverified({ provider: 'cloudflared', path: 'shared-network' })).toBe(true);
    expect(tunnelPathLabel({ provider: 'cloudflared', connector: 'cf', scope: 'public-edge', path: 'shared-namespace' }))
      .toBe('via Cloudflare Tunnel (cf), routing unverified');
  });
});
