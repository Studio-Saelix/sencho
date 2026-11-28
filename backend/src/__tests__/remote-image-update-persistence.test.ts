import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { ImageUpdateService } from '../services/ImageUpdateService';
import { DatabaseService } from '../services/DatabaseService';
import type { ImageUpdateStackFacts } from '../services/imageUpdateFacts';
import { checkResultFromDetection } from '../services/updateDetectionDirectives';

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

it('keeps a recorded policy when a remote observation cannot evaluate it', async () => {
    const scanner = ImageUpdateService.getInstance();
    const db = DatabaseService.getInstance();
    // A remote row cannot be evaluated on this node, so the commit must not
    // overwrite the decision the node itself recorded.
    db.upsertStackUpdateStatus(0, 'remote-policy', false, 1000, 'ok', null, [], 0, {
        decision: 'skip', ineligible: [{ service: 'web', policy: 'manual' }],
    });
    const facts: ImageUpdateStackFacts = {
        name: 'remote-policy', observationRevision: 1, observationToken: 'fixture',
        model: { renderable: true },
        services: [{ name: 'app', declaredImage: 'nginx:latest', runtimeImages: [], hasBuild: false }],
        images: [],
    };
    const generation = scanner.reserveStackWriteGeneration(0, 'remote-policy');
    const result = await scanner.commitRemoteObservation(
        0, facts, new Map([['nginx:latest', { hasUpdate: false, checkStatus: 'ok' }]]), generation,
    );
    expect(result.outcome).toBe('cleared');
    expect(db.getStackUpdateDetail(0)['remote-policy'].unattendedPolicy).toMatchObject({ decision: 'skip' });
});

it('records the unattended decision the target sent with remote facts', async () => {
    const scanner = ImageUpdateService.getInstance();
    const db = DatabaseService.getInstance();
    db.upsertStackUpdateStatus(0, 'remote-evaluated', false, 1000, 'ok', null, [], 0, {
        decision: 'allow', ineligible: [],
    });
    const facts: ImageUpdateStackFacts = {
        name: 'remote-evaluated', observationRevision: 1, observationToken: 'fixture',
        model: { renderable: true },
        services: [{ name: 'app', declaredImage: 'nginx:latest', runtimeImages: [], hasBuild: false }],
        images: [],
        unattendedPolicy: { decision: 'skip', ineligible: [{ service: 'db', policy: 'disabled' }] },
    };
    const generation = scanner.reserveStackWriteGeneration(0, 'remote-evaluated');
    const result = await scanner.commitRemoteObservation(
        0, facts, new Map([['nginx:latest', { hasUpdate: false, checkStatus: 'ok' }]]), generation,
    );
    expect(result.outcome).toBe('cleared');
    // Evaluated on the node that owns the stack, so the hub replaces its prior
    // decision instead of keeping it.
    expect(db.getStackUpdateDetail(0)['remote-evaluated'].unattendedPolicy).toEqual({
        decision: 'skip', ineligible: [{ service: 'db', policy: 'disabled' }],
    });
});

it('records the target decision even when the remote model cannot render', async () => {
    const scanner = ImageUpdateService.getInstance();
    const db = DatabaseService.getInstance();
    db.upsertStackUpdateStatus(0, 'remote-broken', false, 1000, 'ok', null, [], 0, {
        decision: 'allow', ineligible: [],
    });
    const facts: ImageUpdateStackFacts = {
        name: 'remote-broken', observationRevision: 1, observationToken: 'fixture',
        model: { renderable: false, code: 'effective_model_render_failed', error: 'compose render failed' },
        services: [], images: [],
        unattendedPolicy: { decision: 'skip', ineligible: [] },
    };
    const generation = scanner.reserveStackWriteGeneration(0, 'remote-broken');
    const result = await scanner.commitRemoteObservation(0, facts, new Map(), generation);
    expect(result.outcome).toBe('verification_failed');
    expect(db.getStackUpdateDetail(0)['remote-broken'].unattendedPolicy).toEqual({
        decision: 'skip', ineligible: [],
    });
});

it('records the target detection labels on a hub-run observation', async () => {
    const scanner = ImageUpdateService.getInstance();
    const db = DatabaseService.getInstance();
    const write = vi.spyOn(db, 'upsertStackUpdateStatus').mockImplementation(() => undefined);
    const candidate = `sha256:${'c'.repeat(64)}`;
    const facts: ImageUpdateStackFacts = {
        name: 'labeled', model: { renderable: true }, observationRevision: 1, observationToken: 'fixture',
        services: [
            { name: 'app', declaredImage: 'nginx:latest', runtimeImages: [], hasBuild: false },
            { name: 'cache', declaredImage: 'redis:7', runtimeImages: [], hasBuild: false },
        ],
        images: [],
        directives: [
            { service: 'app', check: true, ignore: [candidate], changelogUrl: null },
            { service: 'cache', check: false, ignore: [], changelogUrl: null },
        ],
    };
    const rebuild = checkResultFromDetection({
        hasUpdate: true, digestUpdate: true, tagUpdate: false, nextTag: 'latest', digestError: null,
        tagEnumKind: 'skipped', tagEnumReason: null, checkStatus: 'ok', reason: null, semverBump: 'patch',
        candidateDigest: candidate,
    });
    try {
        const result = await scanner.commitRemoteObservation(103, facts, new Map([
            ['nginx:latest', rebuild],
            ['redis:7', { hasUpdate: false, checkStatus: 'not_checkable', notCheckable: true }],
        ]), scanner.reserveStackWriteGeneration(103, 'labeled'));
        expect(result.outcome).toBe('cleared');
        expect(write.mock.calls[0][2]).toBe(false);
        expect(write.mock.calls[0][6]).toEqual([
            {
                service: 'app', image: 'nginx:latest', hasUpdate: false, checkStatus: 'ok', lastError: null,
                detection: 'ignored', ignoredRefs: ['nginx:latest'],
            },
            { service: 'cache', image: 'redis:7', hasUpdate: false, checkStatus: 'not_checkable', lastError: null, detection: 'off' },
        ]);
    } finally {
        write.mockRestore();
    }
});

function labeledFacts(): ImageUpdateStackFacts {
    const candidate = `sha256:${'c'.repeat(64)}`;
    return {
        name: 'labeled-verify', model: { renderable: true }, observationRevision: 1, observationToken: 'fixture',
        services: [
            { name: 'app', declaredImage: 'nginx:latest', runtimeImages: [], hasBuild: false },
            { name: 'cache', declaredImage: 'redis:7', runtimeImages: [], hasBuild: false },
        ],
        images: [
            { ref: 'nginx:latest', localDigests: [], platform: null, emptyReason: 'no_repo_digests',
                authority: { source: 'unchecked', result: null, observedAt: 1 } },
            { ref: 'redis:7', localDigests: [], platform: null, emptyReason: 'no_repo_digests',
                authority: { source: 'unchecked', result: null, observedAt: 1 } },
        ],
        directives: [
            { service: 'app', check: true, ignore: [candidate], changelogUrl: null },
            { service: 'cache', check: false, ignore: [], changelogUrl: null },
        ],
    };
}

function ignoredRebuild(): ReturnType<typeof checkResultFromDetection> {
    return checkResultFromDetection({
        hasUpdate: true, digestUpdate: true, tagUpdate: false, nextTag: 'latest', digestError: null,
        tagEnumKind: 'skipped', tagEnumReason: null, checkStatus: 'ok', reason: null, semverBump: 'patch',
        candidateDigest: `sha256:${'c'.repeat(64)}`,
    });
}

it('reports ignored digest drift as still present on hub-owned verification', async () => {
    const scanner = ImageUpdateService.getInstance();
    const db = DatabaseService.getInstance();
    const write = vi.spyOn(db, 'upsertStackUpdateStatus').mockImplementation(() => undefined);
    const facts = labeledFacts();
    try {
        const result = await scanner.commitRemoteObservation(104, facts, new Map([
            ['nginx:latest', ignoredRebuild()],
            ['redis:7', { hasUpdate: false, checkStatus: 'ok' }],
        ]), scanner.reserveStackWriteGeneration(104, facts.name), { verification: true });
        expect(result).toEqual({
            outcome: 'still_present',
            warning: 'The update command completed, but the image digest was not updated. Your Docker daemon may cache older content through a registry mirror, or the container may still be pinned to the previous image. Check your daemon configuration or recreate the container with --force-recreate.',
        });
        // Reporting still records the filtered state.
        expect(write.mock.calls[0][2]).toBe(false);
    } finally {
        write.mockRestore();
    }
});

it('clears hub-owned verification once the digest has moved', async () => {
    const scanner = ImageUpdateService.getInstance();
    const db = DatabaseService.getInstance();
    const write = vi.spyOn(db, 'upsertStackUpdateStatus').mockImplementation(() => undefined);
    const facts = labeledFacts();
    try {
        const result = await scanner.commitRemoteObservation(105, facts, new Map([
            ['nginx:latest', { hasUpdate: false, checkStatus: 'ok' }],
            ['redis:7', { hasUpdate: false, checkStatus: 'ok' }],
        ]), scanner.reserveStackWriteGeneration(105, facts.name), { verification: true });
        expect(result).toEqual({ outcome: 'cleared', warning: null });
    } finally {
        write.mockRestore();
    }
});

it('does not hold a build-backed service registry digest against verification', async () => {
    const scanner = ImageUpdateService.getInstance();
    const db = DatabaseService.getInstance();
    const write = vi.spyOn(db, 'upsertStackUpdateStatus').mockImplementation(() => undefined);
    const facts = labeledFacts();
    facts.name = 'build-verify';
    facts.services = [
        { name: 'app', declaredImage: 'nginx:latest', runtimeImages: [], hasBuild: false },
        { name: 'builder', declaredImage: 'builder:latest', runtimeImages: [], hasBuild: true },
    ];
    facts.images = [
        { ref: 'nginx:latest', localDigests: [], platform: null, emptyReason: 'no_repo_digests',
            authority: { source: 'unchecked', result: null, observedAt: 1 } },
        { ref: 'builder:latest', localDigests: [], platform: null, emptyReason: 'no_repo_digests',
            authority: { source: 'unchecked', result: null, observedAt: 1 } },
    ];
    facts.directives = [];
    try {
        const failedBuild = await scanner.commitRemoteObservation(107, facts, new Map([
            ['nginx:latest', { hasUpdate: false, checkStatus: 'ok' }],
            ['builder:latest', { hasUpdate: false, checkStatus: 'failed', error: 'inspect failed' }],
        ]), scanner.reserveStackWriteGeneration(107, facts.name), { verification: true });
        expect(failedBuild).toEqual({ outcome: 'cleared', warning: null });

        const digestDrift = await scanner.commitRemoteObservation(108, { ...facts, name: 'build-drift' }, new Map([
            ['nginx:latest', { hasUpdate: false, checkStatus: 'ok' }],
            ['builder:latest', { hasUpdate: true, digestUpdate: true, checkStatus: 'ok' }],
        ]), scanner.reserveStackWriteGeneration(108, 'build-drift'), { verification: true });
        expect(digestDrift).toEqual({ outcome: 'cleared', warning: null });
    } finally {
        write.mockRestore();
    }
});

it('reports incomplete hub-owned verification when a checks-off ref has no evidence', async () => {
    const scanner = ImageUpdateService.getInstance();
    const db = DatabaseService.getInstance();
    const write = vi.spyOn(db, 'upsertStackUpdateStatus').mockImplementation(() => undefined);
    const facts = labeledFacts();
    try {
        const result = await scanner.commitRemoteObservation(106, facts, new Map([
            ['nginx:latest', { hasUpdate: false, checkStatus: 'ok' }],
        ]), scanner.reserveStackWriteGeneration(106, facts.name), { verification: true });
        expect(result).toEqual({
            outcome: 'verification_incomplete',
            warning: 'The update command completed, but Sencho could not fully verify whether an image update remains.',
        });
    } finally {
        write.mockRestore();
    }
});
