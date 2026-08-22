import fs from 'fs/promises';
import path from 'path';
import { isPathWithinBase } from '../../utils/validation';
import { sanitizeForLog } from '../../utils/safeLog';
import { deleteStagingMarker, validateCandidateRelPath } from './createStagingMarker';
import { isRealPathAtManagedLocation, managedAreaBase } from './managedPaths';

/**
 * Appended to positional-containment refusals so an operator staring at one
 * knows there is no override to flip: something under the managed area is not
 * where its own name says it is, and the fix is repairing or removing that
 * directory, not relocating the data directory (a whole-area move resolves
 * cleanly and never trips this).
 */
const RELOCATION_REMEDIATION = 'repair or remove the redirected directory under DATA_DIR/git-managed, then retry';

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
 * Throws on the first failed *directory* removal rather than continuing, because
 * the caller uses success here as the precondition for tombstoning: a partially
 * cleaned area must keep its checkpoint so the next boot can retry.
 *
 * The staging marker is reported rather than thrown. Once the directories are
 * gone the create is torn down, and a marker file nobody could delete is the
 * same condition the settled path already treats as non-fatal. Throwing here
 * would make one unlink failure the difference between an instance that boots
 * and one that does not.
 */
export async function removeOperationOwnedPaths(
  input: OperationOwnedCleanup,
): Promise<'cleared' | 'marker_retained'> {
  const base = path.resolve(input.stackManagedRoot);
  // Inline containment barrier at the removal sink (see `managedAreaBase`).
  const areaBase = managedAreaBase();
  if (!base.startsWith(areaBase + path.sep)) {
    throw new Error('refusing to remove a managed root outside the managed area');
  }

  if (input.ownsManagedRoot) {
    if (!await isRealPathAtManagedLocation(base)) {
      throw new Error(
        'refusing to remove a managed root that links outside its managed location. '
        + RELOCATION_REMEDIATION,
      );
    }
    await fs.rm(base, { recursive: true, force: true });
    return 'cleared';
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
    // The checks above are lexical, so a link above this path would still pass
    // them while the delete below followed it somewhere else, including into
    // another stack's generations directory inside this same managed area.
    if (!await isRealPathAtManagedLocation(resolved)) {
      throw new Error(
        'refusing to remove a path that links outside its managed location. '
        + RELOCATION_REMEDIATION,
      );
    }
    await fs.rm(resolved, { recursive: true, force: true });
  }

  try {
    await deleteStagingMarker(base);
  } catch (error) {
    console.warn(
      '[GitOps] Removed the staged directories under %s but could not clear its staging marker: %s',
      sanitizeForLog(base),
      error instanceof Error ? error.message : String(error),
    );
    return 'marker_retained';
  }
  return 'cleared';
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
  if (reason) {
    // Said out loud, because the caller only logs the outcome. A directory
    // that survives every boot with no stated reason is indistinguishable
    // from one nothing has looked at.
    console.warn(
      '[GitOps] Preserving unclaimed managed area %s: %s',
      sanitizeForLog(stackManagedRoot), reason,
    );
    return 'preserved';
  }

  if (!marker.rootPreexisted) {
    // Same inline containment barrier as the sinks above: this one removes a
    // whole managed root, so it gets the check even though the analyzer has not
    // reported it. Reported as `preserved` rather than thrown, because every
    // other unprovable case here answers that way and the caller reads the
    // outcome; the warning is what says this one is anomalous rather than
    // merely unproven.
    const root = path.resolve(stackManagedRoot);
    if (!root.startsWith(managedAreaBase() + path.sep) || !await isRealPathAtManagedLocation(root)) {
      console.warn(
        '[GitOps] Refusing to reap a managed root that links outside its managed location: %s',
        sanitizeForLog(stackManagedRoot),
      );
      return 'preserved';
    }
    await fs.rm(root, { recursive: true, force: true });
    return 'removed_root';
  }

  // The marker outcome is not reported onward: this sweep has no checkpoint to
  // keep, so a marker it could not clear is already said out loud by the
  // warning inside the call and there is nothing further for a caller to do.
  await removeOperationOwnedPaths({
    stackManagedRoot,
    candidateRelPath: marker.candidateRelPath,
    ownsManagedRoot: false,
  });
  return 'removed_candidate';
}
