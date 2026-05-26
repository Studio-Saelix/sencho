/**
 * Coverage for `getVulnerabilityScans` filtering + pagination, used by
 * the scan-history page's server-driven pagination.
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

function seedScan(overrides: Partial<{
  node_id: number;
  image_ref: string;
  scanned_at: number;
  status: 'completed' | 'in_progress' | 'failed';
}> = {}): number {
  const db = DatabaseService.getInstance();
  return db.createVulnerabilityScan({
    node_id: overrides.node_id ?? 1,
    image_ref: overrides.image_ref ?? 'alpine:3.19',
    image_digest: `sha256:${Math.random().toString(16).slice(2)}`,
    scanned_at: overrides.scanned_at ?? Date.now(),
    total_vulnerabilities: 0,
    critical_count: 0,
    high_count: 0,
    medium_count: 0,
    low_count: 0,
    unknown_count: 0,
    fixable_count: 0,
    secret_count: 0,
    misconfig_count: 0,
    scanners_used: 'vuln',
    highest_severity: null,
    os_info: null,
    trivy_version: null,
    scan_duration_ms: null,
    triggered_by: 'manual',
    status: overrides.status ?? 'completed',
    error: null,
    stack_context: null,
  });
}

function resetTable(): void {
  (DatabaseService.getInstance() as unknown as {
    db: { prepare: (s: string) => { run: () => void } };
  }).db.prepare('DELETE FROM vulnerability_scans').run();
}

beforeEach(() => resetTable());

describe('getVulnerabilityScans filters and pagination', () => {
  it('filters by status=completed', () => {
    const db = DatabaseService.getInstance();
    seedScan({ status: 'completed', scanned_at: 1 });
    seedScan({ status: 'in_progress', scanned_at: 2 });
    seedScan({ status: 'failed', scanned_at: 3 });

    const result = db.getVulnerabilityScans(1, { status: 'completed' });
    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].status).toBe('completed');
  });

  it('filters by imageRefLike substring, case-sensitive', () => {
    const db = DatabaseService.getInstance();
    seedScan({ image_ref: 'alpine:3.18', scanned_at: 1 });
    seedScan({ image_ref: 'alpine:3.19', scanned_at: 2 });
    seedScan({ image_ref: 'nginx:1.25', scanned_at: 3 });

    const result = db.getVulnerabilityScans(1, { imageRefLike: 'alpine' });
    expect(result.total).toBe(2);
    expect(result.items.every((s) => s.image_ref.startsWith('alpine'))).toBe(true);
  });

  it('returns total independent of limit for pagination', () => {
    const db = DatabaseService.getInstance();
    for (let i = 0; i < 5; i++) seedScan({ scanned_at: i * 1000 });

    const page1 = db.getVulnerabilityScans(1, { limit: 2, offset: 0 });
    const page2 = db.getVulnerabilityScans(1, { limit: 2, offset: 2 });

    expect(page1.total).toBe(5);
    expect(page2.total).toBe(5);
    expect(page1.items).toHaveLength(2);
    expect(page2.items).toHaveLength(2);
    expect(page1.items[0].id).not.toBe(page2.items[0].id);
  });
});

describe('getVulnerabilityScans per-image cap', () => {
  it('caps rows per image_ref when no imageRef filter is set', () => {
    const db = DatabaseService.getInstance();
    db.updateGlobalSetting('scan_history_per_image_limit', '10');

    for (let i = 0; i < 80; i++) seedScan({ image_ref: 'hot:latest', scanned_at: 1000 + i });
    for (let i = 0; i < 5; i++) seedScan({ image_ref: 'cool:latest', scanned_at: 1000 + i });

    const result = db.getVulnerabilityScans(1, { limit: 500 });
    const hotRows = result.items.filter((s) => s.image_ref === 'hot:latest');
    const coolRows = result.items.filter((s) => s.image_ref === 'cool:latest');

    expect(hotRows).toHaveLength(10);
    expect(coolRows).toHaveLength(5);
    expect(result.total).toBe(15);
    expect(result.cappedImageRefs).toEqual(['hot:latest']);
    expect(result.perImageLimit).toBe(10);
  });

  it('bypasses the cap when imageRef targets a single image', () => {
    const db = DatabaseService.getInstance();
    db.updateGlobalSetting('scan_history_per_image_limit', '10');

    for (let i = 0; i < 30; i++) seedScan({ image_ref: 'hot:latest', scanned_at: 1000 + i });

    const result = db.getVulnerabilityScans(1, { imageRef: 'hot:latest', limit: 500 });
    expect(result.items).toHaveLength(30);
    expect(result.total).toBe(30);
    expect(result.cappedImageRefs).toEqual([]);
  });
});

describe('pruneScanHistoryPerImage', () => {
  it('keeps the newest N rows per (node_id, image_ref) and deletes the rest', () => {
    const db = DatabaseService.getInstance();
    for (let i = 0; i < 60; i++) seedScan({ image_ref: 'hot:latest', scanned_at: 1000 + i });
    for (let i = 0; i < 5; i++) seedScan({ image_ref: 'cool:latest', scanned_at: 1000 + i });

    const deleted = db.pruneScanHistoryPerImage(50);
    expect(deleted).toBe(10);

    const after = db.getVulnerabilityScans(1, { imageRef: 'hot:latest', limit: 500 });
    expect(after.items).toHaveLength(50);
    const oldest = Math.min(...after.items.map((s) => s.scanned_at));
    expect(oldest).toBe(1010);

    const cool = db.getVulnerabilityScans(1, { imageRef: 'cool:latest', limit: 500 });
    expect(cool.items).toHaveLength(5);
  });

  it('is a no-op when no image exceeds the cap', () => {
    const db = DatabaseService.getInstance();
    for (let i = 0; i < 3; i++) seedScan({ image_ref: 'small:latest', scanned_at: 1000 + i });

    const deleted = db.pruneScanHistoryPerImage(50);
    expect(deleted).toBe(0);
  });

  it('partitions by node_id so two nodes scanning the same image keep independent histories', () => {
    const db = DatabaseService.getInstance();
    db.getDb()
      .prepare(`INSERT INTO nodes (id, name, type, compose_dir, is_default, status, created_at)
                VALUES (2, 'Peer', 'remote', '/tmp', 0, 'online', ?)`)
      .run(Date.now());

    for (let i = 0; i < 60; i++) seedScan({ node_id: 1, image_ref: 'alpine:3.19', scanned_at: 1000 + i });
    for (let i = 0; i < 60; i++) seedScan({ node_id: 2, image_ref: 'alpine:3.19', scanned_at: 2000 + i });

    const deleted = db.pruneScanHistoryPerImage(50);
    expect(deleted).toBe(20);

    const node1 = db.getVulnerabilityScans(1, { imageRef: 'alpine:3.19', limit: 500 });
    const node2 = db.getVulnerabilityScans(2, { imageRef: 'alpine:3.19', limit: 500 });
    expect(node1.items).toHaveLength(50);
    expect(node2.items).toHaveLength(50);
  });

  it('deletes child vulnerability_details rows for pruned scans', () => {
    const db = DatabaseService.getInstance();
    const ids: number[] = [];
    for (let i = 0; i < 60; i++) {
      ids.push(seedScan({ image_ref: 'hot:latest', scanned_at: 1000 + i }));
    }
    const oldestScanId = ids[0];
    db.insertVulnerabilityDetails(oldestScanId, [{
      vulnerability_id: 'CVE-2020-0001',
      pkg_name: 'libfoo',
      installed_version: '1.0',
      fixed_version: '1.1',
      severity: 'HIGH',
      title: 'Test',
      description: null,
      primary_url: null,
    }]);

    const beforeChildren = db.getDb()
      .prepare('SELECT COUNT(*) as cnt FROM vulnerability_details WHERE scan_id = ?')
      .get(oldestScanId) as { cnt: number };
    expect(beforeChildren.cnt).toBe(1);

    const deleted = db.pruneScanHistoryPerImage(50);
    expect(deleted).toBe(10);

    const afterChildren = db.getDb()
      .prepare('SELECT COUNT(*) as cnt FROM vulnerability_details WHERE scan_id = ?')
      .get(oldestScanId) as { cnt: number };
    expect(afterChildren.cnt).toBe(0);
  });
});
