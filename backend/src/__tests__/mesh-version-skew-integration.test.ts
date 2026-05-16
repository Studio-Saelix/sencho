/**
 * Version skew invariant: central must NOT send a `mesh_handshake` to a peer
 * that lacks the `mesh_proxy_callback_bootstrap` capability.
 *
 * The capability gate keeps central rolling forward without breaking older
 * peers: a peer that does not understand the bootstrap frame would otherwise
 * see a stray JSON text frame before the TCP frames it expects. The dialer's
 * `maybeSendBootstrap` must read the capability list from the remote's meta
 * endpoint and silently skip the send when the bit is absent.
 *
 * This is complementary to `mesh-proxy-tunnel-dialer-handshake.test.ts`,
 * which exercises the same code path with a finer-grained set of inputs;
 * this file locks in the same invariant as an integration so a future
 * refactor that moves the capability check to a different layer does not
 * silently regress.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { NodeRegistry } from '../services/NodeRegistry';
import { MeshProxyTunnelDialer } from '../services/MeshProxyTunnelDialer';
import { OFFLINE_META } from '../services/CapabilityRegistry';
import { MeshCentralRegistry } from '../services/MeshCentralRegistry';
import { DatabaseService } from '../services/DatabaseService';

describe('Version skew: peer without mesh_proxy_callback_bootstrap', () => {
    let tmpDir: string;
    beforeEach(async () => {
        tmpDir = await setupTestDb();
        MeshProxyTunnelDialer.resetForTest();
        MeshCentralRegistry.resetForTest();
        process.env.SENCHO_PRIMARY_URL = 'https://central.example.com';
        DatabaseService.getInstance().setSystemState('instance_id', 'test-central-instance');
    });
    afterEach(() => {
        cleanupTestDb(tmpDir);
        delete process.env.SENCHO_PRIMARY_URL;
        vi.restoreAllMocks();
    });

    type DialerPrivate = {
        maybeSendBootstrap: (nodeId: number, ws: unknown) => Promise<void>;
    };

    it('central does not send mesh_handshake when capability is absent', async () => {
        vi.spyOn(NodeRegistry.getInstance(), 'fetchMetaForNode').mockResolvedValue({
            ...OFFLINE_META,
            version: '0.78.0',
            capabilities: ['stacks'],
            online: true,
            startedAt: Date.now(),
        });

        // Seed a proxy node so maybeSendBootstrap has something to look up.
        const db = DatabaseService.getInstance();
        const id = db.addNode({
            name: `n-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            type: 'remote',
            mode: 'proxy',
            api_url: 'https://n',
            api_token: 't',
            compose_dir: '/tmp',
            is_default: false,
        });
        db.setNodeMeshEnabled(id, true);

        const sentFrames: unknown[] = [];
        const fakeWs = { send: vi.fn((data: string) => sentFrames.push(JSON.parse(data))) };

        await (MeshProxyTunnelDialer.getInstance() as unknown as DialerPrivate)
            .maybeSendBootstrap(id, fakeWs);

        expect(fakeWs.send).not.toHaveBeenCalled();
        expect(sentFrames).toHaveLength(0);
        // No persistence as a side effect either.
        expect(MeshCentralRegistry.getInstance().getActive()).toBeNull();
    });

    it('central does send mesh_handshake when the capability flips to advertised', async () => {
        // Sanity: the same code path with the capability present must take
        // the affirmative branch, so we know the skip above is gated on the
        // capability and not on some unrelated precondition.
        vi.spyOn(NodeRegistry.getInstance(), 'fetchMetaForNode').mockResolvedValue({
            ...OFFLINE_META,
            version: '0.79.0',
            capabilities: ['stacks', 'mesh_proxy_callback_bootstrap'],
            online: true,
            startedAt: Date.now(),
        });
        const db = DatabaseService.getInstance();
        const id = db.addNode({
            name: `n-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            type: 'remote',
            mode: 'proxy',
            api_url: 'https://n',
            api_token: 't',
            compose_dir: '/tmp',
            is_default: false,
        });
        db.setNodeMeshEnabled(id, true);

        const sentFrames: unknown[] = [];
        const fakeWs = { send: vi.fn((data: string) => sentFrames.push(JSON.parse(data))) };
        await (MeshProxyTunnelDialer.getInstance() as unknown as DialerPrivate)
            .maybeSendBootstrap(id, fakeWs);
        expect(fakeWs.send).toHaveBeenCalledOnce();
        expect(sentFrames[0]).toMatchObject({ t: 'mesh_handshake', v: 1 });
    });
});
