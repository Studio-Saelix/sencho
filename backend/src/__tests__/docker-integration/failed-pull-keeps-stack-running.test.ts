/**
 * Docker-backed integration: a failed pull must leave the running stack untouched.
 * Skipped automatically when Docker is unavailable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb } from '../helpers/setupTestDb';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = dockerAvailable();
const STACK = 'fpkeep';

function compose(args: string[], cwd: string): string {
  return execFileSync('docker', ['compose', '-p', STACK, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe.skipIf(!hasDocker)('failed pull keeps stack running', () => {
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

    compose(['up', '-d', '--pull', 'always'], stackDir);
  }, 180_000);

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

  it('leaves the original container running when ComposeService updateStack pull fails', async () => {
    const beforeId = compose(['ps', '-q'], stackDir).trim();
    expect(beforeId.length).toBeGreaterThan(0);

    const beforeInspect = JSON.parse(
      execFileSync('docker', ['inspect', beforeId], { encoding: 'utf8' }),
    ) as Array<{ State: { Running: boolean; Status: string } }>;
    expect(beforeInspect[0].State.Running).toBe(true);

    fs.writeFileSync(
      path.join(stackDir, 'compose.yaml'),
      [
        'services:',
        '  web:',
        '    image: busybox:sencho-does-not-exist-fpkeep-xyz',
        '    command: ["sleep", "3600"]',
        '',
      ].join('\n'),
      'utf8',
    );

    const { StackUpdateRecoveryService } = await import('../../services/StackUpdateRecoveryService');
    StackUpdateRecoveryService.resetForTests();
    const { ComposeService } = await import('../../services/ComposeService');
    await expect(
      ComposeService.getInstance(nodeId).updateStack(STACK, undefined, true),
    ).rejects.toThrow();

    const afterId = compose(['ps', '-q'], stackDir).trim();
    expect(afterId).toBe(beforeId);

    const afterInspect = JSON.parse(
      execFileSync('docker', ['inspect', beforeId], { encoding: 'utf8' }),
    ) as Array<{ State: { Running: boolean } }>;
    expect(afterInspect[0].State.Running).toBe(true);
  }, 180_000);
});
