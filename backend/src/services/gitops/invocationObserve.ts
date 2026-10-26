/**
 * Read back what Compose was actually invoked with on a node, and record it
 * against the target.
 *
 * The read is off the container labels Compose sets on every project container
 * (`pkg/compose/loader.go` in the Compose source), not off the argv Sencho
 * built. That is the whole point: an invocation made outside Sencho, on the
 * node, with a different file order or a different project directory, is
 * exactly what the `invocation` drift class has to be able to see, and reading
 * the argv back would only ever confirm what Sencho already believes.
 *
 * Every failure path leaves the target's observation alone. A node that cannot
 * be reached, a project with no containers, an unreadable label set: in each
 * case the column stays null, which the projection reads as "Sencho has not
 * looked". Writing a placeholder instead would manufacture the one value this
 * class must never compare against.
 */
import DockerController from '../DockerController';
import { NodeRegistry } from '../NodeRegistry';
import { sanitizeForLog } from '../../utils/safeLog';
import { canonicalizeObservedInvocation, type ObservedLabels } from './invocationIdentity';
import { GitOpsTransitions, type EventEnvelope } from './transitions';
import type { ObservedInvocationIdentity } from './json';

/**
 * The labels of one container of the project, which is where Compose records
 * how it was invoked.
 *
 * Every container carries the same four labels when they were all created by
 * the same invocation, and taking any one of them would be a reasonable reading
 * of that. They stop agreeing as soon as a recreate leaves some containers
 * behind, which is ordinary `up` behavior rather than an edge case: Compose
 * only recreates the services whose configuration changed.
 *
 * So the containers are reduced to a single answer here rather than sampled.
 * They are sorted, and a disagreement between them returns nothing, so a
 * half-recreated project records no observation instead of recording whichever
 * container the daemon happened to list first. A random pick among disagreeing
 * containers would flap: two applies with nothing changed on the node would
 * alternate between reporting and clearing a drift item.
 */
async function readProjectLabels(
  nodeId: number,
  projectName: string,
): Promise<ObservedLabels | null> {
  const containers = await DockerController.getInstance(nodeId).getDocker().listContainers({
    all: true,
    filters: { label: [`com.docker.compose.project=${projectName}`] },
  }) as Array<{ Id?: string; Labels?: Record<string, string> }>;
  const containersWithLabels = containers
    .filter((container) => container.Labels !== undefined)
    .sort((left, right) => (left.Id ?? '').localeCompare(right.Id ?? ''));
  const first = containersWithLabels[0];
  if (!first?.Labels) return null;
  const rendered = JSON.stringify(first.Labels);
  const unanimous = containersWithLabels.every(
    (container) => JSON.stringify(container.Labels) === rendered,
  );
  if (!unanimous) {
    console.warn(
      '[GitOpsInvocation] Compose project %s on node %d has containers from more than one invocation; recording none',
      sanitizeForLog(projectName),
      nodeId,
    );
    return null;
  }
  return first.Labels;
}

/**
 * What Compose was invoked with for a stack on a node.
 *
 * Resolves null rather than an unavailable marker when nothing can be read,
 * which is the same absence the deriver sees when a node never answered.
 */
export async function observeStackInvocation(args: {
  stackName: string;
  nodeId: number;
  observedAt?: number;
}): Promise<ObservedInvocationIdentity | null> {
  const observedAt = args.observedAt ?? Date.now();
  const stackDir = NodeRegistry.getInstance().getComposeDir(args.nodeId);
  // Compose lowercases the project name it records, and so does the label
  // filter, so the filter is built from the same normalization.
  const projectName = args.stackName.toLowerCase();
  try {
    const labels = await readProjectLabels(args.nodeId, projectName);
    if (!labels) return null;
    const canonical = canonicalizeObservedInvocation(labels, `${stackDir}/${args.stackName}`, observedAt);
    if (canonical.kind === 'unreadable') {
      console.error(
        '[GitOpsInvocation] Compose project labels for %s on node %d are not a readable invocation',
        sanitizeForLog(args.stackName),
        args.nodeId,
      );
      return null;
    }
    return canonical.observation;
  } catch (error) {
    console.error(
      '[GitOpsInvocation] Invocation observation failed for %s on node %d:',
      sanitizeForLog(args.stackName),
      args.nodeId,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

/**
 * Record the invocation a stack is running with, for a Direct application.
 *
 * Fire-and-forget by design at every call site: an observation that failed must
 * not delay or fail the apply that produced it, and the honest outcome of that
 * failure is a target with no observation and a caveat saying so.
 */
export async function recordObservedInvocationForDeploy(args: {
  stackName: string;
  nodeId: number;
  applicationId: string;
  envelope: EventEnvelope;
}): Promise<void> {
  try {
    const observed = await observeStackInvocation({
      stackName: args.stackName,
      nodeId: args.nodeId,
      observedAt: args.envelope.at,
    });
    if (!observed) return;
    GitOpsTransitions.getInstance().recordObservedInvocation({
      applicationId: args.applicationId,
      nodeId: args.nodeId,
      observed,
      envelope: args.envelope,
    });
  } catch (error) {
    console.error(
      '[GitOpsInvocation] Failed to record invocation observation for %s:',
      sanitizeForLog(args.applicationId),
      error instanceof Error ? error.message : String(error),
    );
  }
}
