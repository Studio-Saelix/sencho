import type Docker from 'dockerode';
import { errorMessageForLog, sanitizeForLog } from '../../utils/safeLog';
import { RecoveryError } from './redaction';
import { HELPER_LABEL_RESTORE_INTENT } from './restic/helperRunner';
import { observeVolumeInUse } from './volumeSources';

/**
 * The volumes Sencho creates for a restore, and the proof that a volume is one
 * of its own before it removes it.
 *
 * Both restore shapes use this: restore-to-new creates its target with it, and a
 * staged overwrite creates its staging volume with it. The staging volume is
 * proven the same way, so a wrong name can never become a target a later step
 * deletes or restores into.
 */

export interface CreatedTarget {
  labels: Record<string, string>;
  createdAt: string | null;
}

/**
 * Create a volume, or return the one Docker already has under that name, with
 * its labels. Docker's create returns an existing volume silently, which is why
 * every caller re-reads the labels and the creation time.
 */
export async function createLabelledVolume(
  docker: Pick<Docker, 'createVolume' | 'getVolume'>,
  volumeName: string,
  intentId: string,
): Promise<CreatedTarget> {
  try {
    await docker.createVolume({
      Name: volumeName,
      Driver: 'local',
      Labels: { [HELPER_LABEL_RESTORE_INTENT]: intentId },
    });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== 409) {
      console.error('[Recovery] Restore target could not be created:', errorMessageForLog(err));
      // Only a refusal (a socket proxy forbidding volume creation) is a missing
      // capability. A name the daemon rejects is the caller's, and anything
      // else is the node failing.
      if (status === 400) throw new RecoveryError('invalid_request');
      throw new RecoveryError(status === 403 || status === 404 ? 'capability_unavailable' : 'node_error');
    }
  }
  const inspected = await docker.getVolume(volumeName).inspect() as {
    Labels?: Record<string, string> | null;
    CreatedAt?: string;
  };
  return {
    labels: inspected.Labels ?? {},
    createdAt: typeof inspected.CreatedAt === 'string' ? inspected.CreatedAt : null,
  };
}

export type RemoveTargetResult = 'removed' | 'missing' | 'not_ours' | 'in_use' | 'error';

/**
 * Remove a volume this intent created, and only that: it must still carry this
 * intent's label and no container may be using it.
 */
export async function removeLabelledVolume(
  docker: Pick<Docker, 'getVolume' | 'listContainers'>,
  volumeName: string,
  intentId: string,
): Promise<RemoveTargetResult> {
  try {
    const inspected = await docker.getVolume(volumeName).inspect() as { Labels?: Record<string, string> | null };
    if ((inspected.Labels ?? {})[HELPER_LABEL_RESTORE_INTENT] !== intentId) return 'not_ours';
    const inUse = await observeVolumeInUse(docker, volumeName);
    if (inUse.inUse) return 'in_use';
    await docker.getVolume(volumeName).remove({ force: false });
    return 'removed';
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return 'missing';
    console.warn('[Recovery] Could not remove restore target %s:', sanitizeForLog(volumeName), errorMessageForLog(err));
    return 'error';
  }
}
