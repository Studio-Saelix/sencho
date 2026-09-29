import { IncomingMessage } from 'http';
import { Socket } from 'net';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveUpgradeClientIp } from '../helpers/clientIp';
import { resetTrustedProxyBlockListCache } from '../helpers/trustedProxyCidrs';

/** An upgrade request as Node hands it to a WebSocket handler. */
function upgradeRequest(peer: string | undefined, forwardedFor?: string): IncomingMessage {
  const socket = new Socket();
  // net.Socket exposes remoteAddress as a getter over the handle, so an
  // unconnected socket has none; define it to stand in for a real peer.
  Object.defineProperty(socket, 'remoteAddress', { value: peer, configurable: true });
  const req = new IncomingMessage(socket);
  if (forwardedFor !== undefined) req.headers['x-forwarded-for'] = forwardedFor;
  return req;
}

describe('resolveUpgradeClientIp', () => {
  beforeEach(() => {
    delete process.env.SENCHO_TRUSTED_PROXY_CIDRS;
    resetTrustedProxyBlockListCache();
  });

  it('ignores a forwarded address from an untrusted peer', () => {
    process.env.SENCHO_TRUSTED_PROXY_CIDRS = '10.0.0.0/8';
    resetTrustedProxyBlockListCache();
    const req = upgradeRequest('198.51.100.7', '203.0.113.50');
    expect(resolveUpgradeClientIp(req)).toBe('198.51.100.7');
  });

  it('ignores a forwarded address when no proxy is configured', () => {
    const req = upgradeRequest('198.51.100.7', '203.0.113.50');
    expect(resolveUpgradeClientIp(req)).toBe('198.51.100.7');
  });

  it('honors a forwarded address from a trusted proxy peer', () => {
    process.env.SENCHO_TRUSTED_PROXY_CIDRS = '10.0.0.0/8';
    resetTrustedProxyBlockListCache();
    const req = upgradeRequest('10.0.0.5', '203.0.113.50');
    expect(resolveUpgradeClientIp(req)).toBe('203.0.113.50');
  });

  it('matches an IPv4-mapped proxy peer against an IPv4 CIDR', () => {
    process.env.SENCHO_TRUSTED_PROXY_CIDRS = '10.0.0.0/8';
    resetTrustedProxyBlockListCache();
    const req = upgradeRequest('::ffff:10.0.0.5', '203.0.113.50');
    expect(resolveUpgradeClientIp(req)).toBe('203.0.113.50');
  });

  it('skips a trusted intermediate proxy hop', () => {
    process.env.SENCHO_TRUSTED_PROXY_CIDRS = '10.0.0.0/8';
    resetTrustedProxyBlockListCache();
    // 10.0.0.5 saw the client, 10.0.0.7 saw 10.0.0.5 and appended it.
    const req = upgradeRequest('10.0.0.5', '203.0.113.50, 10.0.0.7');
    expect(resolveUpgradeClientIp(req)).toBe('203.0.113.50');
  });

  it('ignores hops left of the first untrusted one', () => {
    process.env.SENCHO_TRUSTED_PROXY_CIDRS = '10.0.0.0/8';
    resetTrustedProxyBlockListCache();
    // An unlisted upstream prepended junk; only the nearest hop is trustworthy.
    const req = upgradeRequest('10.0.0.5', 'not-an-ip, 203.0.113.50');
    expect(resolveUpgradeClientIp(req)).toBe('203.0.113.50');
  });

  it('takes the client when a trusted hop sits left of it', () => {
    process.env.SENCHO_TRUSTED_PROXY_CIDRS = '10.0.0.0/8';
    resetTrustedProxyBlockListCache();
    // A trusted proxy to the left of the client entry must not become the
    // recorded address, which is the case a plain "first hop wins" read gets
    // wrong. Express reports 203.0.113.50 for this same request.
    const req = upgradeRequest('10.0.0.5', '10.0.0.9, 203.0.113.50');
    expect(resolveUpgradeClientIp(req)).toBe('203.0.113.50');
  });

  it('ignores the RFC 7239 Forwarded header', () => {
    process.env.SENCHO_TRUSTED_PROXY_CIDRS = '10.0.0.0/8';
    resetTrustedProxyBlockListCache();
    // Only x-forwarded-for is read, which is what Express honors by default.
    const req = upgradeRequest('10.0.0.5');
    req.headers.forwarded = 'for=203.0.113.50;proto=https';
    expect(resolveUpgradeClientIp(req)).toBe('10.0.0.5');
  });

  it('returns the leftmost hop when every hop is a trusted proxy', () => {
    process.env.SENCHO_TRUSTED_PROXY_CIDRS = '10.0.0.0/8';
    resetTrustedProxyBlockListCache();
    // Two trusted proxies appended their predecessors, so every hop the walk
    // sees is a configured proxy and the leftmost entry is the original
    // client, which is what Express reports for the same chain.
    const req = upgradeRequest('10.0.0.5', '10.0.0.9, 10.0.0.7, 10.0.0.8');
    expect(resolveUpgradeClientIp(req)).toBe('10.0.0.9');
  });

  it('fails closed on a malformed proxy CIDR', () => {
    process.env.SENCHO_TRUSTED_PROXY_CIDRS = 'not-a-cidr';
    resetTrustedProxyBlockListCache();
    const req = upgradeRequest('10.0.0.5', '203.0.113.50');
    expect(resolveUpgradeClientIp(req)).toBe('10.0.0.5');
  });

  it('honors a forwarded address for an IPv6 proxy peer', () => {
    process.env.SENCHO_TRUSTED_PROXY_CIDRS = 'fd12:3456:789a::50/128';
    resetTrustedProxyBlockListCache();
    const req = upgradeRequest('fd12:3456:789a::50', '203.0.113.50');
    expect(resolveUpgradeClientIp(req)).toBe('203.0.113.50');
  });

  it('returns the peer address when no forwarded header is present', () => {
    process.env.SENCHO_TRUSTED_PROXY_CIDRS = '10.0.0.0/8';
    resetTrustedProxyBlockListCache();
    expect(resolveUpgradeClientIp(upgradeRequest('10.0.0.5'))).toBe('10.0.0.5');
  });

  it('returns the peer address for an empty forwarded header', () => {
    process.env.SENCHO_TRUSTED_PROXY_CIDRS = '10.0.0.0/8';
    resetTrustedProxyBlockListCache();
    expect(resolveUpgradeClientIp(upgradeRequest('10.0.0.5', '  '))).toBe('10.0.0.5');
  });

  it('fails closed when the socket has no peer address', () => {
    process.env.SENCHO_TRUSTED_PROXY_CIDRS = '10.0.0.0/8';
    resetTrustedProxyBlockListCache();
    expect(resolveUpgradeClientIp(upgradeRequest(undefined, '203.0.113.50'))).toBe('');
  });
});
