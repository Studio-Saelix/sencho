/**
 * Route-level coverage for the rejection paths inside handlePilotTunnel.
 *
 * The headline invariant is "a pilot_enroll JWT is one-shot at the upgrade
 * handler, not just at the DB layer". pilot-enrollment.test.ts already
 * verifies the DB layer. That is necessary but not sufficient: a future
 * refactor of handlePilotTunnel that re-orders mint and consume, or that
 * grants the WebSocket upgrade before checking the consume result, would
 * silently break the invariant while the DB-layer test stays green.
 *
 * This file drives handlePilotTunnel directly with a stub IncomingMessage
 * and Duplex socket. Each test exercises a different early-return branch
 * (missing header, wrong-secret JWT, never-stored row, expired row,
 * already-consumed row, unknown node) and asserts the rejection lands on
 * the wire with the right HTTP status before any upgrade attempt.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { WebSocketServer } from 'ws';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { handlePilotTunnel } from '../websocket/pilotTunnel';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let pilotTunnelWss: WebSocketServer;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    pilotTunnelWss = new WebSocketServer({ noServer: true });
});

afterAll(() => {
    pilotTunnelWss.close();
    cleanupTestDb(tmpDir);
});

interface StubSocket extends EventEmitter {
    writes: string[];
    destroyed: boolean;
    write(chunk: string): boolean;
    destroy(): void;
}

function makeStubSocket(): StubSocket {
    const sock = new EventEmitter() as StubSocket;
    sock.writes = [];
    sock.destroyed = false;
    sock.write = (chunk: string) => { sock.writes.push(chunk); return true; };
    sock.destroy = () => { sock.destroyed = true; };
    return sock;
}

function makeStubReq(authHeader: string | undefined, agentVersion = 'test-1.0'): IncomingMessage {
    const headers: Record<string, string> = { 'x-sencho-agent-version': agentVersion };
    if (authHeader !== undefined) headers['authorization'] = authHeader;
    // Cast through unknown: handlePilotTunnel only reads `headers` from
    // req, and on the reject path only calls socket.write(string) and
    // socket.destroy() on the Duplex. Anything else we add to the handler
    // (e.g. reading req.socket.remoteAddress for rate-limiting) silently
    // no-ops against the stub, so update both stubs when the surface grows.
    return { headers } as unknown as IncomingMessage;
}

/**
 * Mint a real pilot_enroll JWT against the test DB's auth secret. Mirrors
 * mintPilotEnrollment in routes/nodes.ts but inlined to avoid pulling the
 * full Express request shape into the test.
 */
function mintEnroll(nodeId: number, ttlSeconds = 15 * 60): { token: string; hash: string } {
    const db = DatabaseService.getInstance();
    const jwtSecret = db.getGlobalSettings().auth_jwt_secret;
    if (!jwtSecret) throw new Error('test DB has no auth_jwt_secret');
    const token = jwt.sign(
        { scope: 'pilot_enroll', nodeId, enrollNonce: crypto.randomUUID() },
        jwtSecret,
        { expiresIn: ttlSeconds },
    );
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    db.createPilotEnrollment(nodeId, hash, Date.now() + ttlSeconds * 1000);
    return { token, hash };
}

let nodeId: number;

beforeEach(() => {
    // Fresh pilot-mode node per test so prior enrollments do not bleed.
    nodeId = DatabaseService.getInstance().addNode({
        name: `pilot-replay-${Date.now()}-${Math.random()}`,
        type: 'remote',
        mode: 'pilot_agent',
        compose_dir: '/tmp/x',
        is_default: false,
        api_url: '',
        api_token: '',
    });
});

describe('handlePilotTunnel: rejection paths in the upgrade handler', () => {
    it('rejects an enrollment token whose row was already consumed', async () => {
        const { token, hash } = mintEnroll(nodeId);

        // Simulate that a prior successful enrollment consumed the row.
        const firstConsume = DatabaseService.getInstance().consumePilotEnrollment(hash);
        expect(firstConsume).toBeDefined();
        expect(firstConsume?.node_id).toBe(nodeId);

        // Now drive the upgrade handler with the same token. The route
        // must reject with 401 before granting the WebSocket upgrade.
        const socket = makeStubSocket();
        await handlePilotTunnel(
            makeStubReq(`Bearer ${token}`),
            socket as unknown as Duplex,
            Buffer.alloc(0),
            pilotTunnelWss,
        );

        expect(socket.destroyed).toBe(true);
        expect(socket.writes.length).toBeGreaterThan(0);
        expect(socket.writes[0]).toMatch(/^HTTP\/1\.1 401 Unauthorized/);
    });

    it('rejects an enrollment token whose row was never created', async () => {
        // Hand-rolled token whose hash matches no row in pilot_enrollments.
        const db = DatabaseService.getInstance();
        const jwtSecret = db.getGlobalSettings().auth_jwt_secret;
        const orphan = jwt.sign(
            { scope: 'pilot_enroll', nodeId, enrollNonce: 'never-stored' },
            jwtSecret,
            { expiresIn: 60 },
        );

        const socket = makeStubSocket();
        await handlePilotTunnel(
            makeStubReq(`Bearer ${orphan}`),
            socket as unknown as Duplex,
            Buffer.alloc(0),
            pilotTunnelWss,
        );

        expect(socket.destroyed).toBe(true);
        expect(socket.writes[0]).toMatch(/^HTTP\/1\.1 401 Unauthorized/);
    });

    it('rejects an enrollment token whose row has expired', async () => {
        const db = DatabaseService.getInstance();
        const jwtSecret = db.getGlobalSettings().auth_jwt_secret;
        // JWT TTL still valid (60 s) but the DB row's expires_at is in the
        // past. consumePilotEnrollment filters on expires_at > now, so this
        // tests the DB-side window, not the JWT-side one.
        const token = jwt.sign(
            { scope: 'pilot_enroll', nodeId, enrollNonce: 'expired-row' },
            jwtSecret,
            { expiresIn: 60 },
        );
        const hash = crypto.createHash('sha256').update(token).digest('hex');
        db.createPilotEnrollment(nodeId, hash, Date.now() - 1_000);

        const socket = makeStubSocket();
        await handlePilotTunnel(
            makeStubReq(`Bearer ${token}`),
            socket as unknown as Duplex,
            Buffer.alloc(0),
            pilotTunnelWss,
        );

        expect(socket.destroyed).toBe(true);
        expect(socket.writes[0]).toMatch(/^HTTP\/1\.1 401 Unauthorized/);
    });

    it('rejects a missing Authorization header before touching the DB', async () => {
        const socket = makeStubSocket();
        await handlePilotTunnel(
            makeStubReq(undefined),
            socket as unknown as Duplex,
            Buffer.alloc(0),
            pilotTunnelWss,
        );

        expect(socket.destroyed).toBe(true);
        expect(socket.writes[0]).toMatch(/^HTTP\/1\.1 401 Unauthorized/);
    });

    it('rejects a JWT signed with a wrong secret', async () => {
        const wrongToken = jwt.sign(
            { scope: 'pilot_enroll', nodeId, enrollNonce: 'wrong-secret' },
            'this-is-not-the-real-secret',
            { expiresIn: 60 },
        );

        const socket = makeStubSocket();
        await handlePilotTunnel(
            makeStubReq(`Bearer ${wrongToken}`),
            socket as unknown as Duplex,
            Buffer.alloc(0),
            pilotTunnelWss,
        );

        expect(socket.destroyed).toBe(true);
        expect(socket.writes[0]).toMatch(/^HTTP\/1\.1 401 Unauthorized/);
    });

    it('rejects a pilot_tunnel-scoped JWT for an unknown node', async () => {
        // pilot_tunnel scope is the long-lived credential persisted on the
        // agent. A pilot_tunnel JWT for a node that has been deleted (or
        // never existed) must be rejected at the upgrade handler: the
        // node lookup is the gate, not the JWT signature alone.
        const db = DatabaseService.getInstance();
        const jwtSecret = db.getGlobalSettings().auth_jwt_secret;
        const ghost = jwt.sign(
            { scope: 'pilot_tunnel', nodeId: 99_999_999 },
            jwtSecret,
            { expiresIn: '365d' },
        );

        const socket = makeStubSocket();
        await handlePilotTunnel(
            makeStubReq(`Bearer ${ghost}`),
            socket as unknown as Duplex,
            Buffer.alloc(0),
            pilotTunnelWss,
        );

        expect(socket.destroyed).toBe(true);
        expect(socket.writes[0]).toMatch(/^HTTP\/1\.1 404 /);
    });
});
