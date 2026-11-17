/**
 * The paths a file or directory under the compose root has on the way to what
 * it names, read link by link so a target that has been moved aside still has
 * one. Kept free of service imports so the fence checks can use it from
 * FileSystemService as well as from the helpers that FileSystemService loads.
 */

import path from 'path';
import { promises as fsPromises } from 'fs';

/** Links followed before a chain is given up on, as the kernel does with ELOOP. */
const MAX_LINK_HOPS = 40;

/** The longest path the kernel accepts (PATH_MAX); a longer spelling names nothing it would open. */
const MAX_SPELLING_BYTES = 4096;

/**
 * The most all of a chain's spellings may add up to. Each spelling is matched
 * against every fence ancestor by ancestor, so this bounds that work: forty
 * ordinary hops stay far below it, and a link that grows its own path does not.
 */
const MAX_TOTAL_SPELLING_BYTES = 4 * MAX_SPELLING_BYTES;

/**
 * Stands for a chain whose spellings grew past those bounds, in place of them.
 * It is not an absolute path, so the fence matcher cannot place it and a held
 * fence refuses the work as unprovable, without comparing ever longer paths.
 */
export const UNPLACEABLE_LINK_CHAIN = 'link chain too long to place';

/**
 * Every spelling `abs` has on the way to the file it names: the path itself,
 * then, for each link met on a component of it (the file itself, a link to a
 * link, a linked directory on the way, the compose root's own link, or a link
 * outside the compose root that points back into it), the path with that link
 * replaced by where it points.
 *
 * The walk resolves the path as the kernel does, component by component from
 * the filesystem root, reading every link it meets wherever it sits. A link's
 * target is walked part by part too: a relative target from the directory the
 * link really is in, and a `..` in it from the directory the walk has really
 * reached, never by collapsing the target's text (`lnk/..` is the parent of
 * where `lnk` points, not the directory `lnk` sits in). A link's spelling is
 * recorded once the rest of the path has no `..` behind a name the walk has
 * not read yet, so it is the path the kernel opens; a link followed while an
 * earlier one's spelling is still owed is covered by that one spelling. So a
 * chain whose last target was moved aside still yields that target's
 * spelling, however its hops spell their way there. Only where the links
 * point is read, never what a file holds, and the spellings are used only to
 * match the work against the directory fences.
 *
 * Stops at a component that cannot be read as a link or a plain entry (not
 * there, not a directory, not readable), and after MAX_LINK_HOPS links, so a
 * loop ends. A spelling still owed at such a stop is recorded from the text of
 * what is left. A chain whose spellings grow past MAX_SPELLING_BYTES each, or
 * MAX_TOTAL_SPELLING_BYTES together, is answered by the path itself and
 * UNPLACEABLE_LINK_CHAIN alone.
 */
export async function linkSpellings(abs: string): Promise<string[]> {
  const absResolved = path.resolve(abs);
  const spellings = [absResolved];
  let totalBytes = Buffer.byteLength(absResolved);
  // What is left to walk, last part first, so taking the next part and putting
  // a link's target in front of the rest cost nothing per part already there.
  const pending = absResolved.split(path.sep).filter(Boolean).reverse();
  // How many `..` are in `pending` (none in a resolved path to start with).
  let dotDots = 0;
  // Always a path with no link in it: every component was read and found not to be one.
  let resolved: string = path.sep;
  let hops = 0;
  // A link was followed and its spelling is not recorded yet. It is recorded
  // as soon as the rest of the path can be joined onto `resolved` as text.
  let owed = false;
  /** Records `resolved` plus what is left; false when the chain grew past the bounds. */
  const record = (): boolean => {
    const spelling = path.join(resolved, ...[...pending].reverse());
    const bytes = Buffer.byteLength(spelling);
    totalBytes += bytes;
    if (bytes > MAX_SPELLING_BYTES || totalBytes > MAX_TOTAL_SPELLING_BYTES) return false;
    spellings.push(spelling);
    owed = false;
    return true;
  };
  while (pending.length > 0) {
    const name = pending[pending.length - 1];
    // `resolved` holds no link, so the text of what is left can be joined onto
    // it, unless a `..` in that text sits behind a name not read yet: that name
    // may be a link, and the kernel takes the `..` from where it points. A
    // leading `.` or `..` is applied first; joining it as text is the same.
    // With a name next, any `..` left is behind it.
    if (owed && name !== '.' && name !== '..' && dotDots === 0 && !record()) {
      return [absResolved, UNPLACEABLE_LINK_CHAIN];
    }
    pending.pop();
    if (name === '.') continue;
    if (name === '..') {
      dotDots -= 1;
      resolved = path.dirname(resolved);
      continue;
    }
    const next = path.join(resolved, name);
    let target: string;
    try {
      target = await fsPromises.readlink(next);
    } catch (err) {
      // Not a link: carry on with the next component. Any other failure (not
      // there, not a directory, not readable): nothing below it can be asked.
      if ((err as NodeJS.ErrnoException).code === 'EINVAL') {
        resolved = next;
        continue;
      }
      pending.push(name);
      break;
    }
    hops += 1;
    if (hops > MAX_LINK_HOPS) {
      pending.push(name);
      break;
    }
    if (path.isAbsolute(target)) resolved = path.sep;
    const parts = target.split(path.sep).filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      if (parts[i] === '..') dotDots += 1;
      pending.push(parts[i]);
    }
    owed = true;
  }
  // The walk ended with a spelling still owed: it ran out of parts (all of
  // them `.` or `..`), or it stopped at a name it could not read (missing,
  // not a directory, unreadable) or at the hop limit, with a `..` behind that
  // name. The kernel would open nothing there, but a missing name may be a
  // directory a restore moved aside and will put back, most likely a plain
  // one, so the text of what is left is the best spelling there is.
  if (owed && !record()) return [absResolved, UNPLACEABLE_LINK_CHAIN];
  return [...new Set(spellings)];
}
