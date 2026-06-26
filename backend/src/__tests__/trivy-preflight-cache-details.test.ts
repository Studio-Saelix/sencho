/**
 * Regression coverage for the pre-deploy gate false-block on cached large scans.
 *
 * A cache-hit preflight scan must copy the cached scan's FULL finding set, not a
 * truncated page. When the copy kept only the first 1000 detail rows but
 * preserved the full aggregate total, the persisted scan was internally
 * inconsistent (stored rows < total_vulnerabilities), and the deploy gate's
 * integrity check (evaluateImageRisk) failed closed on every KEV/fixable input,
 * blocking a deploy with no actual matching finding.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';

let tmpDir: string;
let TrivyService: typeof import('../services/TrivyService').default;

const DIGEST = 'sha256:cachedbig';
const TOTAL = 1100; // deliberately over the old 1000-row copy cap

beforeAll(async () => {
  tmpDir = await setupTestDb();
  TrivyService = (await import('../services/TrivyService')).default;
});

afterAll(() => cleanupTestDb(tmpDir));

function svc() {
  return TrivyService.getInstance();
}
function db() {
  return DatabaseService.getInstance();
}

/** Seed a consistent cached vuln scan: total_vulnerabilities matches its detail rows. */
function seedCachedScan(): number {
  const scanId = db().createVulnerabilityScan({
    node_id: 1, image_ref: 'big:1', image_digest: DIGEST, scanned_at: Date.now(),
    total_vulnerabilities: TOTAL, critical_count: TOTAL, high_count: 0, medium_count: 0, low_count: 0,
    unknown_count: 0, fixable_count: 0, secret_count: 0, misconfig_count: 0, scanners_used: 'vuln',
    highest_severity: 'CRITICAL', os_info: null, trivy_version: null, scan_duration_ms: null,
    triggered_by: 'manual', status: 'completed', error: null, stack_context: null,
  });
  const details = Array.from({ length: TOTAL }, (_, i) => ({
    vulnerability_id: `CVE-2024-${i}`, pkg_name: `pkg-${i}`, installed_version: '1', fixed_version: null,
    severity: 'CRITICAL' as const, title: null, description: null, primary_url: null,
  }));
  db().insertVulnerabilityDetails(scanId, details);
  return scanId;
}

beforeEach(() => {
  const raw = (db() as unknown as { db: { prepare: (s: string) => { run: () => void } } }).db;
  raw.prepare('DELETE FROM vulnerability_details').run();
  raw.prepare('DELETE FROM vulnerability_scans').run();
  (svc() as unknown as { scanningImages: Set<string> }).scanningImages.clear();
  // The cache-hit path returns before invoking the binary; a non-null path is
  // enough to pass the availability guard.
  (svc() as unknown as { binaryPath: string }).binaryPath = '/fake/trivy';
});

describe('TrivyService cache-hit detail copy', () => {
  it('copies every cached vulnerability detail, not a truncated page', async () => {
    seedCachedScan();
    const result = await svc().scanImage('big:1', 1, { useCache: true, digest: DIGEST, scanners: ['vuln'] });
    expect(result.totalVulnerabilities).toBe(TOTAL);
    expect(result.vulnerabilities).toHaveLength(TOTAL);
  });

  it('persists a preflight scan whose stored detail count matches its total (no false-block mismatch)', async () => {
    seedCachedScan();
    // scanImagePreflight resolves the digest itself; the cache hit then reuses it.
    vi.spyOn(svc(), 'getImageDigest').mockResolvedValue(DIGEST);

    const persisted = await svc().scanImagePreflight('big:1', 1, 'web');

    const storedDetailCount = db().getAllVulnerabilityDetails(persisted.id).length;
    expect(persisted.total_vulnerabilities).toBe(TOTAL);
    expect(storedDetailCount).toBe(persisted.total_vulnerabilities);
    // The severity aggregates must survive the cache round-trip too.
    expect(persisted.critical_count).toBe(TOTAL);
  });
});
