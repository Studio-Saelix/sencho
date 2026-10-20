/**
 * A recovery replay reads the live interpolation environment before it restores
 * anything, because the same inventory decides which paths are safe. An env
 * file that changed type after capture used to hold that read forever (a FIFO
 * with no writer), so the failure was a hang rather than a named input.
 *
 * The regression is invisible to an in-process timeout: the blocked read sits
 * in the libuv pool and the worker never gets to report it. Each case therefore
 * runs the real capture/restore context in a child with an external deadline,
 * and the child patches `spawn` so reaching Compose is an observable failure.
 */
import { describe, expect, it } from 'vitest';
import path from 'path';
import { spawn } from 'child_process';

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const HARNESS_PATH = path.join(__dirname, 'helpers', 'env-input-refusal-harness.ts');
const HARNESS_DEADLINE_MS = 30_000;
// Each child cold-boots the service graph; the deadline is the hang detector,
// not a performance budget, so the test timeout stays above it.
const HARNESS_TEST_TIMEOUT_MS = 60_000;

interface HarnessRun {
  timedOut: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runHarness(scenario: string): Promise<HarnessRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', HARNESS_PATH, scenario], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, HARNESS_DEADLINE_MS);
    child.once('close', (exitCode, signal) => {
      clearTimeout(deadline);
      resolve({ timedOut, exitCode, signal, stdout, stderr });
    });
  });
}

function harnessResult(run: HarnessRun): Record<string, unknown> {
  const line = run.stdout.split('\n').find((entry) => entry.startsWith('HARNESS_RESULT '));
  if (!line) throw new Error(`no HARNESS_RESULT in output:\n${run.stdout}\n${run.stderr}`);
  return JSON.parse(line.slice('HARNESS_RESULT '.length)) as Record<string, unknown>;
}

describe('recovery refuses an interpolation env input that is not a regular file', () => {
  it.skipIf(process.platform === 'win32')(
    'refuses a listed env file that became a FIFO instead of blocking the restore read',
    async () => {
      const run = await runHarness('restore-listed-fifo');

      expect(run.timedOut).toBe(false);
      expect(run.exitCode).toBe(0);
      expect(run.stdout).not.toContain('COMPOSE_SPAWN_ATTEMPTED');
      expect(harnessResult(run)).toMatchObject({
        scenario: 'restore-listed-fifo',
        outcome: 'restore-refused',
        code: 'NOT_A_FILE',
        bytesUnchanged: true,
      });
    },
    HARNESS_TEST_TIMEOUT_MS,
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a project .env that became a FIFO instead of blocking the restore read',
    async () => {
      const run = await runHarness('restore-project-env-fifo');

      expect(run.timedOut).toBe(false);
      expect(run.exitCode).toBe(0);
      expect(run.stdout).not.toContain('COMPOSE_SPAWN_ATTEMPTED');
      expect(harnessResult(run)).toMatchObject({
        scenario: 'restore-project-env-fifo',
        outcome: 'restore-refused',
        code: 'NOT_A_FILE',
        bytesUnchanged: true,
      });
    },
    HARNESS_TEST_TIMEOUT_MS,
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a FIFO that is already in place when the capture starts',
    async () => {
      const run = await runHarness('capture-listed-fifo');

      expect(run.timedOut).toBe(false);
      expect(run.exitCode).toBe(0);
      expect(run.stdout).not.toContain('COMPOSE_SPAWN_ATTEMPTED');
      expect(harnessResult(run)).toMatchObject({
        scenario: 'capture-listed-fifo',
        outcome: 'capture-refused',
        code: 'ROLLBACK_COVERAGE_UNAVAILABLE',
        bytesUnchanged: true,
      });
    },
    HARNESS_TEST_TIMEOUT_MS,
  );

  it.skipIf(process.platform === 'win32')(
    'still restores a stack whose listed env file stays regular',
    async () => {
      const run = await runHarness('restore-listed-regular');

      expect(run.timedOut).toBe(false);
      expect(run.exitCode).toBe(0);
      expect(harnessResult(run)).toMatchObject({
        scenario: 'restore-listed-regular',
        outcome: 'restored',
        bytesUnchanged: true,
      });
    },
    HARNESS_TEST_TIMEOUT_MS,
  );

  it.skipIf(process.platform === 'win32')(
    'still restores a stack whose listed env file is a link inside the compose root',
    async () => {
      const run = await runHarness('restore-listed-linked');

      expect(run.timedOut).toBe(false);
      expect(run.exitCode).toBe(0);
      expect(harnessResult(run)).toMatchObject({
        scenario: 'restore-listed-linked',
        outcome: 'restored',
        bytesUnchanged: true,
      });
    },
    HARNESS_TEST_TIMEOUT_MS,
  );
});
