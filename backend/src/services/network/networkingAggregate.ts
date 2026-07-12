/**
 * Shared node networking aggregate: one Docker snapshot per request, effective-model
 * stack facts, findings, enriched inventory, and optional topology.
 */
import DockerController from '../DockerController';
import { FileSystemService } from '../FileSystemService';
import { DatabaseService } from '../DatabaseService';
import { buildStackNetworkFacts } from './composeNetworkInspector';
import { buildNodeNetworkingFindings } from './networkingFindings';
import { enrichNetworkRows } from './networkingInventory';
import { buildNetworkingTopology } from './networkingTopology';
import { isHostNetwork, isLoopback } from './normalize';
import type { ExposureIntent } from './types';
import type { DependencySnapshot } from '../DockerController';
import type { NodeNetworkingAggregate, NodeNetworkingOverview } from './networkingTypes';
import { getErrorMessage } from '../../utils/errors';
import { sanitizeForLog } from '../../utils/safeLog';
import { mapWithConcurrency } from '../../utils/mapWithConcurrency';
import { withComposeRenderSlot } from './composeRenderSemaphore';

export async function buildNodeNetworkingAggregate(
  nodeId: number,
  options: { includeTopology?: boolean; includeSystem?: boolean },
): Promise<NodeNetworkingAggregate> {
  const fsSvc = FileSystemService.getInstance(nodeId);
  const stacks = await fsSvc.getStacks();

  let snapshot: DependencySnapshot | null = null;
  try {
    snapshot = await DockerController.getInstance(nodeId).getDependencySnapshot(stacks);
  } catch (error) {
    console.warn('[Networking] Snapshot failed on node %d:', nodeId, sanitizeForLog(getErrorMessage(error, 'unknown')));
  }
  const baseRows = snapshot ? DockerController.classifySnapshotNetworks(snapshot, stacks) : [];

  const stackFacts = await mapWithConcurrency(stacks, 4, stack => withComposeRenderSlot(
    nodeId,
    () => buildStackNetworkFacts(nodeId, stack, snapshot),
  ));

  const findings = buildNodeNetworkingFindings(nodeId, snapshot, stackFacts, baseRows);
  const networks = snapshot ? enrichNetworkRows(nodeId, baseRows, stackFacts, snapshot, findings) : [];
  const overview = buildOverview(nodeId, stacks, snapshot, stackFacts, findings);

  const aggregate: NodeNetworkingAggregate = {
    overview,
    networks,
    findings,
    stackFacts,
    runtimeAvailable: snapshot !== null,
    recentActivity: DatabaseService.getInstance().getNodeStackActivity(nodeId, { limit: 20 }),
  };

  if (options.includeTopology) {
    aggregate.topology = buildNetworkingTopology(
      nodeId,
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
  snapshot: DependencySnapshot | null,
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
    const stackIntent = intents.find((intent) => intent.service === '')?.intent ?? null;
    const byService = new Map(
      intents.filter((intent) => intent.service !== '').map((intent) => [intent.service, intent.intent]),
    );

    const publishes = (service: (typeof facts.services)[number]): boolean =>
      service.publishedPorts.length > 0 || isHostNetwork(service.networkMode);

    if (facts.services.some((service) =>
      isHostNetwork(service.networkMode) || service.publishedPorts.some((port) => !isLoopback(port.hostIp)),
    )) {
      exposedStackCount += 1;
    }

    const hasUnclassifiedPublish = facts.services.some((service) => {
      if (!publishes(service)) return false;
      const intent: ExposureIntent | null = byService.get(service.name) ?? stackIntent;
      return intent === null || intent === 'unknown';
    });
    if (hasUnclassifiedPublish) unknownExposureStackCount += 1;

    missingExternalCount += facts.networks.filter((network) =>
      network.external && facts.drift.missingFromRuntime.includes(network.name),
    ).length;
  }

  const connectedContainerCount = snapshot
    ? snapshot.containers.filter((container) => container.networks.length > 0).length
    : null;

  return {
    runtimeAvailable: snapshot !== null,
    networkCount: snapshot?.networks.length ?? null,
    stackCount: stacks.length,
    connectedContainerCount,
    systemNetworkCount: snapshot?.networks.filter(n => n.isSystem).length ?? null,
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
  snapshot: DependencySnapshot | null;
}> {
  const stacks = await FileSystemService.getInstance(nodeId).getStacks();
  try {
    const snapshot = await DockerController.getInstance(nodeId).getDependencySnapshot(stacks);
    return { stacks, snapshot };
  } catch (error) {
    console.error('[Networking] Snapshot failed on node %d:', nodeId, sanitizeForLog(getErrorMessage(error, 'unknown')));
    return { stacks, snapshot: null };
  }
}
