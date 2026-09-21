/**
 * Pins boot-time cleanup of orphaned sencho-digest-pins-* overlay dirs.
 *
 * Restart mid-reconcile and proxy/Pilot equivalence are not automated here;
 * they need a live daemon and a second node fixture.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { DIGEST_PIN_TEMP_PREFIX, sweepStaleDigestPinDirs } from '../helpers/digestPinTempDir';

const ONE_HOUR_MS = 60 * 60 * 1000;

function makeTempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${DIGEST_PIN_TEMP_PREFIX}${label}-`));
  fs.writeFileSync(path.join(dir, 'overlay.yml'), 'services: {}\n');
  return dir;
}

function backdate(dir: string, ageMs: number): void {
  const t = Date.now() - ageMs;
  fs.utimesSync(dir, t / 1000, t / 1000);
}

describe('sweepStaleDigestPinDirs', () => {
  const created: string[] = [];

  beforeEach(() => {
    created.length = 0;
  });

  afterEach(() => {
    for (const d of created) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
    }
  });

  it('removes a sencho-digest-pins-* dir whose mtime is older than 1 hour', async () => {
    const stale = makeTempDir('stale');
    created.push(stale);
    backdate(stale, ONE_HOUR_MS + 5_000);

    await sweepStaleDigestPinDirs();

    expect(fs.existsSync(stale)).toBe(false);
  });

  it('leaves fresh sencho-digest-pins-* dirs untouched', async () => {
    const fresh = makeTempDir('fresh');
    created.push(fresh);

    await sweepStaleDigestPinDirs();

    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('ignores dirs that do not match the prefix', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'not-digest-pins-'));
    backdate(other, 2 * ONE_HOUR_MS);
    created.push(other);

    await sweepStaleDigestPinDirs();

    expect(fs.existsSync(other)).toBe(true);
  });
});
