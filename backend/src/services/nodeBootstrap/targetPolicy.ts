import dnsPromises from 'dns/promises';
import fs from 'fs';
import net from 'net';
import os from 'os';
import { isDisallowedOutboundTargetAddress } from '../../utils/outboundTarget';
import { isArchiveStorableName } from '../cloudBackupArchive';
import { sanitizeForLog } from '../../utils/safeLog';

/**
 * Target validation for the bootstrap SSH connection.
 *
 * Every address the hostname resolves to is checked before a socket is opened,
 * and a single blocked record fails the whole target: a DNS name that answers
 * with one public and one loopback address must not be reachable just because
 * the loopback record sorts second.
 */

export interface BootstrapTargetInput {
  host: string;
  port: number;
  username: string;
  targetName: string;
}

export type TargetField = 'host' | 'port' | 'username' | 'targetName';

export class TargetValidationError extends Error {
  public readonly code: 'INVALID_TARGET';
  public readonly field: TargetField;

  public constructor(field: TargetField, message: string) {
    super(message);
    this.name = 'TargetValidationError';
    this.code = 'INVALID_TARGET';
    this.field = field;
  }
}

const HOSTNAME_PATTERN = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const USERNAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;

/**
 * The canonical target identity. DNS names are case-insensitive, so the
 * lower-case spelling is the one used for trust pins and the per-target lock;
 * IPv4 literals have no case variant.
 */
export function validateHost(raw: unknown): string {
  const host = typeof raw === 'string' ? raw.trim() : '';
  if (!host) throw new TargetValidationError('host', 'Host is required.');
  if (host.includes(':')) {
    throw new TargetValidationError('host', 'IPv6 targets are not supported in this release. Use a hostname or an IPv4 address.');
  }
  if (net.isIP(host) !== 4 && !HOSTNAME_PATTERN.test(host)) {
    throw new TargetValidationError('host', 'Host must be a DNS name or an IPv4 address.');
  }
  // A top-level domain is never numeric, so a name whose last label is all
  // digits or `0x` plus hex is a legacy spelling of an IPv4 address
  // (`1.2.3.04`, `0x7f.1`). Refusing it keeps one server from holding a pin
  // under each spelling.
  if (net.isIP(host) !== 4 && /^(?:\d+|0x[0-9a-f]*)$/i.test(host.slice(host.lastIndexOf('.') + 1))) {
    throw new TargetValidationError('host', 'Host must be a DNS name or an IPv4 address in dotted form.');
  }
  return host.toLowerCase();
}

export function validatePort(raw: unknown): number {
  const portRaw = raw === undefined || raw === null || raw === '' ? 22 : raw;
  const port = typeof portRaw === 'number' ? portRaw : Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TargetValidationError('port', 'Port must be an integer between 1 and 65535.');
  }
  return port;
}

export function validateTarget(raw: {
  host?: unknown;
  port?: unknown;
  username?: unknown;
  targetName?: unknown;
}): BootstrapTargetInput {
  const host = validateHost(raw.host);
  const port = validatePort(raw.port);

  const username = typeof raw.username === 'string' ? raw.username.trim() : '';
  if (!USERNAME_PATTERN.test(username)) {
    throw new TargetValidationError('username', 'SSH user must be a lowercase POSIX user name.');
  }

  const targetName = typeof raw.targetName === 'string' ? raw.targetName.trim() : '';
  if (!targetName) throw new TargetValidationError('targetName', 'Node name is required.');
  if (targetName.length > 100) throw new TargetValidationError('targetName', 'Node name must be at most 100 characters.');
  if (!isArchiveStorableName(targetName)) {
    throw new TargetValidationError('targetName', 'Node name must be valid Unicode text without NUL characters.');
  }

  return { host, port, username, targetName };
}

export class UnsafeTargetError extends Error {
  public readonly code: 'SSH_DNS_FAILED' | 'INVALID_TARGET' | 'SSH_UNREACHABLE';

  public constructor(code: 'SSH_DNS_FAILED' | 'INVALID_TARGET' | 'SSH_UNREACHABLE', message: string) {
    super(message);
    this.name = 'UnsafeTargetError';
    this.code = code;
  }
}

export type ResolveAddresses = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const systemResolve: ResolveAddresses = (hostname) =>
  dnsPromises.lookup(hostname, { all: true, verbatim: true });

/**
 * The addresses of this instance and of the host it runs on. The interface list
 * is all a bare-metal install needs, but inside a container it holds only the
 * bridge address, so two more sources are added:
 *
 * - the host the operator used to reach the hub (the request host or
 *   SENCHO_PUBLIC_URL), whose IPv4 address is the public address of a Docker or
 *   NAT deployment;
 * - the gateways the hub routes through (see {@link gatewayAddresses}), which in
 *   a container are the Docker host itself.
 *
 * A hub host that does not resolve adds nothing and is logged; it does not
 * refuse the target, because this check is a convenience, not the outbound policy.
 */
async function ownAddresses(hubHost: string | null, resolve: ResolveAddresses): Promise<Set<string>> {
  const addresses = ownInterfaceAddresses();
  for (const gateway of gatewayAddresses()) addresses.add(gateway);
  if (!hubHost) return addresses;
  if (net.isIP(hubHost) === 4) {
    addresses.add(hubHost);
    return addresses;
  }
  if (net.isIP(hubHost) !== 0) return addresses;
  try {
    for (const record of await resolve(hubHost)) {
      if (net.isIP(record.address) === 4) addresses.add(record.address);
    }
  } catch (error: unknown) {
    // A hub name that cannot be resolved here identifies no address.
    console.warn(`[Bootstrap] Hub host ${sanitizeForLog(hubHost)} did not resolve (${(error as { code?: string } | null)?.code ?? 'unknown'}); own-address check uses interfaces only.`);
  }
  return addresses;
}

function ownInterfaceAddresses(): Set<string> {
  const addresses = new Set<string>();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      addresses.add(entry.address);
    }
  }
  return addresses;
}

/** Docker's default bridge (`docker0`) gateway: the address of the Docker host on that bridge. */
const DOCKER_DEFAULT_BRIDGE_GATEWAY = '172.17.0.1';

function ipv4ToInt(address: string): number {
  return address.split('.').reduce((acc, part) => (acc * 256) + Number(part), 0);
}

function intToIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.');
}

/** The default-route gateways in the kernel's route table (Linux); none where it cannot be read. */
function defaultRouteGateways(): string[] {
  let table: string;
  try {
    table = fs.readFileSync('/proc/net/route', 'utf8');
  } catch {
    return [];
  }
  const gateways: string[] = [];
  for (const line of table.split('\n').slice(1)) {
    const [, destination, gateway] = line.trim().split(/\s+/);
    if (destination !== '00000000' || !gateway || !/^[0-9A-Fa-f]{8}$/.test(gateway) || gateway === '00000000') continue;
    // The kernel prints the address as a little-endian hex word.
    const octets = gateway.match(/../g)!.map((pair) => parseInt(pair, 16)).reverse();
    gateways.push(octets.join('.'));
  }
  return gateways;
}

/**
 * Gateway addresses that stand for the machine hosting this instance. Inside a
 * bridge-networked container the default gateway, and the first host address
 * (`.1` of a /24) of each attached subnet, is the Docker host itself, so the
 * target `172.17.0.1` is the same server as the public address the guard
 * already refuses. The set holds the default-route gateways (Linux
 * `/proc/net/route`), the first host address of every IPv4 subnet from /8 to
 * /30 an interface is on (a /31 or /32 has no separate gateway; a shorter
 * prefix is not a bridge), and Docker's default bridge gateway.
 *
 * This is a heuristic that over-refuses on purpose: outside a container the
 * same addresses are the network's router, which is refused too. A bridge
 * network the hub is not attached to cannot be told from a LAN address and is
 * not covered.
 */
function gatewayAddresses(): Set<string> {
  const gateways = new Set<string>([DOCKER_DEFAULT_BRIDGE_GATEWAY, ...defaultRouteGateways()]);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4' || net.isIP(entry.netmask) !== 4) continue;
      const mask = ipv4ToInt(entry.netmask);
      const hostBits = 32 - (mask.toString(2).replace(/0/g, '').length);
      // A /31 or /32 has no separate gateway address.
      if (hostBits < 2 || hostBits > 24) continue;
      const network = Math.floor(ipv4ToInt(entry.address) / 2 ** hostBits) * 2 ** hostBits;
      gateways.add(intToIpv4(network + 1));
    }
  }
  return gateways;
}

/**
 * Resolve a host to the addresses that may be dialed. Any blocked record, or a
 * record that is one of this instance's own addresses (its network interfaces,
 * `hubHost` when it resolves, and the gateway addresses of `gatewayAddresses`),
 * rejects the whole target.
 */
export async function resolveTargetAddresses(
  host: string,
  resolve: ResolveAddresses = systemResolve,
  hubHost: string | null = null,
): Promise<string[]> {
  let records: Array<{ address: string; family: number }>;
  if (net.isIP(host) === 4) {
    records = [{ address: host, family: 4 }];
  } else {
    try {
      records = await resolve(host);
    } catch {
      throw new UnsafeTargetError('SSH_DNS_FAILED', `Could not resolve ${host}.`);
    }
  }
  if (!records || records.length === 0) {
    throw new UnsafeTargetError('SSH_DNS_FAILED', `Could not resolve ${host}.`);
  }
  const own = await ownAddresses(hubHost, resolve);
  for (const record of records) {
    if (net.isIP(record.address) !== 4) {
      throw new UnsafeTargetError('INVALID_TARGET', 'IPv6 targets are not supported in this release.');
    }
    if (isDisallowedOutboundTargetAddress(record.address)) {
      throw new UnsafeTargetError('INVALID_TARGET', 'The target address is not allowed.');
    }
    if (own.has(record.address)) {
      throw new UnsafeTargetError('INVALID_TARGET', 'The target resolves to this Sencho instance.');
    }
  }
  return records.map((record) => record.address);
}
