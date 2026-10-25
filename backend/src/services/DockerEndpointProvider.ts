import dns from 'dns';
import net from 'net';
import DockerController from './DockerController';
import SelfIdentityService from './SelfIdentityService';
import { getErrorMessage } from '../utils/errors';

/**
 * Finds the container that carries this node's Docker API, when there is one.
 *
 * Sencho reaches Docker through `DOCKER_HOST`. When that is a `tcp://` address
 * owned by a container on a network Sencho shares (a Docker socket proxy), that
 * container is the connection: stopping or recreating it cuts the API Sencho is
 * using to do the work, and the rollback that follows dies the same way.
 *
 * The answer is re-resolved at most every 15 s, and callers also match the
 * provider by its Compose project and service, because a recreate changes the
 * container id. A `unix://` endpoint or a direct socket mount is `none`;
 * mounting the socket does not make a container this node's connection.
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
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string; NetworkID?: string } | null> };
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

async function resolveAddresses(host: string): Promise<string[]> {
  if (net.isIP(host)) return [host];
  const found = await dns.promises.lookup(host, { all: true });
  return found.map(entry => entry.address);
}

const CACHE_TTL_MS = 15_000;
let cached: { endpoint: string | undefined; at: number; value: Promise<DockerEndpointProvider> } | null = null;

/** Test hook: forget the cached answer. */
export function resetDockerEndpointProviderCache(): void {
  cached = null;
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
      !!network?.IPAddress
      && addresses.includes(network.IPAddress)
      && (self.isOwnNetwork(name) || (!!network.NetworkID && self.isOwnNetwork(network.NetworkID))));
  });
  if (!match || typeof match.Id !== 'string') {
    return { state: 'none', unmatched: true, reason: `No container on a network Sencho shares owns the Docker endpoint address for "${parsed.host}".` };
  }

  const labels = match.Labels ?? {};
  const socketMount = (match.Mounts ?? []).find(mount => mount.Type === 'bind' && /docker\.sock$/.test(mount.Source ?? ''));
  return {
    state: 'resolved',
    provider: {
      containerId: match.Id,
      containerName: (match.Names?.[0] ?? '').replace(/^\//, '') || match.Id.slice(0, 12),
      project: labels['com.docker.compose.project'] ?? null,
      service: labels['com.docker.compose.service'] ?? null,
      workingDir: labels['com.docker.compose.project.working_dir'] ?? null,
      socketBindSource: socketMount?.Source ?? null,
    },
  };
}
