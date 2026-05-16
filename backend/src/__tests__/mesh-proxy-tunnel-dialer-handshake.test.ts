/**
 * `MeshProxyTunnelDialer.maybeSendBootstrap`: capability-gated
 * `mesh_handshake` send.
 *
 * Central mints a signed `mesh_tunnel`-scoped JWT bound to the peer's
 * `api_token` fingerprint and pushes it as the first text frame on the
 * fresh WS, but only when the peer advertises the
 * `mesh_proxy_callback_bootstrap` capability AND a canonical central
 * origin (`SENCHO_PRIMARY_URL`) is configured. All other paths must
 * remain silent (no frame) so the legacy peer-side first-frame state
 * machine can fall straight through to TCP traffic.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { MeshProxyTunnelDialer } from '../services/MeshProxyTunnelDialer';
import { NodeRegistry } from '../services/NodeRegistry';
import { OFFLINE_META } from '../services/CapabilityRegistry';
import { DatabaseService } from '../services/DatabaseService';

let tmpDir: string;
const CENTRAL_INSTANCE_ID = 'central-instance-for-handshake-test';

beforeAll(async () => {
    tmpDir = await setupTestDb();
    // Seed system_state.instance_id (LicenseService.initialize() is not
    // invoked in the test harness; mesh handshake requires this value).
    DatabaseService.getInstance().setSystemState('instance_id', CENTRAL_INSTANCE_ID);
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

describe('MeshProxyTunnelDialer capability-gated handshake', () => {
    let nodeSeq = 0;

    beforeEach(() => {
        MeshProxyTunnelDialer.resetForTest();
        process.env.SENCHO_PRIMARY_URL = 'https://central.example.com';
        nodeSeq += 1;
    });

    afterEach(() => {
        delete process.env.SENCHO_PRIMARY_URL;
        vi.restoreAllMocks();
    });

    function fakeWs(): { send: ReturnType<typeof vi.fn>; sentFrames: unknown[] } {
        const sentFrames: unknown[] = [];
        return {
            send: vi.fn((data: string) => { sentFrames.push(JSON.parse(data)); }),
            sentFrames,
        };
    }

    function seedProxyNode(): number {
        const db = DatabaseService.getInstance();
        const id = db.addNode({
            name: `peer-handshake-${nodeSeq}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            type: 'remote',
            mode: 'proxy',
            api_url: 'https://peer.example.com',
            api_token: 'peer-token-for-fp',
            compose_dir: '/tmp',
            is_default: false,
        });
        db.setNodeMeshEnabled(id, true);
        return id;
    }

    type DialerPrivate = { maybeSendBootstrap: (nodeId: number, ws: unknown) => Promise<void> };

    it('sends mesh_handshake when peer advertises mesh_proxy_callback_bootstrap', async () => {
        vi.spyOn(NodeRegistry.getInstance(), 'fetchMetaForNode').mockResolvedValue({
            ...OFFLINE_META,
            version: '0.79.0',
            capabilities: ['stacks', 'mesh_proxy_callback_bootstrap'],
            online: true,
            startedAt: Date.now(),
        });
        const id = seedProxyNode();
        const ws = fakeWs();
        await (MeshProxyTunnelDialer.getInstance() as unknown as DialerPrivate).maybeSendBootstrap(id, ws);
        expect(ws.send).toHaveBeenCalledOnce();
        expect(ws.sentFrames[0]).toMatchObject({ t: 'mesh_handshake', v: 1 });
    });

    it('skips mesh_handshake when peer lacks the capability', async () => {
        vi.spyOn(NodeRegistry.getInstance(), 'fetchMetaForNode').mockResolvedValue({
            ...OFFLINE_META,
            version: '0.78.0',
            capabilities: ['stacks'],
            online: true,
            startedAt: Date.now(),
        });
        const id = seedProxyNode();
        const ws = fakeWs();
        await (MeshProxyTunnelDialer.getInstance() as unknown as DialerPrivate).maybeSendBootstrap(id, ws);
        expect(ws.send).not.toHaveBeenCalled();
    });

    it('skips mesh_handshake when meta fetch returns offline shape', async () => {
        vi.spyOn(NodeRegistry.getInstance(), 'fetchMetaForNode').mockResolvedValue({
            ...OFFLINE_META,
            online: false,
        });
        const id = seedProxyNode();
        const ws = fakeWs();
        await (MeshProxyTunnelDialer.getInstance() as unknown as DialerPrivate).maybeSendBootstrap(id, ws);
        expect(ws.send).not.toHaveBeenCalled();
    });

    it('skips mesh_handshake when SENCHO_PRIMARY_URL is unset (fail-safe)', async () => {
        delete process.env.SENCHO_PRIMARY_URL;
        vi.spyOn(NodeRegistry.getInstance(), 'fetchMetaForNode').mockResolvedValue({
            ...OFFLINE_META,
            version: '0.79.0',
            capabilities: ['mesh_proxy_callback_bootstrap'],
            online: true,
            startedAt: Date.now(),
        });
        const id = seedProxyNode();
        const ws = fakeWs();
        await (MeshProxyTunnelDialer.getInstance() as unknown as DialerPrivate).maybeSendBootstrap(id, ws);
        expect(ws.send).not.toHaveBeenCalled();
    });

    it('signs the JWT with auth_jwt_secret using HS256 and includes the required claims', async () => {
        vi.spyOn(NodeRegistry.getInstance(), 'fetchMetaForNode').mockResolvedValue({
            ...OFFLINE_META,
            version: '0.79.0',
            capabilities: ['mesh_proxy_callback_bootstrap'],
            online: true,
            startedAt: Date.now(),
        });
        const id = seedProxyNode();
        const ws = fakeWs();
        await (MeshProxyTunnelDialer.getInstance() as unknown as DialerPrivate).maybeSendBootstrap(id, ws);
        const frame = ws.sentFrames[0] as {
            meshTunnelJwt: string;
            centralApiUrl: string;
            centralInstanceId: string;
            peerNodeId: number;
            jwtExpiresAt: number;
        };
        expect(frame.centralApiUrl).toBe('https://central.example.com');
        expect(frame.centralInstanceId).toBe(CENTRAL_INSTANCE_ID);
        expect(frame.peerNodeId).toBe(id);
        expect(typeof frame.jwtExpiresAt).toBe('number');
        const decoded = jwt.decode(frame.meshTunnelJwt, { complete: true });
        expect(decoded?.header.alg).toBe('HS256');
        const payload = decoded?.payload as Record<string, unknown>;
        expect(payload).toMatchObject({
            sub: String(id),
            iss: CENTRAL_INSTANCE_ID,
            aud: 'https://central.example.com',
            scope: 'mesh_tunnel',
            kid: 'v1',
        });
        expect(typeof payload.peer_token_fp).toBe('string');
        expect((payload.peer_token_fp as string).length).toBe(16);
    });
});
