import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getTrustedProxyBlockList,
  getTrustedProxyPolicy,
  isTrustedProxyPeer,
  logTrustedProxyConfiguration,
  resetTrustedProxyBlockListCache,
} from '../helpers/trustedProxyCidrs';

describe('trustedProxyCidrs', () => {
  beforeEach(() => {
    delete process.env.SENCHO_TRUSTED_PROXY_CIDRS;
    resetTrustedProxyBlockListCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it('fails closed on invalid entries and reports each reason', () => {
    process.env.SENCHO_TRUSTED_PROXY_CIDRS = '10.0.0.0/8,not-a-cidr,10.1.0.0/33';
    resetTrustedProxyBlockListCache();
    const policy = getTrustedProxyPolicy();
    expect(getTrustedProxyBlockList()).toBeNull();
    expect(policy.rejected).toEqual([
      { entry: 'not-a-cidr', reason: expect.stringContaining('not a CIDR') },
      { entry: '10.1.0.0/33', reason: expect.stringContaining('out of range') },
    ]);
  });

  it('fails closed on duplicate entries', () => {
    process.env.SENCHO_TRUSTED_PROXY_CIDRS = '10.0.0.0/8,10.0.0.0/8';
    resetTrustedProxyBlockListCache();
    expect(getTrustedProxyBlockList()).toBeNull();
    expect(getTrustedProxyPolicy().rejected).toEqual([
      { entry: '10.0.0.0/8', reason: 'duplicate entry' },
    ]);
  });

  it('tells a bare IP to add a prefix length', () => {
    process.env.SENCHO_TRUSTED_PROXY_CIDRS = '192.168.1.50';
    resetTrustedProxyBlockListCache();
    expect(getTrustedProxyPolicy().rejected).toEqual([
      { entry: '192.168.1.50', reason: expect.stringContaining('/32') },
    ]);
  });

  it('rejects a prefix that is not plain digits', () => {
    process.env.SENCHO_TRUSTED_PROXY_CIDRS = '10.2.0.0/0x10';
    resetTrustedProxyBlockListCache();
    expect(getTrustedProxyPolicy().rejected).toEqual([
      { entry: '10.2.0.0/0x10', reason: expect.stringContaining('not a number') },
    ]);
  });

  it('warns at boot when entries are rejected, once per policy', () => {
    process.env.SENCHO_TRUSTED_PROXY_CIDRS = '192.168.1.50';
    resetTrustedProxyBlockListCache();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    logTrustedProxyConfiguration();
    logTrustedProxyConfiguration();

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('[TrustProxy]');
    expect(message).toContain('192.168.1.50');
    expect(message).toContain('X-Forwarded-* headers will be ignored');
  });

  it('logs the trusted peers at boot when the list is valid', () => {
    process.env.SENCHO_TRUSTED_PROXY_CIDRS = '10.0.0.0/8';
    resetTrustedProxyBlockListCache();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    logTrustedProxyConfiguration();

    expect(warn).not.toHaveBeenCalled();
    expect(String(log.mock.calls[0][0])).toContain('Trusting X-Forwarded-* headers from: 10.0.0.0/8');
  });

  it('logs that forwarded headers are ignored at boot when unset', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    logTrustedProxyConfiguration();
    logTrustedProxyConfiguration();

    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain('SENCHO_TRUSTED_PROXY_CIDRS is not set');
  });
});
