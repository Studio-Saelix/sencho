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

/**
 * Request scheme for a WebSocket upgrade, mirroring Express's `req.protocol`:
 * the connection scheme unless the direct peer is a trusted proxy, in which
 * case the first `X-Forwarded-Proto` value is passed through verbatim, exactly
 * as Express does, falling back to the connection scheme when the header is
 * absent. Express middleware never runs on an upgrade, so a handler that
 * forwards the scheme resolves it here.
 */
export function resolveUpgradeProtocol(req: IncomingMessage): string {
  const encrypted = (req.socket as { encrypted?: boolean }).encrypted === true;
  const fallback = encrypted ? 'https' : 'http';
  const peer = req.socket.remoteAddress ?? '';
  if (!isTrustedProxyPeer(peer)) return fallback;

  const header = req.headers['x-forwarded-proto'];
  const first = (Array.isArray(header) ? header[0] : header)?.split(',')[0]?.trim();
  return first || fallback;
}
