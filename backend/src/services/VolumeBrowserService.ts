import { Writable } from 'stream';
import path from 'path';
import { createHash } from 'crypto';
import DockerController from './DockerController';

const HELPER_IMAGE = 'alpine:3.20';
const VOLUME_MOUNT = '/v';
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
// Named-volume downloads are bounded (not chunk-streamed): the helper output is
// buffered up to this size and a larger file is rejected rather than silently
// truncated. The bound matches the upload limit so the in-memory footprint is no
// worse than the existing multipart upload path.
const DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;
const EXEC_TIMEOUT_MS = 30_000;

// Containment guard run inside the helper after every `cd`. Even though
// sanitizeRelPath strips `..`, a symlinked directory component could redirect
// `cd` outside the mounted volume; `pwd -P` resolves symlinks so we can assert
// the working directory is still under the volume root before touching anything.
const ROOT_GUARD =
  `case "$(pwd -P)" in "${VOLUME_MOUNT}"|"${VOLUME_MOUNT}/"*) ;; *) echo "path escapes volume root" >&2; exit 7 ;; esac`;

// Portable shell scripts that work with BusyBox sh + stat (Alpine) and GNU
// coreutils alike. The user-supplied relative path arrives as $1; we cd into
// it before iterating, so user input never lands as an argv element to a
// command that might interpret it as a flag.
const LIST_SCRIPT = `set -e
cd -- "$1" || exit 1
${ROOT_GUARD}
for entry in * .[!.]* ..?*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  if [ -L "$entry" ]; then t=l; link=$(readlink -- "$entry" 2>/dev/null || echo "")
  elif [ -d "$entry" ]; then t=d; link=""
  elif [ -f "$entry" ]; then t=f; link=""
  else t=o; link=""
  fi
  size=$(stat -c '%s' -- "$entry" 2>/dev/null || echo 0)
  mtime=$(stat -c '%Y' -- "$entry" 2>/dev/null || echo 0)
  printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$t" "$size" "$mtime" "$entry" "$link"
done`;

// Contain the parent before statting the leaf: cd into the leaf's directory and
// assert (via pwd -P) it is still inside the volume, so a symlinked path
// component cannot make stat report on a file outside the mount.
const STAT_SCRIPT = `set -e
p="$1"
d=$(dirname -- "$p"); b=$(basename -- "$p")
cd -- "$d" || exit 1
${ROOT_GUARD}
target="$b"
[ -e "$target" ] || [ -L "$target" ] || { echo "cannot access $target" >&2; exit 1; }
if [ -L "$target" ]; then t=l; link=$(readlink -- "$target" 2>/dev/null || echo "")
elif [ -d "$target" ]; then t=d; link=""
elif [ -f "$target" ]; then t=f; link=""
else t=o; link=""
fi
size=$(stat -c '%s' -- "$target" 2>/dev/null || echo 0)
mtime=$(stat -c '%Y' -- "$target" 2>/dev/null || echo 0)
name=$(basename -- "$target")
printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$t" "$size" "$mtime" "$name" "$link"`;

// --- mutation + probe scripts (all contain the parent, then act on the leaf) ---

// $1 = relative path. New file → owned by the helper user (65534); existing file
// → in-place truncate (`>` keeps the inode, so owner/mode are preserved). A
// symlink leaf is refused so a write never follows a link out of the volume.
const WRITE_SCRIPT = `set -e
p="$1"
d=$(dirname -- "$p"); f=$(basename -- "$p")
cd -- "$d" || exit 1
${ROOT_GUARD}
[ -L "$f" ] && { echo "refusing to write through a symlink" >&2; exit 8; }
[ -d "$f" ] && { echo "target is a directory" >&2; exit 9; }
cat > "$f"`;

// $1 = relative path of the new directory; its parent must already exist.
const MKDIR_SCRIPT = `set -e
p="$1"
d=$(dirname -- "$p"); f=$(basename -- "$p")
cd -- "$d" || exit 1
${ROOT_GUARD}
mkdir -- "$f"`;

// $1 = relative path, $2 = "1" for recursive directory delete. Removing a symlink
// leaf is allowed (rm unlinks the link itself, never its target).
const DELETE_SCRIPT = `set -e
p="$1"; recursive="$2"
d=$(dirname -- "$p"); f=$(basename -- "$p")
cd -- "$d" || exit 1
${ROOT_GUARD}
[ -e "$f" ] || [ -L "$f" ] || { echo "no such path" >&2; exit 1; }
if [ -d "$f" ] && [ ! -L "$f" ]; then
  if [ "$recursive" = "1" ]; then rm -rf -- "$f"; else rmdir -- "$f" 2>/dev/null || { echo "Directory is not empty" >&2; exit 10; }; fi
else
  rm -f -- "$f"
fi`;

// $1 = from, $2 = to. Both parents are contained; the destination must not exist.
const RENAME_SCRIPT = `set -e
from="$1"; to="$2"
fd=$(dirname -- "$from"); td=$(dirname -- "$to")
( cd -- "$fd" 2>/dev/null && case "$(pwd -P)" in "${VOLUME_MOUNT}"|"${VOLUME_MOUNT}/"*) ;; *) exit 7 ;; esac ) || { echo "source escapes volume root" >&2; exit 7; }
( cd -- "$td" 2>/dev/null && case "$(pwd -P)" in "${VOLUME_MOUNT}"|"${VOLUME_MOUNT}/"*) ;; *) exit 7 ;; esac ) || { echo "destination escapes volume root" >&2; exit 7; }
{ [ -e "$to" ] || [ -L "$to" ]; } && { echo "destination exists" >&2; exit 11; }
mv -- "$from" "$to"`;

// $1 = relative path. Prints directory|file|none. Used for upload-overwrite checks.
const PATHKIND_SCRIPT = `set -e
p="$1"
d=$(dirname -- "$p"); f=$(basename -- "$p")
cd -- "$d" || exit 2
${ROOT_GUARD}
if [ -d "$f" ] && [ ! -L "$f" ]; then echo directory
elif [ -e "$f" ] || [ -L "$f" ]; then echo file
else echo none
fi`;

export interface VolumeEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  mtime: number;
  isProtected: boolean;
  symlinkTarget?: string;
}

export interface VolumeFileResult {
  content: string;
  encoding: 'utf-8' | 'base64';
  binary: boolean;
  truncated: boolean;
  size: number;
  mime: string;
  /** mtime in milliseconds (seconds resolution from the helper `stat`, ×1000). */
  mtimeMs: number;
}

/** Raw bytes of a volume file for download, bounded to DOWNLOAD_MAX_BYTES. */
export interface VolumeDownload {
  buffer: Buffer;
  size: number;
  filename: string;
}

export type VolumeStat = VolumeEntry;

/**
 * Opaque optimistic-concurrency token for an editable volume file. Seconds-
 * resolution mtime alone collides for two edits within the same second, so the
 * size and a content hash are folded in to keep the guarantee close to the
 * millisecond-mtime fs path.
 */
export function makeHelperVersion(mtimeSeconds: number, size: number, content: Buffer): string {
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
  return `"v1:${mtimeSeconds}-${size}-${hash}"`;
}

export class PathTraversalError extends Error {
  status = 400;
  constructor() { super('Path escapes volume root'); this.name = 'PathTraversalError'; }
}

export class VolumeNotFoundError extends Error {
  status = 404;
  constructor(name: string) { super(`Volume '${name}' not found`); this.name = 'VolumeNotFoundError'; }
}

export class HelperImageError extends Error {
  status = 503;
  constructor(reason: string) { super(`Volume browser helper unavailable: ${reason}`); this.name = 'HelperImageError'; }
}

export class ExecError extends Error {
  status: number;
  constructor(message: string, status = 500) { super(message); this.status = status; this.name = 'ExecError'; }
}

const helperImageReady = new Map<number, boolean>();

export class VolumeBrowserService {
  private nodeId: number;

  private constructor(nodeId: number) { this.nodeId = nodeId; }

  static getInstance(nodeId?: number): VolumeBrowserService {
    return new VolumeBrowserService(nodeId ?? 1);
  }

  async listDir(volumeName: string, relPath: string): Promise<VolumeEntry[]> {
    const safe = sanitizeRelPath(relPath);
    await this.assertVolumeExists(volumeName);
    await this.ensureHelperImage();

    // Portable across BusyBox (Alpine) and GNU coreutils. Lists each
    // direct child with a tab-separated row: type<TAB>size<TAB>mtime<TAB>
    // name<TAB>symlinkTarget. We chdir to /v/<safe> first so user input is
    // never an argv element passed to find/stat.
    const script = LIST_SCRIPT;
    const { stdout, stderr, exitCode } = await this.runHelper(volumeName, [
      'sh', '-c', script, 'sh', `./${safe || ''}`,
    ]);

    if (exitCode !== 0) {
      const msg = stderr.toString('utf-8').trim();
      if (/No such file or directory|cannot access|cd:.*?:/i.test(msg)) throw new ExecError('Path not found', 404);
      if (/Permission denied/i.test(msg)) throw new ExecError('Permission denied', 403);
      throw new ExecError(`Listing failed: ${msg.substring(0, 200) || 'unknown error'}`);
    }

    const entries: VolumeEntry[] = [];
    const lines = stdout.toString('utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length < 4) continue;
      const [shType, sizeStr, mtimeStr, name, link = ''] = parts;
      if (!name) continue;
      const type: VolumeEntry['type'] =
        shType === 'd' ? 'directory'
        : shType === 'f' ? 'file'
        : shType === 'l' ? 'symlink'
        : 'other';
      entries.push({
        name,
        type,
        size: Number(sizeStr) || 0,
        mtime: Math.floor(Number(mtimeStr) || 0),
        isProtected: false,
        ...(type === 'symlink' && link ? { symlinkTarget: link } : {}),
      });
    }
    entries.sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (a.type !== 'directory' && b.type === 'directory') return 1;
      return a.name.localeCompare(b.name);
    });
    return entries;
  }

  async stat(volumeName: string, relPath: string): Promise<VolumeStat> {
    const safe = sanitizeRelPath(relPath);
    await this.assertVolumeExists(volumeName);
    await this.ensureHelperImage();

    const { stdout, stderr, exitCode } = await this.runHelper(volumeName, [
      'sh', '-c', STAT_SCRIPT, 'sh', `./${safe || ''}`,
    ]);
    if (exitCode !== 0) {
      const msg = stderr.toString('utf-8').trim();
      if (/Permission denied/i.test(msg)) throw new ExecError('Permission denied', 403);
      if (/No such file or directory|cannot access/i.test(msg)) throw new ExecError('Path not found', 404);
      throw new ExecError(`Stat failed: ${msg.substring(0, 200) || 'unknown error'}`);
    }
    const line = stdout.toString('utf-8').split('\n').filter(Boolean)[0] ?? '';
    const parts = line.split('\t');
    const [shType, sizeStr, mtimeStr, name, link = ''] = parts;
    const type: VolumeEntry['type'] =
      shType === 'd' ? 'directory'
      : shType === 'f' ? 'file'
      : shType === 'l' ? 'symlink'
      : 'other';
    return {
      name: name || path.posix.basename(safe || '/'),
      type,
      size: Number(sizeStr) || 0,
      mtime: Math.floor(Number(mtimeStr) || 0),
      isProtected: false,
      ...(type === 'symlink' && link ? { symlinkTarget: link } : {}),
    };
  }

  async readFile(volumeName: string, relPath: string, opts: { maxBytes?: number } = {}): Promise<VolumeFileResult> {
    const safe = sanitizeRelPath(relPath);
    if (!safe) throw new ExecError('Cannot read volume root', 400);
    const maxBytes = Math.max(1, Math.min(opts.maxBytes ?? DEFAULT_MAX_BYTES, DEFAULT_MAX_BYTES));
    await this.assertVolumeExists(volumeName);
    await this.ensureHelperImage();

    const meta = await this.stat(volumeName, safe);
    if (meta.type === 'symlink') throw new ExecError('Refusing to follow symlink', 400);
    if (meta.type !== 'file') throw new ExecError('Not a regular file', 400);

    // Read up to maxBytes+1 to detect truncation precisely. The parent is
    // contained (cd + pwd -P) and the leaf symlink refused so the read can never
    // follow a link out of the volume.
    const { stdout, stderr, exitCode } = await this.runHelper(volumeName, [
      'sh', '-c',
      `p="$1"; d=$(dirname -- "$p"); b=$(basename -- "$p"); cd -- "$d" || exit 1; ${ROOT_GUARD}; [ -L "$b" ] && { echo "refusing to follow symlink" >&2; exit 8; }; head -c ${maxBytes + 1} -- "$b"`,
      'sh', `./${safe}`,
    ]);
    if (exitCode !== 0) {
      const msg = stderr.toString('utf-8').trim();
      if (/Permission denied/i.test(msg)) throw new ExecError('Permission denied', 403);
      throw new ExecError(`Read failed: ${msg.substring(0, 200) || 'unknown error'}`);
    }

    const truncated = stdout.length > maxBytes;
    const buf = truncated ? stdout.subarray(0, maxBytes) : stdout;
    const binary = isBinaryBuffer(buf);
    const mime = binary ? 'application/octet-stream' : 'text/plain';

    return {
      content: binary ? buf.toString('base64') : buf.toString('utf-8'),
      encoding: binary ? 'base64' : 'utf-8',
      binary,
      truncated,
      size: meta.size,
      mime,
      mtimeMs: meta.mtime * 1000,
    };
  }

  /**
   * Read a file's full bytes for download, bounded to DOWNLOAD_MAX_BYTES so a
   * large file is rejected (413) rather than silently truncated. The parent is
   * contained and the leaf symlink refused, like readFile.
   */
  async downloadFile(volumeName: string, relPath: string): Promise<VolumeDownload> {
    const safe = sanitizeRelPath(relPath);
    if (!safe) throw new ExecError('Cannot download volume root', 400);
    await this.assertVolumeExists(volumeName);
    await this.ensureHelperImage();

    const meta = await this.stat(volumeName, safe);
    if (meta.type === 'symlink') throw new ExecError('Refusing to follow symlink', 400);
    if (meta.type !== 'file') throw new ExecError('Not a regular file', 400);
    if (meta.size > DOWNLOAD_MAX_BYTES) {
      throw new ExecError('File is too large to download from this volume', 413);
    }

    const { stdout, stderr, exitCode } = await this.runHelper(volumeName, [
      'sh', '-c',
      `p="$1"; d=$(dirname -- "$p"); b=$(basename -- "$p"); cd -- "$d" || exit 1; ${ROOT_GUARD}; [ -L "$b" ] && { echo "refusing to follow symlink" >&2; exit 8; }; head -c ${DOWNLOAD_MAX_BYTES + 1} -- "$b"`,
      'sh', `./${safe}`,
    ]);
    if (exitCode !== 0) {
      const msg = stderr.toString('utf-8').trim();
      if (/Permission denied/i.test(msg)) throw new ExecError('Permission denied', 403);
      throw new ExecError(`Download failed: ${msg.substring(0, 200) || 'unknown error'}`);
    }
    if (stdout.length > DOWNLOAD_MAX_BYTES) {
      throw new ExecError('File is too large to download from this volume', 413);
    }
    return { buffer: stdout, size: stdout.length, filename: path.posix.basename(safe) };
  }

  /** Probe whether a path is a directory, file, or absent (upload-overwrite check). */
  async pathKind(volumeName: string, relPath: string): Promise<'file' | 'directory' | null> {
    const safe = sanitizeRelPath(relPath);
    if (!safe) return 'directory';
    await this.assertVolumeExists(volumeName);
    await this.ensureHelperImage();
    const { stdout, stderr, exitCode } = await this.runHelper(volumeName, ['sh', '-c', PATHKIND_SCRIPT, 'sh', `./${safe}`]);
    if (exitCode !== 0) {
      // A permission failure on the parent must not be reported as "absent"
      // (which would let an exclusive create proceed); surface it as 403. A
      // genuinely missing parent (ENOENT) means nothing exists at this path.
      if (/Permission denied/i.test(stderr.toString('utf-8'))) throw new ExecError('Permission denied', 403);
      return null;
    }
    const kind = stdout.toString('utf-8').trim();
    if (kind === 'directory') return 'directory';
    if (kind === 'file') return 'file';
    return null;
  }

  /**
   * Write `content` to a volume file. New files are created owned by the helper
   * user (65534); existing files are truncated in place so their owner/mode are
   * preserved. The write is intentionally NON-ATOMIC (a helper death mid-write
   * can leave a truncated file) because the helper cannot chown a renamed temp
   * back to the original owner; ownership preservation is the better default for
   * editing a service's config. Returns the new mtime/size for the version token.
   */
  async writeFile(volumeName: string, relPath: string, content: Buffer): Promise<{ mtimeMs: number; size: number }> {
    const safe = sanitizeRelPath(relPath);
    if (!safe) throw new ExecError('Cannot write the volume root', 400);
    await this.assertVolumeExists(volumeName);
    await this.ensureHelperImage();

    const { stderr, exitCode } = await this.runHelper(
      volumeName,
      ['sh', '-c', WRITE_SCRIPT, 'sh', `./${safe}`],
      { writable: true, stdin: content },
    );
    if (exitCode !== 0) {
      const msg = stderr.toString('utf-8').trim();
      if (/Permission denied/i.test(msg) || exitCode === 8) throw new ExecError('Permission denied', 403);
      if (exitCode === 9) throw new ExecError('Target is a directory', 400);
      throw new ExecError(`Write failed: ${msg.substring(0, 200) || 'unknown error'}`);
    }
    const meta = await this.stat(volumeName, safe);
    return { mtimeMs: meta.mtime * 1000, size: meta.size };
  }

  /** Create a single directory; its parent must already exist. */
  async mkdir(volumeName: string, relPath: string): Promise<void> {
    const safe = sanitizeRelPath(relPath);
    if (!safe) throw new ExecError('Invalid directory path', 400);
    await this.assertVolumeExists(volumeName);
    await this.ensureHelperImage();
    const { stderr, exitCode } = await this.runHelper(
      volumeName,
      ['sh', '-c', MKDIR_SCRIPT, 'sh', `./${safe}`],
      { writable: true },
    );
    if (exitCode !== 0) {
      const msg = stderr.toString('utf-8').trim();
      if (/Permission denied/i.test(msg)) throw new ExecError('Permission denied', 403);
      if (/File exists/i.test(msg)) throw new ExecError('A file or folder with that name already exists', 409);
      throw new ExecError(`Create folder failed: ${msg.substring(0, 200) || 'unknown error'}`);
    }
  }

  /** Delete a file or directory. Removing a symlink unlinks the link, not its target. */
  async deletePath(volumeName: string, relPath: string, recursive: boolean): Promise<void> {
    const safe = sanitizeRelPath(relPath);
    if (!safe) throw new ExecError('Cannot delete the volume root', 400);
    await this.assertVolumeExists(volumeName);
    await this.ensureHelperImage();
    const { stderr, exitCode } = await this.runHelper(
      volumeName,
      ['sh', '-c', DELETE_SCRIPT, 'sh', `./${safe}`, recursive ? '1' : '0'],
      { writable: true },
    );
    if (exitCode !== 0) {
      const msg = stderr.toString('utf-8').trim();
      if (/Permission denied/i.test(msg)) throw new ExecError('Permission denied', 403);
      if (exitCode === 10 || /not empty/i.test(msg)) throw new ExecError('Directory is not empty', 409);
      throw new ExecError(`Delete failed: ${msg.substring(0, 200) || 'unknown error'}`);
    }
  }

  /** Rename/move a file or directory within the same volume. */
  async rename(volumeName: string, fromRel: string, toRel: string): Promise<void> {
    const from = sanitizeRelPath(fromRel);
    const to = sanitizeRelPath(toRel);
    if (!from || !to) throw new ExecError('Invalid rename path', 400);
    await this.assertVolumeExists(volumeName);
    await this.ensureHelperImage();
    const { stderr, exitCode } = await this.runHelper(
      volumeName,
      ['sh', '-c', RENAME_SCRIPT, 'sh', `./${from}`, `./${to}`],
      { writable: true },
    );
    if (exitCode !== 0) {
      const msg = stderr.toString('utf-8').trim();
      if (/Permission denied/i.test(msg)) throw new ExecError('Permission denied', 403);
      if (exitCode === 11 || /exists/i.test(msg)) throw new ExecError('A file or folder with that name already exists', 409);
      throw new ExecError(`Rename failed: ${msg.substring(0, 200) || 'unknown error'}`);
    }
  }

  // --- internals -----------------------------------------------------------

  private async assertVolumeExists(volumeName: string): Promise<void> {
    if (!isValidVolumeName(volumeName)) throw new ExecError('Invalid volume name', 400);
    const docker = DockerController.getInstance(this.nodeId).getDocker();
    try {
      await docker.getVolume(volumeName).inspect();
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string };
      if (e.statusCode === 404 || /no such volume/i.test(e.message ?? '')) {
        throw new VolumeNotFoundError(volumeName);
      }
      throw new ExecError(`Volume inspect failed: ${e.message ?? 'unknown'}`);
    }
  }

  private async ensureHelperImage(): Promise<void> {
    if (helperImageReady.get(this.nodeId)) return;
    const docker = DockerController.getInstance(this.nodeId).getDocker();
    try {
      await docker.getImage(HELPER_IMAGE).inspect();
      helperImageReady.set(this.nodeId, true);
      return;
    } catch { /* not present, pull it */ }

    try {
      await new Promise<void>((resolve, reject) => {
        docker.pull(HELPER_IMAGE, (err: Error | null, stream: NodeJS.ReadableStream | null) => {
          if (err || !stream) { reject(err ?? new Error('pull stream missing')); return; }
          docker.modem.followProgress(stream, (finishErr: Error | null) => {
            if (finishErr) reject(finishErr); else resolve();
          });
        });
      });
      helperImageReady.set(this.nodeId, true);
    } catch (err) {
      throw new HelperImageError((err as Error).message ?? 'pull failed');
    }
  }

  private async runHelper(
    volumeName: string,
    cmd: string[],
    opts: { writable?: boolean; stdin?: Buffer } = {},
  ): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number }> {
    const docker = DockerController.getInstance(this.nodeId).getDocker();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutStream = new Writable({ write(chunk, _enc, cb) { stdoutChunks.push(chunk); cb(); } });
    const stderrStream = new Writable({ write(chunk, _enc, cb) { stderrChunks.push(chunk); cb(); } });
    const wantStdin = opts.stdin !== undefined;

    // Manual lifecycle (create -> attach -> start -> wait -> remove). Using
    // dockerode's docker.run() with AutoRemove races: Docker can delete the
    // container before run()'s internal wait() callback fires, surfacing as
    // a 404 "no such container" from docker-modem. Only the target volume mount
    // becomes writable for mutations; every other hardening flag is unchanged.
    const container = await docker.createContainer({
      Image: HELPER_IMAGE,
      Cmd: cmd,
      Tty: false,
      User: '65534:65534',
      WorkingDir: VOLUME_MOUNT,
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: wantStdin,
      OpenStdin: wantStdin,
      StdinOnce: wantStdin,
      HostConfig: {
        ReadonlyRootfs: true,
        NetworkMode: 'none',
        CapDrop: ['ALL'],
        Privileged: false,
        SecurityOpt: ['no-new-privileges:true'],
        PidsLimit: 64,
        Memory: 128 * 1024 * 1024,
        Mounts: [{
          Type: 'volume',
          Source: volumeName,
          Target: VOLUME_MOUNT,
          ReadOnly: !opts.writable,
        }],
      },
    });

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ExecError('Helper exec timed out', 504)), EXEC_TIMEOUT_MS);
    });

    const runPromise = (async () => {
      const stream = await container.attach({ stream: true, stdin: wantStdin, stdout: true, stderr: true, hijack: wantStdin });
      const streamEnded = new Promise<void>((resolve) => {
        stream.once('end', () => resolve());
        stream.once('close', () => resolve());
      });
      docker.modem.demuxStream(stream, stdoutStream, stderrStream);
      await container.start();
      if (wantStdin && opts.stdin) {
        // Feed the file content to the container's stdin, then close it so the
        // helper's `cat > file` sees EOF and exits.
        stream.write(opts.stdin);
        stream.end();
      }
      const exitInfo = await container.wait();
      // Wait for the attach stream to finish flushing demuxed output.
      await streamEnded;
      return {
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        exitCode: typeof exitInfo?.StatusCode === 'number' ? exitInfo.StatusCode : 0,
      };
    })();

    try {
      return await Promise.race([runPromise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      // Always tear down the helper, regardless of how runPromise resolved.
      try { await container.remove({ force: true }); } catch { /* container may have been killed by timeout already */ }
    }
  }
}

// --- helpers -----------------------------------------------------------------

const VOLUME_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/;
export function isValidVolumeName(name: string): boolean {
  return typeof name === 'string' && VOLUME_NAME_RE.test(name);
}

export function sanitizeRelPath(relPath: string): string {
  if (typeof relPath !== 'string') throw new PathTraversalError();
  if (relPath.length > 1024) throw new PathTraversalError();
  if (relPath.includes('\0')) throw new PathTraversalError();
  // Normalize away leading slashes; reject absolute and parent-escape.
  const p = relPath.replace(/^\/+/, '');
  if (p === '' || p === '.') return '';
  if (p.split('/').some((seg) => seg === '..')) throw new PathTraversalError();
  // posix-resolve and re-check that it stays under the mount root.
  const resolved = path.posix.resolve(VOLUME_MOUNT, p);
  if (resolved !== VOLUME_MOUNT && !resolved.startsWith(`${VOLUME_MOUNT}/`)) {
    throw new PathTraversalError();
  }
  // Return the trailing portion (without the /v prefix) so callers can re-join.
  return resolved === VOLUME_MOUNT ? '' : resolved.slice(VOLUME_MOUNT.length + 1);
}

export function isBinaryBuffer(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}
