import type { IncomingMessage } from 'http';
import { isTrustedProxyPeer } from './trustedProxyCidrs';

/**
 * Client IP for a WebSocket upgrade.
 *
 * Express middleware never runs on an upgrade, so `req.ip` and the `trust proxy`
 * setting do not apply here. A handler that records or keys on an IP resolves it
 * through this function so the upgrade path honors the same trust rule as the
 * HTTP path (`app.set('trust proxy', (address) => isTrustedProxyPeer(address))`).
 *
 * Mirrors proxy-addr: a forwarded hop counts only when the direct peer is a
 * trusted proxy, and the client is the leftmost hop that no trusted proxy
 * supplied (the whole chain being trusted, it is the leftmost entry).
 */
export function resolveUpgradeClientIp(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? '';
  const header = req.headers['x-forwarded-for'];
  const hops = typeof header === 'string'
    ? header.split(',').map((hop) => hop.trim()).filter(Boolean)
    : [];
  if (hops.length === 0 || !isTrustedProxyPeer(peer)) return peer;

  for (let i = hops.length - 1; i >= 0; i--) {
    if (!isTrustedProxyPeer(hops[i])) return hops[i];
  }
  return hops[0];
}
