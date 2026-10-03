import net from 'net';
import { sanitizeForLog } from '../utils/safeLog';

const ENV_KEY = 'SENCHO_TRUSTED_PROXY_CIDRS';

/** One rejected SENCHO_TRUSTED_PROXY_CIDRS entry and the reason it was rejected. */
export interface TrustedProxyRejection {
  entry: string;
  reason: string;
}

/**
 * Effective trust policy for forwarded headers.
 *
 * `blockList` is null when the env var is unset OR when any entry was rejected:
 * a partially valid list is deliberately ignored as a whole (fail closed), so a
 * typo can never leave Sencho trusting a narrower or wider range than the
 * operator wrote. X-Forwarded-* headers are ignored whenever it is null.
 */
export interface TrustedProxyPolicy {
  configured: boolean;
  entries: string[];
  blockList: net.BlockList | null;
  rejected: TrustedProxyRejection[];
}

interface ParsedCidr {
  ok: true;
  family: 4 | 6;
  address: string;
  prefix: number;
}

interface RejectedCidr {
  ok: false;
  reason: string;
}

let cachedPolicy: TrustedProxyPolicy | undefined;
let loggedPolicy = false;

function parseCidrEntry(raw: string): ParsedCidr | RejectedCidr {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: 'empty entry' };

  const slash = trimmed.lastIndexOf('/');
  if (slash <= 0) {
    return {
      ok: false,
      reason: 'not a CIDR; add /32 for one IPv4 address, /128 for one IPv6 address, or the network prefix',
    };
  }

  const addressPart = trimmed.slice(0, slash);
  const prefixPart = trimmed.slice(slash + 1);
  if (!/^\d+$/.test(prefixPart)) {
    return { ok: false, reason: `prefix "${prefixPart}" is not a number` };
  }
  const prefix = Number(prefixPart);

  const family = net.isIP(addressPart);
  if (family === 4) {
    if (prefix < 0 || prefix > 32) {
      return { ok: false, reason: `prefix ${prefix} is out of range for IPv4 (0-32)` };
    }
    return { ok: true, family: 4, address: addressPart, prefix };
  }
  if (family === 6) {
    if (prefix < 0 || prefix > 128) {
      return { ok: false, reason: `prefix ${prefix} is out of range for IPv6 (0-128)` };
    }
    return { ok: true, family: 6, address: addressPart, prefix };
  }
  return { ok: false, reason: `"${addressPart}" is not a valid IPv4 or IPv6 address` };
}

function buildPolicy(): TrustedProxyPolicy {
  const raw = process.env[ENV_KEY]?.trim();
  if (!raw) {
    return { configured: false, entries: [], blockList: null, rejected: [] };
  }

  const entries = raw.split(',').map(part => part.trim()).filter(Boolean);
  if (entries.length === 0) {
    return { configured: false, entries: [], blockList: null, rejected: [] };
  }

  const seen = new Set<string>();
  const blockList = new net.BlockList();
  const rejected: TrustedProxyRejection[] = [];

  for (const entry of entries) {
    if (seen.has(entry)) {
      rejected.push({ entry, reason: 'duplicate entry' });
      continue;
    }
    seen.add(entry);

    const parsed = parseCidrEntry(entry);
    if (!parsed.ok) {
      rejected.push({ entry, reason: parsed.reason });
      continue;
    }

    try {
      blockList.addSubnet(parsed.address, parsed.prefix, parsed.family === 4 ? 'ipv4' : 'ipv6');
    } catch {
      rejected.push({ entry, reason: 'could not be registered as a subnet' });
    }
  }

  return {
    configured: true,
    entries,
    blockList: rejected.length > 0 ? null : blockList,
    rejected,
  };
}

/** Parse SENCHO_TRUSTED_PROXY_CIDRS once per process, memoized until reset. */
export function getTrustedProxyPolicy(): TrustedProxyPolicy {
  if (cachedPolicy === undefined) {
    cachedPolicy = buildPolicy();
  }
  return cachedPolicy;
}

export function getTrustedProxyBlockList(): net.BlockList | null {
  return getTrustedProxyPolicy().blockList;
}

/**
 * Log the effective trusted-proxy policy once per process, at boot. An invalid
 * list is a loud warning because the failure mode (ignored forwarding headers)
 * is silent otherwise: client addresses, secure-cookie detection, SSO callback
 * URLs, Pilot enrollment URLs, and rate-limit keys all fall back to the proxy.
 */
export function logTrustedProxyConfiguration(): void {
  if (loggedPolicy) return;
  loggedPolicy = true;

  const policy = getTrustedProxyPolicy();

  if (!policy.configured) {
    console.log(
      '[TrustProxy] SENCHO_TRUSTED_PROXY_CIDRS is not set. X-Forwarded-* headers are ignored, '
      + 'which is correct when browsers reach Sencho directly; set it to your reverse proxy CIDR when one sits in front.',
    );
    return;
  }

  if (policy.rejected.length > 0) {
    const details = policy.rejected
      .map(rejection => `"${sanitizeForLog(rejection.entry)}" (${sanitizeForLog(rejection.reason)})`)
      .join(', ');
    console.warn(
      `[TrustProxy] Ignoring SENCHO_TRUSTED_PROXY_CIDRS: ${details}. `
      + 'X-Forwarded-* headers will be ignored and client addresses, secure cookies, SSO callback URLs, '
      + 'Pilot enrollment URLs, and rate-limit keys will reflect the proxy instead of the client.',
    );
    return;
  }

  console.log(
    `[TrustProxy] Trusting X-Forwarded-* headers from: ${policy.entries.map(sanitizeForLog).join(', ')}.`,
  );
}

/** Reset cached parse and the boot log (tests only). */
export function resetTrustedProxyBlockListCache(): void {
  cachedPolicy = undefined;
  loggedPolicy = false;
}

export function isTrustedProxyPeer(peerAddress: string | undefined): boolean {
  if (!peerAddress) return false;
  const blockList = getTrustedProxyBlockList();
  if (!blockList) return false;

  const mappedIpv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(peerAddress)?.[1];
  const normalizedPeer = mappedIpv4 ?? peerAddress;
  const family = net.isIP(normalizedPeer);
  if (family === 4) {
    return blockList.check(normalizedPeer, 'ipv4');
  }
  if (family === 6) {
    return blockList.check(normalizedPeer, 'ipv6');
  }
  return false;
}
