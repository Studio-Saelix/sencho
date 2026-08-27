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
 * The base is node-agnostic, since callers here are given a root rather than a
 * node id. On its own it proves only that a path names somewhere inside the
 * managed area, which is why the real-path check below pins the path to its own
 * position under this base rather than to the base itself.
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
 * Whether a path resolves to its own place in the managed area once links are
 * followed.
 *
 * `path.resolve` never touches the filesystem, so lexical containment says
 * nothing about a symlink or Windows junction sitting above the target: the
 * string stays inside the managed area while a recursive delete walks straight
 * out of it. Every sink that creates or removes a managed path asks this before
 * it acts: the create teardown and staging-marker sinks, and the manifest
 * service's generation pruning, boot-sweep orphan reaping, detach staging,
 * staged-area finalization, and whole-area deletion.
 *
 * The property is positional, not membership. Asking only whether the resolved
 * path lands somewhere under the managed area is satisfied by every other node
 * and every other stack in it, so a junction from one stack's `generations` into
 * another's passes while the delete takes a generation that belongs to someone
 * else. What is checked instead is that the path resolves to exactly the
 * location its own name claims: the managed area is resolved once, and the
 * segments below it must be reached without redirection.
 *
 * Resolving the area separately is what keeps an operator's relocation working.
 * Pointing the data directory at another volume moves the whole area and stays
 * legal; a link *inside* the area does not, because nothing under it has any
 * reason to live somewhere other than where it is named.
 *
 * The target itself is resolved when it exists, so a managed root or generation
 * directory that turns out to be a link elsewhere is rejected rather than
 * deleted through. Only when it is genuinely missing does the walk climb to the
 * nearest ancestor that exists, appending the absent segments lexically:
 * nothing can be linked at a path that is not there. A path that cannot be read
 * at all stops the walk and refuses, because climbing past it would infer a
 * location for the one path whose link status could not be established.
 *
 * Callers still run their own lexical containment check at their sink, because
 * the analyzer only credits a barrier it can see at the call. This does not rely
 * on them: it establishes the target's own position before resolving anything.
 *
 * What this does not close is the window between answering and acting. Node
 * exposes no directory-relative remove, so a link swapped into an intermediate
 * segment after this returns is still followed by the caller's `fs.rm`. Whoever
 * could do that already has write access inside the managed area, which is the
 * same position they would need to plant the link this rejects, so the check is
 * worth having and the window is accepted rather than overlooked.
 */
export async function isRealPathAtManagedLocation(target: string): Promise<boolean> {
  const areaLexical = managedAreaBase();
  const resolved = path.resolve(target);
  // The position the target claims for itself, read off the lexical path before
  // any link is followed. This is what the real path has to agree with.
  const relative = path.relative(areaLexical, resolved);
  // The area root itself has no position under the area, and a relative path
  // that climbs out never had one. `path.relative` normalizes, so `..` can only
  // lead; it never appears in the middle of what this returns.
  if (relative === '' || path.isAbsolute(relative)
    || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    return false;
  }

  const area = await resolveRealPath(areaLexical);
  if (area.kind === 'unreadable') {
    console.warn('[GitOps] Cannot resolve the managed area (%s); refusing to act on anything under it', area.code);
    return false;
  }
  // No managed area on disk means nothing under it exists either, so there is
  // no link anywhere beneath it to be misled by, and the check above already
  // proved the target names a path inside it. A removal is then a no-op, and
  // the one non-removal sink creates the area as it goes.
  if (area.kind === 'absent') return true;

  const expected = path.resolve(area.real, relative);
  const trailing: string[] = [];
  let probe = resolved;
  for (;;) {
    const real = await resolveRealPath(probe);
    if (real.kind === 'resolved') {
      const actual = path.resolve(real.real, ...trailing);
      if (actual === expected) return true;
      // The single most useful fact for an operator staring at a refusal, and
      // the only place it exists: the thrown message names neither path, and a
      // refusal here can hold the boot gate.
      console.warn(
        '[GitOps] %s resolves to %s, not to %s; refusing to act on it',
        sanitizeForLog(resolved), sanitizeForLog(actual), sanitizeForLog(expected),
      );
      return false;
    }
    if (real.kind === 'unreadable') {
      console.warn(
        '[GitOps] Cannot resolve %s (%s); refusing to act on it rather than assuming where it points',
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
