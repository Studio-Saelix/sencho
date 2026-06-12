/**
 * Stack exposure-intent DAO: stack-level ('') and per-service rows, upsert,
 * single-row clear, clear-all, the CHECK constraint, and node-delete cleanup.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';

let tmpDir: string;
let db: DatabaseService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  db = DatabaseService.getInstance();
});

afterAll(() => cleanupTestDb(tmpDir));

describe('stack exposure intent DAO', () => {
  it('stores and reads stack-level and per-service intents', () => {
    db.setStackExposureIntent(1, 'web', '', 'internal', 'admin');
    db.setStackExposureIntent(1, 'web', 'api', 'public', 'admin');
    const rows = db.getStackExposureIntents(1, 'web');
    expect(rows.map(r => [r.service, r.intent])).toEqual([['', 'internal'], ['api', 'public']]);
    expect(rows[0].updated_by).toBe('admin');
  });

  it('upserts an existing row in place', () => {
    db.setStackExposureIntent(1, 'web', '', 'lan', 'admin2');
    const stack = db.getStackExposureIntents(1, 'web').find(r => r.service === '');
    expect(stack?.intent).toBe('lan');
    expect(stack?.updated_by).toBe('admin2');
  });

  it('clears one row and clears all rows for a stack', () => {
    db.deleteStackExposureIntent(1, 'web', 'api');
    expect(db.getStackExposureIntents(1, 'web').map(r => r.service)).toEqual(['']);
    db.deleteStackExposureIntents(1, 'web');
    expect(db.getStackExposureIntents(1, 'web')).toEqual([]);
  });

  it('rejects an out-of-range intent via the CHECK constraint', () => {
    const raw = (db as unknown as { db: import('better-sqlite3').Database }).db;
    expect(() => raw
      .prepare("INSERT INTO stack_exposure_intent (node_id, stack_name, service, intent, updated_at) VALUES (1, 'x', '', 'bogus', 1)")
      .run()).toThrow(/CHECK constraint failed/);
  });

  it('removes intent rows when the owning node is deleted', () => {
    const nodeId = db.addNode({ name: 'expnode', type: 'remote', compose_dir: '/app/compose', is_default: false, api_url: 'http://x', api_token: 't' });
    db.setStackExposureIntent(nodeId, 'svc', '', 'public', null);
    expect(db.getStackExposureIntents(nodeId, 'svc')).toHaveLength(1);
    db.deleteNode(nodeId);
    expect(db.getStackExposureIntents(nodeId, 'svc')).toEqual([]);
  });
});
