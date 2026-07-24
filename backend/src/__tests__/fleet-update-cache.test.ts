import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CacheService } from '../services/CacheService';
import {
  FLEET_UPDATE_CACHE_KEY,
  invalidateFleetUpdateCache,
  isFullStackUpdatePath,
} from '../helpers/fleetUpdateCache';

describe('isFullStackUpdatePath', () => {
  it('matches full-stack update paths after the /api mount strip', () => {
    expect(isFullStackUpdatePath('/stacks/paperless/update')).toBe(true);
    expect(isFullStackUpdatePath('/stacks/paperless/update?nodeId=2')).toBe(true);
  });

  it('rejects service-scoped update and restore paths', () => {
    expect(isFullStackUpdatePath('/stacks/paperless/services/redis/update')).toBe(false);
    expect(isFullStackUpdatePath('/stacks/paperless/services/redis/restore')).toBe(false);
    expect(isFullStackUpdatePath('/stacks/paperless/deploy')).toBe(false);
  });
});

describe('invalidateFleetUpdateCache', () => {
  beforeEach(() => {
    CacheService.getInstance().flush();
  });

  afterEach(() => {
    CacheService.getInstance().flush();
  });

  it('drops the shared fleet-updates key', async () => {
    const cache = CacheService.getInstance();
    await cache.getOrFetch(FLEET_UPDATE_CACHE_KEY, 60_000, async () => ({ '1': { web: true } }));
    invalidateFleetUpdateCache();
    expect(cache.get(FLEET_UPDATE_CACHE_KEY)).toBeUndefined();
  });
});
