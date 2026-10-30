/**
 * A cheap per-node networking summary for the Fleet view filter: which stacks
 * are exposed beyond loopback (published ports, host networking, or a tunnel
 * connector), which are exposed without an exposure intent,
 * and which have network drift. It reads each stack's compose with the light
 * dependency parser (no `docker compose config` render) and one Docker snapshot,
 * so it stays inexpensive across a node's full stack set.
 */
import DockerController, { type DependencySnapshot } from '../DockerController';
import { FileSystemService } from '../FileSystemService';
import { DatabaseService } from '../DatabaseService';
import { parseComposeDependencies, type DeclaredCompose } from '../../helpers/composeDependencyParse';
import { detectTunnels, tunnelExposureByService } from './tunnelDetection';
import { assembleStackDrift } from '../DriftDetectionService';
import { resolveManagedMeshAttachment } from './managedMeshAttachment';
import { isHostNetwork, isLoopback } from './normalize';
import { getErrorMessage } from '../../utils/errors';
import { composeInterpolation } from '../../utils/authoredComposeArgs';
import { ComposeEnvFileError } from '../../utils/composeDotenv';
import { sanitizeForLog } from '../../utils/safeLog';
import { isDebugEnabled } from '../../utils/debug';

/** One signal bucket: how many stacks match, and which. */
export interface NetworkingSummaryBucket {
  count: number;
  stacks: string[];
}

export interface NodeNetworkingSummary {
  /** Stacks that publish a host port on a non-loopback interface, use host networking, or are reached through a tunnel. */
  exposed: NetworkingSummaryBucket;
  /** Stacks with an exposed service (published port, host networking, or tunnel) that has no effective exposure intent. */
  unknownExposure: NetworkingSummaryBucket;
  /** Stacks whose running networking disagrees with the Compose file. */
  networkDrift: NetworkingSummaryBucket;
}

const bucket = (stacks: string[]): NetworkingSummaryBucket => ({ count: stacks.length, stacks });

/** Services a tunnel connector reaches, from the light parse (raw YAML; `TS_EXTRA_ARGS` may be interpolated, see `withTailscaleArgsInterpolated`). */
function tunneledServices(declared: DeclaredCompose): Set<string> {
  const connectors = detectTunnels({
    services: declared.services.map(s => ({
      name: s.name,
      image: s.image,
      envKeys: s.envKeys ?? [],
      networkMode: s.networkMode,
      networks: s.networks.map(key => ({ key })),
      ports: s.ports,
      commandHints: s.commandHints,
      tailscaleFlags: s.tailscaleFlags,
    })),
    networks: Object.fromEntries(Object.entries(declared.networks).map(([key, r]) => [key, { name: r.name ?? key, external: r.external }])),
  });
  return new Set(tunnelExposureByService(connectors).keys());
}

/**
 * Re-parse with the stack's interpolation variables when a Tailscale
 * `TS_EXTRA_ARGS` is `unresolved` in the raw YAML (a `${VAR}`, or a key with no
 * value), so these counters read the flags Compose Doctor and the stack views
 * read from the rendered model. The value stays unresolved, and counts as
 * forwarding, when no lookup describes the run (see `ComposeInterpolation`),
 * Compose would refuse the template, or the deploy spec cannot be read.
 */
async function withTailscaleArgsInterpolated(nodeId: number, stack: string, content: string, declared: DeclaredCompose): Promise<DeclaredCompose> {
  if (!declared.services.some(s => s.tailscaleFlags?.includes('unresolved'))) return declared;
  try {
    const interpolation = await composeInterpolation(stack, nodeId);
    if (interpolation.kind === 'lookup') {
      const interpolated = parseComposeDependencies(content, { lookup: interpolation.lookup });
      return interpolated.parseError ? declared : interpolated;
    }
    if (interpolation.reason === 'unreadable') {
      console.warn('[NetworkingSummary] Stack %s env files cannot be read the way Compose reads them; TS_EXTRA_ARGS left unresolved.',
        sanitizeForLog(stack));
    } else if (isDebugEnabled()) {
      // Ordinary configurations this reader does not model, so not a warning.
      console.log('[NetworkingSummary:diag] Stack %s TS_EXTRA_ARGS left unresolved: %s.', sanitizeForLog(stack), interpolation.reason);
    }
    return declared;
  } catch (error) {
    // An invalid or unreadable deploy spec, or a defect. Unreadable env files
    // and a template Compose refuses come back as values instead. An env-file
    // error message can hold an interpolated value, so it is never logged.
    const detail = error instanceof ComposeEnvFileError
      ? 'ComposeEnvFileError'
      : error instanceof Error ? `${error.name}: ${error.message}` : 'unknown';
    console.warn('[NetworkingSummary] Stack %s interpolation failed; TS_EXTRA_ARGS left unresolved:',
      sanitizeForLog(stack), sanitizeForLog(detail));
    return declared;
  }
}

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
    } catch (error) {
      // Unreadable compose (missing, a dangling link or one outside its stack dir, or an I/O error).
      console.warn('[NetworkingSummary] Skipped stack %s, compose file unreadable:',
        sanitizeForLog(stack), sanitizeForLog(getErrorMessage(error, 'unknown')));
      continue;
    }
    let declared = parseComposeDependencies(content);
    if (declared.parseError) {
      console.warn('[NetworkingSummary] Skipped stack %s, compose file does not parse.', sanitizeForLog(stack));
      continue;
    }
    declared = await withTailscaleArgsInterpolated(nodeId, stack, content, declared);

    // A host-network service publishes every container port directly on the host,
    // so it counts as exposed (beyond loopback) and as publishing even with no
    // declared `ports:`. This keeps the summary honest about host networking,
    // matching the Compose Doctor's host-network finding.
    // A service a tunnel connector reaches is exposed without a published port.
    const tunneled = tunneledServices(declared);
    const publishes = (s: typeof declared.services[number]): boolean =>
      s.ports.length > 0 || isHostNetwork(s.networkMode) || tunneled.has(s.name);
    const publishesPort = declared.services.some(publishes);
    if (declared.services.some(s => isHostNetwork(s.networkMode) || tunneled.has(s.name) || s.ports.some(p => !isLoopback(p.hostIp)))) exposed.push(stack);

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
      const managedNetworkAttachment = await resolveManagedMeshAttachment(nodeId, stack);
      const report = assembleStackDrift({
        stack,
        declared,
        containers,
        networks: snapshot.networks,
        managedNetworkAttachment,
      });
      if (report.findings.some(f => f.kind === 'network-undeclared' || f.kind === 'network-missing')) networkDrift.push(stack);
    }
  }

  return { exposed: bucket(exposed), unknownExposure: bucket(unknownExposure), networkDrift: bucket(networkDrift) };
}
