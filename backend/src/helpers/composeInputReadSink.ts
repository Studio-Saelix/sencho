/**
 * Read one compose input (read-only) with a hard byte cap.
 *
 * Split out of `composeExpansionGuard` because CodeQL's
 * `js/insecure-temporary-file` query flags every `fs.open` whose path can reach
 * the operating system's temporary directory, and Git source validation does run
 * the guard over a throwaway directory. Nothing here creates or modifies a file:
 * the open is `O_RDONLY` with no create flag, the path is one the Compose
 * invocation selects or its include/extends graph declares (or an env file that
 * selects or interpolates them), the path is `stat`ed before it is opened so a
 * device or pipe is never opened, the descriptor is checked with `fstat` before
 * the bounded read (the file may have been swapped in between), and
 * `O_NONBLOCK` keeps a FIFO from wedging it. The module is listed under
 * `paths-ignore` in the CodeQL config with the same reasoning, which also
 * covers `resolvePhysicalDirectory` below.
 *
 * An input that is missing or cannot be read as one is reported as skipped:
 * Compose reads the same file next and reports the real error. A path that
 * exists but is not a regular file is marked `nonRegular` with its kind: a
 * directory is Compose's error to report, `/dev/null` is the empty file Compose
 * reads, and anything else (another device, a FIFO) is `unbounded` because
 * Compose reads it with no cap, so the caller must refuse it. Any other read
 * failure is rethrown, so a file this guard could not inspect is never handed
 * to Compose unmeasured.
 *
 * Compose's YAML parser accepts UTF-8 and BOM-marked UTF-16LE/UTF-16BE, so the
 * bytes are decoded the same way. Decoding everything as UTF-8 would measure a
 * string the CLI never parses, and a UTF-16 alias bomb would pass the guard.
 * The decoder is shared with env-file reads; Compose's dotenv reader rejects a
 * UTF-16 env file, so decoding one only makes the guard over-read it and can
 * refuse a file Compose would reject, never the reverse. The file is read
 * whole and decoded once.
 */
import { promises as fsPromises, constants as fsConstants } from 'fs';
import type { Stats } from 'fs';
import path from 'path';

/**
 * Decode one Compose YAML input from its bytes. A leading byte-order mark
 * selects UTF-16LE/BE, which is the encoding Go's YAML parser accepts; without
 * one the file is UTF-8 (a UTF-8 BOM is dropped before parsing). An odd byte at
 * the end of a UTF-16 file is not text Compose can parse either, so it is
 * dropped.
 */
export function decodeComposeInput(bytes: Buffer): string {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return decodeUtf16(bytes.subarray(2), 'le');
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return decodeUtf16(bytes.subarray(2), 'be');
    }
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString('utf8');
  }
  return bytes.toString('utf8');
}

function decodeUtf16(bytes: Buffer, endianness: 'le' | 'be'): string {
  const evenLength = bytes.length - (bytes.length % 2);
  const aligned = bytes.subarray(0, evenLength);
  if (endianness === 'le') return aligned.toString('utf16le');
  const swapped = Buffer.from(aligned);
  swapped.swap16();
  return swapped.toString('utf16le');
}

export interface ComposeInputRead {
  /** File text, or null when the input was skipped. */
  content: string | null;
  /** True when the file is larger than the cap and the caller must refuse it. */
  tooLarge: boolean;
  /**
   * Set when the path exists but is not a regular file. `directory` and
   * `null-device` hold no data Compose could expand (it reports the first and
   * reads the second as empty). `unbounded` is any other device or a FIFO:
   * Compose reads it to its end, so the guard cannot measure it and the caller
   * must refuse it.
   */
  nonRegular?: NonRegularKind;
}

export type NonRegularKind = 'directory' | 'null-device' | 'unbounded';

async function classifyNonRegular(stat: Stats): Promise<NonRegularKind> {
  if (stat.isDirectory()) return 'directory';
  if (stat.isCharacterDevice()) {
    const nullDevice = await fsPromises.stat('/dev/null').catch(() => undefined);
    if (nullDevice && nullDevice.isCharacterDevice() && nullDevice.rdev === stat.rdev) return 'null-device';
  }
  return 'unbounded';
}

/**
 * Errors that mean the input cannot be read as an ordinary file in the first
 * place, which Compose reports on its own. Anything else is unexpected: the
 * guard rethrows it rather than skipping a file it failed to inspect.
 */
const SKIPPABLE_READ_ERRORS = new Set([
  'ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM', 'ELOOP',
  // A name Compose cannot open either: too long, a socket, or a NUL byte.
  'ENAMETOOLONG', 'ENXIO', 'ERR_INVALID_ARG_VALUE',
]);

/** Paths that name a process's own descriptors or memory rather than a file. */
const PROCESS_DESCRIPTOR_PATH = /^(?:\/proc\/(?:self|thread-self|\d+)\/root)?\/(?:dev\/(?:stdin|stdout|stderr|fd\/)|proc\/(?:self|thread-self|\d+)\/(?:fd\/|mem$|task\/\d+\/(?:fd\/|mem$)))/;

/**
 * True when the path, or a symlink it leads through, names one of those. The
 * guard's own stdin is not the Compose child's, so a link to `/dev/stdin` has to
 * be refused where it is found, not after it resolves to whatever this process
 * has open.
 */
async function namesProcessDescriptor(filePath: string): Promise<boolean> {
  let current = filePath;
  for (let hop = 0; hop < 40; hop += 1) {
    if (PROCESS_DESCRIPTOR_PATH.test(current)) return true;
    let target: string;
    try {
      const link = await fsPromises.lstat(current);
      if (!link.isSymbolicLink()) return false;
      target = await fsPromises.readlink(current);
    } catch {
      return false;
    }
    current = path.resolve(path.dirname(current), target);
  }
  return false;
}

function isSkippableReadError(err: unknown): boolean {
  return SKIPPABLE_READ_ERRORS.has((err as NodeJS.ErrnoException).code ?? '');
}

/**
 * Read at most `maxBytes` from a regular file. A non-regular file is reported
 * with its kind, without being opened, and the ordinary unreadable-file errors
 * (including a broken link) are skipped; any other failure is rethrown. A file
 * that reports a small size but yields more (a `/proc` entry, or one that grows
 * after the `fstat`) cannot be read past the cap: the read loop stops once it
 * holds more than `maxBytes` and reports `tooLarge`.
 */
export async function readComposeInputWithinCap(
  filePath: string,
  maxBytes: number,
): Promise<ComposeInputRead> {
  // The guard's own descriptors are not Compose's: `/dev/stdin` or
  // `/proc/self/fd/0` named in a compose input is whatever the Compose child
  // has there (often a pipe), not what this process has, and `/proc/*/mem`
  // fails every read. Refuse them by name.
  if (await namesProcessDescriptor(filePath)) return { content: null, tooLarge: false, nonRegular: 'unbounded' };
  // `stat` before `open`: opening a device can act on it (a watchdog starts, a
  // tape rewinds), so a path that is not a regular file is classified without
  // being opened.
  let before: Stats;
  try {
    before = await fsPromises.stat(filePath);
  } catch (err) {
    if (isSkippableReadError(err)) return { content: null, tooLarge: false };
    throw err;
  }
  // A socket cannot be opened (ENXIO), so Compose fails on it without reading
  // anything, the same outcome as the open errors skipped below.
  if (before.isSocket()) return { content: null, tooLarge: false };
  if (!before.isFile()) return { content: null, tooLarge: false, nonRegular: await classifyNonRegular(before) };

  let handle: Awaited<ReturnType<typeof fsPromises.open>>;
  try {
    handle = await fsPromises.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch (err) {
    if (isSkippableReadError(err)) return { content: null, tooLarge: false };
    throw err;
  }
  try {
    // The path can change between the `stat` and the `open`; the descriptor is
    // the file that will be read.
    const stat = await handle.stat();
    if (!stat.isFile()) return { content: null, tooLarge: false, nonRegular: await classifyNonRegular(stat) };
    if (stat.size > maxBytes) return { content: null, tooLarge: true };

    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      // Whole chunks only: a `/proc` file such as `pagemap` rejects a read
      // whose length is not a multiple of its record size, and the overshoot
      // past the cap is dropped below.
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) return { content: null, tooLarge: true };
    return { content: decodeComposeInput(Buffer.concat(chunks)), tooLarge: false };
  } catch (err) {
    // A read that fails because the input is not an ordinary file, or is gone,
    // is Compose's to report as well. Anything else is a failure this guard did
    // not get to inspect, so it is not treated as a pass.
    if (isSkippableReadError(err)) return { content: null, tooLarge: false };
    throw err;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * The physical path of a directory, so relative paths and `..` resolve the way
 * they do for a process running there. A directory that cannot be resolved is
 * returned unchanged: Compose reports it.
 */
export async function resolvePhysicalDirectory(directory: string): Promise<string> {
  try {
    return await fsPromises.realpath(directory);
  } catch {
    return directory;
  }
}
