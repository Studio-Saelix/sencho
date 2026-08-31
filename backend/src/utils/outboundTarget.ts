import dns, { promises as dnsPromises, type LookupAddress, type LookupAllOptions } from 'dns';
import http from 'http';
import https from 'https';
import net, { type LookupFunction } from 'net';
import { Agent as UndiciAgent, fetch as undiciFetch, type RequestInfo, type RequestInit, type Response } from 'undici';

const blockedIpv4 = new net.BlockList();
blockedIpv4.addSubnet('0.0.0.0', 8, 'ipv4');
blockedIpv4.addSubnet('127.0.0.0', 8, 'ipv4');
blockedIpv4.addSubnet('169.254.0.0', 16, 'ipv4');
blockedIpv4.addSubnet('192.0.0.0', 24, 'ipv4');
blockedIpv4.addSubnet('192.0.2.0', 24, 'ipv4');
blockedIpv4.addSubnet('192.88.99.0', 24, 'ipv4');
blockedIpv4.addSubnet('198.18.0.0', 15, 'ipv4');
blockedIpv4.addSubnet('198.51.100.0', 24, 'ipv4');
blockedIpv4.addSubnet('203.0.113.0', 24, 'ipv4');
blockedIpv4.addSubnet('224.0.0.0', 4, 'ipv4');
blockedIpv4.addSubnet('240.0.0.0', 4, 'ipv4');
blockedIpv4.addAddress('100.100.100.200', 'ipv4');

const blockedIpv6 = new net.BlockList();
blockedIpv6.addAddress('::', 'ipv6');
blockedIpv6.addAddress('::1', 'ipv6');
blockedIpv6.addSubnet('100::', 64, 'ipv6');
blockedIpv6.addSubnet('2001:db8::', 32, 'ipv6');
blockedIpv6.addSubnet('fe80::', 10, 'ipv6');
blockedIpv6.addSubnet('ff00::', 8, 'ipv6');
blockedIpv6.addAddress('fd00:ec2::254', 'ipv6');

export class UnsafeOutboundTargetError extends Error {
  public readonly reason: 'blocked' | 'unresolved';
  public readonly code = 'EACCES';

  public constructor(reason: 'blocked' | 'unresolved') {
    super(reason === 'blocked'
      ? 'The target address is not allowed.'
      : 'The target host could not be resolved.');
    this.name = 'UnsafeOutboundTargetError';
    this.reason = reason;
  }
}

export function isBlockedOutboundAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return blockedIpv4.check(address, 'ipv4');
  if (family === 6) {
    const mappedIpv4 = ipv4FromMappedIpv6(address);
    return mappedIpv4
      ? blockedIpv4.check(mappedIpv4, 'ipv4')
      : blockedIpv6.check(address, 'ipv6');
  }
  return true;
}

function ipv4FromMappedIpv6(address: string): string | null {
  const mapped = address.match(/^(?:::ffff:|0:0:0:0:0:ffff:)(.+)$/i)?.[1];
  if (!mapped) return null;
  if (net.isIPv4(mapped)) return mapped;
  const words = mapped.split(':');
  if (words.length !== 2 || words.some((word) => !/^[0-9a-f]{1,4}$/i.test(word))) return null;
  const high = Number.parseInt(words[0], 16);
  const low = Number.parseInt(words[1], 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function lookupHostname(url: URL): string {
  return url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
}

export async function assertSafeOutboundHostname(hostname: string): Promise<void> {
  await resolveSafeOutboundHostname(hostname);
}

type ResolveAllAddresses = (hostname: string) => Promise<LookupAddress[]>;
type ResolvedOutboundAddresses = [LookupAddress, ...LookupAddress[]];

const systemResolveAllAddresses: ResolveAllAddresses = (hostname) =>
  dnsPromises.lookup(hostname, { all: true, verbatim: true });

export async function resolveSafeOutboundHostname(
  hostname: string,
  resolveAllAddresses: ResolveAllAddresses = systemResolveAllAddresses,
): Promise<ResolvedOutboundAddresses> {
  const normalizedHostname = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (net.isIP(normalizedHostname) !== 0) {
    if (isBlockedOutboundAddress(normalizedHostname)) throw new UnsafeOutboundTargetError('blocked');
    return [{ address: normalizedHostname, family: net.isIPv4(normalizedHostname) ? 4 : 6 }];
  }

  let addresses: LookupAddress[];
  try {
    addresses = await resolveAllAddresses(normalizedHostname);
  } catch {
    throw new UnsafeOutboundTargetError('unresolved');
  }
  const [first, ...rest] = addresses;
  if (!first) throw new UnsafeOutboundTargetError('unresolved');
  if (addresses.some(({ address }) => isBlockedOutboundAddress(address))) {
    throw new UnsafeOutboundTargetError('blocked');
  }
  return [first, ...rest];
}

type LookupAllAddresses = (
  hostname: string,
  options: LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

const systemLookupAllAddresses: LookupAllAddresses = (hostname, options, callback) => {
  dns.lookup(hostname, options, callback);
};

export function createSafeOutboundLookup(lookupAllAddresses: LookupAllAddresses): LookupFunction {
  return (hostname, options, callback): void => lookupAllAddresses(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, '', 0);
      return;
    }
    if (!Array.isArray(addresses) || addresses.length === 0) {
      callback(new UnsafeOutboundTargetError('unresolved'), '', 0);
      return;
    }
    if (addresses.some(({ address }) => isBlockedOutboundAddress(address))) {
      callback(new UnsafeOutboundTargetError('blocked'), '', 0);
      return;
    }
    if (options.all) {
      callback(null, addresses);
      return;
    }
    callback(null, addresses[0].address, addresses[0].family);
  });
}

export const safeOutboundLookup = createSafeOutboundLookup(systemLookupAllAddresses);

export const safeHttpAgent = new http.Agent({ lookup: safeOutboundLookup });
export const safeHttpsAgent = new https.Agent({ lookup: safeOutboundLookup });
const safeFetchDispatcher = new UndiciAgent({ connect: { lookup: safeOutboundLookup } });

export function safeAxiosTransport(trustedLoopback = false): {
  maxRedirects: number;
  proxy: false;
  httpAgent?: http.Agent;
  httpsAgent?: https.Agent;
} {
  return {
    maxRedirects: 0,
    proxy: false,
    ...(trustedLoopback ? {} : { httpAgent: safeHttpAgent, httpsAgent: safeHttpsAgent }),
  };
}

export async function safeRemoteFetch(
  input: RequestInfo,
  init: RequestInit = {},
  trustedLoopback = false,
): Promise<Response> {
  if (!trustedLoopback) {
    const raw = input instanceof URL
      ? input.toString()
      : typeof input === 'string' ? input : input.url;
    const host = lookupHostname(new URL(raw));
    if (net.isIP(host) !== 0 && isBlockedOutboundAddress(host)) {
      throw new UnsafeOutboundTargetError('blocked');
    }
  }
  try {
    return await undiciFetch(input, {
      ...init,
      ...(trustedLoopback ? {} : { dispatcher: safeFetchDispatcher }),
      redirect: 'error',
    });
  } catch (error: unknown) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (cause instanceof UnsafeOutboundTargetError) throw cause;
    throw error;
  }
}

export async function assertSafeOutboundUrl(
  raw: string,
): Promise<URL> {
  const url = new URL(raw);
  await assertSafeOutboundHostname(lookupHostname(url));
  return url;
}
