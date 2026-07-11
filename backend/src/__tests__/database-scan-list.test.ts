/**
 * Coverage for `getVulnerabilityScans` filtering + pagination, used by
 * the scan-history page's server-driven pagination. Caps and prune partition
 * by digest identity (fallback to image_ref when digest is null/empty).
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
  image_digest: string | null;
  scanned_at: number;
  status: 'completed' | 'in_progress' | 'failed';
}> = {}): number {
  const db = DatabaseService.getInstance();
  const digest =
    overrides.image_digest === undefined
      ? `sha256:${Math.random().toString(16).slice(2)}`
      : overrides.image_digest;
  return db.createVulnerabilityScan({
    node_id: overrides.node_id ?? 1,
    image_ref: overrides.image_ref ?? 'alpine:3.19',
    image_digest: digest,
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

  it('filters by imageRefLike substring (reference-only, legacy)', () => {
    const db = DatabaseService.getInstance();
    seedScan({ image_ref: 'alpine:3.18', image_digest: 'sha256:aaa', scanned_at: 1 });
    seedScan({ image_ref: 'alpine:3.19', image_digest: 'sha256:bbb', scanned_at: 2 });
    seedScan({ image_ref: 'nginx:1.25', image_digest: 'sha256:ccc', scanned_at: 3 });

    const result = db.getVulnerabilityScans(1, { imageRefLike: 'alpine' });
    expect(result.total).toBe(2);
    expect(result.items.every((s) => s.image_ref.startsWith('alpine'))).toBe(true);
  });

  it('imageRefLike does not match digest-only fragments', () => {
    const db = DatabaseService.getInstance();
    seedScan({ image_ref: 'nginx:1', image_digest: 'sha256:alpinecafe', scanned_at: 1 });
    seedScan({ image_ref: 'alpine:3.19', image_digest: 'sha256:other', scanned_at: 2 });

    const result = db.getVulnerabilityScans(1, { imageRefLike: 'alpine' });
    expect(result.total).toBe(1);
    expect(result.items[0].image_ref).toBe('alpine:3.19');
  });

  it('imageIdentityLike matches image_ref OR image_digest', () => {
    const db = DatabaseService.getInstance();
    seedScan({ image_ref: 'nginx:1', image_digest: 'sha256:deadbeef01', scanned_at: 1 });
    seedScan({ image_ref: 'redis:7', image_digest: 'sha256:cafef00d02', scanned_at: 2 });
    seedScan({ image_ref: 'alpine:3.19', image_digest: 'sha256:other03', scanned_at: 3 });

    const byDigest = db.getVulnerabilityScans(1, { imageIdentityLike: 'deadbeef' });
    expect(byDigest.total).toBe(1);
    expect(byDigest.items[0].image_ref).toBe('nginx:1');

    const byRef = db.getVulnerabilityScans(1, { imageIdentityLike: 'alpine' });
    expect(byRef.total).toBe(1);
    expect(byRef.items[0].image_ref).toBe('alpine:3.19');
  });

  it('filters by exact imageDigest', () => {
    const db = DatabaseService.getInstance();
    const digest = 'sha256:exactmatch99';
    seedScan({ image_ref: 'a:1', image_digest: digest, scanned_at: 1 });
    seedScan({ image_ref: 'a:2', image_digest: 'sha256:other', scanned_at: 2 });

    const result = db.getVulnerabilityScans(1, { imageDigest: digest });
    expect(result.total).toBe(1);
    expect(result.items[0].image_digest).toBe(digest);
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

describe('getVulnerabilityScans per-digest identity cap', () => {
  it('caps rows per digest identity and reports cappedIdentities', () => {
    const db = DatabaseService.getInstance();
    db.updateGlobalSetting('scan_history_per_image_limit', '10');
    const hotDigest = 'sha256:hotdigest00';
    const coolDigest = 'sha256:cooldigest0';

    for (let i = 0; i < 80; i++) {
      seedScan({ image_ref: 'hot:latest', image_digest: hotDigest, scanned_at: 1000 + i });
    }
    for (let i = 0; i < 5; i++) {
      seedScan({ image_ref: 'cool:latest', image_digest: coolDigest, scanned_at: 1000 + i });
    }

    const result = db.getVulnerabilityScans(1, { limit: 500 });
    const hotRows = result.items.filter((s) => s.image_digest === hotDigest);
    const coolRows = result.items.filter((s) => s.image_digest === coolDigest);

    expect(hotRows).toHaveLength(10);
    expect(coolRows).toHaveLength(5);
    expect(result.total).toBe(15);
    expect(result.cappedIdentities).toEqual([
      { key: hotDigest, kind: 'digest', displayRef: 'hot:latest' },
    ]);
    expect(result.perImageLimit).toBe(10);
  });

  it('shares one retention bucket across tags that share a digest', () => {
    const db = DatabaseService.getInstance();
    db.updateGlobalSetting('scan_history_per_image_limit', '5');
    const shared = 'sha256:sharedigest1';

    for (let i = 0; i < 4; i++) {
      seedScan({ image_ref: 'app:v1', image_digest: shared, scanned_at: 1000 + i });
    }
    for (let i = 0; i < 4; i++) {
      seedScan({ image_ref: 'app:latest', image_digest: shared, scanned_at: 2000 + i });
    }

    const result = db.getVulnerabilityScans(1, { limit: 500 });
    expect(result.total).toBe(5);
    expect(result.items.every((s) => s.image_digest === shared)).toBe(true);
    expect(result.cappedIdentities[0]?.displayRef).toBe('app:latest');
  });

  it('partitions null-digest rows by image_ref', () => {
    const db = DatabaseService.getInstance();
    db.updateGlobalSetting('scan_history_per_image_limit', '3');
    for (let i = 0; i < 6; i++) {
      seedScan({ image_ref: 'stack:web', image_digest: null, scanned_at: 1000 + i });
    }
    const result = db.getVulnerabilityScans(1, { limit: 500 });
    expect(result.total).toBe(3);
    expect(result.cappedIdentities).toEqual([
      { key: 'stack:web', kind: 'ref', displayRef: 'stack:web' },
    ]);
  });

  it('treats empty and whitespace-only digests as ref identity', () => {
    const db = DatabaseService.getInstance();
    db.updateGlobalSetting('scan_history_per_image_limit', '2');
    for (let i = 0; i < 3; i++) {
      seedScan({ image_ref: 'stack:empty', image_digest: '', scanned_at: 1000 + i });
    }
    for (let i = 0; i < 3; i++) {
      seedScan({ image_ref: 'stack:ws', image_digest: '   ', scanned_at: 2000 + i });
    }
    const empty = db.getVulnerabilityScans(1, { imageRef: 'stack:empty', limit: 500 });
    expect(empty.items).toHaveLength(3);
    const listed = db.getVulnerabilityScans(1, { limit: 500 });
    expect(listed.cappedIdentities).toEqual(
      expect.arrayContaining([
        { key: 'stack:empty', kind: 'ref', displayRef: 'stack:empty' },
        { key: 'stack:ws', kind: 'ref', displayRef: 'stack:ws' },
      ]),
    );
  });

  it('bypasses the cap when imageRef targets a single image', () => {
    const db = DatabaseService.getInstance();
    db.updateGlobalSetting('scan_history_per_image_limit', '10');
    const digest = 'sha256:hotdigest00';

    for (let i = 0; i < 30; i++) {
      seedScan({ image_ref: 'hot:latest', image_digest: digest, scanned_at: 1000 + i });
    }

    const result = db.getVulnerabilityScans(1, { imageRef: 'hot:latest', limit: 500 });
    expect(result.items).toHaveLength(30);
    expect(result.total).toBe(30);
    expect(result.cappedIdentities).toEqual([]);
  });

  it('bypasses the cap when imageDigest targets a single digest', () => {
    const db = DatabaseService.getInstance();
    db.updateGlobalSetting('scan_history_per_image_limit', '10');
    const digest = 'sha256:hotdigest00';

    for (let i = 0; i < 30; i++) {
      seedScan({ image_ref: 'hot:latest', image_digest: digest, scanned_at: 1000 + i });
    }

    const result = db.getVulnerabilityScans(1, { imageDigest: digest, limit: 500 });
    expect(result.items).toHaveLength(30);
    expect(result.cappedIdentities).toEqual([]);
  });

  it('never mixes identities across nodes in cappedIdentities', () => {
    const db = DatabaseService.getInstance();
    db.updateGlobalSetting('scan_history_per_image_limit', '2');
    db.getDb()
      .prepare(`INSERT OR IGNORE INTO nodes (id, name, type, compose_dir, is_default, status, created_at)
                VALUES (2, 'Peer', 'remote', '/tmp', 0, 'online', ?)`)
      .run(Date.now());
    const digest = 'sha256:crossnode00';
    for (let i = 0; i < 4; i++) {
      seedScan({ node_id: 1, image_ref: 'a:1', image_digest: digest, scanned_at: 1000 + i });
    }
    for (let i = 0; i < 4; i++) {
      seedScan({ node_id: 2, image_ref: 'a:1', image_digest: digest, scanned_at: 2000 + i });
    }

    const node1 = db.getVulnerabilityScans(1, { limit: 500 });
    const node2 = db.getVulnerabilityScans(2, { limit: 500 });
    expect(node1.total).toBe(2);
    expect(node2.total).toBe(2);
    expect(node1.items.every((s) => s.node_id === 1)).toBe(true);
    expect(node2.items.every((s) => s.node_id === 2)).toBe(true);
  });
});

describe('pruneScanHistoryPerImage', () => {
  it('keeps the newest N rows per (node_id, digest identity) and deletes the rest', () => {
    const db = DatabaseService.getInstance();
    const hotDigest = 'sha256:hotdigest00';
    const coolDigest = 'sha256:cooldigest0';
    for (let i = 0; i < 60; i++) {
      seedScan({ image_ref: 'hot:latest', image_digest: hotDigest, scanned_at: 1000 + i });
    }
    for (let i = 0; i < 5; i++) {
      seedScan({ image_ref: 'cool:latest', image_digest: coolDigest, scanned_at: 1000 + i });
    }

    const deleted = db.pruneScanHistoryPerImage(50);
    expect(deleted).toBe(10);

    const after = db.getVulnerabilityScans(1, { imageRef: 'hot:latest', limit: 500 });
    expect(after.items).toHaveLength(50);
    const oldest = Math.min(...after.items.map((s) => s.scanned_at));
    expect(oldest).toBe(1010);

    const cool = db.getVulnerabilityScans(1, { imageRef: 'cool:latest', limit: 500 });
    expect(cool.items).toHaveLength(5);
  });

  it('prunes shared-digest tags as one identity bucket', () => {
    const db = DatabaseService.getInstance();
    const shared = 'sha256:sharedprune01';
    for (let i = 0; i < 4; i++) {
      seedScan({ image_ref: 'app:v1', image_digest: shared, scanned_at: 1000 + i });
    }
    for (let i = 0; i < 4; i++) {
      seedScan({ image_ref: 'app:latest', image_digest: shared, scanned_at: 2000 + i });
    }

    const deleted = db.pruneScanHistoryPerImage(5);
    expect(deleted).toBe(3);

    const remaining = db.getVulnerabilityScans(1, { imageDigest: shared, limit: 500 });
    expect(remaining.items).toHaveLength(5);
  });

  it('is a no-op when no identity exceeds the cap', () => {
    const db = DatabaseService.getInstance();
    for (let i = 0; i < 3; i++) {
      seedScan({ image_ref: 'small:latest', image_digest: 'sha256:small00', scanned_at: 1000 + i });
    }

    const deleted = db.pruneScanHistoryPerImage(50);
    expect(deleted).toBe(0);
  });

  it('partitions by node_id so two nodes scanning the same digest keep independent histories', () => {
    const db = DatabaseService.getInstance();
    db.getDb()
      .prepare(`INSERT OR IGNORE INTO nodes (id, name, type, compose_dir, is_default, status, created_at)
                VALUES (2, 'Peer', 'remote', '/tmp', 0, 'online', ?)`)
      .run(Date.now());
    const digest = 'sha256:alpine31900';

    for (let i = 0; i < 60; i++) {
      seedScan({ node_id: 1, image_ref: 'alpine:3.19', image_digest: digest, scanned_at: 1000 + i });
    }
    for (let i = 0; i < 60; i++) {
      seedScan({ node_id: 2, image_ref: 'alpine:3.19', image_digest: digest, scanned_at: 2000 + i });
    }

    const deleted = db.pruneScanHistoryPerImage(50);
    expect(deleted).toBe(20);

    const node1 = db.getVulnerabilityScans(1, { imageRef: 'alpine:3.19', limit: 500 });
    const node2 = db.getVulnerabilityScans(2, { imageRef: 'alpine:3.19', limit: 500 });
    expect(node1.items).toHaveLength(50);
    expect(node2.items).toHaveLength(50);
  });

  it('deletes child vulnerability_details rows for pruned scans', () => {
    const db = DatabaseService.getInstance();
    const digest = 'sha256:hotdigest00';
    const ids: number[] = [];
    for (let i = 0; i < 60; i++) {
      ids.push(seedScan({ image_ref: 'hot:latest', image_digest: digest, scanned_at: 1000 + i }));
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

describe('vulnerability_details enrichment round-trips', () => {
  it('persists and reads back status, CVSS, vendor severity, purl, path, and layer', () => {
    const db = DatabaseService.getInstance();
    const scanId = seedScan({ image_ref: 'enriched:1' });
    db.insertVulnerabilityDetails(scanId, [
      {
        vulnerability_id: 'CVE-2024-1234',
        pkg_name: 'libssl',
        installed_version: '1.0.0',
        fixed_version: '1.0.1',
        severity: 'CRITICAL',
        title: 'enriched finding',
        description: null,
        primary_url: null,
        status: 'will_not_fix',
        cvss_score: 9.8,
        cvss_vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
        cvss_source: 'nvd',
        vendor_severity: 'HIGH',
        purl: 'pkg:deb/debian/libssl@1.0.0',
        pkg_path: 'usr/lib/libssl.so',
        layer_digest: 'sha256:cafe',
      },
      {
        vulnerability_id: 'CVE-2024-5678',
        pkg_name: 'libbare',
        installed_version: '2',
        fixed_version: null,
        severity: 'HIGH',
        title: null,
        description: null,
        primary_url: null,
      },
    ]);
    const { items } = db.getVulnerabilityDetails(scanId);
    const enriched = items.find((i) => i.vulnerability_id === 'CVE-2024-1234');
    expect(enriched).toMatchObject({
      status: 'will_not_fix',
      cvss_score: 9.8,
      cvss_source: 'nvd',
      vendor_severity: 'HIGH',
      purl: 'pkg:deb/debian/libssl@1.0.0',
      pkg_path: 'usr/lib/libssl.so',
      layer_digest: 'sha256:cafe',
    });
    const bare = items.find((i) => i.vulnerability_id === 'CVE-2024-5678');
    expect(bare?.status ?? null).toBeNull();
    expect(bare?.cvss_score ?? null).toBeNull();
  });
});

describe('cve_suppressions triage replication', () => {
  function clearSuppressions(): void {
    (DatabaseService.getInstance() as unknown as { db: { prepare: (s: string) => { run: () => void } } })
      .db.prepare('DELETE FROM cve_suppressions').run();
  }

  it('round-trips a non-default triage status through replication', () => {
    const db = DatabaseService.getInstance();
    clearSuppressions();
    db.replaceReplicatedCveSuppressions([{
      cve_id: 'CVE-2024-3001', pkg_name: null, image_pattern: null, reason: 'vendor confirmed safe',
      created_by: 'control-admin', created_at: 1000, expires_at: null, replicated_from_control: 1,
      status: 'not_affected', justification: 'vulnerable_code_not_in_execute_path',
    }]);
    const row = db.getCveSuppressions().find((s) => s.cve_id === 'CVE-2024-3001');
    expect(row).toMatchObject({ status: 'not_affected', justification: 'vulnerable_code_not_in_execute_path', replicated_from_control: 1 });
  });

  it('defaults replicated rows that omit status to accepted (upgrade path)', () => {
    const db = DatabaseService.getInstance();
    clearSuppressions();
    db.replaceReplicatedCveSuppressions([{
      cve_id: 'CVE-2024-3002', pkg_name: null, image_pattern: null, reason: 'legacy push',
      created_by: 'control-admin', created_at: 1000, expires_at: null, replicated_from_control: 1,
    }]);
    const row = db.getCveSuppressions().find((s) => s.cve_id === 'CVE-2024-3002');
    expect(row?.status).toBe('accepted');
  });
});
