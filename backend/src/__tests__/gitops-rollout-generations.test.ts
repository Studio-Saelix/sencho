import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { GitOpsStore } from '../services/gitops/store';
import { encodeGitOpsRequiredTargetsJson } from '../services/gitops/json';
import type {
  GitOpsApplicationRow,
  GitOpsIntentRevisionRow,
  GitOpsRolloutCandidateRow,
  GitOpsRolloutGenerationRow,
} from '../services/gitops/types';

describe('gitops rollout generations', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    GitOpsStore.resetForTests();
    const store = GitOpsStore.getInstance();
    store.insertApplication(directApp('app-rg', 'stack-rg'));
    store.insertIntentRevision(intent('intent-rg', 'app-rg'));
    store.insertRolloutCandidate(candidate('cand-rg', 'app-rg', 'intent-rg'));
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  it('inserts and reads a legacy_inline rollout generation', () => {
    const store = GitOpsStore.getInstance();
    const row = generation('rg-1', 'app-rg', 'intent-rg', 'cand-rg', 'legacy_inline');
    store.insertRolloutGeneration(row);
    expect(store.getRolloutGeneration('rg-1')).toEqual(row);
  });

  it('rejects malformed required_targets_json and invalid preflight fingerprints', () => {
    const store = GitOpsStore.getInstance();
    expect(() => store.insertRolloutGeneration({
      ...generation('rg-bad-targets', 'app-rg', 'intent-rg', 'cand-rg', 'legacy_inline'),
      required_targets_json: '{"nodeIds":[2,1]}',
    })).toThrow();
    expect(store.getRolloutGeneration('rg-bad-targets')).toBeUndefined();

    expect(() => store.insertRolloutGeneration({
      ...generation('rg-bad-fp', 'app-rg', 'intent-rg', 'cand-rg', 'placement_approval'),
      preflight_fingerprint: 'not-a-fingerprint',
    })).toThrow(/preflight_fingerprint/);
    expect(store.getRolloutGeneration('rg-bad-fp')).toBeUndefined();
  });

  it('marks a generation superseded idempotently', () => {
    const store = GitOpsStore.getInstance();
    store.insertRolloutGeneration(generation('rg-2', 'app-rg', 'intent-rg', 'cand-rg', 'placement_approval'));
    store.markRolloutGenerationSuperseded('rg-2', 100);
    expect(store.getRolloutGeneration('rg-2')?.superseded_at).toBe(100);
    store.markRolloutGenerationSuperseded('rg-2', 200);
    expect(store.getRolloutGeneration('rg-2')?.superseded_at).toBe(100);
  });

  it('round-trips a placement_approval generation with a valid preflight fingerprint', () => {
    const store = GitOpsStore.getInstance();
    const fingerprint = 'ab'.repeat(32);
    const row = {
      ...generation('rg-3', 'app-rg', 'intent-rg', 'cand-rg', 'placement_approval'),
      placement_approval_ref: 'place-1',
      preflight_fingerprint: fingerprint,
    };
    store.insertRolloutGeneration(row);
    expect(store.getRolloutGeneration('rg-3')).toEqual(row);
  });
});

function generation(
  id: string,
  applicationId: string,
  intentRevisionId: string,
  rolloutCandidateId: string,
  provenance: GitOpsRolloutGenerationRow['provenance'],
): GitOpsRolloutGenerationRow {
  return {
    id,
    application_id: applicationId,
    intent_revision_id: intentRevisionId,
    rollout_candidate_id: rolloutCandidateId,
    accepted_generation_id: null,
    artifact_set_id: null,
    placement_approval_ref: null,
    source_acceptance_ref: null,
    rollout_authorization_ref: null,
    required_targets_json: encodeGitOpsRequiredTargetsJson([1]),
    preflight_fingerprint: null,
    preflight_evidence_json: null,
    rollout_strategy_json: '{}',
    provenance,
    supersedes_generation_id: null,
    superseded_at: null,
    operation_id: 'op-rg',
    actor: 'tester',
    trigger: 'manual',
    created_at: 1,
  };
}

function candidate(
  id: string,
  applicationId: string,
  intentRevisionId: string,
): GitOpsRolloutCandidateRow {
  return {
    id,
    application_id: applicationId,
    intent_revision_id: intentRevisionId,
    compose_content_sha256: 'c'.repeat(64),
    accepted_generation_id: null,
    artifact_set_id: null,
    required_targets_json: encodeGitOpsRequiredTargetsJson([1]),
    authoritative: 0,
    provenance: 'legacy_inline',
    operation_id: 'op-cand',
    created_at: 1,
  };
}

function intent(id: string, applicationId: string): GitOpsIntentRevisionRow {
  return {
    id,
    application_id: applicationId,
    blueprint_id: 1,
    compose_content_sha256: 'c'.repeat(64),
    blueprint_revision: 1,
    deploy_stack_name: 'web',
    selector_json: '{}',
    pinned_node_id: null,
    cordon_implications_json: '[]',
    rollout_strategy_json: '{}',
    runtime_drift_policy: null,
    stateful_policy_json: null,
    health_failure_rollback_policy_json: null,
    operation_id: 'op-intent',
    actor: 'tester',
    created_at: 1,
  };
}

function directApp(id: string, stackName: string): GitOpsApplicationRow {
  return {
    id,
    lifecycle_key: `direct:${stackName}`,
    lifecycle_status: 'active',
    target_mode: 'direct',
    stack_name: stackName,
    configured_source_stack_name: null,
    blueprint_id: null,
    configured_repo_url: 'https://github.com/org/repo.git',
    repo_identity_json: '{"host":"github.com","pathname":"/org/repo.git"}',
    configured_ref: 'main',
    compose_paths_json: '["compose.yml"]',
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
    artifact_set_id: null,
    latest_artifact_set_id: null,
    intent_revision_id: null,
    rollout_candidate_id: null,
    rollout_generation_id: null,
    source_acceptance_ref: null,
    placement_approval_ref: null,
    rollout_authorization_ref: null,
    legacy_combined_approval_ref: null,
    preflight_fingerprint: null,
    latest_operation_id: null,
    active_operation_id: null,
    active_operation_stage: null,
    active_operation_at: null,
    active_generation_id: null,
    pause_at: null,
    pause_reason: null,
    source_suspended_reason: null,
    source_policy: 'manual',
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
  };
}
