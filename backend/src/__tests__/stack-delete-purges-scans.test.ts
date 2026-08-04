/**
 * DELETE /api/stacks/:stackName must purge the deleted stack's compose-config
 * (misconfig) scan, keyed by the `stack:<name>` image_ref convention, so it no
 * longer skews the Security Overview. Image scans are intentionally left to the
 * janitor reconciler (images are shared and may still exist on the host).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type Mock } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let ComposeService: typeof import('../services/ComposeService').ComposeService;
let FileSystemService: typeof import('../services/FileSystemService').FileSystemService;
let MeshService: typeof import('../services/MeshService').MeshService;
let DeployedStackDeletionService: typeof import('../services/DeployedStackDeletionService').DeployedStackDeletionService;
let DockerController: typeof import('../services/DockerController').default;
let adminCookie: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ ComposeService } = await import('../services/ComposeService'));
  ({ FileSystemService } = await import('../services/FileSystemService'));
  ({ MeshService } = await import('../services/MeshService'));
  ({ DeployedStackDeletionService } = await import('../services/DeployedStackDeletionService'));
  ({ default: DockerController } = await import('../services/DockerController'));
  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  vi.restoreAllMocks();
  // Stub leaf I/O so the real delete handler runs through to the DB cleanup.
  vi.spyOn(ComposeService.prototype, 'downStack').mockResolvedValue(undefined);
  vi.spyOn(FileSystemService.prototype, 'deleteStack').mockResolvedValue(undefined);
  vi.spyOn(MeshService.getInstance(), 'optOutStack').mockResolvedValue(undefined);
  const raw = DatabaseService.getInstance().getDb();
  raw.prepare('DELETE FROM vulnerability_scans').run();
});

function seedStackScan(nodeId: number, imageRef: string): void {
  DatabaseService.getInstance().createVulnerabilityScan({
    node_id: nodeId,
    image_ref: imageRef,
    image_digest: null,
    scanned_at: Date.now(),
    total_vulnerabilities: 0,
    critical_count: 0,
    high_count: 0,
    medium_count: 0,
    low_count: 0,
    unknown_count: 0,
    fixable_count: 0,
    secret_count: 0,
    misconfig_count: 1,
    scanners_used: 'misconfig',
    highest_severity: 'MEDIUM',
    os_info: null,
    trivy_version: null,
    scan_duration_ms: null,
    triggered_by: 'manual',
    status: 'completed',
    error: null,
    stack_context: imageRef.startsWith('stack:') ? imageRef.slice('stack:'.length) : null,
  });
}

describe('DELETE /api/stacks/:stackName purges scan data', () => {
  it("removes the deleted stack's stack:<name> scan and leaves other scans", async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getNodes()[0].id;
    seedStackScan(nodeId, 'stack:web');
    seedStackScan(nodeId, 'stack:db');
    seedStackScan(nodeId, 'nginx:1');

    const res = await request(app).delete('/api/stacks/web').set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(db.getDistinctScanImageRefs(nodeId).sort()).toEqual(['nginx:1', 'stack:db']);
  });

  it('is a no-op (still 200) when the deleted stack has no scans', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getNodes()[0].id;
    seedStackScan(nodeId, 'nginx:1');

    const res = await request(app).delete('/api/stacks/never-scanned').set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(db.getDistinctScanImageRefs(nodeId)).toEqual(['nginx:1']);
  });
});

// ── Wiring: pruneVolumes flag reaches downStack ────────────────────────

describe('DELETE /api/stacks/:stackName wires pruneVolumes to downStack', () => {
  let downStackSpy: Mock;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(FileSystemService.prototype, 'deleteStack').mockResolvedValue(undefined);
    vi.spyOn(MeshService.getInstance(), 'optOutStack').mockResolvedValue(undefined);
    downStackSpy = vi.spyOn(ComposeService.prototype, 'downStack').mockResolvedValue(undefined);
  });

  it('passes removeVolumes: true when pruneVolumes=true', async () => {
    const res = await request(app).delete('/api/stacks/web?pruneVolumes=true').set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    const lastArgs = downStackSpy.mock.calls.at(-1);
    expect(lastArgs?.[1]).toEqual({ removeVolumes: true });
  });

  it('passes a falsy removeVolumes when pruneVolumes is absent', async () => {
    const res = await request(app).delete('/api/stacks/web').set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    const lastArgs = downStackSpy.mock.calls.at(-1);
    expect(lastArgs?.[1]?.removeVolumes).toBeFalsy();
  });
});

// ── Continuation guard: persisted flag beats input flag ─────────────────

describe('DeployedStackDeletionService continuation', () => {
  it('uses intent.prune_volumes_requested (not input.pruneVolumes) on resumed deletion', async () => {
    vi.restoreAllMocks();
    const downStackSpy = vi.spyOn(ComposeService.prototype, 'downStack').mockResolvedValue(undefined);
    vi.spyOn(FileSystemService.prototype, 'deleteStack').mockResolvedValue(undefined);
    vi.spyOn(MeshService.getInstance(), 'optOutStack').mockResolvedValue(undefined);
    vi.spyOn(DockerController.prototype, 'pruneManagedOnly').mockResolvedValue({ success: true, reclaimedBytes: 0 });

    const db = DatabaseService.getInstance();
    const nodeId = db.getNodes()[0].id;

    const intentId = 'test-continuation-guard';
    db.getDb().prepare(`
      INSERT OR REPLACE INTO stack_update_cleanup_pending
        (id, node_id, stack_name, status, target_kind, rollback_tags_json, override_paths_json, prune_volumes_requested, required_blueprint_id, created_at, updated_at)
      VALUES (?, ?, ?, 'prepared', 'local_socket', '[]', '[]', 0, NULL, ?, ?)
    `).run(intentId, nodeId, 'web', Date.now(), Date.now());

    const svc = DeployedStackDeletionService.getInstance();
    await svc.deleteDeployedStack({
      nodeId,
      stackName: 'web',
      pruneVolumes: true,
      actor: 'test',
      continuationIntentId: intentId,
    });

    db.getDb().prepare('DELETE FROM stack_update_cleanup_pending WHERE id = ?').run(intentId);

    const lastArgs = downStackSpy.mock.calls.at(-1);
    expect(lastArgs?.[1]?.removeVolumes).toBeFalsy();
  });
});
