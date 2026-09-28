/**
 * What each authority policy reports, and what it refuses to report.
 *
 * Every case here is about a claim the projection must not make. The dangerous
 * one is `effectiveFrozen`: work in flight is decided under the policy frozen
 * when it opened, so reporting today's configuration as what ran yesterday's
 * rollout is a false statement about who authorized work, and it is the kind a
 * reader has no way to catch.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { directApplicationFixture } from './helpers/gitopsFixtures';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions } from '../services/gitops/transitions';
import { authorityPolicyReads } from '../services/gitops/authorityPolicyProjection';
import {
  DEFAULT_PLACEMENT_POLICY,
  encodePolicySnapshot,
  type PlacementPolicy,
  type RolloutAuthorizationPolicy,
} from '../services/gitops/policyComposition';
import { encodeGitOpsRequiredTargetsJson } from '../services/gitops/json';
import type {
  GitOpsApplicationRow,
  GitOpsApprovalRow,
  PlacementFacet,
  RolloutFacet,
  SourceFacet,
  SourcePolicy,
} from '../services/gitops/types';

const PENDING_FACETS = {
  source: { status: 'never_reconciled' } as SourceFacet,
  placement: { status: 'placement_review_pending' } as PlacementFacet,
  rollout: { status: 'rollout_not_executable', rolloutCandidateId: 'cand-1' } as RolloutFacet,
};

const SETTLED_FACETS = {
  source: { status: 'never_reconciled' } as SourceFacet,
  placement: { status: 'blueprint_bound', completion: 'unknown' } as PlacementFacet,
  rollout: { status: 'rollout_queued', rolloutGenerationId: 'rgen-1' } as RolloutFacet,
};

let tmpDir: string;

function seedApp(overrides: {
  source_policy?: SourcePolicy;
  placement_policy?: PlacementPolicy;
  rollout_authorization_policy?: RolloutAuthorizationPolicy;
} = {}): GitOpsApplicationRow {
  const id = `app-${randomUUID().slice(0, 8)}`;
  const store = GitOpsStore.getInstance();
  store.insertApplication({ ...directApplicationFixture(id, `src-${id}`), ...overrides });
  return store.getApplication(id)!;
}

function read(domain: 'source' | 'placement' | 'rollout_authorization', app: GitOpsApplicationRow) {
  const found = authorityPolicyReads(app, PENDING_FACETS).find((entry) => entry.domain === domain);
  if (!found) throw new Error(`no read for ${domain}`);
  return found;
}

/**
 * The minimum an approval of each kind must carry to satisfy the table's own
 * checks, which is how a real one is shaped. The reads under test look only at
 * `kind`, `authority` and `created_at`, so anything less would be testing a row
 * the database refuses to hold.
 */
function insertApproval(
  overrides: Partial<GitOpsApprovalRow> & Pick<GitOpsApprovalRow, 'kind' | 'authority'>,
): string {
  const minimum: Record<GitOpsApprovalRow['kind'], Partial<GitOpsApprovalRow>> = {
    source_acceptance: { generation_id: 'gen-1' },
    placement_approval: { intent_revision_id: 'intent-1', blast_json: '[]' },
    rollout_authorization: {
      generation_id: 'gen-1',
      artifact_set_id: 'art-1',
      intent_revision_id: 'intent-1',
      rollout_candidate_id: 'cand-1',
      source_acceptance_ref: 'appr-source',
      placement_approval_ref: 'appr-place',
      required_targets_json: encodeGitOpsRequiredTargetsJson([1]),
      preflight_fingerprint: 'a'.repeat(64),
    },
    legacy_combined: { generation_id: 'gen-1' },
  };
  const store = GitOpsStore.getInstance();
  const id = `appr-${randomUUID().slice(0, 8)}`;
  store.insertApproval({
    id,
    authoritative: 1,
    application_id: '',
    generation_id: null,
    intent_revision_id: null,
    artifact_set_id: null,
    rollout_candidate_id: null,
    rollout_generation_id: null,
    source_acceptance_ref: null,
    placement_approval_ref: null,
    required_targets_json: null,
    preflight_fingerprint: null,
    fingerprint: null,
    blast_json: null,
    policy_provenance_json: null,
    actor: 'tester',
    created_at: 1,
    ...minimum[overrides.kind],
    ...overrides,
  } as GitOpsApprovalRow);
  return id;
}

/** A rollout generation carrying whatever snapshot the case is about. */
function seedGeneration(app: GitOpsApplicationRow, policySnapshotJson: string | null): string {
  const id = `rgen-${randomUUID().slice(0, 8)}`;
  const store = GitOpsStore.getInstance();
  store.insertRolloutGeneration({
    id,
    application_id: app.id,
    provenance: 'rollout_authorization',
    intent_revision_id: 'intent-1',
    rollout_candidate_id: 'cand-1',
    accepted_generation_id: null,
    artifact_set_id: null,
    placement_approval_ref: null,
    source_acceptance_ref: null,
    rollout_authorization_ref: null,
    required_targets_json: encodeGitOpsRequiredTargetsJson([1]),
    preflight_fingerprint: null,
    preflight_evidence_json: null,
    rollout_strategy_json: '{}',
    policy_snapshot_json: policySnapshotJson,
    supersedes_generation_id: null,
    superseded_at: null,
    operation_id: 'op-1',
    actor: 'tester',
    trigger: 'test',
    created_at: 1,
  });
  return id;
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  GitOpsStore.resetForTests();
  GitOpsTransitions.resetForTests();
});

describe('authority policy reads', () => {
  it('reports all three domains in stage order', () => {
    expect(authorityPolicyReads(seedApp(), PENDING_FACETS).map((entry) => entry.domain))
      .toEqual(['source', 'placement', 'rollout_authorization']);
  });

  it('reports the configured value verbatim for each domain', () => {
    const app = seedApp({
      source_policy: 'automatic',
      placement_policy: 'bounded_auto',
      rollout_authorization_policy: 'automatic',
    });
    expect(read('source', app).configured).toBe('automatic');
    expect(read('placement', app).configured).toBe('bounded_auto');
    expect(read('rollout_authorization', app).configured).toBe('automatic');
  });

  it('reports no frozen value when no generation is running', () => {
    // The claim under test: absent is absent, not today's setting wearing a
    // frozen label.
    expect(read('placement', seedApp({ placement_policy: 'bounded_auto' })).effectiveFrozen).toBeNull();
  });

  it('reports no frozen value when the running generation holds no readable snapshot', () => {
    const app = seedApp();
    const withGeneration = { ...app, rollout_generation_id: seedGeneration(app, 'not json at all') };
    expect(read('rollout_authorization', withGeneration).effectiveFrozen).toBeNull();
  });

  it('reports the value the running generation froze, not the current setting', () => {
    // The whole point of freezing. An operator editing the policy afterwards must
    // not appear to have authorized the rollout already in flight.
    const app = seedApp({ placement_policy: 'operator' });
    const frozen = encodePolicySnapshot({
      version: 1,
      source: 'review',
      placement: 'bounded_auto',
      rolloutAuthorization: 'automatic',
    });
    const withGeneration = { ...app, rollout_generation_id: seedGeneration(app, frozen) };
    const entry = read('placement', withGeneration);
    expect(entry.configured).toBe('operator');
    expect(entry.effectiveFrozen).toBe('bounded_auto');
  });

  it('reports an open review with no recorded reason as awaiting an operator', () => {
    // Nothing has run yet. Claiming a decline here would send an operator
    // looking for a decision the policy never made.
    const entry = read('placement', seedApp({ placement_policy: 'bounded_auto' }));
    expect(entry.decision).toBe('awaiting_operator');
    expect(entry.reason).toBeNull();
  });

  it('reports a recorded refusal as the policy declining, with its reason', () => {
    const app = seedApp({ placement_policy: 'bounded_auto' });
    GitOpsTransitions.getInstance().placementPolicyRefused({
      applicationId: app.id,
      reason: 'stateful_workload',
      at: 4242,
    });
    const entry = read('placement', GitOpsStore.getInstance().getApplication(app.id)!);
    expect(entry.decision).toBe('policy_declined');
    expect(entry.reason).toBe('stateful_workload');
    expect(entry.decidedAt).toBe(4242);
  });

  it('reports an operator approval as operator-authorized, with no reason', () => {
    const app = seedApp({ placement_policy: 'bounded_auto' });
    const ref = insertApproval({ kind: 'placement_approval', authority: 'operator', application_id: app.id, created_at: 99 });
    const entry = read('placement', { ...app, placement_approval_ref: ref });
    expect(entry.decision).toBe('operator_authorized');
    expect(entry.decidedBy).toBe('operator');
    expect(entry.decidedAt).toBe(99);
    expect(entry.reason).toBeNull();
  });

  it('reports a policy-authorized approval as policy-authorized', () => {
    const app = seedApp({ placement_policy: 'bounded_auto' });
    const ref = insertApproval({
      kind: 'placement_approval',
      authority: 'configured_policy',
      application_id: app.id,
      actor: null,
      created_at: 7,
    });
    const entry = read('placement', { ...app, placement_approval_ref: ref });
    expect(entry.decision).toBe('policy_authorized');
    expect(entry.decidedBy).toBe('configured_policy');
  });

  it('does not report a recorded refusal while no review is open', () => {
    // The clear sites exist for this. A reason left on a settled application
    // would be read as the explanation for whatever comes next.
    const app = seedApp({ placement_policy: 'bounded_auto' });
    GitOpsTransitions.getInstance().placementPolicyRefused({ applicationId: app.id, reason: 'cordon_override' });
    const settled = GitOpsStore.getInstance().getApplication(app.id)!;
    const entry = authorityPolicyReads(settled, SETTLED_FACETS).find((e) => e.domain === 'placement')!;
    expect(entry.reason).toBeNull();
    expect(entry.decision).not.toBe('policy_declined');
  });

  it('reports the rollout authorization domain from the live approval', () => {
    const app = seedApp({ rollout_authorization_policy: 'automatic' });
    const ref = insertApproval({
      kind: 'rollout_authorization',
      authority: 'configured_policy',
      application_id: app.id,
      actor: null,
      created_at: 11,
    });
    const entry = read('rollout_authorization', { ...app, rollout_authorization_ref: ref });
    expect(entry.decision).toBe('policy_authorized');
    expect(entry.decidedAt).toBe(11);
  });

  it('reports the source domain from the acceptance, which only an operator gives', () => {
    const app = seedApp({ source_policy: 'automatic' });
    const ref = insertApproval({ kind: 'source_acceptance', authority: 'operator', application_id: app.id, created_at: 3 });
    const entry = read('source', { ...app, source_acceptance_ref: ref });
    expect(entry.decision).toBe('operator_authorized');
    expect(entry.decidedBy).toBe('operator');
    expect(entry.configured).toBe('automatic');
  });

  it('reports a source acceptance the automatic path made as the policy deciding it', () => {
    // An operator on the automatic policy was being told they had personally
    // accepted a revision nobody showed them, because the authority was
    // hardcoded rather than read from the approval.
    const app = seedApp({ source_policy: 'automatic' });
    const ref = insertApproval({
      kind: 'source_acceptance',
      authority: 'configured_policy',
      application_id: app.id,
      actor: null,
      created_at: 4,
    });
    const entry = read('source', { ...app, source_acceptance_ref: ref });
    expect(entry.decision).toBe('policy_authorized');
    expect(entry.decidedBy).toBe('configured_policy');
  });

  it('reports no frozen value for a generation that predates the policy contract', () => {
    // A generation with no recorded snapshot is one that predates the contract.
    // Decoding that as the fresh-install defaults would claim a rollout was
    // decided under a policy that did not exist when it ran.
    const app = seedApp({ placement_policy: 'bounded_auto', rollout_authorization_policy: 'automatic' });
    const withGeneration = { ...app, rollout_generation_id: seedGeneration(app, null) };
    const entry = read('rollout_authorization', withGeneration);
    expect(entry.effectiveFrozen).toBeNull();
    // The configured value is still reported. Absent evidence about the frozen
    // policy is not an excuse to withhold the one fact the row does hold.
    expect(entry.configured).toBe('automatic');
  });

  it('reports a direct application without inventing a placement review', () => {
    // A Direct application has no Blueprint placement, so its placement policy is
    // never consulted. Reporting a pending review would put a question in front
    // of the operator that does not exist.
    const id = `direct-${randomUUID().slice(0, 8)}`;
    const store = GitOpsStore.getInstance();
    store.insertApplication(directApplicationFixture(id, `stack-${id}`));
    const entry = authorityPolicyReads(store.getApplication(id)!, {
      source: { status: 'not_applicable' },
      placement: { status: 'not_applicable' },
      rollout: { status: 'not_applicable' },
    }).find((e) => e.domain === 'placement')!;
    expect(entry.decision).toBe('awaiting_operator');
    expect(entry.configured).toBe(DEFAULT_PLACEMENT_POLICY);
  });
});
