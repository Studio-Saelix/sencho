import type { FailureClassification } from './types';

interface ClassifierRule extends FailureClassification {
  pattern: RegExp;
}

const DOCKER_UNREACHABLE: FailureClassification = {
  reason: 'node_unreachable',
  label: 'Docker unreachable',
  suggestion: 'Check that Docker is running and reachable on this node, then retry.',
};

/**
 * Maps the redacted error text a failed deploy/update throws (the accumulated
 * compose stdout/stderr from ComposeService.execute, or a sentinel like
 * CONTAINER_CRASHED) onto an operator-facing cause and next step.
 *
 * First match wins, so ordering is load-bearing:
 * - the CONTAINER_CRASHED and stall sentinels are exact, so they go first;
 * - env_missing precedes compose_render_failed because a render failure caused
 *   by a missing variable should classify as the actionable cause;
 * - healthcheck_failed precedes dependency_unavailable because compose phrases
 *   an unhealthy dependency as "dependency failed to start: ... is unhealthy".
 *
 * The app-store install route has its own message-prettifier (utils/ErrorParser)
 * with a different output shape; installs are out of scope here.
 */
const RULES: ClassifierRule[] = [
  {
    reason: 'container_exited',
    label: 'Container exited after start',
    suggestion: 'Check the container logs for the exit cause; roll back if the previous version was healthy.',
    pattern: /CONTAINER_CRASHED/,
  },
  {
    // The idle-stall backstop terminated the step; the real cause is unknown.
    reason: 'unknown',
    label: 'Operation stalled',
    suggestion: 'The operation stopped producing output and was terminated. Check Docker activity on the node, then retry.',
    pattern: /STACK_STALLED_OUTPUT/,
  },
  {
    ...DOCKER_UNREACHABLE,
    pattern: /cannot connect to the docker daemon|docker daemon is not running|error during connect|docker daemon is unreachable/i,
  },
  {
    reason: 'env_missing',
    label: 'Missing environment variable',
    suggestion: 'Define the missing variable in the stack environment file, then retry.',
    pattern: /required variable\s+\S+ is missing|variable is not set|invalid interpolation format|env file .+ not found|couldn't find env file/i,
  },
  {
    reason: 'image_pull_failed',
    label: 'Image pull failed',
    suggestion: 'Check the image name and tag, registry credentials, and registry rate limits, then retry.',
    pattern: /pull access denied|manifest unknown|manifest for .+ not found|toomanyrequests|failed to resolve reference|no matching manifest|error pulling image|repository does not exist|unauthorized: authentication required/i,
  },
  {
    reason: 'port_conflict',
    label: 'Host port conflict',
    suggestion: 'Free the conflicting host port or change the published port, then retry.',
    pattern: /port is already allocated|bind: address already in use|ports are not available|failed to bind host port/i,
  },
  {
    reason: 'bind_path_missing',
    label: 'Bind mount path missing',
    suggestion: 'Create the missing host path or correct the bind mount source, then retry.',
    pattern: /bind source path does not exist|mounts denied|invalid mount config/i,
  },
  {
    reason: 'permission_denied',
    label: 'Permission denied',
    suggestion: 'Check file and Docker socket permissions for the affected path, then retry.',
    pattern: /permission denied|EACCES|operation not permitted/i,
  },
  {
    reason: 'healthcheck_failed',
    label: 'Healthcheck failed',
    suggestion: 'Check the failing service logs and its healthcheck command; roll back if the previous version was healthy.',
    pattern: /is unhealthy/i,
  },
  {
    reason: 'dependency_unavailable',
    label: 'Dependency unavailable',
    suggestion: 'Start or create the missing dependency (service, external network, or volume) first, then retry.',
    pattern: /dependency failed to start|depends on undefined service|declared as external, but could not be found/i,
  },
  {
    reason: 'compose_render_failed',
    label: 'Compose file invalid',
    suggestion: 'Review the compose file syntax (Compose Doctor can pinpoint the issue), then retry.',
    pattern: /yaml:|mapping values are not allowed|cannot unmarshal|additional propert|undefined volume|undefined network|invalid compose/i,
  },
];

const UNKNOWN_FAILURE: FailureClassification = {
  reason: 'unknown',
  label: 'Unclassified failure',
  suggestion: 'Open the deploy log and copy the troubleshooting details for the full error.',
};

/**
 * Classify a failed deploy/update. Total: always returns a classification,
 * falling back to `unknown`. `opts.dockerUnavailable` short-circuits to
 * node_unreachable for errors the route already identified as a dead daemon
 * (their message shape varies too much for patterns alone).
 *
 * Note: a ComposeRollbackError's message is already the underlying cause's
 * message (its constructor copies it), so callers can pass
 * getErrorMessage(error) for wrapped rollback failures unchanged.
 */
export function classifyFailure(
  message: string,
  opts?: { dockerUnavailable?: boolean },
): FailureClassification {
  if (opts?.dockerUnavailable) {
    return { ...DOCKER_UNREACHABLE };
  }
  for (const rule of RULES) {
    if (rule.pattern.test(message)) {
      return { reason: rule.reason, label: rule.label, suggestion: rule.suggestion };
    }
  }
  return { ...UNKNOWN_FAILURE };
}
