/**
 * Docker-backed: interactive exec output must not carry Docker's multiplex
 * stream frame headers. The exec is created with Tty: true, but the daemon
 * picks stream framing from the *start* request's Tty, so DockerController
 * must repeat it there. Without it every output chunk arrives as
 * `01 00 00 00 <len32>` + payload. Skipped when Docker is unavailable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { setupTestDb, cleanupTestDb } from '../helpers/setupTestDb';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], {
      stdio: 'ignore',
      timeout: 8_000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function docker(args: string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

const hasDocker = dockerAvailable();
const TYPED_COMMAND = 'echo __SENCHO_FRAME_$((6*7))';
/** Only the evaluated arithmetic can produce this, not the PTY echo of the typed command. */
const EVALUATED_OUTPUT = '__SENCHO_FRAME_42\r\n';
const CONTAINER_NAME = `sencho-exec-tty-stream-test-${process.pid}`;

/** Docker's multiplex header: stream type (1=stdout, 2=stderr) + 3 zeros + length. */
const FRAME_HEADER = /[\u0001\u0002]\u0000\u0000\u0000/;

function createMockWs(sent: string[]): WebSocket {
  const ws = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN,
    send: (data: string) => { sent.push(data); },
    close: () => {},
    terminate: () => {},
    ping: () => {},
    pong: () => {},
  });
  return ws as unknown as WebSocket;
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for exec output');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(!hasDocker)('interactive exec stream is not multiplex-framed', () => {
  let tmpDir: string;
  let containerId: string;
  let nodeId: number;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    const { DatabaseService } = await import('../../services/DatabaseService');
    const local = DatabaseService.getInstance().getDefaultNode();
    if (!local?.id) throw new Error('Test DB has no default local node');
    nodeId = local.id;

    execFileSync('docker', ['pull', 'busybox:1.36.1'], { stdio: 'ignore' });
    try {
      docker(['rm', '-f', CONTAINER_NAME]);
    } catch {
      // No stale container to remove.
    }
    containerId = docker(['run', '-d', '--name', CONTAINER_NAME, 'busybox:1.36.1', 'sleep', '3600']);
    expect(containerId.length).toBeGreaterThan(0);
  }, 300_000);

  afterAll(async () => {
    try {
      if (containerId) docker(['rm', '-f', containerId]);
    } catch {
      // Best-effort cleanup.
    }
    if (tmpDir) cleanupTestDb(tmpDir);
  }, 120_000);

  it('delivers shell output with no frame header in any chunk', async () => {
    const sent: string[] = [];
    const ws = createMockWs(sent);

    try {
      const { default: DockerController } = await import('../../services/DockerController');
      await DockerController.getInstance(nodeId).execContainer(containerId, ws);

      (ws as unknown as EventEmitter).emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'input', data: `${TYPED_COMMAND}\n` })),
      );

      // The PTY echoes the typed command, so wait for the evaluated output,
      // which only the shell itself can produce.
      await waitFor(() => sent.join('').includes(EVALUATED_OUTPUT));

      const output = sent.join('');
      expect(output).toContain(EVALUATED_OUTPUT);
      expect(output).not.toMatch(FRAME_HEADER);
    } finally {
      (ws as unknown as EventEmitter).emit('close');
    }
  }, 60_000);
});
