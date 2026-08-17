import fs from 'fs/promises';
import path from 'path';
import { isPathWithinBase } from '../../utils/validation';
import { sanitizeForLog } from '../../utils/safeLog';
import { deleteStagingMarker, validateCandidateRelPath } from './createStagingMarker';
import { managedAreaBase } from './managedPaths';

export type OperationOwnedCleanup = {
  /** Absolute path of the stack's managed root. */
  stackManagedRoot: string;
  /** Candidate directory this operation staged, relative to the managed root. */
  candidateRelPath: string | null;
  /** Applied directory this operation promoted, relative to the managed root. */
  appliedRelPath?: string | null;
  /**
   * True only when this operation created the managed root itself. Nothing
   * else authorizes deleting the whole root, because a root that predated the
   * operation may hold another generation's retained content.
   */
  ownsManagedRoot: boolean;
};

/**
 * Remove only what one create operation put on disk.
 *
 * The rule this enforces is that a failed create must never cost an unrelated
 * generation its files. When the operation created the managed root, the whole
 * root is ours and goes. Otherwise the blast radius is exactly the directories
 * the operation staged, resolved and containment-checked against the root
 * before anything is removed.
 *
 * Throws on the first failed removal rather than continuing, because the caller
 * uses success here as the precondition for tombstoning: a partially cleaned
 * area must keep its checkpoint so the next boot can retry.
 */
export async function removeOperationOwnedPaths(input: OperationOwnedCleanup): Promise<void> {
  const base = path.resolve(input.stackManagedRoot);
  // Inline containment barrier at the removal sink (see `managedAreaBase`).
  const areaBase = managedAreaBase();
  if (!base.startsWith(areaBase + path.sep)) {
    throw new Error('refusing to remove a managed root outside the managed area');
  }

  if (input.ownsManagedRoot) {
    await fs.rm(base, { recursive: true, force: true });
    return;
  }

  for (const relPath of [input.candidateRelPath, input.appliedRelPath ?? null]) {
    if (!relPath) continue;
    const resolved = path.resolve(base, relPath);
    // A strict descendant, not merely "within": `.` and `./` resolve to the
    // base itself, and containment alone would let them wipe the whole managed
    // root on the branch whose entire purpose is to protect it.
    if (resolved === base || !isPathWithinBase(resolved, base)) {
      throw new Error('refusing to remove a path outside the managed root');
    }
    // Paths that arrive from a persisted row get the same shape check as
    // marker paths, so a malformed generation row cannot widen the blast
    // radius to a whole generations directory.
    if (!/^(generations)[\\/](candidate|applied)-/.test(relPath)) {
      throw new Error(`refusing to remove a path that is not a generation directory: ${relPath}`);
    }
    // Redundant as a security check: `resolved` is already a strict descendant
    // of `base`, and `base` of `areaBase`. Present because it is this variable
    // that reaches the removal below, and the barrier has to sit at the call.
    if (!resolved.startsWith(areaBase + path.sep)) {
      throw new Error('refusing to remove a path outside the managed area');
    }
    await fs.rm(resolved, { recursive: true, force: true });
  }

  await deleteStagingMarker(base);
}

/**
 * Cleanup for a managed root found at startup with no checkpoint and no live
 * application, driven entirely by its staging marker.
 *
 * Returns what was done so the caller can log it. A corrupt or missing marker
 * is not an error: it means nothing proves who owns this directory, so the
 * only safe action is to leave it alone.
 */
export async function cleanupUnclaimedManagedRoot(
  stackManagedRoot: string,
  marker: { operationId: string; rootPreexisted: boolean; candidateRelPath: string } | null,
): Promise<'removed_root' | 'removed_candidate' | 'preserved'> {
  if (!marker) return 'preserved';
  const reason = validateCandidateRelPath(marker.candidateRelPath, stackManagedRoot);
  if (reason) return 'preserved';

  if (!marker.rootPreexisted) {
    // Same inline containment barrier as the sinks above: this one removes a
    // whole managed root, so it gets the check even though the analyzer has not
    // reported it. Reported as `preserved` rather than thrown, because every
    // other unprovable case here answers that way and the caller reads the
    // outcome; the warning is what says this one is anomalous rather than
    // merely unproven.
    const root = path.resolve(stackManagedRoot);
    if (!root.startsWith(managedAreaBase() + path.sep)) {
      console.warn(
        '[GitOps] Refusing to reap a managed root outside the managed area: %s',
        sanitizeForLog(stackManagedRoot),
      );
      return 'preserved';
    }
    await fs.rm(root, { recursive: true, force: true });
    return 'removed_root';
  }

  await removeOperationOwnedPaths({
    stackManagedRoot,
    candidateRelPath: marker.candidateRelPath,
    ownsManagedRoot: false,
  });
  return 'removed_candidate';
}
