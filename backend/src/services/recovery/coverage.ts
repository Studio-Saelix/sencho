import { ROOT_COVERAGE_FRESHNESS_MS } from './types';
import type {
  CoverageReason,
  CoverageState,
  IntegrityVerification,
  RecoveryPoint,
  RootCoverageReason,
  StorageIdentity,
  VolumeProtectionState,
} from './types';

/**
 * The coverage evaluator. Pure: every surface that shows a protection state
 * (Storage, Anatomy, the Recovery overview) calls this with the evidence it
 * has, and nothing else decides "Protected".
 *
 * A root is covered only by a root point of its current generation that
 * completed with nothing skipped, whose most recent verification says
 * verified, and that finished within the freshness window. Path points never
 * count. Anything the evaluator cannot establish is reported as such, never
 * defaulted to green.
 */

/** How far ahead of the evaluator's clock a completion time may be before it reads as inconsistent. */
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

export type RootAccess = 'supported' | 'unsupported' | 'inaccessible' | 'unknown';

export interface RootCoverageInput {
  /** Null when the identity could not be established. */
  storage: StorageIdentity | null;
  access: RootAccess;
  /** Points recorded for this storage key, any generation and kind. */
  points: readonly RecoveryPoint[];
  /** Verifications by point id. A point missing here has never been verified. */
  verifications: ReadonlyMap<string, readonly IntegrityVerification[]>;
}

export interface CoverageInput {
  volumeProtection: VolumeProtectionState;
  roots: readonly RootCoverageInput[];
  now: number;
  freshnessMs?: number;
}

export interface RootCoverage {
  storageKey: string | null;
  reason: RootCoverageReason;
  /** The point that covers the root, when `reason` is `covered`. */
  coveringPointId: string | null;
}

export interface CoverageVerdict {
  state: CoverageState;
  reason: CoverageReason;
  roots: RootCoverage[];
}

function latestVerification(
  pointId: string,
  verifications: ReadonlyMap<string, readonly IntegrityVerification[]>,
): IntegrityVerification | null {
  const list = verifications.get(pointId) ?? [];
  let latest: IntegrityVerification | null = null;
  for (const v of list) {
    if (v.pointId !== pointId) continue;
    if (!latest || v.verifiedAt > latest.verifiedAt) latest = v;
  }
  return latest;
}

export function evaluateRootCoverage(root: RootCoverageInput, now: number, freshnessMs: number): RootCoverage {
  const storageKey = root.storage?.storageKey ?? null;
  const result = (reason: RootCoverageReason, coveringPointId: string | null = null): RootCoverage =>
    ({ storageKey, reason, coveringPointId });

  if (root.access === 'unsupported') return result('unsupported');
  if (root.access === 'inaccessible') return result('inaccessible');
  if (root.access !== 'supported' || !root.storage) return result('identity_unknown');
  const storage = root.storage;

  const roots = root.points.filter((p) => p.kind === 'root');
  const currentGen = roots.filter((p) => p.storageId === storage.id && p.storageGeneration === storage.generation);
  if (currentGen.length === 0) {
    return result(roots.length > 0 ? 'older_generation' : 'no_point');
  }

  if (currentGen.some((p) => p.completedAt !== null && p.completedAt > now + CLOCK_SKEW_TOLERANCE_MS)) {
    return result('evidence_inconsistent');
  }

  const complete = currentGen
    .filter((p) => p.status === 'succeeded' && p.snapshotId !== null && p.completedAt !== null
      && p.capture !== null && p.capture.skippedCount === 0)
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  if (complete.length === 0) {
    return result(currentGen.some((p) => p.status === 'partial') ? 'partial_point' : 'failed_only');
  }

  const verified = complete.filter((p) => latestVerification(p.id, root.verifications)?.result === 'verified');
  if (verified.length === 0) {
    const newest = latestVerification(complete[0].id, root.verifications);
    return result(newest?.result === 'mismatch' ? 'integrity_mismatch' : 'unverified');
  }

  const best = verified[0];
  if (now - (best.completedAt ?? 0) > freshnessMs) return result('stale');
  return result('covered', best.id);
}

const UNKNOWN_ROOT_REASONS: ReadonlySet<RootCoverageReason> = new Set([
  'identity_unknown', 'inaccessible', 'evidence_inconsistent',
]);

export function evaluateCoverage(input: CoverageInput): CoverageVerdict {
  const freshnessMs = input.freshnessMs ?? ROOT_COVERAGE_FRESHNESS_MS;

  // Shared storage is one root however many aliases reach it.
  const seen = new Set<string>();
  const roots: RootCoverage[] = [];
  for (const root of input.roots) {
    const key = root.storage?.storageKey;
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    roots.push(evaluateRootCoverage(root, input.now, freshnessMs));
  }

  if (input.volumeProtection === 'unknown') return { state: 'unknown', reason: 'capability_unknown', roots };
  if (input.volumeProtection !== 'available') return { state: 'unknown', reason: 'capability_unavailable', roots };
  if (roots.length === 0) return { state: 'unknown', reason: 'no_qualifying_storage', roots };

  const covered = roots.filter((r) => r.reason === 'covered').length;
  if (covered === roots.length) return { state: 'protected', reason: 'all_roots_covered', roots };
  if (covered > 0) return { state: 'partially_protected', reason: 'some_roots_covered', roots };
  if (roots.some((r) => UNKNOWN_ROOT_REASONS.has(r.reason))) {
    return { state: 'unknown', reason: 'root_evidence_unknown', roots };
  }
  return { state: 'unprotected', reason: 'no_root_covered', roots };
}
