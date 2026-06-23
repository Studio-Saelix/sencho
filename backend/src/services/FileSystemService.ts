import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { promises as fsPromises, createReadStream, createWriteStream } from 'fs';
import type { Dirent } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { NodeRegistry } from './NodeRegistry';
import { isPathWithinBase, isValidStackName } from '../utils/validation';
import { isBinaryBuffer } from '../utils/binaryDetect';
import { sanitizeForLog } from '../utils/safeLog';

export interface FileEntry {
  name: string;
  // 'other' covers non-regular helper-volume entries (fifo/socket/device): they
  // are unrepresentable on the fs backend but the helper can surface them, and
  // they must stay distinct from 'file' so the archive guard can reject them.
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  mtime: number;
  isProtected: boolean;
}

/**
 * Optional scope for a file-explorer operation. When `rootAbsDir` is set, the
 * operation resolves and is contained within that absolute directory instead of
 * the stack source dir, so the same primitives serve volume-aware bind-mount
 * roots. `protectedEnabled` (compose/.env protection) defaults to true and is
 * set false by the route for non-stack-source roots, where a file named
 * compose.yaml/.env is just an ordinary editable file. The caller is
 * responsible for pre-authorizing `rootAbsDir` (it may legitimately sit outside
 * the compose base dir); this service only enforces containment within it.
 */
export interface FileRootScope {
  rootAbsDir?: string;
  protectedEnabled?: boolean;
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

// Compose filenames Sencho recognizes, in resolution-priority order. Mirrors the
// list FileSystemService uses elsewhere; named here for the import scan.
const IMPORT_COMPOSE_FILENAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'] as const;
const IMPORT_COMPOSE_FILENAME_SET = new Set<string>(IMPORT_COMPOSE_FILENAMES);
// Override filenames docker compose can auto-discover, listed in priority order (first
// match wins, not paired to the chosen base file's family). We resolve the first that
// exists, mirroring compose's default override resolution, to re-add it when an explicit
// -f list (mesh injection) would otherwise suppress that discovery.
const COMPOSE_OVERRIDE_FILENAMES = [
  'compose.override.yaml',
  'compose.override.yml',
  'docker-compose.override.yaml',
  'docker-compose.override.yml',
] as const;
// Skip reading compose files larger than this into the import preview.
const IMPORT_MAX_PREVIEW_BYTES = 1_048_576; // 1 MiB

/**
 * A compose file discovered on disk during the guided import scan that is not yet
 * a stack. `status` records why: a compose file loose at the compose-dir root
 * (`loose-root`) or one directory too deep (`nested`) will not auto-register and
 * needs the user to move it. A top-level subdirectory with a compose file is
 * already a stack (it shows in the sidebar), so the scan skips it and it never
 * appears here. `content` is null when the file was oversized or unreadable.
 */
export interface ImportCandidateRaw {
  name: string;
  composeFile: string;
  location: string;
  status: 'loose-root' | 'nested';
  content: string | null;
  oversized: boolean;
}

/**
 * The subset of an import candidate the move path needs: where the compose file
 * sits and whether it is loose at the root or nested. The scan only surfaces
 * these two placements, so any candidate it returns can be moved into place.
 */
export type MovableImportCandidate = Pick<ImportCandidateRaw, 'location' | 'composeFile' | 'status'>;

// Strips at most one trailing slash. The upstream validator
// (isValidRelativeStackPath) rejects any '//' sequence, so a string reaching
// this helper can carry at most one trailing slash, and a single slice is
// sufficient. Avoids the polynomial regex /\/+$/ that CodeQL would flag for
// callers without the upstream length guarantee.
function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

// On a case-insensitive filesystem (Windows, default macOS) two paths that differ
// only in case point at the same entry, so comparisons that gate filesystem
// mutations must fold case to stay authoritative. On Linux (where Sencho runs in
// production) paths are case-sensitive and this returns the input unchanged.
function fsCaseKey(s: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? s.toLowerCase() : s;
}

/**
 * True when resolved absolute path `candidate` is `parent` itself or sits inside
 * it, compared case-folded so the guard stays authoritative on a case-insensitive
 * filesystem. Used to block moving/copying a directory into its own subtree.
 */
function isSameOrDescendantFsPath(parent: string, candidate: string): boolean {
  const parentKey = fsCaseKey(parent);
  const parentKeyWithSep = parentKey.endsWith(path.sep) ? parentKey : parentKey + path.sep;
  const candidateKey = fsCaseKey(candidate);
  return candidateKey === parentKey || candidateKey.startsWith(parentKeyWithSep);
}

function isProtectedRelPath(relPath: string): boolean {
  if (!relPath) return false;
  const normalized = stripTrailingSlash(relPath);
  // Only files at the stack root are protected; compose CLI reads compose.yaml from
  // the stack directory itself, so a subdirectory entry named compose.yaml is just
  // an arbitrary file and the user may want to delete it.
  if (normalized.includes('/')) return false;
  // Fold case so e.g. a request for COMPOSE.YAML cannot dodge the gate on a
  // case-insensitive filesystem where it resolves to the real compose.yaml.
  return PROTECTED_STACK_FILES.has(fsCaseKey(normalized));
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
    await this.assertRealWithinBase(stackDir);
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

  /**
   * The stack's hand-authored compose override filename (bare basename, e.g.
   * `compose.override.yml`), or `null` when none exists. Mirrors how docker compose
   * itself resolves the default override: the first existing variant in priority order.
   * Callers building an explicit `-f` list (which suppresses compose's built-in override
   * discovery) use this to re-add the implicit override. Applies the same stack-name and
   * symlink-containment guards as `getComposeFilePath`.
   */
  async getOverrideFilename(stackName: string): Promise<string | null> {
    const stackDir = this.resolveStackDir(stackName);
    await this.assertRealWithinBase(stackDir);
    // Canonical js/path-injection barrier inline with the access sink (same pattern as
    // envExists): stackName is already validated by resolveStackDir and assertRealWithinBase
    // above, but static analysis only credits the containment check when it sits at the sink.
    const baseResolved = path.resolve(this.baseDir);
    for (const file of COMPOSE_OVERRIDE_FILENAMES) {
      const target = path.resolve(stackDir, file);
      if (!target.startsWith(baseResolved + path.sep)) continue;
      try {
        await fsPromises.access(target);
        return file;
      } catch {
        // continue
      }
    }
    return null;
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
    await this.assertRealWithinBase(filePath);
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
    await this.assertRealWithinBase(safePath);

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
    await this.assertRealWithinBase(safePath);

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
    await this.assertRealWithinBase(safePath);
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
    // Canonical js/path-injection barrier inline with the access sink, the
    // same pattern backupStackFiles/restoreStackFiles use: stackName is
    // already validated by resolveStackDir above, but static analysis only
    // credits the containment check when it sits at the sink itself.
    const baseResolved = path.resolve(this.baseDir);
    const target = path.resolve(stackDir, '.env');
    if (!target.startsWith(baseResolved + path.sep)) {
      return false;
    }
    try {
      await this.assertRealWithinBase(target);
      await fsPromises.access(target);
      return true;
    } catch {
      return false;
    }
  }

  async readFile(filePath: string, encoding: BufferEncoding = 'utf-8'): Promise<string> {
    this.assertWithinBase(filePath);
    await this.assertRealWithinBase(filePath);
    return fsPromises.readFile(filePath, encoding);
  }

  async writeFile(filePath: string, content: string, encoding: BufferEncoding = 'utf-8'): Promise<void> {
    this.assertWithinBase(filePath);
    await this.assertRealWithinBase(filePath);
    return fsPromises.writeFile(filePath, content, encoding);
  }

  async access(filePath: string): Promise<void> {
    this.assertWithinBase(filePath);
    await this.assertRealWithinBase(filePath);
    return fsPromises.access(filePath);
  }

  async getEnvContent(stackName: string): Promise<string> {
    const base = path.resolve(this.baseDir);
    const envPath = path.resolve(base, path.basename(stackName), '.env');
    if (!isPathWithinBase(envPath, base)) {
      throw Object.assign(new Error('Path escapes compose directory'), { code: 'INVALID_PATH' });
    }
    await this.assertRealWithinBase(envPath);
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
    await this.assertRealWithinBase(envPath);
    try {
      await fsPromises.writeFile(envPath, content, 'utf-8');
    } catch (error) {
      console.error('Error writing env file:', error);
      throw new Error(`Failed to save env file for stack: ${stackName}`);
    }
  }

  async createStack(stackName: string): Promise<void> {
    const stackDir = this.resolveStackDir(stackName);
    await this.assertRealWithinBase(stackDir);

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
    await this.assertRealWithinBase(stackDir);
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

  private async firstComposeFilename(dir: string): Promise<string | null> {
    this.assertWithinBase(dir);
    for (const file of IMPORT_COMPOSE_FILENAMES) {
      try {
        await fsPromises.access(path.join(dir, file));
        return file;
      } catch {
        // continue
      }
    }
    return null;
  }

  private async readComposeCandidate(filePath: string): Promise<{ content: string | null; oversized: boolean }> {
    this.assertWithinBase(filePath);
    let fh: import('fs/promises').FileHandle | null = null;
    try {
      // Resolve symlinks and confirm the real target is still inside the compose
      // directory before reading (matches resolveSafeStackPath). A symlinked
      // compose file or symlinked parent must not expose a file outside the
      // compose dir through the preview.
      const realPath = await fsPromises.realpath(filePath);
      if (!isPathWithinBase(realPath, this.baseDir)) {
        console.warn('[FileSystemService] Skipping import candidate that escapes the compose directory:', sanitizeForLog(filePath));
        return { content: null, oversized: false };
      }
      // Open the canonical path once and stat/read on the same descriptor so the
      // size check and the read observe the same inode (no time-of-check/use race).
      fh = await fsPromises.open(realPath, 'r');
      const stat = await fh.stat();
      if (!stat.isFile()) return { content: null, oversized: false };
      if (stat.size > IMPORT_MAX_PREVIEW_BYTES) return { content: null, oversized: true };
      // Read at most stat.size (<= cap) bytes so a file that grows after the
      // stat cannot push this buffer past the cap.
      const buffer = Buffer.alloc(stat.size);
      const { bytesRead } = await fh.read(buffer, 0, stat.size, 0);
      return { content: buffer.subarray(0, bytesRead).toString('utf-8'), oversized: false };
    } catch (error) {
      // The file existed at probe time, so a failure here (permission, I/O) is
      // worth a server-side line even though the scan degrades gracefully and the
      // route reports it to the user.
      console.warn('[FileSystemService] Failed to read import candidate:', sanitizeForLog((error as Error)?.message ?? String(error)));
      return { content: null, oversized: false };
    } finally {
      if (fh) await fh.close();
    }
  }

  /**
   * Scan the compose directory for compose files that are not yet stacks: loose
   * files at the root and compose files one directory too deep. A top-level
   * subdirectory with a compose file is already a stack, so it is skipped, not
   * surfaced. Read-only. Bounded by `maxCandidates` and by a single level of
   * nesting so a deep tree cannot make this walk unbounded.
   */
  async findImportCandidates(maxCandidates = 100): Promise<ImportCandidateRaw[]> {
    const candidates: ImportCandidateRaw[] = [];
    let entries: Dirent[];
    try {
      entries = await fsPromises.readdir(this.baseDir, { withFileTypes: true });
    } catch (error) {
      // The compose dir itself is unreadable (missing, permissions). The scan
      // degrades to an empty list, so log it rather than report "no files found"
      // for what is really an access failure.
      console.warn('[FileSystemService] Failed to scan compose directory for import:', sanitizeForLog((error as Error)?.message ?? String(error)));
      return candidates;
    }

    for (const entry of entries) {
      if (candidates.length >= maxCandidates) break;
      if (!entry.name || typeof entry.name !== 'string') continue;

      if (entry.isFile()) {
        if (IMPORT_COMPOSE_FILENAME_SET.has(entry.name)) {
          const loaded = await this.readComposeCandidate(path.join(this.baseDir, entry.name));
          candidates.push({ name: '', composeFile: entry.name, location: entry.name, status: 'loose-root', ...loaded });
        }
        continue;
      }
      if (!entry.isDirectory()) continue;

      const dir = path.join(this.baseDir, entry.name);
      const topCompose = await this.firstComposeFilename(dir);
      if (topCompose) {
        // A top-level subdirectory with a compose file is already a stack (it
        // shows in the sidebar), so it is not an import candidate. Skip it and do
        // not descend: any compose files deeper inside belong to this stack.
        continue;
      }

      // No compose at the top level: peek exactly one level deeper.
      let children: Dirent[];
      try {
        children = await fsPromises.readdir(dir, { withFileTypes: true });
      } catch (error) {
        console.warn('[FileSystemService] Failed to read subdirectory during import scan:', sanitizeForLog((error as Error)?.message ?? String(error)));
        continue;
      }
      for (const child of children) {
        if (candidates.length >= maxCandidates) break;
        if (!child.isDirectory() || !child.name || typeof child.name !== 'string') continue;
        const childDir = path.join(dir, child.name);
        const childCompose = await this.firstComposeFilename(childDir);
        if (childCompose) {
          const loaded = await this.readComposeCandidate(path.join(childDir, childCompose));
          candidates.push({
            name: child.name,
            composeFile: childCompose,
            location: `${entry.name}/${child.name}/${childCompose}`,
            status: 'nested',
            ...loaded,
          });
        }
      }
    }

    return candidates;
  }

  /**
   * Move a discovered import candidate into its own top-level stack directory so
   * auto-discovery (getStacks) picks it up. This is the single write path of the
   * guided import flow and only runs on an explicit, per-file user action.
   *
   * A `loose-root` file is moved into <base>/<destName>/<composeFile>: only the
   * chosen compose file moves, so sibling files referenced by a relative path
   * (e.g. a root .env) stay where they are. A `nested` stack directory
   * (<parent>/<child>) is promoted whole to <base>/<destName>, preserving its
   * .env and any other files.
   *
   * Never overwrites: a pre-existing destination is a conflict. Source and
   * destination are both confirmed to resolve inside the compose directory
   * before the rename, mirroring readComposeCandidate / resolveSafeStackPath.
   */
  async importCandidateIntoStack(
    candidate: MovableImportCandidate,
    destName: string,
  ): Promise<void> {
    // Validate the name, then re-establish containment inline at the sinks below
    // (path.resolve against the safe base + a single startsWith). resolveStackDir
    // applies the same check, but only the inline form is credited by static
    // analysis, matching the read and backup paths in this file.
    if (!isValidStackName(destName)) {
      throw Object.assign(new Error('Invalid stack name'), { code: 'INVALID_STACK_NAME' });
    }
    const baseResolved = path.resolve(this.baseDir);
    const destDir = path.resolve(baseResolved, destName);
    if (!destDir.startsWith(baseResolved + path.sep)) {
      throw Object.assign(new Error('Invalid stack name'), { code: 'INVALID_STACK_NAME' });
    }

    // No overwrite: the destination stack must not already exist. ENOENT is the
    // expected happy path; any other access error (e.g. EACCES) should surface.
    try {
      await fsPromises.access(destDir);
      throw Object.assign(new Error(`A stack named "${destName}" already exists`), { code: 'DEST_EXISTS' });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'DEST_EXISTS') throw error;
      if (code !== 'ENOENT') throw error;
    }

    // The on-disk source the candidate points at, confirmed within the base.
    const source = path.resolve(this.baseDir, candidate.location);
    this.assertWithinBase(source);

    if (candidate.status === 'loose-root') {
      const realSource = await this.realPathWithinBase(source);
      // Build the relocated file path through the same inline containment barrier so
      // the rename target is a credited safe path (candidate.composeFile is an
      // allowlisted compose filename, but it is traced from the request).
      const destComposePath = path.resolve(baseResolved, destName, candidate.composeFile);
      if (!destComposePath.startsWith(baseResolved + path.sep)) {
        throw Object.assign(new Error('Invalid path'), { code: 'INVALID_PATH' });
      }
      // Non-recursive mkdir is the atomic no-overwrite guard: if the destination
      // appeared between the access() precheck above and here, this throws
      // EEXIST (mapped to a 409 conflict) instead of merging into the existing
      // directory and letting the rename clobber a same-named file.
      await fsPromises.mkdir(destDir);
      try {
        await fsPromises.rename(realSource, destComposePath);
      } catch (error) {
        // mkdir just created destDir empty; a failed rename would otherwise strand
        // it, and a retry with the same name would then hit the access() precheck
        // and 409 for a stack that was never created. Remove the empty dir we made
        // (best-effort, only ever empty) and rethrow the original failure.
        await fsPromises.rmdir(destDir).catch(() => undefined);
        throw error;
      }
      return;
    }

    if (candidate.status === 'nested') {
      // Promote the whole child directory (<parent>/<child>) one level up so the
      // stack keeps its .env and any sibling files.
      const sourceDir = path.dirname(source);
      this.assertWithinBase(sourceDir);
      const realSourceDir = await this.realPathWithinBase(sourceDir);
      // The directory can be real and within the base while the compose file inside
      // it symlinks out of the base. Confirm the compose file resolves within the
      // (real) source directory, otherwise the symlink rides the directory move into
      // a stack folder and the editor would later follow it to the out-of-base file.
      const realCompose = await this.realPathWithinBase(source);
      if (!isPathWithinBase(realCompose, realSourceDir)) {
        throw Object.assign(new Error('Compose file escapes the import directory'), { code: 'INVALID_PATH' });
      }
      await fsPromises.rename(realSourceDir, destDir);
      return;
    }

    // Exhaustiveness guard: the union is loose-root | nested. A status added later
    // fails to compile here until it is handled, rather than silently taking a move
    // path that does not fit it.
    const unhandled: never = candidate.status;
    throw new Error(`Unhandled import candidate status: ${String(unhandled)}`);
  }

  /**
   * Resolve symlinks and confirm the real target is still inside the compose
   * directory before a write moves it, so a symlinked source cannot relocate a
   * file from outside the base. Returns the canonical path to operate on.
   */
  private async realPathWithinBase(p: string): Promise<string> {
    const real = await fsPromises.realpath(p);
    if (!isPathWithinBase(real, this.baseDir)) {
      throw Object.assign(new Error('Path escapes compose directory'), { code: 'INVALID_PATH' });
    }
    return real;
  }

  /**
   * Reject when `targetPath` (an absolute managed stack dir, or a managed file
   * inside it) would let an operation escape the real compose root via a
   * symlink/junction. Complements the lexical inline barrier at each sink, which
   * cannot see symlinks: path.resolve does not follow links.
   *
   * Walks up to the deepest path component that actually exists and confirms its
   * canonical (realpath'd) location is inside the canonical compose root. The
   * base is realpath'd too, so a legitimately symlinked compose root is not a
   * false positive (both canonicalize through the same root link). Two escape
   * shapes are rejected: an existing path that resolves outside the root, and a
   * dangling symlink (a link whose target does not exist) anywhere on the path,
   * since a write/mkdir would follow it out of tree. Components that are simply
   * absent are safe (they get created as real entries), so they are walked past.
   *
   * No-op when the compose root itself does not exist yet (first-run
   * create/migrate): nothing can exist under it, so no link can be followed.
   *
   * `targetPath` must be absolute; realpath of a relative path would resolve
   * against the process cwd.
   */
  private async assertRealWithinBase(targetPath: string): Promise<void> {
    // Canonical js/path-injection barrier (mirrors every other sink in this
    // file): resolve the untrusted target against the compose root and confirm
    // lexical containment before any filesystem probe, so static analysis
    // credits the sanitizer for the realpath/lstat calls below. Callers already
    // build targetPath under the base, so this never rejects a legitimate or a
    // symlink-escaping path (both are lexically contained); the realpath walk
    // below is what actually catches symlink/junction escapes.
    const baseResolved = path.resolve(this.baseDir);
    const safeTarget = path.resolve(baseResolved, targetPath);
    if (!safeTarget.startsWith(baseResolved + path.sep)) {
      throw Object.assign(new Error('Path escapes compose directory'), { code: 'INVALID_PATH' });
    }

    let realBase: string;
    try {
      realBase = await fsPromises.realpath(this.baseDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      return;
    }

    const escape = () =>
      Object.assign(new Error('Path escapes compose directory via symlink'), { code: 'SYMLINK_ESCAPE' });

    let cursor = safeTarget;
    for (;;) {
      let realCursor: string;
      try {
        realCursor = await fsPromises.realpath(cursor);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        // cursor did not resolve. A dangling symlink still lstat's (the link
        // exists); a genuinely absent component does not. Reject the dangling
        // link; walk up past an absent component to the nearest real ancestor.
        let danglingLink = false;
        try {
          await fsPromises.lstat(cursor);
          danglingLink = true;
        } catch (le) {
          if ((le as NodeJS.ErrnoException).code !== 'ENOENT') throw le;
        }
        if (danglingLink) throw escape();
        const parent = path.dirname(cursor);
        if (parent === cursor) throw escape();
        cursor = parent;
        continue;
      }
      if (realCursor !== realBase && !realCursor.startsWith(realBase + path.sep)) {
        throw escape();
      }
      return;
    }
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
          await this.assertRealWithinBase(stackDir);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'SYMLINK_ESCAPE') throw e;
          // A symlinked entry escaping the compose root is hostile/anomalous;
          // skip just it so the remaining flat stacks still migrate.
          console.warn(`[FileSystemService] Skipping migration of ${stackName}: stack path escapes the compose directory`);
          continue;
        }

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
    await this.assertRealWithinBase(stackDir);
    // Canonical js/path-injection barrier (mirrors restoreStackFiles): resolve the
    // backup path against the backup root and confirm containment inline, so the
    // mkdir/copy/write sinks below operate on a validated path. stackName is
    // already validated by resolveStackDir above; this re-establishes containment
    // at the backup sinks themselves so static analysis sees the barrier.
    const backupRoot = path.resolve(getBackupBaseDir());
    const backupDir = path.resolve(backupRoot, String(this.nodeId), stackName);
    if (!backupDir.startsWith(backupRoot + path.sep)) {
      throw Object.assign(new Error('Path escapes backup directory'), { code: 'INVALID_PATH' });
    }
    await fsPromises.mkdir(backupDir, { recursive: true });

    // Clear stale managed files from the backup slot before writing the current
    // ones. The slot is reused across runs, so a managed file removed from the
    // stack since the last backup (e.g. a deleted .env or a switched compose
    // variant) would otherwise linger here and a later restore would resurrect
    // it, breaking the faithful-revert guarantee. Scope is the protected set
    // Sencho writes; .timestamp is rewritten below. A clear failure is logged but
    // not fatal: it only risks a stale future rollback, so it should not block an
    // otherwise valid deploy.
    for (const file of PROTECTED_STACK_FILES) {
      const stale = path.resolve(backupRoot, path.join(backupDir, file));
      if (!stale.startsWith(backupRoot + path.sep)) continue;
      try {
        await fsPromises.unlink(stale);
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          console.warn(`[FileSystemService] Could not clear stale backup ${file}:`, (e as Error).message);
        }
      }
    }

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
    await this.assertRealWithinBase(stackDir);
    // Canonical js/path-injection barrier at the backup read sink: resolve the
    // backup dir against its root and confirm containment inline, mirroring
    // backupStackFiles. stackName is already validated by resolveStackDir above;
    // re-establishing containment at the readdir sink itself lets static
    // analysis see the barrier, which it does not credit through the
    // getBackupDir helper.
    const backupRoot = path.resolve(getBackupBaseDir());
    const backupDir = path.resolve(backupRoot, String(this.nodeId), stackName);
    if (!backupDir.startsWith(backupRoot + path.sep)) {
      throw Object.assign(new Error('Path escapes backup directory'), { code: 'INVALID_PATH' });
    }

    const items = await fsPromises.readdir(backupDir);
    const backedUp = new Set(items);

    // Remove managed files the backup does not contain before copying, so a
    // rollback is a faithful revert rather than an additive overlay. If the
    // failed deploy switched compose variants (e.g. compose.yaml ->
    // docker-compose.yml) or added a .env the backup predates, leaving the new
    // file in place would re-deploy a hybrid of old and new configuration.
    // Scope is strictly PROTECTED_STACK_FILES (the same set Sencho backs up);
    // user data and bind-mounted content in the stack directory are untouched.
    // Canonical js/path-injection barrier: path.resolve(SAFE_ROOT, untrusted)
    // followed by a single startsWith check, both inline with the sink. stackDir
    // is already validated by resolveStackDir; this re-establishes containment at
    // the delete sink itself so static analysis sees the barrier.
    const baseResolved = path.resolve(this.baseDir);
    let removedOrphans = 0;
    for (const file of PROTECTED_STACK_FILES) {
      if (backedUp.has(file)) continue;
      const target = path.resolve(baseResolved, path.join(stackDir, file));
      if (!target.startsWith(baseResolved + path.sep)) {
        throw Object.assign(new Error('Path escapes compose directory'), { code: 'INVALID_PATH' });
      }
      try {
        await fsPromises.unlink(target);
        removedOrphans++;
      } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException)?.code;
        // ENOENT means the file is already absent, which is the desired end
        // state. Any other code (EACCES on a chowned bind mount, EBUSY on a
        // held file) means a managed file Sencho meant to remove is still on
        // disk: completing the copy below would leave a hybrid config while
        // reporting success. Abort so the caller surfaces a real failure and
        // preserves the backup for manual recovery.
        if (code !== 'ENOENT') {
          throw new Error(`Rollback aborted: could not remove stale ${file} (${code ?? 'unknown error'}); the restore would leave a mix of old and new configuration.`);
        }
      }
    }

    for (const item of items) {
      if (item === '.timestamp') continue;
      await fsPromises.copyFile(path.join(backupDir, item), path.join(stackDir, item));
    }
    if (debug) console.debug(`[FileSystemService:debug] Restore completed in ${Date.now() - t0}ms`, { stackName, restored: items.filter(i => i !== '.timestamp').length, removedOrphans });
  }

  /**
   * Capture the current managed stack files (PROTECTED_STACK_FILES) in memory and
   * return a function that puts them back, faithfully (writing the captured
   * contents and removing any managed file that did not exist when captured).
   *
   * Used by the rollback route to undo a restored backup when the policy gate
   * blocks before the deploy commits: restoreStackFiles has already overwritten
   * the on-disk files, so without this a blocked rollback would leave disk holding
   * the rolled-back configuration while the deployed containers are unchanged.
   */
  async snapshotStackFiles(stackName: string): Promise<() => Promise<void>> {
    const stackDir = this.resolveStackDir(stackName);
    await this.assertRealWithinBase(stackDir);
    // Canonical js/path-injection barrier inline with the read/write sinks, the
    // same pattern restoreStackFiles uses: resolve against the base and confirm
    // containment so static analysis credits the barrier.
    const baseResolved = path.resolve(this.baseDir);
    const snapshot = new Map<string, Buffer>();
    for (const file of PROTECTED_STACK_FILES) {
      const target = path.resolve(baseResolved, path.join(stackDir, file));
      if (!target.startsWith(baseResolved + path.sep)) {
        throw Object.assign(new Error('Path escapes compose directory'), { code: 'INVALID_PATH' });
      }
      try {
        snapshot.set(file, await fsPromises.readFile(target));
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
      }
    }
    return async () => {
      for (const file of PROTECTED_STACK_FILES) {
        const target = path.resolve(baseResolved, path.join(stackDir, file));
        if (!target.startsWith(baseResolved + path.sep)) continue;
        const saved = snapshot.get(file);
        if (saved !== undefined) {
          await fsPromises.writeFile(target, saved);
        } else {
          try {
            await fsPromises.unlink(target);
          } catch (e: unknown) {
            if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
          }
        }
      }
    };
  }

  /**
   * Names-only summary of the backup slot's env coverage for rollback
   * readiness: whether a backup exists, whether it contains a .env, and the
   * variable names defined in it. Values never leave this method.
   */
  async getBackupEnvSummary(stackName: string): Promise<{ exists: boolean; envPresent: boolean; keys: string[] }> {
    if (!isValidStackName(stackName)) {
      return { exists: false, envPresent: false, keys: [] };
    }
    // Canonical js/path-injection barrier inline with the read sink, mirroring
    // backupStackFiles/restoreStackFiles.
    const backupRoot = path.resolve(getBackupBaseDir());
    const backupDir = path.resolve(backupRoot, String(this.nodeId), stackName);
    if (!backupDir.startsWith(backupRoot + path.sep)) {
      throw Object.assign(new Error('Path escapes backup directory'), { code: 'INVALID_PATH' });
    }
    try {
      await fsPromises.access(backupDir);
    } catch (e: unknown) {
      // Only a missing slot may report "no backup"; an unreadable one (EACCES
      // on a root-created dir) must propagate so callers degrade to unknown
      // instead of falsely promising the next update will create one.
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
      return { exists: false, envPresent: false, keys: [] };
    }
    try {
      const content = await fsPromises.readFile(path.join(backupDir, '.env'), 'utf-8');
      const keys: string[] = [];
      for (const line of content.split(/\r?\n/)) {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
        if (match) keys.push(match[1]);
      }
      return { exists: true, envPresent: true, keys };
    } catch (e: unknown) {
      // ENOENT means the backup genuinely has no env file. Anything else
      // (EACCES, EISDIR) must propagate: reporting it as "no env in backup"
      // would falsely claim a rollback cannot restore env changes.
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
      return { exists: true, envPresent: false, keys: [] };
    }
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

  /**
   * Resolve `relPath` within an arbitrary absolute root directory, applying the
   * same containment + symlink-escape protection used for stack-source paths.
   * Serves both the stack source dir (via resolveSafeStackPath) and volume-aware
   * bind-mount roots, which may legitimately resolve outside the compose base dir
   * (the caller pre-authorizes the root and passes its canonical realpath).
   *
   * KNOWN LIMITATION (TOCTOU): this realpath-validates the path, then the caller
   * opens/streams/writes it by name, so a process that can write inside the root
   * (e.g. a container writing its own bind-mounted config volume) could swap a
   * validated regular file for a symlink between this check and the open and
   * escape the root. Closing it fully requires per-component openat/O_RESOLVE
   * traversal; plain O_NOFOLLOW is not viable because config volumes
   * legitimately contain symlinks (e.g. nginx sites-enabled). This is a
   * pre-existing property of every FileSystemService file op (not specific to
   * volume roots); the bind root is contained to the compose dir and the op
   * requires stack:edit, which already grants equivalent host access via
   * compose. Tracked as a follow-up hardening, not a per-root regression.
   */
  private async resolveSafePathWithin(rootAbsDir: string, relPath: string): Promise<string> {
    // Canonical js/path-injection barrier inline with the realpath sinks below:
    // isPathWithinBase performs the same containment check, but static analysis
    // only credits the path.resolve + startsWith form when it sits at the sink.
    // relPath === '' resolves to the (server-controlled) root itself and carries
    // no user input, so it needs no containment check.
    const baseResolved = path.resolve(rootAbsDir);
    const target = path.resolve(baseResolved, relPath);
    if (relPath !== '' && !target.startsWith(baseResolved + path.sep)) {
      throw Object.assign(new Error('Path escapes root directory'), { code: 'INVALID_PATH' });
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
          throw Object.assign(new Error('Path escapes root directory'), { code: 'INVALID_PATH' });
        }
        suffix.unshift(path.basename(existing));
        existing = parent;
        if (existing === baseResolved) {
          // Reached the root: realpath the untainted base (never a tainted input)
          // and reattach the not-yet-existing suffix.
          const realBase = await fsPromises.realpath(baseResolved);
          if (!isPathWithinBase(realBase, rootAbsDir)) {
            throw Object.assign(new Error('Symlink escapes root directory'), { code: 'SYMLINK_ESCAPE' });
          }
          realTarget = path.join(realBase, ...suffix);
          break;
        }
        // Inline js/path-injection barrier: existing is now strictly below the
        // root, so the canonical path.resolve + startsWith form credits the sink.
        if (!existing.startsWith(baseResolved + path.sep)) {
          throw Object.assign(new Error('Path escapes root directory'), { code: 'INVALID_PATH' });
        }
        try {
          const realExisting = await fsPromises.realpath(existing);
          if (!isPathWithinBase(realExisting, rootAbsDir)) {
            throw Object.assign(new Error('Symlink escapes root directory'), { code: 'SYMLINK_ESCAPE' });
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

    if (!isPathWithinBase(realTarget, rootAbsDir)) {
      throw Object.assign(new Error('Symlink escapes root directory'), { code: 'SYMLINK_ESCAPE' });
    }

    return realTarget;
  }

  private async resolveSafeStackPath(stackName: string, relPath: string): Promise<string> {
    const stackDir = path.join(this.baseDir, stackName);
    if (!isPathWithinBase(stackDir, this.baseDir)) {
      throw Object.assign(new Error('Stack name escapes compose directory'), { code: 'INVALID_PATH' });
    }
    return this.resolveSafePathWithin(stackDir, relPath);
  }

  /**
   * Resolve the effective path for an operation that may target the stack source
   * dir (default) or a pre-authorized bind-mount root (`scope.rootAbsDir`).
   */
  private async resolveScopedPath(stackName: string, relPath: string, scope?: FileRootScope): Promise<string> {
    return scope?.rootAbsDir !== undefined
      ? this.resolveSafePathWithin(scope.rootAbsDir, relPath)
      : this.resolveSafeStackPath(stackName, relPath);
  }

  /** Leaf-path variant of resolveScopedPath (does not follow a symlink leaf). */
  private async resolveScopedLeafPath(stackName: string, relPath: string, scope?: FileRootScope): Promise<string> {
    return scope?.rootAbsDir !== undefined
      ? this.resolveSafeLeafPathWithin(scope.rootAbsDir, relPath)
      : this.resolveSafeStackLeafPath(stackName, relPath);
  }

  async listStackDirectory(stackName: string, relPath: string, scope?: FileRootScope): Promise<FileEntry[]> {
    const page = await this.listStackDirectoryPage(stackName, relPath, { scope });
    return page.entries;
  }

  /**
   * Pagination-aware variant. Returns the sorted entries (optionally truncated
   * to `limit`) along with the unfiltered `total` so the route can advertise
   * how much was elided. Callers that just want the unbounded array should
   * keep using listStackDirectory; the route uses this variant to cap the
   * payload for unusually large directories without losing the count.
   */
  async listStackDirectoryPage(
    stackName: string,
    relPath: string,
    opts: { limit?: number; scope?: FileRootScope },
  ): Promise<{ entries: FileEntry[]; total: number; truncated: boolean }> {
    const safePath = await this.resolveScopedPath(stackName, relPath, opts.scope);
    const protectedEnabled = opts.scope?.protectedEnabled ?? true;
    const dirents = await fsPromises.readdir(safePath, { withFileTypes: true });
    const total = dirents.length;

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
          isProtected: protectedEnabled && PROTECTED_STACK_FILES.has(dirent.name),
        };
      })
    );

    const sorted = entries.sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (a.type !== 'directory' && b.type === 'directory') return 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });

    if (opts.limit !== undefined && sorted.length > opts.limit) {
      return { entries: sorted.slice(0, opts.limit), total, truncated: true };
    }
    return { entries: sorted, total, truncated: false };
  }

  async readStackFile(
    stackName: string,
    relPath: string,
    maxBytes: number = 2 * 1024 * 1024,
    opts: { forceText?: boolean; scope?: FileRootScope } = {},
  ): Promise<{ content?: string; binary: boolean; oversized: boolean; size: number; mime: string; mtimeMs: number }> {
    const safePath = await this.resolveScopedPath(stackName, relPath, opts.scope);
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

      // forceText bypasses the binary-detection heuristic so callers can
      // recover from false positives (a UTF-8 file that happens to carry a
      // NUL or a high non-printable ratio in its first 8 KB). The oversized
      // branch above still applies because returning a multi-megabyte file
      // as JSON-encoded text is wasteful regardless of the heuristic.
      if (!opts.forceText && isBinaryBuffer(buf)) {
        return { binary: true, oversized: false, size: stat.size, mime, mtimeMs };
      }

      return { binary: false, oversized: false, size: stat.size, mime, mtimeMs, content: buf.toString('utf-8') };
    } finally {
      await fh.close();
    }
  }

  async streamStackFile(
    stackName: string,
    relPath: string,
    scope?: FileRootScope,
  ): Promise<{ stream: Readable; size: number; filename: string; mime: string }> {
    const safePath = await this.resolveScopedPath(stackName, relPath, scope);
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
    data: string | Buffer | Readable,
    opts: { exclusive?: boolean } = {},
  ): Promise<void> {
    await fsPromises.mkdir(path.dirname(safePath), { recursive: true });
    // crypto.randomBytes gives a guaranteed-length high-entropy suffix; Math.random
    // can drop leading zeros which narrows entropy unpredictably.
    const suffix = `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const tmpPath = `${safePath}.sencho-tmp-${suffix}`;
    let stagedTmp = false;
    try {
      if (data instanceof Readable) {
        // Stream a temp-file source (an upload spooled to disk) into the staging
        // file without buffering it in memory. 'wx' exclusively creates the
        // staging file; the random suffix already guarantees a fresh name.
        const ws = createWriteStream(tmpPath, { flags: 'wx' });
        stagedTmp = true;
        await pipeline(data, ws);
        const synced = await fsPromises.open(tmpPath, 'r+');
        try {
          await synced.sync();
        } finally {
          await synced.close();
        }
      } else {
        const fh = await fsPromises.open(tmpPath, 'wx');
        stagedTmp = true;
        try {
          await fh.writeFile(data);
          await fh.sync();
        } finally {
          await fh.close();
        }
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

  /**
   * Atomic, scoped write whose source is a temp file on disk (an upload spooled
   * by multer's diskStorage). Streams the temp file into a staging sibling in the
   * target's own directory, fsyncs, then links/renames into place, so a large
   * upload is never buffered in memory and the temp file's filesystem can differ
   * from the stack/volume filesystem (no cross-device rename). The caller owns
   * deleting tempPath.
   */
  async writeScopedFileFromTemp(
    stackName: string,
    relPath: string,
    tempPath: string,
    opts?: { exclusive?: boolean; scope?: FileRootScope },
  ): Promise<void> {
    const safePath = await this.resolveScopedPath(stackName, relPath, opts?.scope);
    await this.writeStackFileAtomic(safePath, createReadStream(tempPath), { exclusive: opts?.exclusive });
  }

  /**
   * Returns 'file' or 'directory' if the resolved path exists, null if it
   * does not. Path-resolution errors (INVALID_PATH, SYMLINK_ESCAPE) propagate
   * so callers do not silently treat a malformed path as 'available for write'.
   * Callers should validate inputs upstream before invoking this helper.
   */
  async pathKind(stackName: string, relPath: string, scope?: FileRootScope): Promise<'file' | 'directory' | null> {
    const safePath = await this.resolveScopedPath(stackName, relPath, scope);
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
    scope?: FileRootScope,
  ): Promise<
    | { ok: true; mtimeMs: number }
    | { ok: false; currentMtimeMs: number; currentContent: string }
  > {
    const safePath = await this.resolveScopedPath(stackName, relPath, scope);
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

  /**
   * Like resolveSafeStackPath but does NOT follow a symlink at the leaf.
   * Path-component symlinks are still resolved and validated (so a symlinked
   * parent that escapes the stack dir still throws SYMLINK_ESCAPE), but the
   * final entry stays as the link path the user sees in the tree. Callers
   * use this to act on the link entry itself (unlink the link, not the
   * target) for operations where following would mutate a file other than
   * the one the user clicked on.
   */
  private async resolveSafeLeafPathWithin(rootAbsDir: string, relPath: string): Promise<string> {
    if (relPath === '' || relPath === '.') {
      return this.resolveSafePathWithin(rootAbsDir, '');
    }
    const parentRel = path.dirname(relPath);
    const baseName = path.basename(relPath);
    if (!baseName || baseName === '.' || baseName === '..') {
      throw Object.assign(new Error('Invalid path'), { code: 'INVALID_PATH' });
    }
    const safeParent = await this.resolveSafePathWithin(rootAbsDir, parentRel === '.' ? '' : parentRel);
    return path.join(safeParent, baseName);
  }

  private async resolveSafeStackLeafPath(stackName: string, relPath: string): Promise<string> {
    const stackDir = path.join(this.baseDir, stackName);
    if (!isPathWithinBase(stackDir, this.baseDir)) {
      throw Object.assign(new Error('Stack name escapes compose directory'), { code: 'INVALID_PATH' });
    }
    return this.resolveSafeLeafPathWithin(stackDir, relPath);
  }

  async deleteStackPath(stackName: string, relPath: string, recursive: boolean = false, scope?: FileRootScope): Promise<void> {
    if ((scope?.protectedEnabled ?? true) && isProtectedRelPath(relPath)) throw protectedFileError(relPath);
    const leafPath = await this.resolveScopedLeafPath(stackName, relPath, scope);

    // Branch on whether the leaf is a symlink BEFORE following it. Deleting
    // a symlink should remove the link entry the user clicked on; following
    // through to the target would silently delete a file with a different
    // name and leave the link entry dangling.
    const leafStat = await fsPromises.lstat(leafPath);
    if (leafStat.isSymbolicLink()) {
      await fsPromises.unlink(leafPath);
      return;
    }

    if (recursive) {
      await fsPromises.rm(leafPath, { recursive: true, force: true });
      return;
    }
    try {
      await fsPromises.unlink(leafPath);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'EISDIR') {
        try {
          await fsPromises.rmdir(leafPath);
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

  async mkdirStackPath(stackName: string, relPath: string, scope?: FileRootScope): Promise<void> {
    const safePath = await this.resolveScopedPath(stackName, relPath, scope);
    await fsPromises.mkdir(safePath, { recursive: true });
  }

  /**
   * Renames or moves an entry within a stack. The source and destination may sit
   * in different directories (a cross-directory move), since fs.rename relocates
   * natively. Both paths resolve through the leaf helper so a symlink source is
   * moved as the link entry itself rather than followed to its target, matching
   * the delete/chmod policy. fs.rename fails with EXDEV across a filesystem
   * boundary (e.g. a bind-mounted subdirectory); the route surfaces that as a 409.
   */
  async renameStackPath(stackName: string, fromRel: string, toRel: string, scope?: FileRootScope): Promise<void> {
    if (scope?.protectedEnabled ?? true) {
      if (isProtectedRelPath(fromRel)) throw protectedFileError(fromRel);
      if (isProtectedRelPath(toRel)) throw protectedFileError(toRel);
    }
    const fromPath = await this.resolveScopedLeafPath(stackName, fromRel, scope);
    const toPath = await this.resolveScopedLeafPath(stackName, toRel, scope);
    const toName = path.basename(toPath);
    if (!toName || toName === '.' || toName === '..') {
      throw Object.assign(new Error('Invalid destination name'), { code: 'INVALID_PATH' });
    }
    // Block moving a directory into itself or one of its own descendants; fs.rename
    // would otherwise fail with an opaque EINVAL/EPERM.
    const fromStat = await fsPromises.lstat(fromPath);
    if (fromStat.isDirectory() && isSameOrDescendantFsPath(fromPath, toPath)) {
      throw Object.assign(new Error('Cannot move a folder into itself'), { code: 'INVALID_PATH' });
    }
    // Prevent overwriting an existing path. lstat (not access) so a dangling
    // symlink already at the destination still counts as occupied.
    try {
      await fsPromises.lstat(toPath);
      throw Object.assign(new Error('A file or folder with that name already exists'), { code: 'EEXIST' });
    } catch (e: unknown) {
      const fe = e as NodeJS.ErrnoException;
      if (fe.code !== 'ENOENT') throw e;
    }
    await fsPromises.rename(fromPath, toPath);
  }

  /**
   * Copies a file or directory within a single root. The source resolves through
   * the leaf helper and the copy does not dereference symlinks, so a symlink
   * entry is copied as a link (matching the delete/rename leaf policy) rather
   * than followed to its target. Only the destination is protection-checked:
   * duplicating a protected file (e.g. compose.yaml) elsewhere is allowed, but a
   * copy cannot create a reserved name at a protected root. An existing
   * destination is rejected (surfaced as EEXIST, which the route maps to 409).
   */
  async copyScopedPath(stackName: string, fromRel: string, toRel: string, scope?: FileRootScope): Promise<void> {
    if ((scope?.protectedEnabled ?? true) && isProtectedRelPath(toRel)) throw protectedFileError(toRel);
    const fromPath = await this.resolveScopedLeafPath(stackName, fromRel, scope);
    const toPath = await this.resolveScopedLeafPath(stackName, toRel, scope);
    const toName = path.basename(toPath);
    if (!toName || toName === '.' || toName === '..') {
      throw Object.assign(new Error('Invalid destination name'), { code: 'INVALID_PATH' });
    }
    // Block copying a directory into itself or one of its own descendants;
    // fs.cp would otherwise recurse into the copy it is creating.
    const fromStat = await fsPromises.lstat(fromPath);
    if (fromStat.isDirectory() && isSameOrDescendantFsPath(fromPath, toPath)) {
      throw Object.assign(new Error('Cannot copy a folder into itself'), { code: 'INVALID_PATH' });
    }
    try {
      await fsPromises.cp(fromPath, toPath, {
        recursive: fromStat.isDirectory(),
        dereference: false,
        errorOnExist: true,
        force: false,
      });
    } catch (err: unknown) {
      // fs.cp raises ERR_FS_CP_EEXIST when the destination already exists; remap
      // to EEXIST so the route returns 409, matching rename's conflict handling.
      if ((err as NodeJS.ErrnoException).code === 'ERR_FS_CP_EEXIST') {
        throw Object.assign(new Error('A file or folder with that name already exists'), { code: 'EEXIST' });
      }
      throw err;
    }
  }

  async getStackEntryMode(stackName: string, relPath: string, scope?: FileRootScope): Promise<{ mode: number; octal: string }> {
    const safePath = await this.resolveScopedPath(stackName, relPath, scope);
    const stat = await fsPromises.stat(safePath);
    const mode = stat.mode & 0o777;
    return { mode, octal: mode.toString(8).padStart(3, '0') };
  }

  async chmodStackPath(stackName: string, relPath: string, mode: number, scope?: FileRootScope): Promise<void> {
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
      throw Object.assign(new Error('Invalid permission bits'), { code: 'INVALID_PATH' });
    }
    if ((scope?.protectedEnabled ?? true) && isProtectedRelPath(relPath)) throw protectedFileError(relPath);
    const leafPath = await this.resolveScopedLeafPath(stackName, relPath, scope);

    // chmod on a symlink is rejected. Following the link would silently
    // mutate permissions on a file with a different name than the entry the
    // user clicked on. Node's fsPromises.lchmod is macOS-only, so for the
    // common Linux/Windows case there is no safe in-place alternative; we
    // surface a clear error so the user edits the target file directly.
    const leafStat = await fsPromises.lstat(leafPath);
    if (leafStat.isSymbolicLink()) {
      throw Object.assign(
        new Error('Cannot change permissions of a symlink. Edit the target file directly.'),
        { code: 'LINK_CHMOD_UNSUPPORTED' as const },
      );
    }
    await fsPromises.chmod(leafPath, mode);
  }

  async statStackEntry(stackName: string, relPath: string, scope?: FileRootScope): Promise<FileEntry> {
    const safePath = await this.resolveScopedPath(stackName, relPath, scope);
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
      isProtected: (scope?.protectedEnabled ?? true) && PROTECTED_STACK_FILES.has(name),
    };
  }
}
