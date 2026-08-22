/**
 * Managed-area path vocabulary, defined here rather than imported from
 * GitProjectManifestService.
 *
 * The manifest service reaches these modules through GitSourceService, so
 * importing its constants back into the gitops layer forms a cycle. Under that
 * cycle the binding can still be uninitialized when these modules evaluate,
 * which silently yields paths like `undefined/candidate-<sha>`: they pass a
 * containment check against the managed root and name a directory that does
 * not exist, so cleanup removes nothing and leaves the real one behind.
 *
 * These values must stay in step with the manifest service's layout.
 */
import fs from 'fs/promises';
import path from 'path';
import { sanitizeForLog } from '../../utils/safeLog';

export const MANAGED_ROOT_NAME = 'git-managed';
export const GENERATIONS_DIR = 'generations';

/**
 * The directory every stack's managed area lives under.
 *
 * Exists so each filesystem call on a managed path can resolve its target and
 * check containment in its own scope. CodeQL does not credit the wrapped
 * `isPathWithinBase` helper as a barrier, so `js/path-injection` reports the
 * call even when the path was already validated; the check has to be inline at
 * the call to be recognised. The duplication is deliberate.
 *
 * The base is node-agnostic on purpose, since callers here are given a root
 * rather than a node id. It proves a path is inside the managed area, not that
 * it is inside one node's subtree of it; keeping a stack out of another node's
 * area still rests on stack-name validation at the route.
 */
export function managedAreaBase(): string {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  return path.resolve(dataDir, MANAGED_ROOT_NAME);
}

/**
 * Resolve one path, keeping "is not there" apart from "could not be read".
 *
 * The distinction is the whole safety property. Collapsing both to "absent"
 * would let the walk below climb past a path it could not resolve and infer
 * containment from an ancestor, which is how a junction that throws `EPERM` or
 * `ELOOP` instead of resolving would be treated as though it were not there at
 * all. Only `ENOENT` means absent; everything else is a failure to establish
 * what a path points at, and a containment check that cannot see a path must
 * not pass it.
 */
async function resolveRealPath(target: string): Promise<
  | { kind: 'resolved'; real: string }
  | { kind: 'absent' }
  | { kind: 'unreadable'; code: string }
> {
  try {
    return { kind: 'resolved', real: await fs.realpath(target) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'unreadable', code: code ?? 'UNKNOWN' };
  }
}

/**
 * Whether a path is still inside the managed area once links are followed.
 *
 * `path.resolve` never touches the filesystem, so lexical containment says
 * nothing about a symlink or Windows junction sitting above the target: the
 * string stays inside the managed area while a recursive delete walks straight
 * out of it. Every sink in the create path asks this before it acts. Deletes
 * elsewhere under the managed area, notably the manifest service's generation
 * pruning and detach cleanup, still rely on lexical containment alone.
 *
 * Both sides are resolved, so relocating the whole data directory onto another
 * volume keeps working. What this rejects is a link that escapes the *real*
 * managed area, not one that moves the area itself.
 *
 * The target itself is resolved when it exists, so a managed root or generation
 * directory that turns out to be a link to somewhere else is rejected rather
 * than deleted through. Only when it is genuinely missing does the walk climb
 * to the nearest ancestor that exists, appending the absent segments lexically:
 * nothing can be linked at a path that is not there. A path that cannot be read
 * at all stops the walk and refuses, because climbing past it would infer
 * containment for the one path whose link status could not be established.
 *
 * Callers must run their own lexical containment check first. This relies on it
 * for the case below where the managed area itself does not exist.
 */
export async function isRealPathWithinManagedArea(target: string): Promise<boolean> {
  const area = await resolveRealPath(managedAreaBase());
  if (area.kind === 'unreadable') {
    console.warn('[GitOps] Cannot resolve the managed area (%s); refusing to remove anything under it', area.code);
    return false;
  }
  // No managed area on disk means nothing under it exists either, so the
  // removal is a no-op. The caller's lexical check already proved the target
  // names a path inside it, and a forced remove of a missing path does nothing.
  if (area.kind === 'absent') return true;

  const trailing: string[] = [];
  let probe = path.resolve(target);
  for (;;) {
    const real = await resolveRealPath(probe);
    if (real.kind === 'resolved') {
      return path.resolve(real.real, ...trailing).startsWith(area.real + path.sep);
    }
    if (real.kind === 'unreadable') {
      console.warn(
        '[GitOps] Cannot resolve %s (%s); refusing to remove it rather than assuming where it points',
        sanitizeForLog(probe), real.code,
      );
      return false;
    }
    const parent = path.dirname(probe);
    // Reached the filesystem root without finding anything that exists.
    if (parent === probe) return false;
    trailing.unshift(path.basename(probe));
    probe = parent;
  }
}
