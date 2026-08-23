/**
 * Shared node networking aggregate: one Docker snapshot per request, effective-model
 * stack facts, findings, enriched inventory, and optional topology.
 */
import DockerController from '../DockerController';
import { FileSystemService } from '../FileSystemService';
import { DatabaseService } from '../DatabaseService';
import { buildStackNetworkFacts } from './composeNetworkInspector';
import { buildNodeNetworkingFindings } from './networkingFindings';
import { applyDoctorNetworkingFindings } from './doctorNetworkingFindings';
import { enrichNetworkRows } from './networkingInventory';
import { buildNetworkingTopology } from './networkingTopology';
import { rankFindings } from './networkingSeverity';
import { isHostNetwork, isLoopback } from './normalize';
import type { ExposureIntent } from './types';
import type { DependencySnapshot } from '../DockerController';
import type { NodeNetworkingAggregate, NodeNetworkingOverview } from './networkingTypes';
import { getErrorMessage } from '../../utils/errors';
import { sanitizeForLog } from '../../utils/safeLog';
import { mapWithConcurrency } from '../../utils/mapWithConcurrency';
import { withComposeRenderSlot } from './composeRenderSemaphore';
import { fetchNodeNetworkingAggregateWithMeta as fetchMemoized, NETWORKING_AGGREGATE_TTL_MS } from './networkingAggregateCache';
import { isDebugEnabled } from '../../utils/debug';

export async function buildNodeNetworkingAggregate(
  nodeId: number,
  options: { includeTopology?: boolean; includeSystem?: boolean },
): Promise<NodeNetworkingAggregate> {
  const startedAt = Date.now();
  const { value: aggregate, outcome } = await fetchMemoized(nodeId, options, () => computeNodeNetworkingAggregate(nodeId, options));
  if (outcome === 'stale') {
    // Stale-on-error fallback: the recompute threw and the memo served the
    // last good aggregate. Mark it so the UI can say so instead of
    // presenting confidently stale data as fresh.
    aggregate.overview.degradedCache = true;
  }
  if (isDebugEnabled()) {
    console.debug('[Networking:debug] Aggregate served', {
      nodeId,
      outcome,
      ms: Date.now() - startedAt,
      stackCount: aggregate.stackFacts.length,
      networkCount: aggregate.overview.networkCount,
      findingCount: aggregate.findings.length,
      renderFailedStacks: aggregate.overview.renderFailedStacks.length,
      ttlMs: NETWORKING_AGGREGATE_TTL_MS,
      variant: options.includeTopology === true ? 'topology' : 'base',
    });
  }
  return aggregate;
}

async function computeNodeNetworkingAggregate(
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

  // Pipeline order matters: live findings, then cached Doctor adaptation
  // and merge, BEFORE inventory enrichment / overview / topology all consume
  // the same unified list, so counts and findingIds never disagree.
  const liveFindings = buildNodeNetworkingFindings(nodeId, snapshot, stackFacts, baseRows);
  const findings = rankFindings(applyDoctorNetworkingFindings(liveFindings, {
    nodeId, stackNames: stacks, stackFacts, snapshot,
  }));
  const networks = snapshot ? enrichNetworkRows(nodeId, baseRows, stackFacts, snapshot, findings) : [];
  const overview = buildOverview(nodeId, stacks, snapshot, stackFacts, findings, networks);

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
  networks: import('./networkingTypes').NetworkingNetworkRow[],
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

    missingExternalCount += facts.missingExternalNetworks.length;
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
    senchoManagedNetworkCount: snapshot ? networks.filter((r) => r.ownership === 'sencho-managed').length : null,
    composeManagedNetworkCount: snapshot ? networks.filter((r) => r.ownership === 'compose-managed').length : null,
    unmanagedNetworkCount: snapshot ? networks.filter((r) => r.ownership === 'unmanaged').length : null,
    externalDependencyNetworkCount: snapshot ? networks.filter((r) => r.isExternalDependency).length : null,
    exposedStackCount,
    unknownExposureStackCount,
    missingExternalCount,
    // Alias/service DNS collisions plus genuine (non-intentional-sharing) name
    // collisions all count toward the overview number.
    networkCollisionCount: findings.filter(f =>
      f.kind === 'network-name-collision' || f.kind === 'alias-collision' || f.kind === 'service-name-collision',
    ).length,
    findingCount: findings.length,
    degradedCache: false,
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
