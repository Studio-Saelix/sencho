import { isCompletePoint, latestVerificationFor } from './coverage';
import type {
  CaptureSummary,
  IntegrityVerification,
  PointExclusion,
  RecoveryPoint,
  StorageIdentity,
} from './types';

/**
 * What a surface showing a point's contents says about the point itself.
 *
 * One shape, built once from the point, its latest verification and its storage
 * identity, so browse and download never describe the same point differently. A
 * point that skipped a path, or whose most recent check did not verify, is never
 * reported `complete`, whatever else the record says: the data is readable and
 * still not a verified copy.
 */
export interface PointContentsEvidence {
  id: string;
  kind: 'root' | 'path';
  status: RecoveryPoint['status'];
  snapshotId: string | null;
  completedAt: number | null;
  consistency: RecoveryPoint['consistency'];
  capture: CaptureSummary | null;
  exclusions: PointExclusion[];
  integrity: {
    result: 'verified' | 'mismatch' | 'error' | 'unverified';
    method: IntegrityVerification['method'] | null;
    verifiedAt: number | null;
  };
  /** Nothing skipped, and the latest check verified. Never true for a partial point. */
  complete: boolean;
  storage: {
    id: string;
    kind: StorageIdentity['kind'];
    locator: string;
    generation: number;
    state: StorageIdentity['state'];
  } | null;
}

export function describePointContentsEvidence(
  point: RecoveryPoint,
  storage: StorageIdentity | null,
  verifications: readonly IntegrityVerification[],
): PointContentsEvidence {
  const byPoint = new Map<string, IntegrityVerification[]>();
  byPoint.set(point.id, [...verifications]);
  const latest = latestVerificationFor(point.id, byPoint);
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
    storage: storage
      ? {
          id: storage.id,
          kind: storage.kind,
          locator: storage.locator,
          generation: storage.generation,
          state: storage.state,
        }
      : null,
  };
}
