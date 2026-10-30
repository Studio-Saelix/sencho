/**
 * An S3 endpoint that accepts the connection and never answers (or a blackholed
 * address) must fail every cloud backup request in bounded time. The Snapshot
 * Vault panel holds Save, the storage picker and Auto-upload while a request
 * runs, so a request that never returns locks the destination controls. These
 * tests use the real AWS SDK against a socket that stays silent.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as net from 'net';
import type { AddressInfo } from 'net';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let silent: net.Server;
const sockets: net.Socket[] = [];
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let CryptoService: typeof import('../services/CryptoService').CryptoService;
let CloudBackupService: typeof import('../services/CloudBackupService').CloudBackupService;
let S3_TIMEOUTS: typeof import('../services/CloudBackupService').S3_TIMEOUTS;
let originalTimeouts: { connectionMs: number; socketMs: number };

// A real ceiling for "bounded": generous next to the 250 ms socket timeout
// (three SDK attempts plus backoff), far below a request that never returns.
const BOUND_MS = 8_000;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ CryptoService } = await import('../services/CryptoService'));
    ({ CloudBackupService, S3_TIMEOUTS } = await import('../services/CloudBackupService'));
    originalTimeouts = { ...S3_TIMEOUTS };
    silent = net.createServer(socket => { sockets.push(socket); });
    await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
    Object.assign(S3_TIMEOUTS, originalTimeouts);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => silent.close(() => resolve()));
    CloudBackupService.getInstance().stop();
    cleanupTestDb(tmpDir);
});

beforeEach(() => {
    S3_TIMEOUTS.connectionMs = 250;
    S3_TIMEOUTS.socketMs = 250;
    const db = DatabaseService.getInstance();
    db.setSystemState('instance_id', 'test-instance-id');
    db.updateGlobalSetting('cloud_backup_provider', 'custom');
    db.updateGlobalSetting('cloud_backup_endpoint', `http://127.0.0.1:${(silent.address() as AddressInfo).port}`);
    db.updateGlobalSetting('cloud_backup_region', 'us-east-1');
    db.updateGlobalSetting('cloud_backup_bucket', 'my-bucket');
    db.updateGlobalSetting('cloud_backup_access_key', 'AKIA1234');
    db.updateGlobalSetting('cloud_backup_secret_key', CryptoService.getInstance().encrypt('test-secret'));
    db.updateGlobalSetting('cloud_backup_path_prefix', 'sencho/');
});

async function settlesWithinBound<T>(run: () => Promise<T>): Promise<{ elapsedMs: number; outcome: 'resolved' | 'rejected' | 'hung'; value?: T }> {
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hung = new Promise<'hung'>(resolve => { timer = setTimeout(() => resolve('hung'), BOUND_MS); });
    const settled = run().then(
        (value): { outcome: 'resolved'; value: T } => ({ outcome: 'resolved', value }),
        (): { outcome: 'rejected' } => ({ outcome: 'rejected' }),
    );
    const result = await Promise.race([settled, hung]);
    clearTimeout(timer);
    return result === 'hung'
        ? { elapsedMs: Date.now() - started, outcome: 'hung' }
        : { elapsedMs: Date.now() - started, ...result };
}

describe('CloudBackupService against an endpoint that never answers', () => {
    it('fails Test with a message instead of hanging', async () => {
        const result = await settlesWithinBound(() => CloudBackupService.getInstance().testConnection());
        expect(result.outcome).toBe('resolved');
        expect(result.value?.success).toBe(false);
        expect(result.value?.error).toBeTruthy();
    });

    it('fails Test after one attempt, not the SDK default of three', async () => {
        S3_TIMEOUTS.socketMs = 1_500;
        const result = await settlesWithinBound(() => CloudBackupService.getInstance().testConnection());
        expect(result.outcome).toBe('resolved');
        // Three attempts would take at least 4.5 s of socket timeouts alone.
        expect(result.elapsedMs).toBeLessThan(4_000);
    });

    it.each<[string, () => Promise<unknown>]>([
        ['the snapshot listing', () => CloudBackupService.getInstance().listCloudSnapshots()],
        ['the recovery listing', () => CloudBackupService.getInstance().listRecoveryArchives()],
        ['an archive download', () => CloudBackupService.getInstance().downloadSnapshot('sencho/instances/test-instance-id/snapshots/1_x.tar.gz')],
        ['an archive import', () => CloudBackupService.getInstance().importSnapshot('sencho/instances/test-instance-id/snapshots/1_x.tar.gz')],
        ['a recovery import', () => CloudBackupService.getInstance().importRecoveryArchive('sencho/instances/other/snapshots/1_x.tar.gz.senc', 'a-long-enough-passphrase')],
        ['a delete', () => CloudBackupService.getInstance().deleteCloudSnapshot('sencho/instances/test-instance-id/snapshots/1_x.tar.gz')],
    ])('rejects %s instead of hanging', async (_label, run) => {
        const result = await settlesWithinBound(run);
        expect(result.outcome).toBe('rejected');
    });

    it('records an upload as failed instead of leaving it uploading', async () => {
        const db = DatabaseService.getInstance();
        const snapshotId = db.createSnapshot('Timeout probe', 'admin', 1, 1, '[]');
        db.insertSnapshotFiles(snapshotId, [
            { nodeId: 1, nodeName: 'gateway', stackName: 'web', filename: 'compose.yaml', content: 'services: {}\n' },
        ]);
        const result = await settlesWithinBound(() => CloudBackupService.getInstance().uploadSnapshot(snapshotId));
        expect(result.outcome).toBe('rejected');
        expect(CloudBackupService.getInstance().getUploadStatus(snapshotId).status).toBe('failed');
    });
});
