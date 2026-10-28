import DockerController from '../DockerController';
import { ComposeService } from '../ComposeService';
import { DatabaseService, type Node } from '../DatabaseService';
import { declaredFromEffectiveModel } from '../../helpers/effectiveToDeclaredCompose';
import { parseEffectiveModel } from '../preflight/effectiveModel';
import { readNodeProxyJson } from '../../helpers/nodeProxyJson';
import { probeRemoteCapability } from '../../helpers/remoteCapabilities';
import { HEALTH_GATE_OBSERVATION_CAPABILITY } from '../CapabilityRegistry';
import { isRecord } from '../gitops/json';
import { getErrorMessage } from '../../utils/errors';
import { withTimeout } from '../../utils/withTimeout';
import { sanitizeForLog } from '../../utils/safeLog';

/**
 * One container's runtime facts, as the health gate accounts for them.
 *
 * This is the gate's own evidence shape rather than Docker's: the names and the
 * nullability are what the accounting reads, and a remote node answers in this
 * shape so the same comparison runs against a leaf's containers and a local
 * node's.
 */
export interface StackContainerFact {
  id: string;
  name: string;
  /** `com.docker.compose.service`, when the container carries it. */
  service: string | null;
  state: string;
  health: string | null;
  /** Docker's raw RestartCount. */
  restartCount: number;
  startedAt: string | null;
  imageId: string;
  exitCode: number | null;
  /** HostConfig.RestartPolicy.Name (report only; one-shot intent comes from the declared model). */
  restartPolicy: string | null;
}

/**
 * What a stack's runtime looks like right now.
 *
 * The health gate runs on the instance that owns the rollout, which for a
 * remote target is not the instance that owns the containers. The facts come
 * from whichever node can actually see them: the local Docker socket for a
 * local node, and the node's own observation route over the proxy for a remote
 * one. A hub-local read of a remote node's Docker is not a fallback that
 * degrades, it is the wrong daemon, so it is never attempted.
 */
export type StackHealthFactsOutcome =
  | { kind: 'ok'; containers: StackContainerFact[] }
  /**
   * The node answered that it does not serve observations, or it does not
   * advertise the capability. A definite answer: asking again changes nothing,
   * so the caller ends its observation rather than retrying.
   */
  | { kind: 'unsupported' }
  /** A read that could have worked and did not, so a later poll may succeed. */
  | { kind: 'unavailable'; cause: 'docker' | 'node'; detail: string };

/** Bounded well under the gate's own per-poll ceiling, so a slow leaf is classified there. */
const REMOTE_OBSERVATION_TIMEOUT_MS = 5_000;
/**
 * The whole remote read, including the capability probe a failure triggers. It
 * has to settle inside the caller's per-poll ceiling, or the caller would
 * report a timeout as a local read that never answered.
 */
const REMOTE_OBSERVATION_BUDGET_MS = 7_000;
/**
 * The declared-intent read renders the stack, so it is allowed longer than a
 * container list. It happens once per gate, and the gate measures its window
 * from arming, so a slow render costs samples rather than producing a verdict
 * from a shortened window.
 */
const REMOTE_DECLARED_INTENT_TIMEOUT_MS = 10_000;

/** Read the running containers of a stack on the node that hosts it. Never throws. */
export async function readStackHealthFacts(args: {
  nodeId: number;
  stackName: string;
}): Promise<StackHealthFactsOutcome> {
  let node: Node | undefined;
  try {
    node = DatabaseService.getInstance().getNode(args.nodeId);
  } catch (error) {
    // This read feeds a poll timer, so an unreadable node row has to be an
    // outcome rather than a rejection: the gate counts it against its error
    // budget and ends unknown, and nothing escapes to the timer.
    return { kind: 'unavailable', cause: 'node', detail: getErrorMessage(error, 'unknown') };
  }
  if (!node) {
    // Neither kind of read is right for a node this instance does not have, and
    // a missing row must never fall through to the local socket: that would
    // report this instance's containers as the target's.
    return { kind: 'unavailable', cause: 'node', detail: `node ${args.nodeId} is not known to this instance` };
  }
  if (node.type === 'remote') {
    return readRemoteStackHealthFacts(args.nodeId, args.stackName);
  }
  try {
    return { kind: 'ok', containers: await listLocalStackContainers(args.nodeId, args.stackName) };
  } catch (error) {
    return { kind: 'unavailable', cause: 'docker', detail: getErrorMessage(error, 'unknown') };
  }
}

/**
 * The declared Compose restart intent per service, which is what tells a
 * completed one-shot apart from a container that died.
 *
 * Null when the stack is not renderable or the node cannot answer. The caller
 * keeps that null rather than substituting an empty map, because the two mean
 * opposite things: a loaded map says an exit with no `restart: "no"` intent is
 * a failure, while null says a clean exit cannot be told from a completed
 * one-shot, so the observation ends unknown instead of failing on evidence it
 * never read. Every definite failure still fails. Rendering a remote stack is
 * the leaf's job for the same reason the container read is.
 */
export async function readStackDeclaredRestartIntent(args: {
  nodeId: number;
  stackName: string;
}): Promise<Map<string, string | null> | null> {
  let node: Node | undefined;
  try {
    node = DatabaseService.getInstance().getNode(args.nodeId);
  } catch (error) {
    console.warn(
      '[StackHealthFacts] Declared restart intent unavailable: node %s could not be read (%s)',
      args.nodeId,
      getErrorMessage(error, 'unknown'),
    );
    return null;
  }
  if (!node) return null;
  if (node.type === 'remote') {
    const read = await readNodeProxyJson({
      nodeId: args.nodeId,
      path: `/api/stacks/${encodeURIComponent(args.stackName)}/health-observation?declaredRestart=1`,
      timeoutMs: REMOTE_DECLARED_INTENT_TIMEOUT_MS,
      logLabel: `remote declared restart intent for ${sanitizeForLog(args.stackName)}`,
    });
    if (read.kind !== 'ok' || !isRecord(read.data)) return null;
    return decodeDeclaredRestart(read.data.declaredRestartByService);
  }
  try {
    const result = await ComposeService.getInstance(args.nodeId).renderConfig(args.stackName);
    if (result.rendered === null) {
      console.warn(
        '[StackHealthFacts] Declared restart intent unavailable for %s on node %s (compose render failed)',
        sanitizeForLog(args.stackName),
        args.nodeId,
      );
      return null;
    }
    const model = parseEffectiveModel(JSON.parse(result.rendered), args.stackName);
    return new Map(declaredFromEffectiveModel(model).services.map((s) => [s.name, s.restart ?? null]));
  } catch (error) {
    console.warn(
      '[StackHealthFacts] Declared restart intent unavailable for %s on node %s: %s',
      sanitizeForLog(args.stackName),
      args.nodeId,
      getErrorMessage(error, 'unknown'),
    );
    return null;
  }
}

async function readRemoteStackHealthFacts(
  nodeId: number,
  stackName: string,
): Promise<StackHealthFactsOutcome> {
  try {
    return await withTimeout(
      readRemoteStackHealthFactsWithin(nodeId, stackName),
      REMOTE_OBSERVATION_BUDGET_MS,
      'remote health observation',
    );
  } catch (error) {
    return { kind: 'unavailable', cause: 'node', detail: getErrorMessage(error, 'unknown') };
  }
}

async function readRemoteStackHealthFactsWithin(
  nodeId: number,
  stackName: string,
): Promise<StackHealthFactsOutcome> {
  const read = await readNodeProxyJson({
    nodeId,
    path: `/api/stacks/${encodeURIComponent(stackName)}/health-observation`,
    timeoutMs: REMOTE_OBSERVATION_TIMEOUT_MS,
    logLabel: `remote health observation for ${sanitizeForLog(stackName)}`,
  });
  if (read.kind === 'ok') {
    const containers = isRecord(read.data) ? decodeContainerFacts(read.data.containers) : null;
    if (containers) return { kind: 'ok', containers };
    console.warn(
      '[StackHealthFacts] Remote health observation invalid shape for %s on node %s',
      sanitizeForLog(stackName),
      nodeId,
    );
    return { kind: 'unavailable', cause: 'node', detail: 'invalid observation payload' };
  }
  // Only an answer about the route itself separates "this node cannot be asked"
  // from "this node did not answer". Asking the capability probe, rather than
  // reading a bare 404, keeps a missing stack or a transient 404 on a capable
  // node in the retry class where it belongs.
  const probe = await probeRemoteCapability(nodeId, HEALTH_GATE_OBSERVATION_CAPABILITY);
  if (probe.kind === 'unsupported') return { kind: 'unsupported' };
  return { kind: 'unavailable', cause: 'node', detail: describeReadFailure(read) };
}

function describeReadFailure(read: Exclude<Awaited<ReturnType<typeof readNodeProxyJson>>, { kind: 'ok' }>): string {
  switch (read.kind) {
    case 'route_missing':
      return 'HTTP 404';
    case 'http':
      return `HTTP ${read.status}`;
    case 'no_target':
      return 'no proxy target';
    case 'transport':
      return read.detail;
  }
}

/** List and inspect a local stack's containers into the gate's evidence shape. */
async function listLocalStackContainers(nodeId: number, stackName: string): Promise<StackContainerFact[]> {
  const docker = DockerController.getInstance(nodeId).getDocker();
  const listed = await docker.listContainers({
    all: true,
    filters: { label: [`com.docker.compose.project=${stackName}`] },
  });
  const observed = await Promise.all(
    listed.map(async (info): Promise<StackContainerFact | null> => {
      try {
        const inspect = await docker.getContainer(info.Id).inspect();
        const labels = (info.Labels ?? inspect.Config?.Labels ?? {}) as Record<string, string>;
        return {
          id: info.Id,
          name: info.Names?.[0]?.replace(/^\//, '') ?? info.Id.slice(0, 12),
          startedAt: inspect.State?.StartedAt ?? null,
          restartCount: typeof inspect.RestartCount === 'number' ? inspect.RestartCount : 0,
          state: inspect.State?.Status ?? info.State ?? 'unknown',
          health: inspect.State?.Health?.Status ?? null,
          service: labels['com.docker.compose.service'] ?? null,
          imageId: inspect.Image ?? '',
          exitCode: typeof inspect.State?.ExitCode === 'number' ? inspect.State.ExitCode : null,
          restartPolicy: inspect.HostConfig?.RestartPolicy?.Name || null,
        };
      } catch (e: unknown) {
        // Removed between list and inspect; the missing-container logic will
        // see its absence on this or the next poll.
        if ((e as { statusCode?: number })?.statusCode === 404) return null;
        throw e;
      }
    }),
  );
  return observed.filter((c): c is StackContainerFact => c !== null);
}

/**
 * A leaf's container list, or null when any entry is unusable.
 *
 * One unreadable entry rejects the whole payload rather than being dropped: a
 * dropped container reads as a container that vanished, which fails the gate,
 * and an observation that cannot be decoded in full is not evidence about the
 * containers it omitted.
 */
function decodeContainerFacts(value: unknown): StackContainerFact[] | null {
  if (!Array.isArray(value)) return null;
  const facts: StackContainerFact[] = [];
  for (const entry of value) {
    const fact = decodeContainerFact(entry);
    if (!fact) return null;
    facts.push(fact);
  }
  return facts;
}

function decodeContainerFact(value: unknown): StackContainerFact | null {
  if (!isRecord(value)) return null;
  const { id, name, service, state, health, restartCount, startedAt, imageId, exitCode, restartPolicy } = value;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof name !== 'string' || name.length === 0) return null;
  if (typeof state !== 'string' || state.length === 0) return null;
  if (typeof imageId !== 'string') return null;
  if (typeof restartCount !== 'number' || !Number.isFinite(restartCount)) return null;
  if (!isNullableString(service) || !isNullableString(health) || !isNullableString(startedAt)) return null;
  if (!isNullableString(restartPolicy)) return null;
  if (!(exitCode === null || (typeof exitCode === 'number' && Number.isFinite(exitCode)))) return null;
  return { id, name, service, state, health, restartCount, startedAt, imageId, exitCode, restartPolicy };
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function decodeDeclaredRestart(value: unknown): Map<string, string | null> | null {
  if (!isRecord(value)) return null;
  const map = new Map<string, string | null>();
  for (const [service, restart] of Object.entries(value)) {
    if (!isNullableString(restart)) return null;
    map.set(service, restart);
  }
  return map;
}
