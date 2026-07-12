import type { NetworkingTopologyContainer, NetworkingTopologyEnvelope, NetworkingTopologyNetwork } from '@/types/networking';

export interface NetworkingTopologyFilters {
  stack: string;
  network: string;
  exposedOnly: boolean;
  driftOnly: boolean;
  missingExternalOnly: boolean;
  sharedOnly: boolean;
}

export const DEFAULT_TOPOLOGY_FILTERS: NetworkingTopologyFilters = {
  stack: '',
  network: '',
  exposedOnly: false,
  driftOnly: false,
  missingExternalOnly: false,
  sharedOnly: false,
};

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
  return {
    networks: envelope.networks,
    runtimeAvailable: true,
  };
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
    if (filters.exposedOnly && !network.containers.some((container) => container.publishedPorts.length > 0)) {
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
    if (filters.sharedOnly && network.declaredByStacks.length + network.declaredExternalByStacks.length < 2) {
      return [];
    }

    return [{ ...network, containers }];
  });
}

export function isMissingTopologyNetwork(network: NetworkingTopologyNetwork): boolean {
  return network.runtimeState === 'missing' || network.id.startsWith('missing:');
}

export function formatTopologyPort(port: NetworkingTopologyContainer['publishedPorts'][number]): string {
  return `${port.hostIp ?? '0.0.0.0'}:${port.published ?? port.target}/${port.protocol}`;
}
