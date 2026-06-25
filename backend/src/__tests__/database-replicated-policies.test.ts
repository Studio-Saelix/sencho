/**
 * Pins the orphan-cleanup behavior of `replaceReplicatedScanPolicies`.
 *
 * A replica receives the full set of replicated policies on every sync push.
 * Inserts always allocate fresh ids on the replica side, so any
 * `vulnerability_scans.policy_evaluation` row that referenced the prior set
 * by id is stale the moment the swap completes. The replace path must clear
 * those orphans atomically inside the same transaction so a replica's UI
 * stops showing violations from a policy that no longer exists.
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

function seedScan(policyId: number, digest: string): number {
    const db = DatabaseService.getInstance();
    const id = db.createVulnerabilityScan({
        node_id: 1,
        image_ref: `alpine:${digest.slice(-4)}`,
        image_digest: digest,
        scanned_at: Date.now(),
        total_vulnerabilities: 1,
        critical_count: 1,
        high_count: 0,
        medium_count: 0,
        low_count: 0,
        unknown_count: 0,
        fixable_count: 0,
        secret_count: 0,
        misconfig_count: 0,
        scanners_used: 'vuln',
        highest_severity: 'CRITICAL',
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
            policyName: 'mirrored',
            maxSeverity: 'HIGH',
            violated: true,
            evaluatedAt: Date.now(),
        }),
    });
    return id;
}

describe('replaceReplicatedScanPolicies', () => {
    it('clears stale policy_evaluation when replicated rows are swapped for fresh ids', () => {
        const db = DatabaseService.getInstance();
        // Insert one replicated policy, simulating the receiver's state after
        // the first sync push from a control.
        db.replaceReplicatedScanPolicies([
            {
                id: 0,
                name: 'mirrored-block',
                node_id: null,
                node_identity: '',
                stack_pattern: '*',
                max_severity: 'HIGH',
                block_on_deploy: 1, block_on_severity: 1, block_on_kev: 0, block_on_fixable: 0,
                enabled: 1,
                replicated_from_control: 1,
                created_at: Date.now(),
                updated_at: Date.now(),
            },
        ]);
        const firstSet = db.getScanPolicies().filter((p) => p.replicated_from_control === 1);
        expect(firstSet).toHaveLength(1);
        const firstId = firstSet[0].id;

        const scanId = seedScan(firstId, 'sha256:replica-staleness');
        expect(db.getVulnerabilityScan(scanId)?.policy_evaluation).not.toBeNull();

        // Second sync replaces the set; the new row has a different id.
        db.replaceReplicatedScanPolicies([
            {
                id: 0,
                name: 'mirrored-block',
                node_id: null,
                node_identity: '',
                stack_pattern: '*',
                max_severity: 'CRITICAL',
                block_on_deploy: 1, block_on_severity: 1, block_on_kev: 0, block_on_fixable: 0,
                enabled: 1,
                replicated_from_control: 1,
                created_at: Date.now(),
                updated_at: Date.now(),
            },
        ]);
        const secondSet = db.getScanPolicies().filter((p) => p.replicated_from_control === 1);
        expect(secondSet[0].id).not.toBe(firstId);

        // Stale policy_evaluation pointing at the old id must have been
        // cleared inside the same transaction as the swap.
        expect(db.getVulnerabilityScan(scanId)?.policy_evaluation).toBeNull();
    });

    it('preserves policy_evaluation that still references a present policy', () => {
        const db = DatabaseService.getInstance();
        // Local-only (non-replicated) policy that survives across replication
        // swaps. Its id stays valid and its policy_evaluation cache must NOT
        // be cleared.
        const local = db.createScanPolicy({
            name: 'local-survivor',
            node_id: null,
            node_identity: '',
            stack_pattern: '*',
            max_severity: 'CRITICAL',
            block_on_deploy: 1, block_on_severity: 1, block_on_kev: 0, block_on_fixable: 0,
            enabled: 1,
            replicated_from_control: 0,
        });
        const scanId = seedScan(local.id, 'sha256:local-survivor');
        expect(db.getVulnerabilityScan(scanId)?.policy_evaluation).not.toBeNull();

        db.replaceReplicatedScanPolicies([
            {
                id: 0,
                name: 'mirrored-other',
                node_id: null,
                node_identity: '',
                stack_pattern: '*',
                max_severity: 'HIGH',
                block_on_deploy: 0, block_on_severity: 1, block_on_kev: 0, block_on_fixable: 0,
                enabled: 1,
                replicated_from_control: 1,
                created_at: Date.now(),
                updated_at: Date.now(),
            },
        ]);

        expect(db.getVulnerabilityScan(scanId)?.policy_evaluation).not.toBeNull();
        db.deleteScanPolicy(local.id);
    });
});
