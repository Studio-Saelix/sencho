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
      digest_update: false,
      tag_update: false,
      semver_bump: 'none' as const,
      check_status: 'ok' as const,
      check_error: null,
      digest_error: null,
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
      verification_failed: false,
      verification_error: null,
    },
    rollback_target: null,
    changelog: null,
  };
}

describe('ImageUpdateService.commitPreviewClear', () => {
  it('clears sticky partial rows and returns cleared', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;
    db.upsertStackUpdateStatus(nodeId, 'web', true, 1000, 'partial', 'half', [
      { service: 'web', image: 'web:1', hasUpdate: true, checkStatus: 'ok', lastError: null },
    ]);
    const svc = ImageUpdateService.getInstance();
    const observedMem = svc.peekStackWriteGeneration(nodeId, 'web');
    const observedRow = db.getStackUpdateWriteGeneration(nodeId, 'web');
    const result = await svc.commitPreviewClear(nodeId, 'web', observedMem, observedRow);
    expect(result).toBe('cleared');
    expect(db.getStackUpdateDetail(nodeId).web).toBeUndefined();
  });

  it('clears an older confirmed ok+true row', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;
    const svc = ImageUpdateService.getInstance();
    const writeGen = (svc as unknown as {
      reserveStackWriteGeneration: (n: number, s: string) => number;
    }).reserveStackWriteGeneration(nodeId, 'web');
    db.upsertStackUpdateStatus(nodeId, 'web', true, 1000, 'ok', null, [
      { service: 'web', image: 'web:1', hasUpdate: true, checkStatus: 'ok', lastError: null },
    ], writeGen);
    const observedMem = svc.peekStackWriteGeneration(nodeId, 'web');
    const observedRow = db.getStackUpdateWriteGeneration(nodeId, 'web');
    expect(observedRow).toBe(writeGen);
    expect(await svc.commitPreviewClear(nodeId, 'web', observedMem, observedRow)).toBe('cleared');
    expect(db.getStackUpdateDetail(nodeId).web).toBeUndefined();
  });

  it('clears a persisted ok+true row when in-memory generation was reset (restart)', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;
    // Simulate a prior process that wrote generation 7, then a restart that
    // left only SQLite state (in-memory high-water is 0 for this stack key).
    db.upsertStackUpdateStatus(nodeId, 'restart-web', true, 1000, 'ok', null, [
      { service: 'web', image: 'web:1', hasUpdate: true, checkStatus: 'ok', lastError: null },
    ], 7);
    const svc = ImageUpdateService.getInstance();
    expect(svc.peekStackWriteGeneration(nodeId, 'restart-web')).toBe(0);
    expect(db.getStackUpdateWriteGeneration(nodeId, 'restart-web')).toBe(7);
    expect(await svc.commitPreviewClear(nodeId, 'restart-web', 0, 7)).toBe('cleared');
    expect(db.getStackUpdateDetail(nodeId)['restart-web']).toBeUndefined();
  });

  it('keeps an ok+false row', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;
    db.upsertStackUpdateStatus(nodeId, 'web', false, 1000, 'ok', null, [
      { service: 'web', image: 'nginx:1.2.3', hasUpdate: false, checkStatus: 'ok', lastError: null },
    ]);
    const svc = ImageUpdateService.getInstance();
    const observedMem = svc.peekStackWriteGeneration(nodeId, 'web');
    const observedRow = db.getStackUpdateWriteGeneration(nodeId, 'web');
    expect(await svc.commitPreviewClear(nodeId, 'web', observedMem, observedRow)).toBe('absent');
    expect(db.getStackUpdateDetail(nodeId).web).toMatchObject({
      hasUpdate: false,
      checkStatus: 'ok',
      services: [
        expect.objectContaining({
          service: 'web',
          image: 'nginx:1.2.3',
          hasUpdate: false,
          checkStatus: 'ok',
        }),
      ],
    });
  });

  it('clears a failed row even when hasUpdate is false', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;
    db.upsertStackUpdateStatus(nodeId, 'web', false, 1000, 'failed', 'timeout', [
      { service: 'web', image: 'nginx:1.2.3', hasUpdate: false, checkStatus: 'failed', lastError: 'timeout' },
    ]);
    const svc = ImageUpdateService.getInstance();
    const observedMem = svc.peekStackWriteGeneration(nodeId, 'web');
    const observedRow = db.getStackUpdateWriteGeneration(nodeId, 'web');
    expect(await svc.commitPreviewClear(nodeId, 'web', observedMem, observedRow)).toBe('cleared');
    expect(db.getStackUpdateDetail(nodeId).web).toBeUndefined();
  });

  it('returns absent when no row exists', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;
    const svc = ImageUpdateService.getInstance();
    expect(await svc.commitPreviewClear(nodeId, 'missing', 0, 0)).toBe('absent');
  });

  it('retains a row written after the observation watermark', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;
    const svc = ImageUpdateService.getInstance() as unknown as {
      peekStackWriteGeneration: (n: number, s: string) => number;
      reserveStackWriteGeneration: (n: number, s: string) => number;
      commitPreviewClear: (
        n: number,
        s: string,
        observedMem: number,
        observedRow: number,
      ) => Promise<'cleared' | 'stale' | 'absent'>;
      withStackWriteLock: (
        n: number,
        s: string,
        g: number,
        write: () => void | Promise<void>,
      ) => Promise<boolean>;
    };

    const observedMem = svc.peekStackWriteGeneration(nodeId, 'race');
    const observedRow = db.getStackUpdateWriteGeneration(nodeId, 'race');
    const scannerGen = svc.reserveStackWriteGeneration(nodeId, 'race');
    expect(scannerGen).toBeGreaterThan(observedMem);

    await svc.withStackWriteLock(nodeId, 'race', scannerGen, () => {
      db.upsertStackUpdateStatus(nodeId, 'race', true, Date.now(), 'ok', null, [
        { service: 'web', image: 'web:2', hasUpdate: true, checkStatus: 'ok', lastError: null },
      ], scannerGen);
    });

    expect(await svc.commitPreviewClear(nodeId, 'race', observedMem, observedRow)).toBe('stale');
    expect(db.getStackUpdateDetail(nodeId).race?.hasUpdate).toBe(true);
    expect(db.getStackUpdateDetail(nodeId).race?.checkStatus).toBe('ok');
  });

  it('retains a row whose DB generation advanced after observation', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;
    db.upsertStackUpdateStatus(nodeId, 'adv', true, 1000, 'ok', null, [
      { service: 'web', image: 'web:1', hasUpdate: true, checkStatus: 'ok', lastError: null },
    ], 3);
    const svc = ImageUpdateService.getInstance();
    const observedMem = svc.peekStackWriteGeneration(nodeId, 'adv');
    const observedRow = db.getStackUpdateWriteGeneration(nodeId, 'adv');
    expect(observedRow).toBe(3);

    db.upsertStackUpdateStatus(nodeId, 'adv', true, Date.now(), 'ok', null, [
      { service: 'web', image: 'web:2', hasUpdate: true, checkStatus: 'ok', lastError: null },
    ], 4);

    expect(await svc.commitPreviewClear(nodeId, 'adv', observedMem, observedRow)).toBe('absent');
    expect(db.getStackUpdateDetail(nodeId).adv?.hasUpdate).toBe(true);
  });
});

describe('GET/POST /api/stacks/:stackName/update-preview reconcile', () => {
  it('GET returns detection_disabled preview without calling getPreview when checks are off', async () => {
    const db = DatabaseService.getInstance();
    db.updateGlobalSetting('image_update_checks_enabled', '0');
    const getPreview = vi.spyOn(UpdatePreviewService.getInstance(), 'getPreview');

    try {
      const res = await request(app)
        .get('/api/stacks/web/update-preview')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(res.body.summary?.detection_disabled).toBe(true);
      expect(res.body.summary?.has_update).toBe(false);
      expect(res.body.images).toEqual([]);
      expect(getPreview).not.toHaveBeenCalled();
    } finally {
      db.updateGlobalSetting('image_update_checks_enabled', '1');
    }
  });

  it('POST returns detection_disabled without registry I/O or sticky reconcile when checks are off', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;
    db.upsertStackUpdateStatus(nodeId, 'web', true, 1000, 'partial', 'half');
    db.updateGlobalSetting('image_update_checks_enabled', '0');
    const getPreview = vi.spyOn(UpdatePreviewService.getInstance(), 'getPreview');
    const broadcast = vi.spyOn(NotificationService.getInstance(), 'broadcastEvent').mockImplementation(() => undefined);
    const invalidate = vi.spyOn(CacheService.getInstance(), 'invalidate').mockImplementation(() => undefined);

    try {
      const res = await request(app)
        .post('/api/stacks/web/update-preview')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(res.body.summary?.detection_disabled).toBe(true);
      expect(res.body.summary?.has_update).toBe(false);
      expect(res.body.reconciled).toBe(false);
      expect(getPreview).not.toHaveBeenCalled();
      expect(db.getStackUpdateDetail(nodeId).web?.hasUpdate).toBe(true);
      expect(broadcast).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
    } finally {
      db.updateGlobalSetting('image_update_checks_enabled', '1');
    }
  });

  it('GET does not mutate sticky state even for authoritative-negative preview', async () => {
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
    expect(res.body.reconciled).toBeUndefined();
    expect(db.getStackUpdateDetail(nodeId).web?.hasUpdate).toBe(true);
    expect(invalidate).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('POST clears sticky state and broadcasts on authoritative-negative preview', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;
    db.upsertStackUpdateStatus(nodeId, 'web', true, 1000, 'partial', 'half');

    vi.spyOn(UpdatePreviewService.getInstance(), 'getPreview').mockResolvedValue(negativeOkPreview('web'));
    const broadcast = vi.spyOn(NotificationService.getInstance(), 'broadcastEvent').mockImplementation(() => undefined);
    const invalidate = vi.spyOn(CacheService.getInstance(), 'invalidate').mockImplementation(() => undefined);

    const res = await request(app)
      .post('/api/stacks/web/update-preview')
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(res.body.reconciled).toBe(true);
    expect(db.getStackUpdateDetail(nodeId).web).toBeUndefined();
    expect(invalidate).toHaveBeenCalledWith('fleet-updates');
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'state-invalidate',
      scope: 'image-updates',
      action: 'update-status-reconciled',
      stackName: 'web',
    }));
  });

  it('POST clears an older confirmed ok+true row and broadcasts', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;
    const svc = ImageUpdateService.getInstance() as unknown as {
      reserveStackWriteGeneration: (n: number, s: string) => number;
    };
    const writeGen = svc.reserveStackWriteGeneration(nodeId, 'web');
    db.upsertStackUpdateStatus(nodeId, 'web', true, 1000, 'ok', null, [
      { service: 'web', image: 'nginx:1', hasUpdate: true, checkStatus: 'ok', lastError: null },
    ], writeGen);

    vi.spyOn(UpdatePreviewService.getInstance(), 'getPreview').mockResolvedValue(negativeOkPreview('web'));
    const broadcast = vi.spyOn(NotificationService.getInstance(), 'broadcastEvent').mockImplementation(() => undefined);
    const invalidate = vi.spyOn(CacheService.getInstance(), 'invalidate').mockImplementation(() => undefined);

    const res = await request(app)
      .post('/api/stacks/web/update-preview')
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(res.body.reconciled).toBe(true);
    expect(db.getStackUpdateDetail(nodeId).web).toBeUndefined();
    expect(invalidate).toHaveBeenCalledWith('fleet-updates');
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      action: 'update-status-reconciled',
      stackName: 'web',
    }));
  });

  it('POST keeps an ok+false scanner row', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;
    db.upsertStackUpdateStatus(nodeId, 'web', false, 1000, 'ok', null, [
      { service: 'web', image: 'nginx:1.2.3', hasUpdate: false, checkStatus: 'ok', lastError: null },
    ]);

    vi.spyOn(UpdatePreviewService.getInstance(), 'getPreview').mockResolvedValue(negativeOkPreview('web'));
    const broadcast = vi.spyOn(NotificationService.getInstance(), 'broadcastEvent').mockImplementation(() => undefined);
    const invalidate = vi.spyOn(CacheService.getInstance(), 'invalidate').mockImplementation(() => undefined);

    const res = await request(app)
      .post('/api/stacks/web/update-preview')
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(res.body.reconciled).toBe(false);
    expect(db.getStackUpdateDetail(nodeId).web).toMatchObject({
      hasUpdate: false,
      checkStatus: 'ok',
      services: [
        expect.objectContaining({
          service: 'web',
          image: 'nginx:1.2.3',
          hasUpdate: false,
          checkStatus: 'ok',
        }),
      ],
    });
    expect(broadcast).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('POST does not mutate on partial negative preview', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;
    db.upsertStackUpdateStatus(nodeId, 'web', true, 1000, 'partial', 'half');

    const preview = negativeOkPreview('web');
    vi.spyOn(UpdatePreviewService.getInstance(), 'getPreview').mockResolvedValue({
      ...preview,
      images: [{ ...preview.images[0], check_status: 'partial' }],
      summary: { ...preview.summary, check_status: 'partial' },
    });

    const res = await request(app)
      .post('/api/stacks/web/update-preview')
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(res.body.reconciled).toBe(false);
    expect(db.getStackUpdateDetail(nodeId).web?.hasUpdate).toBe(true);
  });

  it('POST does not mutate when an image is not_checkable alongside ok', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;
    db.upsertStackUpdateStatus(nodeId, 'web', true, 1000, 'partial', 'half');

    const preview = negativeOkPreview('web');
    vi.spyOn(UpdatePreviewService.getInstance(), 'getPreview').mockResolvedValue({
      ...preview,
      images: [
        preview.images[0],
        {
          ...preview.images[0],
          service: 'bad',
          image: 'not-a-valid-ref',
          check_status: 'not_checkable' as const,
        },
      ],
      summary: { ...preview.summary, check_status: 'partial' as const },
    });

    const res = await request(app)
      .post('/api/stacks/web/update-preview')
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(res.body.reconciled).toBe(false);
    expect(db.getStackUpdateDetail(nodeId).web?.hasUpdate).toBe(true);
  });

  it('POST does not mutate when check_status is missing from summary rollup fields still fail every-ok', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;
    db.upsertStackUpdateStatus(nodeId, 'web', true, 1000, 'partial', 'half');

    const preview = negativeOkPreview('web');
    vi.spyOn(UpdatePreviewService.getInstance(), 'getPreview').mockResolvedValue({
      ...preview,
      images: [{ ...preview.images[0], check_status: 'partial' as const }],
    });

    const res = await request(app)
      .post('/api/stacks/web/update-preview')
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(res.body.reconciled).toBe(false);
    expect(db.getStackUpdateDetail(nodeId).web?.hasUpdate).toBe(true);
  });

  it('POST does not broadcast when clear finds no row', async () => {
    vi.spyOn(UpdatePreviewService.getInstance(), 'getPreview').mockResolvedValue(negativeOkPreview('ghost'));
    const broadcast = vi.spyOn(NotificationService.getInstance(), 'broadcastEvent').mockImplementation(() => undefined);
    const invalidate = vi.spyOn(CacheService.getInstance(), 'invalidate').mockImplementation(() => undefined);

    const res = await request(app)
      .post('/api/stacks/ghost/update-preview')
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(res.body.reconciled).toBe(false);
    expect(broadcast).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('retains a confirmed row written after the preview observation', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;
    const svc = ImageUpdateService.getInstance() as unknown as {
      peekStackWriteGeneration: (n: number, s: string) => number;
      reserveStackWriteGeneration: (n: number, s: string) => number;
      withStackWriteLock: (
        n: number,
        s: string,
        g: number,
        write: () => void | Promise<void>,
      ) => Promise<boolean>;
    };

    const observedBeforePreview = svc.peekStackWriteGeneration(nodeId, 'web');
    let previewCalls = 0;
    vi.spyOn(UpdatePreviewService.getInstance(), 'getPreview').mockImplementation(async () => {
      previewCalls += 1;
      // Simulate a scanner reservation+commit that begins after observation.
      const scannerGen = svc.reserveStackWriteGeneration(nodeId, 'web');
      await svc.withStackWriteLock(nodeId, 'web', scannerGen, () => {
        db.upsertStackUpdateStatus(nodeId, 'web', true, Date.now(), 'ok', null, [
          { service: 'web', image: 'nginx:9', hasUpdate: true, checkStatus: 'ok', lastError: null },
        ], scannerGen);
      });
      expect(scannerGen).toBeGreaterThan(observedBeforePreview);
      return negativeOkPreview('web');
    });
    const broadcast = vi.spyOn(NotificationService.getInstance(), 'broadcastEvent').mockImplementation(() => undefined);
    const invalidate = vi.spyOn(CacheService.getInstance(), 'invalidate').mockImplementation(() => undefined);

    const res = await request(app)
      .post('/api/stacks/web/update-preview')
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(res.body.reconciled).toBe(false);
    expect(previewCalls).toBe(1);
    expect(db.getStackUpdateDetail(nodeId).web?.hasUpdate).toBe(true);
    expect(db.getStackUpdateDetail(nodeId).web?.checkStatus).toBe('ok');
    expect(broadcast).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('generation ordering for preview clear', () => {
  it('a newer scanner reservation supersedes an in-flight observation-watermark clear', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;
    db.upsertStackUpdateStatus(nodeId, 'ord', true, 1000, 'partial', 'half');
    const svc = ImageUpdateService.getInstance();
    const observedMem = svc.peekStackWriteGeneration(nodeId, 'ord');
    const observedRow = db.getStackUpdateWriteGeneration(nodeId, 'ord');
    const scannerGen = (svc as unknown as {
      reserveStackWriteGeneration: (n: number, s: string) => number;
    }).reserveStackWriteGeneration(nodeId, 'ord');
    expect(scannerGen).toBeGreaterThan(observedMem);

    expect(await svc.commitPreviewClear(nodeId, 'ord', observedMem, observedRow)).toBe('stale');

    const scannerCommitted = await (svc as unknown as {
      withStackWriteLock: (
        n: number,
        s: string,
        g: number,
        write: () => void | Promise<void>,
      ) => Promise<boolean>;
    }).withStackWriteLock(nodeId, 'ord', scannerGen, () => {
      db.upsertStackUpdateStatus(nodeId, 'ord', true, Date.now(), 'ok', null);
    });
    expect(scannerCommitted).toBe(true);
    expect(db.getStackUpdateDetail(nodeId).ord?.hasUpdate).toBe(true);
    expect(db.getStackUpdateDetail(nodeId).ord?.checkStatus).toBe('ok');
  });

  it('equal-generation scanner reserved before observation cannot rewrite after clear', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;
    db.upsertStackUpdateStatus(nodeId, 'ord2', true, 1000, 'partial', 'half', [
      { service: 'web', image: 'web:1', hasUpdate: true, checkStatus: 'partial', lastError: 'half' },
    ], 1);
    const svc = ImageUpdateService.getInstance() as unknown as {
      peekStackWriteGeneration: (n: number, s: string) => number;
      reserveStackWriteGeneration: (n: number, s: string) => number;
      commitPreviewClear: (
        n: number,
        s: string,
        observedMem: number,
        observedRow: number,
      ) => Promise<'cleared' | 'stale' | 'absent'>;
      withStackWriteLock: (
        n: number,
        s: string,
        g: number,
        write: () => void | Promise<void>,
      ) => Promise<boolean>;
    };

    // Full scan reserved generation N before its slow registry work.
    const scannerGen = svc.reserveStackWriteGeneration(nodeId, 'ord2');
    // Preview observation sees that same watermark.
    const observedMem = svc.peekStackWriteGeneration(nodeId, 'ord2');
    const observedRow = db.getStackUpdateWriteGeneration(nodeId, 'ord2');
    expect(observedMem).toBe(scannerGen);

    expect(await svc.commitPreviewClear(nodeId, 'ord2', observedMem, observedRow)).toBe('cleared');
    expect(db.getStackUpdateDetail(nodeId).ord2).toBeUndefined();

    // Delayed scanner write using the pre-observation reservation must not commit.
    const scannerCommitted = await svc.withStackWriteLock(nodeId, 'ord2', scannerGen, () => {
      db.upsertStackUpdateStatus(nodeId, 'ord2', true, Date.now(), 'ok', null, [
        { service: 'web', image: 'web:2', hasUpdate: true, checkStatus: 'ok', lastError: null },
      ], scannerGen);
    });
    expect(scannerCommitted).toBe(false);
    expect(db.getStackUpdateDetail(nodeId).ord2).toBeUndefined();
  });
});
