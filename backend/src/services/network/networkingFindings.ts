/**
 * Node-scoped networking findings derived from effective-model stack facts,
 * exposure intents, and the shared dependency snapshot.
 */
import { createHash } from 'crypto';
import type { DependencySnapshot } from '../DockerController';
import type { ExposureIntent, StackNetworkFacts } from './types';
import { isHostNetwork } from './normalize';
import { getExposureContext, type ExposureContext } from './exposureContext';
import type { NetworkingFinding, NetworkingFindingKind, NetworkingNetworkBase, NetworkingRecommendedAction } from './networkingTypes';

type FindingExtra = Pick<NetworkingFinding, 'stack' | 'network' | 'service'>;

function finding(
  kind: NetworkingFindingKind,
  severity: NetworkingFinding['severity'],
  title: string,
  message: string,
  extra: FindingExtra = {},
  recommendedActions: NetworkingRecommendedAction[] = [],
): NetworkingFinding {
  const idPayload = [kind, message, extra.stack ?? '', extra.network ?? '', extra.service ?? ''].join('\0');
  return {
    id: createHash('sha256').update(idPayload).digest('hex').slice(0, 16),
    kind,
    severity,
    title,
    message,
    ...extra,
    evidence: [
      ...(extra.stack ? [{ label: 'Stack', value: extra.stack }] : []),
      ...(extra.service ? [{ label: 'Service', value: extra.service }] : []),
      ...(extra.network ? [{ label: 'Network', value: extra.network }] : []),
    ],
    recommendedActions,
    sources: ['live'],
    doctorFindings: [],
  };
}

function stackActions(stack: string): NetworkingRecommendedAction[] {
  return [{ kind: 'open-stack-networking', label: 'Open stack networking', stack }];
}

function effectiveIntent(service: string, stackIntent: ExposureIntent | null, byService: Record<string, ExposureIntent>): ExposureIntent | null {
  return byService[service] ?? stackIntent ?? null;
}

/** Host-mode severity matrix, parameterized by documented Dossier access.
 *  Internal/same-node are a contradiction regardless of documentation: high. Unset
 *  and unknown are unclassified exposure under host networking (no network
 *  isolation): high.
 *  Everything else (lan/public/reverse-proxy/temporary) is medium undocumented,
 *  info when a Dossier access URL documents the exposure. */
export function hostModeSeverity(intent: ExposureIntent | null, hasAccessUrls: boolean): NetworkingFinding['severity'] {
  if (intent === 'internal' || intent === 'same-node') return 'high';
  if (intent === null || intent === 'unknown') return 'high';
  return hasAccessUrls ? 'info' : 'medium';
}

function addExposureFindings(
  out: NetworkingFinding[],
  facts: StackNetworkFacts,
  context: ExposureContext,
): void {
  const stackIntent = context.available ? context.stackIntent : null;
  const byService = context.available ? context.serviceIntents : {};
  const hasAccessUrls = context.available && context.hasAccessUrls;

  for (const service of facts.services) {
    const hostMode = isHostNetwork(service.networkMode);
    const publishes = hostMode || service.publishedPorts.length > 0;
    if (!publishes) continue;
    const intent = effectiveIntent(service.name, stackIntent, byService);
    const intentAction: NetworkingRecommendedAction = {
      kind: 'set-exposure-intent', label: 'Set exposure intent', stack: facts.stack, service: service.name,
    };
    if (hostMode) {
      // Structural fact; stays visible even when exposure context is unavailable,
      // at the neutral fallback severity (no intent/Dossier interpretation).
      out.push(finding(
        'network-mode-host',
        context.available ? hostModeSeverity(intent, hasAccessUrls) : 'medium',
        'Host network mode',
        `Service "${service.name}" in stack "${facts.stack}" uses network_mode: host.`,
        { stack: facts.stack, service: service.name },
        [intentAction, ...stackActions(facts.stack)],
      ));
      continue;
    }
    const broad = service.publishedPorts.some(port => port.allInterfaces);
    if (!context.available) {
      // Structural all-interface bind fact stays visible at fallback severity;
      // intent-dependent interpretation (unclassified/mismatch) is skipped.
      if (broad) {
        out.push(finding(
          'exposure-all-interfaces',
          'medium',
          'Port bound on all interfaces',
          `Service "${service.name}" in stack "${facts.stack}" publishes ports on all interfaces.`,
          { stack: facts.stack, service: service.name },
          [intentAction],
        ));
      }
      continue;
    }
    if (intent === null || intent === 'unknown') {
      out.push(finding(
        'exposure-unclassified',
        'info',
        'Publishing without exposure intent',
        `Stack "${facts.stack}" publishes ports from "${service.name}" without a classified exposure intent.`,
        { stack: facts.stack, service: service.name },
        [intentAction],
      ));
    }
    if ((intent === 'internal' || intent === 'same-node') && service.publishedPorts.some(port => !port.loopbackOnly)) {
      out.push(finding(
        'exposure-intent-mismatch',
        'high',
        intent === 'internal' ? 'Internal intent with host publish' : 'Same-node intent with host publish',
        `Service "${service.name}" is classified ${intent} but publishes ports to the host.`,
        { stack: facts.stack, service: service.name },
        [intentAction],
      ));
    } else if (intent === 'temporary' && broad) {
      out.push(finding(
        'exposure-intent-mismatch',
        'medium',
        'Temporary exposure is broadly bound',
        `Service "${service.name}" is marked temporary and publishes on all interfaces.`,
        { stack: facts.stack, service: service.name },
        [intentAction],
      ));
    } else if (broad && intent !== 'public' && intent !== 'reverse-proxy') {
      out.push(finding(
        'exposure-all-interfaces',
        'medium',
        'Port bound on all interfaces',
        `Service "${service.name}" in stack "${facts.stack}" publishes ports on all interfaces.`,
        { stack: facts.stack, service: service.name },
        [intentAction],
      ));
    }
  }
}

function addCrossStackDnsFindings(out: NetworkingFinding[], stackFacts: StackNetworkFacts[], baseNetworks: NetworkingNetworkBase[]): void {
  const runtimeNetworks = new Map(baseNetworks.map(network => [network.name, network]));
  const entriesByNetwork = new Map<string, Array<{ stack: string; service: string; names: string[] }>>();
  for (const facts of stackFacts.filter(facts => facts.renderable)) {
    for (const service of facts.services) {
      for (const membership of service.networks) {
        const declared = facts.networks.find(network => network.key === membership.key);
        const networkName = declared?.name ?? membership.key;
        const network = runtimeNetworks.get(networkName);
        if (network?.isSystem || network?.ingress) continue;
        const shared = declared?.external === true || (network?.connectedCount ?? 0) > 1;
        if (!shared) continue;
        const entries = entriesByNetwork.get(networkName) ?? [];
        entries.push({ stack: facts.stack, service: service.name, names: [service.name, ...membership.aliases] });
        entriesByNetwork.set(networkName, entries);
      }
    }
  }
  for (const [networkName, entries] of entriesByNetwork) {
    const names = new Map<string, Array<{ stack: string; service: string; isAlias: boolean }>>();
    for (const entry of entries) {
      entry.names.forEach((name, index) => {
        const values = names.get(name) ?? [];
        values.push({ stack: entry.stack, service: entry.service, isAlias: index > 0 });
        names.set(name, values);
      });
    }
    for (const [name, owners] of names) {
      const distinct = new Set(owners.map(owner => `${owner.stack}\0${owner.service}`));
      if (distinct.size < 2) continue;
      const allServices = owners.every(owner => !owner.isAlias);
      out.push(finding(
        allServices ? 'service-name-collision' : 'alias-collision',
        allServices ? 'medium' : 'high',
        allServices ? 'Duplicate service name on shared network' : 'Duplicate DNS name on shared network',
        `Name "${name}" resolves to multiple services on shared network "${networkName}".`,
        { network: networkName },
        [{ kind: 'filter-topology', label: 'View network topology', networkName }],
      ));
    }
  }
}

function addComposeDriftFindings(
  out: NetworkingFinding[],
  facts: StackNetworkFacts,
  baseNetworks: NetworkingNetworkBase[],
): void {
  const networkIds = new Map(baseNetworks.map((network) => [network.name, network.id]));
  for (const network of facts.networks) {
    if (!network.external && network.createdByStack && facts.drift.missingFromRuntime.includes(network.name)) {
      out.push(finding(
        'network-missing',
        'high',
        'Declared network missing',
        `Stack "${facts.stack}" declares network "${network.name}" but it does not exist in the runtime.`,
        { stack: facts.stack, network: network.name },
        [...stackActions(facts.stack), { kind: 'copy-docker-command', label: 'Copy Docker command', commandKind: 'network-create', networkName: network.name }],
      ));
    }
    if (!network.external && network.createdByStack && facts.drift.declaredButUnused.includes(network.key)) {
      out.push(finding(
        'declared-network-unused',
        'medium',
        'Declared network unused',
        `Stack "${facts.stack}" declares network "${network.name}" but no running service is attached.`,
        { stack: facts.stack, network: network.name },
        stackActions(facts.stack),
      ));
    }
  }
  for (const attachment of facts.drift.runtimeOnlyAttachments) {
    out.push(finding(
      'network-undeclared',
      'high',
      'Undeclared network attachment',
      `Container "${attachment.container}" (${attachment.service ?? 'unknown service'}) is attached to undeclared network "${attachment.network}".`,
      { stack: facts.stack, network: attachment.network, service: attachment.service ?? undefined },
      [...stackActions(facts.stack), ...(networkIds.has(attachment.network) ? [{ kind: 'inspect-network', label: 'Inspect network', networkId: networkIds.get(attachment.network)! } satisfies NetworkingRecommendedAction] : [])],
    ));
  }
  for (const attachment of facts.drift.foreignNetworkAttachments) {
    out.push(finding(
      'foreign-network-attachment',
      'high',
      'Foreign network attachment',
      `Container "${attachment.container}" in stack "${facts.stack}" is attached to network "${attachment.network}" owned elsewhere.`,
      { stack: facts.stack, network: attachment.network },
      [...stackActions(facts.stack), ...(networkIds.has(attachment.network) ? [{ kind: 'inspect-network', label: 'Inspect network', networkId: networkIds.get(attachment.network)! } satisfies NetworkingRecommendedAction] : [])],
    ));
  }
}

function addSharedNetworkFindings(
  out: NetworkingFinding[],
  snapshot: DependencySnapshot,
  stackFacts: StackNetworkFacts[],
): void {
  const stacksByNetwork = new Map<string, Set<string>>();
  for (const container of snapshot.containers) {
    if (!container.stack) continue;
    for (const attached of container.networks) {
      const stacks = stacksByNetwork.get(attached.name) ?? new Set<string>();
      stacks.add(container.stack);
      stacksByNetwork.set(attached.name, stacks);
    }
  }
  for (const [networkName, stacks] of stacksByNetwork) {
    if (stacks.size < 2) continue;
    out.push(finding(
      'shared-network',
      'info',
      'Shared network',
      `Network "${networkName}" connects containers from ${stacks.size} stacks: ${[...stacks].sort().join(', ')}.`,
      { network: networkName },
      [{ kind: 'filter-topology', label: 'View network topology', networkName }],
    ));
  }

  // Only genuinely unsafe name collisions are worth a warning: two or more stacks
  // declaring a NON-external network that happens to resolve to the same literal
  // name (a forced `name:` override colliding by accident). Two or more stacks
  // that all declare the SAME network as `external: true` is the ordinary
  // shared-external-network pattern, already covered above as an info-level
  // "shared network" finding, not a collision.
  const declaredNames = new Map<string, { stack: string; external: boolean }[]>();
  for (const facts of stackFacts) {
    if (!facts.renderable) continue;
    for (const network of facts.networks) {
      const entries = declaredNames.get(network.name) ?? [];
      entries.push({ stack: facts.stack, external: network.external === true });
      declaredNames.set(network.name, entries);
    }
  }
  for (const [networkName, entries] of declaredNames) {
    const uniqueStacks = [...new Set(entries.map((e) => e.stack))];
    if (uniqueStacks.length < 2) continue;
    const allExternal = entries.every((e) => e.external);
    if (allExternal) continue;
    out.push(finding(
      'network-name-collision',
      'medium',
      'Network name collision',
      `Multiple stacks resolve to the same network name "${networkName}": ${uniqueStacks.join(', ')}.`,
      { network: networkName },
      [{ kind: 'filter-topology', label: 'View network topology', networkName }],
    ));
  }
}

function largeFlatSeverity(connectedCount: number): NetworkingFinding['severity'] {
  if (connectedCount >= 1000) return 'high';
  if (connectedCount >= 500) return 'medium';
  return 'info';
}

export function buildNodeNetworkingFindings(
  nodeId: number,
  snapshot: DependencySnapshot | null,
  stackFacts: StackNetworkFacts[],
  baseNetworks: NetworkingNetworkBase[],
): NetworkingFinding[] {
  const out: NetworkingFinding[] = [];
  if (!snapshot) {
    out.push(finding(
      'runtime-unavailable', 'info', 'Runtime networking unavailable',
      'Sencho could not read Docker networking state on this node.',
      {},
      [
        { kind: 'refresh', label: 'Refresh runtime data' },
        { kind: 'open-docs', label: 'Open troubleshooting guide', docsPath: '/operations/troubleshooting' },
      ],
    ));
  }

  for (const facts of stackFacts) {
    if (!facts.renderable) continue;
    const context = getExposureContext(nodeId, facts.stack);
    addExposureFindings(out, facts, context);

    if (!snapshot) continue;
    addComposeDriftFindings(out, facts, baseNetworks);
    for (const missing of facts.missingExternalNetworks) {
      const isRunning = snapshot.containers.some(container => container.stack === facts.stack && ['running', 'restarting'].includes(container.state));
      const actions: NetworkingRecommendedAction[] = [
        { kind: 'open-stack-editor', label: 'Open stack editor', stack: facts.stack },
      ];
      if (missing.safe) {
        actions.unshift(
          { kind: 'create-network', label: 'Create network', networkName: missing.name, requiresAdmin: true },
          { kind: 'copy-compose-snippet', label: 'Copy Compose snippet', snippetKind: 'external-network', networkName: missing.name },
          { kind: 'copy-docker-command', label: 'Copy Docker command', commandKind: 'network-create', networkName: missing.name },
        );
      }
      const reasonSuffix = missing.safe
        ? ''
        : ` Sencho cannot create it automatically (${[
          missing.blockReason === 'unsupported_driver'
            ? `unsupported driver kind(s): ${[...new Set(missing.declarations.map((d) => d.driverKind))].join(', ')}`
            : null,
          missing.unsupportedFeatures.length > 0
            ? `unsupported options: ${missing.unsupportedFeatures.join(', ')}`
            : null,
          missing.blockReason === 'invalid_name' ? 'invalid Docker network name' : null,
          missing.blockReason === 'reserved_system' ? 'reserved system network name' : null,
        ].filter(Boolean).join('; ')}).`;
      out.push(finding(
        'external-network-missing', isRunning ? 'critical' : 'high', 'External network not found',
        `Stack "${facts.stack}" requires the external network "${missing.name}" (Compose keys: ${missing.keys.join(', ')}), which is not present on this node.${reasonSuffix}`,
        { stack: facts.stack, network: missing.name },
        actions,
      ));
    }
  }

  if (!snapshot) return out;
  addSharedNetworkFindings(out, snapshot, stackFacts);
  addCrossStackDnsFindings(out, stackFacts, baseNetworks);
  for (const network of baseNetworks) {
    if (network.isSystem || network.ingress || ['host', 'none'].includes(network.driver)) continue;
    if (network.connectedCount >= 100) {
      out.push(finding(
        'large-flat-network', largeFlatSeverity(network.connectedCount), 'Large flat network',
        `Network "${network.name}" has ${network.connectedCount} connected endpoints.`,
        { network: network.name },
        [{ kind: 'filter-topology', label: 'View network topology', networkName: network.name }],
      ));
    }
    if (['overlay', 'macvlan', 'ipvlan'].includes(network.driver) || network.enableIPv6) {
      out.push(finding(
        'advanced-driver-caveat', 'info', 'Advanced network configuration',
        `Network "${network.name}" uses ${network.enableIPv6 ? 'IPv6 or ' : ''}${network.driver} networking.`,
        { network: network.name },
        [{ kind: 'inspect-network', label: 'Inspect network', networkId: network.id }],
      ));
    }
  }
  return out;
}
