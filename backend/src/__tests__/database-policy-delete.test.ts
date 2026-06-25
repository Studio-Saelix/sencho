/**
 * Pins the cascade behavior of `DatabaseService.deleteScanPolicy`.
 *
 * Scans are evaluated against a policy at scan time and the result is cached
 * inside `vulnerability_scans.policy_evaluation` as a JSON blob. When the
 * underlying policy is deleted, those blobs must be cleared so the scheduler
 * and UI stop reporting violations from a policy that no longer exists.
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

function seedScanWithEvaluation(policyId: number, digest: string): number {
    const db = DatabaseService.getInstance();
    const id = db.createVulnerabilityScan({
        node_id: 1,
        image_ref: `alpine:${digest.slice(-4)}`,
        image_digest: digest,
        scanned_at: Date.now(),
        total_vulnerabilities: 1,
        critical_count: 0,
        high_count: 1,
        medium_count: 0,
        low_count: 0,
        unknown_count: 0,
        fixable_count: 0,
        secret_count: 0,
        misconfig_count: 0,
        scanners_used: 'vuln',
        highest_severity: 'HIGH',
        os_info: 'alpine 3.19',
        trivy_version: '0.56.0',
        scan_duration_ms: 1200,
        triggered_by: 'manual',
        status: 'completed',
        error: null,
        stack_context: null,
    });
    db.updateVulnerabilityScan(id, {
        policy_evaluation: JSON.stringify({
            policyId,
            policyName: 'block-high',
            maxSeverity: 'HIGH',
            violated: true,
            evaluatedAt: Date.now(),
        }),
    });
    return id;
}

describe('deleteScanPolicy', () => {
    it('removes the policy row and clears policy_evaluation on matching scans', () => {
        const db = DatabaseService.getInstance();
        const policy = db.createScanPolicy({
            name: 'block-high',
            node_id: null,
            node_identity: '',
            stack_pattern: '*',
            max_severity: 'HIGH',
            block_on_deploy: 1, block_on_severity: 1, block_on_kev: 0, block_on_fixable: 0,
            enabled: 1,
            replicated_from_control: 0,
        });
        const otherPolicy = db.createScanPolicy({
            name: 'block-critical',
            node_id: null,
            node_identity: '',
            stack_pattern: '*',
            max_severity: 'CRITICAL',
            block_on_deploy: 1, block_on_severity: 1, block_on_kev: 0, block_on_fixable: 0,
            enabled: 1,
            replicated_from_control: 0,
        });

        const matchingScanId = seedScanWithEvaluation(policy.id, 'sha256:matching');
        const unrelatedScanId = seedScanWithEvaluation(otherPolicy.id, 'sha256:unrelated');

        db.deleteScanPolicy(policy.id);

        expect(db.getScanPolicy(policy.id)).toBeNull();
        expect(db.getVulnerabilityScan(matchingScanId)?.policy_evaluation).toBeNull();
        expect(db.getVulnerabilityScan(unrelatedScanId)?.policy_evaluation).not.toBeNull();
        expect(db.getScanPolicy(otherPolicy.id)).not.toBeNull();
    });

    it('is a no-op for an unknown policy id', () => {
        const db = DatabaseService.getInstance();
        expect(() => db.deleteScanPolicy(999_999)).not.toThrow();
    });

    it('does not touch scans whose policy_evaluation is NULL', () => {
        const db = DatabaseService.getInstance();
        const policy = db.createScanPolicy({
            name: 'block-medium',
            node_id: null,
            node_identity: '',
            stack_pattern: '*',
            max_severity: 'MEDIUM',
            block_on_deploy: 1, block_on_severity: 1, block_on_kev: 0, block_on_fixable: 0,
            enabled: 1,
            replicated_from_control: 0,
        });
        const unevaluatedScanId = db.createVulnerabilityScan({
            node_id: 1,
            image_ref: 'alpine:none',
            image_digest: 'sha256:nopol',
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
            os_info: 'alpine 3.19',
            trivy_version: '0.56.0',
            scan_duration_ms: 100,
            triggered_by: 'manual',
            status: 'completed',
            error: null,
            stack_context: null,
        });

        db.deleteScanPolicy(policy.id);

        const row = db.getVulnerabilityScan(unevaluatedScanId);
        expect(row).not.toBeNull();
        expect(row?.policy_evaluation).toBeNull();
    });
});
