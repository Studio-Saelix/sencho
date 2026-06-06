/**
 * Tests for FileSystemService.importCandidateIntoStack: the single write path of
 * the guided import flow. Uses a real temp directory so the on-disk rename and
 * the containment guards are exercised against the actual filesystem.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';

const { tmpRoot } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('fs');
  const tmpRoot: string = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'sencho-import-move-'));
  return { tmpRoot };
});

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getComposeDir: () => tmpRoot,
      getDefaultNodeId: () => 1,
    }),
  },
}));

import { FileSystemService } from '../services/FileSystemService';

const COMPOSE = 'services:\n  app:\n    image: nginx:1.27\n';

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('FileSystemService.importCandidateIntoStack', () => {
  it('moves a loose-root file into its own stack subfolder', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'docker-compose.yml'), COMPOSE);
    await FileSystemService.getInstance().importCandidateIntoStack(
      { location: 'docker-compose.yml', composeFile: 'docker-compose.yml', status: 'loose-root' },
      'webapp',
    );
    // The file now lives under <base>/webapp/ and the root copy is gone.
    expect(fs.existsSync(path.join(tmpRoot, 'webapp', 'docker-compose.yml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, 'docker-compose.yml'))).toBe(false);
    // Auto-discovery now lists it as a stack.
    expect(await FileSystemService.getInstance().getStacks()).toContain('webapp');
  });

  it('leaves sibling root files (a root .env) untouched when moving a loose-root file', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'compose.yaml'), COMPOSE);
    fs.writeFileSync(path.join(tmpRoot, '.env'), 'TOKEN=keep-me\n');
    await FileSystemService.getInstance().importCandidateIntoStack(
      { location: 'compose.yaml', composeFile: 'compose.yaml', status: 'loose-root' },
      'onlyfile',
    );
    expect(fs.existsSync(path.join(tmpRoot, 'onlyfile', 'compose.yaml'))).toBe(true);
    // The root .env is not assumed to belong to this compose, so it stays put.
    expect(fs.existsSync(path.join(tmpRoot, '.env'))).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, 'onlyfile', '.env'))).toBe(false);
    fs.rmSync(path.join(tmpRoot, '.env'), { force: true });
  });

  it('promotes a nested stack directory whole, preserving its .env and siblings', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'apps', 'vault'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'apps', 'vault', 'compose.yaml'), COMPOSE);
    fs.writeFileSync(path.join(tmpRoot, 'apps', 'vault', '.env'), 'SECRET=1\n');
    await FileSystemService.getInstance().importCandidateIntoStack(
      { location: 'apps/vault/compose.yaml', composeFile: 'compose.yaml', status: 'nested' },
      'vault',
    );
    expect(fs.existsSync(path.join(tmpRoot, 'vault', 'compose.yaml'))).toBe(true);
    // The whole directory moves, so its .env comes along.
    expect(fs.existsSync(path.join(tmpRoot, 'vault', '.env'))).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, 'apps', 'vault'))).toBe(false);
    expect(await FileSystemService.getInstance().getStacks()).toContain('vault');
  });

  it('honors a destination name different from the nested folder name', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'group', 'api'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'group', 'api', 'compose.yaml'), COMPOSE);
    await FileSystemService.getInstance().importCandidateIntoStack(
      { location: 'group/api/compose.yaml', composeFile: 'compose.yaml', status: 'nested' },
      'renamed-api',
    );
    expect(fs.existsSync(path.join(tmpRoot, 'renamed-api', 'compose.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, 'group', 'api'))).toBe(false);
  });

  it('refuses to overwrite an existing destination stack', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'taken'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'taken', 'compose.yaml'), 'services:\n  existing: {}\n');
    fs.writeFileSync(path.join(tmpRoot, 'compose.yml'), COMPOSE);
    await expect(
      FileSystemService.getInstance().importCandidateIntoStack(
        { location: 'compose.yml', composeFile: 'compose.yml', status: 'loose-root' },
        'taken',
      ),
    ).rejects.toMatchObject({ code: 'DEST_EXISTS' });
    // The source file is left in place; nothing was moved or overwritten.
    expect(fs.existsSync(path.join(tmpRoot, 'compose.yml'))).toBe(true);
    expect(fs.readFileSync(path.join(tmpRoot, 'taken', 'compose.yaml'), 'utf-8')).toContain('existing');
    fs.rmSync(path.join(tmpRoot, 'compose.yml'), { force: true });
  });

  it('does not clobber a destination that appears between the existence check and the move', async () => {
    // Simulate the TOCTOU race: the existence precheck sees nothing, but the
    // destination (with a same-named compose file) exists by the time the move
    // creates it. The non-recursive mkdir must reject rather than merge and let
    // the rename overwrite the existing file.
    const dest = path.join(tmpRoot, 'racewin');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'docker-compose.yml'), 'services:\n  existing: {}\n');
    fs.writeFileSync(path.join(tmpRoot, 'docker-compose.yml'), COMPOSE);
    // Force only the destination existence precheck to report "absent".
    const accessSpy = vi
      .spyOn(fsPromises, 'access')
      .mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    try {
      await expect(
        FileSystemService.getInstance().importCandidateIntoStack(
          { location: 'docker-compose.yml', composeFile: 'docker-compose.yml', status: 'loose-root' },
          'racewin',
        ),
      ).rejects.toMatchObject({ code: 'EEXIST' });
      // The pre-existing file is intact and the source loose file is untouched.
      expect(fs.readFileSync(path.join(dest, 'docker-compose.yml'), 'utf-8')).toContain('existing');
      expect(fs.existsSync(path.join(tmpRoot, 'docker-compose.yml'))).toBe(true);
    } finally {
      accessSpy.mockRestore();
      fs.rmSync(dest, { recursive: true, force: true });
      fs.rmSync(path.join(tmpRoot, 'docker-compose.yml'), { force: true });
    }
  });

  it('rolls back the empty destination directory when the loose-root rename fails', async () => {
    // mkdir succeeds, then the rename fails. The empty destDir it created must be
    // removed so a retry with the same name is not blocked by a phantom
    // "already exists" conflict on the access() precheck.
    fs.writeFileSync(path.join(tmpRoot, 'docker-compose.yml'), COMPOSE);
    const renameSpy = vi
      .spyOn(fsPromises, 'rename')
      .mockRejectedValueOnce(Object.assign(new Error('disk error'), { code: 'EIO' }));
    try {
      await expect(
        FileSystemService.getInstance().importCandidateIntoStack(
          { location: 'docker-compose.yml', composeFile: 'docker-compose.yml', status: 'loose-root' },
          'rollback',
        ),
      ).rejects.toMatchObject({ code: 'EIO' });
      // The empty directory the failed move created was cleaned up...
      expect(fs.existsSync(path.join(tmpRoot, 'rollback'))).toBe(false);
      // ...and the source loose file is left in place for a retry.
      expect(fs.existsSync(path.join(tmpRoot, 'docker-compose.yml'))).toBe(true);
    } finally {
      renameSpy.mockRestore();
      fs.rmSync(path.join(tmpRoot, 'docker-compose.yml'), { force: true });
      fs.rmSync(path.join(tmpRoot, 'rollback'), { recursive: true, force: true });
    }
  });

  it('rejects an invalid destination name without touching the filesystem', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'compose.yaml'), COMPOSE);
    try {
      await expect(
        FileSystemService.getInstance().importCandidateIntoStack(
          { location: 'compose.yaml', composeFile: 'compose.yaml', status: 'loose-root' },
          '../escape',
        ),
      ).rejects.toMatchObject({ code: 'INVALID_STACK_NAME' });
      expect(fs.existsSync(path.join(tmpRoot, 'compose.yaml'))).toBe(true);
    } finally {
      fs.rmSync(path.join(tmpRoot, 'compose.yaml'), { force: true });
    }
  });

  it('refuses to move a loose-root file that symlinks outside the compose directory', async () => {
    const outside = path.join(path.dirname(tmpRoot), `sencho-outside-loose-${Date.now()}.yaml`);
    fs.writeFileSync(outside, COMPOSE);
    let linked = true;
    try {
      fs.symlinkSync(outside, path.join(tmpRoot, 'docker-compose.yml'));
    } catch {
      // Symlink creation needs privilege on some platforms; the assertion runs
      // for real on the Linux CI runners.
      linked = false;
    }
    try {
      if (!linked) return;
      await expect(
        FileSystemService.getInstance().importCandidateIntoStack(
          { location: 'docker-compose.yml', composeFile: 'docker-compose.yml', status: 'loose-root' },
          'escaped',
        ),
      ).rejects.toMatchObject({ code: 'INVALID_PATH' });
      // The out-of-tree file is left in place and no destination stack was made.
      expect(fs.existsSync(outside)).toBe(true);
      expect(fs.existsSync(path.join(tmpRoot, 'escaped'))).toBe(false);
    } finally {
      fs.rmSync(path.join(tmpRoot, 'docker-compose.yml'), { force: true });
      fs.rmSync(outside, { force: true });
    }
  });

  it('refuses to promote a nested directory that symlinks outside the compose directory', async () => {
    const outsideDir = path.join(path.dirname(tmpRoot), `sencho-outside-dir-${Date.now()}`);
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'compose.yaml'), COMPOSE);
    const parent = path.join(tmpRoot, 'parent');
    fs.mkdirSync(parent, { recursive: true });
    let linked = true;
    try {
      fs.symlinkSync(outsideDir, path.join(parent, 'child'), 'dir');
    } catch {
      linked = false;
    }
    try {
      if (!linked) return;
      await expect(
        FileSystemService.getInstance().importCandidateIntoStack(
          { location: 'parent/child/compose.yaml', composeFile: 'compose.yaml', status: 'nested' },
          'escaped-dir',
        ),
      ).rejects.toMatchObject({ code: 'INVALID_PATH' });
      expect(fs.existsSync(path.join(outsideDir, 'compose.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(tmpRoot, 'escaped-dir'))).toBe(false);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
