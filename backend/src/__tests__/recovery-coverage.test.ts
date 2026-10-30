/**
 * Coverage evaluator: only complete, verified, fresh root points of the current
 * generation count, path points never do, and missing or partial evidence is
 * reported as such instead of defaulting to Protected.
 */
import { describe, it, expect } from 'vitest';
import { evaluateCoverage, evaluateRootCoverage, type RootCoverageInput } from '../services/recovery/coverage';
import { ROOT_COVERAGE_FRESHNESS_MS } from '../services/recovery/types';
import type { IntegrityVerification, RecoveryPoint, StorageIdentity } from '../services/recovery/types';

const NOW = Date.UTC(2026, 9, 30);
const DAY = 24 * 60 * 60 * 1000;

function storage(key: string, generation = 1): StorageIdentity {
  return {
    id: `${key}-g${generation}`, authorityId: 'auth', ownerNodeKey: 'docker-engine:x', kind: 'named_volume',
    locator: key, storageKey: key, generation, generationToken: `t${generation}`, lineageParentId: null,
    state: 'current', firstSeenAt: 0, lastSeenAt: 0,
  };
}

let seq = 0;
/** Fixture builder; overrides may describe any status, so the result is asserted to the union. */
function point(s: StorageIdentity, overrides: Record<string, unknown> = {}): RecoveryPoint {
  const completedAt = overrides.completedAt === undefined ? NOW - DAY : overrides.completedAt as number | null;
  return {
    id: `p${++seq}`, schemaVersion: 1, storageId: s.id, storageGeneration: s.generation, kind: 'root', pathScope: null,
    repositoryId: 'r', snapshotId: 'snap', status: 'succeeded', consistency: 'crash_consistent_live',
    capture: { fileCount: 1, byteCount: 1, skippedCount: 0 }, exclusions: [], trigger: 'manual', actor: 'admin',
    sourceOperationId: 'op', sourceNodeKey: 'docker-engine:x', engineId: 'e', capabilityVersion: 1,
    startedAt: (completedAt ?? NOW) - 1000, failureClass: null,
    ...overrides,
    completedAt,
  } as RecoveryPoint;
}

function verified(p: RecoveryPoint, result: IntegrityVerification['result'] = 'verified', at = NOW - DAY + 1): [string, IntegrityVerification[]] {
  return [p.id, [{ id: `v-${p.id}-${at}`, pointId: p.id, method: 'engine_check_metadata', result, verifiedAt: at, operationId: null }]];
}

function root(s: StorageIdentity | null, pts: RecoveryPoint[], verifs: Array<[string, IntegrityVerification[]]> = [], access: RootCoverageInput['access'] = 'supported'): RootCoverageInput {
  return { storage: s, access, points: pts, verifications: new Map(verifs) };
}

const reasonOf = (r: RootCoverageInput) => evaluateRootCoverage(r, NOW, ROOT_COVERAGE_FRESHNESS_MS).reason;

describe('evaluateRootCoverage', () => {
  it('covers a root with a complete, verified, fresh root point', () => {
    const s = storage('a');
    const p = point(s);
    expect(evaluateRootCoverage(root(s, [p], [verified(p)]), NOW, ROOT_COVERAGE_FRESHNESS_MS)).toEqual({ storageKey: 'a', reason: 'covered', coveringPointId: p.id });
  });

  it('never counts a path point', () => {
    const s = storage('a');
    const p = point(s, { kind: 'path', pathScope: 'x' });
    expect(reasonOf(root(s, [p], [verified(p)]))).toBe('no_point');
  });

  it('does not count an unverified point, and names a failed check', () => {
    const s = storage('a');
    const p = point(s);
    expect(reasonOf(root(s, [p]))).toBe('unverified');
    expect(reasonOf(root(s, [p], [verified(p, 'error')]))).toBe('unverified');
    expect(reasonOf(root(s, [p], [verified(p, 'mismatch')]))).toBe('integrity_mismatch');
  });

  it('reads the most recent verification, so a later mismatch revokes coverage', () => {
    const s = storage('a');
    const p = point(s);
    const verifs: Array<[string, IntegrityVerification[]]> = [[p.id, [
      { id: 'v1', pointId: p.id, method: 'engine_check_metadata', result: 'verified', verifiedAt: NOW - DAY + 1, operationId: null },
      { id: 'v2', pointId: p.id, method: 'engine_check_read_data', result: 'mismatch', verifiedAt: NOW - 10, operationId: null },
    ]]];
    expect(reasonOf(root(s, [p], verifs))).toBe('integrity_mismatch');
  });

  it('does not count a partial point or a failed one', () => {
    const s = storage('a');
    const partial = point(s, { status: 'partial', capture: { fileCount: 1, byteCount: 1, skippedCount: 3 } });
    expect(reasonOf(root(s, [partial], [verified(partial)]))).toBe('partial_point');
    const failed = point(s, { status: 'failed', snapshotId: null, capture: null, failureClass: 'internal' });
    expect(reasonOf(root(s, [failed]))).toBe('failed_only');
    const unknown = point(s, { status: 'completion_unknown', snapshotId: null, capture: null, failureClass: 'interrupted' });
    expect(reasonOf(root(s, [unknown]))).toBe('completion_unknown');
    const pending = point(s, { status: 'pending', snapshotId: null, capture: null, completedAt: null });
    expect(reasonOf(root(s, [pending]))).toBe('in_progress');
    expect(reasonOf(root(s, [pending, unknown, failed]))).toBe('in_progress');
  });

  it('does not count a partial point whose capture reports nothing skipped', () => {
    const s = storage('a');
    const clean = point(s, { status: 'partial' });
    expect(reasonOf(root(s, [clean], [verified(clean)]))).toBe('partial_point');
    expect(evaluateCoverage({ volumeProtection: 'available', roots: [root(s, [clean], [verified(clean)])], now: NOW }).state).not.toBe('protected');
    // A complete point beside it still covers the root.
    const complete = point(s);
    expect(evaluateRootCoverage(root(s, [clean, complete], [verified(clean), verified(complete)]), NOW, ROOT_COVERAGE_FRESHNESS_MS))
      .toMatchObject({ reason: 'covered', coveringPointId: complete.id });
  });

  it('does not trust a succeeded row whose capture reports skipped files or unreadable exclusions', () => {
    const s = storage('a');
    const skipped = point(s, { capture: { fileCount: 1, byteCount: 1, skippedCount: 1 } });
    expect(reasonOf(root(s, [skipped], [verified(skipped)]))).toBe('partial_point');
    const excluded = point(s, { exclusions: [{ path: 'db', reason: 'unreadable' }] });
    expect(reasonOf(root(s, [excluded], [verified(excluded)]))).toBe('partial_point');
    const policy = point(s, { exclusions: [{ path: 'cache', reason: 'policy_excluded' }] });
    expect(reasonOf(root(s, [policy], [verified(policy)]))).toBe('covered');
  });

  it('does not count a point that belongs to another storage with the same generation number', () => {
    const s = storage('a');
    const other = point(storage('b'));
    expect(reasonOf(root(s, [other], [verified(other)]))).toBe('older_generation');
  });

  it('does not count coverage for an identity that has been superseded', () => {
    const s = { ...storage('a'), state: 'superseded' as const };
    const p = point(s);
    expect(reasonOf(root(s, [p], [verified(p)]))).toBe('older_generation');
    expect(evaluateCoverage({ volumeProtection: 'available', roots: [root(s, [p], [verified(p)])], now: NOW }).state).not.toBe('protected');
  });

  it('lets a check that did not verify win a tie with one that did', () => {
    const s = storage('a');
    const p = point(s);
    const at = NOW - 10;
    const tie: Array<[string, IntegrityVerification[]]> = [[p.id, [
      { id: 'z-verified', pointId: p.id, method: 'engine_check_metadata', result: 'verified', verifiedAt: at, operationId: null },
      { id: 'a-mismatch', pointId: p.id, method: 'engine_check_read_data', result: 'mismatch', verifiedAt: at, operationId: null },
    ]]];
    expect(reasonOf(root(s, [p], tie))).toBe('integrity_mismatch');
    const reversed: Array<[string, IntegrityVerification[]]> = [[p.id, [...tie[0][1]].reverse()]];
    expect(reasonOf(root(s, [p], reversed))).toBe('integrity_mismatch');
  });

  it('expires coverage after the freshness window, without deleting anything', () => {
    const s = storage('a');
    const old = point(s, { completedAt: NOW - 8 * DAY });
    expect(reasonOf(root(s, [old], [verified(old)]))).toBe('stale');
    const edge = point(s, { completedAt: NOW - 7 * DAY });
    expect(reasonOf(root(s, [edge], [verified(edge)]))).toBe('covered');
  });

  it('falls back to an older verified point while a newer one is still unverified', () => {
    const s = storage('a');
    const older = point(s, { completedAt: NOW - 2 * DAY });
    const newer = point(s, { completedAt: NOW - DAY });
    const result = evaluateRootCoverage(root(s, [newer, older], [verified(older)]), NOW, ROOT_COVERAGE_FRESHNESS_MS);
    expect(result).toMatchObject({ reason: 'covered', coveringPointId: older.id });
  });

  it('does not count a point of an earlier generation as coverage of the recreated storage', () => {
    const g1 = storage('a', 1);
    const g2 = storage('a', 2);
    const p = point(g1);
    expect(reasonOf(root(g2, [p], [verified(p)]))).toBe('older_generation');
  });

  it('treats a completion time from the future as inconsistent evidence', () => {
    const s = storage('a');
    const p = point(s, { completedAt: NOW + DAY });
    expect(reasonOf(root(s, [p], [verified(p, 'verified', NOW + DAY)]))).toBe('evidence_inconsistent');
  });

  it('reports unsupported, inaccessible and unidentified roots for what they are', () => {
    const s = storage('a');
    const p = point(s);
    expect(reasonOf(root(s, [p], [verified(p)], 'unsupported'))).toBe('unsupported');
    expect(reasonOf(root(s, [p], [verified(p)], 'inaccessible'))).toBe('inaccessible');
    expect(reasonOf(root(s, [p], [verified(p)], 'unknown'))).toBe('identity_unknown');
    expect(reasonOf(root(null, [p], [verified(p)]))).toBe('identity_unknown');
  });

  it('ignores a verification filed under another point', () => {
    const s = storage('a');
    const p = point(s);
    const stray: [string, IntegrityVerification[]] = [p.id, [{ id: 'v', pointId: 'someone-else', method: 'engine_check_metadata', result: 'verified', verifiedAt: NOW, operationId: null }]];
    expect(reasonOf(root(s, [p], [stray]))).toBe('unverified');
  });
});

describe('evaluateCoverage', () => {
  const covered = (key: string) => {
    const s = storage(key);
    const p = point(s);
    return root(s, [p], [verified(p)]);
  };
  const bare = (key: string) => root(storage(key), []);

  it('is Protected only when every root is covered', () => {
    expect(evaluateCoverage({ volumeProtection: 'available', roots: [covered('a'), covered('b')], now: NOW }))
      .toMatchObject({ state: 'protected', reason: 'all_roots_covered' });
  });

  it('is Partially protected when some roots are covered', () => {
    expect(evaluateCoverage({ volumeProtection: 'available', roots: [covered('a'), bare('b')], now: NOW }))
      .toMatchObject({ state: 'partially_protected', reason: 'some_roots_covered' });
    expect(evaluateCoverage({ volumeProtection: 'available', roots: [covered('a'), root(storage('c'), [], [], 'unsupported')], now: NOW }).state)
      .toBe('partially_protected');
  });

  it('is Unprotected when nothing is covered and the evidence is complete', () => {
    expect(evaluateCoverage({ volumeProtection: 'available', roots: [bare('a'), root(storage('b'), [], [], 'unsupported')], now: NOW }))
      .toMatchObject({ state: 'unprotected', reason: 'no_root_covered' });
  });

  it('is Unknown when nothing is covered and some root cannot be established', () => {
    expect(evaluateCoverage({ volumeProtection: 'available', roots: [bare('a'), root(null, [], [], 'unknown')], now: NOW }))
      .toMatchObject({ state: 'unknown', reason: 'root_evidence_unknown' });
    expect(evaluateCoverage({ volumeProtection: 'available', roots: [root(storage('a'), [], [], 'inaccessible')], now: NOW }).state)
      .toBe('unknown');
  });

  it('is never Protected while the capability is missing, skewed or unknown', () => {
    expect(evaluateCoverage({ volumeProtection: 'unavailable', roots: [covered('a')], now: NOW }))
      .toMatchObject({ state: 'unknown', reason: 'capability_unavailable' });
    expect(evaluateCoverage({ volumeProtection: 'update_required', roots: [covered('a')], now: NOW }))
      .toMatchObject({ state: 'unknown', reason: 'capability_update_required' });
    expect(evaluateCoverage({ volumeProtection: 'unknown', roots: [covered('a')], now: NOW }))
      .toMatchObject({ state: 'unknown', reason: 'capability_unknown' });
  });

  it('is Unknown, not Protected, with no qualifying storage', () => {
    expect(evaluateCoverage({ volumeProtection: 'available', roots: [], now: NOW }))
      .toMatchObject({ state: 'unknown', reason: 'no_qualifying_storage' });
  });

  it('is Unknown when the only evidence is an interrupted point', () => {
    const s = storage('a');
    const unknown = point(s, { status: 'completion_unknown', snapshotId: null, capture: null, failureClass: 'interrupted' });
    expect(evaluateCoverage({ volumeProtection: 'available', roots: [root(s, [unknown])], now: NOW }))
      .toMatchObject({ state: 'unknown', reason: 'root_evidence_unknown' });
  });

  it('takes the unknown answer over a plain uncovered one, whatever the order', () => {
    const s = storage('mixed');
    const old = point(s, { completedAt: NOW - 30 * DAY });
    const stale = root(s, [old], [verified(old)]);
    const blocked = { ...stale, access: 'inaccessible' as const };
    for (const roots of [[stale, blocked], [blocked, stale]]) {
      const verdict = evaluateCoverage({ volumeProtection: 'available', roots, now: NOW });
      expect(verdict.roots.map((r) => r.reason)).toEqual(['inaccessible']);
      expect(verdict).toMatchObject({ state: 'unknown', reason: 'root_evidence_unknown' });
    }
  });

  it('takes the uncovered answer when aliases of one storage disagree, whatever the order', () => {
    const shared = covered('shared');
    const blocked = { ...shared, access: 'inaccessible' as const };
    for (const roots of [[shared, blocked], [blocked, shared]]) {
      const verdict = evaluateCoverage({ volumeProtection: 'available', roots, now: NOW });
      expect(verdict.roots).toHaveLength(1);
      expect(verdict.roots[0].reason).toBe('inaccessible');
      expect(verdict.state).toBe('unknown');
    }
  });

  it('counts shared storage once however many aliases reach it', () => {
    const shared = covered('shared');
    const verdict = evaluateCoverage({ volumeProtection: 'available', roots: [shared, shared, bare('b')], now: NOW });
    expect(verdict.roots).toHaveLength(2);
    expect(verdict.state).toBe('partially_protected');
  });
});
