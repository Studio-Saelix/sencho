/**
 * Compose-aware topology built from the aggregate snapshot and stack facts.
 * No additional Docker API calls.
 */
import type { DependencySnapshot } from '../DockerController';
import { DatabaseService } from '../DatabaseService';
import type { ExposureIntent, StackNetworkFacts } from './types';
import { isHostNetwork } from './normalize';
import type {
  NetworkingFinding,
  NetworkingOwnership,
  NetworkingTopology,
  NetworkingTopologyContainer,
  NetworkingTopologyNetwork,
} from './networkingTypes';
import { indexFindingIdsByNetwork, stacksDeclaringNetwork } from './networkingInventory';

const RUNNING_STATES = new Set(['running', 'restarting']);

function aliasMapForStack(facts: StackNetworkFacts): Map<string, Map<string, string[]>> {
  const byRuntime = new Map<string, Map<string, string[]>>();
  for (const service of facts.services) {
    for (const membership of service.networks) {
      const network = facts.networks.find((item) => item.key === membership.key);
      const runtimeName = network?.name ?? membership.key;
      const bucket = byRuntime.get(runtimeName) ?? new Map<string, string[]>();
      for (const alias of membership.aliases) {
        const list = bucket.get(alias) ?? [];
        list.push(service.name);
        bucket.set(alias, list);
      }
      byRuntime.set(runtimeName, bucket);
    }
  }
  return byRuntime;
}

function ownershipForNetwork(net: DependencySnapshot['networks'][number]): NetworkingOwnership {
  if (net.isSystem || net.ingress) return 'system';
  if (net.stack) return 'sencho-managed';
  if (net.composeProject) return 'compose-managed';
  return 'unmanaged';
}

function aliasesForService(
  aliasesByStack: Map<string, Map<string, Map<string, string[]>>>,
  stack: string | null,
  service: string | null,
  networkName: string,
): string[] {
  if (!stack || !service) return [];
  const networkAliases = aliasesByStack.get(stack)?.get(networkName);
  if (!networkAliases) return [];
  return [...networkAliases.entries()]
    .filter(([, services]) => services.includes(service))
    .map(([alias]) => alias);
}

export function buildNetworkingTopology(
  nodeId: number,
  snapshot: DependencySnapshot | null,
  stackFacts: StackNetworkFacts[],
  findings: NetworkingFinding[],
  includeSystem: boolean,
): NetworkingTopology {
  if (!snapshot) return { networks: [], includeSystem };

  const findingsByNetwork = indexFindingIdsByNetwork(findings);
  const aliasesByStack = new Map(stackFacts.map((facts) => [facts.stack, aliasMapForStack(facts)]));
  const intentsByStack = new Map(stackFacts.map((facts) => {
    const intents = DatabaseService.getInstance().getStackExposureIntents(nodeId, facts.stack);
    return [facts.stack, new Map(intents.map((intent) => [intent.service, intent.intent]))];
  }));

  const networks: NetworkingTopologyNetwork[] = [];
  for (const net of snapshot.networks) {
    if (net.isSystem && !includeSystem) continue;

    const containers: NetworkingTopologyContainer[] = [];
    for (const container of snapshot.containers) {
      if (!RUNNING_STATES.has(container.state)) continue;
      for (const attached of container.networks) {
        if (attached.name !== net.name && attached.id !== net.id) continue;
        containers.push({
          id: container.id,
          name: container.name,
          ip: attached.ip,
          state: container.state,
          image: container.image,
          stack: container.stack,
          service: container.service,
          composeAliases: aliasesForService(aliasesByStack, container.stack, container.service, net.name),
          publishedPorts: findService(container.stack, container.service, stackFacts)?.publishedPorts ?? [],
          exposureIntent: container.stack && container.service
            ? getExposureIntent(container.stack, container.service, intentsByStack)
            : null,
          findingIds: findingsByNetwork.get(net.name) ?? [],
          driftFlags: getDriftFlags(container.stack, container.service, net.name, stackFacts),
          hostMode: isHostNetwork(findService(container.stack, container.service, stackFacts)?.networkMode),
        });
      }
    }

    const declaredExternalByStacks = stacksDeclaringNetwork(stackFacts, net.name, true);
    networks.push({
      id: net.id,
      name: net.name,
      driver: net.driver,
      scope: net.scope,
      stack: net.stack,
      isSystem: net.isSystem,
      ingress: net.ingress === true,
      enableIPv6: net.enableIPv6,
      ownership: ownershipForNetwork(net),
      declaredByStacks: stacksDeclaringNetwork(stackFacts, net.name),
      declaredExternalByStacks,
      isExternalDependency: declaredExternalByStacks.length > 0,
      runtimeState: 'present',
      findingIds: findingsByNetwork.get(net.name) ?? [],
      containers,
    });
  }

  const presentNames = new Set(snapshot.networks.map((network) => network.name));
  for (const facts of stackFacts) {
    if (!facts.renderable) continue;
    for (const declared of facts.networks) {
      if (!declared.external || presentNames.has(declared.name)) continue;
      const existing = networks.find((network) => network.name === declared.name);
      if (existing) {
        if (!existing.declaredExternalByStacks.includes(facts.stack)) {
          existing.declaredExternalByStacks.push(facts.stack);
          existing.isExternalDependency = true;
        }
        continue;
      }
      networks.push({
        id: `missing:${encodeURIComponent(declared.name)}`,
        name: declared.name,
        driver: 'unknown',
        scope: 'unknown',
        stack: null,
        isSystem: false,
        ingress: false,
        ownership: 'unmanaged',
        declaredByStacks: [facts.stack],
        declaredExternalByStacks: [facts.stack],
        isExternalDependency: true,
        runtimeState: 'missing',
        findingIds: findingsByNetwork.get(declared.name) ?? [],
        containers: [],
      });
    }
  }

  return { networks, includeSystem };
}

function findService(stack: string | null, service: string | null, facts: StackNetworkFacts[]) {
  return facts.find((item) => item.stack === stack)?.services.find((candidate) => candidate.name === service);
}

function getExposureIntent(
  stack: string,
  service: string,
  intentsByStack: Map<string, Map<string, ExposureIntent>>,
): ExposureIntent | null {
  const intents = intentsByStack.get(stack);
  return intents?.get(service) ?? intents?.get('') ?? null;
}

function getDriftFlags(
  stack: string | null,
  service: string | null,
  network: string,
  facts: StackNetworkFacts[],
): string[] {
  if (!stack) return [];
  const current = facts.find((item) => item.stack === stack);
  if (!current) return [];
  const flags: string[] = [];
  if (current.drift.runtimeOnlyAttachments.some((item) => item.network === network && item.service === service)) {
    flags.push('undeclared-attachment');
  }
  if (current.drift.foreignNetworkAttachments.some((item) => item.network === network)) {
    flags.push('foreign-attachment');
  }
  if (current.drift.missingFromRuntime.includes(network)) {
    flags.push('missing-runtime-network');
  }
  return flags;
}
