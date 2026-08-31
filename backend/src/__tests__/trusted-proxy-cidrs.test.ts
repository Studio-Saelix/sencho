import { describe, it, expect, beforeEach } from 'vitest';
import {
  getTrustedProxyBlockList,
  isTrustedProxyPeer,
  resetTrustedProxyBlockListCache,
} from '../helpers/trustedProxyCidrs';

describe('trustedProxyCidrs', () => {
  beforeEach(() => {
    delete process.env.SENCHO_TRUSTED_PROXY_CIDRS;
    resetTrustedProxyBlockListCache();
  });

  it('returns null when unset', () => {
    expect(getTrustedProxyBlockList()).toBeNull();
    expect(isTrustedProxyPeer('10.0.0.1')).toBe(false);
  });

  it('matches IPv4 CIDR members', () => {
    process.env.SENCHO_TRUSTED_PROXY_CIDRS = '10.0.0.0/8';
    resetTrustedProxyBlockListCache();
    expect(isTrustedProxyPeer('10.1.2.3')).toBe(true);
    expect(isTrustedProxyPeer('192.168.1.1')).toBe(false);
  });

  it('matches IPv4-mapped IPv6 peers against IPv4 CIDRs', () => {
    process.env.SENCHO_TRUSTED_PROXY_CIDRS = '10.0.0.0/8';
    resetTrustedProxyBlockListCache();
    expect(isTrustedProxyPeer('::ffff:10.1.2.3')).toBe(true);
    expect(isTrustedProxyPeer('::ffff:192.168.1.1')).toBe(false);
  });

  it('fails closed on invalid entries', () => {
    process.env.SENCHO_TRUSTED_PROXY_CIDRS = 'not-a-cidr';
    resetTrustedProxyBlockListCache();
    expect(getTrustedProxyBlockList()).toBeNull();
  });

  it('fails closed on duplicate entries', () => {
    process.env.SENCHO_TRUSTED_PROXY_CIDRS = '10.0.0.0/8,10.0.0.0/8';
    resetTrustedProxyBlockListCache();
    expect(getTrustedProxyBlockList()).toBeNull();
  });
});
