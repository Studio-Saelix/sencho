import { CacheService } from '../services/CacheService';

/** Hub aggregation cache for GET /api/image-updates/fleet. */
export const FLEET_UPDATE_CACHE_KEY = 'fleet-updates';

/**
 * Drop the hub fleet-updates aggregation. Generation-aware via CacheService:
 * an in-flight getOrFetch started before this call cannot commit afterward.
 */
export function invalidateFleetUpdateCache(): void {
  CacheService.getInstance().invalidate(FLEET_UPDATE_CACHE_KEY);
}

/**
 * True when `pathAfterApi` is a full-stack update route
 * (`/stacks/:name/update`), not a service-scoped update/restore.
 * `pathAfterApi` is the Express path after the `/api` mount strip
 * (for example `/stacks/paperless/update`).
 */
export function isFullStackUpdatePath(pathAfterApi: string): boolean {
  const pathname = pathAfterApi.split('?')[0] ?? pathAfterApi;
  return /^\/stacks\/[^/]+\/update\/?$/.test(pathname);
}
