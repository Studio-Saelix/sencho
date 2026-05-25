import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { promises as fsPromises, createReadStream } from 'fs';
import type { Readable } from 'stream';
import { NodeRegistry } from './NodeRegistry';
import { isPathWithinBase, isValidStackName } from '../utils/validation';
import { isBinaryBuffer } from '../utils/binaryDetect';
import { sanitizeForLog } from '../utils/safeLog';

export interface FileEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  mtime: number;
  isProtected: boolean;
}

/**
 * Resolves the writable Sencho data directory (same one DatabaseService /
 * CryptoService use). Recomputed lazily so test harnesses that override
 * `process.env.DATA_DIR` after module load still take effect.
 */
function getBackupBaseDir(): string {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  return path.join(dataDir, 'backups');
}

import { isDebugEnabled } from '../utils/debug';

const PROTECTED_STACK_FILES = new Set([
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
  '.env',
]);

// Strips at most one trailing slash. The upstream validator
// (isValidRelativeStackPath) rejects any '//' sequence, so a string reaching
// this helper can carry at most one trailing slash, and a single slice is
// sufficient. Avoids the polynomial regex /\/+$/ that CodeQL would flag for
// callers without the upstream length guarantee.
function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function isProtectedRelPath(relPath: string): boolean {
  if (!relPath) return false;
  const normalized = stripTrailingSlash(relPath);
  // Only files at the stack root are protected; compose CLI reads compose.yaml from
  // the stack directory itself, so a subdirectory entry named compose.yaml is just
  // an arbitrary file and the user may want to delete it.
  if (normalized.includes('/')) return false;
  return PROTECTED_STACK_FILES.has(normalized);
}

function protectedFileError(relPath: string): Error & { code: string } {
  const basename = stripTrailingSlash(relPath).split('/').pop() ?? relPath;
  return Object.assign(
    new Error(`${basename} is a protected stack file. Delete the stack itself via Stack Actions instead.`),
    { code: 'PROTECTED_FILE' as const },
  );
}

const MIME_MAP: Record<string, string> = {
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.json': 'application/json',
  '.sh': 'text/x-sh',
  '.env': 'text/plain',
};

/**
 * FileSystemService - local-only file I/O for compose stack management.
 *
 * In the Distributed API model, remote node file operations are handled
 * by the remote Sencho instance itself. This service only operates on
 * the local filesystem.
 */
export class FileSystemService {
  private baseDir: string;
  private nodeId: number;

  constructor(nodeId?: number) {
    this.nodeId = nodeId ?? NodeRegistry.getInstance().getDefaultNodeId();
    this.baseDir = NodeRegistry.getInstance().getComposeDir(this.nodeId);
  }

  public static getInstance(nodeId?: number): FileSystemService {
    return new FileSystemService(nodeId);
  }

  private assertWithinBase(filePath: string): void {
    if (!isPathWithinBase(filePath, this.baseDir)) {
      throw Object.assign(new Error('Path escapes compose directory'), { code: 'INVALID_PATH' });
    }
  }

  private resolveStackDir(stackName: string): string {
    if (!isValidStackName(stackName)) {
      throw Object.assign(new Error('Invalid stack name'), { code: 'INVALID_STACK_NAME' });
    }
    const stackDir = path.join(this.baseDir, stackName);
    this.assertWithinBase(stackDir);
    return stackDir;
  }

  private getBackupDir(stackName: string): string {
    if (!isValidStackName(stackName)) {
      throw Object.assign(new Error('Invalid stack name'), { code: 'INVALID_STACK_NAME' });
    }
    return path.join(getBackupBaseDir(), String(this.nodeId), stackName);
  }

  async hasComposeFile(dir: string): Promise<boolean> {
    this.assertWithinBase(dir);
    const composeFiles = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
    for (const file of composeFiles) {
      try {
        await fsPromises.access(path.join(dir, file));
        return true;
      } catch {
        // continue
      }
    }
    return false;
  }

  private async getComposeFilePath(stackName: string): Promise<string> {
    const stackDir = this.resolveStackDir(stackName);
    const composeFiles = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
    for (const file of composeFiles) {
      const filePath = path.join(stackDir, file);
      try {
        await fsPromises.access(filePath);
        if (isDebugEnabled()) console.debug('[FileSystemService:debug] Resolved compose file', { stackName, file });
        return filePath;
      } catch {
        // continue
      }
    }
    throw new Error(`No compose file found for stack: ${stackName}`);
  }

  async getComposeFilename(stackName: string): Promise<string> {
    return path.basename(await this.getComposeFilePath(stackName));
  }

  async getStacks(): Promise<string[]> {
    try {
      const items = await fsPromises.readdir(this.baseDir, { withFileTypes: true });
      const stackNames: string[] = [];

      for (const item of items) {
        if (!item.isDirectory()) continue;
        if (!item.name || typeof item.name !== 'string') continue;

        const stackDir = path.join(this.baseDir, item.name);
        if (await this.hasComposeFile(stackDir)) {
          stackNames.push(item.name);
        }
      }

      return stackNames;
    } catch (error: any) {
      if (error?.code === 'ENOMEM') {
        const freeMiB = Math.round(os.freemem() / (1024 * 1024));
        console.warn(`[FileSystemService] Failed to list stacks: ENOMEM (host free memory: ${freeMiB} MiB). Returning empty list.`);
      } else {
        console.warn(`[FileSystemService] Failed to list stacks: ${error.message}`);
      }
      return [];
    }
  }

  async getStackContent(stackName: string): Promise<string> {
    try {
      const filePath = await this.getComposeFilePath(stackName);
      return await fsPromises.readFile(filePath, 'utf-8');
    } catch (error) {
      console.error('Error reading stack content:', sanitizeForLog((error as Error)?.message ?? String(error)));
      throw new Error(`Failed to read stack: ${stackName}`);
    }
  }

  /**
   * Read the resolved compose file along with its mtimeMs, which the route
   * layer surfaces as an ETag for optimistic-concurrency on PUT. The stat
   * and read share a single file descriptor so they observe the same inode
   * state, even if the file is replaced (rename) between the two calls.
   */
  async getStackContentWithMtime(stackName: string): Promise<{ content: string; mtimeMs: number }> {
    const untrustedFilePath = await this.getComposeFilePath(stackName);
    // Canonical js/path-injection barrier: resolve against a known-safe root
    // then check the result is contained in that root. The form mirrors
    // CodeQL's documented sanitizer exactly so taint flow recognizes it.
    const baseResolved = path.resolve(this.baseDir);
    const safePath = path.resolve(baseResolved, untrustedFilePath);
    if (!safePath.startsWith(baseResolved + path.sep)) {
      throw Object.assign(new Error('Path escapes compose directory'), { code: 'INVALID_PATH' });
    }
    const fh = await fsPromises.open(safePath, 'r');
    try {
      const stat = await fh.stat();
      const content = await fh.readFile('utf-8');
      return { content, mtimeMs: stat.mtimeMs };
    } finally {
      await fh.close();
    }
  }

  async saveStackContent(stackName: string, content: string): Promise<void> {
    const stackDir = this.resolveStackDir(stackName);
    const filePath = path.join(stackDir, 'compose.yaml');
    try {
      await fsPromises.writeFile(filePath, content, 'utf-8');
    } catch (error) {
      console.error('Error writing file:', error);
      throw new Error(`Failed to save stack: ${stackName}`);
    }
  }

  /**
   * Optimistic-concurrency write: if `expectedMtimeMs` is provided, stat the
   * write target first and return `{ok: false}` with the current content and
   * mtime when they don't match. The route maps that to 412. Mtime comparison
   * uses Math.floor to absorb sub-millisecond jitter from different file
   * systems / Node versions.
   *
   * If the file doesn't exist yet, the write proceeds (no mtime to compare).
   * Returns the new mtimeMs so the route can emit a fresh ETag.
   */
  async saveStackContentIfUnchanged(
    stackName: string,
    content: string,
    expectedMtimeMs: number | null,
  ): Promise<
    | { ok: true; mtimeMs: number }
    | { ok: false; currentMtimeMs: number; currentContent: string }
  > {
    const stackDir = this.resolveStackDir(stackName);
    const untrustedFilePath = path.join(stackDir, 'compose.yaml');
    // Canonical js/path-injection barrier: path.resolve(SAFE_ROOT, untrusted)
    // followed by a single startsWith check, both inline with the sink.
    const baseResolved = path.resolve(this.baseDir);
    const safePath = path.resolve(baseResolved, untrustedFilePath);
    if (!safePath.startsWith(baseResolved + path.sep)) {
      throw Object.assign(new Error('Path escapes compose directory'), { code: 'INVALID_PATH' });
    }

    if (expectedMtimeMs !== null) {
      let fh: import('fs/promises').FileHandle | null = null;
      try {
        fh = await fsPromises.open(safePath, 'r');
        const stat = await fh.stat();
        if (Math.floor(stat.mtimeMs) !== Math.floor(expectedMtimeMs)) {
          const currentContent = await fh.readFile('utf-8');
          return { ok: false, currentMtimeMs: stat.mtimeMs, currentContent };
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        // File doesn't exist yet, treat as fresh write.
      } finally {
        if (fh) await fh.close();
      }
    }

    await fsPromises.writeFile(safePath, content, 'utf-8');
    const newStat = await fsPromises.stat(safePath);
    return { ok: true, mtimeMs: newStat.mtimeMs };
  }

  /**
   * Optimistic-concurrency write for arbitrary paths under the stack dir
   * (used for .env files; the path was already validated by the caller).
   */
  async writeFileIfUnchanged(
    untrustedTargetPath: string,
    content: string,
    expectedMtimeMs: number | null,
  ): Promise<
    | { ok: true; mtimeMs: number }
    | { ok: false; currentMtimeMs: number; currentContent: string }
  > {
    // Canonical js/path-injection barrier: path.resolve(SAFE_ROOT, untrusted)
    // followed by a single startsWith check, both inline with the sink.
    const baseResolved = path.resolve(this.baseDir);
    const safePath = path.resolve(baseResolved, untrustedTargetPath);
    if (!safePath.startsWith(baseResolved + path.sep)) {
      throw Object.assign(new Error('Path escapes compose directory'), { code: 'INVALID_PATH' });
    }

    if (expectedMtimeMs !== null) {
      let fh: import('fs/promises').FileHandle | null = null;
      try {
        fh = await fsPromises.open(safePath, 'r');
        const stat = await fh.stat();
        if (Math.floor(stat.mtimeMs) !== Math.floor(expectedMtimeMs)) {
          const currentContent = await fh.readFile('utf-8');
          return { ok: false, currentMtimeMs: stat.mtimeMs, currentContent };
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      } finally {
        if (fh) await fh.close();
      }
    }

    await fsPromises.writeFile(safePath, content, 'utf-8');
    const newStat = await fsPromises.stat(safePath);
    return { ok: true, mtimeMs: newStat.mtimeMs };
  }

  async statMtime(untrustedTargetPath: string): Promise<number | null> {
    const baseResolved = path.resolve(this.baseDir);
    const safePath = path.resolve(baseResolved, untrustedTargetPath);
    if (!safePath.startsWith(baseResolved + path.sep)) {
      throw Object.assign(new Error('Path escapes compose directory'), { code: 'INVALID_PATH' });
    }
    try {
      const stat = await fsPromises.stat(safePath);
      return stat.mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async envExists(stackName: string): Promise<boolean> {
    const stackDir = this.resolveStackDir(stackName);
    try {
      await fsPromises.access(path.join(stackDir, '.env'));
      return true;
    } catch {
      return false;
    }
  }

  async readFile(filePath: string, encoding: BufferEncoding = 'utf-8'): Promise<string> {
    this.assertWithinBase(filePath);
    return fsPromises.readFile(filePath, encoding);
  }

  async writeFile(filePath: string, content: string, encoding: BufferEncoding = 'utf-8'): Promise<void> {
    this.assertWithinBase(filePath);
    return fsPromises.writeFile(filePath, content, encoding);
  }

  async access(filePath: string): Promise<void> {
    this.assertWithinBase(filePath);
    return fsPromises.access(filePath);
  }

  async getEnvContent(stackName: string): Promise<string> {
    const base = path.resolve(this.baseDir);
    const envPath = path.resolve(base, path.basename(stackName), '.env');
    if (!isPathWithinBase(envPath, base)) {
      throw Object.assign(new Error('Path escapes compose directory'), { code: 'INVALID_PATH' });
    }
    try {
      return await fsPromises.readFile(envPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Error reading env file:', error);
      }
      throw error;
    }
  }

  async saveEnvContent(stackName: string, content: string): Promise<void> {
    const stackDir = this.resolveStackDir(stackName);
    const envPath = path.join(stackDir, '.env');
    try {
      await fsPromises.writeFile(envPath, content, 'utf-8');
    } catch (error) {
      console.error('Error writing env file:', error);
      throw new Error(`Failed to save env file for stack: ${stackName}`);
    }
  }

  async createStack(stackName: string): Promise<void> {
    const stackDir = this.resolveStackDir(stackName);

    try {
      await fsPromises.access(stackDir);
      throw new Error(`Stack "${stackName}" already exists`);
    } catch (error: any) {
      if (error.message.includes('already exists')) throw error;
    }

    await fsPromises.mkdir(stackDir, { recursive: true });

    const boilerplate = `services:
  app:
    image: nginx:latest
    restart: always
    # Uncomment to expose a host port:
    # ports:
    #   - "8080:80"
`;
    try {
      await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), boilerplate, 'utf-8');
    } catch (error) {
      console.error('Error creating stack:', error);
      throw new Error(`Failed to create stack: ${stackName}`);
    }
  }

  public async deleteStack(stackName: string): Promise<void> {
    const stackDir = this.resolveStackDir(stackName);
    try {
      await fsPromises.rm(stackDir, { recursive: true, force: true });
    } catch (error: unknown) {
      const fsError = error as NodeJS.ErrnoException;
      if (fsError.code === 'ENOENT') return;
      console.error('Error deleting stack directory:', fsError.message);
      throw new Error(`Failed to delete stack directory: ${fsError.message}`);
    }
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  async migrateFlatToDirectory(): Promise<void> {
    try {
      try {
        await fsPromises.access(this.baseDir);
      } catch {
        await fsPromises.mkdir(this.baseDir, { recursive: true });
        return;
      }

      const items = await fsPromises.readdir(this.baseDir, { withFileTypes: true });

      for (const item of items) {
        if (!item.isFile()) continue;
        if (!item.name.endsWith('.yml') && !item.name.endsWith('.yaml')) continue;

        const stackName = item.name.replace(/\.(yml|yaml)$/, '');
        const stackDir = path.join(this.baseDir, stackName);

        try {
          await fsPromises.access(stackDir);
          continue;
        } catch {
          // Directory doesn't exist, proceed
        }

        await fsPromises.mkdir(stackDir, { recursive: true });

        const oldComposePath = path.join(this.baseDir, item.name);
        const newComposePath = path.join(stackDir, 'compose.yaml');
        await fsPromises.rename(oldComposePath, newComposePath);

        const oldEnvPath = path.join(this.baseDir, `${stackName}.env`);
        const newEnvPath = path.join(stackDir, '.env');
        try {
          await fsPromises.access(oldEnvPath);
          await fsPromises.rename(oldEnvPath, newEnvPath);
        } catch (e: unknown) {
          const code = (e as NodeJS.ErrnoException)?.code;
          if (code !== 'ENOENT') {
            console.warn(`[FileSystemService] Could not migrate env file for ${stackName}:`, (e as Error).message);
          }
        }

      }
    } catch (error) {
      console.error('Migration error:', error);
    }
  }

  /**
   * Backup stack files (compose.yaml + .env) into Sencho's data dir.
   *
   * Backups live at <DATA_DIR>/backups/<nodeId>/<stackName>/ (NOT inside the user's
   * compose folder) so the operation always succeeds even when the stack
   * folder is owned by another UID (e.g., a container running as root has
   * chowned its bind mount). DATA_DIR is the same writable location that
   * holds sencho.db and encryption.key.
   */
  async backupStackFiles(stackName: string): Promise<void> {
    const debug = isDebugEnabled();
    const t0 = Date.now();
    const stackDir = this.resolveStackDir(stackName);
    const backupDir = this.getBackupDir(stackName);
    await fsPromises.mkdir(backupDir, { recursive: true });

    // Copy compose file
    const composeFiles = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
    for (const file of composeFiles) {
      const src = path.join(stackDir, file);
      try {
        await fsPromises.access(src);
        await fsPromises.copyFile(src, path.join(backupDir, file));
      } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException)?.code;
        if (code !== 'ENOENT') {
          console.warn(`[FileSystemService] Could not back up ${file}:`, (e as Error).message);
        }
      }
    }

    // Copy .env if it exists
    const envSrc = path.join(stackDir, '.env');
    try {
      await fsPromises.access(envSrc);
      await fsPromises.copyFile(envSrc, path.join(backupDir, '.env'));
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        console.warn('[FileSystemService] Could not back up .env:', (e as Error).message);
      }
    }

    // Write timestamp marker
    await fsPromises.writeFile(path.join(backupDir, '.timestamp'), Date.now().toString(), 'utf-8');
    if (debug) console.debug(`[FileSystemService:debug] Backup completed in ${Date.now() - t0}ms`, { stackName });
  }

  async restoreStackFiles(stackName: string): Promise<void> {
    const debug = isDebugEnabled();
    const t0 = Date.now();
    const stackDir = this.resolveStackDir(stackName);
    const backupDir = this.getBackupDir(stackName);

    const items = await fsPromises.readdir(backupDir);
    for (const item of items) {
      if (item === '.timestamp') continue;
      await fsPromises.copyFile(path.join(backupDir, item), path.join(stackDir, item));
    }
    if (debug) console.debug(`[FileSystemService:debug] Restore completed in ${Date.now() - t0}ms`, { stackName, files: items.filter(i => i !== '.timestamp') });
  }

  async getBackupInfo(stackName: string): Promise<{ exists: boolean; timestamp: number | null }> {
    const backupDir = this.getBackupDir(stackName);
    try {
      await fsPromises.access(backupDir);
      const tsFile = path.join(backupDir, '.timestamp');
      try {
        const ts = await fsPromises.readFile(tsFile, 'utf-8');
        return { exists: true, timestamp: parseInt(ts, 10) || null };
      } catch (e) {
        console.warn('[FileSystemService] Backup timestamp file unreadable:', (e as Error).message);
        return { exists: true, timestamp: null };
      }
    } catch {
      return { exists: false, timestamp: null };
    }
  }

  // ---------------------------------------------------------------------------
  // Stack-scoped file explorer methods
  // ---------------------------------------------------------------------------

  private guessMime(filePath: string): string {
    if (path.basename(filePath) === '.env') return 'text/plain';
    const ext = path.extname(filePath).toLowerCase();
    return MIME_MAP[ext] ?? 'text/plain';
  }

  private async resolveSafeStackPath(stackName: string, relPath: string): Promise<string> {
    const stackDir = path.join(this.baseDir, stackName);
    if (!isPathWithinBase(stackDir, this.baseDir)) {
      throw Object.assign(new Error('Stack name escapes compose directory'), { code: 'INVALID_PATH' });
    }
    const target = relPath === '' ? stackDir : path.resolve(stackDir, relPath);

    if (!isPathWithinBase(target, stackDir)) {
      throw Object.assign(new Error('Path escapes stack directory'), { code: 'INVALID_PATH' });
    }

    let realTarget: string;
    try {
      realTarget = await fsPromises.realpath(target);
    } catch (err: unknown) {
      const fsErr = err as NodeJS.ErrnoException;
      if (fsErr.code !== 'ENOENT') throw err;

      // Walk up to the deepest existing ancestor, then reattach the suffix.
      let existing = target;
      const suffix: string[] = [];
      while (true) {
        const parent = path.dirname(existing);
        if (parent === existing) {
          // Reached filesystem root without finding an existing path.
          throw Object.assign(new Error('Path escapes stack directory'), { code: 'INVALID_PATH' });
        }
        suffix.unshift(path.basename(existing));
        existing = parent;
        try {
          const realExisting = await fsPromises.realpath(existing);
          if (!isPathWithinBase(realExisting, stackDir)) {
            throw Object.assign(new Error('Symlink escapes stack directory'), { code: 'SYMLINK_ESCAPE' });
          }
          realTarget = path.join(realExisting, ...suffix);
          break;
        } catch (innerErr: unknown) {
          const innerFsErr = innerErr as NodeJS.ErrnoException;
          if (innerFsErr.code !== 'ENOENT') throw innerErr;
          // Continue walking up.
        }
      }
    }

    if (!isPathWithinBase(realTarget, stackDir)) {
      throw Object.assign(new Error('Symlink escapes stack directory'), { code: 'SYMLINK_ESCAPE' });
    }

    return realTarget;
  }

  async listStackDirectory(stackName: string, relPath: string): Promise<FileEntry[]> {
    const safePath = await this.resolveSafeStackPath(stackName, relPath);
    const dirents = await fsPromises.readdir(safePath, { withFileTypes: true });

    const entries = await Promise.all(
      dirents.map(async (dirent): Promise<FileEntry> => {
        const entryPath = path.join(safePath, dirent.name);
        let size = 0;
        let mtime = 0;
        try {
          const st = await fsPromises.stat(entryPath);
          size = dirent.isDirectory() ? 0 : st.size;
          mtime = st.mtimeMs;
        } catch {
          // stat can fail for broken symlinks; use defaults.
        }
        const type: FileEntry['type'] = dirent.isDirectory()
          ? 'directory'
          : dirent.isSymbolicLink()
          ? 'symlink'
          : 'file';
        return {
          name: dirent.name,
          type,
          size,
          mtime,
          isProtected: PROTECTED_STACK_FILES.has(dirent.name),
        };
      })
    );

    return entries.sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (a.type !== 'directory' && b.type === 'directory') return 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
  }

  async readStackFile(
    stackName: string,
    relPath: string,
    maxBytes: number = 2 * 1024 * 1024
  ): Promise<{ content?: string; binary: boolean; oversized: boolean; size: number; mime: string; mtimeMs: number }> {
    const safePath = await this.resolveSafeStackPath(stackName, relPath);
    const mime = this.guessMime(safePath);

    // Open once and stat+read through the same handle so the mtime returned to
    // the client matches the bytes it received, even if the file is replaced
    // (atomic rename) between the two operations.
    const fh = await fsPromises.open(safePath, 'r');
    try {
      const stat = await fh.stat();
      const mtimeMs = stat.mtimeMs;

      if (stat.isDirectory()) {
        throw Object.assign(new Error('Target is a directory'), { code: 'IS_DIRECTORY' });
      }

      if (stat.size > maxBytes) {
        const probe = Buffer.allocUnsafe(8192);
        const { bytesRead } = await fh.read(probe, 0, 8192, 0);
        const binary = isBinaryBuffer(probe.subarray(0, bytesRead));
        return { binary, oversized: true, size: stat.size, mime, mtimeMs };
      }

      const buf = await fh.readFile();

      if (isBinaryBuffer(buf)) {
        return { binary: true, oversized: false, size: stat.size, mime, mtimeMs };
      }

      return { binary: false, oversized: false, size: stat.size, mime, mtimeMs, content: buf.toString('utf-8') };
    } finally {
      await fh.close();
    }
  }

  async streamStackFile(
    stackName: string,
    relPath: string
  ): Promise<{ stream: Readable; size: number; filename: string; mime: string }> {
    const safePath = await this.resolveSafeStackPath(stackName, relPath);
    const stat = await fsPromises.stat(safePath);

    if (stat.isDirectory()) {
      throw Object.assign(new Error('Target is a directory'), { code: 'IS_DIRECTORY' });
    }

    return {
      stream: createReadStream(safePath),
      size: stat.size,
      filename: path.basename(safePath),
      mime: this.guessMime(safePath),
    };
  }

  /**
   * Atomic write: stages the content in a sibling .tmp file in the same
   * directory, fsyncs, then promotes it to the final path. A crash between
   * the open and the rename leaves either the original target intact or a
   * leftover .tmp file (cleaned up on next failure path), never a truncated
   * target.
   *
   * `exclusive: true` uses link+unlink instead of rename so the create is
   * race-free atomic: link fails with EEXIST if the target already exists,
   * giving the caller a definitive "did not exist when we wrote it" signal.
   * The non-exclusive default uses rename, which is atomic against partial
   * reads but clobbers any existing target.
   */
  private async writeStackFileAtomic(
    safePath: string,
    data: string | Buffer,
    opts: { exclusive?: boolean } = {},
  ): Promise<void> {
    await fsPromises.mkdir(path.dirname(safePath), { recursive: true });
    // crypto.randomBytes gives a guaranteed-length high-entropy suffix; Math.random
    // can drop leading zeros which narrows entropy unpredictably.
    const suffix = `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const tmpPath = `${safePath}.sencho-tmp-${suffix}`;
    let stagedTmp = false;
    try {
      const fh = await fsPromises.open(tmpPath, 'wx');
      stagedTmp = true;
      try {
        await fh.writeFile(data);
        await fh.sync();
      } finally {
        await fh.close();
      }
      if (opts.exclusive) {
        // link() is atomic against EEXIST. Tmp and target are guaranteed to live
        // in the same directory (same filesystem); link works on NTFS and any
        // POSIX FS without elevated privileges.
        try {
          await fsPromises.link(tmpPath, safePath);
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
            throw Object.assign(new Error('File already exists'), { code: 'FILE_EXISTS' as const });
          }
          throw err;
        }
      } else {
        await fsPromises.rename(tmpPath, safePath);
        stagedTmp = false;
      }
    } finally {
      if (stagedTmp) {
        await fsPromises.unlink(tmpPath).catch(() => {});
      }
    }
  }

  async writeStackFile(
    stackName: string,
    relPath: string,
    content: string,
    opts?: { exclusive?: boolean },
  ): Promise<void> {
    const safePath = await this.resolveSafeStackPath(stackName, relPath);
    await this.writeStackFileAtomic(safePath, content, opts);
  }

  async writeStackFileBuffer(
    stackName: string,
    relPath: string,
    buffer: Buffer,
    opts?: { exclusive?: boolean },
  ): Promise<void> {
    const safePath = await this.resolveSafeStackPath(stackName, relPath);
    await this.writeStackFileAtomic(safePath, buffer, opts);
  }

  /**
   * Returns 'file' or 'directory' if the resolved path exists, null if it
   * does not. Path-resolution errors (INVALID_PATH, SYMLINK_ESCAPE) propagate
   * so callers do not silently treat a malformed path as 'available for write'.
   * Callers should validate inputs upstream before invoking this helper.
   */
  async pathKind(stackName: string, relPath: string): Promise<'file' | 'directory' | null> {
    const safePath = await this.resolveSafeStackPath(stackName, relPath);
    try {
      const stat = await fsPromises.lstat(safePath);
      if (stat.isDirectory()) return 'directory';
      return 'file';
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * Optimistic-concurrency write for arbitrary stack files (file-explorer
   * editor save path). If `expectedMtimeMs` is provided, opens the target,
   * stats it, and refuses the write (returning current content + mtime) when
   * the stat does not match the caller's expectation. Mirrors the
   * compose-file pattern in saveStackContentIfUnchanged.
   *
   * Mtime comparison uses Math.floor so sub-millisecond jitter between
   * different filesystems and Node versions does not produce false 412s.
   *
   * If the file does not exist yet, the write proceeds (no mtime to compare).
   * Returns the new mtimeMs so the route can emit a fresh ETag.
   */
  async writeStackFileIfUnchanged(
    stackName: string,
    relPath: string,
    content: string,
    expectedMtimeMs: number | null,
  ): Promise<
    | { ok: true; mtimeMs: number }
    | { ok: false; currentMtimeMs: number; currentContent: string }
  > {
    const safePath = await this.resolveSafeStackPath(stackName, relPath);
    await fsPromises.mkdir(path.dirname(safePath), { recursive: true });

    if (expectedMtimeMs !== null) {
      let fh: import('fs/promises').FileHandle | null = null;
      try {
        fh = await fsPromises.open(safePath, 'r');
        const stat = await fh.stat();
        if (Math.floor(stat.mtimeMs) !== Math.floor(expectedMtimeMs)) {
          const currentContent = await fh.readFile('utf-8');
          return { ok: false, currentMtimeMs: stat.mtimeMs, currentContent };
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        // The caller expected an existing file but it has been deleted under
        // the editor. That is itself a conflict (the file is gone, the user
        // is editing into a void) so surface it the same way as a stale-mtime
        // mismatch. An empty current snapshot tells the client "the live
        // version is gone, you are starting from scratch".
        return { ok: false, currentMtimeMs: 0, currentContent: '' };
      } finally {
        if (fh) await fh.close();
      }
    }

    await fsPromises.writeFile(safePath, content, 'utf-8');
    const newStat = await fsPromises.stat(safePath);
    return { ok: true, mtimeMs: newStat.mtimeMs };
  }

  async deleteStackPath(stackName: string, relPath: string, recursive: boolean = false): Promise<void> {
    if (isProtectedRelPath(relPath)) throw protectedFileError(relPath);
    const safePath = await this.resolveSafeStackPath(stackName, relPath);

    if (recursive) {
      await fsPromises.rm(safePath, { recursive: true, force: true });
      return;
    }
    try {
      await fsPromises.unlink(safePath);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'EISDIR') {
        try {
          await fsPromises.rmdir(safePath);
        } catch (inner: unknown) {
          const ie = inner as NodeJS.ErrnoException;
          if (ie.code === 'ENOTEMPTY' || ie.code === 'EEXIST') {
            throw Object.assign(new Error('Directory is not empty'), { code: 'NOT_EMPTY' });
          }
          throw inner;
        }
      } else {
        throw err;
      }
    }
  }

  async mkdirStackPath(stackName: string, relPath: string): Promise<void> {
    const safePath = await this.resolveSafeStackPath(stackName, relPath);
    await fsPromises.mkdir(safePath, { recursive: true });
  }

  async renameStackPath(stackName: string, fromRel: string, toRel: string): Promise<void> {
    if (isProtectedRelPath(fromRel)) throw protectedFileError(fromRel);
    if (isProtectedRelPath(toRel)) throw protectedFileError(toRel);
    const fromPath = await this.resolveSafeStackPath(stackName, fromRel);
    // toRel must resolve to the same parent directory (rename only, no cross-dir move).
    const toPath = await this.resolveSafeStackPath(stackName, toRel);
    if (path.dirname(fromPath) !== path.dirname(toPath)) {
      throw Object.assign(new Error('Cross-directory rename is not supported'), { code: 'INVALID_PATH' });
    }
    const toName = path.basename(toPath);
    if (!toName || toName === '.' || toName === '..') {
      throw Object.assign(new Error('Invalid destination name'), { code: 'INVALID_PATH' });
    }
    // Prevent overwriting an existing path.
    try {
      await fsPromises.access(toPath);
      throw Object.assign(new Error('A file or folder with that name already exists'), { code: 'EEXIST' });
    } catch (e: unknown) {
      const fe = e as NodeJS.ErrnoException;
      if (fe.code !== 'ENOENT') throw e;
    }
    await fsPromises.rename(fromPath, toPath);
  }

  async getStackEntryMode(stackName: string, relPath: string): Promise<{ mode: number; octal: string }> {
    const safePath = await this.resolveSafeStackPath(stackName, relPath);
    const stat = await fsPromises.stat(safePath);
    const mode = stat.mode & 0o777;
    return { mode, octal: mode.toString(8).padStart(3, '0') };
  }

  async chmodStackPath(stackName: string, relPath: string, mode: number): Promise<void> {
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
      throw Object.assign(new Error('Invalid permission bits'), { code: 'INVALID_PATH' });
    }
    if (isProtectedRelPath(relPath)) throw protectedFileError(relPath);
    const safePath = await this.resolveSafeStackPath(stackName, relPath);
    await fsPromises.chmod(safePath, mode);
  }

  async statStackEntry(stackName: string, relPath: string): Promise<FileEntry> {
    const safePath = await this.resolveSafeStackPath(stackName, relPath);
    // Use lstat so symlinks are reported as 'symlink' rather than resolved to target type.
    const stat = await fsPromises.lstat(safePath);
    const name = path.basename(safePath);

    const type: FileEntry['type'] = stat.isDirectory()
      ? 'directory'
      : stat.isSymbolicLink()
      ? 'symlink'
      : 'file';

    return {
      name,
      type,
      size: stat.isDirectory() ? 0 : stat.size,
      mtime: stat.mtimeMs,
      isProtected: PROTECTED_STACK_FILES.has(name),
    };
  }
}
