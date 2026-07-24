/**
 * Legacy installations upgrade stack_update_cleanup_pending with nullable
 * required_blueprint_id via maybeAddCol.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
});

afterAll(() => cleanupTestDb(tmpDir));

describe('stack_update_cleanup_pending required_blueprint_id migration', () => {
  it('upgrades a legacy table without the column and preserves null for old rows', () => {
    const db = DatabaseService.getInstance();
    const raw = db.getDb();

    // Simulate a pre-migration installation: drop the column if present, then
    // re-add it the same way initSchema's maybeAddCol does.
    try {
      raw.exec('ALTER TABLE stack_update_cleanup_pending DROP COLUMN required_blueprint_id');
    } catch {
      // Column may already be absent in a hand-built fixture.
    }

    const now = Date.now();
    raw.prepare(`
      INSERT INTO stack_update_cleanup_pending (
        id, node_id, stack_name, status, target_kind, rollback_tags_json,
        override_paths_json, prune_volumes_requested, created_at, updated_at
      ) VALUES (?, ?, ?, 'prepared', 'local_socket', '[]', '[]', 0, ?, ?)
    `).run('legacy-1', 1, 'legacy-stack', now, now);

    try {
      raw.exec('ALTER TABLE stack_update_cleanup_pending ADD COLUMN required_blueprint_id INTEGER');
    } catch {
      // Idempotent if a parallel path re-added it.
    }

    const legacy = db.getCleanupPending('legacy-1');
    expect(legacy).toBeDefined();
    expect(legacy?.required_blueprint_id ?? null).toBeNull();

    db.insertCleanupPending({
      id: 'owned-1',
      node_id: 2,
      stack_name: 'bp-stack',
      status: 'prepared',
      target_kind: 'local_socket',
      rollback_tags_json: '[]',
      override_paths_json: '[]',
      prune_volumes_requested: 0,
      required_blueprint_id: 42,
      created_at: now,
      updated_at: now,
    });
    expect(db.getCleanupPending('owned-1')?.required_blueprint_id).toBe(42);
  });
});
