/**
 * The automatic placement approval path.
 *
 * Three properties are load bearing and each is pinned here. An approval cannot
 * be duplicated by a replay. An approval carries the authority that actually
 * made it, paired with the snapshot that made it. A policy edit is
 * configuration, so it changes what a future decision may do and leaves every
 * standing approval and the generation they opened exactly where they are.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions, type EventEnvelope } from '../services/gitops/transitions';
import { applyAutomaticPlacement } from '../services/gitops/automaticPlacement';
import {
  encodeGitOpsApprovedTargetEffectJson,
  encodeGitOpsRequiredTargetsJson,
} from '../services/gitops/json';
import type {
  GitOpsApplicationRow,
  GitOpsIntentRevisionRow,
  GitOpsRolloutCandidateRow,
} from '../services/gitops/types';

let tmpDir: string;

function envelope(trigger: string): EventEnvelope {
  return { operationId: `op-${trigger}-${Math.random().toString(16).slice(2)}`, actor: 'tester', trigger, at: 1000 };
}

function blueprintApp(id: string, overrides: Partial<GitOpsApplicationRow> = {}): GitOpsApplicationRow {
  return {
    id,
    lifecycle_key: `blueprint:${id}`,
    lifecycle_status: 'active',
    target_mode: 'blueprint',
    stack_name: null,
    configured_source_stack_name: null,
    blueprint_id: Number(id.replace(/\D/g, '')) + 500,
    configured_repo_url: `https://example.invalid/${id}.git`,
    repo_identity_json: '{"host":"example.invalid","pathname":"/x.git"}',
    configured_ref: 'main',
    compose_paths_json: '["compose.yaml"]',
    context_dir: null,
    sync_env: 0,
    env_path: null,
    materialization_fingerprint: 'a'.repeat(64),
    desired_commit_sha: null,
    fetched_commit_sha: null,
    fetched_resolved_ref_kind: null,
    candidate_generation_id: null,
    accepted_generation_id: null,
    candidate_plan_blocked: 0,
    review_required: 0,
    review_block_reason: null,
    artifact_set_id: null,
    latest_artifact_set_id: null,
    intent_revision_id: `${id}-intent`,
    rollout_candidate_id: `${id}-cand`,
    rollout_generation_id: null,
    source_acceptance_ref: null,
    placement_approval_ref: null,
    rollout_authorization_ref: null,
    legacy_combined_approval_ref: null,
    preflight_fingerprint: null,
    latest_preflight_evidence_json: null,
    latest_operation_id: null,
    active_operation_id: null,
    active_operation_stage: null,
    active_operation_at: null,
    active_generation_id: null,
    pause_at: null,
    pause_reason: null,
    source_suspended_reason: null,
    source_policy: 'review',
    placement_policy: 'bounded_auto',
    rollout_authorization_policy: 'automatic',
        placement_policy_refusal_reason: null,
        placement_policy_refused_at: null,
    poll_interval_secs: null,
    next_poll_at: null,
    attempt_seq: 0,
    partial_json: null,
    failure_stage: null,
    failure_class: null,
    failure_at: null,
    retry_at: null,
    retry_count: 0,
    suspended_at: null,
    recovery_ref: null,
    recovery_phase: null,
    interruption_stage: null,
    interruption_at: null,
    interruption_operation_id: null,
    interruption_generation_id: null,
    evidence_fresh_at: null,
    evidence_limitations_json: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function intent(id: string, applicationId: string): GitOpsIntentRevisionRow {
  return {
    id,
    application_id: applicationId,
    blueprint_id: 501,
    compose_content_sha256: 'b'.repeat(64),
    blueprint_revision: 1,
    deploy_stack_name: 'bp-stack',
    selector_json: '{"labels":{}}',
    pinned_node_id: null,
    cordon_implications_json: '{"pinnedOverridesCordon":false}',
    rollout_strategy_json: '{"driftMode":"observe","enabled":true}',
    runtime_drift_policy: 'observe',
    stateful_policy_json: null,
    health_failure_rollback_policy_json: null,
    operation_id: `op-${id}`,
    actor: 'tester',
    created_at: 1,
  };
}

function candidate(id: string, applicationId: string, intentId: string, nodeIds: number[]): GitOpsRolloutCandidateRow {
  return {
    id,
    application_id: applicationId,
    intent_revision_id: intentId,
    compose_content_sha256: 'b'.repeat(64),
    accepted_generation_id: null,
    artifact_set_id: null,
    required_targets_json: encodeGitOpsRequiredTargetsJson(nodeIds),
    authoritative: 1,
    provenance: 'roster_change',
    operation_id: `op-${id}`,
    created_at: 1,
  };
}

function seedApproved(app: GitOpsApplicationRow, approvedNodeIds: number[]): void {
  const store = GitOpsStore.getInstance();
  store.insertIntentRevision(intent(app.intent_revision_id as string, app.id));
  store.insertRolloutCandidate(candidate(app.rollout_candidate_id as string, app.id, app.intent_revision_id as string, approvedNodeIds));
  store.insertApplication(app);
  GitOpsTransitions.getInstance().placementApproved({
    applicationId: app.id,
    approvalId: `${app.id}-placement`,
    intentRevisionId: app.intent_revision_id as string,
    blastJson: encodeGitOpsApprovedTargetEffectJson(approvedNodeIds.map((nodeId) => ({ nodeId, outcome: 'place' as const }))),
    requiredNodeIds: approvedNodeIds,
    fingerprint: null,
    actor: 'tester',
    envelope: envelope('seed'),
    rolloutGenerationId: `${app.id}-gen`,
    candidateId: app.rollout_candidate_id as string,
    authority: 'operator',
    policyProvenanceJson: null,
  });
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  GitOpsStore.resetForTests();
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

describe('the replay guard', () => {
  it('lets an operator approve the same intent and candidate twice', () => {
    const store = GitOpsStore.getInstance();
    const app = blueprintApp('9001', { intent_revision_id: 'r-intent', rollout_candidate_id: 'r-cand' });
    store.insertIntentRevision(intent('r-intent', '9001'));
    store.insertRolloutCandidate(candidate('r-cand', '9001', 'r-intent', [1]));
    store.insertApplication(app);

    const first = {
      applicationId: '9001',
      approvalId: 'r-approval-1',
      intentRevisionId: 'r-intent',
      blastJson: encodeGitOpsApprovedTargetEffectJson([{ nodeId: 1, outcome: 'place' as const }]),
      requiredNodeIds: [1],
      fingerprint: null,
      actor: 'tester',
      envelope: envelope('first'),
      rolloutGenerationId: 'r-gen-1',
      candidateId: 'r-cand',
      authority: 'operator' as const,
      policyProvenanceJson: null,
    };
    GitOpsTransitions.getInstance().placementApproved(first);

    // The pointers have not moved, so every currency check passes. Without the
    // The Inline Apply path reuses the current intent, so an operator pressing
    // Apply again lands on the same intent and candidate. That is a deliberate
    // second decision, and refusing it as a replay regressed a flow that had
    // worked for ever.
    expect(() =>
      GitOpsTransitions.getInstance().placementApproved({ ...first, approvalId: 'r-approval-2', rolloutGenerationId: 'r-gen-2' }),
    ).not.toThrow();
    expect(store.getApproval('r-approval-2')).toBeDefined();
  });

  it('allows a fresh approval once a new candidate exists for a new intent', () => {
    // The guard is scoped to one intent and candidate, not to the application.
    // Legitimate re-approval after a change must not be blocked by it.
    const store = GitOpsStore.getInstance();
    const app = blueprintApp('9002', { intent_revision_id: 'p-intent-1', rollout_candidate_id: 'p-cand-1' });
    store.insertIntentRevision(intent('p-intent-1', '9002'));
    store.insertRolloutCandidate(candidate('p-cand-1', '9002', 'p-intent-1', [1]));
    store.insertApplication(app);
    GitOpsTransitions.getInstance().placementApproved({
      applicationId: '9002',
      approvalId: 'p-approval-1',
      intentRevisionId: 'p-intent-1',
      blastJson: encodeGitOpsApprovedTargetEffectJson([{ nodeId: 1, outcome: 'place' as const }]),
      requiredNodeIds: [1],
      fingerprint: null,
      actor: 'tester',
      envelope: envelope('p1'),
      rolloutGenerationId: 'p-gen-1',
      candidateId: 'p-cand-1',
      authority: 'operator',
      policyProvenanceJson: null,
    });

    // The transitions own the insert for a new intent, so the rows are not
    // seeded directly here.
    GitOpsTransitions.getInstance().intentRevised({
      applicationId: '9002',
      intent: intent('p-intent-2', '9002'),
      envelope: envelope('p2'),
    });
    GitOpsTransitions.getInstance().rolloutCandidateOpened({
      applicationId: '9002',
      candidate: candidate('p-cand-2', '9002', 'p-intent-2', [1, 2]),
      envelope: envelope('p2'),
    });

    expect(() =>
      GitOpsTransitions.getInstance().placementApproved({
        applicationId: '9002',
        approvalId: 'p-approval-2',
        intentRevisionId: 'p-intent-2',
        blastJson: encodeGitOpsApprovedTargetEffectJson([{ nodeId: 1, outcome: 'place' as const }, { nodeId: 2, outcome: 'place' as const }]),
        requiredNodeIds: [1, 2],
        fingerprint: null,
        actor: 'tester',
        envelope: envelope('p2'),
        rolloutGenerationId: 'p-gen-2',
        candidateId: 'p-cand-2',
        authority: 'operator',
        policyProvenanceJson: null,
      }),
    ).not.toThrow();
    expect(store.getApproval('p-approval-2')).toBeDefined();
  });
});

describe('authority and the snapshot that made it', () => {
  const base = {
    applicationId: '9100',
    approvalId: 'a-1',
    intentRevisionId: 'a-intent',
    blastJson: encodeGitOpsApprovedTargetEffectJson([{ nodeId: 1, outcome: 'place' as const }]),
    requiredNodeIds: [1],
    fingerprint: null,
    actor: 'tester',
    envelope: envelope('pairing'),
    rolloutGenerationId: 'a-gen',
    candidateId: 'a-cand',
  };

  beforeAll(() => {
    const store = GitOpsStore.getInstance();
    store.insertIntentRevision(intent('a-intent', '9100'));
    store.insertRolloutCandidate(candidate('a-cand', '9100', 'a-intent', [1]));
    store.insertApplication(blueprintApp('9100', { intent_revision_id: 'a-intent', rollout_candidate_id: 'a-cand' }));
  });

  it('refuses a policy-authorized approval that records no snapshot', () => {
    // A decision with no record of the snapshot that made it cannot be
    // reviewed later, so the two are checked together rather than trusted
    // individually.
    expect(() =>
      GitOpsTransitions.getInstance().placementApproved({
        ...base,
        authority: 'configured_policy',
        policyProvenanceJson: null,
      }),
    ).toThrow(/must record its policy snapshot/);
    expect(GitOpsStore.getInstance().getApproval('a-1')).toBeUndefined();
  });

  it('refuses a replayed automatic approval for the same intent and candidate', () => {
    // The guard the automatic path relies on: a policy decision already recorded
    // for this exact pair is durable, and re-running it must not mint a second
    // approval or supersede the generation the first one opened.
    const store = GitOpsStore.getInstance();
    const app = blueprintApp('9120', { intent_revision_id: 'd-intent', rollout_candidate_id: 'd-cand' });
    store.insertIntentRevision(intent('d-intent', '9120'));
    store.insertRolloutCandidate(candidate('d-cand', '9120', 'd-intent', [1]));
    store.insertApplication(app);
    const automatic = (approvalId: string, generationId: string) => () =>
      GitOpsTransitions.getInstance().placementApproved({
        applicationId: '9120',
        approvalId,
        intentRevisionId: 'd-intent',
        blastJson: encodeGitOpsApprovedTargetEffectJson([{ nodeId: 1, outcome: 'place' as const }]),
        requiredNodeIds: [1],
        fingerprint: null,
        actor: null,
        envelope: { operationId: `op-${approvalId}`, actor: null, trigger: 'placement_policy', at: 1 },
        rolloutGenerationId: generationId,
        candidateId: 'd-cand',
        authority: 'configured_policy',
        policyProvenanceJson: JSON.stringify({
          version: 1, source: 'review', placement: 'bounded_auto', rolloutAuthorization: 'automatic',
        }),
      });

    automatic('d-approval-1', 'd-gen-1')();
    expect(() => automatic('d-approval-1-replay', 'd-gen-1b')()).toThrow(/already recorded/);
    expect(store.getApproval('d-approval-1-replay')).toBeUndefined();
    expect(store.getRolloutGeneration('d-gen-1b')).toBeUndefined();
  });

  it('allows a fresh approval against a second candidate under the same intent', async () => {
    // The guard is scoped to one intent and candidate pair. Keying on the intent
    // alone assumed one candidate per intent, which nothing enforces, so this
    // legitimate approval was refused as a replay of the first.
    const { GitOpsTransitions: Tx, GitOpsStore: Store } = { GitOpsTransitions, GitOpsStore };
    const app = blueprintApp('9110', { intent_revision_id: 'c-intent', rollout_candidate_id: 'c-cand-1' });
    Store.getInstance().insertIntentRevision(intent('c-intent', '9110'));
    Store.getInstance().insertRolloutCandidate(candidate('c-cand-1', '9110', 'c-intent', [1]));
    Store.getInstance().insertApplication(app);
    const approve = (approvalId: string, generationId: string, candidateId: string) => () =>
      Tx.getInstance().placementApproved({
        applicationId: '9110',
        approvalId,
        intentRevisionId: 'c-intent',
        blastJson: encodeGitOpsApprovedTargetEffectJson([{ nodeId: 1, outcome: 'place' as const }]),
        requiredNodeIds: [1],
        fingerprint: null,
        actor: 'tester',
        envelope: { operationId: `op-${approvalId}`, actor: 'tester', trigger: 'test', at: 1 },
        rolloutGenerationId: generationId,
        candidateId,
        authority: 'operator',
        policyProvenanceJson: null,
      });

    approve('c-approval-1', 'c-gen-1', 'c-cand-1')();
    // A second operator approval on the same intent and candidate is a deliberate
    // decision, not a replay, and the Inline Apply path depends on it.
    expect(() => approve('c-approval-1-again', 'c-gen-1b', 'c-cand-1')()).not.toThrow();

    Tx.getInstance().rolloutCandidateOpened({
      applicationId: '9110',
      candidate: candidate('c-cand-2', '9110', 'c-intent', [1]),
      envelope: { operationId: 'op-c2', actor: 'tester', trigger: 'test', at: 2 },
    });
    expect(() => approve('c-approval-2', 'c-gen-2', 'c-cand-2')()).not.toThrow();
  });

  it('refuses when the policy changed between the decision and the write', async () => {
    // The authorizing snapshot is read by the caller before this transaction and
    // the generation freezes what is configured now. Without a comparison, a
    // policy edit landing in between would leave the approval and the generation
    // disagreeing about one decision, under a policy the operator had revoked.
    const Store = GitOpsStore.getInstance();
    const Tx = GitOpsTransitions;
    const live = Store.getApplication('9100')!;
    // A decision made under bounded_auto, arriving after the operator tightened
    // the policy to operator.
    const stale = JSON.stringify({
      version: 1,
      source: 'review',
      placement: 'operator',
      rolloutAuthorization: 'manual',
    });
    expect(() =>
      Tx.getInstance().placementApproved({
        applicationId: '9100',
        approvalId: 'a-stale',
        intentRevisionId: live.intent_revision_id as string,
        blastJson: encodeGitOpsApprovedTargetEffectJson([{ nodeId: 1, outcome: 'place' as const }]),
        requiredNodeIds: [1],
        fingerprint: null,
        actor: null,
        envelope: { operationId: 'op-stale', actor: null, trigger: 'test', at: 1 },
        rolloutGenerationId: 'a-gen-stale',
        candidateId: live.rollout_candidate_id as string,
        authority: 'configured_policy',
        policyProvenanceJson: stale,
      }),
    ).toThrow(/policy changed while the decision was being applied/);
    expect(Store.getApproval('a-stale')).toBeUndefined();
  });

  it('refuses an operator approval that claims a policy decided it', () => {
    expect(() =>
      GitOpsTransitions.getInstance().placementApproved({
        ...base,
        approvalId: 'a-2',
        authority: 'operator',
        policyProvenanceJson: '{"version":1,"source":"review","placement":"bounded_auto","rolloutAuthorization":"manual"}',
      }),
    ).toThrow(/records no policy snapshot/);
  });
});

describe('a policy edit is configuration, not work', () => {
  it('changes what a future decision may do and leaves every standing approval alone', () => {
    const store = GitOpsStore.getInstance();
    seedApproved(blueprintApp('9200'), [1]);
    const before = store.getApplication('9200');
    expect(before?.placement_approval_ref).toBe('9200-placement');
    expect(before?.rollout_generation_id).toBe('9200-gen');
    const generationBefore = store.getRolloutGeneration('9200-gen');

    GitOpsTransitions.getInstance().placementPolicyChanged({
      applicationId: '9200',
      placementPolicy: 'operator',
      envelope: envelope('policy'),
    });

    const after = store.getApplication('9200');
    expect(after?.placement_policy).toBe('operator');
    // Nothing about what was already approved moves. The edit decides what the
    // next placement decision may do; the standing approval was made under the
    // snapshot that authorized it and keeps running under it.
    expect(after?.placement_approval_ref).toBe(before?.placement_approval_ref);
    expect(after?.rollout_generation_id).toBe(before?.rollout_generation_id);
    expect(after?.intent_revision_id).toBe(before?.intent_revision_id);
    expect(after?.rollout_candidate_id).toBe(before?.rollout_candidate_id);
    expect(after?.source_acceptance_ref).toBe(before?.source_acceptance_ref);
    expect(after?.latest_preflight_evidence_json).toBe(before?.latest_preflight_evidence_json);
    expect(store.getRolloutGeneration('9200-gen')).toEqual(generationBefore);
    expect(store.getApproval('9200-placement')).toBeDefined();
  });

  it('refuses while an operation is in flight', () => {
    // The operation is reading the policy this edit would change underneath it.
    const store = GitOpsStore.getInstance();
    store.insertApplication(blueprintApp('9201', { active_operation_stage: 'deploy_started', active_operation_id: 'op-x' }));
    expect(() =>
      GitOpsTransitions.getInstance().placementPolicyChanged({
        applicationId: '9201',
        placementPolicy: 'bounded_auto',
        envelope: envelope('busy'),
      }),
    ).toThrow(/operation is in flight/);
  });

  it('drops a recorded refusal when an approval resolves the review', () => {
    // Both writes happen inside the approval's own transaction, and on the policy
    // path the same pass records the approval that superseded the refusal. A
    // reason left behind would name the decision that produced the approval,
    // which is the opposite of what an operator needs to read.
    const store = GitOpsStore.getInstance();
    const app = blueprintApp('9206', { placement_policy: 'bounded_auto' });
    store.insertIntentRevision(intent(app.intent_revision_id as string, app.id));
    store.insertRolloutCandidate(candidate(
      app.rollout_candidate_id as string, app.id, app.intent_revision_id as string, [1],
    ));
    store.insertApplication(app);
    GitOpsTransitions.getInstance().placementPolicyRefused({
      applicationId: '9206',
      reason: 'conflicting_operation',
      at: 700,
    });
    expect(store.getApplication('9206')?.placement_policy_refusal_reason).toBe('conflicting_operation');

    GitOpsTransitions.getInstance().placementApproved({
      applicationId: '9206',
      approvalId: '9206-placement',
      intentRevisionId: app.intent_revision_id as string,
      blastJson: encodeGitOpsApprovedTargetEffectJson([{ nodeId: 1, outcome: 'place' as const }]),
      requiredNodeIds: [1],
      fingerprint: null,
      actor: 'tester',
      envelope: envelope('approve'),
      rolloutGenerationId: '9206-gen',
      candidateId: app.rollout_candidate_id as string,
      authority: 'operator',
      policyProvenanceJson: null,
    });

    const after = store.getApplication('9206');
    expect(after?.placement_approval_ref).toBe('9206-placement');
    expect(after?.placement_policy_refusal_reason).toBeNull();
    expect(after?.placement_policy_refused_at).toBeNull();
  });

  it('drops a recorded refusal when the policy changes, since it described the old one', () => {
    // A reason that explained a decline under `bounded_auto` says nothing once
    // the policy is `operator`. Left in place it would be read as the current
    // explanation for whatever review is open next, which is the opposite of
    // what it described.
    const store = GitOpsStore.getInstance();
    store.insertApplication(blueprintApp('9205', { placement_policy: 'bounded_auto' }));
    GitOpsTransitions.getInstance().placementPolicyRefused({
      applicationId: '9205',
      reason: 'cordon_override',
      at: 500,
    });
    expect(store.getApplication('9205')?.placement_policy_refusal_reason).toBe('cordon_override');

    GitOpsTransitions.getInstance().placementPolicyChanged({
      applicationId: '9205',
      placementPolicy: 'operator',
      envelope: envelope('policy'),
    });

    const after = store.getApplication('9205');
    expect(after?.placement_policy).toBe('operator');
    expect(after?.placement_policy_refusal_reason).toBeNull();
    expect(after?.placement_policy_refused_at).toBeNull();
  });

  it('refuses a change to the value already set, so no empty history row is written', () => {
    GitOpsStore.getInstance().insertApplication(blueprintApp('9202', { placement_policy: 'operator' }));
    expect(() =>
      GitOpsTransitions.getInstance().placementPolicyChanged({
        applicationId: '9202',
        placementPolicy: 'operator',
        envelope: envelope('noop'),
      }),
    ).toThrow(/already set/);
  });

  it('changes the rollout authorization policy on the same terms', () => {
    const store = GitOpsStore.getInstance();
    seedApproved(blueprintApp('9203'), [1]);
    GitOpsTransitions.getInstance().rolloutAuthorizationPolicyChanged({
      applicationId: '9203',
      policy: 'manual',
      envelope: envelope('rolloutpolicy'),
    });
    const after = store.getApplication('9203');
    expect(after?.rollout_authorization_policy).toBe('manual');
    expect(after?.placement_approval_ref).toBe('9203-placement');
    expect(after?.rollout_generation_id).toBe('9203-gen');
  });
});

describe('the automatic path', () => {
  it('writes nothing when the policy says an operator decides', () => {
    const store = GitOpsStore.getInstance();
    const app = blueprintApp('9300', { placement_policy: 'operator', intent_revision_id: 'o-intent', rollout_candidate_id: 'o-cand' });
    store.insertIntentRevision(intent('o-intent', '9300'));
    store.insertRolloutCandidate(candidate('o-cand', '9300', 'o-intent', [1, 2, 3]));
    store.insertApplication(app);

    const outcome = applyAutomaticPlacement('9300', envelope('auto'));
    expect(outcome).toEqual({ status: 'operator_review', reason: 'policy_is_operator' });
    expect(store.getApplication('9300')?.placement_approval_ref).toBeNull();
  });

  it('skips an application with no current candidate rather than deciding anything', () => {
    const store = GitOpsStore.getInstance();
    store.insertApplication(blueprintApp('9301', { intent_revision_id: null, rollout_candidate_id: null }));
    expect(applyAutomaticPlacement('9301', envelope('auto'))).toEqual({
      status: 'skipped',
      reason: 'no_current_candidate',
    });
  });

  it('never throws at the caller, whatever the state', () => {
    // The Blueprint write that triggered this already committed. A refusal or a
    // defect must not turn that into a failed request.
    for (const id of ['missing-app', '9300', '']) {
      expect(() => applyAutomaticPlacement(id, envelope('auto'))).not.toThrow();
    }
  });
});
