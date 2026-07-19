/**
 * Coverage for the tri-state stack_update_status accessors on the real
 * DatabaseService (against a temp DB, so the migrated schema with check_status /
 * last_error is exercised exactly as in production):
 *   - upsertStackUpdateStatus persists hasUpdate + check_status + last_error
 *   - getStackUpdateDetail returns the rich per-stack shape
 *   - getStackUpdateStatus stays the boolean map (fleet contract)
 *   - recordStackCheckFailure preserves a prior has_update while marking failed
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

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

beforeEach(() => {
  const raw = (db() as unknown as { db: { prepare: (s: string) => { run: () => void } } }).db;
  raw.prepare('DELETE FROM stack_update_status').run();
});

const NODE = 1;

describe('stack_update_status tri-state accessors', () => {
  it('persists and reads back check_status + last_error via getStackUpdateDetail', () => {
    db().upsertStackUpdateStatus(NODE, 'web', true, 1000, 'ok', null);
    db().upsertStackUpdateStatus(NODE, 'api', false, 2000, 'partial', 'Registry unreachable for ghcr.io/acme/api:v1');

    const detail = db().getStackUpdateDetail(NODE);
    expect(detail.web).toEqual({ hasUpdate: true, checkStatus: 'ok', lastError: null, checkedAt: 1000 });
    expect(detail.api).toEqual({ hasUpdate: false, checkStatus: 'partial', lastError: 'Registry unreachable for ghcr.io/acme/api:v1', checkedAt: 2000 });
  });

  it('defaults check_status to ok when omitted', () => {
    db().upsertStackUpdateStatus(NODE, 'web', true, 1000);
    expect(db().getStackUpdateDetail(NODE).web.checkStatus).toBe('ok');
  });

  it('keeps getStackUpdateStatus a boolean map for the fleet contract', () => {
    db().upsertStackUpdateStatus(NODE, 'web', true, 1000, 'ok', null);
    db().upsertStackUpdateStatus(NODE, 'api', false, 1000, 'failed', 'boom');
    expect(db().getStackUpdateStatus(NODE)).toEqual({ web: true, api: false });
  });

  it('recordStackCheckFailure preserves a prior has_update while marking failed', () => {
    // A stack with a confirmed update, then a scan where every image errored.
    db().upsertStackUpdateStatus(NODE, 'web', true, 1000, 'ok', null);
    db().recordStackCheckFailure(NODE, 'web', 'Registry unreachable for registry-1.docker.io/library/nginx:latest', 3000);

    const detail = db().getStackUpdateDetail(NODE).web;
    expect(detail.hasUpdate).toBe(true); // not erased by the failed check
    expect(detail.checkStatus).toBe('failed');
    expect(detail.lastError).toContain('Registry unreachable');
    expect(detail.checkedAt).toBe(3000);
  });

  it('recordStackCheckFailure on a first-ever check inserts has_update 0 + failed', () => {
    db().recordStackCheckFailure(NODE, 'fresh', 'auth failed', 4000);
    const detail = db().getStackUpdateDetail(NODE).fresh;
    expect(detail).toEqual({ hasUpdate: false, checkStatus: 'failed', lastError: 'auth failed', checkedAt: 4000 });
  });

  it('scopes detail rows to the node', () => {
    db().upsertStackUpdateStatus(NODE, 'web', true, 1000, 'ok', null);
    db().upsertStackUpdateStatus(2, 'web', false, 1000, 'failed', 'boom');
    expect(Object.keys(db().getStackUpdateDetail(NODE))).toEqual(['web']);
    expect(db().getStackUpdateDetail(NODE).web.hasUpdate).toBe(true);
    expect(db().getStackUpdateDetail(2).web.checkStatus).toBe('failed');
  });
});

describe('stack_update_status services_json (per-service reduction)', () => {
  const SERVICES = [
    { service: 'web', image: 'web:latest', hasUpdate: true, checkStatus: 'ok' as const, lastError: null },
    { service: 'worker', image: 'worker:latest', hasUpdate: false, checkStatus: 'ok' as const, lastError: null },
  ];

  it('persists and returns a per-service breakdown via getStackUpdateDetail', () => {
    db().upsertStackUpdateStatus(NODE, 'stackA', true, 1000, 'ok', null, SERVICES, 3);

    const detail = db().getStackUpdateDetail(NODE).stackA;
    expect(detail.services).toEqual(SERVICES);
  });

  it('omits the services field entirely for a stack with no persisted per-service data', () => {
    db().upsertStackUpdateStatus(NODE, 'stackA', true, 1000, 'ok', null);

    const detail = db().getStackUpdateDetail(NODE).stackA;
    expect(detail.services).toBeUndefined();
    expect('services' in detail).toBe(false);
  });

  it('leaves a prior services_json untouched when a later write omits services (COALESCE)', () => {
    db().upsertStackUpdateStatus(NODE, 'stackA', true, 1000, 'ok', null, SERVICES, 1);
    // A legacy-path caller (or the fallback tally) writes without a services array.
    db().upsertStackUpdateStatus(NODE, 'stackA', true, 2000, 'ok', null);

    expect(db().getStackUpdateDetail(NODE).stackA.services).toEqual(SERVICES);
  });

  it('getStackServicesJson returns [] for a stack with no persisted row', () => {
    expect(db().getStackServicesJson(NODE, 'missing')).toEqual([]);
  });

  it('getStackServicesJson returns [] for a stack row with no services_json', () => {
    db().upsertStackUpdateStatus(NODE, 'stackA', true, 1000, 'ok', null);
    expect(db().getStackServicesJson(NODE, 'stackA')).toEqual([]);
  });

  it('getStackServicesJson round-trips a persisted per-service breakdown', () => {
    db().upsertStackUpdateStatus(NODE, 'stackA', true, 1000, 'ok', null, SERVICES, 5);
    expect(db().getStackServicesJson(NODE, 'stackA')).toEqual(SERVICES);
  });

  it('recordStackCheckFailure persists a per-service breakdown alongside the failure', () => {
    db().recordStackCheckFailure(NODE, 'stackA', 'Registry unreachable', 4000, SERVICES, 2);

    const detail = db().getStackUpdateDetail(NODE).stackA;
    expect(detail.checkStatus).toBe('failed');
    expect(detail.services).toEqual(SERVICES);
  });

  it('treats corrupt services_json as an empty list rather than throwing (empty model invariant)', () => {
    db().upsertStackUpdateStatus(NODE, 'stackA', true, 1000, 'ok', null);
    const raw = (db() as unknown as { db: { prepare: (s: string) => { run: (...args: unknown[]) => void } } }).db;
    raw.prepare('UPDATE stack_update_status SET services_json = ? WHERE node_id = ? AND stack_name = ?')
      .run('{not valid json', NODE, 'stackA');

    expect(db().getStackServicesJson(NODE, 'stackA')).toEqual([]);
    const detail = db().getStackUpdateDetail(NODE).stackA;
    expect(detail.services).toBeUndefined();
    expect(detail.hasUpdate).toBe(true); // aggregate columns are unaffected by corrupt services_json
  });

  it('treats a services_json shape-version mismatch as an empty list', () => {
    db().upsertStackUpdateStatus(NODE, 'stackA', true, 1000, 'ok', null);
    const raw = (db() as unknown as { db: { prepare: (s: string) => { run: (...args: unknown[]) => void } } }).db;
    raw.prepare('UPDATE stack_update_status SET services_json = ? WHERE node_id = ? AND stack_name = ?')
      .run(JSON.stringify({ version: 999, generation: 1, services: SERVICES }), NODE, 'stackA');

    expect(db().getStackServicesJson(NODE, 'stackA')).toEqual([]);
  });

  it('filters out malformed entries within an otherwise valid services_json array', () => {
    db().upsertStackUpdateStatus(NODE, 'stackA', true, 1000, 'ok', null);
    const raw = (db() as unknown as { db: { prepare: (s: string) => { run: (...args: unknown[]) => void } } }).db;
    const malformed = [...SERVICES, { service: 'broken' /* missing required fields */ }];
    raw.prepare('UPDATE stack_update_status SET services_json = ? WHERE node_id = ? AND stack_name = ?')
      .run(JSON.stringify({ version: 1, generation: 1, services: malformed }), NODE, 'stackA');

    expect(db().getStackServicesJson(NODE, 'stackA')).toEqual(SERVICES);
  });
});
