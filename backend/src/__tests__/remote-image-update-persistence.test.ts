import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { ImageUpdateService } from '../services/ImageUpdateService';
import { DatabaseService } from '../services/DatabaseService';
import type { ImageUpdateStackFacts } from '../services/imageUpdateFacts';

let tmpDir: string;
beforeAll(async () => { tmpDir = await setupTestDb(); });
afterAll(() => cleanupTestDb(tmpDir));

it('keeps accepted remote run timestamps and cooldowns independent per node', async () => {
    const scanner = ImageUpdateService.getInstance();
    const enabled = vi.spyOn(ImageUpdateService, 'isChecksEnabled').mockReturnValue(true);
    let finish: () => void = () => undefined;
    const held = new Promise<void>(resolve => { finish = resolve; });
    const first = scanner.runRemoteScan(101, true, () => held);
    const started = scanner.getRemoteScanStatus(101);
    try {
        expect(started.checking).toBe(true);
        expect(started.lastCheckedAt).not.toBeNull();
        expect(await scanner.runRemoteScan(101, true, async () => undefined)).toBe(false);
        expect(scanner.getRemoteScanStatus(101)).toEqual(started);
        expect(await scanner.runRemoteScan(102, true, async () => undefined)).toBe(true);
        scanner.clearNodeRuntimeMaps(101);
        expect(scanner.getRemoteScanStatus(101)).toMatchObject({ checking: false, lastCheckedAt: null, cooldownEndsAt: null });
    } finally {
        finish();
        await first;
        scanner.clearNodeRuntimeMaps(102);
        enabled.mockRestore();
    }
});

it('drops an old remote observation after a newer recheck reservation', async () => {
    const scanner = ImageUpdateService.getInstance();
    const db = DatabaseService.getInstance();
    const write = vi.spyOn(db, 'upsertStackUpdateStatus').mockImplementation(() => undefined);
    const facts: ImageUpdateStackFacts = {
        name: 'web', model: { renderable: true }, observationRevision: 900, observationToken: 'fixture',
        services: [{ name: 'app', declaredImage: 'nginx:latest', runtimeImages: [], hasBuild: false }],
        images: [],
    };
    const oldGeneration = scanner.reserveStackWriteGeneration(100, 'web');
    const newGeneration = scanner.reserveStackWriteGeneration(100, 'web');
    try {
        const current = await scanner.commitRemoteObservation(100, { ...facts, observationRevision: 1 },
            new Map([['nginx:latest', { hasUpdate: false, checkStatus: 'ok' }]]), newGeneration);
        expect(current.outcome).toBe('cleared');
        const stale = await scanner.commitRemoteObservation(100, facts,
            new Map([['nginx:latest', { hasUpdate: true, checkStatus: 'ok' }]]), oldGeneration);
        expect(stale.outcome).toBe('verification_incomplete');
        expect(write).toHaveBeenCalledTimes(1);
        expect(write.mock.calls[0][7]).toBe(newGeneration);
    } finally {
        write.mockRestore();
    }
});

it('persists failure evidence when remote facts are unrenderable', async () => {
    const scanner = ImageUpdateService.getInstance();
    const db = DatabaseService.getInstance();
    // Seed a prior confirmed update row so the commit must overwrite it.
    // Node 0 is the fixture instance's single local node; no addNode needed.
    db.upsertStackUpdateStatus(0, 'broken', true, 1000, 'ok', null);
    const failure = vi.spyOn(db, 'recordStackCheckFailure');
    const facts: ImageUpdateStackFacts = {
        name: 'broken', observationRevision: 1, observationToken: 'fixture',
        model: { renderable: false, code: 'effective_model_render_failed', error: 'compose render failed' },
        services: [], images: [],
    };
    const generation = scanner.reserveStackWriteGeneration(0, 'broken');
    const result = await scanner.commitRemoteObservation(0, facts, new Map(), generation);
    expect(result.outcome).toBe('verification_failed');
    expect(failure).toHaveBeenCalledTimes(1);
    expect(failure.mock.calls[0][2]).toContain('compose render failed');
    const row = db.getStackUpdateDetail(0)['broken'];
    expect(row?.checkStatus).toBe('failed');
    expect(row?.lastError).toContain('compose render failed');
    // The stale prior update must not survive as confirmed.
    expect(db.getConfirmedStackUpdateStatus(0)['broken']).toBe(false);
    expect(db.getStackUpdateWriteGeneration(0, 'broken')).toBe(generation);
});
