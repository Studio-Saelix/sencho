import fs from 'fs';
import os from 'os';
import path from 'path';

export const DIGEST_PIN_TEMP_PREFIX = 'sencho-digest-pins-';
const DIGEST_PIN_TEMP_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Remove leftover digest-overlay temp dirs older than one hour. Healthy
 * deploys delete the directory in a finally; a crash between mkdtemp and
 * that cleanup leaks it until the next boot.
 */
export async function sweepStaleDigestPinDirs(): Promise<void> {
  const tmp = os.tmpdir();
  let entries: string[];
  try {
    entries = await fs.promises.readdir(tmp);
  } catch {
    return;
  }
  const cutoff = Date.now() - DIGEST_PIN_TEMP_MAX_AGE_MS;
  for (const entry of entries) {
    if (!entry.startsWith(DIGEST_PIN_TEMP_PREFIX)) continue;
    const full = path.join(tmp, entry);
    try {
      const stat = await fs.promises.stat(full);
      if (stat.mtimeMs < cutoff) {
        await fs.promises.rm(full, { recursive: true, force: true });
      }
    } catch {
      // best effort
    }
  }
}
