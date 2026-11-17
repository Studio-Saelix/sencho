import type { NetworkingTopologyContainer, NetworkingTopologyEnvelope, NetworkingTopologyNetwork } from '@/types/networking';

export type TopologyOwnershipFilter = 'all' | 'managed' | 'external' | 'system';

export interface NetworkingTopologyFilters {
  stack: string;
  network: string;
  ownership: TopologyOwnershipFilter;
  exposedOnly: boolean;
  driftOnly: boolean;
  missingExternalOnly: boolean;
  sharedOnly: boolean;
}

export const DEFAULT_TOPOLOGY_FILTERS: NetworkingTopologyFilters = {
  stack: '',
  network: '',
  ownership: 'all',
  exposedOnly: false,
  driftOnly: false,
  missingExternalOnly: false,
  sharedOnly: false,
};

/** Large-topology strategy: edges stop animating above this count,
 *  and the graph refuses to render (falling back to the Networks table) above
 *  the combined node+edge cap. The cap check runs on FILTERED, already-deduped
 *  counts so narrowing a filter can bring an over-cap graph back under it. */
export const TOPOLOGY_ANIMATION_EDGE_LIMIT = 80;
export const TOPOLOGY_RENDER_CAP = 350;

/** Cheap pre-layout size count. Mirrors the container cross-network dedupe that
 *  `layoutGraph`/`aggregateContainers` perform, so a container attached to two
 *  networks counts as one node (not two) and contributes one edge per network. */
export function countTopologyGraphSize(networks: NetworkingTopologyNetwork[]): {
  nodeCount: number;
  edgeCount: number;
} {
  const containerIds = new Set<string>();
  let edgeCount = 0;
  for (const network of networks) {
    for (const container of network.containers) {
      containerIds.add(container.id);
      edgeCount += 1;
    }
  }
  return { nodeCount: networks.length + containerIds.size, edgeCount };
}

export function normalizeTopologyResponse(payload: unknown): {
  networks: NetworkingTopologyNetwork[];
  runtimeAvailable: boolean;
} {
  if (Array.isArray(payload)) {
    return { networks: payload as NetworkingTopologyNetwork[], runtimeAvailable: true };
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid topology response');
  }
  const envelope = payload as Partial<NetworkingTopologyEnvelope>;
  if (envelope.runtimeAvailable === false) {
    return { networks: [], runtimeAvailable: false };
  }
  if (!Array.isArray(envelope.networks)) {
    throw new Error('Invalid topology response');
  }
  // A schema-2 remote's containers lack `hostMode`; default it so exposedOnly
  // filtering degrades to published-ports-only instead of crashing.
  const networks = envelope.networks.map((network) => ({
    ...network,
    containers: network.containers.map((container) => ({
      ...container,
      hostMode: container.hostMode === true,
    })),
  }));
  return { networks, runtimeAvailable: true };
}

function containerMatchesStackQuery(
  container: NetworkingTopologyContainer,
  stackQuery: string,
): boolean {
  return Boolean(
    container.stack?.toLowerCase().includes(stackQuery)
    || container.service?.toLowerCase().includes(stackQuery),
  );
}

function matchesOwnership(network: NetworkingTopologyNetwork, ownership: TopologyOwnershipFilter): boolean {
  switch (ownership) {
    case 'managed': return network.ownership === 'sencho-managed';
    case 'external': return network.isExternalDependency;
    case 'system': return network.ownership === 'system';
    case 'all':
    default: return true;
  }
}

export function filterTopologyNetworks(
  networks: NetworkingTopologyNetwork[],
  filters: NetworkingTopologyFilters,
): NetworkingTopologyNetwork[] {
  const networkQuery = filters.network.trim().toLowerCase();
  const stackQuery = filters.stack.trim().toLowerCase();

  return networks.flatMap((network) => {
    const isMissing = network.runtimeState === 'missing' || network.id.startsWith('missing:');
    const containers = stackQuery
      ? network.containers.filter((container) => containerMatchesStackQuery(container, stackQuery))
      : network.containers;

    if (networkQuery && !network.name.toLowerCase().includes(networkQuery)) return [];
    if (
      stackQuery
      && !network.declaredByStacks.some((stack) => stack.toLowerCase().includes(stackQuery))
      && containers.length === 0
    ) {
      return [];
    }
    if (!matchesOwnership(network, filters.ownership)) return [];
    if (
      filters.exposedOnly
      && !network.containers.some((container) => container.publishedPorts.length > 0 || container.hostMode)
    ) {
      return [];
    }
    if (
      filters.driftOnly
      && !network.findingIds.length
      && !network.containers.some((container) => container.findingIds.length || container.driftFlags.length)
    ) {
      return [];
    }
    if (filters.missingExternalOnly && !isMissing) return [];
    if (filters.sharedOnly) {
      // declaredExternalByStacks is a SUBSET of declaredByStacks (an external
      // declaration is still a declaration), so summing both double-counts.
      // Shared means 2+ distinct declaring stacks.
      const uniqueStacks = new Set(network.declaredByStacks);
      if (uniqueStacks.size < 2) return [];
    }

    return [{ ...network, containers }];
  });
}

export function isMissingTopologyNetwork(network: NetworkingTopologyNetwork): boolean {
  return network.runtimeState === 'missing' || network.id.startsWith('missing:');
}

/** The backend's all-interface sentinels, all shown as `0.0.0.0`. */
const ALL_INTERFACE_HOSTS = new Set(['', '0.0.0.0', '::', '[::]']);

/** A host as it belongs in `host:port`: an IPv6 literal needs brackets, and an
 *  all-interface binding reads as the canonical `0.0.0.0`. */
function formatTopologyHost(hostIp: string): string {
  if (ALL_INTERFACE_HOSTS.has(hostIp)) return '0.0.0.0';
  if (hostIp.startsWith('[') || !hostIp.includes(':')) return hostIp;
  return `[${hostIp}]`;
}

/** A published port line: `host:startPort/protocol` for one fixed port,
 *  `host:startPort-endPort/protocol` for a fixed range, and
 *  `host:auto/protocol` when Docker picks the host port at start. A payload
 *  that omits `dynamic` still marks an auto-assigned port as 0/0. */
export function formatTopologyPort(port: NetworkingTopologyContainer['publishedPorts'][number]): string {
  const host = formatTopologyHost(port.hostIp);
  if (port.dynamic === true || (port.startPort === 0 && port.endPort === 0)) {
    return `${host}:auto/${port.protocol}`;
  }
  const range = port.startPort === port.endPort ? `${port.startPort}` : `${port.startPort}-${port.endPort}`;
  return `${host}:${range}/${port.protocol}`;
}
