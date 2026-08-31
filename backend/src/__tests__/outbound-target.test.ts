import http from 'http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertSafeOutboundUrl,
  isBlockedOutboundAddress,
  safeOutboundLookup,
  safeAxiosTransport,
  safeRemoteFetch,
  UnsafeOutboundTargetError,
} from '../utils/outboundTarget';
import { withLoopbackTargetProtection } from './helpers/allowLoopbackTargets';

afterEach(() => vi.restoreAllMocks());

describe('outbound target validation', () => {
  it.each([
    '127.0.0.1',
    '169.254.169.254',
    '100.100.100.200',
    '192.0.2.10',
    '198.18.0.10',
    '198.51.100.10',
    '203.0.113.10',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fe80::1',
    'ff02::1',
    '100::1',
    '2001:db8::1',
    'fd00:ec2::254',
    '::ffff:7f00:1',
  ])('blocks unsafe address %s', (address) => {
    expect(isBlockedOutboundAddress(address)).toBe(true);
  });

  it.each([
    '10.0.0.10',
    '172.16.0.10',
    '192.168.1.10',
    'fd12:3456:789a::10',
    '8.8.8.8',
    '::ffff:808:808',
  ])('allows private and ordinary unicast address %s', (address) => {
    expect(isBlockedOutboundAddress(address)).toBe(false);
  });

  it('rejects a URL whose literal host is unsafe', async () => {
    await expect(withLoopbackTargetProtection(() =>
      assertSafeOutboundUrl('https://[::ffff:127.0.0.1]/repo.git')))
      .rejects.toBeInstanceOf(UnsafeOutboundTargetError);
  });

  it('accepts private LAN targets', async () => {
    await expect(assertSafeOutboundUrl('http://192.168.1.50:1852'))
      .resolves.toMatchObject({ hostname: '192.168.1.50' });
  });

  it('rejects an unsafe address inside the connection lookup', async () => {
    const error = await withLoopbackTargetProtection(() =>
      new Promise<NodeJS.ErrnoException | null>((resolve) => {
        safeOutboundLookup('127.0.0.1', {}, (lookupError) => resolve(lookupError));
      }));

    expect(error).toBeInstanceOf(UnsafeOutboundTargetError);
  });

  it('rejects a hostname when any resolved address is unsafe', async () => {
    const actual = await vi.importActual<typeof import('../utils/outboundTarget')>('../utils/outboundTarget');
    const resolveMixed = async () => [
      { address: '93.184.216.34', family: 4 as const },
      { address: '169.254.169.254', family: 4 as const },
    ];

    await expect(actual.resolveSafeOutboundHostname('mixed.example', resolveMixed))
      .rejects.toMatchObject({ reason: 'blocked' });
  });

  it('rejects an exact metadata address returned by DNS', async () => {
    const actual = await vi.importActual<typeof import('../utils/outboundTarget')>('../utils/outboundTarget');
    const resolveMetadata = async () => [
      { address: '100.100.100.200', family: 4 as const },
    ];

    await expect(actual.resolveSafeOutboundHostname('metadata.example', resolveMetadata))
      .rejects.toMatchObject({ reason: 'blocked' });
  });

  it('rechecks DNS at connection time after safe validation', async () => {
    const actual = await vi.importActual<typeof import('../utils/outboundTarget')>('../utils/outboundTarget');
    const resolveSafe = async () => [{ address: '93.184.216.34', family: 4 as const }];
    await expect(actual.resolveSafeOutboundHostname('rebinding.example', resolveSafe)).resolves.toHaveLength(1);

    const rebindingLookup = actual.createSafeOutboundLookup((_hostname, _options, callback) => {
      callback(null, [{ address: '169.254.169.254', family: 4 }]);
    });
    const connectionError = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      rebindingLookup('rebinding.example', {}, (lookupError) => resolve(lookupError));
    });
    expect(connectionError).toMatchObject({ reason: 'blocked' });
  });

  it('rejects unsafe addresses at fetch connection time', async () => {
    await expect(withLoopbackTargetProtection(() =>
      safeRemoteFetch('http://127.0.0.1:1852/api/meta')))
      .rejects.toBeInstanceOf(UnsafeOutboundTargetError);
  });

  it('rejects redirects without contacting the redirect destination', async () => {
    const actual = await vi.importActual<typeof import('../utils/outboundTarget')>('../utils/outboundTarget');
    let destinationRequests = 0;
    const destination = http.createServer((_req, res) => {
      destinationRequests += 1;
      res.end('unexpected');
    });
    await new Promise<void>((resolve) => destination.listen(0, '127.0.0.1', resolve));
    const destinationAddress = destination.address();
    if (!destinationAddress || typeof destinationAddress === 'string') throw new Error('Missing destination address');

    const redirect = http.createServer((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${destinationAddress.port}/target` });
      res.end();
    });
    await new Promise<void>((resolve) => redirect.listen(0, '127.0.0.1', resolve));
    const redirectAddress = redirect.address();
    if (!redirectAddress || typeof redirectAddress === 'string') throw new Error('Missing redirect address');

    try {
      await expect(actual.safeRemoteFetch(
        `http://127.0.0.1:${redirectAddress.port}/start`,
        {},
        true,
      )).rejects.toThrow();
      expect(destinationRequests).toBe(0);
    } finally {
      await Promise.all([
        new Promise<void>((resolve, reject) => destination.close((error) => error ? reject(error) : resolve())),
        new Promise<void>((resolve, reject) => redirect.close((error) => error ? reject(error) : resolve())),
      ]);
    }
  });

  it('isolates protected loopback checks from concurrent fixture requests', async () => {
    const [ordinary, protectedResult] = await Promise.all([
      assertSafeOutboundUrl('http://127.0.0.1:1852').then(() => 'allowed'),
      withLoopbackTargetProtection(() => assertSafeOutboundUrl('http://127.0.0.1:1852'))
        .then(() => 'allowed', () => 'blocked'),
    ]);

    expect(ordinary).toBe('allowed');
    expect(protectedResult).toBe('blocked');
  });

  it('disables environment proxy routing for guarded Axios requests', () => {
    expect(safeAxiosTransport(false)).toMatchObject({
      maxRedirects: 0,
      proxy: false,
    });
  });
});
