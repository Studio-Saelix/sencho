import net from 'net';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { FORWARDING_HEADER_NAMES, getTrustedProxyPolicy, isTrustedProxyPeer } from '../helpers/trustedProxyCidrs';
import { sanitizeForLog } from '../utils/safeLog';

const FORWARDING_HEADERS = FORWARDING_HEADER_NAMES;

/** Cap on distinct peers warned about, so a directly exposed instance cannot flood the log. */
const MAX_LOGGED_PEERS = 16;

function hasForwardingHeader(req: Request): boolean {
  const headers = req.headers ?? {};
  return FORWARDING_HEADERS.some((name) => {
    const value = headers[name];
    if (typeof value === 'string') return value.trim() !== '';
    return Array.isArray(value) && value.some(part => part.trim() !== '');
  });
}

/** Drop an IPv6 zone id and unwrap an IPv4-mapped address, so one host has one identity. */
function normalizePeer(peer: string): string {
  const bare = peer.split('%')[0];
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare)?.[1];
  return mapped ?? bare;
}

/** The CIDR an operator should paste for this peer address. */
function peerCidr(peer: string): string {
  return net.isIP(peer) === 6 ? `${peer}/128` : `${peer}/32`;
}

/**
 * Warn once per untrusted peer when a request carries forwarding headers that
 * Sencho is ignoring because the direct peer is not listed in
 * SENCHO_TRUSTED_PROXY_CIDRS.
 *
 * A reverse-proxy deployment with no CIDR configured keeps working, but
 * silently uses the proxy as the client for everything: client addresses,
 * secure-cookie detection, SSO callback URLs, Pilot enrollment URLs, and
 * rate-limit keys. This middleware is the runtime half of making that failure
 * loud; `logTrustedProxyConfiguration` covers the boot half. It only observes
 * and logs, so it runs before every middleware that keys on client identity and
 * never touches the response.
 */
export function createTrustedProxyWarning(): RequestHandler {
  const loggedPeers = new Set<string>();
  let capWarned = false;

  return (req: Request, _res: Response, next: NextFunction): void => {
    if (hasForwardingHeader(req)) {
      const peer = normalizePeer(req.socket?.remoteAddress ?? '');
      if (peer && !isTrustedProxyPeer(peer)) {
        if (!loggedPeers.has(peer) && loggedPeers.size < MAX_LOGGED_PEERS) {
          loggedPeers.add(peer);
          const policy = getTrustedProxyPolicy();
          let suggestion: string;
          if (!policy.configured) {
            suggestion = `set SENCHO_TRUSTED_PROXY_CIDRS=${sanitizeForLog(peerCidr(peer))} and restart`;
          } else if (policy.blockList) {
            suggestion = `add ${sanitizeForLog(peerCidr(peer))} to SENCHO_TRUSTED_PROXY_CIDRS and restart`;
          } else {
            suggestion = 'fix the rejected SENCHO_TRUSTED_PROXY_CIDRS entries reported at startup and restart';
          }
          console.warn(
            `[TrustProxy] Ignoring X-Forwarded-* headers from untrusted peer ${sanitizeForLog(peer)}. `
            + `If that is your reverse proxy, ${suggestion}. `
            + 'Until then client addresses, secure cookies, SSO callback URLs, and rate-limit keys reflect the proxy, not the client.',
          );
        } else if (!loggedPeers.has(peer) && !capWarned) {
          capWarned = true;
          console.warn(
            `[TrustProxy] Ignoring X-Forwarded-* headers from more than ${MAX_LOGGED_PEERS} untrusted peers; further peers will not be logged.`,
          );
        }
      }
    }
    next();
  };
}
