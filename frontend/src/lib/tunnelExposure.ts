/**
 * Display helpers for tunnel and private-overlay exposure (Cloudflare Tunnel,
 * Tailscale, WireGuard), shared by the stack Networking tab, the Dossier
 * export, and the Security exposure contexts so they name a tunnel the same way.
 */
import type { ServiceTunnelExposure, TunnelProvider, TunnelScope } from '@/types/networking';

export const TUNNEL_PROVIDER_LABEL: Record<TunnelProvider, string> = {
  cloudflared: 'Cloudflare Tunnel',
  tailscale: 'Tailscale',
  wireguard: 'WireGuard',
};

export const TUNNEL_SCOPE_LABEL: Record<TunnelScope, string> = {
  'public-edge': 'public edge',
  'private-overlay': 'private overlay',
};

/** "via Cloudflare Tunnel (cloudflared), routing unverified" style phrase. */
export function tunnelPathLabel(e: ServiceTunnelExposure): string {
  const base = `via ${TUNNEL_PROVIDER_LABEL[e.provider]} (${e.connector})`;
  return e.path === 'shared-network' ? `${base}, routing unverified` : base;
}
