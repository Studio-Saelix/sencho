/**
 * Unit tests for RollbackGenerationStore: capture staging, checksum verify,
 * restore round-trip, mid-capture failure isolation, and managed-set tombstones.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
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
  files: Array<{
    relativePath: string;
    absolutePath: string | null;
    kind?: ResolvedRollbackInventory['entries'][number]['dependencyKind'];
    sensitivity?: ResolvedRollbackInventory['entries'][number]['sensitivity'];
  }>,
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
      meshEnabled: false,
      meshOverrideRelativePath: null,
    },
    git: null,
    appliedDeploySpec: null,
    lastAppliedContentHash: null,
    manifestState: null,
    manifestGeneration: null,
    coverageRefusal: null,
    uncapturedInputs: [],
    uncapturedRelativePaths: [],
    applicationDataPaths: [],
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

  it('restores the prior bytes of an in-stack link target when a restore fails', async () => {
    const stackName = 'linkwrite';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'app.env'), 'MARK=captured\n', 'utf8');

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName,
      generationId,
      inventory: inventoryFor(stackName, [
        { relativePath: 'compose.yaml', absolutePath: path.join(stackDir, 'compose.yaml') },
        {
          relativePath: 'app.env',
          absolutePath: path.join(stackDir, 'app.env'),
          kind: 'env_file',
          sensitivity: 'medium',
        },
      ]),
    });

    // Before restore, an operator swaps the managed env file for a link that
    // stays inside the stack. The restore write follows the link, so the bytes
    // that change are the target's, and the sensitive-entry chmod then refuses
    // the link, which is the failure this has to survive.
    await fsPromises.rm(path.join(stackDir, 'app.env'));
    await fsPromises.writeFile(path.join(stackDir, 'target.env'), 'MARK=before-restore\n', 'utf8');
    await fsPromises.symlink('target.env', path.join(stackDir, 'app.env'));

    await expect(
      RollbackGenerationStore.restoreGeneration(NODE, stackName, generationId, ['compose.yaml', 'app.env']),
    ).rejects.toMatchObject({ code: 'RESTORE_CHMOD_FAILED' });

    // The revert has to put the target's own bytes back, not just leave the
    // link alone, and the link itself is still the operator's.
    expect(await fsPromises.readFile(path.join(stackDir, 'target.env'), 'utf8')).toBe('MARK=before-restore\n');
    expect((await fsPromises.lstat(path.join(stackDir, 'app.env'))).isSymbolicLink()).toBe(true);
    expect(await fsPromises.readlink(path.join(stackDir, 'app.env'))).toBe('target.env');

    const genDir = RollbackGenerationStore.getGenerationDir(NODE, stackName, generationId);
    // The revert landed, so there is no longer a restore half-applied.
    await expect(fsPromises.access(path.join(genDir, 'restore-intent.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('puts a vanished link back before restoring the bytes it carried', async () => {
    const stackName = 'linkgone';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'app.env'), 'MARK=captured\n', 'utf8');

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName,
      generationId,
      inventory: inventoryFor(stackName, [
        { relativePath: 'compose.yaml', absolutePath: path.join(stackDir, 'compose.yaml') },
        {
          relativePath: 'app.env',
          absolutePath: path.join(stackDir, 'app.env'),
          kind: 'env_file',
          sensitivity: 'medium',
        },
      ]),
    });

    // The managed env file becomes a link to a target with its own bytes.
    await fsPromises.rm(path.join(stackDir, 'app.env'));
    await fsPromises.writeFile(path.join(stackDir, 'target.env'), 'MARK=before-restore\n', 'utf8');
    await fsPromises.symlink('target.env', path.join(stackDir, 'app.env'));

    // Restore runs, then the link is removed before the revert, which is the
    // window a revert has to survive.
    const { FileSystemService } = await import('../services/FileSystemService');
    let linkRemoved = false;
    const realWrite = FileSystemService.prototype.writeStackFile;
    vi.spyOn(FileSystemService.prototype, 'writeStackFile').mockImplementation(
      async function (this: InstanceType<typeof FileSystemService>, stack, rel, content) {
        const result = await realWrite.call(this, stack, rel, content);
        // The link is removed after the restore wrote through it, which is the
        // window a revert has to survive. Once, so the revert's own write is
        // left alone.
        if (rel === 'app.env' && !linkRemoved) {
          linkRemoved = true;
          await fsPromises.rm(path.join(stackDir, 'app.env'), { force: true });
        }
        return result;
      },
    );
    // The real chmod refuses a symlink, which is what makes the restore of a
    // sensitive linked entry fail and hand over to the revert. A revert skips
    // the chmod for a linked entry, so this only ever fires on the restore.
    vi.spyOn(FileSystemService.prototype, 'chmodStackPath').mockImplementation(
      async (_stack: string, rel: string) => {
        if (rel === 'app.env') {
          throw Object.assign(new Error('Cannot change permissions of a symlink.'), {
            code: 'LINK_CHMOD_UNSUPPORTED',
          });
        }
      },
    );

    await expect(
      RollbackGenerationStore.restoreGeneration(NODE, stackName, generationId, ['compose.yaml', 'app.env']),
    ).rejects.toMatchObject({ code: 'RESTORE_CHMOD_FAILED' });

    // The bytes belong to the target, so a revert that dropped the link first
    // would leave them in a plain file and the target still mutated.
    expect((await fsPromises.lstat(path.join(stackDir, 'app.env'))).isSymbolicLink()).toBe(true);
    expect(await fsPromises.readlink(path.join(stackDir, 'app.env'))).toBe('target.env');
    expect(await fsPromises.readFile(path.join(stackDir, 'target.env'), 'utf8')).toBe('MARK=before-restore\n');
  });

  it('does not write the preimage through a link the operator has replaced', async () => {
    const stackName = 'linkreplaced';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'app.env'), 'MARK=captured\n', 'utf8');

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName,
      generationId,
      inventory: inventoryFor(stackName, [
        { relativePath: 'compose.yaml', absolutePath: path.join(stackDir, 'compose.yaml') },
        {
          relativePath: 'app.env',
          absolutePath: path.join(stackDir, 'app.env'),
          kind: 'env_file',
          sensitivity: 'medium',
        },
      ]),
    });

    await fsPromises.rm(path.join(stackDir, 'app.env'));
    await fsPromises.writeFile(path.join(stackDir, 'target.env'), 'MARK=before-restore\n', 'utf8');
    await fsPromises.symlink('target.env', path.join(stackDir, 'app.env'));

    const { FileSystemService } = await import('../services/FileSystemService');
    let swapDone = false;
    const realWrite = FileSystemService.prototype.writeStackFile;
    vi.spyOn(FileSystemService.prototype, 'writeStackFile').mockImplementation(
      async function (this: InstanceType<typeof FileSystemService>, stack, rel, content) {
        const result = await realWrite.call(this, stack, rel, content);
        if (rel === 'app.env' && !swapDone) {
          swapDone = true;
          await fsPromises.rm(path.join(stackDir, 'app.env'), { force: true });
          await fsPromises.writeFile(path.join(stackDir, 'other.env'), 'MARK=operator\n', 'utf8');
          await fsPromises.symlink('other.env', path.join(stackDir, 'app.env'));
        }
        return result;
      },
    );
    vi.spyOn(FileSystemService.prototype, 'chmodStackPath').mockImplementation(
      async (_stack: string, rel: string) => {
        if (rel === 'app.env') {
          throw Object.assign(new Error('Cannot change permissions of a symlink.'), {
            code: 'LINK_CHMOD_UNSUPPORTED',
          });
        }
      },
    );

    await expect(
      RollbackGenerationStore.restoreGeneration(NODE, stackName, generationId, ['compose.yaml', 'app.env']),
    ).rejects.toMatchObject({ code: 'RESTORE_CHMOD_FAILED' });

    // The revert restores the link the snapshot recorded, so the bytes land
    // back on the target the restore changed. Writing through the replacement
    // would instead clobber a file the operator created.
    expect(await fsPromises.readlink(path.join(stackDir, 'app.env'))).toBe('target.env');
    expect(await fsPromises.readFile(path.join(stackDir, 'target.env'), 'utf8')).toBe('MARK=before-restore\n');
    expect(await fsPromises.readFile(path.join(stackDir, 'other.env'), 'utf8')).toBe('MARK=operator\n');
  });

it('refuses to recreate a managed link whose parent now leaves the stack', async () => {
    const stackName = 'linkparent';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(path.join(stackDir, 'config'), { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'config', 'app.env'), 'A=1\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'config', 'target.env'), 'A=before\n', 'utf8');

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName,
      generationId,
      inventory: inventoryFor(stackName, [
        { relativePath: 'compose.yaml', absolutePath: path.join(stackDir, 'compose.yaml') },
        {
          relativePath: 'config/app.env',
          absolutePath: path.join(stackDir, 'config', 'app.env'),
          kind: 'env_file',
          sensitivity: 'medium',
        },
      ]),
    });

    // The managed env file becomes a link inside the stack, so the snapshot
    // records its bytes and its target.
    await fsPromises.rm(path.join(stackDir, 'config', 'app.env'));
    await fsPromises.symlink('target.env', path.join(stackDir, 'config', 'app.env'));

    const outside = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-outside-'));
    const { FileSystemService } = await import('../services/FileSystemService');
    // The restore itself succeeds and leaves the intent plus the pre-restore
    // snapshot on disk, which is the state startup reconciliation finds.
    vi.spyOn(FileSystemService.prototype, 'chmodStackPath').mockResolvedValue(undefined);
    await RollbackGenerationStore.restoreGeneration(NODE, stackName, generationId, ['compose.yaml', 'config/app.env']);
    expect(await RollbackGenerationStore.hasPendingRestoreIntent(NODE, stackName, generationId)).toBe(true);

    // The whole parent directory is replaced by a link out of the stack while
    // the process was down, so the recorded link can no longer be put back
    // where it belongs.
    await fsPromises.rename(path.join(stackDir, 'config'), path.join(composeDir, `${stackName}-config-moved`));
    await fsPromises.symlink(outside, path.join(stackDir, 'config'));

    await expect(
      RollbackGenerationStore.reconcileInterruptedRestore(NODE, stackName, generationId),
    ).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });

    // Nothing may be created through the escaped parent.
    expect(await fsPromises.readdir(outside)).toEqual([]);
    await fsPromises.rm(outside, { recursive: true, force: true });
    await fsPromises.rm(path.join(composeDir, `${stackName}-config-moved`), { recursive: true, force: true });
  });

it('leaves an external file alone when the recorded link is reconciled elsewhere', async () => {
    const stackName = 'linkexternal';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(path.join(stackDir, 'config'), { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'config', 'app.env'), 'A=1\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'config', 'target.env'), 'A=before\n', 'utf8');

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName,
      generationId,
      inventory: inventoryFor(stackName, [
        { relativePath: 'compose.yaml', absolutePath: path.join(stackDir, 'compose.yaml') },
        {
          relativePath: 'config/app.env',
          absolutePath: path.join(stackDir, 'config', 'app.env'),
          kind: 'env_file',
          sensitivity: 'medium',
        },
      ]),
    });

    await fsPromises.rm(path.join(stackDir, 'config', 'app.env'));
    await fsPromises.symlink('target.env', path.join(stackDir, 'config', 'app.env'));

    const { FileSystemService } = await import('../services/FileSystemService');
    vi.spyOn(FileSystemService.prototype, 'chmodStackPath').mockResolvedValue(undefined);
    await RollbackGenerationStore.restoreGeneration(NODE, stackName, generationId, ['compose.yaml', 'config/app.env']);
    expect(await RollbackGenerationStore.hasPendingRestoreIntent(NODE, stackName, generationId)).toBe(true);

    // The parent becomes a link to a folder that holds a differently pointed
    // link at the managed name. Containment has to be settled before that link
    // is read or removed, or reconciliation would delete a file outside the
    // stack on its way to refusing.
    const outside = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-outside-'));
    const outsideTarget = path.join(outside, 'elsewhere.env');
    await fsPromises.writeFile(outsideTarget, 'OPERATOR=1\n', 'utf8');
    await fsPromises.symlink('elsewhere.env', path.join(outside, 'app.env'));
    await fsPromises.rename(path.join(stackDir, 'config'), path.join(composeDir, `${stackName}-config-moved`));
    await fsPromises.symlink(outside, path.join(stackDir, 'config'));

    await expect(
      RollbackGenerationStore.reconcileInterruptedRestore(NODE, stackName, generationId),
    ).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });

    expect((await fsPromises.lstat(path.join(outside, 'app.env'))).isSymbolicLink()).toBe(true);
    expect(await fsPromises.readFile(outsideTarget, 'utf8')).toBe('OPERATOR=1\n');
    await fsPromises.rm(outside, { recursive: true, force: true });
    await fsPromises.rm(path.join(composeDir, `${stackName}-config-moved`), { recursive: true, force: true });
  });

it('restores a snapshotted Git manifesto on compensate path helper', async () => {
    const stackName = 'gitman';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');

    const managedDir = path.join(dataDir, 'git-managed', '1', stackName);
    await fsPromises.mkdir(managedDir, { recursive: true });
    const priorManifest = {
      manifestVersion: 3,
      state: 'active',
      repo: { url: 'https://example.com/r.git', branch: 'main' },
      resolvedRevision: { commitSha: 'abc1234' },
      project: {
        root: '.',
        composeFiles: ['compose.yaml'],
        projectName: stackName,
        effectiveProjectDir: null,
        invocation: ['-f', 'compose.yaml'],
      },
      inputs: [],
      buildContexts: [],
      counts: { total: 0, refused: 0 },
      refusals: [],
      generation: { appliedDir: 'generations/prior', previousDir: null },
    };
    await fsPromises.writeFile(
      path.join(managedDir, 'manifest.v1.json'),
      JSON.stringify(priorManifest),
      'utf8',
    );

    const generationId = randomUUID();
    const inv = inventoryFor(stackName, [
      { relativePath: 'compose.yaml', absolutePath: path.join(stackDir, 'compose.yaml') },
    ]);
    inv.git = {
      repoUrl: 'https://example.com/r.git',
      branch: 'main',
      commitSha: 'abc1234',
      manifestVersion: 3,
    };
    const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
    const readSpy = vi.spyOn(GitProjectManifestService.getInstance(), 'readManifest')
      .mockResolvedValue(priorManifest as never);
    let genDir = '';
    try {
      await RollbackGenerationStore.captureGeneration({
        nodeId: NODE,
        stackName,
        generationId,
        inventory: inv,
      });

      genDir = RollbackGenerationStore.getGenerationDir(NODE, stackName, generationId);
      const snap = await fsPromises.readFile(path.join(genDir, 'git-manifest.v1.json'), 'utf8');
      expect(JSON.parse(snap).resolvedRevision.commitSha).toBe('abc1234');
    } finally {
      readSpy.mockRestore();
    }
    const newer = { ...priorManifest, resolvedRevision: { commitSha: 'ffffff' } };
    await fsPromises.writeFile(path.join(managedDir, 'manifest.v1.json'), JSON.stringify(newer), 'utf8');

    const captured = JSON.parse(await fsPromises.readFile(path.join(genDir, 'generation.json'), 'utf8'));
    await RollbackGenerationStore.restoreCapturedGitManifest(stackName, genDir, captured);
    const restored = JSON.parse(await fsPromises.readFile(path.join(managedDir, 'manifest.v1.json'), 'utf8'));
    expect(restored.resolvedRevision.commitSha).toBe('abc1234');
  });

  it('does not snapshot a corrupt Git manifesto into the generation', async () => {
    const stackName = 'nocorrupt';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');

    const generationId = randomUUID();
    const inv = inventoryFor(stackName, [
      { relativePath: 'compose.yaml', absolutePath: path.join(stackDir, 'compose.yaml') },
    ]);
    inv.git = {
      repoUrl: 'https://example.com/r.git',
      branch: 'main',
      commitSha: 'abc',
      manifestVersion: 3,
    };
    const { GitProjectManifestService } = await import('../services/GitProjectManifestService');
    const readSpy = vi.spyOn(GitProjectManifestService.getInstance(), 'readManifest')
      .mockResolvedValue({ corrupt: 'identity mismatch' });
    try {
      await RollbackGenerationStore.captureGeneration({
        nodeId: NODE,
        stackName,
        generationId,
        inventory: inv,
      });
      const genDir = RollbackGenerationStore.getGenerationDir(NODE, stackName, generationId);
      await expect(fsPromises.access(path.join(genDir, 'git-manifest.v1.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      const captured = JSON.parse(await fsPromises.readFile(path.join(genDir, 'generation.json'), 'utf8'));
      expect(captured.priorRecords.gitManifestCaptured).toBe(false);
    } finally {
      readSpy.mockRestore();
    }
  });

  it('clears post-capture manifesto for first-apply preimage', async () => {
    const stackName = 'firstapply';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');

    const generationId = randomUUID();
    const inv = inventoryFor(stackName, [
      { relativePath: 'compose.yaml', absolutePath: path.join(stackDir, 'compose.yaml') },
    ]);
    inv.git = {
      repoUrl: 'https://example.com/r.git',
      branch: 'main',
      commitSha: '',
      manifestVersion: null,
    };
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName,
      generationId,
      inventory: inv,
    });

    const genDir = RollbackGenerationStore.getGenerationDir(NODE, stackName, generationId);
    const captured = JSON.parse(await fsPromises.readFile(path.join(genDir, 'generation.json'), 'utf8'));
    expect(captured.priorRecords.gitManifestCaptured).toBe(false);

    const managedDir = path.join(dataDir, 'git-managed', '1', stackName);
    await fsPromises.mkdir(managedDir, { recursive: true });
    await fsPromises.writeFile(path.join(managedDir, 'manifest.v1.json'), '{"manifestVersion":3}\n', 'utf8');

    await RollbackGenerationStore.restoreCapturedGitManifest(stackName, genDir, captured);
    await expect(fsPromises.access(path.join(managedDir, 'manifest.v1.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not clear live manifesto for legacy generations without a snapshot', async () => {
    const stackName = 'legacygen';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');

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
    const captured = JSON.parse(await fsPromises.readFile(path.join(genDir, 'generation.json'), 'utf8'));
    delete captured.priorRecords.gitManifestCaptured;
    captured.git = {
      repoUrl: 'https://example.com/r.git',
      branch: 'main',
      commitSha: 'abc',
      manifestVersion: 3,
    };
    await fsPromises.writeFile(path.join(genDir, 'generation.json'), JSON.stringify(captured), 'utf8');

    const managedDir = path.join(dataDir, 'git-managed', '1', stackName);
    await fsPromises.mkdir(managedDir, { recursive: true });
    await fsPromises.writeFile(path.join(managedDir, 'manifest.v1.json'), '{"keep":true}\n', 'utf8');

    await RollbackGenerationStore.restoreCapturedGitManifest(stackName, genDir, captured);
    expect(await fsPromises.readFile(path.join(managedDir, 'manifest.v1.json'), 'utf8')).toBe('{"keep":true}\n');
  });

  it('refuses restore when a managed file path is currently a directory', async () => {
    const stackName = 'dircollide';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'OLD\n', 'utf8');

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName,
      generationId,
      inventory: inventoryFor(stackName, [
        { relativePath: 'compose.yaml', absolutePath: path.join(stackDir, 'compose.yaml') },
      ]),
    });

    await fsPromises.rm(path.join(stackDir, 'compose.yaml'));
    await fsPromises.mkdir(path.join(stackDir, 'compose.yaml'), { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml', 'sentinel.txt'), 'keep-me\n', 'utf8');

    await expect(
      RollbackGenerationStore.restoreGeneration(NODE, stackName, generationId, ['compose.yaml']),
    ).rejects.toMatchObject({ code: 'DIRECTORY_COLLISION' });

    expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml', 'sentinel.txt'), 'utf8')).toBe('keep-me\n');
  });

  it.skipIf(process.platform === 'win32')('rejects a managed file replaced by a fifo without a writer', async () => {
    const stackName = 'fiforestore';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, '.env'), 'MARK=captured\n', 'utf8');

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName,
      generationId,
      inventory: inventoryFor(stackName, [
        { relativePath: 'compose.yaml', absolutePath: path.join(stackDir, 'compose.yaml') },
        { relativePath: '.env', absolutePath: path.join(stackDir, '.env'), kind: 'interpolation-env' },
      ]),
    });

    await fsPromises.rm(path.join(stackDir, '.env'));
    execFileSync('mkfifo', [path.join(stackDir, '.env')]);

    await expect(
      RollbackGenerationStore.restoreGeneration(NODE, stackName, generationId, ['.env', 'compose.yaml']),
    ).rejects.toMatchObject({ code: 'DIRECTORY_COLLISION' });

    const fifo = await fsPromises.lstat(path.join(stackDir, '.env'));
    expect(fifo.isFIFO()).toBe(true);
    expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf8')).toBe('services: {}\n');
  }, 3_000);

  it.skipIf(process.platform === 'win32')('rejects a delete-only fifo without a writer', async () => {
    const stackName = 'fifodelete';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName,
      generationId,
      inventory: inventoryFor(stackName, [
        { relativePath: 'compose.yaml', absolutePath: path.join(stackDir, 'compose.yaml') },
      ]),
    });

    execFileSync('mkfifo', [path.join(stackDir, 'discovered.fifo')]);

    await expect(
      RollbackGenerationStore.restoreGeneration(
        NODE,
        stackName,
        generationId,
        ['compose.yaml', 'discovered.fifo'],
      ),
    ).rejects.toMatchObject({ code: 'DIRECTORY_COLLISION' });

    expect((await fsPromises.lstat(path.join(stackDir, 'discovered.fifo'))).isFIFO()).toBe(true);
    expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf8')).toBe('services: {}\n');
  }, 3_000);

  it.skipIf(process.platform === 'win32')('rejects a managed path replaced by a symlink to an in-stack fifo', async () => {
    const stackName = 'fifolink';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, '.env'), 'MARK=captured\n', 'utf8');

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName,
      generationId,
      inventory: inventoryFor(stackName, [
        { relativePath: 'compose.yaml', absolutePath: path.join(stackDir, 'compose.yaml') },
        { relativePath: '.env', absolutePath: path.join(stackDir, '.env'), kind: 'interpolation-env' },
      ]),
    });

    const fifo = path.join(stackDir, 'pipe.fifo');
    execFileSync('mkfifo', [fifo]);
    await fsPromises.rm(path.join(stackDir, '.env'));
    await fsPromises.symlink(fifo, path.join(stackDir, '.env'));

    await expect(
      RollbackGenerationStore.restoreGeneration(NODE, stackName, generationId, ['.env']),
    ).rejects.toMatchObject({ code: 'DIRECTORY_COLLISION' });

    expect((await fsPromises.lstat(path.join(stackDir, '.env'))).isSymbolicLink()).toBe(true);
    expect((await fsPromises.lstat(fifo)).isFIFO()).toBe(true);
    expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf8')).toBe('services: {}\n');
  }, 3_000);

  it('restores a legitimate file whose name ends with .sencho-tombstone (index-based snapshot)', async () => {
    const stackName = 'tombname';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');
    const special = 'config.sencho-tombstone';
    await fsPromises.writeFile(path.join(stackDir, special), 'KEEP_ME\n', 'utf8');

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName,
      generationId,
      inventory: inventoryFor(stackName, [
        { relativePath: 'compose.yaml', absolutePath: path.join(stackDir, 'compose.yaml') },
        { relativePath: special, absolutePath: path.join(stackDir, special), kind: 'other' },
      ]),
    });

    await fsPromises.writeFile(path.join(stackDir, special), 'CHANGED\n', 'utf8');
    await RollbackGenerationStore.restoreGeneration(
      NODE,
      stackName,
      generationId,
      ['compose.yaml', special],
    );

    expect(await fsPromises.readFile(path.join(stackDir, special), 'utf8')).toBe('KEEP_ME\n');
  });

  it('captures POSIX mode and restores it on generation restore', async () => {
    if (process.platform === 'win32') return;

    const stackName = 'modes';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    const scriptPath = path.join(stackDir, 'entrypoint.sh');
    await fsPromises.writeFile(scriptPath, '#!/bin/sh\necho hi\n', 'utf8');
    await fsPromises.chmod(scriptPath, 0o755);
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');

    const generationId = randomUUID();
    const manifest = await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName,
      generationId,
      inventory: inventoryFor(stackName, [
        { relativePath: 'compose.yaml', absolutePath: path.join(stackDir, 'compose.yaml') },
        { relativePath: 'entrypoint.sh', absolutePath: scriptPath, kind: 'other' },
      ]),
    });
    const entry = manifest.entries.find((e) => e.relativePath === 'entrypoint.sh');
    expect(entry?.mode).toBe(0o755);

    await fsPromises.chmod(scriptPath, 0o644);
    await RollbackGenerationStore.restoreGeneration(
      NODE,
      stackName,
      generationId,
      ['compose.yaml', 'entrypoint.sh'],
    );
    const st = await fsPromises.stat(scriptPath);
    expect(st.mode & 0o777).toBe(0o755);
  });

  it('reverts an interrupted restore that deleted a post-capture file via index absent entries', async () => {
    const stackName = 'absenttx';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'OLD\n', 'utf8');

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName,
      generationId,
      inventory: inventoryFor(stackName, [
        { relativePath: 'compose.yaml', absolutePath: path.join(stackDir, 'compose.yaml') },
      ]),
    });

    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'NEW\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'extra.yml'), 'EXTRA\n', 'utf8');

    const { FileSystemService } = await import('../services/FileSystemService');
    const originalWrite = FileSystemService.prototype.writeStackFile;
    vi.spyOn(FileSystemService.prototype, 'writeStackFile').mockImplementation(async function (
      this: InstanceType<typeof FileSystemService>,
      stack,
      rel,
      content,
    ) {
      if (rel === 'compose.yaml') throw new Error('injected write failure');
      return originalWrite.call(this, stack, rel, content);
    });

    await expect(
      RollbackGenerationStore.restoreGeneration(NODE, stackName, generationId, ['compose.yaml', 'extra.yml']),
    ).rejects.toThrow(/injected write failure/);

    expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf8')).toBe('NEW\n');
    expect(await fsPromises.readFile(path.join(stackDir, 'extra.yml'), 'utf8')).toBe('EXTRA\n');
  });

  it('marks a failed mid-write restore whose own revert did not land', async () => {
    const stackName = 'revertfailed';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'OLD\n', 'utf8');

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName,
      generationId,
      inventory: inventoryFor(stackName, [
        { relativePath: 'compose.yaml', absolutePath: path.join(stackDir, 'compose.yaml') },
      ]),
    });

    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'NEW\n', 'utf8');

    const { FileSystemService } = await import('../services/FileSystemService');
    const originalWrite = FileSystemService.prototype.writeStackFile;
    vi.spyOn(FileSystemService.prototype, 'writeStackFile').mockImplementation(async function (
      this: InstanceType<typeof FileSystemService>,
      stack,
      rel,
      content,
    ) {
      if (rel === 'compose.yaml') throw new Error('injected write failure');
      return originalWrite.call(this, stack, rel, content);
    });
    vi.spyOn(
      RollbackGenerationStore as unknown as {
        revertFromPreRestoreSnapshot: (...args: unknown[]) => Promise<void>;
      },
      'revertFromPreRestoreSnapshot',
    ).mockRejectedValue(new Error('injected revert failure'));

    // The live files may now be a mix of the generation and the pre-restore
    // state, so the failure carries that fact for the caller's classification.
    await expect(
      RollbackGenerationStore.restoreGeneration(NODE, stackName, generationId, ['compose.yaml']),
    ).rejects.toMatchObject({ restoreRevertFailed: true });
  });

  it('encrypts sensitive pre-restore snapshots and restores them from ciphertext', async () => {
    const stackName = 'presensitive';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, '.env'), 'CAPTURED=1\n', 'utf8');

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
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

    await fsPromises.writeFile(path.join(stackDir, '.env'), 'SUPERSECRET=live\n', 'utf8');
    await RollbackGenerationStore.restoreGeneration(
      NODE,
      stackName,
      generationId,
      ['compose.yaml', '.env'],
    );

    const genDir = RollbackGenerationStore.getGenerationDir(NODE, stackName, generationId);
    const blobsDir = path.join(genDir, 'pre-restore', 'blobs');
    const blobNames = await fsPromises.readdir(blobsDir);
    expect(blobNames.length).toBeGreaterThan(0);
    for (const name of blobNames) {
      const blob = await fsPromises.readFile(path.join(blobsDir, name));
      expect(blob.toString('utf8')).not.toContain('SUPERSECRET');
      expect(blob.toString('utf8')).not.toContain('CAPTURED=1');
    }
    const index = JSON.parse(
      await fsPromises.readFile(path.join(genDir, 'pre-restore', 'index.json'), 'utf8'),
    ) as { entries: Array<{ relativePath: string; encrypted?: boolean; blobId?: string }> };
    const envEntry = index.entries.find((e) => e.relativePath === '.env');
    expect(envEntry?.encrypted).toBe(true);
    expect(envEntry?.blobId).toBeTruthy();
    const envBlob = await fsPromises.readFile(path.join(blobsDir, envEntry!.blobId!), 'utf8');
    expect(envBlob.startsWith('enc:')).toBe(true);
    expect(envBlob).not.toContain('SUPERSECRET');

    await RollbackGenerationStore.reconcileInterruptedRestore(NODE, stackName, generationId);
    expect(await fsPromises.readFile(path.join(stackDir, '.env'), 'utf8')).toBe('SUPERSECRET=live\n');
  });

  it('persists runtime image identity on an existing generation', async () => {
    const stackName = 'imgid';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');
    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName,
      generationId,
      inventory: inventoryFor(stackName, [
        { relativePath: 'compose.yaml', absolutePath: path.join(stackDir, 'compose.yaml') },
      ]),
    });

    await RollbackGenerationStore.attachImages(NODE, stackName, generationId, [{
      serviceName: 'web',
      imageId: 'sha256:abc',
      repoDigest: 'nginx@sha256:digest',
      platform: 'linux/amd64',
      declaredImageRef: 'nginx:latest',
    }]);

    const genDir = RollbackGenerationStore.getGenerationDir(NODE, stackName, generationId);
    const manifest = JSON.parse(
      await fsPromises.readFile(path.join(genDir, 'generation.json'), 'utf8'),
    ) as { images: Array<{ serviceName: string; imageId: string; repoDigest: string; platform: string }> };
    expect(manifest.images).toEqual([{
      serviceName: 'web',
      imageId: 'sha256:abc',
      repoDigest: 'nginx@sha256:digest',
      platform: 'linux/amd64',
      declaredImageRef: 'nginx:latest',
    }]);
  });

  it('does not recursively delete a directory created after an absent-file snapshot', async () => {
    const stackName = 'dirrace';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'OLD\n', 'utf8');

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName,
      generationId,
      inventory: inventoryFor(stackName, [
        { relativePath: 'compose.yaml', absolutePath: path.join(stackDir, 'compose.yaml') },
      ]),
    });

    await RollbackGenerationStore.restoreGeneration(
      NODE,
      stackName,
      generationId,
      ['compose.yaml', 'scratch'],
    );

    const scratchDir = path.join(stackDir, 'scratch');
    await fsPromises.mkdir(scratchDir, { recursive: true });
    await fsPromises.writeFile(path.join(scratchDir, 'keep.txt'), 'unrelated\n', 'utf8');

    await expect(
      RollbackGenerationStore.reconcileInterruptedRestore(NODE, stackName, generationId),
    ).rejects.toMatchObject({ code: 'DIRECTORY_COLLISION' });

    expect(await fsPromises.readFile(path.join(scratchDir, 'keep.txt'), 'utf8')).toBe('unrelated\n');
    const genDir = RollbackGenerationStore.getGenerationDir(NODE, stackName, generationId);
    await expect(fsPromises.access(path.join(genDir, 'restore-intent.json'))).resolves.toBeUndefined();
  });
});

describe('RollbackGenerationStore uncaptured paths', () => {
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

  async function captureWithExcludedEnv(stackName: string): Promise<{ stackDir: string; generationId: string }> {
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');
    const shared = path.join(composeDir, 'shared.env');
    await fsPromises.writeFile(shared, 'A=1\n', 'utf8');
    await fsPromises.symlink(shared, path.join(stackDir, '.env'));

    const generationId = randomUUID();
    const inventory = {
      ...inventoryFor(stackName, [
        { relativePath: 'compose.yaml', absolutePath: path.join(stackDir, 'compose.yaml') },
      ]),
      uncapturedInputs: ['.env links outside the stack directory and is not captured'],
      uncapturedRelativePaths: ['.env'],
    };
    const manifest = await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName,
      generationId,
      inventory,
    });
    expect(manifest.uncapturedRelativePaths).toEqual(['.env']);
    expect(manifest.entries.map((e) => e.relativePath)).toEqual(['compose.yaml']);
    return { stackDir, generationId };
  }

  it('persists the excluded paths on the verified generation', async () => {
    const { generationId } = await captureWithExcludedEnv('persist');

    const read = await RollbackGenerationStore.readVerifiedGeneration(NODE, 'persist', generationId);

    expect(read.uncapturedRelativePaths).toEqual(['.env']);
  });

  it('does not delete a real file that replaced an excluded link when it restores', async () => {
    const { stackDir, generationId } = await captureWithExcludedEnv('keep');
    await fsPromises.rm(path.join(stackDir, '.env'));
    await fsPromises.writeFile(path.join(stackDir, '.env'), 'NEW=2\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {x: {}}\n', 'utf8');

    await RollbackGenerationStore.restoreGeneration(NODE, 'keep', generationId, ['compose.yaml', '.env']);

    expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf8')).toBe('services: {}\n');
    expect(await fsPromises.readFile(path.join(stackDir, '.env'), 'utf8')).toBe('NEW=2\n');
  });

  it('keeps a real file that replaced a data link even when no input was noted', async () => {
    const stackName = 'datalink';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');
    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName,
      generationId,
      inventory: {
        ...inventoryFor(stackName, [
          { relativePath: 'compose.yaml', absolutePath: path.join(stackDir, 'compose.yaml') },
        ]),
        uncapturedInputs: [],
        uncapturedRelativePaths: ['config.json'],
      },
    });
    await fsPromises.writeFile(path.join(stackDir, 'config.json'), '{"keep":true}\n', 'utf8');

    await RollbackGenerationStore.restoreGeneration(NODE, stackName, generationId, ['compose.yaml', 'config.json']);

    expect(await fsPromises.readFile(path.join(stackDir, 'config.json'), 'utf8')).toBe('{"keep":true}\n');
  });

  it('does not delete a live file the caller discovered when the generation has uncaptured inputs', async () => {
    const { stackDir, generationId } = await captureWithExcludedEnv('discovered');
    const genJson = path.join(RollbackGenerationStore.getGenerationDir(NODE, 'discovered', generationId), 'generation.json');
    const withNote = JSON.parse(await fsPromises.readFile(genJson, 'utf8'));
    expect(withNote.uncapturedInputs).toHaveLength(1);
    await fsPromises.writeFile(path.join(stackDir, 'app.env'), 'SECRET=1\n', 'utf8');

    await RollbackGenerationStore.restoreGeneration(NODE, 'discovered', generationId, ['compose.yaml', 'app.env']);

    expect(await fsPromises.readFile(path.join(stackDir, 'app.env'), 'utf8')).toBe('SECRET=1\n');
  });

  it('rejects a generation manifest whose uncaptured list is malformed', async () => {
    const { generationId } = await captureWithExcludedEnv('malformed');
    const genJson = path.join(RollbackGenerationStore.getGenerationDir(NODE, 'malformed', generationId), 'generation.json');
    const broken = JSON.parse(await fsPromises.readFile(genJson, 'utf8'));
    broken.uncapturedRelativePaths = '.env';
    await fsPromises.writeFile(genJson, JSON.stringify(broken), 'utf8');

    await expect(RollbackGenerationStore.readVerifiedGeneration(NODE, 'malformed', generationId))
      .rejects.toThrow(/malformed uncaptured list/);
  });

  it('still deletes a file discovered after capture when the generation is complete', async () => {
    const stackDir = path.join(composeDir, 'complete');
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');
    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'complete',
      generationId,
      inventory: inventoryFor('complete', [
        { relativePath: 'compose.yaml', absolutePath: path.join(stackDir, 'compose.yaml') },
      ]),
    });
    await fsPromises.writeFile(path.join(stackDir, 'extra.env'), 'X=1\n', 'utf8');

    await RollbackGenerationStore.restoreGeneration(NODE, 'complete', generationId, ['compose.yaml', 'extra.env']);

    await expect(fsPromises.access(path.join(stackDir, 'extra.env'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('RollbackGenerationStore with a linked compose directory', () => {
  let realDir: string;
  let linkDir: string;
  let dataDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    realDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-realroot-'));
    linkDir = `${realDir}-link`;
    await fsPromises.symlink(realDir, linkDir);
    dataDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-data-'));
    mockState.composeDir = linkDir;
    mockState.composeDirs = new Map([[1, linkDir]]);
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    await fsPromises.rm(linkDir, { force: true });
    await fsPromises.rm(realDir, { recursive: true, force: true });
    await fsPromises.rm(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('captures a plain stack when the compose directory is itself a link', async () => {
    const stackDir = path.join(linkDir, 'plain');
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');

    const manifest = await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName: 'plain',
      generationId: randomUUID(),
      inventory: inventoryFor('plain', [
        { relativePath: 'compose.yaml', absolutePath: path.join(stackDir, 'compose.yaml') },
      ]),
    });

    expect(manifest.entries.map((e) => e.relativePath)).toEqual(['compose.yaml']);
  });

  it('restores and reconciles a generation captured under the linked compose directory', async () => {
    const stackName = 'linkedrestore';
    const stackDir = path.join(realDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');
    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: NODE,
      stackName,
      generationId,
      inventory: inventoryFor(stackName, [
        { relativePath: 'compose.yaml', absolutePath: path.join(stackDir, 'compose.yaml') },
      ]),
    });

    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services:\n  web: {}\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'later.txt'), 'added after capture\n', 'utf8');

    await RollbackGenerationStore.restoreGeneration(NODE, stackName, generationId, ['compose.yaml', 'later.txt']);

    // The capture is only admissible if its restore actually runs, so the
    // physical path of every file must clear the real stack root, not the
    // lexical one that the compose-directory link makes different.
    expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf8')).toBe('services: {}\n');
    await expect(fsPromises.access(path.join(stackDir, 'later.txt'))).rejects.toMatchObject({ code: 'ENOENT' });

    // A compose up or health failure after a successful restore reverts it from
    // the same snapshot, which resolves paths the same way.
    expect(await RollbackGenerationStore.reconcileInterruptedRestore(NODE, stackName, generationId)).toBe(true);
    expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf8')).toBe(
      'services:\n  web: {}\n',
    );
    expect(await fsPromises.readFile(path.join(stackDir, 'later.txt'), 'utf8')).toBe('added after capture\n');
  });

  it('still refuses a stack directory that links to another location', async () => {
    const elsewhere = path.join(realDir, 'elsewhere');
    await fsPromises.mkdir(elsewhere, { recursive: true });
    await fsPromises.writeFile(path.join(elsewhere, 'compose.yaml'), 'services: {}\n', 'utf8');
    await fsPromises.symlink(elsewhere, path.join(realDir, 'moved'));

    await expect(
      RollbackGenerationStore.captureGeneration({
        nodeId: NODE,
        stackName: 'moved',
        generationId: randomUUID(),
        inventory: inventoryFor('moved', [
          { relativePath: 'compose.yaml', absolutePath: path.join(linkDir, 'moved', 'compose.yaml') },
        ]),
      }),
    ).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
  });
});
