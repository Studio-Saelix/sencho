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
 * The compose root as configured and as the filesystem names it. A link may
 * spell a path into the root either way (a symlinked COMPOSE_DIR read by its
 * real path, or the reverse), and both are the root.
 */
async function rootSpellings(baseDir: string): Promise<string[]> {
  const configured = path.resolve(baseDir);
  const real = await fsPromises.realpath(configured).catch(() => configured);
  return real === configured ? [configured] : [configured, real];
}

/**
 * The directory `dir` names, by the filesystem's own spelling, or null when it
 * cannot be resolved (gone, not a directory, not readable).
 */
async function canonicalDirectory(dir: string): Promise<string | null> {
  try {
    return await fsPromises.realpath(dir);
  } catch {
    return null;
  }
}

/**
 * Every spelling `abs` has on the way to the file it names: the path itself,
 * then, for each link met on a component of it under the compose root (the
 * file itself, a link to a link, or a linked directory on the way), the path
 * with that link replaced by where it points. Followed component by component,
 * so a chain whose last target was moved aside still yields that target's
 * spelling.
 *
 * A component outside the compose root by its spelling is asked where its
 * parent directory really is: a hop that reaches the root through another path
 * to it (an alias of the root or of a directory in it, or the root's other
 * spelling) is carried on from inside the root, so the links after it are read
 * too. Its parent only, so a link that is itself the component is still read
 * as a link, not followed to a target that may be gone.
 *
 * Stops at a component under the root that cannot be read as a link or a plain
 * entry (not there, not a directory, not readable), and after MAX_LINK_HOPS
 * links, so a loop ends.
 */
export async function linkSpellings(abs: string, baseDir: string): Promise<string[]> {
  const roots = await rootSpellings(baseDir);
  const rootHolding = (p: string): string | undefined => roots.find((root) => p.startsWith(root + path.sep));
  const leadsToRoot = (p: string): boolean => roots.some((root) => root === p || root.startsWith(p + path.sep));
  const absResolved = path.resolve(abs);
  const spellings = [absResolved];
  let pending = absResolved.split(path.sep).filter(Boolean);
  let resolved: string = path.sep;
  let hops = 0;
  while (pending.length > 0) {
    const name = pending[0];
    pending = pending.slice(1);
    let next = path.join(resolved, name);
    let root = rootHolding(next);
    if (!root && !leadsToRoot(next)) {
      // Outside the root by its spelling: it may still be inside it by another.
      const parent = await canonicalDirectory(resolved);
      const respelled = parent === null ? null : path.join(parent, name);
      root = respelled === null ? undefined : rootHolding(respelled);
      if (root && respelled !== null) {
        if (respelled !== next) spellings.push(path.join(respelled, ...pending));
        next = respelled;
      }
    }
    if (!root) {
      resolved = next;
      continue;
    }
    // Canonical containment barrier, inline with the readlink below: only a
    // path under the compose root is asked where it points.
    const contained = path.resolve(root, next);
    if (!contained.startsWith(root + path.sep)) {
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
        resolved = contained;
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
