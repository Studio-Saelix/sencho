/**
 * Docker-backed: the endpoint replacement helper runs as root even when Sencho
 * itself runs as SENCHO_USER. Every handoff file it publishes (the rollback
 * snapshot, the recreation marker and the outcome) must stay owner-only and be
 * readable by the application uid, or a non-root Sencho cannot read the marker
 * it is waiting for.
 *
 * The unit test in handoff-file.test.ts records the chmod/chown calls through a
 * fake filesystem. This test proves the real result: a root process runs the
 * checked-in writeHandoffJson, and a separate process running as the application
 * uid reads the files back. The reader is a fixed unprivileged uid rather than
 * the test runner's uid, so the test also proves the chown when the CI runner
 * itself is root. Without the chown the files stay root-owned 0600 and the
 * reader fails with EACCES. Skipped when Docker is unavailable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 8_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = dockerAvailable();
const IMAGE = 'node:26.12.1-alpine';
const HELPER_SOURCE = path.resolve(__dirname, '../../helpers/handoffFile.ts');
/** An unprivileged uid/gid that stands in for a Sencho running as SENCHO_USER. */
const APPLICATION_UID = 65534;
const APPLICATION_GID = 65534;
const FILES = [
  ['snapshot.json', { id: 'snapshot' }],
  ['provider-recreated.json', { operationId: 'op' }],
  ['outcome.json', { ok: true }],
] as const;

describe.skipIf(!hasDocker || process.platform !== 'linux')(
  'a root helper writes handoff files the application uid can read',
  () => {
    let tmpDir: string;
    let containerName: string;

    beforeAll(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-handoff-cross-uid-'));
      // The helper writes into Sencho's data directory. Traversal is all the
      // reader needs from the directory; the file itself stays 0600.
      await fs.chmod(tmpDir, 0o755);
      containerName = `sencho-handoff-cross-uid-${process.pid}`;
      try {
        execFileSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
      } catch {
        // No stale container to remove.
      }
      execFileSync('docker', ['pull', IMAGE], { stdio: 'ignore', timeout: 300_000 });
    }, 300_000);

    afterAll(async () => {
      try {
        if (containerName) execFileSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
      } catch {
        // Best-effort cleanup; the container uses --rm anyway.
      }
      if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    }, 120_000);

    it('reads root-written files as the application uid', async () => {
      const writeScript = [
        "import { writeHandoffJson } from '/code/handoffFile.mts';",
        `const owner = { uid: ${APPLICATION_UID}, gid: ${APPLICATION_GID} };`,
        // The attached stage helper writes the snapshot; the detached replace
        // helper writes the marker and the terminal outcome.
        ...FILES.map(([name, value]) => `await writeHandoffJson('/handoff/${name}', ${JSON.stringify(value)}, owner);`),
      ].join('\n');

      execFileSync('docker', [
        'run', '--rm', '--name', containerName,
        // Mount the checked-in helper source under an ESM TypeScript name:
        // backend/package.json declares type=commonjs, so a .ts mount would be
        // loaded as CommonJS while the source uses import syntax.
        '-v', `${HELPER_SOURCE}:/code/handoffFile.mts:ro`,
        '-v', `${tmpDir}:/handoff:rw`,
        IMAGE,
        'node', '--input-type=module', '-e', writeScript,
      ], { encoding: 'utf8', timeout: 120_000 });

      for (const [name] of FILES) {
        const info = await fs.stat(path.join(tmpDir, name));
        expect({ uid: info.uid, gid: info.gid }).toEqual({ uid: APPLICATION_UID, gid: APPLICATION_GID });
        expect(info.mode & 0o777).toBe(0o600);
      }

      // Read them from a process that is not root and does not own the files.
      const readScript = [
        "import fs from 'fs/promises';",
        `const names = ${JSON.stringify(FILES.map(([name]) => name))};`,
        'const read = {};',
        "for (const name of names) read[name] = JSON.parse(await fs.readFile('/handoff/' + name, 'utf8'));",
        'console.log(JSON.stringify(read));',
      ].join('\n');
      const readBack = JSON.parse(execFileSync('docker', [
        'run', '--rm', '--user', `${APPLICATION_UID}:${APPLICATION_GID}`,
        '-v', `${tmpDir}:/handoff:ro`,
        IMAGE,
        'node', '--input-type=module', '-e', readScript,
      ], { encoding: 'utf8', timeout: 120_000 }).trim()) as Record<string, unknown>;

      expect(readBack).toEqual(Object.fromEntries(FILES));
      // The root helper must not leave its temporary files behind.
      expect((await fs.readdir(tmpDir)).sort()).toEqual(FILES.map(([name]) => name).sort());
    }, 180_000);
  },
);
