import fs from 'fs';
import path from 'path';

import { isPathWithinBase } from '../../utils/validation';
import type { HostPathKind, HostPathProbe } from './types';

function kindOf(st: fs.Stats): HostPathKind {
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isDirectory()) return 'directory';
  if (st.isFile()) return 'file';
  if (st.isSocket()) return 'socket';
  return 'unknown';
}

const UNVERIFIED: HostPathProbe = {
  lexicalWithinStackDir: false, withinStackDir: false, exists: false,
  kind: 'unknown', escapes: false, uid: null, gid: null, mode: null,
};

/**
 * Probe a bind-mount host source for the storage inventory. Existence, type, and
 * ownership are resolved ONLY for sources lexically inside the stack's own
 * directory (relative binds); absolute external host paths are outside Sencho's
 * filesystem view and are left unverified. A within-stack symlink whose target
 * escapes the stack dir, resolved or (when the link is broken) via its readlink
 * target, is flagged `escapes` so the classifier treats it as node-bound. Never
 * reads the path's content.
 */
export async function probeHostPath(source: string, stackDir: string): Promise<HostPathProbe> {
  const resolvedStackDir = path.resolve(stackDir);
  const resolvedSource = path.resolve(source);

  if (!isPathWithinBase(resolvedSource, resolvedStackDir)) {
    return { ...UNVERIFIED };
  }

  let lst: fs.Stats;
  try {
    lst = await fs.promises.lstat(resolvedSource);
  } catch {
    return {
      lexicalWithinStackDir: true, withinStackDir: true, exists: false,
      kind: 'missing', escapes: false, uid: null, gid: null, mode: null,
    };
  }

  const kind = kindOf(lst);
  let withinStackDir = true;
  let escapes = false;

  if (kind === 'symlink') {
    const target = await resolveSymlinkTarget(resolvedSource);
    if (target !== null) {
      withinStackDir = isPathWithinBase(target, resolvedStackDir);
      escapes = !withinStackDir;
    }
    // An unreadable link is left as within-stack (conservative; nothing proves an escape).
  }

  const posix = process.platform !== 'win32';
  const uid = posix && typeof lst.uid === 'number' ? lst.uid : null;
  const gid = posix && typeof lst.gid === 'number' ? lst.gid : null;
  const mode = posix && typeof lst.mode === 'number' ? (lst.mode & 0o777).toString(8).padStart(3, '0') : null;

  return { lexicalWithinStackDir: true, withinStackDir, exists: true, kind, escapes, uid, gid, mode };
}

/**
 * Resolve a symlink's absolute target. Prefers `realpath` (follows the whole
 * chain); on a broken link falls back to `readlink` and resolves its target
 * lexically so an escape is still detectable. Returns null when neither works.
 */
async function resolveSymlinkTarget(linkPath: string): Promise<string | null> {
  try {
    return await fs.promises.realpath(linkPath);
  } catch {
    try {
      const link = await fs.promises.readlink(linkPath);
      return path.isAbsolute(link) ? path.resolve(link) : path.resolve(path.dirname(linkPath), link);
    } catch {
      return null;
    }
  }
}
