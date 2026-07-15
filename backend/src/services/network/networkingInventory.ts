/**
 * Phase B enrichment for network inventory rows.
 */
import type { DependencySnapshot } from '../DockerController';
import { DatabaseService } from '../DatabaseService';
import type { StackNetworkFacts } from './types';
import { isHostNetwork } from './normalize';
import type {
  NetworkingExposureSummary,
  NetworkingFinding,
  NetworkingNetworkBase,
  NetworkingNetworkRow,
} from './networkingTypes';

/** Stacks whose effective model declares a network (optionally external-only). */
export function stacksDeclaringNetwork(
  stackFacts: StackNetworkFacts[],
  networkName: string,
  externalOnly = false,
): string[] {
  return stackFacts
    .filter((facts) =>
      facts.renderable
      && facts.networks.some((network) =>
        network.name === networkName && (!externalOnly || network.external),
      ),
    )
    .map((facts) => facts.stack);
}

export function indexFindingIdsByNetwork(findings: NetworkingFinding[]): Map<string, string[]> {
  const byNetwork = new Map<string, string[]>();
  for (const finding of findings) {
    if (!finding.network) continue;
    const list = byNetwork.get(finding.network) ?? [];
    list.push(finding.id);
    byNetwork.set(finding.network, list);
  }
  return byNetwork;
}

export function enrichNetworkRows(
  nodeId: number,
  baseRows: NetworkingNetworkBase[],
  stackFacts: StackNetworkFacts[],
  snapshot: DependencySnapshot,
  findings: NetworkingFinding[],
): NetworkingNetworkRow[] {
  const stacksByNetwork = new Map<string, Set<string>>();
  const serviceNamesByNetwork = new Map<string, Set<string>>();
  for (const container of snapshot.containers) {
    for (const attached of container.networks) {
      const set = stacksByNetwork.get(attached.name) ?? new Set<string>();
      if (container.stack) set.add(container.stack);
      stacksByNetwork.set(attached.name, set);

      if (container.service) {
        const services = serviceNamesByNetwork.get(attached.name) ?? new Set<string>();
        services.add(container.service);
        serviceNamesByNetwork.set(attached.name, services);
      }
    }
  }

  const findingsByNetwork = indexFindingIdsByNetwork(findings);

  return baseRows.map((row) => {
    const declaredByStacks = stacksDeclaringNetwork(stackFacts, row.name);
    const declaredExternalByStacks = stacksDeclaringNetwork(stackFacts, row.name, true);
    return {
      ...row,
      declaredByStacks,
      declaredExternalByStacks,
      isExternalDependency: declaredExternalByStacks.length > 0,
      sharedStackCount: stacksByNetwork.get(row.name)?.size ?? 0,
      exposureSummary: buildExposureSummary(nodeId, row.name, stackFacts, snapshot),
      findingIds: findingsByNetwork.get(row.name) ?? [],
      serviceNames: [...(serviceNamesByNetwork.get(row.name) ?? [])].sort(),
    };
  });
}

function buildExposureSummary(
  nodeId: number,
  networkName: string,
  stackFacts: StackNetworkFacts[],
  snapshot: DependencySnapshot,
): NetworkingExposureSummary | null {
  const stacksOnNetwork = new Set<string>();
  for (const c of snapshot.containers) {
    if (c.networks.some(n => n.name === networkName) && c.stack) stacksOnNetwork.add(c.stack);
  }
  if (stacksOnNetwork.size === 0) return null;

  let broadExposureCount = 0;
  let unclassifiedStackCount = 0;
  const db = DatabaseService.getInstance();

  for (const stack of stacksOnNetwork) {
    const facts = stackFacts.find(f => f.stack === stack);
    if (!facts?.renderable) continue;
    const intents = db.getStackExposureIntents(nodeId, stack);
    const stackIntent = intents.find(i => i.service === '')?.intent ?? null;
    const byService = new Map(intents.filter(i => i.service !== '').map(i => [i.service, i.intent]));

    let stackBroad = false;
    let stackUnclassified = false;
    for (const svc of facts.services) {
      const attached = svc.networks.some(n => {
        const net = facts.networks.find(nn => nn.key === n.key);
        return (net?.name ?? n.key) === networkName;
      });
      if (!attached) continue;
      const publishes = svc.publishedPorts.length > 0 || isHostNetwork(svc.networkMode);
      if (svc.publishedPorts.some(p => p.allInterfaces) || isHostNetwork(svc.networkMode)) stackBroad = true;
      const intent = byService.get(svc.name) ?? stackIntent;
      if (publishes && (intent === null || intent === 'unknown')) stackUnclassified = true;
    }
    if (stackBroad) broadExposureCount += 1;
    if (stackUnclassified) unclassifiedStackCount += 1;
  }

  return {
    publishingStackCount: stacksOnNetwork.size,
    broadExposureCount,
    unclassifiedStackCount,
  };
}
