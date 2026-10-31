/**
 * An S3 endpoint that accepts the connection and then goes quiet must fail
 * every cloud backup request in bounded time. The Snapshot Vault panel holds
 * Save, the storage picker and Auto-upload while a request runs, so a request
 * that never returns locks the destination controls. These tests use the real
 * AWS SDK against sockets that stay silent, stall after the response headers,
 * or keep trickling data. The connection timeout is not exercised: it needs an
 * address that drops SYN packets, which a test host cannot promise.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as net from 'net';
import type { AddressInfo } from 'net';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

type Mode = 'silent' | 'stall-body' | 'trickle';

let tmpDir: string;
const servers = new Map<Mode, net.Server>();
const sockets: net.Socket[] = [];
const timers: Array<ReturnType<typeof setInterval>> = [];
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let CryptoService: typeof import('../services/CryptoService').CryptoService;
let CloudBackupService: typeof import('../services/CloudBackupService').CloudBackupService;
let S3_TIMEOUTS: typeof import('../services/CloudBackupService').S3_TIMEOUTS;
let originalTimeouts: { connectionMs: number; socketMs: number; operationMs: number; bodyIdleMs: number };

const TRICKLE_BYTES = 12;
const TRICKLE_GAP_MS = 150;

// A ceiling for "bounded": generous next to the 250 ms timeouts below, far
// below a request that never returns.
const BOUND_MS = 8_000;

const OWN_KEY = 'sencho/instances/test-instance-id/snapshots/1_x.tar.gz';

function startServer(mode: Mode): Promise<net.Server> {
    const server = net.createServer(socket => {
        sockets.push(socket);
        socket.on('error', () => undefined);
        if (mode === 'silent') return;
        socket.once('data', () => {
            if (mode === 'stall-body') {
                // Headers arrive at once; the body promised never completes.
                socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/xml\r\nContent-Length: 1000000\r\n\r\n<x>');
                return;
            }
            socket.write(`HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: ${TRICKLE_BYTES}\r\n\r\n`);
            let sent = 0;
            const timer = setInterval(() => {
                if (socket.destroyed || sent >= TRICKLE_BYTES) {
                    clearInterval(timer);
                    return;
                }
                sent += 1;
                socket.write('a');
                if (sent === TRICKLE_BYTES) clearInterval(timer);
            }, TRICKLE_GAP_MS);
            timers.push(timer);
        });
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function point(mode: Mode) {
    const port = (servers.get(mode)!.address() as AddressInfo).port;
    DatabaseService.getInstance().updateGlobalSetting('cloud_backup_endpoint', `http://127.0.0.1:${port}`);
}

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ CryptoService } = await import('../services/CryptoService'));
    ({ CloudBackupService, S3_TIMEOUTS } = await import('../services/CloudBackupService'));
    originalTimeouts = { ...S3_TIMEOUTS };
    for (const mode of ['silent', 'stall-body', 'trickle'] as const) servers.set(mode, await startServer(mode));
});

afterAll(async () => {
    Object.assign(S3_TIMEOUTS, originalTimeouts);
    for (const timer of timers) clearInterval(timer);
    for (const socket of sockets) socket.destroy();
    await Promise.all([...servers.values()].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    CloudBackupService.getInstance().stop();
    cleanupTestDb(tmpDir);
});

beforeEach(() => {
    // The socket timeout is above the SDK's 6 s threshold on purpose: below it
    // the SDK times out a stalled body itself, which would hide the bounds
    // under test. Only the 250 ms operation and body limits can end these.
    S3_TIMEOUTS.connectionMs = 250;
    S3_TIMEOUTS.socketMs = 20_000;
    S3_TIMEOUTS.operationMs = 250;
    S3_TIMEOUTS.bodyIdleMs = 250;
    const db = DatabaseService.getInstance();
    db.setSystemState('instance_id', 'test-instance-id');
    db.updateGlobalSetting('cloud_backup_provider', 'custom');
    db.updateGlobalSetting('cloud_backup_region', 'us-east-1');
    db.updateGlobalSetting('cloud_backup_bucket', 'my-bucket');
    db.updateGlobalSetting('cloud_backup_access_key', 'AKIA1234');
    db.updateGlobalSetting('cloud_backup_secret_key', CryptoService.getInstance().encrypt('test-secret'));
    db.updateGlobalSetting('cloud_backup_path_prefix', 'sencho/');
    point('silent');
});

interface Settled<T> { outcome: 'resolved' | 'rejected' | 'hung'; value?: T; message?: string; elapsedMs: number }

async function settle<T>(run: () => Promise<T>): Promise<Settled<T>> {
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hung = new Promise<Settled<T>>(resolve => {
        timer = setTimeout(() => resolve({ outcome: 'hung', elapsedMs: Date.now() - started }), BOUND_MS);
    });
    const settled = run().then(
        (value): Settled<T> => ({ outcome: 'resolved', value, elapsedMs: Date.now() - started }),
        (err: unknown): Settled<T> => ({ outcome: 'rejected', message: (err as Error).message, elapsedMs: Date.now() - started }),
    );
    const result = await Promise.race([settled, hung]);
    clearTimeout(timer);
    return result;
}

const service = () => CloudBackupService.getInstance();

// Every message an operator can see for a timeout names the endpoint, not the SDK.
const OPERATOR_MESSAGE = /storage endpoint/;

describe('CloudBackupService against an endpoint that accepts the connection and never answers', () => {
    it('fails Test with a message about the endpoint', async () => {
        const result = await settle(() => service().testConnection());
        expect(result.outcome).toBe('resolved');
        expect(result.value?.success).toBe(false);
        expect(result.value?.error).toMatch(OPERATOR_MESSAGE);
        expect(result.elapsedMs).toBeGreaterThanOrEqual(200);
    });

    it('makes one attempt for Test, not the SDK default of three', async () => {
        // With a 1.2 s operation bound a single attempt reports at 1.2 s. The
        // SDK would otherwise keep retrying a socket timeout inside that bound.
        S3_TIMEOUTS.operationMs = 20_000;
        S3_TIMEOUTS.socketMs = 1_200;
        const result = await settle(() => service().testConnection());
        expect(result.outcome).toBe('resolved');
        expect(result.value?.success).toBe(false);
        // Three attempts would take at least 3.6 s of socket timeouts alone.
        expect(result.elapsedMs).toBeLessThan(3_000);
    });

    it.each<[string, () => Promise<unknown>]>([
        ['the snapshot listing', () => service().listCloudSnapshots()],
        ['the recovery listing', () => service().listRecoveryArchives()],
        ['a delete', () => service().deleteCloudSnapshot(OWN_KEY)],
        ['an archive download', () => service().downloadSnapshot(OWN_KEY)],
        ['an archive import', () => service().importSnapshot(OWN_KEY)],
        ['a recovery import', () => service().importRecoveryArchive('sencho/instances/other/snapshots/1_x.tar.gz.senc', 'a-long-enough-passphrase')],
    ])('rejects %s instead of hanging', async (_label, run) => {
        // Downloads have no operation bound, so the SDK's own socket timeout
        // ends them; keep it short for these rows.
        S3_TIMEOUTS.socketMs = 400;
        const result = await settle(run);
        expect(result.outcome).toBe('rejected');
        expect(result.message).toMatch(OPERATOR_MESSAGE);
        expect(result.elapsedMs).toBeGreaterThanOrEqual(200);
    });

    it('records an upload as failed instead of leaving it uploading', async () => {
        S3_TIMEOUTS.socketMs = 400;
        const db = DatabaseService.getInstance();
        const snapshotId = db.createSnapshot('Timeout probe', 'admin', 1, 1, '[]');
        db.insertSnapshotFiles(snapshotId, [
            { nodeId: 1, nodeName: 'gateway', stackName: 'web', filename: 'compose.yaml', content: 'services: {}\n' },
        ]);
        const result = await settle(() => service().uploadSnapshot(snapshotId));
        expect(result.outcome).toBe('rejected');
        expect(result.message).toMatch(OPERATOR_MESSAGE);
        expect(service().getUploadStatus(snapshotId).status).toBe('failed');
    });
});

describe('CloudBackupService against an endpoint that stalls after the response headers', () => {
    beforeEach(() => point('stall-body'));

    it.each<[string, () => Promise<unknown>]>([
        ['the snapshot listing', () => service().listCloudSnapshots()],
        ['the recovery listing', () => service().listRecoveryArchives()],
    ])('bounds %s although the SDK arms no timer after the headers', async (_label, run) => {
        const result = await settle(run);
        expect(result.outcome).toBe('rejected');
        expect(result.message).toMatch(OPERATOR_MESSAGE);
    });

    it('cuts a download whose body stalls', async () => {
        const result = await settle(() => service().downloadSnapshot(OWN_KEY));
        expect(result.outcome).toBe('rejected');
        expect(result.message).toMatch(/stopped sending data/);
    });
});

describe('CloudBackupService against an endpoint that keeps trickling a download', () => {
    it('does not cut a download that is slow but still moving', async () => {
        point('trickle');
        // 12 bytes at one per 150 ms take about 1.8 s in all, longer than the
        // 250 ms idle limit, but the stream is never idle for more than 150 ms.
        const fetchObject = (service() as unknown as { fetchObject(key: string): Promise<Buffer> }).fetchObject.bind(service());
        const result = await settle(() => fetchObject(OWN_KEY));
        expect(result.outcome).toBe('resolved');
        expect(result.value?.byteLength).toBe(TRICKLE_BYTES);
        expect(result.elapsedMs).toBeGreaterThan(1_000);
    });
});
