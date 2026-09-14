import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let runGitOpsSourceRecovery: typeof import('../bootstrap/startup').runGitOpsSourceRecovery;
let GitSourceService: typeof import('../services/GitSourceService').GitSourceService;
let gitSourceServiceModule: typeof import('../services/GitSourceService');

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ runGitOpsSourceRecovery } = await import('../bootstrap/startup'));
    gitSourceServiceModule = await import('../services/GitSourceService');
    ({ GitSourceService } = gitSourceServiceModule);
});

afterEach(() => {
    vi.restoreAllMocks();
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

describe('runGitOpsSourceRecovery', () => {
    it('recovers unsettled reconcile attempts before sweeping the managed area', async () => {
        const order: string[] = [];
        // Recovery yields before recording itself: if the sweep were ever
        // started concurrently instead of strictly after recovery resolves,
        // the sweep's own synchronous push would land first and this would
        // catch it, rather than merely proving call order at invocation
        // time.
        vi.spyOn(GitSourceService.getInstance(), 'recoverUnsettledReconcileAttempts')
            .mockImplementation(async () => {
                await new Promise((resolve) => setTimeout(resolve, 10));
                order.push('recover');
            });
        vi.spyOn(gitSourceServiceModule, 'sweepGitManifestOrphans')
            .mockImplementation(async () => { order.push('sweep'); });

        await runGitOpsSourceRecovery();

        expect(order).toEqual(['recover', 'sweep']);
    });

    it('still runs the sweep when recovery itself throws, tolerating the failure', async () => {
        const order: string[] = [];
        vi.spyOn(GitSourceService.getInstance(), 'recoverUnsettledReconcileAttempts')
            .mockImplementation(async () => { throw new Error('simulated recovery failure'); });
        vi.spyOn(gitSourceServiceModule, 'sweepGitManifestOrphans')
            .mockImplementation(async () => { order.push('sweep'); });
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        await expect(runGitOpsSourceRecovery()).resolves.toBeUndefined();

        expect(order).toEqual(['sweep']);
        expect(errorSpy).toHaveBeenCalled();
    });

    it('still resolves when the sweep itself throws, tolerating the failure rather than aborting startup', async () => {
        const recoverSpy = vi.spyOn(GitSourceService.getInstance(), 'recoverUnsettledReconcileAttempts')
            .mockImplementation(async () => {});
        vi.spyOn(gitSourceServiceModule, 'sweepGitManifestOrphans')
            .mockImplementation(async () => { throw new Error('simulated sweep failure'); });
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await expect(runGitOpsSourceRecovery()).resolves.toBeUndefined();

        expect(recoverSpy).toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalled();
    });
});

describe('startServer source ordering', () => {
    it('calls runGitOpsSourceRecovery before starting SourceController, so recovery and the sweep always precede the controller poll loop', () => {
        // A structural check, not a behavioral one: startServer drives ~25
        // unrelated services and isn't practical to run end to end in a
        // test. What matters here is the one property a future edit could
        // silently break: SourceController must never start before
        // recovery and the sweep have both awaited to completion. Comments
        // are stripped first so a mention of either symbol in prose can't
        // satisfy the match, and matching is whitespace/chaining-tolerant
        // so a harmless reformat (line-wrapped method chain, a `const`
        // extracted for the controller instance) doesn't false-fail this.
        const source = fs.readFileSync(path.join(__dirname, '../bootstrap/startup.ts'), 'utf-8');
        const startServerStart = source.indexOf('export async function startServer');
        // startServer is the last top-level declaration in this file today;
        // if that ever changes, bound this slice to its closing brace
        // instead of running to end of file.
        const startServerBody = source.slice(startServerStart);
        const code = startServerBody.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        const reconcileCallIndex = code.search(/await\s+runGitOpsSourceRecovery\s*\(/);
        const controllerStartIndex = code.search(/SourceController\s*\.\s*getInstance\s*\(\s*\)\s*\.\s*start\s*\(/);
        expect(reconcileCallIndex).toBeGreaterThan(-1);
        expect(controllerStartIndex).toBeGreaterThan(-1);
        expect(reconcileCallIndex).toBeLessThan(controllerStartIndex);
    });
});
