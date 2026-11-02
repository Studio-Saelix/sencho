/**
 * The emitted cache for `io.sencho.notify.route` keys, kept as a leaf module so
 * mutation helpers can drop a node's keys without importing the resolver (which
 * renders Compose) back into themselves.
 *
 * The resolver owns the TTL, the in-flight dedupe, and the stale-while-error
 * rule; this module only holds the map and the one invalidation entry point.
 */

/** Per-service routing key, or null for a service that declares none. */
export type ServiceRouteKeys = Record<string, string | null>;

export interface RouteKeyCacheEntry {
  expiresAt: number;
  services: ServiceRouteKeys;
}

const entries = new Map<string, RouteKeyCacheEntry>();

export function routeKeyCacheKey(nodeId: number, stackName: string): string {
  return `${nodeId}\u0000${stackName}`;
}

export function readRouteKeyCache(nodeId: number, stackName: string): RouteKeyCacheEntry | undefined {
  return entries.get(routeKeyCacheKey(nodeId, stackName));
}

export function writeRouteKeyCache(nodeId: number, stackName: string, entry: RouteKeyCacheEntry): void {
  entries.set(routeKeyCacheKey(nodeId, stackName), entry);
}

/** Drop every cached key set for a node. Called from `invalidateNodeCaches`. */
export function clearRouteKeyCacheForNode(nodeId: number): void {
  const prefix = `${nodeId}\u0000`;
  for (const key of [...entries.keys()]) {
    if (key.startsWith(prefix)) entries.delete(key);
  }
}
