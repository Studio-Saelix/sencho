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

/**
 * Every spelling `abs` has on the way to the file it names: the path itself,
 * then, for each link met on a component of it (the file itself, a link to a
 * link, a linked directory on the way, the compose root's own link, or a link
 * outside the compose root that points back into it), the path with that link
 * replaced by where it points.
 *
 * The walk resolves the path as the kernel does, component by component from
 * the filesystem root, reading every link it meets wherever it sits: a relative
 * link target is resolved against the directory the link really is in, and a
 * chain that leaves the compose root and comes back is followed the whole way.
 * So a chain whose last target was moved aside still yields that target's
 * spelling, however its hops spell their way there. Only where the links point
 * is read, never what a file holds, and the spellings are used only to match
 * the work against the directory fences.
 *
 * Stops at a component that cannot be read as a link or a plain entry (not
 * there, not a directory, not readable), and after MAX_LINK_HOPS links, so a
 * loop ends.
 */
export async function linkSpellings(abs: string): Promise<string[]> {
  const absResolved = path.resolve(abs);
  const spellings = [absResolved];
  let pending = absResolved.split(path.sep).filter(Boolean);
  let resolved: string = path.sep;
  let hops = 0;
  while (pending.length > 0) {
    const next = path.join(resolved, pending[0]);
    pending = pending.slice(1);
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
      break;
    }
    hops += 1;
    if (hops > MAX_LINK_HOPS) break;
    // `resolved` holds no link, so this is where the kernel resolves the target.
    const destination = path.resolve(resolved, target);
    spellings.push(path.join(destination, ...pending));
    pending = [...destination.split(path.sep).filter(Boolean), ...pending];
    resolved = path.sep;
  }
  return [...new Set(spellings)];
}
