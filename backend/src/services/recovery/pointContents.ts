import { isCompletePoint, latestVerificationFor } from './coverage';
import { RecoveryError } from './redaction';
import type {
  ExclusionReason,
  IntegrityVerification,
  PointReadEligibility,
  PointReadEvidence,
  RecoveryPoint,
  StorageIdentity,
} from './types';

/**
 * The rules for reading a saved point without restoring it: which paths a
 * request may name, which points can be read at all, how many reads run at once,
 * and what the answer says about the point itself.
 *
 * Everything here is decided from stored records. Nothing starts a helper and
 * nothing authorizes; authorization is `authorizePointContentRead`.
 */

/** Entries one browse page returns. */
export const POINT_BROWSE_PAGE_SIZE = 500;
/** Point reads one node runs at once, across every repository. */
export const POINT_READ_CONCURRENCY = 4;
/**
 * How long a file body may go without a byte delivered before the read is
 * stopped. A stalled repository mount and a client that stays connected but
 * stops reading both look the same from here, and neither may hold a helper
 * forever. The bound is idle time, not total time: a slow transfer that keeps
 * moving is never cut.
 */
export const POINT_DOWNLOAD_IDLE_MS = 5 * 60 * 1000;
/** Seconds a refused read is told to wait before it asks again. */
export const POINT_READ_RETRY_AFTER_S = 5;

const MAX_PATH_BYTES = 4_096;
const MAX_SEGMENT_BYTES = 255;
// C0 controls, DEL and C1 controls. A name holding one is not something an
// operator typed, and it would reach a log line or a header.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * One path inside a point, as a request names it: absolute within the point
 * (`/` is the root), 1 to 4096 bytes, segments of 1 to 255 bytes, no `.`, `..`
 * or empty segment, no control character. Nothing is normalized: a path that is
 * not already canonical is refused, so two spellings never name one entry and a
 * traversal is never "resolved" into something harmless-looking.
 */
export function parsePointPath(raw: unknown): string {
  if (typeof raw !== 'string') throw new RecoveryError('invalid_request');
  if (raw === '/') return raw;
  const bytes = Buffer.byteLength(raw);
  if (bytes === 0 || bytes > MAX_PATH_BYTES) throw new RecoveryError('invalid_request');
  if (!raw.startsWith('/') || CONTROL_CHARACTERS.test(raw)) throw new RecoveryError('invalid_request');
  for (const segment of raw.slice(1).split('/')) {
    if (segment === '' || segment === '.' || segment === '..') throw new RecoveryError('invalid_request');
    if (Buffer.byteLength(segment) > MAX_SEGMENT_BYTES) throw new RecoveryError('invalid_request');
  }
  return raw;
}

/** A page offset: a non-negative integer written in plain digits. */
export function parsePageOffset(raw: unknown): number {
  if (raw === undefined) return 0;
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) throw new RecoveryError('invalid_request');
  return Number(raw);
}

/**
 * Whether a point can be read at all. The one place that decides it: both read
 * routes call it before a helper starts, and the views that offer Browse ask it
 * instead of guessing from a point's status.
 *
 * Only a finished root point of a named volume, in the repository this node
 * uses now, holds a snapshot a read can open. A path point and a bind root have
 * no read yet; a pending, failed or interrupted point holds no snapshot; a point
 * in a replaced repository is kept, not served.
 */
export function pointReadEligibility(
  point: RecoveryPoint,
  storage: Pick<StorageIdentity, 'kind'>,
  repository: { id: string; active: boolean },
): PointReadEligibility {
  if (point.kind !== 'root' || storage.kind !== 'named_volume') {
    return { readable: false, reason: 'unsupported_entry_type' };
  }
  if ((point.status !== 'succeeded' && point.status !== 'partial') || !point.snapshotId) {
    return { readable: false, reason: 'point_not_readable' };
  }
  if (!repository.active || repository.id !== point.repositoryId) {
    return { readable: false, reason: 'repository_replaced' };
  }
  return { readable: true };
}

// --- Read slots -------------------------------------------------------------

/**
 * Point reads in flight, by repository. A read holds no restic lock (`--no-lock`),
 * so a prune or a forget cannot see it; this count is what repository
 * maintenance waits on or refuses against instead. The node-wide total is the
 * concurrency bound.
 */
const activeReads = new Map<string, number>();
let totalActiveReads = 0;

/**
 * Take one read slot for a repository, or null when the node is already at its
 * bound. The returned release is idempotent, so every ending (success, failure,
 * abort, idle stop) can call it without counting twice.
 */
export function acquirePointReadSlot(repositoryId: string): (() => void) | null {
  if (totalActiveReads >= POINT_READ_CONCURRENCY) return null;
  totalActiveReads += 1;
  activeReads.set(repositoryId, (activeReads.get(repositoryId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    totalActiveReads -= 1;
    const left = (activeReads.get(repositoryId) ?? 1) - 1;
    if (left > 0) activeReads.set(repositoryId, left);
    else activeReads.delete(repositoryId);
  };
}

/** Point reads in flight against one repository. */
export function activeReadCount(repositoryId: string): number {
  return activeReads.get(repositoryId) ?? 0;
}

/** Test seam: forget every slot. */
export function resetPointReadSlotsForTests(): void {
  activeReads.clear();
  totalActiveReads = 0;
}

// --- Evidence ---------------------------------------------------------------

/**
 * What a browse answer says about the point itself. `complete` is the capture's
 * own fact and `integrity` the latest check's, kept apart so neither hides the
 * other: a partial point with a verified check is readable, verified and
 * incomplete. A check that errored proves nothing and reads as unverified.
 */
export function describePointReadEvidence(
  point: Extract<RecoveryPoint, { status: 'succeeded' | 'partial' }>,
  storage: StorageIdentity,
  verifications: readonly IntegrityVerification[],
): PointReadEvidence {
  const latest = latestVerificationFor(point.id, verifications);
  const state = latest?.result === 'verified' || latest?.result === 'mismatch' ? latest.result : 'unverified';
  return {
    id: point.id,
    status: point.status,
    snapshotId: point.snapshotId,
    storage: { id: storage.id, locator: storage.locator, generation: storage.generation, state: storage.state },
    consistency: point.consistency,
    capture: point.capture,
    complete: isCompletePoint(point),
    integrity: {
      state,
      method: state === 'unverified' ? null : latest?.method ?? null,
      verifiedAt: state === 'unverified' ? null : latest?.verifiedAt ?? null,
    },
    completedAt: point.completedAt,
  };
}

/**
 * The capture's exclusions that sit directly inside one directory. Exclusion
 * paths are stored relative to the root without a leading slash.
 */
export function skippedInDirectory(
  exclusions: ReadonlyArray<{ path: string; reason: ExclusionReason }>,
  directory: string,
): Array<{ name: string; reason: ExclusionReason }> {
  const prefix = directory === '/' ? '' : `${directory.slice(1)}/`;
  const skipped: Array<{ name: string; reason: ExclusionReason }> = [];
  for (const exclusion of exclusions) {
    if (!exclusion.path.startsWith(prefix)) continue;
    const name = exclusion.path.slice(prefix.length);
    if (name === '' || name.includes('/')) continue;
    skipped.push({ name, reason: exclusion.reason });
  }
  return skipped;
}
