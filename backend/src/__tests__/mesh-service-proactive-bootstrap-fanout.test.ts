/**
 * `MeshService.proactiveBootstrapFanout` (Trigger 3).
 *
 * At central startup, after `MeshService.start()` finishes, iterate the
 * mesh-enabled proxy-mode nodes that have at least one `mesh_stacks` row
 * and call `MeshProxyTunnelDialer.ensureBridge(nodeId)` on each. This
 * proactively re-establishes the central->peer bridges so the
 * capability-gated handshake can mint and ship bootstrap material to any
 * peer that just came online or just got upgraded to v0.79+.
 *
 * Concurrency 4, 250ms stagger, fire-and-forget. Failures do not abort
 * the fan-out.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { MeshService } from '../services/MeshService';
import { MeshProxyTunnelDialer } from '../services/MeshProxyTunnelDialer';
import { DatabaseService } from '../services/DatabaseService';

let tmpDir: string;

beforeAll(async () => {
    tmpDir = await setupTestDb();
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

function uniqueSuffix(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function seedProxyNode(meshEnabled: boolean): number {
    const db = DatabaseService.getInstance();
    const id = db.addNode({
        name: `peer-fanout-${uniqueSuffix()}`,
        type: 'remote',
        mode: 'proxy',
        api_url: `https://peer-${uniqueSuffix()}.example.com`,
        api_token: `tok-${uniqueSuffix()}`,
        compose_dir: '/tmp',
        is_default: false,
    });
    if (meshEnabled) {
        db.setNodeMeshEnabled(id, true);
    }
    return id;
}

function insertMeshStack(nodeId: number, stackName: string): void {
    const db = DatabaseService.getInstance();
    db.getDb().prepare(
        'INSERT INTO mesh_stacks (node_id, stack_name, created_at, created_by) VALUES (?, ?, ?, ?)',
    ).run(nodeId, stackName, Date.now(), 'test');
}

function clearNodesAndMeshStacks(): void {
    const db = DatabaseService.getInstance().getDb();
    db.prepare('DELETE FROM mesh_stacks').run();
    db.prepare('DELETE FROM nodes WHERE is_default = 0').run();
}

describe('MeshService.proactiveBootstrapFanout (Trigger 3)', () => {
    beforeEach(() => {
        clearNodesAndMeshStacks();
        MeshProxyTunnelDialer.resetForTest();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('iterates only mesh-enabled proxy-mode nodes that have mesh_stacks rows', async () => {
        const calls: number[] = [];
        vi.spyOn(MeshProxyTunnelDialer.getInstance(), 'ensureBridge')
            .mockImplementation(async (id: number) => {
                calls.push(id);
                return null;
            });

        // Eligible: mesh-enabled proxy node with a mesh_stacks row.
        const eligible = seedProxyNode(true);
        insertMeshStack(eligible, `stack-eligible-${uniqueSuffix()}`);

        // Ineligible: mesh-enabled proxy node WITHOUT a mesh_stacks row.
        seedProxyNode(true);

        // Ineligible: mesh-disabled proxy node WITH a mesh_stacks row.
        const meshOff = seedProxyNode(false);
        insertMeshStack(meshOff, `stack-meshoff-${uniqueSuffix()}`);

        await (MeshService.getInstance() as unknown as {
            proactiveBootstrapFanout: () => Promise<void>;
        }).proactiveBootstrapFanout();

        expect(calls).toEqual([eligible]);
    });

    it('throttles to concurrency 4', async () => {
        let inflight = 0;
        let maxInflight = 0;
        vi.spyOn(MeshProxyTunnelDialer.getInstance(), 'ensureBridge')
            .mockImplementation(async () => {
                inflight++;
                if (inflight > maxInflight) maxInflight = inflight;
                await new Promise((r) => setTimeout(r, 10));
                inflight--;
                return null;
            });

        for (let i = 0; i < 12; i++) {
            const id = seedProxyNode(true);
            insertMeshStack(id, `stack-${i}-${uniqueSuffix()}`);
        }

        await (MeshService.getInstance() as unknown as {
            proactiveBootstrapFanout: () => Promise<void>;
        }).proactiveBootstrapFanout();

        expect(maxInflight).toBeLessThanOrEqual(4);
        expect(maxInflight).toBeGreaterThan(0);
    });

    it('failures do not abort the fanout', async () => {
        const ids: number[] = [];
        for (let i = 0; i < 3; i++) {
            const id = seedProxyNode(true);
            insertMeshStack(id, `stack-fail-${i}-${uniqueSuffix()}`);
            ids.push(id);
        }
        const failingId = ids[1];

        const calls: number[] = [];
        vi.spyOn(MeshProxyTunnelDialer.getInstance(), 'ensureBridge')
            .mockImplementation(async (id: number) => {
                calls.push(id);
                if (id === failingId) throw new Error('boom');
                return null;
            });

        await (MeshService.getInstance() as unknown as {
            proactiveBootstrapFanout: () => Promise<void>;
        }).proactiveBootstrapFanout();

        expect(calls.slice().sort((a, b) => a - b)).toEqual(ids.slice().sort((a, b) => a - b));
    });
});
