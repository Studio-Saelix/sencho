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
