/**
 * Exposure cache refresh success path via DatabaseService upsert + buildExposedImageMap.
 * ComposeService.refreshExposureCache is best-effort: on failure it returns without
 * upserting, so the prior beyond-loopback descriptor stays in stack_exposure.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { buildExposedImageMap, type StackExposure } from '../services/preflight/exposure';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
});

afterAll(() => cleanupTestDb(tmpDir));

function db() {
  return DatabaseService.getInstance();
}

function reset(): void {
  const raw = (db() as unknown as { db: { prepare: (s: string) => { run: () => void } } }).db;
  raw.prepare('DELETE FROM stack_exposure').run();
}

function parseExposures(nodeId: number): StackExposure[] {
  return db().getStackExposures(nodeId).map((row) => JSON.parse(row.descriptor) as StackExposure);
}

describe('exposure cache refresh (DatabaseService)', () => {
  beforeEach(() => reset());

  it('clears prior beyond-loopback exposure after a successful descriptor replace', () => {
    const now = Date.now();
    db().upsertStackExposure(1, 'web', JSON.stringify({
      stack: 'web',
      computedAt: now,
      services: [{
        service: 'api',
        image: 'web:1',
        publiclyExposed: true,
        reason: 'published-port',
        bindings: ['0.0.0.0:80/tcp'],
      }],
    } satisfies StackExposure), now);

    expect(buildExposedImageMap(parseExposures(1)).get('web:1')).toBe(true);

    // Successful ComposeService.refreshExposureCache upserts the corrected descriptor.
    // Refresh failure retains the prior row (ComposeService best-effort); not asserted here.
    const correctedAt = now + 1;
    db().upsertStackExposure(1, 'web', JSON.stringify({
      stack: 'web',
      computedAt: correctedAt,
      services: [{
        service: 'api',
        image: 'web:1',
        publiclyExposed: false,
        reason: null,
        bindings: ['127.0.0.1:80/tcp'],
      }],
    } satisfies StackExposure), correctedAt);

    expect(buildExposedImageMap(parseExposures(1)).get('web:1')).toBe(false);
  });
});
