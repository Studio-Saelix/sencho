import { describe, it, expect } from 'vitest';
import type { FindingDismissal } from '@/types/findingDismissal';
import type { PostureReason } from '@/types/security';
import { isReasonDismissable, partitionPostureReasons, securityDismissalKey } from './securityDismissals';

const NOW = 1_000_000;

function reason(partial: Partial<PostureReason> = {}): PostureReason {
  return {
    kind: 'needs_review', count: 2, severity: 'review', label: 'Findings needing review', description: 'd', targetTab: 'suppressions',
    key: 'needs_review:all', fingerprint: 'fp-1', dismissPolicy: 'any', ...partial,
  };
}

function dismissal(partial: Partial<FindingDismissal> = {}): FindingDismissal {
  return {
    id: 1, nodeId: 1, surface: 'security', findingKey: securityDismissalKey(1, 'needs_review:all'), fingerprint: 'fp-1',
    severity: 'review', count: 2, mode: 'until_change', expiresAt: null, createdBy: 'alice', createdAt: NOW - 1000, ...partial,
  };
}

describe('partitionPostureReasons', () => {
  it('sets aside a reason its dismissal still covers, and keeps it listed in the dismissed set', () => {
    const r = reason();
    const { active, dismissed } = partitionPostureReasons([r], [dismissal()], 1, NOW);
    expect(active).toEqual([]);
    expect(dismissed).toEqual([{ reason: r, dismissal: dismissal() }]);
  });

  it('resurfaces a reason when its fingerprint changes or its count grows', () => {
    expect(partitionPostureReasons([reason({ fingerprint: 'fp-2' })], [dismissal()], 1, NOW).active).toHaveLength(1);
    expect(partitionPostureReasons([reason({ count: 3 })], [dismissal()], 1, NOW).active).toHaveLength(1);
    expect(partitionPostureReasons([reason({ count: 1 })], [dismissal()], 1, NOW).active).toHaveLength(0);
  });

  it('resurfaces a reason that became more severe', () => {
    const info = dismissal({ severity: 'info' });
    expect(partitionPostureReasons([reason({ severity: 'review' })], [info], 1, NOW).active).toHaveLength(1);
  });

  it('honors a timed dismissal until its time is up', () => {
    const timed = dismissal({ mode: 'days', expiresAt: NOW + 1000 });
    expect(partitionPostureReasons([reason()], [timed], 1, NOW).active).toHaveLength(0);
    expect(partitionPostureReasons([reason()], [timed], 1, NOW + 2000).active).toHaveLength(1);
  });

  it('never sets aside a blocker, an unkeyed reason, or a reason another node dismissed', () => {
    const blocker = reason({ severity: 'blocker', dismissPolicy: 'none', key: 'secret:all' });
    const stored = dismissal({ findingKey: securityDismissalKey(1, 'secret:all'), severity: 'blocker' });
    expect(partitionPostureReasons([blocker], [stored], 1, NOW).active).toHaveLength(1);
    const unkeyed = reason({ key: undefined, fingerprint: undefined, dismissPolicy: undefined });
    expect(partitionPostureReasons([unkeyed], [dismissal()], 1, NOW).active).toHaveLength(1);
    expect(partitionPostureReasons([reason()], [dismissal({ findingKey: securityDismissalKey(2, 'needs_review:all') })], 1, NOW).active).toHaveLength(1);
  });
});

describe('a remote that sends part of the facts', () => {
  it('lists a reason with a key but no policy, and one with an unrecognised key, as active and not dismissable', () => {
    const noPolicy = reason({ dismissPolicy: undefined });
    expect(partitionPostureReasons([noPolicy], [dismissal()], 1, NOW).active).toHaveLength(1);
    expect(isReasonDismissable(noPolicy)).toBe(false);
    const unknown = reason({ key: 'future_kind:all', dismissPolicy: 'any' });
    expect(partitionPostureReasons([unknown], [dismissal()], 1, NOW).active).toHaveLength(1);
  });
});

describe('securityDismissalKey', () => {
  it('matches the key the hub stores', () => {
    expect(securityDismissalKey(3, 'public_exposure:conflict')).toBe('security:3:public_exposure:conflict');
  });
});

describe('isReasonDismissable', () => {
  it('needs the remote facts, a non-blocker, and a policy that allows it', () => {
    expect(isReasonDismissable(reason())).toBe(true);
    expect(isReasonDismissable(reason({ dismissPolicy: 'timed' }))).toBe(true);
    expect(isReasonDismissable(reason({ dismissPolicy: 'none' }))).toBe(false);
    expect(isReasonDismissable(reason({ severity: 'blocker' }))).toBe(false);
    expect(isReasonDismissable(reason({ key: undefined }))).toBe(false);
    expect(isReasonDismissable(reason({ fingerprint: undefined }))).toBe(false);
  });
});
