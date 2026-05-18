/**
 * `MeshService.proactiveBridgeFanout` and the bridge-reconcile loop.
 *
 * Central proactively dials every mesh-enabled proxy-mode peer at startup
 * and on every reconcile tick so peer→central reverse traffic always has a
 * live forward WS to multiplex through. The fanout selects ALL such peers
 * regardless of whether they have any `mesh_stacks` rows yet, because the
 * bridge is a control-plane primitive, not stack-scoped.
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

function callFanout(): Promise<void> {
    return (MeshService.getInstance() as unknown as {
        proactiveBridgeFanout: () => Promise<void>;
    }).proactiveBridgeFanout();
}

describe('MeshService.proactiveBridgeFanout', () => {
    beforeEach(() => {
        clearNodesAndMeshStacks();
        MeshProxyTunnelDialer.resetForTest();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('iterates every mesh-enabled proxy-mode node regardless of mesh_stacks rows', async () => {
        const calls: number[] = [];
        vi.spyOn(MeshProxyTunnelDialer.getInstance(), 'ensureBridge')
            .mockImplementation(async (id: number) => {
                calls.push(id);
                return null;
            });

        const withStack = seedProxyNode(true);
        insertMeshStack(withStack, `stack-${uniqueSuffix()}`);

        // Mesh-enabled proxy node WITHOUT any mesh_stacks row. The old
        // SQL excluded these; this assertion locks in the new behavior.
        const withoutStack = seedProxyNode(true);

        // Mesh-disabled proxy node WITH a mesh_stacks row. Must still be skipped.
        const meshOff = seedProxyNode(false);
        insertMeshStack(meshOff, `stack-meshoff-${uniqueSuffix()}`);

        await callFanout();

        expect(calls.sort((a, b) => a - b)).toEqual([withStack, withoutStack].sort((a, b) => a - b));
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

        for (let i = 0; i < 12; i++) seedProxyNode(true);

        await callFanout();

        expect(maxInflight).toBeLessThanOrEqual(4);
        expect(maxInflight).toBeGreaterThan(0);
    });

    it('failures do not abort the fanout', async () => {
        const ids: number[] = [];
        for (let i = 0; i < 3; i++) ids.push(seedProxyNode(true));
        const failingId = ids[1];

        const calls: number[] = [];
        vi.spyOn(MeshProxyTunnelDialer.getInstance(), 'ensureBridge')
            .mockImplementation(async (id: number) => {
                calls.push(id);
                if (id === failingId) throw new Error('boom');
                return null;
            });

        await callFanout();

        expect(calls.slice().sort((a, b) => a - b)).toEqual(ids.slice().sort((a, b) => a - b));
    });

    it('repeated fanout calls invoke ensureBridge each tick (reconcile semantics)', async () => {
        const ensureSpy = vi.spyOn(MeshProxyTunnelDialer.getInstance(), 'ensureBridge')
            .mockResolvedValue(null);

        const id = seedProxyNode(true);
        await callFanout();
        await callFanout();

        expect(ensureSpy.mock.calls.filter(([n]) => n === id).length).toBe(2);
    });
});
