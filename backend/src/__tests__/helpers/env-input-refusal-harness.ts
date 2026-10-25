/**
 * Standalone capture/restore driver for the interpolation env refusal tests.
 *
 * A regression here blocks inside a filesystem read that no in-process test
 * timeout can interrupt, so the spec spawns this file as a child with an
 * external deadline and reads its exit status. The child also patches `spawn`
 * with a distinct exit code, so a future change that reaches Compose during one
 * of these scenarios fails loudly instead of waiting on a real CLI; the
 * production guard itself is asserted by the in-process recovery-spawn tests.
 *
 * Usage: node -r ts-node/register/transpile-only env-input-refusal-harness.ts <scenario>
 *
 * Scenarios:
 *   restore-listed-fifo      COMPOSE_ENV_FILES file captured regular, then FIFO
 *   restore-project-env-fifo project .env captured regular, then FIFO
 *   capture-listed-fifo      COMPOSE_ENV_FILES file already a FIFO at capture
 *   restore-listed-regular   COMPOSE_ENV_FILES file regular throughout
 *   restore-listed-linked    in-root linked COMPOSE_ENV_FILES file throughout
 *   restore-unrelated-selection-fifo
 *                            captured old.env, current selection a FIFO new.env
 *   restore-project-env-escaping-fifo
 *                            captured .env, then a link to a FIFO outside the root
 *   restore-process-env-outside-fifo
 *                            captured with no env file, then COMPOSE_ENV_FILES
 *                            names a FIFO outside the compose root
 */
import fs from 'fs';
import path from 'path';
import childProcess, { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { setupTestDb, cleanupTestDb } from './setupTestDb';

childProcess.spawn = ((..._args: unknown[]) => {
  process.stdout.write('COMPOSE_SPAWN_ATTEMPTED\n');
  process.exit(90);
  return undefined as never;
}) as unknown as typeof childProcess.spawn;

type Scenario =
  | 'restore-listed-fifo'
  | 'restore-project-env-fifo'
  | 'capture-listed-fifo'
  | 'restore-listed-regular'
  | 'restore-listed-linked'
  | 'restore-unrelated-selection-fifo'
  | 'restore-project-env-escaping-fifo'
  | 'restore-process-env-outside-fifo';

const SCENARIOS: Scenario[] = [
  'restore-listed-fifo',
  'restore-project-env-fifo',
  'capture-listed-fifo',
  'restore-listed-regular',
  'restore-listed-linked',
  'restore-unrelated-selection-fifo',
  'restore-project-env-escaping-fifo',
  'restore-process-env-outside-fifo',
];

/**
 * Every path under the stack with a stable description of its bytes. A FIFO is
 * described by its type alone: reading it to hash its content is the wait this
 * harness exists to detect.
 */
function snapshotTree(root: string): string {
  const lines: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      const rel = path.join(prefix, entry.name);
      if (entry.isDirectory()) {
        lines.push(`${rel} dir`);
        walk(abs, rel);
      } else if (entry.isFile()) {
        const digest = createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
        lines.push(`${rel} file ${digest}`);
      } else if (entry.isSymbolicLink()) {
        lines.push(`${rel} link ${fs.readlinkSync(abs)}`);
      } else {
        lines.push(`${rel} other`);
      }
    }
  };
  walk(root, '');
  return lines.join('\n');
}

function fail(reason: string): never {
  process.stdout.write(`HARNESS_FAILURE ${reason}\n`);
  process.exit(1);
}

async function runScenario(scenario: Scenario): Promise<Record<string, unknown>> {
  const composeDir = process.env.COMPOSE_DIR!;
  const stackName = 'env-input';
  const stackDir = path.join(composeDir, stackName);
  fs.mkdirSync(stackDir, { recursive: true });
  fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n', 'utf8');

  const unrelatedSelection = scenario === 'restore-unrelated-selection-fifo';
  const usesProjectEnv = scenario === 'restore-project-env-fifo'
    || scenario === 'restore-project-env-escaping-fifo'
    || scenario === 'restore-process-env-outside-fifo';
  const envFile = path.join(stackDir, usesProjectEnv ? '.env' : unrelatedSelection ? 'old.env' : 'operator.env');
  if (!unrelatedSelection) {
    if (scenario === 'restore-listed-linked') {
      const sharedDir = path.join(composeDir, 'shared');
      fs.mkdirSync(sharedDir, { recursive: true });
      fs.writeFileSync(path.join(sharedDir, 'operator.env'), 'MARK=shared\n', 'utf8');
      fs.symlinkSync(path.join(sharedDir, 'operator.env'), envFile);
    } else {
      fs.writeFileSync(envFile, 'MARK=captured\n', 'utf8');
    }
    if (!usesProjectEnv) process.env.COMPOSE_ENV_FILES = path.basename(envFile);
  }

  const { DatabaseService } = await import('../../services/DatabaseService');
  const nodeId = DatabaseService.getInstance().getDefaultNode()?.id;
  if (!nodeId) fail('no default node in the test database');
  if (unrelatedSelection) {
    fs.writeFileSync(envFile, 'MARK=captured\n', 'utf8');
    DatabaseService.getInstance().setStackProjectEnvFiles(nodeId, stackName, ['old.env']);
  }
  const { resolveComposeProjectContext } = await import('../../services/composeProjectContext');
  const context = await resolveComposeProjectContext(nodeId, stackName);

  if (scenario === 'capture-listed-fifo') {
    // The invalid input is already in place, so the capture must refuse
    // without ever reading it.
    fs.rmSync(envFile);
    execFileSync('mkfifo', [envFile]);
    const before = snapshotTree(stackDir);
    const captureError = await context.backupFromContext('deployment').then(
      () => null,
      (error: unknown) => error as NodeJS.ErrnoException,
    );
    if (captureError === null) fail('capture accepted a FIFO interpolation env file');
    if (captureError.code !== 'ROLLBACK_COVERAGE_UNAVAILABLE') {
      fail(`capture refused with ${String(captureError.code)} instead of ROLLBACK_COVERAGE_UNAVAILABLE`);
    }
    if (!String(captureError.message).includes('operator.env')) {
      fail(`capture refusal does not name the invalid file: ${captureError.message}`);
    }
    if (snapshotTree(stackDir) !== before) fail('capture changed the project bytes');
    return { scenario, outcome: 'capture-refused', code: captureError.code, bytesUnchanged: true };
  }

  const generationId = await context.backupFromContext('deployment');
  if (!generationId) fail('capture returned no generation id');

  if (
    scenario === 'restore-listed-fifo'
    || scenario === 'restore-project-env-fifo'
    || scenario === 'restore-project-env-escaping-fifo'
  ) {
    if (scenario === 'restore-project-env-escaping-fifo') {
      // The project .env is now a link to a FIFO outside the compose root. The
      // containment guard cannot classify it by reading, so the restore has to
      // judge the target's type without opening it.
      const outsideDir = path.join(path.dirname(composeDir), 'outside-env');
      fs.mkdirSync(outsideDir, { recursive: true });
      const outsideFifo = path.join(outsideDir, 'secret.env');
      execFileSync('mkfifo', [outsideFifo]);
      fs.rmSync(envFile);
      fs.symlinkSync(outsideFifo, envFile);
    } else {
      fs.rmSync(envFile);
      execFileSync('mkfifo', [envFile]);
    }
    // Snapshot the state the restore actually starts from: the replacement
    // itself is an intended change, anything after it is not.
    const before = snapshotTree(stackDir);
    const restoreError = await context.restoreFromContext().then(
      () => null,
      (error: unknown) => error as NodeJS.ErrnoException,
    );
    if (restoreError === null) fail('restore accepted a FIFO interpolation env file');
    if (restoreError.code !== 'NOT_A_FILE') {
      fail(`restore refused with ${String(restoreError.code)} instead of NOT_A_FILE`);
    }
    if (!String(restoreError.message).includes(usesProjectEnv ? '.env' : 'operator.env')) {
      fail(`restore refusal does not name the invalid file: ${restoreError.message}`);
    }
    if (snapshotTree(stackDir) !== before) fail('restore changed the project bytes before refusing');
    return { scenario, outcome: 'restore-refused', code: restoreError.code, bytesUnchanged: true };
  }

  if (scenario === 'restore-process-env-outside-fifo') {
    // A file the operator's own COMPOSE_ENV_FILES names, outside the compose
    // root, that became a FIFO after capture. Compose reads it wherever it
    // points, so the restore has to refuse before moving project files.
    const outsideDir = path.join(path.dirname(composeDir), 'outside-process-env');
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsideFifo = path.join(outsideDir, 'process.env');
    execFileSync('mkfifo', [outsideFifo]);
    process.env.COMPOSE_ENV_FILES = outsideFifo;
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: busybox\n', 'utf8');

    const before = snapshotTree(stackDir);
    const restoreError = await context.restoreFromContext().then(
      () => null,
      (error: unknown) => error as NodeJS.ErrnoException,
    );
    if (restoreError === null) fail('restore accepted an outside FIFO named by COMPOSE_ENV_FILES');
    if (restoreError.code !== 'NOT_A_FILE') {
      fail(`restore refused with ${String(restoreError.code)} instead of NOT_A_FILE`);
    }
    if (!String(restoreError.message).includes('process.env')) {
      fail(`restore refusal does not name the invalid file: ${restoreError.message}`);
    }
    if (snapshotTree(stackDir) !== before) fail('restore changed the project bytes before refusing');
    return { scenario, outcome: 'restore-refused', code: restoreError.code, bytesUnchanged: true };
  }

  if (unrelatedSelection) {
    // A live selection the rollback never reads, on top of a file that appeared
    // after capture. Neither may stop the restore or be deleted by it.
    const newEnv = path.join(stackDir, 'new.env');
    execFileSync('mkfifo', [newEnv]);
    DatabaseService.getInstance().setStackProjectEnvFiles(nodeId, stackName, ['new.env']);
    const capturedCompose = 'services:\n  web:\n    image: nginx\n';
    fs.writeFileSync(
      path.join(stackDir, 'compose.yaml'),
      'services:\n  web:\n    image: busybox\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(stackDir, 'compose.override.yaml'),
      'services:\n  web:\n    image: alpine\n',
      'utf8',
    );

    await context.restoreFromContext();

    if (fs.readFileSync(path.join(stackDir, 'compose.yaml'), 'utf8') !== capturedCompose) {
      fail('restore did not write the captured compose file back');
    }
    if (!fs.statSync(newEnv).isFIFO()) fail('restore changed the unrelated live selection');
    if (!fs.existsSync(path.join(stackDir, 'compose.override.yaml'))) {
      fail('restore deleted a live path the unusable selection could not classify');
    }

    const { RollbackGenerationStore } = await import('../../services/RollbackGenerationStore');
    const { ComposeService } = await import('../../services/ComposeService');
    const stored = await RollbackGenerationStore.readVerifiedGeneration(nodeId, stackName, generationId);
    const args = await ComposeService.getInstance(nodeId).buildComposeArgsWithRecoveryOverride(
      stackName,
      ['up', '-d'],
      path.join(stackDir, '.sencho-recovery-aaaaaaaaaaaa.yml'),
      stored.invocation,
    );
    if (!args.includes(envFile)) fail('recovery args do not replay the captured env file');
    if (args.includes(newEnv)) fail('recovery args name the unrelated live selection');
    return { scenario, outcome: 'restored-unrelated-selection', bytesUnchanged: true };
  }

  const before = snapshotTree(stackDir);
  await context.restoreFromContext();
  // A supported partial input stays live: the link is still a link and the
  // regular file is still the same bytes.
  if (snapshotTree(stackDir) !== before) fail('supported restore changed the project bytes');
  return { scenario, outcome: 'restored', bytesUnchanged: true };
}

async function main(): Promise<void> {
  const scenario = process.argv[2] as Scenario | undefined;
  if (!scenario || !SCENARIOS.includes(scenario)) fail(`unknown scenario ${JSON.stringify(scenario)}`);

  delete process.env.COMPOSE_ENV_FILES;
  delete process.env.COMPOSE_FILE;
  delete process.env.COMPOSE_DISABLE_ENV_FILE;

  const tmpDir = await setupTestDb();
  let exitCode = 0;
  try {
    const result = await runScenario(scenario);
    process.stdout.write(`HARNESS_RESULT ${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`HARNESS_FAILURE ${(error as Error).stack ?? String(error)}\n`);
    exitCode = 1;
  } finally {
    cleanupTestDb(tmpDir);
  }
  process.exit(exitCode);
}

void main();
