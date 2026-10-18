/**
 * Restore has to select the project the generation captured. Live discovery at
 * restore time may name a newer Compose root, an implicit override, or a managed
 * input that only became a link after capture; none of them may decide what the
 * recovered stack runs, and none of them may leave a shared target deleted.
 *
 * The inventory here is the real one, so an ordinary authored stack is captured
 * with an empty compose prefix and docker compose auto-discovery, which is what
 * makes the wrong-root case reachable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';
import os from 'os';
import { promises as fsPromises } from 'fs';
import { randomUUID } from 'crypto';

const mockState = { composeDir: '', dataDir: '' };

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getComposeDir: () => mockState.composeDir,
      getDefaultNodeId: () => 1,
    }),
  },
}));

vi.mock('../utils/debug', () => ({ isDebugEnabled: () => false }));

vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({
      getGitSource: () => undefined,
      getStackProjectEnvFiles: () => [],
      isMeshStackEnabled: () => false,
    }),
  },
}));

import { resolveRollbackInventory } from '../services/rollbackInventory';
import { RollbackGenerationStore } from '../services/RollbackGenerationStore';
import { resolveComposeProjectContextForGeneration } from '../services/composeProjectContext';

const NODE = 1;

describe('restore selects the captured Compose project', () => {
  let composeDir: string;
  let dataDir: string;
  let stackDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    composeDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-sel-'));
    dataDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-seldata-'));
    mockState.composeDir = composeDir;
    mockState.dataDir = dataDir;
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
    stackDir = path.join(composeDir, 'app');
    await fsPromises.mkdir(stackDir, { recursive: true });
  });

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    await fsPromises.rm(composeDir, { recursive: true, force: true });
    await fsPromises.rm(dataDir, { recursive: true, force: true });
  });

  it('restores a partial generation without a later compose root or override shadowing it', async () => {
    await fsPromises.mkdir(path.join(composeDir, 'shared'), { recursive: true });
    await fsPromises.writeFile(path.join(composeDir, 'shared', 'base.yaml'), 'services: {}\n', 'utf8');
    await fsPromises.writeFile(
      path.join(stackDir, 'docker-compose.yml'),
      'include:\n  - path: ../shared/base.yaml\nservices:\n  web:\n    image: nginx\n',
      'utf8',
    );

    const captured = await resolveRollbackInventory(NODE, 'app');
    expect(captured.coverageRefusal).toBeNull();
    // Partial on purpose: the shared include is a recorded omission.
    expect(captured.uncapturedInputs.length).toBeGreaterThan(0);

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'app',
      generationId,
      inventory: captured,
    });
    const manifest = await RollbackGenerationStore.readVerifiedGeneration(NODE, 'app', generationId);
    expect(manifest.invocation.composeArgsPrefix).toEqual([]);
    expect(manifest.invocation.explicitComposeFiles).toEqual(['docker-compose.yml']);

    // A later edit adds a higher-priority root and an implicit override.
    await fsPromises.writeFile(
      path.join(stackDir, 'compose.yaml'),
      'services:\n  web:\n    image: nginx\n    command: ["false"]\n',
      'utf8',
    );
    await fsPromises.writeFile(
      path.join(stackDir, 'docker-compose.override.yml'),
      'services:\n  web:\n    command: ["false"]\n',
      'utf8',
    );

    const ctx = await resolveComposeProjectContextForGeneration(NODE, 'app', generationId);
    await ctx.restoreFromContext();

    const restored = await fsPromises.readFile(path.join(stackDir, 'docker-compose.yml'), 'utf8');
    expect(restored).toBe('include:\n  - path: ../shared/base.yaml\nservices:\n  web:\n    image: nginx\n');
    // Only one root may survive, or docker compose auto-discovery picks the
    // wrong one for the next ordinary action as well as for recovery.
    await expect(fsPromises.lstat(path.join(stackDir, 'compose.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsPromises.lstat(path.join(stackDir, 'docker-compose.override.yml'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a link that was deliberately left out of the capture', async () => {
    await fsPromises.mkdir(path.join(composeDir, 'shared'), { recursive: true });
    await fsPromises.writeFile(path.join(composeDir, 'shared', 'base.yaml'), 'services: {}\n', 'utf8');
    await fsPromises.writeFile(path.join(composeDir, 'shared', 'common.env'), 'A=1\n', 'utf8');
    await fsPromises.symlink(path.join(composeDir, 'shared', 'base.yaml'), path.join(stackDir, 'linked.yaml'));
    await fsPromises.writeFile(
      path.join(stackDir, 'docker-compose.yml'),
      'include:\n  - ./linked.yaml\nservices:\n  web:\n    image: nginx\n',
      'utf8',
    );

    const captured = await resolveRollbackInventory(NODE, 'app');
    expect(captured.coverageRefusal).toBeNull();
    expect(captured.uncapturedRelativePaths).toContain('linked.yaml');

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'app',
      generationId,
      inventory: captured,
    });

    const ctx = await resolveComposeProjectContextForGeneration(NODE, 'app', generationId);
    await ctx.restoreFromContext();

    expect((await fsPromises.lstat(path.join(stackDir, 'linked.yaml'))).isSymbolicLink()).toBe(true);
  });

  it('removes a managed env path that became a link after capture and keeps its target', async () => {
    await fsPromises.mkdir(path.join(composeDir, 'shared'), { recursive: true });
    await fsPromises.writeFile(path.join(composeDir, 'shared', 'common.env'), 'A=1\n', 'utf8');
    await fsPromises.writeFile(
      path.join(stackDir, 'docker-compose.yml'),
      'services:\n  web:\n    image: nginx\n    env_file:\n      - path: ./later.env\n        required: false\n',
      'utf8',
    );

    const captured = await resolveRollbackInventory(NODE, 'app');
    expect(captured.coverageRefusal).toBeNull();
    // Absent at capture and not an omission, so this generation is complete.
    expect(captured.uncapturedInputs).toEqual([]);
    expect(captured.uncapturedRelativePaths).toEqual([]);

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'app',
      generationId,
      inventory: captured,
    });

    // The optional env file appears as a link to a file outside this stack.
    await fsPromises.symlink(path.join(composeDir, 'shared', 'common.env'), path.join(stackDir, 'later.env'));

    const ctx = await resolveComposeProjectContextForGeneration(NODE, 'app', generationId);
    await ctx.restoreFromContext();

    await expect(fsPromises.lstat(path.join(stackDir, 'later.env'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fsPromises.readFile(path.join(composeDir, 'shared', 'common.env'), 'utf8')).toBe('A=1\n');
  });

  it('pins only the root Compose selects when the stack holds more than one', async () => {
    await fsPromises.writeFile(
      path.join(stackDir, 'compose.yaml'),
      'services:\n  web:\n    image: nginx\n',
      'utf8',
    );
    await fsPromises.writeFile(
      path.join(stackDir, 'docker-compose.yml'),
      'services:\n  web:\n    image: nginx\n    command: ["false"]\n',
      'utf8',
    );

    const captured = await resolveRollbackInventory(NODE, 'app');
    expect(captured.coverageRefusal).toBeNull();
    // Both roots are captured, but a run with no explicit -f loads one.
    expect(captured.entries.map((e) => e.relativePath).sort()).toEqual(['compose.yaml', 'docker-compose.yml']);
    expect(captured.invocation.composeLayers).toEqual(['compose.yaml']);

    const { ComposeService } = await import('../services/ComposeService');
    const args = await ComposeService.getInstance(NODE).buildComposeArgsWithRecoveryOverride(
      'app',
      ['up', '-d'],
      null,
      captured.invocation,
    );
    // Merging both roots would run a configuration the deploy never ran.
    expect(args).toEqual(['compose', '-f', 'compose.yaml', 'up', '-d']);
  });

  it.each([
    ['braced', '${STACK_DIR}/compose.yaml'],
    ['bare', '$STACK_DIR/compose.yaml'],
  ])('keeps a %s dynamic include target even when it is a compose filename', async (_form, includePath) => {
    await fsPromises.writeFile(
      path.join(stackDir, 'docker-compose.yml'),
      `include:\n  - ${includePath}\nservices:\n  web:\n    image: nginx\n`,
      'utf8',
    );

    const captured = await resolveRollbackInventory(NODE, 'app');
    expect(captured.coverageRefusal).toBeNull();
    expect(captured.uncapturedInputs).toHaveLength(1);
    // The generation cannot read the substitution, so the one name it could
    // resolve to is an input it does not hold.
    expect(captured.uncapturedRelativePaths).toContain('compose.yaml');

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'app',
      generationId,
      inventory: captured,
    });

    await fsPromises.writeFile(
      path.join(stackDir, 'compose.yaml'),
      'services:\n  web:\n    image: nginx\n',
      'utf8',
    );

    const ctx = await resolveComposeProjectContextForGeneration(NODE, 'app', generationId);
    await ctx.restoreFromContext();

    // A partial rollback uses the current content of an input it could not
    // hold. Deleting this one would break the include it feeds.
    expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf8')).toBe(
      'services:\n  web:\n    image: nginx\n',
    );
  });

  it('reinstates an external symlink when a restore is later reconciled', async () => {
    await fsPromises.mkdir(path.join(composeDir, 'shared'), { recursive: true });
    await fsPromises.writeFile(path.join(composeDir, 'shared', 'common.env'), 'A=1\n', 'utf8');
    await fsPromises.writeFile(
      path.join(stackDir, 'docker-compose.yml'),
      'services:\n  web:\n    image: nginx\n    env_file:\n      - path: ./later.env\n        required: false\n',
      'utf8',
    );

    const captured = await resolveRollbackInventory(NODE, 'app');
    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'app',
      generationId,
      inventory: captured,
    });

    const sharedEnv = path.join(composeDir, 'shared', 'common.env');
    await fsPromises.symlink(sharedEnv, path.join(stackDir, 'later.env'));
    // A compose file the generation restores, so reconciliation has real work.
    // The env_file declaration stays: dropping it would stop later.env from
    // being a declared input at all.
    await fsPromises.writeFile(
      path.join(stackDir, 'docker-compose.yml'),
      'services:\n  web:\n    image: nginx:2\n    env_file:\n      - path: ./later.env\n        required: false\n',
      'utf8',
    );

    const ctx = await resolveComposeProjectContextForGeneration(NODE, 'app', generationId);
    await ctx.restoreFromContext();

    // Restore unlinked the leaf. The link is gone but its target is untouched.
    await expect(fsPromises.lstat(path.join(stackDir, 'later.env'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fsPromises.readFile(sharedEnv, 'utf8')).toBe('A=1\n');

    // Compose up or the health probe failed, so the deployment is reconciled.
    const reverted = await RollbackGenerationStore.reconcileInterruptedRestore(NODE, 'app', generationId);
    expect(reverted).toBe(true);

    const relinked = await fsPromises.lstat(path.join(stackDir, 'later.env'));
    expect(relinked.isSymbolicLink()).toBe(true);
    expect(await fsPromises.readlink(path.join(stackDir, 'later.env'))).toBe(sharedEnv);
    expect(await fsPromises.readFile(path.join(stackDir, 'docker-compose.yml'), 'utf8')).toBe(
      'services:\n  web:\n    image: nginx:2\n    env_file:\n      - path: ./later.env\n        required: false\n',
    );
    expect(await fsPromises.readFile(sharedEnv, 'utf8')).toBe('A=1\n');
  });

  it('refuses to restore when a parent directory of a managed path escaped', async () => {
    await fsPromises.writeFile(
      path.join(stackDir, 'docker-compose.yml'),
      'services:\n  web:\n    image: nginx\n    env_file:\n      - path: ./config/other.env\n        required: false\n',
      'utf8',
    );

    const captured = await resolveRollbackInventory(NODE, 'app');
    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'app',
      generationId,
      inventory: captured,
    });

    await fsPromises.mkdir(path.join(composeDir, 'shared'), { recursive: true });
    await fsPromises.writeFile(path.join(composeDir, 'shared', 'common.env'), 'A=1\n', 'utf8');
    await fsPromises.writeFile(path.join(composeDir, 'shared', 'other.env'), 'B=2\n', 'utf8');
    await fsPromises.symlink(path.join(composeDir, 'shared'), path.join(stackDir, 'config'));

    const ctx = await resolveComposeProjectContextForGeneration(NODE, 'app', generationId);
    await expect(ctx.restoreFromContext()).rejects.toThrow();

    expect(await fsPromises.readFile(path.join(composeDir, 'shared', 'common.env'), 'utf8')).toBe('A=1\n');
    expect(await fsPromises.readFile(path.join(composeDir, 'shared', 'other.env'), 'utf8')).toBe('B=2\n');
  });
});