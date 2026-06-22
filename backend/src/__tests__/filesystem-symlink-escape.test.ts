/**
 * Symlink/junction escape hardening for FileSystemService's legacy managed-stack
 * methods. A stack directory (or a managed .env / compose.yaml leaf) that is a
 * symlink pointing outside the compose root must be rejected before the
 * read/write/delete sink follows the link out of tree. The lexical inline
 * barriers cannot see symlinks; assertRealWithinBase realpaths both sides.
 *
 * Real symlink creation needs admin or Developer Mode on Windows, so the escape
 * cases run on Linux/macOS (CI) and skip on the Windows dev box, mirroring
 * filesystem-stack-paths.test.ts. The happy-path block at the bottom runs on
 * every platform and confirms the guard is a no-op on normal directories.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const isWindows = process.platform === 'win32';

// Mutable state the mocked NodeRegistry reads; beforeEach rewrites it before any
// FileSystemService is instantiated (the constructor reads composeDir eagerly).
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

import { FileSystemService } from '../services/FileSystemService';

const STACK = 'mystack';

// ── Whole stack directory is a junction pointing out of the compose root ──────
describe.skipIf(isWindows)('FileSystemService symlink-escape: symlinked stack dir', () => {
  let tmpBase: string;
  let composeDir: string;
  let externalTarget: string;
  let dataDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-symesc-'));
    composeDir = path.join(tmpBase, 'compose');
    externalTarget = path.join(tmpBase, 'external');
    await fs.mkdir(composeDir, { recursive: true });
    await fs.mkdir(externalTarget, { recursive: true });
    // Plant sentinel managed files in the out-of-tree target.
    await fs.writeFile(path.join(externalTarget, '.env'), 'SECRET=leaked\n', 'utf-8');
    await fs.writeFile(path.join(externalTarget, 'compose.yaml'), 'services: {}\n', 'utf-8');
    mockState.composeDir = composeDir;
    // The stack directory itself is a junction out of the compose root.
    await fs.symlink(externalTarget, path.join(composeDir, STACK));
    // DATA_DIR backs the backup/restore/snapshot slot.
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-symesc-data-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    await fs.rm(tmpBase, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('saveEnvContent rejects and leaves the out-of-tree .env untouched', async () => {
    const svc = FileSystemService.getInstance();
    await expect(svc.saveEnvContent(STACK, 'PWNED=1\n')).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    expect(await fs.readFile(path.join(externalTarget, '.env'), 'utf-8')).toBe('SECRET=leaked\n');
  });

  it('saveStackContent rejects and leaves the out-of-tree compose.yaml untouched', async () => {
    const svc = FileSystemService.getInstance();
    await expect(svc.saveStackContent(STACK, 'services: { evil: {} }\n')).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    expect(await fs.readFile(path.join(externalTarget, 'compose.yaml'), 'utf-8')).toBe('services: {}\n');
  });

  it('saveStackContentIfUnchanged rejects', async () => {
    const svc = FileSystemService.getInstance();
    await expect(svc.saveStackContentIfUnchanged(STACK, 'services: {}\n', null)).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
  });

  it('deleteStack rejects and the out-of-tree directory survives', async () => {
    const svc = FileSystemService.getInstance();
    await expect(svc.deleteStack(STACK)).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    await expect(fs.access(externalTarget)).resolves.toBeUndefined();
    expect(await fs.readFile(path.join(externalTarget, '.env'), 'utf-8')).toBe('SECRET=leaked\n');
  });

  it('getEnvContent rejects instead of returning the planted secret', async () => {
    const svc = FileSystemService.getInstance();
    await expect(svc.getEnvContent(STACK)).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
  });

  it('envExists degrades to false without throwing', async () => {
    const svc = FileSystemService.getInstance();
    await expect(svc.envExists(STACK)).resolves.toBe(false);
  });

  it('backupStackFiles rejects and does not copy the out-of-tree file into the backup slot', async () => {
    const svc = FileSystemService.getInstance();
    await expect(svc.backupStackFiles(STACK)).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    await expect(fs.access(path.join(dataDir, 'backups', '1', STACK, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restoreStackFiles rejects before reading the backup slot', async () => {
    const svc = FileSystemService.getInstance();
    await expect(svc.restoreStackFiles(STACK)).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
  });

  it('snapshotStackFiles rejects and never captures the out-of-tree contents', async () => {
    const svc = FileSystemService.getInstance();
    await expect(svc.snapshotStackFiles(STACK)).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
  });

  it('getStackContentWithMtime rejects via the guarded getComposeFilePath', async () => {
    await fs.writeFile(path.join(externalTarget, 'compose.yaml'), 'services: { evil: {} }\n', 'utf-8');
    const svc = FileSystemService.getInstance();
    await expect(svc.getStackContentWithMtime(STACK)).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
  });

  it('generic readFile/writeFile/access through the symlinked stack dir reject', async () => {
    const svc = FileSystemService.getInstance();
    const envAbs = path.join(composeDir, STACK, '.env');
    await expect(svc.readFile(envAbs)).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    await expect(svc.access(envAbs)).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    await expect(svc.writeFile(envAbs, 'PWNED=1\n')).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    expect(await fs.readFile(path.join(externalTarget, '.env'), 'utf-8')).toBe('SECRET=leaked\n');
  });

  it('writeFileIfUnchanged/statMtime through the symlinked stack dir reject (env PUT route sinks)', async () => {
    const svc = FileSystemService.getInstance();
    const envAbs = path.join(composeDir, STACK, '.env');
    await expect(svc.writeFileIfUnchanged(envAbs, 'PWNED=1\n', null)).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    await expect(svc.statMtime(envAbs)).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    expect(await fs.readFile(path.join(externalTarget, '.env'), 'utf-8')).toBe('SECRET=leaked\n');
  });
});

// ── A managed .env leaf is a symlink out of tree (stack dir is real) ──────────
describe.skipIf(isWindows)('FileSystemService symlink-escape: symlinked managed-file leaf', () => {
  let tmpBase: string;
  let composeDir: string;
  let stackDir: string;
  let externalEnv: string;

  beforeEach(async () => {
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-symleaf-'));
    composeDir = path.join(tmpBase, 'compose');
    stackDir = path.join(composeDir, STACK);
    await fs.mkdir(stackDir, { recursive: true });
    externalEnv = path.join(tmpBase, 'outside.env');
    await fs.writeFile(externalEnv, 'SECRET=leaked\n', 'utf-8');
    mockState.composeDir = composeDir;
    // The .env inside an otherwise-normal stack dir links out of tree.
    await fs.symlink(externalEnv, path.join(stackDir, '.env'));
  });

  afterEach(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  it('saveEnvContent rejects and leaves the linked target untouched', async () => {
    const svc = FileSystemService.getInstance();
    await expect(svc.saveEnvContent(STACK, 'PWNED=1\n')).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    expect(await fs.readFile(externalEnv, 'utf-8')).toBe('SECRET=leaked\n');
  });

  it('getEnvContent rejects instead of returning the linked secret', async () => {
    const svc = FileSystemService.getInstance();
    await expect(svc.getEnvContent(STACK)).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
  });
});

// ── Dangling (broken) symlinks: a link whose target does not exist must still ─
//    be rejected, because a write/mkdir would follow it out of tree.
describe.skipIf(isWindows)('FileSystemService symlink-escape: dangling (broken) symlink', () => {
  let tmpBase: string;
  let composeDir: string;
  let stackDir: string;

  beforeEach(async () => {
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-symdangle-'));
    composeDir = path.join(tmpBase, 'compose');
    stackDir = path.join(composeDir, STACK);
    await fs.mkdir(stackDir, { recursive: true });
    mockState.composeDir = composeDir;
  });

  afterEach(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  it('rejects a dangling .env leaf (link to a non-existent target)', async () => {
    await fs.symlink(path.join(tmpBase, 'does-not-exist.env'), path.join(stackDir, '.env'));
    const svc = FileSystemService.getInstance();
    await expect(svc.saveEnvContent(STACK, 'PWNED=1\n')).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    await expect(svc.getEnvContent(STACK)).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
  });

  it('rejects a dangling stack-dir junction (link to a non-existent target)', async () => {
    await fs.symlink(path.join(tmpBase, 'no-such-dir'), path.join(composeDir, 'ghost'));
    const svc = FileSystemService.getInstance();
    await expect(svc.createStack('ghost')).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    await expect(svc.saveEnvContent('ghost', 'X=1\n')).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
  });
});

// ── The compose root itself is a symlink: must NOT be a false positive ───────
describe.skipIf(isWindows)('FileSystemService symlink-escape: symlinked compose root is allowed', () => {
  let tmpBase: string;
  let realBase: string;
  let linkBase: string;

  beforeEach(async () => {
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-symbase-'));
    realBase = path.join(tmpBase, 'realbase');
    linkBase = path.join(tmpBase, 'linkbase');
    await fs.mkdir(path.join(realBase, STACK), { recursive: true });
    await fs.writeFile(path.join(realBase, STACK, '.env'), 'OK=1\n', 'utf-8');
    await fs.writeFile(path.join(realBase, STACK, 'compose.yaml'), 'services: {}\n', 'utf-8');
    // COMPOSE_DIR is a symlink to the real base; both canonicalize alike.
    await fs.symlink(realBase, linkBase);
    mockState.composeDir = linkBase;
  });

  afterEach(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  it('getEnvContent reads through the symlinked root', async () => {
    const svc = FileSystemService.getInstance();
    await expect(svc.getEnvContent(STACK)).resolves.toBe('OK=1\n');
  });

  it('saveEnvContent writes through the symlinked root', async () => {
    const svc = FileSystemService.getInstance();
    await expect(svc.saveEnvContent(STACK, 'OK=2\n')).resolves.toBeUndefined();
    expect(await fs.readFile(path.join(realBase, STACK, '.env'), 'utf-8')).toBe('OK=2\n');
  });

  it('createStack succeeds under the symlinked root', async () => {
    const svc = FileSystemService.getInstance();
    await expect(svc.createStack('fresh')).resolves.toBeUndefined();
    expect(await fs.readFile(path.join(realBase, 'fresh', 'compose.yaml'), 'utf-8')).toContain('services:');
  });
});

// ── migrateFlatToDirectory skips an escaping entry rather than aborting all ──
describe.skipIf(isWindows)('FileSystemService symlink-escape: migrate skips an escaping entry', () => {
  let tmpBase: string;
  let composeDir: string;
  let externalTarget: string;

  beforeEach(async () => {
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-symmig-'));
    composeDir = path.join(tmpBase, 'compose');
    externalTarget = path.join(tmpBase, 'external');
    await fs.mkdir(composeDir, { recursive: true });
    await fs.mkdir(externalTarget, { recursive: true });
    mockState.composeDir = composeDir;
  });

  afterEach(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  it('skips a flat entry whose target dir is a symlink out of tree, migrates the rest', async () => {
    await fs.writeFile(path.join(composeDir, 'app.yaml'), 'services: {}\n', 'utf-8');
    await fs.writeFile(path.join(composeDir, 'evil.yaml'), 'services: {}\n', 'utf-8');
    await fs.symlink(externalTarget, path.join(composeDir, 'evil'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const svc = FileSystemService.getInstance();
    await expect(svc.migrateFlatToDirectory()).resolves.toBeUndefined();

    // The legitimate stack migrated.
    expect(await fs.readFile(path.join(composeDir, 'app', 'compose.yaml'), 'utf-8')).toBe('services: {}\n');
    // The escaping entry was skipped: nothing was written through the symlink.
    await expect(fs.access(path.join(externalTarget, 'compose.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
    warn.mockRestore();
  });
});

// ── Happy path on every platform: the guard is a no-op on normal directories ──
describe('FileSystemService symlink-escape: happy path (no symlinks)', () => {
  let composeDir: string;

  beforeEach(async () => {
    composeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-symok-'));
    mockState.composeDir = composeDir;
  });

  afterEach(async () => {
    await fs.rm(composeDir, { recursive: true, force: true });
  });

  it('createStack then saveEnvContent / saveStackContent / deleteStack round-trip', async () => {
    const svc = FileSystemService.getInstance();
    await svc.createStack(STACK);
    expect(await fs.readFile(path.join(composeDir, STACK, 'compose.yaml'), 'utf-8')).toContain('services:');

    await svc.saveStackContent(STACK, 'services: { web: {} }\n');
    expect(await fs.readFile(path.join(composeDir, STACK, 'compose.yaml'), 'utf-8')).toBe('services: { web: {} }\n');

    const read = await svc.getStackContentWithMtime(STACK);
    expect(read.content).toBe('services: { web: {} }\n');

    await svc.saveEnvContent(STACK, 'FOO=bar\n');
    expect(await fs.readFile(path.join(composeDir, STACK, '.env'), 'utf-8')).toBe('FOO=bar\n');

    await svc.deleteStack(STACK);
    await expect(fs.access(path.join(composeDir, STACK))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('migrateFlatToDirectory moves a flat compose + env into a stack directory', async () => {
    await fs.writeFile(path.join(composeDir, 'web.yaml'), 'services: {}\n', 'utf-8');
    await fs.writeFile(path.join(composeDir, 'web.env'), 'FOO=bar\n', 'utf-8');

    const svc = FileSystemService.getInstance();
    await expect(svc.migrateFlatToDirectory()).resolves.toBeUndefined();

    expect(await fs.readFile(path.join(composeDir, 'web', 'compose.yaml'), 'utf-8')).toBe('services: {}\n');
    expect(await fs.readFile(path.join(composeDir, 'web', '.env'), 'utf-8')).toBe('FOO=bar\n');
  });
});
