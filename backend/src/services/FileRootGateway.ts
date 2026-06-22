/**
 * FileRootGateway: one uniform interface over the two storage backends behind a
 * stack file root. Stack-source and bind roots run on FileSystemService (the
 * `fs` backend); named-volume roots run on VolumeBrowserService (the `helper`
 * backend, a hardened Alpine container). The route layer resolves a
 * StackFileRoot, then calls the gateway so each handler does not re-implement
 * the fs-vs-helper branch or the response-shape mapping.
 *
 * Optimistic concurrency is carried as an opaque, quoted `version` token that is
 * a valid If-Match/ETag value end-to-end: for fs roots it is the existing weak
 * ETag `W/"<mtimeMs>"` (so stack-source concurrency is unchanged); for helper
 * roots it is a composite mtime+size+hash token that distinguishes two edits
 * within the same (seconds-resolution) second.
 */
import type { Readable } from 'stream';
import { createReadStream, promises as fsp } from 'fs';

import { FileSystemService, type FileEntry, type FileRootScope } from './FileSystemService';
import { VolumeBrowserService, makeHelperVersion, DOWNLOAD_MAX_BYTES, type VolumeEntry } from './VolumeBrowserService';
import type { StackFileRoot } from './StackFileRootsService';

const HELPER_VIEW_MAX_BYTES = 2 * 1024 * 1024; // match the stack-source viewer cap

export interface GatewayReadResult {
  content?: string;
  binary: boolean;
  oversized: boolean;
  size: number;
  mime: string;
  mtimeMs: number;
  version: string;
}

export type GatewayWriteResult =
  | { ok: true; mtimeMs: number; version: string }
  | { ok: false; currentContent: string; currentMtimeMs: number; currentVersion: string };

/** fs version token: the existing weak ETag over the integer mtimeMs. */
export function makeFsVersion(mtimeMs: number): string {
  return `W/"${Math.floor(mtimeMs)}"`;
}

/** Parse the millisecond mtime out of a quoted (optionally weak) numeric ETag token. */
export function parseFsVersion(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = /(?:W\/)?"(\d+)"/.exec(raw);
  if (!m) return null;
  const value = Number(m[1]);
  return Number.isFinite(value) ? value : null;
}

function volumeEntryToFileEntry(e: VolumeEntry): FileEntry {
  return {
    name: e.name,
    // Preserve 'other' (non-regular entries) so the archive guard can reject
    // what the helper download path would refuse; the UI renders it like a file.
    type: e.type,
    size: e.size,
    mtime: e.mtime * 1000,
    isProtected: false,
  };
}

export class FileRootGateway {
  private nodeId: number;

  private constructor(nodeId: number) {
    this.nodeId = nodeId;
  }

  static getInstance(nodeId: number): FileRootGateway {
    return new FileRootGateway(nodeId);
  }

  private fs(): FileSystemService {
    return FileSystemService.getInstance(this.nodeId);
  }

  private helper(): VolumeBrowserService {
    return VolumeBrowserService.getInstance(this.nodeId);
  }

  /** fs scope for a stack-source/bind root; bind roots disable compose/.env protection. */
  private scopeFor(root: StackFileRoot): FileRootScope {
    return root.kind === 'stack-source'
      ? { protectedEnabled: true }
      : { rootAbsDir: root.hostPathOrName, protectedEnabled: false };
  }

  /** Composite helper version token from an ms mtime + size + the file bytes. */
  private helperVersion(mtimeMs: number, size: number, bytes: Buffer): string {
    return makeHelperVersion(Math.floor(mtimeMs / 1000), size, bytes);
  }

  async listDir(
    root: StackFileRoot,
    stackName: string,
    relPath: string,
    limit: number,
  ): Promise<{ entries: FileEntry[]; total: number; truncated: boolean }> {
    if (root.backend === 'helper') {
      // Ask for one over the limit so a fully-listed directory is distinguishable
      // from a truncated one without the helper buffering every entry.
      const raw = await this.helper().listDir(root.hostPathOrName, relPath, limit);
      const truncated = raw.length > limit;
      const entries = raw.slice(0, limit).map(volumeEntryToFileEntry);
      return { entries, total: entries.length, truncated };
    }
    return this.fs().listStackDirectoryPage(stackName, relPath, { limit, scope: this.scopeFor(root) });
  }

  async read(
    root: StackFileRoot,
    stackName: string,
    relPath: string,
    forceText: boolean,
  ): Promise<GatewayReadResult> {
    if (root.backend === 'helper') {
      const r = await this.helper().readFile(root.hostPathOrName, relPath, { maxBytes: HELPER_VIEW_MAX_BYTES });
      const bytes = Buffer.from(r.content, r.encoding);
      const showContent = !r.binary && !r.truncated;
      return {
        content: showContent ? r.content : undefined,
        binary: r.binary,
        oversized: r.truncated,
        size: r.size,
        mime: r.mime,
        mtimeMs: r.mtimeMs,
        version: this.helperVersion(r.mtimeMs, r.size, bytes),
      };
    }
    const r = await this.fs().readStackFile(stackName, relPath, undefined, { forceText, scope: this.scopeFor(root) });
    return { ...r, version: makeFsVersion(r.mtimeMs) };
  }

  /** Optimistic-concurrency write for the editor save path. */
  async writeIfUnchanged(
    root: StackFileRoot,
    stackName: string,
    relPath: string,
    content: string,
    expectedVersion: string | undefined,
  ): Promise<GatewayWriteResult> {
    if (root.backend === 'helper') {
      const volume = root.hostPathOrName;
      const exists = (await this.helper().pathKind(volume, relPath)) === 'file';
      if (exists && expectedVersion) {
        const current = await this.helper().readFile(volume, relPath, { maxBytes: HELPER_VIEW_MAX_BYTES });
        const currentBytes = Buffer.from(current.content, current.encoding);
        const currentVersion = this.helperVersion(current.mtimeMs, current.size, currentBytes);
        if (currentVersion !== expectedVersion) {
          return {
            ok: false,
            currentContent: current.binary ? '' : current.content,
            currentMtimeMs: current.mtimeMs,
            currentVersion,
          };
        }
      }
      const written = await this.helper().writeFile(volume, relPath, Buffer.from(content, 'utf-8'));
      return {
        ok: true,
        mtimeMs: written.mtimeMs,
        version: this.helperVersion(written.mtimeMs, written.size, Buffer.from(content, 'utf-8')),
      };
    }
    const expectedMtimeMs = parseFsVersion(expectedVersion);
    const result = await this.fs().writeStackFileIfUnchanged(stackName, relPath, content, expectedMtimeMs, this.scopeFor(root));
    if (result.ok) return { ok: true, mtimeMs: result.mtimeMs, version: makeFsVersion(result.mtimeMs) };
    return {
      ok: false,
      currentContent: result.currentContent,
      currentMtimeMs: result.currentMtimeMs,
      currentVersion: makeFsVersion(result.currentMtimeMs),
    };
  }

  async pathKind(root: StackFileRoot, stackName: string, relPath: string): Promise<'file' | 'directory' | null> {
    if (root.backend === 'helper') return this.helper().pathKind(root.hostPathOrName, relPath);
    return this.fs().pathKind(stackName, relPath, this.scopeFor(root));
  }

  /** Stat a single entry (type + size). Used by bulk download to size the archive. */
  async stat(root: StackFileRoot, stackName: string, relPath: string): Promise<FileEntry> {
    if (root.backend === 'helper') {
      return volumeEntryToFileEntry(await this.helper().stat(root.hostPathOrName, relPath));
    }
    return this.fs().statStackEntry(stackName, relPath, this.scopeFor(root));
  }

  /**
   * Reject a non-directory entry the backend's download path could not stream,
   * BEFORE the archive prewalk commits to sending response headers. The fs
   * backend streams any in-root file (and follows in-root symlinks), so it has
   * no constraint; the helper backend's download refuses symlinks/non-regular
   * files and caps each file at DOWNLOAD_MAX_BYTES, which must be enforced here
   * or a bulk download would tear mid-archive when gateway.download() later
   * throws. Throws ARCHIVE_UNSUPPORTED (-> 400) or ARCHIVE_TOO_LARGE (-> 413).
   */
  assertArchivable(root: StackFileRoot, relPath: string, entry: FileEntry): void {
    if (root.backend !== 'helper') return;
    if (entry.type !== 'file') {
      throw Object.assign(new Error(`"${relPath}" cannot be downloaded from this volume`), { code: 'ARCHIVE_UNSUPPORTED' });
    }
    if (entry.size > DOWNLOAD_MAX_BYTES) {
      throw Object.assign(new Error(`"${relPath}" is too large to download from this volume`), { code: 'ARCHIVE_TOO_LARGE' });
    }
  }

  /**
   * Upload write sourced from a temp file spooled to disk (multer diskStorage),
   * so the upload is never buffered in memory. `exclusive` rejects an existing
   * target (no overwrite). The caller owns deleting `tempPath`.
   */
  async writeFromTemp(
    root: StackFileRoot,
    stackName: string,
    relPath: string,
    tempPath: string,
    exclusive: boolean,
  ): Promise<void> {
    if (root.backend === 'helper') {
      if (exclusive && (await this.helper().pathKind(root.hostPathOrName, relPath)) !== null) {
        throw Object.assign(new Error('File already exists'), { code: 'FILE_EXISTS' });
      }
      // The helper writes via `cat`, which cannot report a short write; pass the
      // spooled byte count so writeFileStream can verify the volume got it all.
      const { size } = await fsp.stat(tempPath);
      await this.helper().writeFileStream(root.hostPathOrName, relPath, createReadStream(tempPath), size);
      return;
    }
    await this.fs().writeScopedFileFromTemp(stackName, relPath, tempPath, { exclusive, scope: this.scopeFor(root) });
  }

  async download(
    root: StackFileRoot,
    stackName: string,
    relPath: string,
  ): Promise<{ kind: 'stream'; stream: Readable; size: number; filename: string; mime: string }
    | { kind: 'buffer'; buffer: Buffer; size: number; filename: string }> {
    if (root.backend === 'helper') {
      const d = await this.helper().downloadFile(root.hostPathOrName, relPath);
      return { kind: 'buffer', buffer: d.buffer, size: d.size, filename: d.filename };
    }
    const s = await this.fs().streamStackFile(stackName, relPath, this.scopeFor(root));
    return { kind: 'stream', stream: s.stream, size: s.size, filename: s.filename, mime: s.mime };
  }

  async deletePath(root: StackFileRoot, stackName: string, relPath: string, recursive: boolean): Promise<void> {
    if (root.backend === 'helper') return this.helper().deletePath(root.hostPathOrName, relPath, recursive);
    return this.fs().deleteStackPath(stackName, relPath, recursive, this.scopeFor(root));
  }

  async mkdir(root: StackFileRoot, stackName: string, relPath: string): Promise<void> {
    if (root.backend === 'helper') return this.helper().mkdir(root.hostPathOrName, relPath);
    return this.fs().mkdirStackPath(stackName, relPath, this.scopeFor(root));
  }

  async rename(root: StackFileRoot, stackName: string, fromRel: string, toRel: string): Promise<void> {
    if (root.backend === 'helper') return this.helper().rename(root.hostPathOrName, fromRel, toRel);
    return this.fs().renameStackPath(stackName, fromRel, toRel, this.scopeFor(root));
  }

  /** Copy a file or directory within a single root (cross-root copy is rejected at the route). */
  async copy(root: StackFileRoot, stackName: string, fromRel: string, toRel: string): Promise<void> {
    if (root.backend === 'helper') return this.helper().copy(root.hostPathOrName, fromRel, toRel);
    return this.fs().copyScopedPath(stackName, fromRel, toRel, this.scopeFor(root));
  }

  async getMode(root: StackFileRoot, stackName: string, relPath: string): Promise<{ mode: number; octal: string }> {
    if (root.backend === 'helper') throw unsupportedOnHelperRoot();
    return this.fs().getStackEntryMode(stackName, relPath, this.scopeFor(root));
  }

  async chmod(root: StackFileRoot, stackName: string, relPath: string, mode: number): Promise<void> {
    if (root.backend === 'helper') throw unsupportedOnHelperRoot();
    return this.fs().chmodStackPath(stackName, relPath, mode, this.scopeFor(root));
  }
}

/** Permissions (chmod) are not supported on a helper-backed named-volume root. */
function unsupportedOnHelperRoot(): Error & { code: string } {
  return Object.assign(new Error('Permissions are not editable on a named volume'), { code: 'UNSUPPORTED_ON_ROOT' });
}
