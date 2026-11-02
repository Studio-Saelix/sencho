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
 * (Storage, Anatomy, the Recovery overview) must call this with the evidence it
 * has, and nothing else may decide "Protected".
 *
 * A root is covered only by a root point of its current generation that
 * completed with nothing skipped and nothing excluded except by policy, whose
 * most recent verification says verified, and that finished within the
 * freshness window. The evaluator checks all of that itself rather than trusting
 * the store's `partial` demotion. Path points never count. Anything it cannot
 * establish is reported as such, never defaulted to green.
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
  /**
   * True when the live volume no longer matches the stored current generation:
   * it was deleted and recreated since the last capture, so no stored point
   * describes its bytes, whatever the stored identity still says.
   */
  liveGenerationChanged?: boolean;
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

/** The most recent verification; on a tie, the one that did not verify wins. */
function latestVerification(
  pointId: string,
  verifications: ReadonlyMap<string, readonly IntegrityVerification[]>,
): IntegrityVerification | null {
  const list = verifications.get(pointId) ?? [];
  let latest: IntegrityVerification | null = null;
  for (const v of list) {
    if (v.pointId !== pointId) continue;
    if (!latest || v.verifiedAt > latest.verifiedAt
      || (v.verifiedAt === latest.verifiedAt && latest.result === 'verified' && v.result !== 'verified')) {
      latest = v;
    }
  }
  return latest;
}

const isComplete = (p: RecoveryPoint): boolean =>
  p.status === 'succeeded' && p.capture.skippedCount === 0
  && p.exclusions.every((e) => e.reason === 'policy_excluded');

export function evaluateRootCoverage(root: RootCoverageInput, now: number, freshnessMs: number): RootCoverage {
  const storageKey = root.storage?.storageKey ?? null;
  const result = (reason: RootCoverageReason, coveringPointId: string | null = null): RootCoverage =>
    ({ storageKey, reason, coveringPointId });

  if (root.access === 'unsupported') return result('unsupported');
  if (root.access === 'inaccessible') return result('inaccessible');
  if (root.access !== 'supported') return result('identity_unknown');
  if (!root.storage) {
    // No identity and no evidence: the root has never been observed, which is
    // "not protected yet", not an identity Sencho failed to establish. An
    // identity that cannot be established while points exist is a real
    // inconsistency and keeps the unknown reason.
    return result(root.points.length > 0 ? 'identity_unknown' : 'no_point');
  }
  const storage = root.storage;
  // Points matched to a superseded identity describe bytes that were replaced.
  if (storage.state !== 'current') return result('older_generation');
  if (root.liveGenerationChanged) {
    return result(root.points.some((p) => p.kind === 'root') ? 'older_generation' : 'no_point');
  }

  const roots = root.points.filter((p) => p.kind === 'root');
  const currentGen = roots.filter((p) => p.storageId === storage.id && p.storageGeneration === storage.generation);
  if (currentGen.length === 0) {
    return result(roots.length > 0 ? 'older_generation' : 'no_point');
  }

  if (currentGen.some((p) => p.completedAt !== null && p.completedAt > now + CLOCK_SKEW_TOLERANCE_MS)) {
    return result('evidence_inconsistent');
  }

  const complete = currentGen
    .filter(isComplete)
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  if (complete.length === 0) {
    if (currentGen.some((p) => p.status === 'pending')) return result('in_progress');
    if (currentGen.some((p) => p.status === 'partial' || p.status === 'succeeded')) return result('partial_point');
    if (currentGen.some((p) => p.status === 'completion_unknown')) return result('completion_unknown');
    return result('failed_only');
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
  'identity_unknown', 'inaccessible', 'evidence_inconsistent', 'completion_unknown',
]);

/** How bad a root reason is for the aggregate: covered, plain uncovered, unknown evidence. */
function rank(reason: RootCoverageReason): number {
  if (reason === 'covered') return 0;
  return UNKNOWN_ROOT_REASONS.has(reason) ? 2 : 1;
}

export function evaluateCoverage(input: CoverageInput): CoverageVerdict {
  const freshnessMs = input.freshnessMs ?? ROOT_COVERAGE_FRESHNESS_MS;

  // Shared storage is one root however many aliases reach it. When aliases
  // disagree, the worst answer wins (unknown evidence over a plain uncovered
  // reason over covered); between two of equal rank the first is kept. Both
  // lead to the same aggregate state and reason, so the verdict does not depend
  // on input order, though the per-root reason kept for that storage may.
  const byKey = new Map<string, RootCoverage>();
  const roots: RootCoverage[] = [];
  for (const root of input.roots) {
    const evaluated = evaluateRootCoverage(root, input.now, freshnessMs);
    const key = root.storage?.storageKey;
    if (!key) {
      roots.push(evaluated);
      continue;
    }
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, evaluated);
      roots.push(evaluated);
    } else if (rank(evaluated.reason) > rank(existing.reason)) {
      byKey.set(key, evaluated);
      roots[roots.indexOf(existing)] = evaluated;
    }
  }

  if (input.volumeProtection === 'unknown') return { state: 'unknown', reason: 'capability_unknown', roots };
  if (input.volumeProtection === 'update_required') return { state: 'unknown', reason: 'capability_update_required', roots };
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
