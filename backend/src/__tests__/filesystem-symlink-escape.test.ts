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

  it('getOverrideFilename rejects instead of resolving an out-of-tree override', async () => {
    await fs.writeFile(path.join(externalTarget, 'compose.override.yml'), 'services: {}\n', 'utf-8');
    const svc = FileSystemService.getInstance();
    await expect(svc.getOverrideFilename(STACK)).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
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
    await expect(svc.writeFileIfUnchanged(STACK, envAbs, 'PWNED=1\n', null)).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
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

// ── Scoped file-explorer writes (bind roots) must reject a dangling symlink ──
//    leaf the same way the legacy managed-stack path does: the editor save sink
//    (writeStackFileIfUnchanged) resolves through resolveSafePathWithin, which
//    must not hand back a link path a follow-on write would traverse out of the
//    root. The escape only triggers on first save (no expected mtime).
describe.skipIf(isWindows)('FileSystemService scoped-root: dangling symlink leaf write', () => {
  let tmpBase: string;
  let composeDir: string;
  let rootDir: string;
  let externalTarget: string;

  beforeEach(async () => {
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-scopedangle-'));
    composeDir = path.join(tmpBase, 'compose');
    rootDir = path.join(tmpBase, 'bindroot');
    externalTarget = path.join(tmpBase, 'outside');
    await fs.mkdir(composeDir, { recursive: true });
    await fs.mkdir(rootDir, { recursive: true });
    // The escape target dir exists; only the leaf file is missing, so the leaf
    // symlink is dangling (realpath ENOENT) but a writeFile would create it.
    await fs.mkdir(externalTarget, { recursive: true });
    mockState.composeDir = composeDir;
  });

  afterEach(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  it('rejects a first-save through a dangling symlink leaf and writes nothing outside the root', async () => {
    await fs.symlink(path.join(externalTarget, 'pwned.conf'), path.join(rootDir, 'leak.conf'));
    const svc = FileSystemService.getInstance();
    await expect(
      svc.writeStackFileIfUnchanged(STACK, 'leak.conf', 'PWNED=1\n', null, { rootAbsDir: rootDir }),
    ).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    await expect(fs.access(path.join(externalTarget, 'pwned.conf'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a scoped read through a dangling symlink leaf (shared resolver guard)', async () => {
    await fs.symlink(path.join(externalTarget, 'secret.conf'), path.join(rootDir, 'peek.conf'));
    const svc = FileSystemService.getInstance();
    await expect(
      svc.readStackFile(STACK, 'peek.conf', undefined, { scope: { rootAbsDir: rootDir } }),
    ).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
  });

  it('writes a normal scoped file atomically (no leftover staging file)', async () => {
    const svc = FileSystemService.getInstance();
    const res = await svc.writeStackFileIfUnchanged(STACK, 'app.conf', 'key=value\n', null, { rootAbsDir: rootDir });
    expect(res.ok).toBe(true);
    expect(await fs.readFile(path.join(rootDir, 'app.conf'), 'utf-8')).toBe('key=value\n');
    // The atomic helper stages into a sibling .sencho-tmp-* file and renames it
    // away; nothing transient should remain in the root after a clean write.
    const entries = await fs.readdir(rootDir);
    expect(entries.filter((e) => e.includes('sencho-tmp'))).toHaveLength(0);
    expect(entries).toEqual(['app.conf']);
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

  it('reads and saves the compose file through the symlinked root', async () => {
    const svc = FileSystemService.getInstance();
    const read = await svc.getStackContentWithMtime(STACK);
    expect(read).toMatchObject({ content: 'services: {}\n', filename: 'compose.yaml' });
    const saved = await svc.saveStackContentIfUnchanged(STACK, 'services: { web: {} }\n', read.mtimeMs, 'compose.yaml');
    expect(saved).toMatchObject({ ok: true, filename: 'compose.yaml' });
    await svc.saveStackContent(STACK, 'services: { api: {} }\n');
    expect(await fs.readFile(path.join(realBase, STACK, 'compose.yaml'), 'utf-8')).toBe('services: { api: {} }\n');
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

describe.skipIf(isWindows)('FileSystemService symlink-escape: alternate compose filename', () => {
  let tmpBase: string;
  let composeDir: string;
  let stackDir: string;
  let outside: string;

  beforeEach(async () => {
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-symcompose-'));
    composeDir = path.join(tmpBase, 'compose');
    stackDir = path.join(composeDir, STACK);
    outside = path.join(tmpBase, 'outside.yml');
    await fs.mkdir(stackDir, { recursive: true });
    await fs.writeFile(outside, 'OUTSIDE=1\n', 'utf-8');
    mockState.composeDir = composeDir;
  });

  afterEach(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  it('rejects a docker-compose.yml symlink that leaves the compose dir and does not create compose.yaml', async () => {
    await fs.symlink(outside, path.join(stackDir, 'docker-compose.yml'));
    const svc = FileSystemService.getInstance();
    await expect(svc.getStackContentWithMtime(STACK)).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    await expect(svc.getStackContent(STACK)).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    await expect(svc.saveStackContentIfUnchanged(STACK, 'pwned\n', null, 'docker-compose.yml')).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    expect(await fs.readFile(outside, 'utf-8')).toBe('OUTSIDE=1\n');
    await expect(fs.access(path.join(stackDir, 'compose.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a dangling docker-compose.yml instead of treating it as a missing compose file', async () => {
    const link = path.join(stackDir, 'docker-compose.yml');
    await fs.symlink(path.join(stackDir, 'missing.yml'), link);
    const svc = FileSystemService.getInstance();
    await expect(svc.saveStackContentIfUnchanged(STACK, 'fresh\n', null)).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    await expect(fs.access(path.join(stackDir, 'compose.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'])(
    'reads a %s that links into a sibling stack but refuses every save through it',
    async (basename) => {
      const sibling = path.join(composeDir, 'other');
      await fs.mkdir(sibling);
      await fs.writeFile(path.join(sibling, 'compose.yaml'), 'services: { other: {} }\n', 'utf-8');
      await fs.symlink('../other/compose.yaml', path.join(stackDir, basename));
      const svc = FileSystemService.getInstance();
      // The link stays inside the compose root, so this stack deploys the shared
      // file and a read follows it. Every write refuses, so nothing this stack
      // saves can land in the other stack's file.
      const read = await svc.getStackContentWithMtime(STACK);
      expect(read).toMatchObject({ content: 'services: { other: {} }\n', filename: basename });
      await expect(svc.getStackContent(STACK)).resolves.toBe('services: { other: {} }\n');
      await expect(svc.saveStackContentIfUnchanged(STACK, 'pwned\n', null, basename)).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
      await expect(svc.saveStackContentIfUnchanged(STACK, 'pwned\n', null)).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
      expect(await fs.readFile(path.join(sibling, 'compose.yaml'), 'utf-8')).toBe('services: { other: {} }\n');
      expect((await fs.lstat(path.join(stackDir, basename))).isSymbolicLink()).toBe(true);
    },
  );

  it('refuses a stack dir that is a link to a sibling stack', async () => {
    const sibling = path.join(composeDir, 'other');
    await fs.mkdir(sibling);
    await fs.writeFile(path.join(sibling, 'compose.yaml'), 'services: { other: {} }\n', 'utf-8');
    await fs.symlink('other', path.join(composeDir, 'alias'));
    const svc = FileSystemService.getInstance();
    await expect(svc.getStackContentWithMtime('alias')).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    await expect(svc.saveStackContentIfUnchanged('alias', 'pwned\n', null, 'compose.yaml')).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    await expect(svc.saveStackContent('alias', 'pwned\n')).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    expect(await fs.readFile(path.join(sibling, 'compose.yaml'), 'utf-8')).toBe('services: { other: {} }\n');
  });

  it('refuses a first save into a stack dir linked to a directory with no compose file', async () => {
    const sibling = path.join(composeDir, 'other');
    await fs.mkdir(sibling);
    await fs.symlink('other', path.join(composeDir, 'alias'));
    const svc = FileSystemService.getInstance();
    await expect(svc.saveStackContentIfUnchanged('alias', 'pwned\n', null)).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    await expect(fs.access(path.join(sibling, 'compose.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('saveStackContent refuses a compose.yaml that links into a sibling stack', async () => {
    const sibling = path.join(composeDir, 'other');
    await fs.mkdir(sibling);
    await fs.writeFile(path.join(sibling, 'compose.yaml'), 'services: { other: {} }\n', 'utf-8');
    await fs.symlink('../other/compose.yaml', path.join(stackDir, 'compose.yaml'));
    const svc = FileSystemService.getInstance();
    await expect(svc.saveStackContent(STACK, 'pwned\n')).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    expect(await fs.readFile(path.join(sibling, 'compose.yaml'), 'utf-8')).toBe('services: { other: {} }\n');
  });

  it('reads and saves through a compose link that stays inside the stack dir', async () => {
    await fs.mkdir(path.join(stackDir, 'env'));
    await fs.writeFile(path.join(stackDir, 'env', 'prod.yml'), 'services: { web: {} }\n', 'utf-8');
    await fs.symlink('env/prod.yml', path.join(stackDir, 'docker-compose.yml'));
    const svc = FileSystemService.getInstance();
    const read = await svc.getStackContentWithMtime(STACK);
    expect(read).toMatchObject({ content: 'services: { web: {} }\n', filename: 'docker-compose.yml' });
    const saved = await svc.saveStackContentIfUnchanged(STACK, 'services: { api: {} }\n', read.mtimeMs, 'docker-compose.yml');
    expect(saved).toMatchObject({ ok: true, filename: 'docker-compose.yml' });
    expect(await fs.readFile(path.join(stackDir, 'env', 'prod.yml'), 'utf-8')).toBe('services: { api: {} }\n');
    expect((await fs.lstat(path.join(stackDir, 'docker-compose.yml'))).isSymbolicLink()).toBe(true);
  });
});

// ── A compose file that links into the shared compose directory: reads follow, ─
//    writes refuse, and the stack directory itself is still never followed ──────
describe.skipIf(isWindows)('FileSystemService: compose file linked into the shared compose directory', () => {
  let tmpBase: string;
  let composeDir: string;
  let stackDir: string;
  let sharedDir: string;
  let sharedCompose: string;

  beforeEach(async () => {
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-sharedlink-'));
    composeDir = path.join(tmpBase, 'compose');
    stackDir = path.join(composeDir, STACK);
    sharedDir = path.join(composeDir, 'shared');
    await fs.mkdir(stackDir, { recursive: true });
    await fs.mkdir(sharedDir, { recursive: true });
    sharedCompose = path.join(sharedDir, 'base.yaml');
    await fs.writeFile(sharedCompose, 'services:\n  shared: {}\n', 'utf-8');
    mockState.composeDir = composeDir;
    await fs.symlink(sharedCompose, path.join(stackDir, 'compose.yaml'));
  });

  afterEach(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  it('reads the linked file and reports the link basename', async () => {
    const svc = FileSystemService.getInstance();
    const read = await svc.getStackContentWithMtime(STACK);
    expect(read).toMatchObject({ content: 'services:\n  shared: {}\n', filename: 'compose.yaml' });
    await expect(svc.getStackContent(STACK)).resolves.toBe('services:\n  shared: {}\n');
    await expect(svc.assertComposeFileReadable(STACK)).resolves.toBeUndefined();
  });

  it('refuses every save through the link and leaves the target untouched', async () => {
    const svc = FileSystemService.getInstance();
    await expect(svc.saveStackContentIfUnchanged(STACK, 'pwned\n', null, 'compose.yaml'))
      .rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    await expect(svc.saveStackContentIfUnchanged(STACK, 'pwned\n', null))
      .rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    await expect(svc.saveStackContent(STACK, 'pwned\n')).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    expect(await fs.readFile(sharedCompose, 'utf-8')).toBe('services:\n  shared: {}\n');
    expect((await fs.lstat(path.join(stackDir, 'compose.yaml'))).isSymbolicLink()).toBe(true);
  });

  it('still refuses a link out of the compose directory', async () => {
    const outside = path.join(tmpBase, 'outside.yml');
    await fs.writeFile(outside, 'services: { outside: {} }\n', 'utf-8');
    await fs.rm(path.join(stackDir, 'compose.yaml'));
    await fs.symlink(outside, path.join(stackDir, 'compose.yaml'));

    const svc = FileSystemService.getInstance();
    await expect(svc.getStackContentWithMtime(STACK)).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    await expect(svc.assertComposeFileReadable(STACK)).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    await expect(svc.saveStackContentIfUnchanged(STACK, 'pwned\n', null)).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    expect(await fs.readFile(outside, 'utf-8')).toBe('services: { outside: {} }\n');
  });

  it('still refuses a stack directory that links to another location', async () => {
    const elsewhere = path.join(composeDir, 'elsewhere');
    await fs.mkdir(elsewhere);
    await fs.writeFile(path.join(elsewhere, 'compose.yaml'), 'services: { other: {} }\n', 'utf-8');
    await fs.rm(stackDir, { recursive: true, force: true });
    await fs.symlink(elsewhere, stackDir);

    const svc = FileSystemService.getInstance();
    await expect(svc.getStackContentWithMtime(STACK)).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    await expect(svc.assertComposeFileReadable(STACK)).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
  });
});

// ── An env file that links into another stack: reads follow, writes refuse ─────
describe.skipIf(isWindows)('FileSystemService: env file linked into another stack', () => {
  let tmpBase: string;
  let composeDir: string;
  let stackDir: string;
  let siblingEnv: string;

  beforeEach(async () => {
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-envlink-'));
    composeDir = path.join(tmpBase, 'compose');
    stackDir = path.join(composeDir, STACK);
    const siblingDir = path.join(composeDir, 'other');
    await fs.mkdir(stackDir, { recursive: true });
    await fs.mkdir(siblingDir, { recursive: true });
    await fs.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf-8');
    siblingEnv = path.join(siblingDir, '.env');
    await fs.writeFile(siblingEnv, 'OTHER=1\n', 'utf-8');
    mockState.composeDir = composeDir;
    await fs.symlink(siblingEnv, path.join(stackDir, '.env'));
  });

  afterEach(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  it('reads the linked env file and saves through a link that stays inside the stack', async () => {
    const svc = FileSystemService.getInstance();
    await expect(svc.getEnvContent(STACK)).resolves.toBe('OTHER=1\n');

    // The same save path with an in-stack link keeps working.
    await fs.rm(path.join(stackDir, '.env'));
    await fs.writeFile(path.join(stackDir, 'real.env'), 'A=1\n', 'utf-8');
    await fs.symlink('real.env', path.join(stackDir, '.env'));
    const saved = await svc.writeFileIfUnchanged(
      STACK,
      path.join(stackDir, '.env'),
      'A=2\n',
      null,
    );
    expect(saved.ok).toBe(true);
    expect(await fs.readFile(path.join(stackDir, 'real.env'), 'utf-8')).toBe('A=2\n');
  });

  it('refuses both env write paths when the link leaves the stack, and leaves the target untouched', async () => {
    const svc = FileSystemService.getInstance();
    await expect(svc.writeFileIfUnchanged(STACK, path.join(stackDir, '.env'), 'PWNED=1\n', null))
      .rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    await expect(svc.saveEnvContent(STACK, 'PWNED=1\n')).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    expect(await fs.readFile(siblingEnv, 'utf-8')).toBe('OTHER=1\n');
    expect((await fs.lstat(path.join(stackDir, '.env'))).isSymbolicLink()).toBe(true);
  });

  it('refuses a link whose sibling target does not exist yet instead of creating it there', async () => {
    await fs.rm(siblingEnv);
    const svc = FileSystemService.getInstance();

    // The link is dangling, and a write would create the file at its target, so
    // the containment guard has to refuse before any create.
    await expect(svc.writeFileIfUnchanged(STACK, path.join(stackDir, '.env'), 'PWNED=1\n', null))
      .rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    await expect(svc.saveEnvContent(STACK, 'PWNED=1\n')).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    await expect(fs.access(siblingEnv)).rejects.toMatchObject({ code: 'ENOENT' });
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
