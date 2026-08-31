import { vi } from 'vitest';
import http from 'http';
import https from 'https';
import type { LookupFunction } from 'net';
import { AsyncLocalStorage } from 'async_hooks';

const targetProtectionScope = new AsyncLocalStorage<boolean>();

export async function withLoopbackTargetProtection<T>(action: () => PromiseLike<T>): Promise<T> {
  return targetProtectionScope.run(false, async () => action());
}

vi.mock('../../utils/outboundTarget', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/outboundTarget')>();
  const fixtureAllows = (hostname: string): boolean => {
    if (targetProtectionScope.getStore() === false) return false;
    const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return normalized === 'localhost'
      || normalized === '::1'
      || normalized.startsWith('127.')
      || normalized.startsWith('10.')
      || normalized.startsWith('192.168.')
      || /^172\.(1[6-9]|2\d|3[01])\./.test(normalized)
      || normalized.endsWith('.example.com')
      || normalized.endsWith('.example')
      || normalized.endsWith('.invalid')
      || normalized.endsWith('.local')
      || normalized === 'remote'
      || normalized === 'remote2'
      || normalized === 'good-host'
      || normalized === 'bad-host';
  };
  const fixtureAddress = (hostname: string): string => {
    const normalized = hostname.replace(/^\[|\]$/g, '');
    if (normalized === 'localhost') return '127.0.0.1';
    if (normalized === 'pinned.example') return '93.184.216.34';
    return normalized;
  };
  const fixtureLookup: LookupFunction = (hostname, options, callback): void => {
    if (!fixtureAllows(hostname)) {
      actual.safeOutboundLookup(hostname, options, callback);
      return;
    }
    const normalized = hostname.replace(/^\[|\]$/g, '');
    const address = fixtureAddress(hostname);
    const family = normalized === '::1' ? 6 : 4;
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };

  const fixtureHttpAgent = new http.Agent({ lookup: fixtureLookup });
  const fixtureHttpsAgent = new https.Agent({ lookup: fixtureLookup });

  return {
    ...actual,
    assertSafeOutboundHostname: async (
      hostname: string,
    ): Promise<void> => {
      if (fixtureAllows(hostname)) return;
      await actual.assertSafeOutboundHostname(hostname);
    },
    assertSafeOutboundUrl: async (
      raw: string,
    ): Promise<URL> => {
      const url = new URL(raw);
      if (fixtureAllows(url.hostname)) return url;
      return actual.assertSafeOutboundUrl(raw);
    },
    resolveSafeOutboundHostname: async (hostname: string) => {
      if (fixtureAllows(hostname)) {
        const normalized = hostname.replace(/^\[|\]$/g, '');
        return [{ address: fixtureAddress(hostname), family: normalized === '::1' ? 6 : 4 }];
      }
      return actual.resolveSafeOutboundHostname(hostname);
    },
    safeOutboundLookup: fixtureLookup,
    safeHttpAgent: fixtureHttpAgent,
    safeHttpsAgent: fixtureHttpsAgent,
    safeAxiosTransport: (trustedLoopback = false) => ({
      maxRedirects: 0,
      proxy: false,
      ...(trustedLoopback ? {} : { httpAgent: fixtureHttpAgent, httpsAgent: fixtureHttpsAgent }),
    }),
    safeRemoteFetch: async (
      input: Parameters<typeof actual.safeRemoteFetch>[0],
      init?: Parameters<typeof actual.safeRemoteFetch>[1],
      trustedLoopback?: boolean,
    ) => {
      const url = input instanceof URL
        ? input
        : new URL(typeof input === 'string' ? input : input.url);
      if (fixtureAllows(url.hostname)) {
        return globalThis.fetch(input, { ...init, redirect: 'error' });
      }
      return actual.safeRemoteFetch(input, init, trustedLoopback);
    },
  };
});
