import { isCompletePoint, latestVerificationOf } from './coverage';
import type {
  CaptureSummary,
  IntegrityVerification,
  PointExclusion,
  RecoveryPoint,
  StorageIdentity,
} from './types';

/**
 * What a browse answer says about the point itself: built from the point, its
 * latest verification and its storage identity.
 *
 * A point that skipped a path, or whose most recent check did not verify, is
 * never reported `complete`, whatever else the record says. The data is still
 * readable: `integrity` reports the check on its own, and `complete` is the
 * conjunction, so a partial point with a verified check reads as readable and
 * incomplete rather than as either a clean copy or an unverified one. The input
 * is the narrowed point the read path has already proven, so a status a browse
 * cannot serve is not representable.
 */
export interface PointContentsEvidence {
  id: string;
  kind: 'root' | 'path';
  /** Only a point a browse can serve: it has a snapshot and a capture. */
  status: 'succeeded' | 'partial';
  snapshotId: string;
  completedAt: number;
  consistency: RecoveryPoint['consistency'];
  capture: CaptureSummary;
  exclusions: PointExclusion[];
  integrity: {
    result: 'verified' | 'mismatch' | 'error' | 'unverified';
    method: IntegrityVerification['method'] | null;
    verifiedAt: number | null;
  };
  /** The capture counted everything and the latest check verified. Never true for a partial point. */
  complete: boolean;
  /** The storage the point describes; a read refuses a point without one. */
  storage: {
    id: string;
    kind: StorageIdentity['kind'];
    locator: string;
    generation: number;
    state: StorageIdentity['state'];
  };
}

export function describePointContentsEvidence(
  point: Extract<RecoveryPoint, { status: 'succeeded' | 'partial' }>,
  storage: StorageIdentity,
  verifications: readonly IntegrityVerification[],
): PointContentsEvidence {
  // A verification filed under another point never verifies this one, whatever
  // list the caller passed.
  const latest = latestVerificationOf(verifications.filter((v) => v.pointId === point.id));
  return {
    id: point.id,
    kind: point.kind,
    status: point.status,
    snapshotId: point.snapshotId,
    completedAt: point.completedAt,
    consistency: point.consistency,
    capture: point.capture,
    exclusions: point.exclusions,
    integrity: {
      result: latest?.result ?? 'unverified',
      method: latest?.method ?? null,
      verifiedAt: latest?.verifiedAt ?? null,
    },
    complete: isCompletePoint(point) && latest?.result === 'verified',
    storage: {
      id: storage.id,
      kind: storage.kind,
      locator: storage.locator,
      generation: storage.generation,
      state: storage.state,
    },
  };
}
