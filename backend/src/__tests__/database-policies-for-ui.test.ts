/**
 * Pins the replica-side filtering of `getScanPoliciesForUi`.
 *
 * On a replica the security-settings panel must only render policies that
 * apply to that replica. Replicated rows with a node_identity targeting a
 * sibling replica are filtered out so an operator cannot enumerate other
 * replicas' identity-scoped rules.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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

beforeEach(() => {
    const db = DatabaseService.getInstance();
    // Wipe all replicated and local rows between tests so each scenario starts clean.
    db.clearReplicatedRows();
    for (const p of db.getScanPolicies()) {
        db.deleteScanPolicy(p.id);
    }
});

function seedFleetWideReplicated(name: string): void {
    DatabaseService.getInstance().replaceReplicatedScanPolicies([
        {
            id: 0,
            name,
            node_id: null,
            node_identity: '',
            stack_pattern: '*',
            max_severity: 'HIGH',
            block_on_deploy: 0,
            enabled: 1,
            replicated_from_control: 1,
            created_at: Date.now(),
            updated_at: Date.now(),
        },
    ]);
}

function seedReplicaScopedReplicated(name: string, nodeIdentity: string): void {
    const db = DatabaseService.getInstance();
    // Append-style: read existing replicated rows + the new scoped one.
    const existing = db.getScanPolicies().filter((p) => p.replicated_from_control === 1);
    db.replaceReplicatedScanPolicies([
        ...existing,
        {
            id: 0,
            name,
            node_id: null,
            node_identity: nodeIdentity,
            stack_pattern: '*',
            max_severity: 'CRITICAL',
            block_on_deploy: 0,
            enabled: 1,
            replicated_from_control: 1,
            created_at: Date.now(),
            updated_at: Date.now(),
        },
    ]);
}

describe('getScanPoliciesForUi', () => {
    it('returns the full set on a control instance', () => {
        const db = DatabaseService.getInstance();
        seedFleetWideReplicated('fleet-wide');
        seedReplicaScopedReplicated('targets-other', 'https://other.example');
        const result = db.getScanPoliciesForUi('control', 'local');
        expect(result.map((p) => p.name).sort()).toEqual(['fleet-wide', 'targets-other']);
    });

    it('hides identity-scoped replicated rows that target a different replica', () => {
        const db = DatabaseService.getInstance();
        seedFleetWideReplicated('fleet-wide');
        seedReplicaScopedReplicated('targets-other', 'https://other.example');
        seedReplicaScopedReplicated('targets-self', 'https://me.example');
        const result = db.getScanPoliciesForUi('replica', 'https://me.example');
        const names = result.map((p) => p.name).sort();
        expect(names).toEqual(['fleet-wide', 'targets-self']);
    });

    it('always includes locally created rows on a replica', () => {
        const db = DatabaseService.getInstance();
        seedReplicaScopedReplicated('targets-other', 'https://other.example');
        db.createScanPolicy({
            name: 'local-on-replica',
            node_id: null,
            node_identity: '',
            stack_pattern: null,
            max_severity: 'CRITICAL',
            block_on_deploy: 0,
            enabled: 1,
            replicated_from_control: 0,
        });
        const result = db.getScanPoliciesForUi('replica', 'https://me.example');
        const names = result.map((p) => p.name).sort();
        expect(names).toContain('local-on-replica');
        expect(names).not.toContain('targets-other');
    });
});
