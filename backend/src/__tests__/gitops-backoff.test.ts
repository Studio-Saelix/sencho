/**
 * Failure classification and retry-delay coverage for the GitOps source
 * controller. classifyFailure is a compile-enforced total map: adding a new
 * TransportFailureReason or GitSourceErrorCode without updating the lookup
 * tables here fails the build, not just these tests.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyFailure,
  nextRetryAt,
  DEFAULT_TRANSIENT_CEILING,
  LOW_TRANSIENT_CEILING,
  type FailureEvidence,
} from '../services/gitops/backoff';

function gitSourceError(code: string, transportReason?: string): FailureEvidence {
  return { kind: 'git_source_error', code: code as never, transportReason: transportReason as never };
}

describe('classifyFailure', () => {
  it('classifies a tip-changed race as supersession, not backoff', () => {
    expect(classifyFailure(gitSourceError('GIT_ERROR', 'tip-changed'))).toEqual({ class: 'supersession' });
  });

  it('classifies a standalone timeout reason as transient', () => {
    expect(classifyFailure(gitSourceError('NETWORK_TIMEOUT', 'timeout')))
      .toEqual({ class: 'transient', retryCeiling: DEFAULT_TRANSIENT_CEILING });
  });

  it('classifies DNS resolution failure (target-unresolved) as transient', () => {
    expect(classifyFailure(gitSourceError('NETWORK_TIMEOUT', 'target-unresolved')))
      .toEqual({ class: 'transient', retryCeiling: DEFAULT_TRANSIENT_CEILING });
  });

  it('classifies an exit-coded network timeout as transient', () => {
    expect(classifyFailure(gitSourceError('NETWORK_TIMEOUT', 'exit')))
      .toEqual({ class: 'transient', retryCeiling: DEFAULT_TRANSIENT_CEILING });
  });

  it('classifies an exit-coded rate limit as transient', () => {
    expect(classifyFailure(gitSourceError('RATE_LIMITED', 'exit')))
      .toEqual({ class: 'transient', retryCeiling: DEFAULT_TRANSIENT_CEILING });
  });

  it('classifies an exit-coded unrecognized git error with a low retry ceiling', () => {
    expect(classifyFailure(gitSourceError('GIT_ERROR', 'exit')))
      .toEqual({ class: 'transient', retryCeiling: LOW_TRANSIENT_CEILING });
  });

  it.each(['invalid-url', 'unsafe-target', 'invalid-ref', 'redirect-scope'])(
    'classifies %s as permanent configuration',
    (reason) => {
      expect(classifyFailure(gitSourceError('GIT_ERROR', reason))).toEqual({ class: 'permanent' });
    },
  );

  it.each(['git-missing', 'git-old'])('classifies %s as permanent environment', (reason) => {
    expect(classifyFailure(gitSourceError('GIT_ERROR', reason))).toEqual({ class: 'permanent' });
  });

  it('classifies a repository over the size cap as permanent', () => {
    expect(classifyFailure(gitSourceError('GIT_ERROR', 'size'))).toEqual({ class: 'permanent' });
  });

  it.each(['ssh-auth-required'])('classifies %s as permanent authorization', (reason) => {
    expect(classifyFailure(gitSourceError('GIT_ERROR', reason))).toEqual({ class: 'permanent' });
  });

  it.each(['AUTH_FAILED', 'SSH_HOST_KEY_FAILED'])('classifies %s (no transport reason) as permanent', (code) => {
    expect(classifyFailure(gitSourceError(code))).toEqual({ class: 'permanent' });
  });

  it.each(['ref-not-found', 'unsupported-ref'])('classifies %s as permanent configuration', (reason) => {
    expect(classifyFailure(gitSourceError('GIT_ERROR', reason))).toEqual({ class: 'permanent' });
  });

  it.each(['REPO_NOT_FOUND', 'REF_NOT_FOUND', 'REF_DELETED', 'UNSUPPORTED_REF'])(
    'classifies %s (no transport reason) as permanent',
    (code) => {
      expect(classifyFailure(gitSourceError(code))).toEqual({ class: 'permanent' });
    },
  );

  it.each(['STALE_PLAN', 'PLAN_BLOCKED', 'PLAN_FINGERPRINT_REQUIRED', 'LEGACY_PENDING', 'PLAN_UNAVAILABLE', 'FILE_NOT_FOUND'])(
    'classifies %s as requiring operator action',
    (code) => {
      expect(classifyFailure(gitSourceError(code))).toEqual({ class: 'operator_action_required' });
    },
  );

  it('classifies a conflicting in-flight operation for reconciliation, not blind retry', () => {
    expect(classifyFailure(gitSourceError('OPERATION_IN_FLIGHT'))).toEqual({ class: 'reconcile' });
  });

  it('classifies an unavailable policy scanner as degraded', () => {
    expect(classifyFailure({ kind: 'policy_unavailable' })).toEqual({ class: 'degraded' });
  });

  it('classifies unavailable persistence as transient with no source-stage progress', () => {
    expect(classifyFailure({ kind: 'persistence_unavailable' }))
      .toEqual({ class: 'transient', retryCeiling: DEFAULT_TRANSIENT_CEILING });
  });

  it('classifies an invalid target binding as permanent at the target level', () => {
    expect(classifyFailure({ kind: 'target_binding_invalid' })).toEqual({ class: 'target_permanent' });
  });

  it('classifies a temporarily unavailable target as transient at the target level', () => {
    expect(classifyFailure({ kind: 'target_unavailable' })).toEqual({ class: 'target_transient' });
  });

  it('classifies a deploy/health failure after a successful apply as its own class, never refetch or reapply', () => {
    expect(classifyFailure({ kind: 'target_mutation_failed' })).toEqual({ class: 'target_mutation_failed' });
  });

  it('classifies unavailable Blueprint evaluation as blocked, not retried', () => {
    expect(classifyFailure({ kind: 'blueprint_unavailable' })).toEqual({ class: 'blocked' });
  });

  it('classifies an interrupted or unknown-completion operation for reconciliation', () => {
    expect(classifyFailure({ kind: 'interrupted' })).toEqual({ class: 'reconcile' });
  });
});

describe('nextRetryAt', () => {
  it('computes the base delay with up to +-10% jitter on the first attempt', () => {
    const now = 1_000_000;
    const at = nextRetryAt(now, 0);
    expect(at).toBeGreaterThanOrEqual(now + 54_000);
    expect(at).toBeLessThanOrEqual(now + 66_000);
  });

  it('doubles the delay per retry count', () => {
    const now = 1_000_000;
    const at = nextRetryAt(now, 3); // 60s * 2^3 = 480s
    expect(at).toBeGreaterThanOrEqual(now + 432_000);
    expect(at).toBeLessThanOrEqual(now + 528_000);
  });

  it('caps the delay at one hour regardless of retry count', () => {
    const now = 1_000_000;
    const at = nextRetryAt(now, 20);
    expect(at).toBeLessThanOrEqual(now + 3_600_000 * 1.1);
  });

  it('honors a provider retry floor larger than the computed delay', () => {
    const now = 1_000_000;
    const at = nextRetryAt(now, 0, 10_000_000);
    expect(at).toBe(now + 10_000_000);
  });

  it('ignores a provider retry floor smaller than the computed delay', () => {
    const now = 1_000_000;
    const at = nextRetryAt(now, 5, 1_000);
    expect(at).toBeGreaterThan(now + 1_000);
  });
});
