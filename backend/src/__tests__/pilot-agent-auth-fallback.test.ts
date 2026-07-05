/**
 * Regression tests for pilot agent auth fallback when a persisted tunnel
 * token is rejected at WebSocket upgrade (401 invalid JWT, 404 unknown node).
 *
 * Without fallback the agent reconnects forever with the same stale
 * pilot.jwt credential even when SENCHO_ENROLL_TOKEN carries a fresh
 * enrollment JWT.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'http';
import jwt from 'jsonwebtoken';
import { WebSocketServer } from 'ws';
import { setupTestDb, cleanupTestDb, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { attachUpgrade } from '../websocket/upgradeHandler';
import { PilotTunnelManager } from '../services/PilotTunnelManager';
import { WebSocket } from 'ws';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

// agent.ts freezes its pilot.jwt path from DATA_DIR at module load, so it must
// be imported only after setupTestDb() points DATA_DIR at the writable tmp dir.
let readPersistedToken: typeof import('../pilot/agent').readPersistedToken;
let persistToken: typeof import('../pilot/agent').persistToken;
let clearPersistedToken: typeof import('../pilot/agent').clearPersistedToken;

let server: http.Server;
let port: number;
let pilotTunnelWss: WebSocketServer;
let mainWss: WebSocketServer;
let nodeId: number;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ readPersistedToken, persistToken, clearPersistedToken } = await import('../pilot/agent'));

    server = http.createServer();
    mainWss = new WebSocketServer({ noServer: true });
    pilotTunnelWss = new WebSocketServer({ noServer: true });
    attachUpgrade(server, { wss: mainWss, pilotTunnelWss });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (!addr || typeof addr === 'string') {
                reject(new Error('listen returned unexpected address'));
                return;
            }
            port = addr.port;
            resolve();
        });
    });

    nodeId = DatabaseService.getInstance().addNode({
        name: `pilot-auth-fallback-${Date.now()}`,
        type: 'remote',
        mode: 'pilot_agent',
        compose_dir: '/tmp/x',
        is_default: false,
        api_url: '',
        api_token: '',
    });
});

afterAll(async () => {
    const mgr = PilotTunnelManager.getInstance();
    mgr.closeTunnel(nodeId);
    mgr.removeAllListeners('tunnel-up');
    mgr.removeAllListeners('tunnel-down');
    pilotTunnelWss.close();
    mainWss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    cleanupTestDb(tmpDir);
});

afterEach(() => {
    PilotTunnelManager.getInstance().closeTunnel(nodeId);
    clearPersistedToken();
});

function mintStaleTunnelTokenWrongSecret(): string {
    return jwt.sign(
        { scope: 'pilot_tunnel', nodeId },
        'wrong-secret-not-the-control-instance',
        { expiresIn: '365d' },
    );
}

function mintStaleTunnelTokenWrongNode(): string {
    return jwt.sign(
        { scope: 'pilot_tunnel', nodeId: 99_999_999 },
        TEST_JWT_SECRET,
        { expiresIn: '365d' },
    );
}

describe('clearPersistedToken', () => {
    it('removes an existing pilot.jwt file', () => {
        persistToken('stale-token');
        expect(readPersistedToken()).toBe('stale-token');
        clearPersistedToken();
        expect(readPersistedToken()).toBeNull();
    });

    it('does not throw when the file is already absent', () => {
        clearPersistedToken();
        expect(() => clearPersistedToken()).not.toThrow();
        expect(readPersistedToken()).toBeNull();
    });
});

describe('pilot tunnel upgrade rejection (in-process integration)', () => {
    it('rejects a stale tunnel JWT signed with the wrong secret at upgrade', async () => {
        const staleToken = mintStaleTunnelTokenWrongSecret();
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/pilot/tunnel`, {
            headers: {
                Authorization: `Bearer ${staleToken}`,
                'x-sencho-agent-version': 'auth-fallback-test/1.0',
            },
        });
        const result = await new Promise<{ status?: number }>((resolve) => {
            ws.on('unexpected-response', (_req, res) => {
                resolve({ status: res.statusCode });
                res.destroy();
            });
            ws.on('error', () => { /* close follows */ });
        });
        expect(result.status).toBe(401);
    });

    it('rejects a tunnel JWT for an unknown node with HTTP 404 at upgrade', async () => {
        const staleToken = mintStaleTunnelTokenWrongNode();
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/pilot/tunnel`, {
            headers: {
                Authorization: `Bearer ${staleToken}`,
                'x-sencho-agent-version': 'auth-fallback-test/1.0',
            },
        });
        const result = await new Promise<{ status?: number }>((resolve) => {
            ws.on('unexpected-response', (_req, res) => {
                resolve({ status: res.statusCode });
                res.destroy();
            });
            ws.on('error', () => { /* close follows */ });
        });
        expect(result.status).toBe(404);
    });
});
