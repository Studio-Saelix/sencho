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
    if (!finding.network || finding.acknowledged) continue;
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
    const byName = new Map(facts.services.map(service => [service.name, service]));

    let stackBroad = false;
    let stackUnclassified = false;
    for (const svc of facts.services) {
      // A service in another service's namespace has no networks: entries of
      // its own. Its traffic leaves through the namespace owner's network.
      if (!attachedToNetwork(svc, networkName, facts, byName)) continue;
      const owner = namespaceOwner(svc.name, byName);
      // A tunnel reaches the service over the connector's own networks, so it
      // counts on this network only when the connector is attached to it too.
      const connector = svc.tunnel ? byName.get(svc.tunnel.connector) : undefined;
      const tunneledHere = svc.tunnel !== undefined && connector !== undefined && attachedToNetwork(connector, networkName, facts, byName);
      const publishes = svc.publishedPorts.length > 0 || isHostNetwork(owner?.networkMode) || tunneledHere;
      // A public-edge tunnel can reach the internet, so the network carries
      // exposure beyond loopback even when no host port is published.
      if (svc.publishedPorts.some(p => p.allInterfaces) || isHostNetwork(owner?.networkMode) || (tunneledHere && svc.tunnel?.scope === 'public-edge')) stackBroad = true;
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

type FactService = StackNetworkFacts['services'][number];

const SERVICE_MODE = /^service:(.+)$/;

/** The service whose network namespace `name` runs in (itself when it owns one).
 *  A `network_mode` cycle has no owner and resolves to an arbitrary member. */
function namespaceOwner(name: string, byName: Map<string, FactService>): FactService | undefined {
  let current = name;
  for (let hops = 0; hops < byName.size; hops += 1) {
    const target = byName.get(current)?.networkMode?.match(SERVICE_MODE)?.[1];
    if (!target || !byName.has(target)) return byName.get(current);
    current = target;
  }
  return byName.get(current);
}

/** `network_mode: bridge`, or `default`, which Docker runs on its default bridge. */
function usesDefaultBridgeMode(mode: string | undefined): boolean {
  return mode === 'bridge' || mode === 'default';
}

/** Whether a service's traffic reaches `networkName`, following a
 *  `network_mode: service:<x>` chain to the service that owns the namespace.
 *  Docker's default bridge and host network are named as the snapshot does. */
function attachedToNetwork(
  service: FactService,
  networkName: string,
  facts: StackNetworkFacts,
  byName: Map<string, FactService>,
): boolean {
  const owner = namespaceOwner(service.name, byName);
  if (!owner) return false;
  if (isHostNetwork(owner.networkMode)) return networkName === 'host';
  if (usesDefaultBridgeMode(owner.networkMode)) return networkName === 'bridge';
  if (owner.networkMode !== undefined && owner.networkMode !== '') return false;
  // Compose attaches a service that names no network to the project's implicit
  // `default` network, matching the detector's own membership rule.
  const keys = owner.networks.length > 0 ? owner.networks.map(n => n.key) : ['default'];
  return keys.some((key) => {
    const net = facts.networks.find(nn => nn.key === key);
    return (net?.name ?? key) === networkName;
  });
}
