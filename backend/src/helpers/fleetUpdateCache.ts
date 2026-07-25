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

function pathWithoutQuery(pathAfterApi: string): string {
  return pathAfterApi.split('?')[0] ?? pathAfterApi;
}

/**
 * True when `pathAfterApi` is a full-stack update route
 * (`/stacks/:name/update`), not a service-scoped update/restore.
 * `pathAfterApi` is the Express path after the `/api` mount strip
 * (for example `/stacks/paperless/update`).
 */
export function isFullStackUpdatePath(pathAfterApi: string): boolean {
  return /^\/stacks\/[^/]+\/update\/?$/.test(pathWithoutQuery(pathAfterApi));
}

/**
 * True when `pathAfterApi` is the stack update-preview route
 * (`/stacks/:name/update-preview`).
 */
export function isUpdatePreviewPath(pathAfterApi: string): boolean {
  return /^\/stacks\/[^/]+\/update-preview\/?$/.test(pathWithoutQuery(pathAfterApi));
}
