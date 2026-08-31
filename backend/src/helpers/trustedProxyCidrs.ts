import net from 'net';

const ENV_KEY = 'SENCHO_TRUSTED_PROXY_CIDRS';

let cachedBlockList: net.BlockList | null | undefined;

function parseCidrEntry(raw: string): { family: 4 | 6; address: string; prefix: number } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const slash = trimmed.lastIndexOf('/');
  if (slash <= 0) return null;

  const addressPart = trimmed.slice(0, slash);
  const prefixPart = trimmed.slice(slash + 1);
  const prefix = Number(prefixPart);
  if (!Number.isInteger(prefix)) return null;

  const family = net.isIP(addressPart);
  if (family === 4) {
    if (prefix < 0 || prefix > 32) return null;
    return { family: 4, address: addressPart, prefix };
  }
  if (family === 6) {
    if (prefix < 0 || prefix > 128) return null;
    return { family: 6, address: addressPart, prefix };
  }
  return null;
}

/**
 * Parse SENCHO_TRUSTED_PROXY_CIDRS once at process start. Invalid or duplicate
 * entries fail closed by returning null, so forwarding headers are ignored.
 */
export function getTrustedProxyBlockList(): net.BlockList | null {
  if (cachedBlockList !== undefined) {
    return cachedBlockList;
  }

  const raw = process.env[ENV_KEY]?.trim();
  if (!raw) {
    cachedBlockList = null;
    return cachedBlockList;
  }

  const entries = raw.split(',').map(part => part.trim()).filter(Boolean);
  if (entries.length === 0) {
    cachedBlockList = null;
    return cachedBlockList;
  }

  const seen = new Set<string>();
  const blockList = new net.BlockList();

  for (const entry of entries) {
    if (seen.has(entry)) {
      cachedBlockList = null;
      return cachedBlockList;
    }
    seen.add(entry);

    const parsed = parseCidrEntry(entry);
    if (!parsed) {
      cachedBlockList = null;
      return cachedBlockList;
    }

    try {
      if (parsed.family === 4) {
        blockList.addSubnet(parsed.address, parsed.prefix, 'ipv4');
      } else {
        blockList.addSubnet(parsed.address, parsed.prefix, 'ipv6');
      }
    } catch {
      cachedBlockList = null;
      return cachedBlockList;
    }
  }

  cachedBlockList = blockList;
  return cachedBlockList;
}

/** Reset cached parser (tests only). */
export function resetTrustedProxyBlockListCache(): void {
  cachedBlockList = undefined;
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
