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

export function enrichNetworkRows(
  nodeId: number,
  baseRows: NetworkingNetworkBase[],
  stackFacts: StackNetworkFacts[],
  snapshot: DependencySnapshot,
  findings: NetworkingFinding[],
): NetworkingNetworkRow[] {
  const stacksByNetwork = new Map<string, Set<string>>();
  for (const c of snapshot.containers) {
    for (const attached of c.networks) {
      const set = stacksByNetwork.get(attached.name) ?? new Set<string>();
      if (c.stack) set.add(c.stack);
      stacksByNetwork.set(attached.name, set);
    }
  }

  const findingsByNetwork = new Map<string, string[]>();
  for (const f of findings) {
    if (!f.network) continue;
    const list = findingsByNetwork.get(f.network) ?? [];
    list.push(f.id);
    findingsByNetwork.set(f.network, list);
  }

  return baseRows.map(row => ({
    ...row,
    sharedStackCount: stacksByNetwork.get(row.name)?.size ?? 0,
    exposureSummary: buildExposureSummary(nodeId, row.name, stackFacts, snapshot),
    findingIds: findingsByNetwork.get(row.name) ?? [],
  }));
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
