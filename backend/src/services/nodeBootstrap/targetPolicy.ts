import dnsPromises from 'dns/promises';
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
 * The addresses this instance answers on. The interface list is all a bare-metal
 * install needs, but inside a container it holds only the bridge address, so the
 * host the operator used to reach the hub (the request host or SENCHO_PUBLIC_URL)
 * is added: its IPv4 address is the public address of a Docker or NAT deployment.
 * A hub host that does not resolve adds nothing and is logged; it does not
 * refuse the target, because this check is a convenience, not the outbound policy.
 */
async function ownAddresses(hubHost: string | null, resolve: ResolveAddresses): Promise<Set<string>> {
  const addresses = ownInterfaceAddresses();
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

/**
 * Resolve a host to the addresses that may be dialed. Any blocked record, or a
 * record that is one of this instance's own addresses (its network interfaces
 * plus `hubHost`, the host clients reach the hub on, when it resolves), rejects
 * the whole target.
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
