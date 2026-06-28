/**
 * Pins the matching and ordering behavior of `DatabaseService.getMatchingPolicy`.
 *
 * The matcher must be deterministic across replicas: two policies in the same
 * scope class (e.g. both fleet-wide stack-wildcard) need to resolve to the same
 * winner regardless of SQLite row-iteration order. The chosen tiebreaker is
 * lowest id wins, so the oldest-defined policy stays authoritative.
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

describe('getMatchingPolicy tiebreaker', () => {
    it('returns the lowest-id row when two policies tie on scope class', () => {
        const db = DatabaseService.getInstance();
        const first = db.createScanPolicy({
            name: 'first-fleet-wide',
            node_id: null,
            node_identity: '',
            stack_pattern: null,
            max_severity: 'HIGH',
            block_on_deploy: 0, block_on_severity: 1, block_on_kev: 0, block_on_fixable: 0,
            enabled: 1,
            replicated_from_control: 0,
        });
        const second = db.createScanPolicy({
            name: 'second-fleet-wide',
            node_id: null,
            node_identity: '',
            stack_pattern: null,
            max_severity: 'CRITICAL',
            block_on_deploy: 0, block_on_severity: 1, block_on_kev: 0, block_on_fixable: 0,
            enabled: 1,
            replicated_from_control: 0,
        });
        const winner = db.getMatchingPolicy(1, 'web', 'local');
        expect(winner?.id).toBe(first.id);
        // Sanity: with first deleted, the next-lowest takes over.
        db.deleteScanPolicy(first.id);
        const next = db.getMatchingPolicy(1, 'web', 'local');
        expect(next?.id).toBe(second.id);
    });

    it('prefers node-scoped over fleet-wide regardless of id order', () => {
        const db = DatabaseService.getInstance();
        const fleetWide = db.createScanPolicy({
            name: 'tie-fleet',
            node_id: null,
            node_identity: '',
            stack_pattern: null,
            max_severity: 'LOW',
            block_on_deploy: 0, block_on_severity: 1, block_on_kev: 0, block_on_fixable: 0,
            enabled: 1,
            replicated_from_control: 0,
        });
        const nodeScoped = db.createScanPolicy({
            name: 'tie-node',
            node_id: 1,
            node_identity: 'local',
            stack_pattern: null,
            max_severity: 'CRITICAL',
            block_on_deploy: 0, block_on_severity: 1, block_on_kev: 0, block_on_fixable: 0,
            enabled: 1,
            replicated_from_control: 0,
        });
        const winner = db.getMatchingPolicy(1, 'web', 'local');
        // Node-scoped wins by class, even though its id is higher than the fleet-wide row.
        expect(winner?.id).toBe(nodeScoped.id);
        db.deleteScanPolicy(fleetWide.id);
        db.deleteScanPolicy(nodeScoped.id);
    });

    it('respects identity matching for replicated rows', () => {
        const db = DatabaseService.getInstance();
        const otherIdentity = db.createScanPolicy({
            name: 'replicated-other',
            node_id: null,
            node_identity: 'https://other.example',
            stack_pattern: null,
            max_severity: 'CRITICAL',
            block_on_deploy: 0, block_on_severity: 1, block_on_kev: 0, block_on_fixable: 0,
            enabled: 1,
            replicated_from_control: 1,
        });
        const ourIdentity = db.createScanPolicy({
            name: 'replicated-self',
            node_id: null,
            node_identity: 'https://me.example',
            stack_pattern: null,
            max_severity: 'HIGH',
            block_on_deploy: 0, block_on_severity: 1, block_on_kev: 0, block_on_fixable: 0,
            enabled: 1,
            replicated_from_control: 1,
        });
        const winner = db.getMatchingPolicy(1, 'web', 'https://me.example');
        expect(winner?.id).toBe(ourIdentity.id);
        db.deleteScanPolicy(otherIdentity.id);
        db.deleteScanPolicy(ourIdentity.id);
    });
});
