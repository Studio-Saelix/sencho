/**
 * Pins boot-time cleanup of orphaned `sencho-trivy-*` tmp dirs.
 *
 * `buildEnv` writes a per-scan DOCKER_CONFIG dir under os.tmpdir(). Healthy
 * scans clean up via a finally block; a process crash mid-scan leaks the dir.
 * `sweepStaleTrivyTempDirs` runs at startup and removes any prefix-matching
 * dir older than 1 hour, leaving fresh dirs alone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { sweepStaleTrivyTempDirs } from '../services/TrivyService';

const PREFIX = 'sencho-trivy-';
const ONE_HOUR_MS = 60 * 60 * 1000;

// `mkdtempSync` appends a process-random suffix to the prefix and creates the
// directory atomically. Required to avoid the predictable-tmp-path symlink
// attack flagged by CodeQL's `js/insecure-temporary-file` rule.
function makeTempDir(label: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${PREFIX}${label}-`));
    fs.writeFileSync(path.join(dir, 'config.json'), '{}');
    return dir;
}

function makeNonPrefixedTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'not-trivy-'));
}

function backdate(dir: string, ageMs: number): void {
    const t = Date.now() - ageMs;
    fs.utimesSync(dir, t / 1000, t / 1000);
}

describe('sweepStaleTrivyTempDirs', () => {
    const created: string[] = [];

    beforeEach(() => {
        created.length = 0;
    });

    afterEach(() => {
        for (const d of created) {
            try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
        }
    });

    it('removes a sencho-trivy-* dir whose mtime is older than 1 hour', async () => {
        const stale = makeTempDir('stale');
        created.push(stale);
        backdate(stale, ONE_HOUR_MS + 5_000);

        await sweepStaleTrivyTempDirs();

        expect(fs.existsSync(stale)).toBe(false);
    });

    it('leaves fresh sencho-trivy-* dirs untouched', async () => {
        const fresh = makeTempDir('fresh');
        created.push(fresh);
        // Default mtime is now, well within the 1-hour cutoff.

        await sweepStaleTrivyTempDirs();

        expect(fs.existsSync(fresh)).toBe(true);
    });

    it('ignores dirs that do not match the prefix', async () => {
        const other = makeNonPrefixedTempDir();
        backdate(other, 2 * ONE_HOUR_MS);
        created.push(other);

        await sweepStaleTrivyTempDirs();

        expect(fs.existsSync(other)).toBe(true);
    });

    it('returns without throwing when the tmp dir is unreadable', async () => {
        // We cannot reliably make os.tmpdir unreadable in a portable test, so
        // assert that the call completes without error on a normal system.
        await expect(sweepStaleTrivyTempDirs()).resolves.toBeUndefined();
    });
});
