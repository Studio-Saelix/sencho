/**
 * Read one compose input (read-only) with a hard byte cap.
 *
 * Split out of `composeExpansionGuard` because CodeQL's
 * `js/insecure-temporary-file` query flags every `fs.open` whose path can reach
 * the operating system's temporary directory, and Git source validation does run
 * the guard over a throwaway directory. Nothing here creates or modifies a file:
 * the open is `O_RDONLY` with no create flag, the path is one the Compose
 * invocation selects or its include/extends graph declares, the descriptor is
 * checked with `fstat`
 * before the bounded read, and `O_NONBLOCK` keeps a FIFO from wedging it. The
 * module is listed under `paths-ignore` in the CodeQL config with the same
 * reasoning.
 *
 * An input that is missing or cannot be read as one is reported as skipped:
 * Compose reads the same file next and reports the real error. A path that
 * exists but is not a regular file is marked `nonRegular`, so an env-file caller
 * can treat `/dev/null` as the empty file Compose reads instead of treating it
 * as missing. Any other read failure is rethrown, so a file this guard could not
 * inspect is never handed to Compose unmeasured.
 *
 * Compose's YAML parser accepts UTF-8 and BOM-marked UTF-16LE/UTF-16BE, so the
 * bytes are decoded the same way. Decoding everything as UTF-8 would measure a
 * string the CLI never parses, and a UTF-16 alias bomb would pass the guard.
 * The decoder is shared with env-file reads; Compose's dotenv reader rejects a
 * UTF-16 env file, so decoding one only makes the guard over-read it and can
 * refuse a file Compose would reject, never the reverse.
 */
import { promises as fsPromises, constants as fsConstants } from 'fs';

/**
 * Decode one Compose YAML input from its bytes. A leading byte-order mark
 * selects UTF-16LE/BE, which is the encoding Go's YAML parser accepts; without
 * one the file is UTF-8 (a UTF-8 BOM is dropped before parsing). An odd byte at
 * the end of a UTF-16 file is not text Compose can parse either, so it is
 * dropped rather than combined with the next read.
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
   * True when the path exists but is not a regular file. Compose reads such a
   * path itself (a character device like `/dev/null` is empty, a FIFO can
   * block), so an env-file caller must not treat it as a missing file.
   */
  nonRegular?: true;
}

/**
 * Errors that mean the input cannot be read as an ordinary file in the first
 * place, which Compose reports on its own. Anything else is unexpected: the
 * guard rethrows it rather than skipping a file it failed to inspect.
 */
const SKIPPABLE_READ_ERRORS = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM', 'ELOOP']);

function isSkippableReadError(err: unknown): boolean {
  return SKIPPABLE_READ_ERRORS.has((err as NodeJS.ErrnoException).code ?? '');
}

/**
 * Read at most `maxBytes` from a regular file. Non-regular files (a directory,
 * FIFO, device, or broken link) and the ordinary unreadable-file errors are
 * skipped; any other failure is rethrown. A file that grows after the `fstat`
 * cannot be read past the cap: the read loop stops one byte past it and reports
 * `tooLarge`.
 */
export async function readComposeInputWithinCap(
  filePath: string,
  maxBytes: number,
): Promise<ComposeInputRead> {
  let handle: Awaited<ReturnType<typeof fsPromises.open>>;
  try {
    handle = await fsPromises.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch (err) {
    if (isSkippableReadError(err)) return { content: null, tooLarge: false };
    throw err;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { content: null, tooLarge: false, nonRegular: true };
    if (stat.size > maxBytes) return { content: null, tooLarge: true };

    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
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
