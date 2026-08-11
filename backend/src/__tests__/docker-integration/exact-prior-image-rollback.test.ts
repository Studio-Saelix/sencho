/**
 * Docker-backed: recovery override must recreate containers whose inspected
 * Image ID equals the captured prior image ID (moving-tag case).
 * Skipped when Docker is unavailable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
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

const hasDocker = dockerAvailable();
const STACK = 'exactimg';

function compose(args: string[], cwd: string): string {
  return execFileSync('docker', ['compose', '-p', STACK, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function inspectImageId(containerId: string): string {
  const raw = execFileSync('docker', ['inspect', containerId, '--format', '{{.Image}}'], {
    encoding: 'utf8',
  }).trim();
  expect(raw.length).toBeGreaterThan(0);
  return raw;
}

describe.skipIf(!hasDocker)('exact prior-image rollback after post-handoff failure', () => {
  let tmpDir: string;
  let composeDir: string;
  let stackDir: string;
  let nodeId: number;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    composeDir = process.env.COMPOSE_DIR!;
    stackDir = path.join(composeDir, STACK);
    fs.mkdirSync(stackDir, { recursive: true });

    const { DatabaseService } = await import('../../services/DatabaseService');
    const db = DatabaseService.getInstance();
    const local = db.getDefaultNode();
    if (!local?.id) throw new Error('Test DB has no default local node');
    nodeId = local.id;
    db.updateGlobalSetting('prune_on_update', '0');

    execFileSync('docker', ['pull', 'busybox:1.36.1'], { stdio: 'ignore' });
    execFileSync('docker', ['pull', 'busybox:1.36.0'], { stdio: 'ignore' });

    fs.writeFileSync(
      path.join(stackDir, 'compose.yaml'),
      [
        'services:',
        '  web:',
        '    image: busybox:1.36.1',
        '    command: ["sleep", "3600"]',
        '',
      ].join('\n'),
      'utf8',
    );

    compose(['up', '-d', '--pull', 'never'], stackDir);
  }, 300_000);

  afterAll(async () => {
    try {
      if (stackDir && fs.existsSync(stackDir)) {
        compose(['down', '--remove-orphans'], stackDir);
      }
    } catch {
      // Best-effort cleanup.
    }
    if (tmpDir) cleanupTestDb(tmpDir);
  }, 120_000);

  it('restores a container whose inspected Image equals the captured prior image ID', async () => {
    const beforeId = compose(['ps', '-q'], stackDir).trim();
    expect(beforeId.length).toBeGreaterThan(0);
    const priorImageId = inspectImageId(beforeId);

    const { StackUpdateRecoveryService } = await import('../../services/StackUpdateRecoveryService');
    StackUpdateRecoveryService.resetForTests();
    const recoverySvc = StackUpdateRecoveryService.getInstance();

    // Capture while the prior runtime is still healthy.
    const candidate = await recoverySvc.captureCandidate({
      nodeId,
      stackName: STACK,
      createdBy: null,
      operationKind: 'update',
    });
    expect(candidate.override_path).toBeTruthy();
    expect(recoverySvc.handoff(candidate.id, nodeId, STACK)).toBe(true);

    // Simulate a post-handoff mutation that moves the tag / image identity.
    fs.writeFileSync(
      path.join(stackDir, 'compose.yaml'),
      [
        'services:',
        '  web:',
        '    image: busybox:1.36.0',
        '    command: ["sleep", "3600"]',
        '',
      ].join('\n'),
      'utf8',
    );
    compose(['up', '-d', '--pull', 'never', '--force-recreate'], stackDir);
    const midId = compose(['ps', '-q'], stackDir).trim();
    const midImageId = inspectImageId(midId);
    expect(midImageId).not.toBe(priorImageId);

    const { ComposeService } = await import('../../services/ComposeService');
    const rolledBack = await recoverySvc.compensateWithCandidate(
      candidate.id,
      (overridePath, invocation) => ComposeService.getInstance(nodeId).composeUpWithRecoveryOverride(
        STACK,
        overridePath,
        undefined,
        invocation,
      ),
    );
    expect(rolledBack).toBe(true);

    const afterId = compose(['ps', '-q'], stackDir).trim();
    expect(afterId.length).toBeGreaterThan(0);
    expect(inspectImageId(afterId)).toBe(priorImageId);

    const afterInspect = JSON.parse(
      execFileSync('docker', ['inspect', afterId], { encoding: 'utf8' }),
    ) as Array<{ State: { Running: boolean } }>;
    expect(afterInspect[0].State.Running).toBe(true);
  }, 300_000);
});
