import DockerController from '../services/DockerController';
import { buildLocalGraph, type LocalDependencyGraph } from '../services/DependencyGraphService';
import { computeNodeNetworkingSummary, type NodeNetworkingSummary } from '../services/network/networkingSummary';
import { LocalFleetBuildShare } from './localFleetBuildShare';
import {
  LOCAL_FLEET_READ_BUDGET,
  withinFleetReadBudget,
  withinLocalFleetReadBudget,
  type LocalFleetReadBudget,
} from './fleetReadBudget';

const graphShare = new LocalFleetBuildShare<LocalDependencyGraph>();
const summaryShare = new LocalFleetBuildShare<NodeNetworkingSummary>();

/**
 * The hub's own dependency graph inside the local Fleet budget.
 *
 * The graph build grows with the host and cannot be cancelled, so a Map load
 * cut at the deadline leaves it running; the Map's Retry then joins that build
 * (or takes its unread answer) instead of starting the whole snapshot again.
 * `budget` is a seam for tests.
 */
export function readLocalDependencyGraph(
  nodeId: number,
  nodeName: string,
  budget: LocalFleetReadBudget = LOCAL_FLEET_READ_BUDGET,
): Promise<LocalDependencyGraph> {
  return graphShare.read(
    `${nodeId}:${nodeName}`,
    () => buildLocalGraph(nodeId, nodeName),
    (work) => withinLocalFleetReadBudget(
      'dependency graph',
      () => DockerController.getInstance(nodeId).ping(),
      work,
      budget,
    ),
  );
}

/**
 * The hub's own networking summary under the local deadline, shared the same
 * way. No daemon check gates it: the summary keeps its declared signals when
 * Docker fails, so a down daemon must not turn a partial answer into a node
 * error.
 */
export function readLocalNetworkingSummary(
  nodeId: number,
  budget: Pick<LocalFleetReadBudget, 'deadlineMs'> = LOCAL_FLEET_READ_BUDGET,
): Promise<NodeNetworkingSummary> {
  return summaryShare.read(
    String(nodeId),
    () => computeNodeNetworkingSummary(nodeId),
    (work) => withinFleetReadBudget(work(), 'networking summary', budget.deadlineMs),
  );
}
