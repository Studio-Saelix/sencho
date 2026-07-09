/**
 * Shared node networking aggregate: one Docker snapshot per request, effective-model
 * stack facts, findings, enriched inventory, and optional topology.
 */
import DockerController, { type DependencySnapshot } from '../DockerController';
import { FileSystemService } from '../FileSystemService';
import { DatabaseService } from '../DatabaseService';
import { buildStackNetworkFacts } from './composeNetworkInspector';
import { buildNodeNetworkingFindings } from './networkingFindings';
import { enrichNetworkRows } from './networkingInventory';
import { buildNetworkingTopology } from './networkingTopology';
import { isHostNetwork, isLoopback } from './normalize';
import type { ExposureIntent } from './types';
import type {
  NodeNetworkingAggregate,
  NodeNetworkingOverview,
  NetworkingAggregateDepth,
} from './networkingTypes';
import { getErrorMessage } from '../../utils/errors';
import { sanitizeForLog } from '../../utils/safeLog';

export async function buildNodeNetworkingAggregate(
  nodeId: number,
  options: { depth: NetworkingAggregateDepth; includeSystem?: boolean },
): Promise<NodeNetworkingAggregate> {
  const fsSvc = FileSystemService.getInstance(nodeId);
  const stacks = await fsSvc.getStacks();

  const snapshot = await DockerController.getInstance(nodeId).getDependencySnapshot(stacks);
  const baseRows = DockerController.classifySnapshotNetworks(snapshot, stacks);

  const stackFacts = await Promise.all(
    stacks.map(stack => buildStackNetworkFacts(nodeId, stack, snapshot)),
  );

  const findings = buildNodeNetworkingFindings(nodeId, snapshot, stackFacts, baseRows);
  const networks = enrichNetworkRows(nodeId, baseRows, stackFacts, snapshot, findings);
  const overview = buildOverview(nodeId, stacks, snapshot, stackFacts, findings);

  const aggregate: NodeNetworkingAggregate = {
    overview,
    networks,
    findings,
    stackFacts,
  };

  if (options.depth === 'topology') {
    aggregate.topology = buildNetworkingTopology(
      snapshot,
      stackFacts,
      findings,
      options.includeSystem === true,
    );
  }

  return aggregate;
}

function buildOverview(
  nodeId: number,
  stacks: string[],
  snapshot: DependencySnapshot,
  stackFacts: Awaited<ReturnType<typeof buildStackNetworkFacts>>[],
  findings: ReturnType<typeof buildNodeNetworkingFindings>,
): NodeNetworkingOverview {
  const db = DatabaseService.getInstance();
  const renderFailedStacks = stackFacts.filter(f => !f.renderable).map(f => f.stack);

  let exposedStackCount = 0;
  let unknownExposureStackCount = 0;
  let missingExternalCount = 0;

  for (const facts of stackFacts) {
    if (!facts.renderable) continue;

    const intents = db.getStackExposureIntents(nodeId, facts.stack);
    const stackIntent = intents.find(i => i.service === '')?.intent ?? null;
    const byService = new Map(intents.filter(i => i.service !== '').map(i => [i.service, i.intent]));

    const publishes = (svc: typeof facts.services[number]): boolean =>
      svc.publishedPorts.length > 0 || isHostNetwork(svc.networkMode);

    const isExposed = facts.services.some(s =>
      isHostNetwork(s.networkMode) || s.publishedPorts.some(p => !isLoopback(p.hostIp)),
    );
    if (isExposed) exposedStackCount += 1;

    const anyUnclassified = facts.services
      .filter(publishes)
      .some(s => {
        const intent: ExposureIntent | null = byService.get(s.name) ?? stackIntent;
        return intent === null || intent === 'unknown';
      });
    if (anyUnclassified && facts.services.some(publishes)) unknownExposureStackCount += 1;

    missingExternalCount += facts.networks.filter(n =>
      n.external && facts.drift.missingFromRuntime.includes(n.name),
    ).length;
  }

  const connectedContainerCount = new Set(
    snapshot.containers.flatMap(c => c.networks.map(_n => c.id)),
  ).size;

  return {
    networkCount: snapshot.networks.length,
    stackCount: stacks.length,
    connectedContainerCount,
    systemNetworkCount: snapshot.networks.filter(n => n.isSystem).length,
    exposedStackCount,
    unknownExposureStackCount,
    missingExternalCount,
    networkCollisionCount: findings.filter(f => f.kind === 'network-name-collision').length,
    findingCount: findings.length,
    renderFailedStacks,
  };
}

export async function loadNetworkingSnapshot(nodeId: number): Promise<{
  stacks: string[];
  snapshot: DependencySnapshot;
}> {
  const stacks = await FileSystemService.getInstance(nodeId).getStacks();
  try {
    const snapshot = await DockerController.getInstance(nodeId).getDependencySnapshot(stacks);
    return { stacks, snapshot };
  } catch (error) {
    console.error('[Networking] Snapshot failed on node %d:', nodeId, sanitizeForLog(getErrorMessage(error, 'unknown')));
    throw error;
  }
}
