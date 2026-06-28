/**
 * A cheap per-node networking summary for the Fleet view filter: which stacks
 * are exposed beyond loopback, which publish ports without an exposure intent,
 * and which have network drift. It reads each stack's compose with the light
 * dependency parser (no `docker compose config` render) and one Docker snapshot,
 * so it stays inexpensive across a node's full stack set.
 */
import DockerController, { type DependencySnapshot } from '../DockerController';
import { FileSystemService } from '../FileSystemService';
import { DatabaseService } from '../DatabaseService';
import { parseComposeDependencies } from '../../helpers/composeDependencyParse';
import { assembleStackDrift } from '../DriftDetectionService';
import { isHostNetwork, isLoopback } from './normalize';
import { getErrorMessage } from '../../utils/errors';
import { sanitizeForLog } from '../../utils/safeLog';

/** One signal bucket: how many stacks match, and which. */
export interface NetworkingSummaryBucket {
  count: number;
  stacks: string[];
}

export interface NodeNetworkingSummary {
  /** Stacks that publish a host port on a non-loopback interface. */
  exposed: NetworkingSummaryBucket;
  /** Stacks that publish ports but have no stack-level exposure intent set. */
  unknownExposure: NetworkingSummaryBucket;
  /** Stacks whose running networking disagrees with the Compose file. */
  networkDrift: NetworkingSummaryBucket;
}

const bucket = (stacks: string[]): NetworkingSummaryBucket => ({ count: stacks.length, stacks });

export async function computeNodeNetworkingSummary(nodeId: number): Promise<NodeNetworkingSummary> {
  const fsSvc = FileSystemService.getInstance(nodeId);
  const db = DatabaseService.getInstance();
  const stacks = await fsSvc.getStacks();

  // One snapshot for the whole node; absent when Docker is unreachable, in which
  // case drift is simply not computed (the declared signals still work).
  let snapshot: DependencySnapshot | null = null;
  try {
    snapshot = await DockerController.getInstance(nodeId).getDependencySnapshot(stacks);
  } catch (error) {
    console.warn('[NetworkingSummary] Snapshot unavailable on node %d; drift skipped:',
      nodeId, sanitizeForLog(getErrorMessage(error, 'unknown')));
  }

  const exposed: string[] = [];
  const unknownExposure: string[] = [];
  const networkDrift: string[] = [];

  for (const stack of stacks) {
    let content: string;
    try {
      content = await fsSvc.getStackContent(stack);
    } catch {
      continue; // unreadable compose: nothing to summarize for this stack
    }
    const declared = parseComposeDependencies(content);
    if (declared.parseError) continue;

    // A host-network service publishes every container port directly on the host,
    // so it counts as exposed (beyond loopback) and as publishing even with no
    // declared `ports:`. This keeps the summary honest about host networking,
    // matching the Compose Doctor's host-network finding.
    const publishes = (s: typeof declared.services[number]): boolean => s.ports.length > 0 || isHostNetwork(s.networkMode);
    const publishesPort = declared.services.some(publishes);
    if (declared.services.some(s => isHostNetwork(s.networkMode) || s.ports.some(p => !isLoopback(p.hostIp)))) exposed.push(stack);

    if (publishesPort) {
      // Unknown only when a publishing service is effectively unclassified: a
      // service-level intent overrides the stack-level row for that service.
      const intents = db.getStackExposureIntents(nodeId, stack);
      const stackIntent = intents.find(i => i.service === '')?.intent ?? null;
      const byService = new Map(intents.filter(i => i.service !== '').map(i => [i.service, i.intent]));
      const anyUnclassified = declared.services
        .filter(publishes)
        .some(s => {
          const intent = byService.get(s.name) ?? stackIntent;
          return intent === null || intent === 'unknown';
        });
      if (anyUnclassified) unknownExposure.push(stack);
    }

    if (snapshot) {
      // declared.parseError is already excluded above, so the drift report is authoritative.
      const containers = snapshot.containers.filter(c => c.stack === stack);
      const report = assembleStackDrift({ stack, declared, containers, networks: snapshot.networks });
      if (report.findings.some(f => f.kind === 'network-undeclared' || f.kind === 'network-missing')) networkDrift.push(stack);
    }
  }

  return { exposed: bucket(exposed), unknownExposure: bucket(unknownExposure), networkDrift: bucket(networkDrift) };
}
