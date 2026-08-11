/**
 * Unit tests for RollbackGenerationStore: capture staging, checksum verify,
 * restore round-trip, mid-capture failure isolation, and managed-set tombstones.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import { promises as fsPromises } from 'fs';
import { randomUUID } from 'crypto';

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

import { RollbackGenerationStore } from '../services/RollbackGenerationStore';
import type { ResolvedRollbackInventory } from '../types/rollbackGeneration';

const NODE = 1;

function inventoryFor(
  stackName: string,
  files: Array<{ relativePath: string; absolutePath: string; kind?: ResolvedRollbackInventory['entries'][number]['dependencyKind']; sensitivity?: ResolvedRollbackInventory['entries'][number]['sensitivity'] }>,
): ResolvedRollbackInventory {
  return {
    entries: files.map((f) => ({
      relativePath: f.relativePath,
      dependencyKind: f.kind ?? 'compose-root',
      provenance: 'authored' as const,
      sensitivity: f.sensitivity ?? 'low',
      absolutePath: f.absolutePath,
    })),
    invocation: {
      composeArgsPrefix: [],
      projectDirectory: null,
      projectName: stackName,
      explicitComposeFiles: files.map((f) => f.relativePath).filter((p) => !p.includes('/')),
    },
    git: null,
    appliedDeploySpec: null,
    lastAppliedContentHash: null,
    manifestState: null,
    manifestGeneration: null,
    exactCoverage: true,
    coverageRefusal: null,
  };
}

describe('RollbackGenerationStore', () => {
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

  it('captures and restores a nested path round-trip', async () => {
    const stackName = 'web';
    const stackDir = path.join(composeDir, stackName);
    const nestedRel = 'includes/base.yaml';
    await fsPromises.mkdir(path.join(stackDir, 'includes'), { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services:\n  app:\n    image: a\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, nestedRel), 'services: {}\n', 'utf8');

    const generationId = randomUUID();
    const inv = inventoryFor(stackName, [
      { relativePath: 'compose.yaml', absolutePath: path.join(stackDir, 'compose.yaml') },
      { relativePath: nestedRel, absolutePath: path.join(stackDir, nestedRel), kind: 'include' },
    ]);

    const manifest = await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName,
      generationId,
      inventory: inv,
      operationKind: 'manual_backup',
    });

    expect(manifest.managedRelativePaths).toEqual(['compose.yaml', nestedRel].sort((a, b) => a.localeCompare(b)));
    const genDir = RollbackGenerationStore.getGenerationDir(NODE, stackName, generationId);
    await expect(fsPromises.access(path.join(genDir, 'generation.json'))).resolves.toBeUndefined();
    await expect(fsPromises.access(path.join(genDir, 'files', nestedRel))).resolves.toBeUndefined();

    // Mutate live files, then restore
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: { mutated: {} }\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, nestedRel), 'services: { mutated: true }\n', 'utf8');

    await RollbackGenerationStore.restoreGeneration(NODE, stackName, generationId, [
      'compose.yaml',
      nestedRel,
    ]);

    expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf8')).toBe(
      'services:\n  app:\n    image: a\n',
    );
    expect(await fsPromises.readFile(path.join(stackDir, nestedRel), 'utf8')).toBe('services: {}\n');
  });

  it('leaves no final generation dir when capture fails mid-write', async () => {
    const stackName = 'failcap';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');
    await fsPromises.mkdir(path.join(stackDir, 'configs'), { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'configs', 'app.conf'), 'ok\n', 'utf8');

    const generationId = randomUUID();
    const inv = inventoryFor(stackName, [
      { relativePath: 'compose.yaml', absolutePath: path.join(stackDir, 'compose.yaml') },
      {
        relativePath: 'configs/app.conf',
        absolutePath: path.join(stackDir, 'configs', 'app.conf'),
        kind: 'config',
        sensitivity: 'high',
      },
    ]);

    const realWriteFile = fsPromises.writeFile.bind(fsPromises);
    const writeSpy = vi.spyOn(fsPromises, 'writeFile').mockImplementation(async (file, data, options) => {
      const normalized = path.normalize(String(file));
      if (normalized.includes(`${path.sep}configs${path.sep}app.conf`) && normalized.includes('staging-')) {
        throw new Error('disk full during capture');
      }
      return realWriteFile(file, data, options);
    });

    try {
      await expect(
        RollbackGenerationStore.captureGeneration({
          nodeId: NODE,
          stackName,
          generationId,
          inventory: inv,
        }),
      ).rejects.toThrow(/disk full during capture/);

      const finalDir = RollbackGenerationStore.getGenerationDir(NODE, stackName, generationId);
      await expect(fsPromises.access(finalDir)).rejects.toMatchObject({ code: 'ENOENT' });

      const gensRoot = RollbackGenerationStore.getGenerationsRoot(NODE, stackName);
      let leftoverStaging = false;
      try {
        const entries = await fsPromises.readdir(gensRoot);
        leftoverStaging = entries.some((e) => e.startsWith('staging-'));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      expect(leftoverStaging).toBe(false);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('refuses restore when a checksum is corrupt before mutating live files', async () => {
    const stackName = 'corrupt';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    const original = 'services:\n  app:\n    image: good\n';
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), original, 'utf8');

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName,
      generationId,
      inventory: inventoryFor(stackName, [
        { relativePath: 'compose.yaml', absolutePath: path.join(stackDir, 'compose.yaml') },
      ]),
    });

    const genDir = RollbackGenerationStore.getGenerationDir(NODE, stackName, generationId);
    await fsPromises.writeFile(path.join(genDir, 'files', 'compose.yaml'), 'services: { tampered: true }\n', 'utf8');

    const liveMutated = 'services: { live: true }\n';
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), liveMutated, 'utf8');

    await expect(
      RollbackGenerationStore.restoreGeneration(NODE, stackName, generationId, ['compose.yaml']),
    ).rejects.toThrow(/Checksum mismatch/);

    expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf8')).toBe(liveMutated);
  });

  it('tombstones post-capture managed additions and leaves unrelated files', async () => {
    const stackName = 'tomb';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(path.join(stackDir, 'configs'), { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'configs', 'app.conf'), 'v1\n', 'utf8');

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName,
      generationId,
      inventory: inventoryFor(stackName, [
        { relativePath: 'compose.yaml', absolutePath: path.join(stackDir, 'compose.yaml') },
        {
          relativePath: 'configs/app.conf',
          absolutePath: path.join(stackDir, 'configs', 'app.conf'),
          kind: 'config',
          sensitivity: 'high',
        },
      ]),
    });

    // Post-capture addition inside the managed discovery set
    await fsPromises.writeFile(path.join(stackDir, 'configs', 'extra.conf'), 'new\n', 'utf8');
    // Unrelated file outside managed discovery
    await fsPromises.writeFile(path.join(stackDir, 'README.md'), 'keep me\n', 'utf8');
    // Mutate a present managed file
    await fsPromises.writeFile(path.join(stackDir, 'configs', 'app.conf'), 'v2\n', 'utf8');

    await RollbackGenerationStore.restoreGeneration(NODE, stackName, generationId, [
      'compose.yaml',
      'configs/app.conf',
      'configs/extra.conf',
    ]);

    expect(await fsPromises.readFile(path.join(stackDir, 'configs', 'app.conf'), 'utf8')).toBe('v1\n');
    await expect(fsPromises.access(path.join(stackDir, 'configs', 'extra.conf'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await fsPromises.readFile(path.join(stackDir, 'README.md'), 'utf8')).toBe('keep me\n');
  });

  it('encrypts medium sensitivity entries and refuses symlink escapes', async () => {
    const stackName = 'secure';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, '.env'), 'SECRET=1\n', 'utf8');

    const outside = path.join(composeDir, 'outside-secret.txt');
    await fsPromises.writeFile(outside, 'escaped\n', 'utf8');
    const linkPath = path.join(stackDir, 'escape.link');
    let symlinkOk = true;
    try {
      await fsPromises.symlink(outside, linkPath);
    } catch {
      symlinkOk = false;
    }

    if (symlinkOk) {
      await expect(
        RollbackGenerationStore.captureGeneration({
          nodeId: NODE,
          stackName,
          generationId: randomUUID(),
          inventory: inventoryFor(stackName, [
            { relativePath: 'compose.yaml', absolutePath: path.join(stackDir, 'compose.yaml') },
            {
              relativePath: 'escape.link',
              absolutePath: linkPath,
              kind: 'other',
              sensitivity: 'low',
            },
          ]),
        }),
      ).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    }

    const generationId = randomUUID();
    const manifest = await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName,
      generationId,
      inventory: inventoryFor(stackName, [
        { relativePath: 'compose.yaml', absolutePath: path.join(stackDir, 'compose.yaml') },
        {
          relativePath: '.env',
          absolutePath: path.join(stackDir, '.env'),
          kind: 'interpolation-env',
          sensitivity: 'medium',
        },
      ]),
    });
    const envEntry = manifest.entries.find((e) => e.relativePath === '.env');
    expect(envEntry?.encrypted).toBe(true);
    expect(envEntry?.state).toBe('present');
  });
  it('reverts an interrupted multi-file restore from pre-restore snapshot', async () => {
    const stackName = 'tx';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(path.join(stackDir, 'includes'), { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'OLD_BASE\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'includes/base.yaml'), 'OLD_INC\n', 'utf8');

    const generationId = randomUUID();
    const inv = inventoryFor(stackName, [
      { relativePath: 'compose.yaml', absolutePath: path.join(stackDir, 'compose.yaml') },
      { relativePath: 'includes/base.yaml', absolutePath: path.join(stackDir, 'includes/base.yaml'), kind: 'include' },
    ]);
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName,
      generationId,
      inventory: inv,
      operationKind: 'manual_backup',
    });

    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'NEW_BASE\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'includes/base.yaml'), 'NEW_INC\n', 'utf8');

    const { FileSystemService } = await import('../services/FileSystemService');
    const originalWrite = FileSystemService.prototype.writeStackFile;
    let n = 0;
    vi.spyOn(FileSystemService.prototype, 'writeStackFile').mockImplementation(async function (this: InstanceType<typeof FileSystemService>, stack, rel, content) {
      n += 1;
      if (n === 2) throw new Error('injected write failure');
      return originalWrite.call(this, stack, rel, content);
    });

    await expect(
      RollbackGenerationStore.restoreGeneration(NODE, stackName, generationId, ['compose.yaml', 'includes/base.yaml']),
    ).rejects.toThrow(/injected write failure/);

    expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf8')).toBe('NEW_BASE\n');
    expect(await fsPromises.readFile(path.join(stackDir, 'includes/base.yaml'), 'utf8')).toBe('NEW_INC\n');

    const genDir = RollbackGenerationStore.getGenerationDir(NODE, stackName, generationId);
    await expect(fsPromises.access(path.join(genDir, 'restore-intent.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });


});
