/**
 * The inventory and the generation store agree on what a stack can hold: every
 * path the inventory admits is one capture can read, and everything it leaves
 * out is recorded on the generation instead of making capture throw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';
import os from 'os';
import { promises as fsPromises } from 'fs';
import { randomUUID } from 'crypto';

const mockState = { composeDir: '' };

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

vi.mock('../utils/authoredComposeArgs', () => ({
  authoredComposeFileArgs: () => ['-f', 'compose.yaml'],
  authoredComposeEnvFileArgs: async () => [],
  DEFAULT_PATH_SEPARATOR: ':',
  composeFileEnvVarSelection: async () => ({ kind: 'absent' }),
}));

import { resolveRollbackInventory } from '../services/rollbackInventory';
import { RollbackGenerationStore } from '../services/RollbackGenerationStore';

const NODE = 1;
const STACK = 'app';

describe('rollback capture with inputs outside the stack', () => {
  let composeDir: string;
  let dataDir: string;
  let stackDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    composeDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-ext-'));
    dataDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-extdata-'));
    mockState.composeDir = composeDir;
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
    stackDir = path.join(composeDir, STACK);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.mkdir(path.join(composeDir, 'shared-common'), { recursive: true });
    await fsPromises.writeFile(path.join(composeDir, 'shared-common', 'base.yaml'), 'services: {}\n', 'utf8');
    await fsPromises.writeFile(path.join(composeDir, 'shared-common', 'app.env'), 'A=1\n', 'utf8');
    await fsPromises.writeFile(path.join(composeDir, 'shared-common', 'shared.env'), 'B=2\n', 'utf8');
  });

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    await fsPromises.rm(composeDir, { recursive: true, force: true });
    await fsPromises.rm(dataDir, { recursive: true, force: true });
  });

  it('captures what the inventory admits and records what it left out', async () => {
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), [
      'include:',
      '  - path: ../shared-common/base.yaml',
      'services:',
      '  web:',
      '    image: nginx',
      '    env_file: [./config/app.env, "${EXTRA_ENV}"]',
      '',
    ].join('\n'), 'utf8');
    await fsPromises.symlink(path.join(composeDir, 'shared-common'), path.join(stackDir, 'config'));
    await fsPromises.symlink(path.join(composeDir, 'shared-common', 'shared.env'), path.join(stackDir, '.env'));

    const inventory = await resolveRollbackInventory(NODE, STACK);
    expect(inventory.coverageRefusal).toBeNull();

    const generationId = randomUUID();
    const manifest = await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: STACK,
      generationId,
      inventory,
      operationKind: 'deployment',
    });

    expect(manifest.entries.map((e) => e.relativePath)).toEqual(['compose.yaml']);
    expect(manifest.uncapturedRelativePaths).toEqual(['.env', 'config/app.env']);
    expect(manifest.uncapturedInputs).toHaveLength(inventory.uncapturedInputs.length);
    expect(manifest.uncapturedInputs).toEqual(expect.arrayContaining([
      expect.stringContaining('include ../shared-common/base.yaml'),
      expect.stringContaining('${EXTRA_ENV}'),
    ]));
  });

  it.each([
    ['an interpolated include path', 'include:\n  - "${COMMON_DIR}/base.yaml"\nservices:\n  web:\n    image: nginx\n', 'include ${COMMON_DIR}/base.yaml (and the files it references) is resolved by Compose at deploy time and is not captured'],
    ['an interpolated extends file', 'services:\n  web:\n    extends:\n      file: ${BASE_FILE:-base.yaml}\n      service: base\n', 'extends ${BASE_FILE:-base.yaml} (and the files it references) is resolved by Compose at deploy time and is not captured'],
    ['a long-form include with a project_directory outside the stack', 'include:\n  - path: ../shared-common/base.yaml\n    project_directory: ../shared-common\nservices:\n  web:\n    image: nginx\n', 'include ../shared-common/base.yaml (and the files it references) is outside the stack directory and is not captured'],
  ])('captures a stack with %s and records what it left out', async (_label, compose, expectedNote) => {
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), compose, 'utf8');

    const inventory = await resolveRollbackInventory(NODE, STACK);
    expect(inventory.coverageRefusal).toBeNull();

    const manifest = await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: STACK,
      generationId: randomUUID(),
      inventory,
    });

    expect(manifest.entries.map((e) => e.relativePath)).toEqual(['compose.yaml']);
    expect(manifest.uncapturedInputs).toEqual([expectedNote]);
  });

  it('captures an include entry that lists a literal file and then an interpolated one', async () => {
    await fsPromises.writeFile(
      path.join(stackDir, 'compose.yaml'),
      'include:\n  - path: ["./a.yaml", "${X}/b.yaml"]\nservices: {}\n',
      'utf8',
    );
    await fsPromises.writeFile(path.join(stackDir, 'a.yaml'), 'services:\n  web:\n    image: nginx\n', 'utf8');

    const inventory = await resolveRollbackInventory(NODE, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.entries.map((e) => e.relativePath)).toEqual(['a.yaml', 'compose.yaml']);
    expect(inventory.uncapturedInputs).toEqual([
      'include ${X}/b.yaml (and the files it references) is resolved by Compose at deploy time and is not captured',
    ]);
  });

  it('captures the include env_file when the project_directory is outside the stack', async () => {
    await fsPromises.mkdir(path.join(stackDir, 'inc'));
    await fsPromises.writeFile(path.join(stackDir, 'inc', 'base.yaml'), 'services:\n  web:\n    image: nginx\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'inc.env'), 'A=1\n', 'utf8');
    await fsPromises.writeFile(
      path.join(stackDir, 'compose.yaml'),
      'include:\n  - path: ./inc/base.yaml\n    project_directory: ../shared-common\n    env_file: ./inc.env\nservices: {}\n',
      'utf8',
    );

    const inventory = await resolveRollbackInventory(NODE, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.entries.map((e) => e.relativePath)).toEqual(['compose.yaml', 'inc.env', 'inc/base.yaml']);
    expect(inventory.uncapturedInputs).toEqual([
      'include ../shared-common (and the files it references) is outside the stack directory and is not captured',
    ]);
  });

  it('notes an outside project_directory even when the included file is inside the stack', async () => {
    await fsPromises.writeFile(
      path.join(stackDir, 'compose.yaml'),
      'include:\n  - path: ./local.yaml\n    project_directory: ../shared-common\nservices: {}\n',
      'utf8',
    );
    await fsPromises.writeFile(path.join(stackDir, 'local.yaml'), 'services:\n  web:\n    image: nginx\n', 'utf8');

    const inventory = await resolveRollbackInventory(NODE, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.entries.map((e) => e.relativePath)).toEqual(['compose.yaml', 'local.yaml']);
    expect(inventory.uncapturedInputs).toEqual([
      'include ../shared-common (and the files it references) is outside the stack directory and is not captured',
    ]);
  });

  it('still refuses invalid YAML and a missing static include inside the stack', async () => {
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: [unclosed\n', 'utf8');
    expect((await resolveRollbackInventory(NODE, STACK)).coverageRefusal).toMatch(/^Cannot parse compose file compose\.yaml/);

    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'include:\n  - ./missing.yaml\nservices: {}\n', 'utf8');
    expect((await resolveRollbackInventory(NODE, STACK)).coverageRefusal).toMatch(/missing\.yaml is unreadable/);
  });

  it('admits a plain stack when the compose directory is itself a link', async () => {
    const linkDir = `${composeDir}-link`;
    await fsPromises.symlink(composeDir, linkDir);
    mockState.composeDir = linkDir;
    try {
      await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');

      const inventory = await resolveRollbackInventory(NODE, STACK);
      expect(inventory.coverageRefusal).toBeNull();
      expect(inventory.entries.map((e) => e.relativePath)).toEqual(['compose.yaml']);

      const manifest = await RollbackGenerationStore.captureGeneration({
        nodeId: NODE,
        stackName: STACK,
        generationId: randomUUID(),
        inventory,
      });
      expect(manifest.entries.map((e) => e.relativePath)).toEqual(['compose.yaml']);
    } finally {
      await fsPromises.rm(linkDir, { force: true });
    }
  });

  it('restores a generation written before uncaptured paths were recorded', async () => {
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');
    const inventory = await resolveRollbackInventory(NODE, STACK);
    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: STACK,
      generationId,
      inventory,
    });

    const genJson = path.join(RollbackGenerationStore.getGenerationDir(NODE, STACK, generationId), 'generation.json');
    const legacy = JSON.parse(await fsPromises.readFile(genJson, 'utf8'));
    delete legacy.uncapturedRelativePaths;
    delete legacy.uncapturedInputs;
    await fsPromises.writeFile(genJson, JSON.stringify(legacy, null, 2), 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {changed: {}}\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'stale.env'), 'X=1\n', 'utf8');

    await RollbackGenerationStore.restoreGeneration(NODE, STACK, generationId, ['compose.yaml', 'stale.env']);

    expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf8')).toBe('services: {}\n');
    await expect(fsPromises.access(path.join(stackDir, 'stale.env'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
