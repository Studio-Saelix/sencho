/**
 * Pins the fleet_sync_status cascade behavior of DatabaseService.deleteNode.
 *
 * Without this cleanup, deleting a node from Settings → Nodes leaves orphaned
 * sync-status rows behind that the UI then renders as ghost entries.
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

describe('deleteNode fleet_sync_status cascade', () => {
    it('removes fleet_sync_status rows for the deleted node', () => {
        const db = DatabaseService.getInstance();
        const nodeId = db.addNode({
            name: 'cascade-target',
            type: 'remote',
            compose_dir: '/app/compose',
            is_default: false,
            api_url: 'https://cascade.example',
            api_token: 'tok',
            mode: 'proxy',
        });

        // Sibling node so we can confirm its rows survive.
        const siblingId = db.addNode({
            name: 'cascade-sibling',
            type: 'remote',
            compose_dir: '/app/compose',
            is_default: false,
            api_url: 'https://sibling.example',
            api_token: 'tok',
            mode: 'proxy',
        });

        db.recordFleetSyncFailure(nodeId, 'scan_policies', 'timeout');
        db.recordFleetSyncFailure(nodeId, 'cve_suppressions', 'timeout');
        db.recordFleetSyncSuccess(siblingId, 'scan_policies');

        const before = db.getFleetSyncStatuses();
        expect(before.filter((s) => s.node_id === nodeId)).toHaveLength(2);
        expect(before.filter((s) => s.node_id === siblingId)).toHaveLength(1);

        db.deleteNode(nodeId);

        const after = db.getFleetSyncStatuses();
        expect(after.filter((s) => s.node_id === nodeId)).toHaveLength(0);
        expect(after.filter((s) => s.node_id === siblingId)).toHaveLength(1);
    });
});
