/**
 * A remote node that dies in the middle of a download.
 *
 * The node sends 200 headers and part of the body, then its socket is
 * destroyed. The hub has already written those headers to the client, so it
 * cannot answer with an error status; the only honest signal left is to abort
 * the client response. A clean end would hand the client a truncated file
 * that looks complete.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo, Socket } from 'net';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

// A listed long-lived download. Recovery paths run a node preflight before
// the hop, which is not what this case is about.
const DOWNLOAD_PATH = '/api/stacks/x/files/download?path=compose.yaml';

interface ClientOutcome {
    status: number;
    body: string;
    ended: boolean;
    aborted: boolean;
}

describe('direct remote proxy mid-stream abort', () => {
    let tmpDir: string;
    let hub: http.Server;
    let hubPort: number;
    let stub: http.Server;
    let remoteNodeId: number;
    let authHeader: string;
    let upstreamSawRequest = false;
    const stubSockets = new Set<Socket>();

    beforeAll(async () => {
        tmpDir = await setupTestDb();

        stub = http.createServer((req, res) => {
            if (!req.url?.startsWith('/api/stacks/x/files/download')) {
                res.writeHead(404, { 'content-type': 'application/json' });
                res.end('{}');
                return;
            }
            upstreamSawRequest = true;
            res.writeHead(200, {
                'content-type': 'application/octet-stream',
                'content-disposition': 'attachment; filename="file.bin"',
            });
            // Chunked on purpose: with no content-length, a clean end from the
            // hub would look like a complete body to the client.
            res.write('partial-body');
            // Let the partial body reach the hub, then kill the node's socket.
            setTimeout(() => req.socket.destroy(), 100);
        });
        stub.on('connection', (socket: Socket) => {
            stubSockets.add(socket);
            socket.on('close', () => stubSockets.delete(socket));
        });
        await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
        const stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;

        const { app } = await import('../index');
        hub = http.createServer(app);
        await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve));
        hubPort = (hub.address() as AddressInfo).port;

        const { DatabaseService } = await import('../services/DatabaseService');
        remoteNodeId = DatabaseService.getInstance().addNode({
            name: 'midstream-remote',
            type: 'remote',
            mode: 'proxy',
            compose_dir: '/tmp',
            is_default: false,
            api_url: stubUrl,
            api_token: 'midstream-abort-test-token',
        });

        authHeader = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '10m' })}`;
    });

    afterAll(async () => {
        for (const socket of stubSockets) socket.destroy();
        hub.closeAllConnections();
        await new Promise<void>((resolve) => hub.close(() => resolve()));
        await new Promise<void>((resolve) => stub.close(() => resolve()));
        cleanupTestDb(tmpDir);
    });

    it('aborts the client response instead of ending it cleanly', async () => {
        const outcome = await new Promise<ClientOutcome>((resolve) => {
            const req = http.get({
                host: '127.0.0.1',
                port: hubPort,
                path: DOWNLOAD_PATH,
                headers: { authorization: authHeader, 'x-node-id': String(remoteNodeId) },
            }, (res) => {
                let body = '';
                let aborted = false;
                res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                res.on('aborted', () => { aborted = true; });
                res.on('error', () => { aborted = true; });
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body, ended: true, aborted }));
                res.on('close', () => resolve({ status: res.statusCode ?? 0, body, ended: false, aborted: aborted || !res.complete }));
            });
            req.on('error', () => resolve({ status: 0, body: '', ended: false, aborted: true }));
        });

        expect(upstreamSawRequest).toBe(true);
        expect(outcome.status).toBe(200);
        expect(outcome.body).toBe('partial-body');
        expect(outcome.aborted).toBe(true);
        expect(outcome.ended).toBe(false);
    }, 15_000);
});
