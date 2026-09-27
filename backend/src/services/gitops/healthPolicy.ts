import { decodeGitOpsJson, encodeGitOpsJson, isRecord } from './json';

/**
 * How a rollout reacts to a per-target health outcome.
 *
 * `observe` records outcomes and never gates advancement, so it is the safe
 * default and the behavior every rollout had before this policy existed. The
 * other four gate advancement, and each is opt-in because three of them can
 * restore or stop work across a fleet.
 *
 * The modes never rewrite source, placement, or artifact authority. A health
 * outcome selects what happens to the *rollout queue*, nothing else.
 */
export const HEALTH_ROLLOUT_POLICIES = ['observe', 'pause', 'retry_once', 'stop', 'rollback'] as const;

export type HealthRolloutPolicy = (typeof HEALTH_ROLLOUT_POLICIES)[number];

export const DEFAULT_HEALTH_ROLLOUT_POLICY: HealthRolloutPolicy = 'observe';

/** Whether a mode gates advancement. `observe` never does, so it never needs a capability. */
export function gatesAdvancement(policy: HealthRolloutPolicy): boolean {
  return policy !== 'observe';
}

export function isHealthRolloutPolicy(value: unknown): value is HealthRolloutPolicy {
  return typeof value === 'string' && (HEALTH_ROLLOUT_POLICIES as readonly string[]).includes(value);
}

/**
 * The rollout strategy frozen with a rollout generation.
 *
 * `driftMode` and `enabled` are the Blueprint runtime pair that predates this
 * policy. `healthPolicy` is added to the same envelope rather than a new column
 * so one authority record carries the whole strategy a rollout was authorized
 * under.
 *
 * A generation written before health policy existed has no `healthPolicy` key.
 * That decodes to `observe`, which is what those rollouts actually did.
 */
export type FrozenRolloutStrategy = {
  healthPolicy: HealthRolloutPolicy;
  driftMode: string | null;
  enabled: boolean | null;
};

/**
 * Read the frozen strategy off a rollout generation.
 *
 * Unknown keys are dropped rather than carried: a strategy row is an authority
 * record, and an unrecognized field in it must not become executable intent.
 *
 * Throws on a present-but-unusable `healthPolicy`, because a rollout whose
 * policy cannot be read must block rather than fall back to a mode that moves
 * the fleet. A row that predates the key is not that case and reads `observe`.
 */
export function decodeFrozenRolloutStrategy(raw: string | null | undefined): FrozenRolloutStrategy {
  if (raw == null || raw.trim() === '') {
    return { healthPolicy: DEFAULT_HEALTH_ROLLOUT_POLICY, driftMode: null, enabled: null };
  }
  const decoded = decodeGitOpsJson(raw);
  if (!isRecord(decoded)) {
    throw new Error('The rollout strategy is not a JSON object.');
  }
  const policy = decoded.healthPolicy;
  if (policy === undefined) {
    // A row that predates the key, which is the one case that reads `observe`.
    return {
      healthPolicy: DEFAULT_HEALTH_ROLLOUT_POLICY,
      driftMode: typeof decoded.driftMode === 'string' ? decoded.driftMode : null,
      enabled: typeof decoded.enabled === 'boolean' ? decoded.enabled : null,
    };
  }
  if (policy === null) {
    // The key is present and says nothing. That is a rollout that claims to have
    // a policy and does not, not a legacy row, and reading it as `observe` would
    // run a fleet-wide rollout ungated on the strength of a null.
    throw new Error('The rollout strategy names a health policy that is null.');
  }
  if (!isHealthRolloutPolicy(policy)) {
    throw new Error(`The rollout strategy names an unknown health policy: ${String(policy)}`);
  }
  return {
    healthPolicy: policy,
    driftMode: typeof decoded.driftMode === 'string' ? decoded.driftMode : null,
    enabled: typeof decoded.enabled === 'boolean' ? decoded.enabled : null,
  };
}

export function encodeFrozenRolloutStrategy(input: {
  healthPolicy: HealthRolloutPolicy;
  driftMode: string | null;
  enabled: boolean | null;
}): string {
  return encodeGitOpsJson({
    healthPolicy: input.healthPolicy,
    driftMode: input.driftMode,
    enabled: input.enabled,
  });
}

/**
 * The health policy as the operator selected it on an intent revision.
 *
 * `health_failure_rollback_policy_json` was reserved by the policy-composition
 * work and written as null. It now holds `{ policy }`, and a null column means
 * the operator has not chosen, which is `observe`. An unreadable or unknown
 * value is an error: the write path validates, so a bad value here means the
 * row was corrupted and guessing a policy from it could move a fleet.
 */
export function decodeIntentHealthPolicy(raw: string | null | undefined): HealthRolloutPolicy {
  if (raw == null || raw.trim() === '') return DEFAULT_HEALTH_ROLLOUT_POLICY;
  const decoded = decodeGitOpsJson(raw);
  if (!isRecord(decoded)) {
    throw new Error('The health policy is not a JSON object.');
  }
  const policy = decoded.policy;
  if (policy === undefined || policy === null) return DEFAULT_HEALTH_ROLLOUT_POLICY;
  if (!isHealthRolloutPolicy(policy)) {
    throw new Error(`The health policy names an unknown mode: ${String(policy)}`);
  }
  return policy;
}

export function encodeIntentHealthPolicy(policy: HealthRolloutPolicy): string {
  return encodeGitOpsJson({ policy });
}

/**
 * The health policy a newly minted intent revision should carry.
 *
 * The operator's choice is intent authority, so a new intent revision has to
 * carry it forward. Writing null instead would silently reset the policy to
 * observe every time a Blueprint's intent is rewritten for an unrelated reason,
 * so a rollout an operator had set to pause would quietly stop pausing.
 *
 * The stored value is copied verbatim rather than decoded and re-encoded: the
 * column is the authority record, and rewriting an operator's selection through
 * a decode that could throw would make an intent mint fail on data it is only
 * copying.
 */
export function carriedHealthPolicyJson(
  previous: { health_failure_rollback_policy_json: string | null } | undefined,
): string | null {
  return previous?.health_failure_rollback_policy_json ?? null;
}

/**
 * What a health verdict does to the rollout queue.
 *
 * `advance` is the only outcome that hands the queue back to the executor. The
 * rest are terminal for this attempt: the operator resumes, or a later
 * reconciliation picks the target up.
 */
export type HealthRolloutAction =
  | 'none'
  | 'advance'
  | 'retry'
  | 'pause'
  | 'stop'
  | 'rollback';

export type HealthVerdict = 'passed' | 'failed' | 'unknown';

/**
 * A closed reason class. No free-form payload, so nothing sensitive lands in a
 * history row.
 *
 * Split by whether the reason is a fence, because only a decision that actually
 * stops the rollout writes one: `advance` clears it and `none` writes nothing at
 * all. Keeping the non-fence reasons in their own union makes it a type error
 * for the caller to write a reason the target column does not accept, rather
 * than a constraint violation at write time.
 */
export type HealthFenceReason =
  | 'health_passed'
  | 'health_failed'
  | 'health_unknown'
  | 'health_retried'
  | 'health_retry_exhausted'
  | 'rollout_stopped'
  | 'rollback_unavailable';

export type HealthPolicyDecision =
  | { action: 'advance'; reason: 'health_passed' }
  | { action: 'retry'; reason: 'health_retried' }
  | { action: 'pause' | 'stop' | 'rollback'; reason: HealthFenceReason }
  | { action: 'none'; reason: 'health_policy_observe' };

/**
 * Decide what a verdict does, from the policy frozen into the rollout
 * generation.
 *
 * Two invariants hold for every mode, and they are the reason this is a pure
 * function rather than a branch at the call site:
 *
 *  - `unknown` never triggers retry, stop, or rollback. A gate reports
 *    `unknown` for benign conditions (a healthcheck still starting, a newer
 *    operation superseding the run, a restart mid-observation, evidence that
 *    never arrived). Treating any of those as failure would destroy a healthy
 *    workload on missing evidence.
 *  - `rollback` needs a recovery point. Without one the honest answer is
 *    `recovery_required`, surfaced by the caller through the existing facet,
 *    never an unverified restore.
 *
 * `attemptsUsed` is how many times this target has already been retried under
 * this rollout generation, so `retry_once` is exactly once per target and
 * generation without any remembered flag.
 */
export function decideHealthRolloutAction(args: {
  policy: HealthRolloutPolicy;
  verdict: HealthVerdict;
  attemptsUsed: number;
  /** Whether the target still has the pre-rollout generation captured. */
  recoveryAvailable: boolean;
}): HealthPolicyDecision {
  const { policy, verdict, attemptsUsed, recoveryAvailable } = args;
  if (!gatesAdvancement(policy)) {
    return { action: 'none', reason: 'health_policy_observe' };
  }
  if (verdict === 'passed') {
    return { action: 'advance', reason: 'health_passed' };
  }
  if (verdict === 'unknown') {
    return { action: 'pause', reason: 'health_unknown' };
  }
  switch (policy) {
    case 'pause':
      return { action: 'pause', reason: 'health_failed' };
    case 'retry_once':
      if (attemptsUsed < 1) return { action: 'retry', reason: 'health_retried' };
      return { action: 'pause', reason: 'health_retry_exhausted' };
    case 'stop':
      return { action: 'stop', reason: 'rollout_stopped' };
    case 'rollback':
      if (!recoveryAvailable) return { action: 'pause', reason: 'rollback_unavailable' };
      return { action: 'rollback', reason: 'health_failed' };
    default:
      return { action: 'none', reason: 'health_policy_observe' };
  }
}
