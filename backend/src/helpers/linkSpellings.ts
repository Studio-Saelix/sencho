/**
 * The paths a file under the compose root has on the way to what it names,
 * read link by link so a target that has been moved aside still has one.
 * Kept free of service imports: the fence admission in FileSystemService and
 * the env file resolution both use it.
 */

import path from 'path';
import { promises as fsPromises } from 'fs';

/** Links followed before a chain is given up on, as the kernel does with ELOOP. */
const MAX_LINK_HOPS = 40;

/**
 * Every spelling `abs` has on the way to the file it names: the path itself,
 * then, for each link met on a component of it under the compose root (the
 * file itself, a link to a link, or a linked directory on the way), the path
 * with that link replaced by where it points. Followed component by component,
 * so a chain whose last target was moved aside still yields that target's
 * spelling. Stops at a component that cannot be read as a link or a plain
 * entry (not there, not a directory, not readable), and after MAX_LINK_HOPS
 * links, so a loop ends.
 */
export async function linkSpellings(abs: string, baseDir: string): Promise<string[]> {
  const baseResolved = path.resolve(baseDir);
  const spellings = [path.resolve(abs)];
  let pending = path.resolve(abs).split(path.sep).filter(Boolean);
  let resolved: string = path.sep;
  let hops = 0;
  while (pending.length > 0) {
    const next = path.join(resolved, pending[0]);
    pending = pending.slice(1);
    // Canonical containment barrier, inline with the readlink below: only a
    // path under the compose root is asked where it points.
    const contained = path.resolve(baseResolved, next);
    if (!contained.startsWith(baseResolved + path.sep)) {
      resolved = next;
      continue;
    }
    let target: string;
    try {
      target = await fsPromises.readlink(contained);
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
    const destination = path.resolve(path.dirname(contained), target);
    spellings.push(path.join(destination, ...pending));
    pending = [...destination.split(path.sep).filter(Boolean), ...pending];
    resolved = path.sep;
  }
  return [...new Set(spellings)];
}
