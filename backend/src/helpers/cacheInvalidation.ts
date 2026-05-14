import { CacheService } from '../services/CacheService';

export const REMOTE_META_NAMESPACE = 'remote-meta';

/**
 * Drop the per-node caches affected by a stack or container mutation so the
 * next dashboard poll shows fresh state instead of stale reads.
 *
 * Also drops the global `project-name-map` since stack writes (create,
 * delete, rename, compose edits) can reshape the on-disk layout used to
 * build it.
 */
export function invalidateNodeCaches(nodeId: number): void {
  const cache = CacheService.getInstance();
  cache.invalidate(`stats:${nodeId}`);
  cache.invalidate(`stack-statuses:${nodeId}`);
  cache.invalidate('project-name-map');
}

/**
 * Drop the cached `/api/meta` response for a remote node. Triggered on pilot
 * tunnel reconnect so the next request rebuilds capabilities and version
 * through the live loopback bridge instead of waiting for the TTL.
 */
export function invalidateRemoteMetaCache(nodeId: number): void {
  CacheService.getInstance().invalidate(`${REMOTE_META_NAMESPACE}:${nodeId}`);
}
