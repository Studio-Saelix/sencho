/**
 * Authoritative-negative update-preview reconcile: commitPreviewClear generation
 * safety and route side effects (broadcast / fleet cache invalidate).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let ImageUpdateService: typeof import('../services/ImageUpdateService').ImageUpdateService;
let UpdatePreviewService: typeof import('../services/UpdatePreviewService').UpdatePreviewService;
let NotificationService: typeof import('../services/NotificationService').NotificationService;
let CacheService: typeof import('../services/CacheService').CacheService;
let adminCookie: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ ImageUpdateService } = await import('../services/ImageUpdateService'));
  ({ UpdatePreviewService } = await import('../services/UpdatePreviewService'));
  ({ NotificationService } = await import('../services/NotificationService'));
  ({ CacheService } = await import('../services/CacheService'));
  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  vi.restoreAllMocks();
  const raw = (DatabaseService.getInstance() as unknown as { db: { prepare: (s: string) => { run: () => void } } }).db;
  raw.prepare('DELETE FROM stack_update_status').run();
});

function negativeOkPreview(stackName = 'web') {
  return {
    stack_name: stackName,
    images: [{
      service: 'web',
      image: 'nginx:1.2.3',
      current_tag: '1.2.3',
      next_tag: null,
      has_update: false,
      semver_bump: 'none' as const,
      check_status: 'ok' as const,
    }],
    build_services: [] as string[],
    summary: {
      has_update: false,
      primary_image: 'nginx:1.2.3',
      current_tag: '1.2.3',
      next_tag: null,
      semver_bump: 'none' as const,
      update_kind: 'none' as const,
      blocked: false,
      blocked_reason: null,
      has_build_services: false,
      rebuild_available: false,
      check_status: 'ok' as const,
    },
    rollback_target: null,
    changelog: null,
  };
}

describe('ImageUpdateService.commitPreviewClear', () => {
  it('clears aggregate and services_json and returns cleared', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;
    db.upsertStackUpdateStatus(nodeId, 'web', true, 1000, 'partial', 'half', [
      { service: 'web', image: 'web:1', hasUpdate: true, checkStatus: 'ok', lastError: null },
    ]);
    const result = await ImageUpdateService.getInstance().commitPreviewClear(nodeId, 'web');
    expect(result).toBe('cleared');
    expect(db.getStackUpdateDetail(nodeId).web).toBeUndefined();
  });

  it('returns absent when no row exists', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;
    expect(await ImageUpdateService.getInstance().commitPreviewClear(nodeId, 'missing')).toBe('absent');
  });
});

describe('GET /api/stacks/:stackName/update-preview reconcile', () => {
  it('clears sticky state and broadcasts on authoritative-negative preview', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;
    db.upsertStackUpdateStatus(nodeId, 'web', true, 1000, 'partial', 'half');

    vi.spyOn(UpdatePreviewService.getInstance(), 'getPreview').mockResolvedValue(negativeOkPreview('web'));
    const broadcast = vi.spyOn(NotificationService.getInstance(), 'broadcastEvent').mockImplementation(() => undefined);
    const invalidate = vi.spyOn(CacheService.getInstance(), 'invalidate').mockImplementation(() => undefined);

    const res = await request(app)
      .get('/api/stacks/web/update-preview')
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(db.getStackUpdateDetail(nodeId).web).toBeUndefined();
    expect(invalidate).toHaveBeenCalledWith('fleet-updates');
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'state-invalidate',
      scope: 'image-updates',
      action: 'update-status-reconciled',
      stackName: 'web',
    }));
  });

  it('does not mutate on partial negative preview', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;
    db.upsertStackUpdateStatus(nodeId, 'web', true, 1000, 'partial', 'half');

    vi.spyOn(UpdatePreviewService.getInstance(), 'getPreview').mockResolvedValue({
      ...negativeOkPreview('web'),
      summary: { ...negativeOkPreview('web').summary, check_status: 'partial' },
    });

    const res = await request(app)
      .get('/api/stacks/web/update-preview')
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(db.getStackUpdateDetail(nodeId).web?.hasUpdate).toBe(true);
  });

  it('does not mutate when check_status is missing', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;
    db.upsertStackUpdateStatus(nodeId, 'web', true, 1000, 'partial', 'half');

    const preview = negativeOkPreview('web');
    const { check_status: _omit, ...summaryWithout } = preview.summary;
    vi.spyOn(UpdatePreviewService.getInstance(), 'getPreview').mockResolvedValue({
      ...preview,
      summary: summaryWithout as typeof preview.summary,
    });

    const res = await request(app)
      .get('/api/stacks/web/update-preview')
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(db.getStackUpdateDetail(nodeId).web?.hasUpdate).toBe(true);
  });

  it('does not broadcast when clear finds no row', async () => {
    vi.spyOn(UpdatePreviewService.getInstance(), 'getPreview').mockResolvedValue(negativeOkPreview('ghost'));
    const broadcast = vi.spyOn(NotificationService.getInstance(), 'broadcastEvent').mockImplementation(() => undefined);
    const invalidate = vi.spyOn(CacheService.getInstance(), 'invalidate').mockImplementation(() => undefined);

    const res = await request(app)
      .get('/api/stacks/ghost/update-preview')
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(broadcast).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('generation ordering for preview clear', () => {
  it('a newer scanner reservation supersedes an in-flight clear', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;
    db.upsertStackUpdateStatus(nodeId, 'ord', true, 1000, 'partial', 'half');
    const svc = ImageUpdateService.getInstance() as unknown as {
      reserveStackWriteGeneration: (n: number, s: string) => number;
      withStackWriteLock: (
        n: number,
        s: string,
        g: number,
        write: () => void | Promise<void>,
      ) => Promise<boolean>;
    };

    // Start clear: reserve clear gen, but delay the lock body.
    const clearGen = svc.reserveStackWriteGeneration(nodeId, 'ord');
    // Scanner reserves after clear → higher gen.
    const scannerGen = svc.reserveStackWriteGeneration(nodeId, 'ord');
    expect(scannerGen).toBeGreaterThan(clearGen);

    const clearCommitted = await svc.withStackWriteLock(nodeId, 'ord', clearGen, () => {
      db.clearStackUpdateStatus(nodeId, 'ord');
    });
    expect(clearCommitted).toBe(false); // stale relative to scannerGen

    const scannerCommitted = await svc.withStackWriteLock(nodeId, 'ord', scannerGen, () => {
      db.upsertStackUpdateStatus(nodeId, 'ord', true, Date.now(), 'ok', null);
    });
    expect(scannerCommitted).toBe(true);
    expect(db.getStackUpdateDetail(nodeId).ord?.hasUpdate).toBe(true);
    expect(db.getStackUpdateDetail(nodeId).ord?.checkStatus).toBe('ok');
  });

  it('a clear reserved after an older scanner reservation supersedes it', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;
    db.upsertStackUpdateStatus(nodeId, 'ord2', true, 1000, 'partial', 'half');
    const svc = ImageUpdateService.getInstance() as unknown as {
      reserveStackWriteGeneration: (n: number, s: string) => number;
      withStackWriteLock: (
        n: number,
        s: string,
        g: number,
        write: () => void | Promise<void>,
      ) => Promise<boolean>;
    };

    const scannerGen = svc.reserveStackWriteGeneration(nodeId, 'ord2');
    const clearGen = svc.reserveStackWriteGeneration(nodeId, 'ord2');
    expect(clearGen).toBeGreaterThan(scannerGen);

    const scannerCommitted = await svc.withStackWriteLock(nodeId, 'ord2', scannerGen, () => {
      db.upsertStackUpdateStatus(nodeId, 'ord2', true, Date.now(), 'ok', null);
    });
    expect(scannerCommitted).toBe(false);

    const clearCommitted = await svc.withStackWriteLock(nodeId, 'ord2', clearGen, () => {
      db.clearStackUpdateStatus(nodeId, 'ord2');
    });
    expect(clearCommitted).toBe(true);
    expect(db.getStackUpdateDetail(nodeId).ord2).toBeUndefined();
  });
});
