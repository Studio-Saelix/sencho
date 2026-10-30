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

/** Provider label, falling back to the raw provider for one a newer node reports. */
export function tunnelProviderLabel(provider: TunnelProvider): string {
  return Object.prototype.hasOwnProperty.call(TUNNEL_PROVIDER_LABEL, provider)
    ? TUNNEL_PROVIDER_LABEL[provider]
    : provider;
}

/** Scope label, falling back to the raw scope for one a newer node reports. */
export function tunnelScopeLabel(scope: TunnelScope): string {
  return Object.prototype.hasOwnProperty.call(TUNNEL_SCOPE_LABEL, scope)
    ? TUNNEL_SCOPE_LABEL[scope]
    : scope;
}

/** A shared namespace is certain only behind a Tailscale or WireGuard
 *  connector, whose peers reach the service at the connector's own address. A
 *  cloudflared sidecar can reach it on localhost, but Cloudflare's ingress
 *  independently chooses the origin, so that path stays unverified. */
export function isRoutingUnverified(e: Pick<ServiceTunnelExposure, 'provider' | 'path'>): boolean {
  return !(e.path === 'shared-namespace' && (e.provider === 'tailscale' || e.provider === 'wireguard'));
}

/** "via Cloudflare Tunnel (cloudflared), routing unverified" style phrase. */
export function tunnelPathLabel(e: ServiceTunnelExposure): string {
  const base = `via ${tunnelProviderLabel(e.provider)} (${e.connector})`;
  return isRoutingUnverified(e) ? `${base}, routing unverified` : base;
}
