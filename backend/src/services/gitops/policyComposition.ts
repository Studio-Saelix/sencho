import { decodeGitOpsJson, encodeGitOpsJson, isFiniteInteger, isRecord } from './json';
import type { SourcePolicy } from './types';

/**
 * The authority policy contract, versioned and closed.
 *
 * Three domains, one contract, one version. A policy may only ever authorize an
 * action inside its own domain, and this module is where that separation is
 * named: source acceptance, placement approval, and rollout authorization each
 * carry their own value here, so no reader can reach a single value that looks
 * like it covers all three.
 *
 * The snapshot is the unit of provenance. Every decision record names the
 * snapshot that decided it, and every rollout freezes the snapshot it executes,
 * so a policy that changed mid-flight cannot be mistaken for the one that ran.
 *
 * Nothing here carries source content, credentials, secret names, or secret
 * values. Safe identities and closed reason classes only.
 */

/**
 * Bumped only when the shape changes incompatibly.
 *
 * A reader that finds a version it does not know must refuse rather than
 * interpret, which is why the decoder throws on an unknown version instead of
 * defaulting it.
 */
export const POLICY_CONTRACT_VERSION = 1;

/** Source acceptance of a new Git application generation. */
export const SOURCE_POLICIES = ['manual', 'review', 'automatic'] as const;

/**
 * Fresh-install default for source.
 *
 * `review` rather than `manual` because a fresh install still needs to fetch to
 * show a diff at all; `manual` is for an operator who has turned even that off.
 */
export const DEFAULT_SOURCE_POLICY: SourcePolicy = 'review';

/** Whether a change in Blueprint target intent needs an operator. */
export const PLACEMENT_POLICIES = ['operator', 'bounded_auto'] as const;
export type PlacementPolicy = (typeof PLACEMENT_POLICIES)[number];

/**
 * Fresh-install default for placement.
 *
 * `operator` is the only safe default: automatic placement moves workloads on
 * nodes, and an install that has never asked to be automated must not start.
 */
export const DEFAULT_PLACEMENT_POLICY: PlacementPolicy = 'operator';

/** Whether rollout authorization is minted by policy or waits for an operator. */
export const ROLLOUT_AUTHORIZATION_POLICIES = ['manual', 'automatic'] as const;
export type RolloutAuthorizationPolicy = (typeof ROLLOUT_AUTHORIZATION_POLICIES)[number];

/**
 * Fresh-install default for rollout authorization.
 *
 * `manual`. An install that has no rollout history has no evidence that any
 * target can actually take the generation, so it waits for an operator. Existing
 * installs are a separate case: see `LEGACY_FROZEN_POLICY_SNAPSHOT`.
 *
 * **What this means after the upgrade, stated so it is not a surprise.**
 *
 * The one-time backfill restores `automatic` for the live Blueprint applications
 * that already authorized their own rollouts, which is the only class that had
 * that behavior before the column existed. Everything created afterwards gets
 * `manual`, including:
 *
 * - a Blueprint adopted or converted after the upgrade;
 * - an application converted back and converted forward again;
 * - any row written by an older binary during a downgrade and read back after a
 *   re-upgrade, since the marker means the backfill will not run a second time.
 *
 * That is a real change of behavior for those applications, and it is the safe
 * direction: they never had evidence that a target could take a generation, so
 * waiting for an operator costs one review. An operator who wants the old
 * behavior sets the policy on the application, and the control is beside the
 * rollout authorization action it governs.
 */
export const DEFAULT_ROLLOUT_AUTHORIZATION_POLICY: RolloutAuthorizationPolicy = 'manual';

export const POLICY_DOMAINS = ['source', 'placement', 'rollout_authorization'] as const;
export type PolicyDomain = (typeof POLICY_DOMAINS)[number];

export type PolicySnapshot = {
  version: number;
  source: SourcePolicy;
  placement: PlacementPolicy;
  rolloutAuthorization: RolloutAuthorizationPolicy;
};

export function isSourcePolicy(value: unknown): value is SourcePolicy {
  return typeof value === 'string' && (SOURCE_POLICIES as readonly string[]).includes(value);
}

export function isPlacementPolicy(value: unknown): value is PlacementPolicy {
  return typeof value === 'string' && (PLACEMENT_POLICIES as readonly string[]).includes(value);
}

export function isRolloutAuthorizationPolicy(value: unknown): value is RolloutAuthorizationPolicy {
  return typeof value === 'string' && (ROLLOUT_AUTHORIZATION_POLICIES as readonly string[]).includes(value);
}

/**
 * What a rollout generation that predates policy snapshots actually ran under.
 *
 * Placement was always operator-approved, because automatic placement did not
 * exist. Rollout authorization was automatic for Blueprint applications, because
 * that is what the acceptance handoff already did on its own.
 *
 * This is deliberately not the fresh-install default. A generation that really
 * did authorize itself must not be reported as though it waited for an operator,
 * and reporting it that way would be the more dangerous of the two errors: it
 * would teach an operator to trust a generation that never asked them.
 *
 * Version 0 is what marks this as a reconstruction. No recorded snapshot carries
 * it, so a reader can always tell a reconstruction from a real one.
 */
export const LEGACY_FROZEN_POLICY_SNAPSHOT: PolicySnapshot = {
  version: 0,
  source: DEFAULT_SOURCE_POLICY,
  placement: DEFAULT_PLACEMENT_POLICY,
  rolloutAuthorization: 'automatic',
};

/** The snapshot a fresh application, or a row written before this module, reads as. */
export function defaultPolicySnapshot(): PolicySnapshot {
  return {
    version: POLICY_CONTRACT_VERSION,
    source: DEFAULT_SOURCE_POLICY,
    placement: DEFAULT_PLACEMENT_POLICY,
    rolloutAuthorization: DEFAULT_ROLLOUT_AUTHORIZATION_POLICY,
  };
}

export function encodePolicySnapshot(snapshot: PolicySnapshot): string {
  return encodeGitOpsJson({
    version: snapshot.version,
    source: snapshot.source,
    placement: snapshot.placement,
    rolloutAuthorization: snapshot.rolloutAuthorization,
  });
}

/**
 * The keys a snapshot may carry. A closed set, so an unrecognized one is a
 * disagreement about what governs rather than a field to ignore.
 */
const SNAPSHOT_KEYS: ReadonlySet<string> = new Set(['version', 'source', 'placement', 'rolloutAuthorization']);

/**
 * Refuse a snapshot carrying a key this contract does not define.
 *
 * `decodeFrozenRolloutStrategy` drops unknown keys, and for a rollout strategy
 * that is right: an extra field must not become executable intent, and refusing
 * to read the whole envelope over one unrecognized key would take down a
 * decision for a field that was never going to act.
 *
 * A policy snapshot is the other case. A fourth key here means the writer
 * believed some policy belonged to this contract, and a reader that quietly
 * dropped it would report a snapshot with that domain missing and let an operator
 * conclude nothing was configured for it. That is one policy domain silently
 * standing in for another, which is the whole failure this contract exists to
 * prevent. So an unrecognized key makes the snapshot unreadable rather than
 * quietly partial.
 */
function assertNoUnrecognizedKeys(decoded: Record<string, unknown>): void {
  for (const key of Object.keys(decoded)) {
    if (!SNAPSHOT_KEYS.has(key)) {
      throw new Error(`The policy snapshot names an unrecognized key: ${key}`);
    }
  }
}

/**
 * Read a recorded snapshot.
 *
 * `null` and blank are a row that predates the column, which is the one case
 * that reconstructs rather than throws. Everything else that cannot be read is
 * an error, because a decision record that claims a policy and cannot name it
 * must not be interpreted as a permissive one.
 *
 * Throws, rather than defaulting, on a present-but-unusable value: a wrong
 * version, a missing domain, an unknown domain value, an unrecognized key, or a
 * value that is not an object. `{}` is in that set on purpose. A nullable column
 * added without a default leaves legacy rows as SQL NULL, so an empty object can
 * only have been written by code, and code that wrote it is broken.
 */
export function decodePolicySnapshot(raw: string | null | undefined): PolicySnapshot {
  if (raw == null || raw.trim() === '') {
    return LEGACY_FROZEN_POLICY_SNAPSHOT;
  }
  const decoded = decodeGitOpsJson(raw);
  if (!isRecord(decoded)) {
    throw new Error('The policy snapshot is not a JSON object.');
  }
  assertNoUnrecognizedKeys(decoded);
  if (!isFiniteInteger(decoded.version)) {
    throw new Error('The policy snapshot does not name a version.');
  }
  if (decoded.version !== POLICY_CONTRACT_VERSION) {
    throw new Error(`The policy snapshot names an unknown version: ${String(decoded.version)}`);
  }
  if (!isSourcePolicy(decoded.source)) {
    throw new Error(`The policy snapshot names an unknown source policy: ${String(decoded.source)}`);
  }
  if (!isPlacementPolicy(decoded.placement)) {
    throw new Error(`The policy snapshot names an unknown placement policy: ${String(decoded.placement)}`);
  }
  if (!isRolloutAuthorizationPolicy(decoded.rolloutAuthorization)) {
    throw new Error(
      `The policy snapshot names an unknown rollout authorization policy: ${String(decoded.rolloutAuthorization)}`,
    );
  }
  return {
    version: decoded.version,
    source: decoded.source,
    placement: decoded.placement,
    rolloutAuthorization: decoded.rolloutAuthorization,
  };
}

/**
 * Read a recorded snapshot as stored on an approval, where absence is a fact.
 *
 * An approval written by an operator carries no policy snapshot, because no
 * policy decided it. That is not the same as an unreadable snapshot, which is an
 * error, so this returns `null` for absence and still throws for damage.
 */

/** Whether a snapshot was reconstructed rather than recorded. */
/**
 * The snapshot an approval carries, or null when it carries none.
 *
 * Distinct from `decodePolicySnapshot` in what absence means. A generation with
 * no snapshot predates the policy contract, and reading that as the legacy
 * defaults preserves the behavior it was authorized under. An approval with no
 * snapshot is a different fact: an operator approval records none, because no
 * policy decided it, and reconstructing the legacy policy there would claim a
 * policy governed a decision it did not make.
 */
export function decodeApprovalPolicySnapshot(raw: string | null | undefined): PolicySnapshot | null {
  if (raw == null || raw.trim() === '') return null;
  return decodePolicySnapshot(raw);
}

export function isLegacyPolicySnapshot(snapshot: PolicySnapshot): boolean {
  return snapshot.version === LEGACY_FROZEN_POLICY_SNAPSHOT.version;
}

/**
 * The configured snapshot for an application row.
 *
 * Reads the three columns as they are. A column holding a value outside its own
 * union cannot reach here, because every write path validates first and the
 * schema carries a CHECK, so this does not re-validate: doing so would be a
 * second answer to a question the database already refused.
 */
export function configuredSnapshotFor(app: {
  source_policy: SourcePolicy;
  placement_policy: PlacementPolicy;
  rollout_authorization_policy: RolloutAuthorizationPolicy;
}): PolicySnapshot {
  return {
    version: POLICY_CONTRACT_VERSION,
    source: app.source_policy,
    placement: app.placement_policy,
    rolloutAuthorization: app.rollout_authorization_policy,
  };
}

/** Whether two snapshots authorize identically, ignoring the contract version. */
export function policyValuesEqual(a: PolicySnapshot, b: PolicySnapshot): boolean {
  return (
    a.source === b.source && a.placement === b.placement && a.rolloutAuthorization === b.rolloutAuthorization
  );
}
