import dns from 'dns';
import net from 'net';
import DockerController from './DockerController';
import SelfIdentityService from './SelfIdentityService';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';

/** Endpoint hosts already reported as matching no container, so the warning is logged once per host. */
const warnedUnmatchedHost = new Set<string>();

/**
 * Finds the container that carries this node's Docker API, when there is one.
 *
 * Sencho reaches Docker through `DOCKER_HOST`. When that is a `tcp://` address
 * owned by a container on a network Sencho shares (a Docker socket proxy), that
 * container is the connection: stopping or recreating it cuts the API Sencho is
 * using to do the work, and the rollback that follows dies the same way.
 *
 * Callers also match the provider by its Compose project and service, because
 * a recreate changes the container id (the cache rules are on
 * `resolveDockerEndpointProvider`). A `unix://` endpoint or a direct socket
 * mount is `none`: mounting the socket does not make a container this node's
 * connection.
 */
export type DockerEndpointProvider =
  /** `unmatched` is set when a tcp endpoint was looked up and no container owns it: that answer is not remembered. */
  | { state: 'none'; reason: string; unmatched?: true }
  | { state: 'resolved'; provider: DockerEndpointContainer }
  | { state: 'unresolved'; reason: string };

export interface DockerEndpointContainer {
  containerId: string;
  containerName: string;
  project: string | null;
  service: string | null;
  workingDir: string | null;
  /** Host path bind-mounted at the container's docker.sock, null when it does not mount one. */
  socketBindSource: string | null;
}

type ListedContainer = {
  Id?: string;
  Names?: string[];
  Labels?: Record<string, string>;
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string; GlobalIPv6Address?: string; NetworkID?: string } | null> };
  Mounts?: Array<{ Type?: string; Source?: string; Destination?: string }>;
};

export type ParsedDockerEndpoint = { kind: 'local' } | { kind: 'tcp'; host: string };

/** Reads `DOCKER_HOST`. Only tcp-like endpoints can name a container; everything else is local. */
export function parseDockerEndpoint(raw: string | undefined): ParsedDockerEndpoint {
  const value = raw?.trim();
  if (!value) return { kind: 'local' };
  const match = /^(tcp|http|https):\/\/(.+)$/i.exec(value);
  if (!match) return { kind: 'local' };
  try {
    const host = new URL(`tcp://${match[2]}`).hostname.replace(/^\[|\]$/g, '');
    return host ? { kind: 'tcp', host } : { kind: 'local' };
  } catch {
    return { kind: 'local' };
  }
}

/**
 * One spelling per IP address, so `fd00:0:0:0:0:0:0:5`, `FD00::5` and
 * `::ffff:10.0.0.2` compare equal to what Docker reports. Anything that is not
 * an IP address is returned unchanged.
 */
export function normalizeIpAddress(address: string): string {
  const bare = address.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (net.isIPv4(bare)) return bare;
  if (!net.isIPv6(bare)) return address;
  try {
    const canonical = new URL(`http://[${bare}]`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    // An IPv4-mapped address (::ffff:a.b.c.d) is the IPv4 address it wraps.
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
    if (!mapped) return canonical;
    const high = parseInt(mapped[1], 16);
    const low = parseInt(mapped[2], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  } catch {
    return bare.toLowerCase();
  }
}

async function resolveAddresses(host: string): Promise<string[]> {
  if (net.isIP(host)) return [normalizeIpAddress(host)];
  const found = await dns.promises.lookup(host, { all: true });
  return found.map(entry => normalizeIpAddress(entry.address));
}

const CACHE_TTL_MS = 15_000;
let cached: { endpoint: string | undefined; at: number; value: Promise<DockerEndpointProvider> } | null = null;

/** Test hook: forget the cached answer. */
export function resetDockerEndpointProviderCache(): void {
  cached = null;
  warnedUnmatchedHost.clear();
}

/**
 * `resolved` and settled `none` answers are remembered for at most 15 s so a
 * burst of lifecycle calls (a bulk update, a scheduled run) lists containers
 * once. A recreate of the provider inside that window leaves a stale container
 * id, which callers cover by also matching Compose project and service.
 * Concurrent callers share one lookup while it is in flight; once it settles,
 * an `unresolved` answer, an unmatched tcp endpoint, or a failed lookup is not
 * reused: the next call tries again.
 */
export async function resolveDockerEndpointProvider(): Promise<DockerEndpointProvider> {
  const endpoint = process.env.DOCKER_HOST;
  if (cached && cached.endpoint === endpoint && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  const pending = resolveUncached(endpoint);
  const entry = { endpoint, at: Date.now(), value: pending };
  cached = entry;
  let value: DockerEndpointProvider;
  try {
    value = await pending;
  } catch (error) {
    if (cached === entry) cached = null;
    throw error;
  }
  const retryNext = value.state === 'unresolved' || (value.state === 'none' && value.unmatched === true);
  if (retryNext && cached === entry) cached = null;
  return value;
}

async function resolveUncached(endpoint: string | undefined): Promise<DockerEndpointProvider> {
  const parsed = parseDockerEndpoint(endpoint);
  if (parsed.kind === 'local') {
    return { state: 'none', reason: 'Sencho reaches Docker through a local socket.' };
  }

  const self = SelfIdentityService.getInstance();
  const selfState = await self.ensureResolved();
  if (selfState === 'unresolved') {
    return { state: 'unresolved', reason: self.getUnresolvedReason() ?? 'Sencho could not identify its own container.' };
  }
  if (selfState === 'none') {
    return { state: 'none', reason: 'Sencho is not running in a container, so no container shares its network.' };
  }

  let addresses: string[];
  try {
    addresses = await resolveAddresses(parsed.host);
  } catch (error) {
    return { state: 'unresolved', reason: `The Docker endpoint host "${parsed.host}" did not resolve: ${getErrorMessage(error, 'lookup failed')}` };
  }

  let containers: ListedContainer[];
  try {
    containers = await DockerController.getInstance().getDocker().listContainers() as ListedContainer[];
  } catch (error) {
    return { state: 'unresolved', reason: `Could not list containers to find the Docker endpoint: ${getErrorMessage(error, 'list failed')}` };
  }

  const match = containers.find(container => {
    if (typeof container.Id !== 'string' || self.isOwnContainer(container.Id)) return false;
    return Object.entries(container.NetworkSettings?.Networks ?? {}).some(([name, network]) =>
      [network?.IPAddress, network?.GlobalIPv6Address].some(address => !!address && addresses.includes(normalizeIpAddress(address)))
      && (self.isOwnNetwork(name) || (!!network?.NetworkID && self.isOwnNetwork(network?.NetworkID))));
  });
  if (!match || typeof match.Id !== 'string') {
    if (!warnedUnmatchedHost.has(parsed.host)) {
      warnedUnmatchedHost.add(parsed.host);
      console.warn(
        '[DockerEndpointProvider] No container on a shared network owns the Docker endpoint address for "%s"; only %s protects a proxy reached this way',
        sanitizeForLog(parsed.host),
        'the io.sencho.infrastructure label',
      );
    }
    return { state: 'none', unmatched: true, reason: `No container on a network Sencho shares owns the Docker endpoint address for "${parsed.host}".` };
  }

  const labels = match.Labels ?? {};
  const socketMount = (match.Mounts ?? []).find(mount => mount.Type === 'bind' && /docker\.sock$/.test(mount.Source ?? ''));
  return {
    state: 'resolved',
    provider: {
      containerId: match.Id,
      containerName: (match.Names?.[0] ?? '').replace(/^\//, '') || match.Id.slice(0, 12),
      // An empty label is no label: Compose and the guard both treat it as missing.
      project: labels['com.docker.compose.project'] || null,
      service: labels['com.docker.compose.service'] || null,
      workingDir: labels['com.docker.compose.project.working_dir'] || null,
      socketBindSource: socketMount?.Source ?? null,
    },
  };
}
