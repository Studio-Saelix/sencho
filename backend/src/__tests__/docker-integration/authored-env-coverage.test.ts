/**
 * Docker-backed: an authored recovery generation has to say which env files it
 * does not hold, on the same terms the Git inventory does.
 *
 * Mesh injects its own `-f` list, so the layer set is pinned and the stack still
 * captures while the layer-selection reader cannot decide what COMPOSE_FILE
 * holds. The interpolation environment is a separate question: Compose loads
 * COMPOSE_ENV_FILES for it, and a file outside the compose root is one Sencho's
 * containment refuses to read while Compose reads it anyway. A generation that
 * certifies complete coverage while that file stays live promises an exact
 * restore it cannot make, so this case captures a real generation, changes the
 * operator env file, restores, and renders the captured invocation with the
 * real CLI.
 *
 * Skipped automatically when Docker is unavailable.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb } from '../helpers/setupTestDb';
import { generateOverrideYaml } from '../../services/MeshComposeOverride';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 8_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = dockerAvailable();

const STACK = 'authoredenvcoverage';

const COMPOSE = [
  'services:',
  '  web:',
  '    image: busybox:1.36.1',
  '    command: ["echo","${MARK}"]',
  '',
].join('\n');

describe.skipIf(!hasDocker)('an authored generation records the env files it does not hold', () => {
  let tmpDir: string;
  let composeDir: string;
  let stackDir: string;
  let externalEnv: string;
  let insideEnv: string;
  let nodeId: number;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    composeDir = process.env.COMPOSE_DIR!;
    stackDir = path.join(composeDir, STACK);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), COMPOSE, 'utf8');
    // The operator's own file, outside the compose root the stack is confined
    // to, which is what makes Sencho's reader refuse it.
    externalEnv = path.join(tmpDir, 'operator.env');
    fs.writeFileSync(externalEnv, 'MARK=captured\n', 'utf8');
    // A later entry in the same list, inside the stack. The reader stops at the
    // first one it cannot read, so this name has to be accounted for from the
    // list Compose was given rather than from anything it read.
    insideEnv = path.join(stackDir, 'later.env');
    fs.writeFileSync(insideEnv, 'OTHER=one\n', 'utf8');

    const { DatabaseService } = await import('../../services/DatabaseService');
    const db = DatabaseService.getInstance();
    const local = db.getDefaultNode();
    if (!local?.id) throw new Error('Test DB has no default local node');
    nodeId = local.id;
    // Mesh pins the layer set, so an undecidable layer-selection reader does not
    // refuse the capture: the generation still describes the layers it ran.
    db.insertMeshStack(nodeId, STACK, null);
  }, 120_000);

  afterAll(() => {
    if (tmpDir) cleanupTestDb(tmpDir);
  });

  it('lists a readable external env file as omitted and renders its current content on restore', async () => {
    // The variable is process state another test file can inherit, so the
    // previous value is put back rather than assumed absent.
    const priorEnvFiles = process.env.COMPOSE_ENV_FILES;
    process.env.COMPOSE_ENV_FILES = `${externalEnv},${insideEnv}`;
    const overridePath = path.join(tmpDir, `${STACK}.override.yml`);
    fs.writeFileSync(
      overridePath,
      generateOverrideYaml({ services: ['web'], aliases: [], senchoIp: '172.30.0.2' }),
      'utf8',
    );
    const { MeshService } = await import('../../services/MeshService');
    vi.spyOn(MeshService.getInstance(), 'ensureStackOverride').mockResolvedValue(overridePath);
    try {
      const { resolveRollbackInventory } = await import('../../services/rollbackInventory');
      const { RollbackGenerationStore } = await import('../../services/RollbackGenerationStore');
      const { describeRollbackManagedInputs, storedRestoreCoverage } = await import('../../services/updateGuard/readiness');
      const { resolveComposeProjectContextForGeneration } = await import('../../services/composeProjectContext');
      const { composeFileEnvVarSelection } = await import('../../utils/authoredComposeArgs');
      const { ComposeService } = await import('../../services/ComposeService');

      // The reader cannot decide what COMPOSE_FILE holds, because the file the
      // list names is outside the containment root it may read. Both names are
      // still reported, including the one after the file it stopped at.
      const selection = await composeFileEnvVarSelection(STACK, nodeId);
      expect(selection.kind).toBe('unknown');
      expect(selection.loadedEnvFiles).toEqual([externalEnv, insideEnv]);

      const inventory = await resolveRollbackInventory(nodeId, STACK);
      expect(inventory.coverageRefusal).toBeNull();
      // Compose loads the listed files on top of the -f list Mesh pins, so the
      // generation has to say it does not hold them.
      expect(inventory.uncapturedInputs).toEqual([
        'operator.env is loaded by Compose for interpolation from outside the stack directory and is not captured',
        'later.env is loaded by Compose for interpolation and is not captured',
      ]);
      // A path outside the stack cannot be protected by a relative name, so it
      // is only named in the notes; the in-stack one joins the list a restore
      // never deletes.
      expect(inventory.uncapturedRelativePaths).toEqual(['later.env']);

      const generationId = randomUUID();
      await RollbackGenerationStore.captureGeneration({
        nodeId,
        stackName: STACK,
        generationId,
        inventory,
      });
      const stored = await RollbackGenerationStore.readVerifiedGeneration(nodeId, STACK, generationId);
      expect(storedRestoreCoverage(stored)).toBe('omits_inputs');
      const managedInputs = describeRollbackManagedInputs({
        coverage: 'omits_inputs',
        stored,
        live: inventory,
      });
      expect(managedInputs).toMatchObject({ covered: false });
      expect(managedInputs !== 'error' ? managedInputs.detail : '').toContain('operator.env');

      // The operator moves the env file on. No generation holds the old value,
      // so the rollback reads the current one, which is what the recorded
      // omission says.
      fs.writeFileSync(externalEnv, 'MARK=changed\n', 'utf8');
      // A layer that appeared after capture. Live discovery lists it, but a
      // partial generation cannot claim it is stale managed content, because an
      // uncaptured input can be the file that names it.
      const lateOverride = path.join(stackDir, 'compose.override.yml');
      fs.writeFileSync(
        lateOverride,
        'services:\n  web:\n    environment:\n      - LATE=1\n',
        'utf8',
      );

      const ctx = await resolveComposeProjectContextForGeneration(nodeId, STACK, generationId);
      await ctx.restoreFromContext();
      expect(fs.readFileSync(externalEnv, 'utf8')).toBe('MARK=changed\n');
      // The in-stack listed file is a recorded omission, so the restore leaves
      // it alone even though live discovery lists it.
      expect(fs.readFileSync(insideEnv, 'utf8')).toBe('OTHER=one\n');
      expect(fs.readFileSync(lateOverride, 'utf8')).toContain('LATE=1');
      fs.rmSync(lateOverride, { force: true });

      const recoveryLayer = path.join(stackDir, '.sencho-recovery-test.yml');
      fs.writeFileSync(
        recoveryLayer,
        'services:\n  web:\n    labels:\n      sencho.recovery-test: "1"\n',
        'utf8',
      );
      const args = await ComposeService.getInstance(nodeId).buildComposeArgsWithRecoveryOverride(
        STACK,
        ['config'],
        recoveryLayer,
        stored.invocation,
      );
      const prefix = args.slice(1, args.indexOf('config'));
      const rendered = JSON.parse(execFileSync(
        'docker',
        ['compose', '-p', STACK, ...prefix, 'config', '--format', 'json'],
        { cwd: stackDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )) as { services: { web: { command: string[] } } };
      // The captured layers render with the file's current value, which is what
      // the recorded omission tells the operator.
      expect(rendered.services.web.command).toEqual(['echo', 'changed']);
    } finally {
      if (priorEnvFiles === undefined) delete process.env.COMPOSE_ENV_FILES;
      else process.env.COMPOSE_ENV_FILES = priorEnvFiles;
      vi.restoreAllMocks();
    }
  });
});
