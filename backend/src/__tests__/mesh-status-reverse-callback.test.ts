/**
 * `MeshService.getStatus().reverseCallbackStatus` discriminator.
 *
 * Surfaces the per-node state of the peer→central reverse path: forward
 * bridge open (`connected`), dial in flight (`connecting`), no bridge and
 * not dialing (`unavailable`), or non-proxy node (`not_applicable`). The
 * Routing tab consumes this to render a transient pill while central
 * reconciles a dropped bridge.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { MeshService } from '../services/MeshService';
import { MeshProxyTunnelDialer } from '../services/MeshProxyTunnelDialer';
import { DatabaseService } from '../services/DatabaseService';

let tmpDir: string;
beforeAll(async () => { tmpDir = await setupTestDb(); });
afterAll(() => cleanupTestDb(tmpDir));

function uniqueSuffix(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function seedProxyNode(meshEnabled: boolean): number {
    const db = DatabaseService.getInstance();
    const id = db.addNode({
        name: `peer-status-${uniqueSuffix()}`,
        type: 'remote',
        mode: 'proxy',
        api_url: `https://peer-${uniqueSuffix()}.example.com`,
        api_token: `tok-${uniqueSuffix()}`,
        compose_dir: '/tmp',
        is_default: false,
    });
    if (meshEnabled) db.setNodeMeshEnabled(id, true);
    return id;
}

function seedPilotNode(): number {
    const db = DatabaseService.getInstance();
    return db.addNode({
        name: `pilot-${uniqueSuffix()}`,
        type: 'remote',
        mode: 'pilot_agent',
        api_url: `https://pilot-${uniqueSuffix()}.example.com`,
        api_token: `tok-${uniqueSuffix()}`,
        compose_dir: '/tmp',
        is_default: false,
    });
}

beforeEach(() => {
    DatabaseService.getInstance().getDb().prepare('DELETE FROM nodes WHERE is_default = 0').run();
    MeshProxyTunnelDialer.resetForTest();
    vi.restoreAllMocks();
});

describe('MeshService.getStatus reverseCallbackStatus', () => {
    it('returns connected when the dialer has a bridge for a mesh-enabled proxy peer', async () => {
        const id = seedProxyNode(true);
        vi.spyOn(MeshProxyTunnelDialer.getInstance(), 'hasBridge')
            .mockImplementation((n: number) => n === id);

        const statuses = await MeshService.getInstance().getStatus();
        const entry = statuses.find((s) => s.nodeId === id);
        expect(entry?.reverseCallbackStatus).toBe('connected');
    });

    it('returns connecting when a dial is in flight for the peer', async () => {
        const id = seedProxyNode(true);
        vi.spyOn(MeshProxyTunnelDialer.getInstance(), 'hasBridge').mockReturnValue(false);
        vi.spyOn(MeshProxyTunnelDialer.getInstance(), 'isDialing')
            .mockImplementation((n: number) => n === id);

        const statuses = await MeshService.getInstance().getStatus();
        const entry = statuses.find((s) => s.nodeId === id);
        expect(entry?.reverseCallbackStatus).toBe('connecting');
    });

    it('returns unavailable when no bridge and no dial in flight', async () => {
        const id = seedProxyNode(true);
        vi.spyOn(MeshProxyTunnelDialer.getInstance(), 'hasBridge').mockReturnValue(false);
        vi.spyOn(MeshProxyTunnelDialer.getInstance(), 'isDialing').mockReturnValue(false);

        const statuses = await MeshService.getInstance().getStatus();
        const entry = statuses.find((s) => s.nodeId === id);
        expect(entry?.reverseCallbackStatus).toBe('unavailable');
    });

    it('returns not_applicable for the local node', async () => {
        const statuses = await MeshService.getInstance().getStatus();
        const local = statuses.find((s) => s.nodeName === 'Local' || s.nodeId === 1);
        expect(local?.reverseCallbackStatus).toBe('not_applicable');
    });

    it('returns not_applicable for pilot-mode peers', async () => {
        const id = seedPilotNode();
        const statuses = await MeshService.getInstance().getStatus();
        const entry = statuses.find((s) => s.nodeId === id);
        expect(entry?.reverseCallbackStatus).toBe('not_applicable');
    });

    it('returns not_applicable for mesh-disabled proxy peers', async () => {
        const id = seedProxyNode(false);
        const statuses = await MeshService.getInstance().getStatus();
        const entry = statuses.find((s) => s.nodeId === id);
        expect(entry?.reverseCallbackStatus).toBe('not_applicable');
    });
});
