/**
 * DELETE /api/stacks/:stackName must purge notification_history for that
 * (node_id, stack_name) so the bell panel, Activity ticker, Stack Activity,
 * and Networking recent activity no longer show the deleted stack.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let ComposeService: typeof import('../services/ComposeService').ComposeService;
let FileSystemService: typeof import('../services/FileSystemService').FileSystemService;
let MeshService: typeof import('../services/MeshService').MeshService;
let NotificationService: typeof import('../services/NotificationService').NotificationService;
let adminCookie: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ ComposeService } = await import('../services/ComposeService'));
  ({ FileSystemService } = await import('../services/FileSystemService'));
  ({ MeshService } = await import('../services/MeshService'));
  ({ NotificationService } = await import('../services/NotificationService'));
  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(ComposeService.prototype, 'downStack').mockResolvedValue(undefined);
  vi.spyOn(FileSystemService.prototype, 'deleteStack').mockResolvedValue(undefined);
  vi.spyOn(MeshService.getInstance(), 'optOutStack').mockResolvedValue(undefined);
  const raw = DatabaseService.getInstance().getDb();
  raw.prepare('DELETE FROM notification_history').run();
});

function seedNotif(
  nodeId: number,
  opts: { stack_name?: string; message?: string; timestamp?: number },
): void {
  DatabaseService.getInstance().addNotificationHistory(nodeId, {
    level: 'error',
    message: opts.message ?? 'test',
    timestamp: opts.timestamp ?? Date.now(),
    stack_name: opts.stack_name ?? 'web',
    category: 'deploy_failure',
  });
}

function stackNamesForNode(nodeId: number): Array<string | null> {
  const rows = DatabaseService.getInstance()
    .getDb()
    .prepare('SELECT stack_name FROM notification_history WHERE node_id = ? ORDER BY id')
    .all(nodeId) as Array<{ stack_name: string | null }>;
  return rows.map((r) => r.stack_name);
}

describe('DELETE /api/stacks/:stackName purges notifications', () => {
  it('removes only the target node/stack rows and emits one invalidation', async () => {
    const db = DatabaseService.getInstance();
    const nodeA = db.getNodes()[0].id;
    const nodeB = db.addNode({
      name: 'other-node',
      type: 'remote',
      api_url: 'http://other:1852',
      api_token: 't',
      compose_dir: '/tmp',
      is_default: false,
    });

    seedNotif(nodeA, { stack_name: 'web', message: 'a-web' });
    seedNotif(nodeA, { stack_name: 'db', message: 'a-db' });
    // Unattached (null stack_name) via SQL; addNotificationHistory omits null.
    db.getDb()
      .prepare(
        `INSERT INTO notification_history (node_id, level, message, timestamp, is_read, stack_name, category)
         VALUES (?, 'info', 'a-unattached', ?, 0, NULL, 'system')`,
      )
      .run(nodeA, Date.now());
    seedNotif(nodeB, { stack_name: 'web', message: 'b-web' });

    const broadcastSpy = vi.spyOn(NotificationService.getInstance(), 'broadcastEvent');

    const res = await request(app).delete('/api/stacks/web').set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(stackNamesForNode(nodeA).sort((a, b) => String(a).localeCompare(String(b)))).toEqual([
      'db',
      null,
    ]);
    expect(stackNamesForNode(nodeB)).toEqual(['web']);

    const notifInvalidations = broadcastSpy.mock.calls
      .map((c) => c[0])
      .filter(
        (e) =>
          e.type === 'state-invalidate' &&
          e.scope === 'notifications' &&
          e.action === 'stack-deleted',
      );
    expect(notifInvalidations).toHaveLength(1);
    expect(notifInvalidations[0]).toMatchObject({
      type: 'state-invalidate',
      scope: 'notifications',
      action: 'stack-deleted',
      nodeId: nodeA,
      stackName: 'web',
    });
    expect(typeof notifInvalidations[0].ts).toBe('number');
  });

  it('emits no notification invalidation when delete fails before success', async () => {
    vi.spyOn(FileSystemService.prototype, 'deleteStack').mockRejectedValue(new Error('fs boom'));
    const broadcastSpy = vi.spyOn(NotificationService.getInstance(), 'broadcastEvent');
    const db = DatabaseService.getInstance();
    const nodeId = db.getNodes()[0].id;
    seedNotif(nodeId, { stack_name: 'web' });

    const res = await request(app).delete('/api/stacks/web').set('Cookie', adminCookie);

    expect(res.status).toBe(500);
    expect(stackNamesForNode(nodeId)).toEqual(['web']);
    const notifInvalidations = broadcastSpy.mock.calls
      .map((c) => c[0])
      .filter((e) => e.scope === 'notifications' && e.action === 'stack-deleted');
    expect(notifInvalidations).toHaveLength(0);
  });
});
