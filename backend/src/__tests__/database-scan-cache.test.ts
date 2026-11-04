/**
 * Verifies the `scanners_used` dimension of the digest cache key.
 *
 * A vuln-only row must not satisfy a lookup for a vuln+secret scan; otherwise
 * a secret-scan request would silently reuse a stale finding set.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

function seedScan(overrides: Partial<{ scanners_used: string; scanned_at: number; platform: string; digest: string }> = {}): number {
    const db = DatabaseService.getInstance();
    return db.createVulnerabilityScan({
        node_id: 1,
        image_ref: 'alpine:3.19',
        image_digest: overrides.digest ?? 'sha256:deadbeef',
        platform: overrides.platform,
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
        scanners_used: overrides.scanners_used ?? 'vuln',
        highest_severity: null,
        os_info: 'alpine 3.19',
        trivy_version: '0.56.0',
        scan_duration_ms: 1200,
        triggered_by: 'manual',
        status: 'completed',
        error: null,
        stack_context: null,
    });
}

describe('getLatestScanByDigest scanners scoping', () => {
    it('returns null for a vuln+secret lookup when only a vuln row exists', () => {
        const db = DatabaseService.getInstance();
        seedScan({ scanners_used: 'vuln' });
        expect(
            db.getLatestScanByDigest('sha256:deadbeef', 'vuln,secret'),
        ).toBeNull();
    });

    it('returns the matching row when scanners_used matches exactly', () => {
        const db = DatabaseService.getInstance();
        const id = seedScan({ scanners_used: 'vuln,secret', scanned_at: Date.now() + 10 });
        const row = db.getLatestScanByDigest('sha256:deadbeef', 'vuln,secret');
        expect(row?.id).toBe(id);
    });

    it('falls back to latest completed row when scannersUsed omitted', () => {
        const db = DatabaseService.getInstance();
        const row = db.getLatestScanByDigest('sha256:deadbeef');
        expect(row).not.toBeNull();
    });

    it('returns null for digest with no completed scans', () => {
        const db = DatabaseService.getInstance();
        expect(db.getLatestScanByDigest('sha256:notreal', 'vuln')).toBeNull();
    });
});

describe('getLatestScanByDigest platform scoping', () => {
    it('does not return a row for another platform child of the same index digest', () => {
        const db = DatabaseService.getInstance();
        const digest = 'sha256:platformchildren';
        const amd = seedScan({ digest, platform: 'linux/amd64' });

        expect(db.getLatestScanByDigest(digest, 'vuln', 'linux/arm64')).toBeNull();
        expect(db.getLatestScanByDigest(digest, 'vuln', 'linux/amd64')?.id).toBe(amd);
        // Callers that do not name a platform (every non-gate path) keep the
        // historical digest-only lookup.
        expect(db.getLatestScanByDigest(digest, 'vuln')?.id).toBe(amd);
    });
});
