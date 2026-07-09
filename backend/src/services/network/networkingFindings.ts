/**
 * Node-scoped networking findings derived from effective-model stack facts,
 * exposure intents, and the shared dependency snapshot.
 */
import { createHash } from 'crypto';
import type { DependencySnapshot } from '../DockerController';
import { DatabaseService } from '../DatabaseService';
import type { StackNetworkFacts } from './types';
import { isHostNetwork } from './normalize';
import type { ExposureIntent } from './types';
import type { NetworkingFinding, NetworkingFindingKind, NetworkingNetworkBase } from './networkingTypes';

function finding(
  kind: NetworkingFindingKind,
  severity: NetworkingFinding['severity'],
  title: string,
  message: string,
  extra: Pick<NetworkingFinding, 'stack' | 'network' | 'service'> = {},
): NetworkingFinding {
  const idPayload = [kind, message, extra.stack ?? '', extra.network ?? '', extra.service ?? ''].join('\0');
  const id = createHash('sha256').update(idPayload).digest('hex').slice(0, 16);
  return { id, kind, severity, title, message, ...extra };
}

function effectiveIntent(
  stack: string,
  service: string,
  stackIntent: ExposureIntent | null,
  byService: Map<string, ExposureIntent>,
): ExposureIntent | null {
  return byService.get(service) ?? stackIntent;
}

function publishesPort(facts: StackNetworkFacts, serviceName: string): boolean {
  const svc = facts.services.find(s => s.name === serviceName);
  if (!svc) return false;
  return svc.publishedPorts.length > 0 || isHostNetwork(svc.networkMode);
}

export function buildNodeNetworkingFindings(
  nodeId: number,
  snapshot: DependencySnapshot,
  stackFacts: StackNetworkFacts[],
  baseNetworks: NetworkingNetworkBase[],
): NetworkingFinding[] {
  const out: NetworkingFinding[] = [];
  const db = DatabaseService.getInstance();
  const networkByName = new Map(baseNetworks.map(n => [n.name, n]));

  for (const facts of stackFacts) {
    if (!facts.renderable) continue;

    const intents = db.getStackExposureIntents(nodeId, facts.stack);
    const stackIntent = intents.find(i => i.service === '')?.intent ?? null;
    const byService = new Map(intents.filter(i => i.service !== '').map(i => [i.service, i.intent]));

    for (const net of facts.networks) {
      if (net.external && facts.drift.missingFromRuntime.includes(net.name)) {
        out.push(finding(
          'external-network-missing',
          'error',
          'External network not found',
          `Stack "${facts.stack}" requires the external network "${net.name}", which is not present on this node.`,
          { stack: facts.stack, network: net.name },
        ));
      }
      if (!net.external && net.createdByStack && facts.drift.missingFromRuntime.includes(net.name)) {
        out.push(finding(
          'network-missing',
          'warning',
          'Declared network missing',
          `Stack "${facts.stack}" declares network "${net.name}" but it does not exist in the runtime.`,
          { stack: facts.stack, network: net.name },
        ));
      }
      if (!net.external && net.createdByStack && facts.drift.declaredButUnused.includes(net.key)) {
        out.push(finding(
          'declared-network-unused',
          'info',
          'Declared network unused',
          `Stack "${facts.stack}" declares network "${net.name}" but no running service is attached.`,
          { stack: facts.stack, network: net.name },
        ));
      }
    }

    for (const row of facts.drift.runtimeOnlyAttachments) {
      out.push(finding(
        'network-undeclared',
        'warning',
        'Undeclared network attachment',
        `Container "${row.container}" (${row.service ?? 'unknown service'}) is attached to undeclared network "${row.network}".`,
        { stack: facts.stack, network: row.network, service: row.service ?? undefined },
      ));
    }

    for (const row of facts.drift.foreignNetworkAttachments) {
      out.push(finding(
        'foreign-network-attachment',
        'warning',
        'Foreign network attachment',
        `Container "${row.container}" in stack "${facts.stack}" is attached to network "${row.network}" owned elsewhere.`,
        { stack: facts.stack, network: row.network },
      ));
    }

    for (const svc of facts.services) {
      if (isHostNetwork(svc.networkMode)) {
        out.push(finding(
          'network-mode-host',
          'warning',
          'Host network mode',
          `Service "${svc.name}" in stack "${facts.stack}" uses network_mode: host.`,
          { stack: facts.stack, service: svc.name },
        ));
      }

      for (const port of svc.publishedPorts) {
        if (port.allInterfaces) {
          out.push(finding(
            'exposure-all-interfaces',
            'warning',
            'Port bound on all interfaces',
            `Service "${svc.name}" in stack "${facts.stack}" publishes ${port.startPort}/${port.protocol} on all interfaces.`,
            { stack: facts.stack, service: svc.name },
          ));
        }
      }

      const intent = effectiveIntent(facts.stack, svc.name, stackIntent, byService);
      if (publishesPort(facts, svc.name) && (intent === null || intent === 'unknown')) {
        out.push(finding(
          'exposure-unclassified',
          'info',
          'Publishing without exposure intent',
          `Stack "${facts.stack}" publishes ports from "${svc.name}" without a classified exposure intent.`,
          { stack: facts.stack, service: svc.name },
        ));
      }
      if (publishesPort(facts, svc.name) && intent === 'internal' && svc.publishedPorts.some(p => !p.loopbackOnly)) {
        out.push(finding(
          'exposure-internal-conflict',
          'warning',
          'Internal intent with host publish',
          `Service "${svc.name}" is classified internal but publishes ports to the host.`,
          { stack: facts.stack, service: svc.name },
        ));
      }
    }

    const aliasByNetwork = new Map<string, Map<string, string[]>>();
    for (const svc of facts.services) {
      for (const membership of svc.networks) {
        const net = facts.networks.find(n => n.key === membership.key);
        const runtimeName = net?.name ?? membership.key;
        for (const alias of membership.aliases) {
          const bucket = aliasByNetwork.get(runtimeName) ?? new Map<string, string[]>();
          const list = bucket.get(alias) ?? [];
          list.push(svc.name);
          bucket.set(alias, list);
          aliasByNetwork.set(runtimeName, bucket);
        }
      }
    }
    for (const [runtimeName, aliases] of aliasByNetwork) {
      for (const [alias, services] of aliases) {
        if (services.length > 1) {
          out.push(finding(
            'alias-collision',
            'error',
            'Duplicate network alias',
            `Alias "${alias}" on network "${runtimeName}" is used by multiple services in stack "${facts.stack}": ${services.join(', ')}.`,
            { stack: facts.stack, network: runtimeName },
          ));
        }
      }
    }
  }

  const stacksByNetwork = new Map<string, Set<string>>();
  for (const c of snapshot.containers) {
    if (!c.stack) continue;
    for (const attached of c.networks) {
      const set = stacksByNetwork.get(attached.name) ?? new Set<string>();
      set.add(c.stack);
      stacksByNetwork.set(attached.name, set);
    }
  }
  for (const [networkName, stacks] of stacksByNetwork) {
    if (stacks.size > 1) {
      out.push(finding(
        'shared-network',
        'info',
        'Shared network',
        `Network "${networkName}" connects containers from ${stacks.size} stacks: ${[...stacks].sort().join(', ')}.`,
        { network: networkName },
      ));
    }
  }

  const declaredNames = new Map<string, string[]>();
  for (const facts of stackFacts) {
    if (!facts.renderable) continue;
    for (const net of facts.networks) {
      const owners = declaredNames.get(net.name) ?? [];
      owners.push(facts.stack);
      declaredNames.set(net.name, owners);
    }
  }
  for (const [name, stacks] of declaredNames) {
    const unique = [...new Set(stacks)];
    if (unique.length > 1) {
      out.push(finding(
        'network-name-collision',
        'warning',
        'Network name collision',
        `Multiple stacks resolve to the same network name "${name}": ${unique.join(', ')}.`,
        { network: name },
      ));
    }
  }

  for (const f of out) {
    if (f.network && !networkByName.has(f.network)) {
      const snap = snapshot.networks.find(n => n.name === f.network);
      if (snap) networkByName.set(snap.name, { id: snap.id, name: snap.name } as NetworkingNetworkBase);
    }
  }

  return out;
}
