/**
 * The versioned policy contract.
 *
 * The contract is the only place a policy value is defined, so this file pins
 * the three things a reader depends on: a recorded snapshot round-trips, a row
 * that predates the column reconstructs instead of throwing, and anything
 * present but unreadable fails closed.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLACEMENT_POLICY,
  DEFAULT_ROLLOUT_AUTHORIZATION_POLICY,
  DEFAULT_SOURCE_POLICY,
  LEGACY_FROZEN_POLICY_SNAPSHOT,
  POLICY_CONTRACT_VERSION,
  configuredSnapshotFor,
  decodeApprovalPolicySnapshot,
  decodePolicySnapshot,
  defaultPolicySnapshot,
  encodePolicySnapshot,
  isLegacyPolicySnapshot,
  isPlacementPolicy,
  isRolloutAuthorizationPolicy,
  isSourcePolicy,
  policyValuesEqual,
  type PolicySnapshot,
} from '../services/gitops/policyComposition';

const recorded: PolicySnapshot = {
  version: POLICY_CONTRACT_VERSION,
  source: 'automatic',
  placement: 'bounded_auto',
  rolloutAuthorization: 'automatic',
};

describe('policy guards', () => {
  it('accepts only the three values its own domain defines', () => {
    expect(isSourcePolicy('manual')).toBe(true);
    expect(isSourcePolicy('review')).toBe(true);
    expect(isSourcePolicy('automatic')).toBe(true);
    expect(isSourcePolicy('bounded_auto')).toBe(false);
    expect(isSourcePolicy('enforce')).toBe(false);

    expect(isPlacementPolicy('operator')).toBe(true);
    expect(isPlacementPolicy('bounded_auto')).toBe(true);
    // A placement value is not a source value. Reading one as the other is
    // exactly the confusion this contract exists to prevent.
    expect(isPlacementPolicy('automatic')).toBe(false);
    expect(isPlacementPolicy('manual')).toBe(false);

    expect(isRolloutAuthorizationPolicy('manual')).toBe(true);
    expect(isRolloutAuthorizationPolicy('automatic')).toBe(true);
    expect(isRolloutAuthorizationPolicy('bounded_auto')).toBe(false);
  });

  it('rejects non-strings and missing values', () => {
    for (const guard of [isSourcePolicy, isPlacementPolicy, isRolloutAuthorizationPolicy]) {
      expect(guard(undefined)).toBe(false);
      expect(guard(null)).toBe(false);
      expect(guard(1)).toBe(false);
      expect(guard({})).toBe(false);
    }
  });
});

describe('a recorded snapshot', () => {
  it('round-trips through encode and decode', () => {
    expect(decodePolicySnapshot(encodePolicySnapshot(recorded))).toEqual(recorded);
  });

  it('names a contract version every recorded snapshot carries', () => {
    expect(recorded.version).toBe(POLICY_CONTRACT_VERSION);
    expect(POLICY_CONTRACT_VERSION).toBe(1);
  });
});

describe('a row that predates the column', () => {
  it('reconstructs rather than throwing, and marks itself as reconstructed', () => {
    for (const absent of [null, undefined, '', '   ']) {
      const decoded = decodePolicySnapshot(absent);
      expect(decoded).toEqual(LEGACY_FROZEN_POLICY_SNAPSHOT);
      expect(isLegacyPolicySnapshot(decoded)).toBe(true);
    }
  });

  it('reports automatic rollout authorization, not the fresh-install default', () => {
    // A generation that really did authorize itself on its own must not be
    // reported as though it waited for an operator. That would teach an operator
    // to trust a generation that never asked them.
    expect(LEGACY_FROZEN_POLICY_SNAPSHOT.rolloutAuthorization).toBe('automatic');
    expect(LEGACY_FROZEN_POLICY_SNAPSHOT.rolloutAuthorization).not.toBe(
      DEFAULT_ROLLOUT_AUTHORIZATION_POLICY,
    );
    expect(LEGACY_FROZEN_POLICY_SNAPSHOT.placement).toBe('operator');
  });

  it('is distinguishable from every recorded snapshot by its version', () => {
    expect(isLegacyPolicySnapshot(LEGACY_FROZEN_POLICY_SNAPSHOT)).toBe(true);
    expect(isLegacyPolicySnapshot(recorded)).toBe(false);
    expect(isLegacyPolicySnapshot(defaultPolicySnapshot())).toBe(false);
  });
});

describe('a snapshot that is present but unreadable', () => {
  it('fails closed rather than defaulting to something permissive', () => {
    // An empty object is not a legacy row. The column is nullable and was added
    // without a default, so legacy rows are SQL NULL; an empty object can only
    // have been written by code, and code that wrote it is broken.
    expect(() => decodePolicySnapshot('{}')).toThrow();
  });

  it('refuses a version it does not know', () => {
    expect(() => decodePolicySnapshot(encodePolicySnapshot({ ...recorded, version: 2 }))).toThrow(
      /unknown version/,
    );
    expect(() => decodePolicySnapshot(encodePolicySnapshot({ ...recorded, version: 0 }))).toThrow(
      /unknown version/,
    );
  });

  it('refuses a missing or non-integer version', () => {
    expect(() => decodePolicySnapshot('{"source":"manual","placement":"operator"}')).toThrow(/version/);
    expect(() => decodePolicySnapshot('{"version":1.5}')).toThrow(/version/);
    expect(() => decodePolicySnapshot('{"version":"1"}')).toThrow(/version/);
  });

  it('refuses a missing domain', () => {
    expect(() =>
      decodePolicySnapshot(
        encodePolicySnapshot({ ...recorded, placement: undefined as unknown as PolicySnapshot['placement'] }),
      ),
    ).toThrow();
  });

  it('refuses an unknown value in any domain, naming the domain', () => {
    const corrupt = (field: string, value: unknown) =>
      JSON.stringify({ version: 1, source: 'review', placement: 'operator', rolloutAuthorization: 'manual', [field]: value });

    expect(() => decodePolicySnapshot(corrupt('source', 'rollback'))).toThrow(/source policy/);
    expect(() => decodePolicySnapshot(corrupt('placement', 'bounded'))).toThrow(/placement policy/);
    expect(() => decodePolicySnapshot(corrupt('rolloutAuthorization', 'enforce'))).toThrow(
      /rollout authorization policy/,
    );
  });

  it('refuses a domain that names itself something unknown', () => {
    expect(() => decodePolicySnapshot(corruptWithExtraDomain())).toThrow();
  });

  it('refuses a value that is not an object', () => {
    for (const raw of ['[]', '"operator"', '7', 'null', 'true']) {
      expect(() => decodePolicySnapshot(raw)).toThrow(/not a JSON object/);
    }
  });

  it('refuses text that is not JSON at all', () => {
    expect(() => decodePolicySnapshot('not json')).toThrow();
    expect(() => decodePolicySnapshot('{')).toThrow();
  });
});

describe('the configured snapshot for an application', () => {
  it('reads the three columns as they are', () => {
    expect(
      configuredSnapshotFor({
        source_policy: 'review',
        placement_policy: 'bounded_auto',
        rollout_authorization_policy: 'manual',
      }),
    ).toEqual({
      version: POLICY_CONTRACT_VERSION,
      source: 'review',
      placement: 'bounded_auto',
      rolloutAuthorization: 'manual',
    });
  });

  it('compares by value, not by version', () => {
    // Same three domain values, different versions: the comparison is about what
    // each snapshot authorizes, so these are equal even though one is a
    // reconstruction and the other was recorded.
    const reconstruction: PolicySnapshot = {
      version: 0,
      source: 'automatic',
      placement: 'bounded_auto',
      rolloutAuthorization: 'automatic',
    };
    expect(policyValuesEqual(reconstruction, recorded)).toBe(true);
  });

  it('reports a difference in any single domain', () => {
    expect(policyValuesEqual(recorded, { ...recorded, source: 'manual' })).toBe(false);
    expect(policyValuesEqual(recorded, { ...recorded, placement: 'operator' })).toBe(false);
    expect(policyValuesEqual(recorded, { ...recorded, rolloutAuthorization: 'manual' })).toBe(false);
  });
});

describe('the fresh-install defaults', () => {
  it('require an operator for placement and rollout on a new install', () => {
    const fresh = defaultPolicySnapshot();
    expect(fresh.placement).toBe(DEFAULT_PLACEMENT_POLICY);
    expect(fresh.placement).toBe('operator');
    expect(fresh.rolloutAuthorization).toBe(DEFAULT_ROLLOUT_AUTHORIZATION_POLICY);
    expect(fresh.rolloutAuthorization).toBe('manual');
    expect(fresh.source).toBe(DEFAULT_SOURCE_POLICY);
    expect(fresh.source).toBe('review');
  });

  it('carries the current contract version so a fresh row is never mistaken for a legacy one', () => {
    expect(defaultPolicySnapshot().version).toBe(POLICY_CONTRACT_VERSION);
  });
});

function corruptWithExtraDomain(): string {
  // A domain the contract does not define. Reading it as absent would be
  // interpreting an unrecognized field in an authority record as though it were
  // not there, which is how one policy ends up quietly standing in for another.
  return JSON.stringify({
    version: 1,
    source: 'review',
    placement: 'operator',
    rolloutAuthorization: 'manual',
    runtimeDrift: 'enforce',
  });
}

describe('an approval snapshot', () => {
  it('treats absence as a fact, because no policy decided an operator approval', () => {
    for (const absent of [null, undefined, '', '  ']) {
      expect(decodeApprovalPolicySnapshot(absent)).toBeNull();
    }
  });

  it('still refuses damage rather than reporting no policy', () => {
    expect(() => decodeApprovalPolicySnapshot('{}')).toThrow();
    expect(decodeApprovalPolicySnapshot(encodePolicySnapshot(recorded))).toEqual(recorded);
  });
});
