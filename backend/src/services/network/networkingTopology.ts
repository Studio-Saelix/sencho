/**
 * Compose-aware topology built from the aggregate snapshot and stack facts.
 * No additional Docker API calls.
 */
import type { DependencySnapshot } from '../DockerController';
import type { StackNetworkFacts } from './types';
import type {
  NetworkingFinding,
  NetworkingTopology,
  NetworkingTopologyContainer,
  NetworkingTopologyNetwork,
} from './networkingTypes';

const RUNNING_STATES = new Set(['running', 'restarting']);

function aliasMapForStack(facts: StackNetworkFacts): Map<string, Map<string, string[]>> {
  const byRuntime = new Map<string, Map<string, string[]>>();
  for (const svc of facts.services) {
    for (const membership of svc.networks) {
      const net = facts.networks.find(n => n.key === membership.key);
      const runtimeName = net?.name ?? membership.key;
      const bucket = byRuntime.get(runtimeName) ?? new Map<string, string[]>();
      for (const alias of membership.aliases) {
        const list = bucket.get(alias) ?? [];
        list.push(svc.name);
        bucket.set(alias, list);
      }
      byRuntime.set(runtimeName, bucket);
    }
  }
  return byRuntime;
}

export function buildNetworkingTopology(
  snapshot: DependencySnapshot,
  stackFacts: StackNetworkFacts[],
  findings: NetworkingFinding[],
  includeSystem: boolean,
): NetworkingTopology {
  const findingsByNetwork = new Map<string, string[]>();
  for (const f of findings) {
    if (!f.network) continue;
    const list = findingsByNetwork.get(f.network) ?? [];
    list.push(f.id);
    findingsByNetwork.set(f.network, list);
  }

  const aliasesByStack = new Map(stackFacts.map(f => [f.stack, aliasMapForStack(f)]));

  const networks: NetworkingTopologyNetwork[] = [];
  for (const net of snapshot.networks) {
    if (net.isSystem && !includeSystem) continue;

    const containers: NetworkingTopologyContainer[] = [];
    for (const c of snapshot.containers) {
      if (!RUNNING_STATES.has(c.state)) continue;
      for (const attached of c.networks) {
        if (attached.name !== net.name && attached.id !== net.id) continue;
        const stackAliases = c.stack ? aliasesByStack.get(c.stack) : undefined;
        const serviceAliases = c.service && stackAliases
          ? [...(stackAliases.get(net.name)?.entries() ?? [])]
              .filter(([, services]) => services.includes(c.service!))
              .map(([alias]) => alias)
          : [];
        containers.push({
          id: c.id,
          name: c.name,
          ip: attached.ip,
          state: c.state,
          image: c.image,
          stack: c.stack,
          service: c.service,
          composeAliases: serviceAliases,
        });
      }
    }

    networks.push({
      id: net.id,
      name: net.name,
      driver: net.driver,
      scope: net.scope,
      stack: net.stack,
      isSystem: net.isSystem,
      findingIds: findingsByNetwork.get(net.name) ?? [],
      containers,
    });
  }

  return { networks, includeSystem };
}
