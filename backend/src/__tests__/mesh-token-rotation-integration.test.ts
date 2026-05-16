/**
 * Triggers 1 + 2: proactive mesh bridge bootstrap on mesh-enable and on
 * api_token rotation.
 *
 * Trigger 1 (mesh-enable): after `setNodeMeshEnabled(true)`, the service
 * fire-and-forgets `MeshProxyTunnelDialer.ensureBridge(nodeId)` for any
 * remote/proxy peer. The capability-gated handshake then ships
 * `mesh_handshake` material to peers that just came online or just got
 * upgraded to a build that advertises `mesh_proxy_callback_bootstrap`.
 *
 * Trigger 2 (api_token rotation): when the nodes router persists a new
 * `api_token` for a mesh-enabled proxy peer, it closes the existing bridge
 * with reason 'peer token rotated' and re-dials. The next ensureBridge mints
 * a JWT whose fingerprint matches the freshly stored token; without this
 * trigger the remote would reject the upgrade with token_fingerprint_mismatch
 * until the next idle re-dial.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { MeshService } from '../services/MeshService';
import { MeshProxyTunnelDialer } from '../services/MeshProxyTunnelDialer';
import { DatabaseService } from '../services/DatabaseService';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ app } = await import('../index'));
    const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });
    authHeader = `Bearer ${token}`;
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
        name: `peer-rotate-${uniqueSuffix()}`,
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

function clearTestNodes(): void {
    const db = DatabaseService.getInstance().getDb();
    db.prepare('DELETE FROM mesh_stacks').run();
    db.prepare('DELETE FROM nodes WHERE is_default = 0').run();
}

describe('Trigger 1: enableForNode triggers proactive bridge bootstrap', () => {
    beforeEach(() => {
        clearTestNodes();
        MeshProxyTunnelDialer.resetForTest();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('calls ensureBridge for a remote proxy-mode node', async () => {
        const ensureSpy = vi.spyOn(MeshProxyTunnelDialer.getInstance(), 'ensureBridge')
            .mockResolvedValue(null);
        const nodeId = seedProxyNode(false);

        await MeshService.getInstance().enableForNode(nodeId);

        // Trigger is fire-and-forget; wait a microtask for the void promise.
        await new Promise((r) => setImmediate(r));
        expect(ensureSpy).toHaveBeenCalledWith(nodeId);
    });

    it('skips local nodes', async () => {
        const ensureSpy = vi.spyOn(MeshProxyTunnelDialer.getInstance(), 'ensureBridge')
            .mockResolvedValue(null);
        const localId = DatabaseService.getInstance().getNodes()[0].id;

        await MeshService.getInstance().enableForNode(localId);

        await new Promise((r) => setImmediate(r));
        expect(ensureSpy).not.toHaveBeenCalled();
    });

    it('swallows ensureBridge rejections without throwing', async () => {
        vi.spyOn(MeshProxyTunnelDialer.getInstance(), 'ensureBridge')
            .mockRejectedValue(new Error('peer unreachable'));
        const nodeId = seedProxyNode(false);

        await expect(MeshService.getInstance().enableForNode(nodeId)).resolves.toBeUndefined();
        await new Promise((r) => setImmediate(r));
    });
});

describe('Trigger 2: api_token rotation forces re-bootstrap', () => {
    beforeEach(() => {
        clearTestNodes();
        MeshProxyTunnelDialer.resetForTest();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('calls closeBridge then ensureBridge when rotation handler runs', async () => {
        const closeSpy = vi.spyOn(MeshProxyTunnelDialer.getInstance(), 'closeBridge');
        const ensureSpy = vi.spyOn(MeshProxyTunnelDialer.getInstance(), 'ensureBridge')
            .mockResolvedValue(null);
        const nodeId = seedProxyNode(true);

        const res = await request(app)
            .put(`/api/nodes/${nodeId}`)
            .set('Authorization', authHeader)
            .send({ api_token: 'rotated-token-abc' });

        expect(res.status).toBe(200);
        await new Promise((r) => setImmediate(r));

        expect(closeSpy).toHaveBeenCalledWith(nodeId, 'peer token rotated');
        expect(ensureSpy).toHaveBeenCalledWith(nodeId);
        const closeOrder = closeSpy.mock.invocationCallOrder[0];
        const ensureOrder = ensureSpy.mock.invocationCallOrder[0];
        expect(closeOrder).toBeLessThan(ensureOrder);
    });

    it('does not fire when api_token is not in the update payload', async () => {
        const closeSpy = vi.spyOn(MeshProxyTunnelDialer.getInstance(), 'closeBridge');
        const ensureSpy = vi.spyOn(MeshProxyTunnelDialer.getInstance(), 'ensureBridge')
            .mockResolvedValue(null);
        const nodeId = seedProxyNode(true);

        const res = await request(app)
            .put(`/api/nodes/${nodeId}`)
            .set('Authorization', authHeader)
            .send({ name: `renamed-${uniqueSuffix()}` });

        expect(res.status).toBe(200);
        await new Promise((r) => setImmediate(r));

        expect(closeSpy).not.toHaveBeenCalled();
        expect(ensureSpy).not.toHaveBeenCalled();
    });

    it('does not fire when mesh is disabled on the node', async () => {
        const closeSpy = vi.spyOn(MeshProxyTunnelDialer.getInstance(), 'closeBridge');
        const ensureSpy = vi.spyOn(MeshProxyTunnelDialer.getInstance(), 'ensureBridge')
            .mockResolvedValue(null);
        const nodeId = seedProxyNode(false);

        const res = await request(app)
            .put(`/api/nodes/${nodeId}`)
            .set('Authorization', authHeader)
            .send({ api_token: 'rotated-token-xyz' });

        expect(res.status).toBe(200);
        await new Promise((r) => setImmediate(r));

        expect(closeSpy).not.toHaveBeenCalled();
        expect(ensureSpy).not.toHaveBeenCalled();
    });
});
