/**
 * Coverage for the orphan-scan purge helpers on the real DatabaseService:
 *   - getDistinctScanImageRefs (node-scoped, deduplicated)
 *   - deleteScansByImageRef (removes the scan AND its children explicitly,
 *     since SQLite FK cascade is not enabled on the connection)
 *   - deleteStackScans (purges the stack:<name> misconfig scan only)
 *
 * Uses the real DatabaseService against a temp DB so the no-cascade delete path
 * is exercised exactly as in production, not against an in-memory mirror that
 * might enable foreign_keys and mask a missing child delete.
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

function reset(): void {
  const raw = (db() as unknown as { db: { prepare: (s: string) => { run: () => void } } }).db;
  raw.prepare('DELETE FROM vulnerability_scans').run();
  raw.prepare('DELETE FROM vulnerability_details').run();
  raw.prepare('DELETE FROM secret_findings').run();
  raw.prepare('DELETE FROM misconfig_findings').run();
}

function seedScan(imageRef: string, nodeId = 1): number {
  return db().createVulnerabilityScan({
    node_id: nodeId,
    image_ref: imageRef,
    image_digest: `sha256:${imageRef}-${Math.random().toString(16).slice(2)}`,
    scanned_at: Date.now(),
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
    status: 'completed',
    error: null,
    stack_context: null,
  });
}

function countChild(table: string, scanId: number): number {
  const raw = (db() as unknown as { db: { prepare: (s: string) => { get: (...a: unknown[]) => { c: number } } } }).db;
  return raw.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE scan_id = ?`).get(scanId).c;
}

beforeEach(reset);

describe('getDistinctScanImageRefs', () => {
  it('returns each image_ref once, scoped to the node', () => {
    seedScan('nginx:1');
    seedScan('nginx:1'); // duplicate ref, same node
    seedScan('redis:7');
    seedScan('other:1', 2); // different node

    const refs = db().getDistinctScanImageRefs(1).sort();
    expect(refs).toEqual(['nginx:1', 'redis:7']);
  });

  it('returns an empty array when the node has no scans', () => {
    expect(db().getDistinctScanImageRefs(99)).toEqual([]);
  });
});

describe('deleteScansByImageRef', () => {
  it('removes the scan and ALL of its child findings (no FK cascade reliance)', () => {
    const scanId = seedScan('nginx:1');
    db().insertVulnerabilityDetails(scanId, [
      { vulnerability_id: 'CVE-1', pkg_name: 'libssl', installed_version: '1.0', fixed_version: '1.1', severity: 'CRITICAL', title: null, description: null, primary_url: null },
    ]);
    db().insertSecretFindings(scanId, [
      { rule_id: 'aws-key', category: 'secret', severity: 'HIGH', title: null, target: 'app.env', start_line: 1, end_line: 1, match_excerpt: null },
    ]);
    db().insertMisconfigFindings(scanId, [
      { rule_id: 'DS002', check_id: null, severity: 'MEDIUM', title: null, message: null, resolution: null, target: 'Dockerfile', primary_url: null },
    ]);

    expect(countChild('vulnerability_details', scanId)).toBe(1);
    expect(countChild('secret_findings', scanId)).toBe(1);
    expect(countChild('misconfig_findings', scanId)).toBe(1);

    const removed = db().deleteScansByImageRef(1, 'nginx:1');

    expect(removed).toBe(1);
    expect(db().getDistinctScanImageRefs(1)).toEqual([]);
    expect(countChild('vulnerability_details', scanId)).toBe(0);
    expect(countChild('secret_findings', scanId)).toBe(0);
    expect(countChild('misconfig_findings', scanId)).toBe(0);
  });

  it('only deletes the requested ref and node, leaving others intact', () => {
    seedScan('nginx:1');
    seedScan('redis:7');
    seedScan('nginx:1', 2);

    const removed = db().deleteScansByImageRef(1, 'nginx:1');

    expect(removed).toBe(1);
    expect(db().getDistinctScanImageRefs(1).sort()).toEqual(['redis:7']);
    expect(db().getDistinctScanImageRefs(2)).toEqual(['nginx:1']);
  });

  it('is idempotent (0 when nothing matches)', () => {
    expect(db().deleteScansByImageRef(1, 'ghost:1')).toBe(0);
  });
});

describe('deleteStackScans', () => {
  it('purges only the stack:<name> scan, not unrelated image scans', () => {
    seedScan('stack:web');
    seedScan('stack:db');
    seedScan('nginx:1');

    const removed = db().deleteStackScans(1, 'web');

    expect(removed).toBe(1);
    expect(db().getDistinctScanImageRefs(1).sort()).toEqual(['nginx:1', 'stack:db']);
  });
});
