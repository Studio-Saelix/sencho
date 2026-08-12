/**
 * Generation capture must not rewrite the legacy single-slot backup. A later
 * capture failure has to leave a pre-migration recovery point byte-identical.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import { promises as fsPromises } from 'fs';

const mockState = { composeDir: '', composeDirs: new Map<number, string>() };

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getComposeDir: (nodeId?: number) => mockState.composeDirs.get(nodeId ?? 1) ?? mockState.composeDir,
      getDefaultNodeId: () => 1,
    }),
  },
}));

vi.mock('../utils/debug', () => ({
  isDebugEnabled: () => false,
}));

vi.mock('../services/rollbackInventory', () => ({
  resolveRollbackInventory: vi.fn(),
}));

vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({
      getStackProjectEnvFiles: () => [],
    }),
  },
}));

import { FileSystemService } from '../services/FileSystemService';
import { RollbackGenerationStore } from '../services/RollbackGenerationStore';
import { resolveRollbackInventory } from '../services/rollbackInventory';
import { resolveComposeProjectContext } from '../services/composeProjectContext';

describe('composeProjectContext backupFromContext', () => {
  let composeDir: string;
  let dataDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    composeDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-compose-'));
    dataDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-data-'));
    mockState.composeDir = composeDir;
    mockState.composeDirs = new Map([[1, composeDir]]);
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    await fsPromises.rm(composeDir, { recursive: true, force: true });
    await fsPromises.rm(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('preserves a seeded legacy backup when generation capture fails', async () => {
    const stackName = 'legacy-slot';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'ORIGINAL\n', 'utf8');

    const fsSvc = FileSystemService.getInstance(1);
    await fsSvc.backupStackFiles(stackName);
    const backupPath = path.join(dataDir, 'backups', '1', stackName, 'compose.yaml');
    const originalBackup = await fsPromises.readFile(backupPath);

    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'MUTATED\n', 'utf8');

    vi.mocked(resolveRollbackInventory).mockResolvedValue({
      entries: [{
        relativePath: 'compose.yaml',
        dependencyKind: 'compose-root',
        provenance: 'authored',
        sensitivity: 'low',
        absolutePath: path.join(stackDir, 'compose.yaml'),
      }],
      invocation: {
        composeArgsPrefix: [],
        projectDirectory: null,
        projectName: stackName,
        explicitComposeFiles: ['compose.yaml'],
        meshEnabled: false,
        meshOverrideRelativePath: null,
      },
      git: null,
      appliedDeploySpec: null,
      lastAppliedContentHash: null,
      manifestState: null,
      manifestGeneration: null,
      exactCoverage: true,
      coverageRefusal: null,
    });
    vi.spyOn(RollbackGenerationStore, 'captureGeneration').mockRejectedValue(
      new Error('injected capture failure'),
    );

    const ctx = await resolveComposeProjectContext(1, stackName);
    await expect(ctx.backupFromContext('update')).rejects.toThrow(/injected capture failure/);

    expect(await fsPromises.readFile(backupPath)).toEqual(originalBackup);
    await fsSvc.restoreStackFiles(stackName);
    expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf8')).toBe('ORIGINAL\n');
  });
});
