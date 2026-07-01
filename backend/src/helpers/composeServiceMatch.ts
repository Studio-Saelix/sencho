/**
 * Match stack containers to a compose service name. `docker compose ps` sets
 * `Service`, but smartFallback containers only had `Names` until Service was
 * backfilled; these matchers also accept the compose service label and a
 * container name equal to the service (common with `container_name:`).
 */
export interface ComposeServiceContainer {
  Id: string;
  Service?: string;
  Names?: string[];
  Labels?: Record<string, string>;
}

export function containerBelongsToComposeService(
  container: ComposeServiceContainer,
  serviceName: string,
): boolean {
  if (container.Service === serviceName) return true;
  if (container.Labels?.['com.docker.compose.service'] === serviceName) return true;
  const containerName = container.Names?.[0]?.replace(/^\//, '');
  return containerName === serviceName;
}

export function filterContainersByComposeService<T extends ComposeServiceContainer>(
  containers: T[],
  serviceName: string,
): T[] {
  return containers.filter(c => containerBelongsToComposeService(c, serviceName));
}
