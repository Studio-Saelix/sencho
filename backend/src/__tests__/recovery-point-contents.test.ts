/**
 * The rules for reading a saved point: the path grammar a request may use, the
 * page offset, which points can be read at all, the per-repository read slots,
 * and what a browse says about the point itself. Pure: no database, no daemon.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  POINT_READ_CONCURRENCY,
  acquirePointReadSlot,
  activeReadCount,
  describePointReadEvidence,
  parsePageOffset,
  parsePointPath,
  pointReadEligibility,
  resetPointReadSlotsForTests,
  skippedInDirectory,
} from '../services/recovery/pointContents';
import { RecoveryError } from '../services/recovery/redaction';
import type { IntegrityVerification, RecoveryPoint, StorageIdentity } from '../services/recovery/types';

function refused(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof RecoveryError ? err.errorClass : 'thrown';
  }
}

const BASE = {
  id: 'p1',
  schemaVersion: 1,
  storageId: 's1',
  storageGeneration: 2,
  repositoryId: 'r1',
  trigger: 'manual',
  actor: 'admin',
  sourceOperationId: 'op',
  sourceNodeKey: 'docker-engine:x',
  engineId: 'restic',
  capabilityVersion: 1,
  startedAt: 1,
  kind: 'root',
  pathScope: null,
} as const;

function finished(status: 'succeeded' | 'partial', skippedCount = 0): Extract<RecoveryPoint, { status: 'succeeded' | 'partial' }> {
  return {
    ...BASE,
    status,
    snapshotId: 'a'.repeat(64),
    consistency: 'crash_consistent_stopped',
    capture: { fileCount: 3, byteCount: 30, skippedCount },
    exclusions: skippedCount > 0 ? [{ path: 'sub/secret.key', reason: 'permission_denied' }] : [],
    completedAt: 2,
    failureClass: null,
  };
}

const STORAGE = {
  id: 's1', authorityId: 'a', ownerNodeKey: 'docker-engine:x', kind: 'named_volume', locator: 'pg_data',
  storageKey: 'k', generation: 2, generationToken: 't', state: 'current', createdAt: 1, observedAt: 1,
} as unknown as StorageIdentity;

const ACTIVE = { id: 'r1', active: true };

describe('parsePointPath', () => {
  it('accepts the root and canonical absolute paths unchanged', () => {
    expect(parsePointPath('/')).toBe('/');
    expect(parsePointPath('/sub/dir')).toBe('/sub/dir');
    expect(parsePointPath('/name with spaces/ü.sql')).toBe('/name with spaces/ü.sql');
    expect(parsePointPath('/-rf')).toBe('/-rf');
    expect(parsePointPath('/...')).toBe('/...');
  });

  it('refuses traversal, dot and empty segments instead of resolving them', () => {
    for (const bad of ['/..', '/sub/..', '/sub/../etc', '/.', '/sub/./x', '//', '/sub//x', '/sub/']) {
      expect(refused(() => parsePointPath(bad)), bad).toBe('invalid_request');
    }
  });

  it('refuses a relative path, an empty one and anything that is not a string', () => {
    for (const bad of ['', 'sub', '..', 'sub/x']) expect(refused(() => parsePointPath(bad)), bad).toBe('invalid_request');
    expect(refused(() => parsePointPath(['/a', '/b']))).toBe('invalid_request');
    expect(refused(() => parsePointPath({ path: '/' }))).toBe('invalid_request');
    expect(refused(() => parsePointPath(undefined))).toBe('invalid_request');
  });

  it('refuses NUL and control characters', () => {
    for (const bad of ['/a\u0000b', '/a\nb', '/a\tb', '/a\u007fb', '/a\u0085b']) {
      expect(refused(() => parsePointPath(bad))).toBe('invalid_request');
    }
  });

  it('bounds the whole path at 4096 bytes and a segment at 255', () => {
    expect(parsePointPath(`/${'a'.repeat(255)}`)).toHaveLength(256);
    expect(refused(() => parsePointPath(`/${'a'.repeat(256)}`))).toBe('invalid_request');
    // 255 multi-byte characters are well over 255 bytes.
    expect(refused(() => parsePointPath(`/${'é'.repeat(200)}`))).toBe('invalid_request');
    const deep = `/${Array.from({ length: 21 }, () => 'a'.repeat(200)).join('/')}`;
    expect(refused(() => parsePointPath(deep))).toBe('invalid_request');
  });
});

describe('parsePageOffset', () => {
  it('reads an absent offset as the first page and plain digits as themselves', () => {
    expect(parsePageOffset(undefined)).toBe(0);
    expect(parsePageOffset('0')).toBe(0);
    expect(parsePageOffset('500')).toBe(500);
  });

  it('refuses anything that is not a non-negative integer in plain digits', () => {
    for (const bad of ['', '-1', '1.5', '1e3', ' 1', 'abc', '0x10', '1234567890']) {
      expect(refused(() => parsePageOffset(bad)), bad).toBe('invalid_request');
    }
    expect(refused(() => parsePageOffset(['1', '2']))).toBe('invalid_request');
  });
});

describe('pointReadEligibility', () => {
  it('reads a finished root point of a named volume in the active repository', () => {
    expect(pointReadEligibility(finished('succeeded'), STORAGE, ACTIVE)).toEqual({ readable: true });
    expect(pointReadEligibility(finished('partial', 1), STORAGE, ACTIVE)).toEqual({ readable: true });
  });

  it('answers point_not_readable for a point that holds no snapshot', () => {
    const pending: RecoveryPoint = { ...BASE, status: 'pending', snapshotId: null, consistency: 'unknown', capture: null, exclusions: [], completedAt: null, failureClass: null };
    const failed: RecoveryPoint = { ...BASE, status: 'failed', snapshotId: null, consistency: 'unknown', capture: null, exclusions: [], completedAt: 2, failureClass: 'internal' };
    const unknown: RecoveryPoint = { ...BASE, status: 'completion_unknown', snapshotId: null, consistency: 'unknown', capture: null, exclusions: [], completedAt: 2, failureClass: 'interrupted' };
    for (const point of [pending, failed, unknown]) {
      expect(pointReadEligibility(point, STORAGE, ACTIVE)).toEqual({ readable: false, reason: 'point_not_readable' });
    }
  });

  it('answers repository_replaced for a point outside the active repository', () => {
    expect(pointReadEligibility(finished('succeeded'), STORAGE, { id: 'r1', active: false }))
      .toEqual({ readable: false, reason: 'repository_replaced' });
  });

  it('answers unsupported_entry_type for a path point and a bind root', () => {
    const pathPoint = { ...finished('succeeded'), kind: 'path', pathScope: 'sub' } as const;
    expect(pointReadEligibility(pathPoint, STORAGE, ACTIVE)).toEqual({ readable: false, reason: 'unsupported_entry_type' });
    expect(pointReadEligibility(finished('succeeded'), { kind: 'bind_root' } as Pick<StorageIdentity, 'kind'>, ACTIVE))
      .toEqual({ readable: false, reason: 'unsupported_entry_type' });
  });
});

describe('the read slots', () => {
  beforeEach(() => resetPointReadSlotsForTests());

  it('counts reads per repository and bounds them per node', () => {
    const releases = [acquirePointReadSlot('r1'), acquirePointReadSlot('r1'), acquirePointReadSlot('r2')];
    expect(activeReadCount('r1')).toBe(2);
    expect(activeReadCount('r2')).toBe(1);
    expect(activeReadCount('r3')).toBe(0);
    releases.push(acquirePointReadSlot('r3'));
    expect(POINT_READ_CONCURRENCY).toBe(4);
    expect(acquirePointReadSlot('r1')).toBeNull();
    expect(activeReadCount('r1')).toBe(2);
    for (const release of releases) release?.();
    expect(activeReadCount('r1')).toBe(0);
    expect(acquirePointReadSlot('r1')).not.toBeNull();
  });

  it('releases once however many endings call it', () => {
    const release = acquirePointReadSlot('r1');
    release?.();
    release?.();
    expect(activeReadCount('r1')).toBe(0);
    const others = [acquirePointReadSlot('r1'), acquirePointReadSlot('r1'), acquirePointReadSlot('r1'), acquirePointReadSlot('r1')];
    expect(others.every((r) => r !== null)).toBe(true);
  });
});

describe('describePointReadEvidence', () => {
  const verification = (result: IntegrityVerification['result'], verifiedAt: number, pointId = 'p1'): IntegrityVerification => ({
    id: `v${verifiedAt}`, pointId, method: 'engine_check_read_data', result, verifiedAt, operationId: null,
  });

  it('carries the storage identity, capture and latest check', () => {
    expect(describePointReadEvidence(finished('succeeded'), STORAGE, [verification('verified', 5)])).toEqual({
      id: 'p1',
      status: 'succeeded',
      snapshotId: 'a'.repeat(64),
      storage: { id: 's1', locator: 'pg_data', generation: 2, state: 'current' },
      consistency: 'crash_consistent_stopped',
      capture: { fileCount: 3, byteCount: 30, skippedCount: 0 },
      complete: true,
      integrity: { state: 'verified', method: 'engine_check_read_data', verifiedAt: 5 },
      completedAt: 2,
    });
  });

  it('never reports a partial point complete, even with a verified check', () => {
    const evidence = describePointReadEvidence(finished('partial', 1), STORAGE, [verification('verified', 5)]);
    expect(evidence.complete).toBe(false);
    expect(evidence.integrity.state).toBe('verified');
  });

  it('reports a later mismatch over an earlier pass, and an errored or missing check as unverified', () => {
    expect(describePointReadEvidence(finished('succeeded'), STORAGE, [verification('verified', 5), verification('mismatch', 6)]).integrity.state)
      .toBe('mismatch');
    expect(describePointReadEvidence(finished('succeeded'), STORAGE, [verification('error', 6)]).integrity)
      .toEqual({ state: 'unverified', method: null, verifiedAt: null });
    expect(describePointReadEvidence(finished('succeeded'), STORAGE, []).integrity.state).toBe('unverified');
    // A check filed under another point verifies nothing here.
    expect(describePointReadEvidence(finished('succeeded'), STORAGE, [verification('verified', 5, 'other')]).integrity.state)
      .toBe('unverified');
  });
});

describe('skippedInDirectory', () => {
  const exclusions = [
    { path: 'top.key', reason: 'permission_denied' as const },
    { path: 'sub/secret.key', reason: 'unreadable' as const },
    { path: 'sub/deeper/x', reason: 'vanished' as const },
  ];

  it('lists only what was left out directly inside the directory', () => {
    expect(skippedInDirectory(exclusions, '/')).toEqual([{ name: 'top.key', reason: 'permission_denied' }]);
    expect(skippedInDirectory(exclusions, '/sub')).toEqual([{ name: 'secret.key', reason: 'unreadable' }]);
    expect(skippedInDirectory(exclusions, '/sub/deeper')).toEqual([{ name: 'x', reason: 'vanished' }]);
    expect(skippedInDirectory(exclusions, '/su')).toEqual([]);
  });
});
