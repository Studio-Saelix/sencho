import type { NextFunction, Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrustedProxyWarning } from '../middleware/trustedProxyWarning';
import { resetTrustedProxyBlockListCache } from '../helpers/trustedProxyCidrs';

function makeRequest(peer: string, headers: Record<string, string>): Request {
  return { headers, socket: { remoteAddress: peer } } as unknown as Request;
}

function trustProxyWarnings(warn: { mock: { calls: unknown[][] } }): string[] {
  return warn.mock.calls
    .map(call => String(call[0]))
    .filter(message => message.includes('[TrustProxy]'));
}

describe('trustedProxyWarning', () => {
  beforeEach(() => {
    delete process.env.SENCHO_TRUSTED_PROXY_CIDRS;
    resetTrustedProxyBlockListCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns once per untrusted peer and names the exact CIDR to set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const middleware = createTrustedProxyWarning();
    const next = vi.fn();

    middleware(makeRequest('172.18.0.1', { 'x-forwarded-for': '203.0.113.7' }), {} as Response, next as NextFunction);
    middleware(makeRequest('172.18.0.1', { 'x-forwarded-for': '203.0.113.8' }), {} as Response, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(2);
    const warnings = trustProxyWarnings(warn);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('untrusted peer 172.18.0.1');
    expect(warnings[0]).toContain('SENCHO_TRUSTED_PROXY_CIDRS=172.18.0.1/32');
  });

  it('stays silent for a peer inside the configured CIDR', () => {
    process.env.SENCHO_TRUSTED_PROXY_CIDRS = '172.18.0.0/16';
    resetTrustedProxyBlockListCache();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const middleware = createTrustedProxyWarning();

    middleware(makeRequest('172.18.0.1', { 'x-forwarded-proto': 'https' }), {} as Response, vi.fn() as NextFunction);

    expect(trustProxyWarnings(warn)).toHaveLength(0);
  });

  it('stays silent when no forwarding header is present', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const middleware = createTrustedProxyWarning();

    middleware(makeRequest('203.0.113.9', { accept: 'application/json' }), {} as Response, vi.fn() as NextFunction);

    expect(trustProxyWarnings(warn)).toHaveLength(0);
  });

  it('suggests a /32 for an IPv4-mapped IPv6 peer', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const middleware = createTrustedProxyWarning();

    middleware(makeRequest('::ffff:172.18.0.1', { 'x-real-ip': '203.0.113.7' }), {} as Response, vi.fn() as NextFunction);

    expect(trustProxyWarnings(warn)[0]).toContain('SENCHO_TRUSTED_PROXY_CIDRS=172.18.0.1/32');
  });

  it('counts an IPv4-mapped peer and its bare form as one host', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const middleware = createTrustedProxyWarning();

    middleware(makeRequest('::ffff:172.18.0.1', { 'x-forwarded-for': '203.0.113.7' }), {} as Response, vi.fn() as NextFunction);
    middleware(makeRequest('172.18.0.1', { 'x-forwarded-for': '203.0.113.8' }), {} as Response, vi.fn() as NextFunction);

    expect(trustProxyWarnings(warn)).toHaveLength(1);
  });

  it('strips an IPv6 zone id and suggests a /128', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const middleware = createTrustedProxyWarning();

    middleware(makeRequest('fe80::1%eth0', { 'x-forwarded-for': '203.0.113.7' }), {} as Response, vi.fn() as NextFunction);

    const warning = trustProxyWarnings(warn)[0];
    expect(warning).toContain('untrusted peer fe80::1');
    expect(warning).toContain('SENCHO_TRUSTED_PROXY_CIDRS=fe80::1/128');
  });

  it('tells an operator with a configured list to add the peer, not replace the list', () => {
    process.env.SENCHO_TRUSTED_PROXY_CIDRS = '10.0.0.0/8';
    resetTrustedProxyBlockListCache();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const middleware = createTrustedProxyWarning();

    middleware(makeRequest('172.18.0.1', { 'x-forwarded-for': '203.0.113.7' }), {} as Response, vi.fn() as NextFunction);

    const warning = trustProxyWarnings(warn)[0];
    expect(warning).toContain('add 172.18.0.1/32 to SENCHO_TRUSTED_PROXY_CIDRS');
    expect(warning).not.toContain('set SENCHO_TRUSTED_PROXY_CIDRS=');
  });

  it('points at the rejected entries when the configured list is invalid', () => {
    process.env.SENCHO_TRUSTED_PROXY_CIDRS = '192.168.1.50';
    resetTrustedProxyBlockListCache();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const middleware = createTrustedProxyWarning();

    middleware(makeRequest('172.18.0.1', { 'x-forwarded-for': '203.0.113.7' }), {} as Response, vi.fn() as NextFunction);

    const warning = trustProxyWarnings(warn)[0];
    expect(warning).toContain('fix the rejected SENCHO_TRUSTED_PROXY_CIDRS entries');
    expect(warning).not.toContain('add 172.18.0.1/32');
  });

  it('caps distinct logged peers and says so once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const middleware = createTrustedProxyWarning();

    for (let i = 1; i <= 20; i += 1) {
      middleware(
        makeRequest(`10.20.30.${i}`, { 'x-forwarded-for': '203.0.113.7' }),
        {} as Response,
        vi.fn() as NextFunction,
      );
    }

    const warnings = trustProxyWarnings(warn);
    expect(warnings).toHaveLength(17);
    expect(warnings[16]).toContain('more than 16 untrusted peers');
  });
});
