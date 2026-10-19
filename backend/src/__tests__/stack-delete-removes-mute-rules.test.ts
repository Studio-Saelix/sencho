/**
 * DELETE /api/stacks/:stackName must remove the mute rules that target only
 * that stack on that node (what the per-stack "Mute" actions create). Rules that
 * also cover other stacks or nodes stay, and a permanent tombstone is written so
 * remote replicas are retracted.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { format } from 'node:util';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let ComposeService: typeof import('../services/ComposeService').ComposeService;
let FileSystemService: typeof import('../services/FileSystemService').FileSystemService;
let MeshService: typeof import('../services/MeshService').MeshService;
let adminCookie: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ ComposeService } = await import('../services/ComposeService'));
  ({ FileSystemService } = await import('../services/FileSystemService'));
  ({ MeshService } = await import('../services/MeshService'));
  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(ComposeService.prototype, 'downStack').mockResolvedValue(undefined);
  vi.spyOn(FileSystemService.prototype, 'deleteStack').mockResolvedValue(undefined);
  vi.spyOn(MeshService.getInstance(), 'optOutStack').mockResolvedValue(undefined);
  DatabaseService.getInstance().getDb().prepare('DELETE FROM notification_suppression_rules').run();
});

function seedRule(
  name: string,
  nodeId: number | null,
  stackPatterns: string[],
  overrides: { categories?: string[] | null; enabled?: boolean } = {},
) {
  const now = Date.now();
  return DatabaseService.getInstance().createNotificationSuppressionRule({
    name,
    node_id: nodeId,
    stack_patterns: stackPatterns,
    label_ids: null,
    categories: overrides.categories ?? null,
    levels: null,
    applies_to: 'both',
    enabled: overrides.enabled ?? true,
    expires_at: null,
    schedule: null,
    created_at: now,
    updated_at: now,
  });
}

function ruleNames(): string[] {
  return DatabaseService.getInstance().getNotificationSuppressionRules().map((r) => r.name).sort();
}

describe('DELETE /api/stacks/:stackName removes its mute rules', () => {
  it('removes single-stack rules on this node, including category-scoped ones, and writes a tombstone', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getNodes()[0].id;
    const muteAll = seedRule('Mute web', nodeId, ['web']);
    seedRule('Mute web monitor alerts', nodeId, ['web'], { categories: ['monitor_alert'] });
    seedRule('Mute web (paused)', nodeId, ['web'], { enabled: false });
    seedRule('Mute db', nodeId, ['db']);

    const res = await request(app).delete('/api/stacks/web').set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(ruleNames()).toEqual(['Mute db']);
    expect(db.getNotificationSuppressionRuleTombstone(muteAll.id)?.kind).toBe('permanent');
  });

  it('matches stack names case-sensitively', async () => {
    const nodeId = DatabaseService.getInstance().getNodes()[0].id;
    seedRule('Mute Web', nodeId, ['Web']);

    const res = await request(app).delete('/api/stacks/web').set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(ruleNames()).toEqual(['Mute Web']);
  });

  it('keeps rules that also cover other stacks or nodes', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getNodes()[0].id;
    seedRule('Wildcard', nodeId, ['we*']);
    seedRule('Several stacks', nodeId, ['web', 'db']);
    seedRule('All nodes', null, ['web']);
    seedRule('Other node', nodeId + 1000, ['web']);
    seedRule('Whole node', nodeId, ['*']);

    const res = await request(app).delete('/api/stacks/web').set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(ruleNames()).toEqual(['All nodes', 'Other node', 'Several stacks', 'Whole node', 'Wildcard']);
  });

  it('still completes the delete (and mesh opt-out) when mute rule cleanup fails', async () => {
    const db = DatabaseService.getInstance();
    const optOut = vi.spyOn(MeshService.getInstance(), 'optOutStack').mockResolvedValue(undefined);
    vi.spyOn(db, 'getNotificationSuppressionRules').mockImplementation(() => { throw new Error('corrupt rule row'); });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await request(app).delete('/api/stacks/web').set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(optOut).toHaveBeenCalled();
    expect(logged.mock.calls.some((args) => String(args[0]).includes('Failed to look up mute rules'))).toBe(true);
  });

  it('keeps removing the other rules when one rule fails to delete, and names the failed rule', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getNodes()[0].id;
    const first = seedRule('Mute web', nodeId, ['web']);
    const second = seedRule('Mute web monitor alerts', nodeId, ['web'], { categories: ['monitor_alert'] });
    const realDelete = db.deleteNotificationSuppressionRule.bind(db);
    vi.spyOn(db, 'deleteNotificationSuppressionRule').mockImplementation((id, retraction) => {
      if (id === first.id) throw new Error('database is locked');
      return realDelete(id, retraction);
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await request(app).delete('/api/stacks/web').set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(ruleNames()).toEqual(['Mute web']);
    expect(db.getNotificationSuppressionRule(second.id)).toBeUndefined();
    expect(logged.mock.calls.some((args) => format(String(args[0]), ...args.slice(1)).includes(`mute rule ${first.id}`))).toBe(true);
  });

  it('leaves the rule in place when removing the stack files fails', async () => {
    const nodeId = DatabaseService.getInstance().getNodes()[0].id;
    seedRule('Mute web', nodeId, ['web']);
    vi.spyOn(FileSystemService.prototype, 'deleteStack').mockRejectedValue(new Error('disk error'));

    const res = await request(app).delete('/api/stacks/web').set('Cookie', adminCookie);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(ruleNames()).toEqual(['Mute web']);
  });
});
