import type { GitSourceErrorCode } from '../GitSourceService';
import type { TransportFailureReason } from '../git/errors';

/**
 * Everything a controller attempt can fail with. `git_source_error` covers
 * every GitSourceError the fetch/apply path can throw, transport-classified
 * or not. The remaining kinds cover dispatch-stage failures that have no
 * GitSourceError at all (target binding, target availability, a deploy or
 * health failure after a successful apply, Blueprint evaluation, and an
 * interrupted or unknown-completion operation).
 */
export type FailureEvidence =
  | { kind: 'git_source_error'; code: GitSourceErrorCode; transportReason?: TransportFailureReason }
  | { kind: 'policy_unavailable' }
  | { kind: 'persistence_unavailable' }
  | { kind: 'target_binding_invalid' }
  | { kind: 'target_unavailable' }
  | { kind: 'target_mutation_failed' }
  | { kind: 'blueprint_unavailable' }
  | { kind: 'interrupted' };

export type FailureDisposition =
  /** A newer revision replaced the one being worked on; re-resolve, not backoff. */
  | { class: 'supersession' }
  /** Retryable. retryCeiling bounds how many attempts before it escalates to permanent. */
  | { class: 'transient'; retryCeiling: number }
  /** Will never succeed by retrying; needs a configuration, environment, or credential change. */
  | { class: 'permanent' }
  /** A human decision is required (review a plan, resolve a conflict); not retried automatically. */
  | { class: 'operator_action_required' }
  /** Evidence could not be produced (e.g. scanner unavailable); held for review, not retried blind. */
  | { class: 'degraded' }
  /** The target itself will never accept this generation without a configuration change. */
  | { class: 'target_permanent' }
  /** The target is temporarily unreachable; retryable at the target/dispatch stage only. */
  | { class: 'target_transient' }
  /** Applied but deploy or health failed: never refetch or reapply, only redeploy. */
  | { class: 'target_mutation_failed' }
  /** Blocked pending a capability this program does not yet provide (e.g. Blueprint rollout). */
  | { class: 'blocked' }
  /** Ambiguous or interrupted; reconcile from durable state, never blind retry. */
  | { class: 'reconcile' };

export const DEFAULT_TRANSIENT_CEILING = 8;
export const LOW_TRANSIENT_CEILING = 3;

const TRANSIENT_DEFAULT: FailureDisposition = { class: 'transient', retryCeiling: DEFAULT_TRANSIENT_CEILING };
const TRANSIENT_LOW: FailureDisposition = { class: 'transient', retryCeiling: LOW_TRANSIENT_CEILING };
const PERMANENT: FailureDisposition = { class: 'permanent' };

/**
 * Total over every TransportFailureReason except `exit`, which is generic
 * and needs the classified GitSourceErrorCode (see CODE_DISPOSITION) to
 * tell a transient network condition from a rate limit from an
 * unrecognized error. Adding a new reason to the source union without
 * adding it here fails the build.
 */
const REASON_DISPOSITION: Record<Exclude<TransportFailureReason, 'exit'>, FailureDisposition> = {
  'tip-changed': { class: 'supersession' },
  timeout: TRANSIENT_DEFAULT,
  'target-unresolved': TRANSIENT_DEFAULT,
  'invalid-url': PERMANENT,
  'unsafe-target': PERMANENT,
  'invalid-ref': PERMANENT,
  'redirect-scope': PERMANENT,
  'git-missing': PERMANENT,
  'git-old': PERMANENT,
  size: PERMANENT,
  'ssh-auth-required': PERMANENT,
  'ref-not-found': PERMANENT,
  'unsupported-ref': PERMANENT,
};

/**
 * Total over every GitSourceErrorCode. Used directly when there is no
 * transport reason (a plan/validation/file/operation-conflict error), and
 * as the exit-reason fallback (RATE_LIMITED, NETWORK_TIMEOUT, and GIT_ERROR
 * only ever arise from an `exit` transport reason). Adding a new code
 * without adding it here fails the build.
 */
const CODE_DISPOSITION: Record<GitSourceErrorCode, FailureDisposition> = {
  REPO_NOT_FOUND: PERMANENT,
  AUTH_FAILED: PERMANENT,
  REF_NOT_FOUND: PERMANENT,
  REF_DELETED: PERMANENT,
  UNSUPPORTED_REF: PERMANENT,
  SSH_HOST_KEY_FAILED: PERMANENT,
  FILE_NOT_FOUND: { class: 'operator_action_required' },
  RATE_LIMITED: TRANSIENT_DEFAULT,
  NETWORK_TIMEOUT: TRANSIENT_DEFAULT,
  GIT_ERROR: TRANSIENT_LOW,
  STALE_PLAN: { class: 'operator_action_required' },
  PLAN_FINGERPRINT_REQUIRED: { class: 'operator_action_required' },
  PLAN_BLOCKED: { class: 'operator_action_required' },
  LEGACY_PENDING: { class: 'operator_action_required' },
  PLAN_UNAVAILABLE: { class: 'operator_action_required' },
  OPERATION_IN_FLIGHT: { class: 'reconcile' },
};

export function classifyFailure(evidence: FailureEvidence): FailureDisposition {
  switch (evidence.kind) {
    case 'git_source_error':
      if (evidence.transportReason && evidence.transportReason !== 'exit') {
        return REASON_DISPOSITION[evidence.transportReason];
      }
      return CODE_DISPOSITION[evidence.code];
    case 'policy_unavailable':
      return { class: 'degraded' };
    case 'persistence_unavailable':
      return TRANSIENT_DEFAULT;
    case 'target_binding_invalid':
      return { class: 'target_permanent' };
    case 'target_unavailable':
      return { class: 'target_transient' };
    case 'target_mutation_failed':
      return { class: 'target_mutation_failed' };
    case 'blueprint_unavailable':
      return { class: 'blocked' };
    case 'interrupted':
      return { class: 'reconcile' };
  }
}

const BASE_DELAY_MS = 60_000;
const MAX_DELAY_MS = 3_600_000;
const JITTER_RATIO = 0.1;

/**
 * Bounded exponential backoff with jitter: 60s * 2^retryCount, capped at one
 * hour, with up to +-10% jitter so many sources retrying at once do not
 * all land on the same second. A provider-supplied retry floor (e.g. a
 * rate-limit Retry-After) takes precedence whenever it is larger than the
 * computed delay.
 */
export function nextRetryAt(now: number, retryCount: number, providerFloorMs?: number): number {
  const capped = Math.min(BASE_DELAY_MS * 2 ** retryCount, MAX_DELAY_MS);
  const jittered = capped + capped * JITTER_RATIO * (Math.random() * 2 - 1);
  const delay = providerFloorMs !== undefined ? Math.max(jittered, providerFloorMs) : jittered;
  return now + delay;
}
