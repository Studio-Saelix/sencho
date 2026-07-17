/**
 * Shared Docker network name predicate. Must stay aligned with
 * DockerController.createNetwork validation.
 */
const DOCKER_NETWORK_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function isValidDockerNetworkName(name: string): boolean {
  return DOCKER_NETWORK_NAME_RE.test(name);
}

export const RESERVED_SYSTEM_NETWORK_NAMES: ReadonlySet<string> = new Set([
  'bridge',
  'host',
  'none',
]);
