/**
 * Read one compose input (read-only) with a hard byte cap.
 *
 * Split out of `composeExpansionGuard` because CodeQL's
 * `js/insecure-temporary-file` query flags every `fs.open` whose path can reach
 * the operating system's temporary directory, and Git source validation does run
 * the guard over a throwaway directory. Nothing here creates or modifies a file:
 * the open is `O_RDONLY` with no create flag, the path is contained to the
 * invocation directory by the caller, the descriptor is checked with `fstat`
 * before the bounded read, and `O_NONBLOCK` keeps a FIFO from wedging it. The
 * module is listed under `paths-ignore` in the CodeQL config with the same
 * reasoning.
 *
 * A file this read cannot handle is reported as skipped, never as a render
 * failure: Compose reads the same file next and reports the real error.
 */
import { promises as fsPromises, constants as fsConstants } from 'fs';

export interface ComposeInputRead {
  /** File text, or null when the input was skipped. */
  content: string | null;
  /** True when the file is larger than the cap and the caller must refuse it. */
  tooLarge: boolean;
}

/**
 * Read at most `maxBytes` from a regular file. Non-regular files (a directory,
 * FIFO, device, or broken link) and unreadable files are skipped. A file that
 * grows after the `fstat` cannot be read past the cap: the read loop stops one
 * byte past it and reports `tooLarge`.
 */
export async function readComposeInputWithinCap(
  filePath: string,
  maxBytes: number,
): Promise<ComposeInputRead> {
  let handle: Awaited<ReturnType<typeof fsPromises.open>>;
  try {
    handle = await fsPromises.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch {
    return { content: null, tooLarge: false };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { content: null, tooLarge: false };
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
    return { content: Buffer.concat(chunks).toString('utf8'), tooLarge: false };
  } catch {
    // A read that fails mid-file is Compose's to report as well.
    return { content: null, tooLarge: false };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
