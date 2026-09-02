import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { GitOpsStore } from '../services/gitops/store';
import { encodeGitOpsApprovedTargetEffectJson, encodeGitOpsRequiredTargetsJson } from '../services/gitops/json';
import type {
  GitOpsApplicationRow,
  GitOpsApprovalRow,
  GitOpsGenerationRow,
  GitOpsIntentRevisionRow,
  GitOpsRolloutCandidateRow,
} from '../services/gitops/types';

describe('gitops approvals', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    GitOpsStore.resetForTests();
    const store = GitOpsStore.getInstance();
    store.insertApplication(directApp('app-a', 'stack-a'));
    store.insertGeneration(generation('gen-a', 'app-a'));
    store.insertGeneration(generation('gen-b', 'app-a'));
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  it('rejects exact kind/authority mismatches at the CHECK floor', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance().getDb();
    const insert = db.prepare(
      `INSERT INTO gitops_approvals (
        id, kind, authority, authoritative, application_id, generation_id, intent_revision_id,
        artifact_set_id, rollout_candidate_id, rollout_generation_id, source_acceptance_ref,
        placement_approval_ref, required_targets_json, preflight_fingerprint, fingerprint,
        blast_json, policy_provenance_json, actor, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    expect(() => insert.run(
      'bad-src-legacy', 'source_acceptance', 'legacy_combined', 1, 'app-a', 'gen-a',
      null, null, null, null, null, null, null, null, null, null, null, 'tester', 1,
    )).toThrow();
    expect(() => insert.run(
      'bad-src-auth0', 'source_acceptance', 'operator', 0, 'app-a', 'gen-a',
      null, null, null, null, null, null, null, null, null, null, null, 'tester', 1,
    )).toThrow();
    expect(() => insert.run(
      'bad-legacy-auth1', 'legacy_combined', 'legacy_combined', 1, 'app-a', null,
      null, null, null, null, null, null, null, null, null, null, null, 'tester', 1,
    )).toThrow();
    expect(() => insert.run(
      'bad-legacy-op', 'legacy_combined', 'operator', 0, 'app-a', null,
      null, null, null, null, null, null, null, null, null, null, null, 'tester', 1,
    )).toThrow();
  });

  it('resolves source acceptance only for the expected generation', () => {
    const store = GitOpsStore.getInstance();
    store.insertApproval(sourceAcceptance('acc-a', 'app-a', 'gen-a'));
    store.insertApproval(sourceAcceptance('acc-b', 'app-a', 'gen-b'));
    expect(store.resolveApprovalRef('acc-a', {
      kind: 'source_acceptance',
      applicationId: 'app-a',
      generationId: 'gen-a',
    })?.id).toBe('acc-a');
    expect(store.resolveApprovalRef('acc-a', {
      kind: 'source_acceptance',
      applicationId: 'app-a',
      generationId: 'gen-b',
    })).toBeNull();
    expect(store.newestSourceAcceptanceId('app-a', 'gen-a')).toBe('acc-a');
  });

  it('validates placement effects against required nodes without set equality', () => {
    const store = GitOpsStore.getInstance();
    store.insertIntentRevision(intent('intent-1', 'app-a'));
    store.insertApproval(placement('place-subset', 'app-a', 'intent-1', [
      { nodeId: 2, outcome: 'place' },
    ]));
    store.insertApproval(placement('place-empty', 'app-a', 'intent-1', []));
    store.insertApproval(placement('place-remove-extra', 'app-a', 'intent-1', [
      { nodeId: 3, outcome: 'remove' },
    ]));
    const required = [1, 2];
    expect(store.resolveApprovalRef('place-subset', {
      kind: 'placement_approval',
      applicationId: 'app-a',
      intentRevisionId: 'intent-1',
      requiredNodeIds: required,
    })?.id).toBe('place-subset');
    expect(store.resolveApprovalRef('place-empty', {
      kind: 'placement_approval',
      applicationId: 'app-a',
      intentRevisionId: 'intent-1',
      requiredNodeIds: required,
    })?.id).toBe('place-empty');
    expect(store.resolveApprovalRef('place-remove-extra', {
      kind: 'placement_approval',
      applicationId: 'app-a',
      intentRevisionId: 'intent-1',
      requiredNodeIds: required,
    })?.id).toBe('place-remove-extra');
    store.insertApproval(placement('place-bad-required', 'app-a', 'intent-1', [
      { nodeId: 9, outcome: 'place' },
    ]));
    expect(store.resolveApprovalRef('place-bad-required', {
      kind: 'placement_approval',
      applicationId: 'app-a',
      intentRevisionId: 'intent-1',
      requiredNodeIds: required,
    })).toBeNull();
    store.insertApproval(placement('remove-required', 'app-a', 'intent-1', [
      { nodeId: 1, outcome: 'remove' },
    ]));
    expect(store.resolveApprovalRef('remove-required', {
      kind: 'placement_approval',
      applicationId: 'app-a',
      intentRevisionId: 'intent-1',
      requiredNodeIds: required,
    })).toBeNull();
  });

  it('refuses to persist an approval whose evidence JSON cannot be decoded', () => {
    const store = GitOpsStore.getInstance();
    store.insertApplication(directApp('app-badjson', 'badjson-web'));
    store.insertGeneration(generation('gen-badjson', 'app-badjson'));
    store.insertIntentRevision(intent('intent-badjson', 'app-badjson'));
    expect(() => store.insertApproval({
      ...placement('appr-badblast', 'app-badjson', 'intent-badjson', []),
      generation_id: null,
      blast_json: '[{"nodeId":2,"outcome":"place"},{"nodeId":1,"outcome":"remove"}]',
    })).toThrow();
    expect(() => store.insertApproval({
      ...placement('appr-badtargets', 'app-badjson', 'intent-badjson', []),
      generation_id: null,
      required_targets_json: '{"nodeIds":[2,1]}',
    })).toThrow();
    expect(store.getApproval('appr-badblast')).toBeUndefined();
    expect(store.getApproval('appr-badtargets')).toBeUndefined();
  });

  it('does not treat a CHECK-valid row as proof when expected identity differs', () => {
    const store = GitOpsStore.getInstance();
    store.insertIntentRevision(intent('intent-2', 'app-a'));
    store.insertRolloutCandidate(candidate('cand-1', 'app-a', 'intent-2', 'gen-a'));
    store.insertApproval(sourceAcceptance('acc-bind-a', 'app-a', 'gen-a'));
    store.insertApproval(placement('place-bind', 'app-a', 'intent-2', [
      { nodeId: 1, outcome: 'place' },
    ]));
    const fingerprint = 'ab'.repeat(32);
    store.insertApproval({
      id: 'rollout-1',
      kind: 'rollout_authorization',
      authority: 'operator',
      authoritative: 1,
      application_id: 'app-a',
      generation_id: 'gen-a',
      intent_revision_id: 'intent-2',
      artifact_set_id: 'art-missing',
      rollout_candidate_id: 'cand-1',
      rollout_generation_id: null,
      source_acceptance_ref: 'acc-bind-a',
      placement_approval_ref: 'place-bind',
      required_targets_json: encodeGitOpsRequiredTargetsJson([1]),
      preflight_fingerprint: fingerprint,
      fingerprint: null,
      blast_json: null,
      policy_provenance_json: null,
      actor: 'tester',
      created_at: 10,
    });
    expect(store.resolveApprovalRef('rollout-1', {
      kind: 'rollout_authorization',
      applicationId: 'app-a',
      binding: {
        rolloutCandidateId: 'cand-1',
        acceptedGenerationId: 'gen-b',
        artifactSetId: 'art-missing',
        intentRevisionId: 'intent-2',
        requiredNodeIds: [1],
        sourceAcceptanceRef: 'acc-bind-a',
        placementApprovalRef: 'place-bind',
        preflightFingerprint: fingerprint,
      },
    })).toBeNull();
  });
});

function sourceAcceptance(id: string, applicationId: string, generationId: string): GitOpsApprovalRow {
  return {
    id,
    kind: 'source_acceptance',
    authority: 'operator',
    authoritative: 1,
    application_id: applicationId,
    generation_id: generationId,
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
  };
}

function placement(
  id: string,
  applicationId: string,
  intentRevisionId: string,
  effect: Array<{ nodeId: number; outcome: 'place' | 'remove' }>,
): GitOpsApprovalRow {
  return {
    ...sourceAcceptance(id, applicationId, 'gen-a'),
    kind: 'placement_approval',
    generation_id: null,
    intent_revision_id: intentRevisionId,
    blast_json: encodeGitOpsApprovedTargetEffectJson(effect),
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

function candidate(
  id: string,
  applicationId: string,
  intentRevisionId: string,
  acceptedGenerationId: string,
): GitOpsRolloutCandidateRow {
  return {
    id,
    application_id: applicationId,
    intent_revision_id: intentRevisionId,
    compose_content_sha256: 'c'.repeat(64),
    accepted_generation_id: acceptedGenerationId,
    artifact_set_id: null,
    required_targets_json: encodeGitOpsRequiredTargetsJson([1]),
    authoritative: 0,
    provenance: 'legacy_inline',
    operation_id: 'op-cand',
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

function generation(id: string, applicationId: string): GitOpsGenerationRow {
  return {
    id,
    application_id: applicationId,
    commit_sha: id,
    repo_url: 'https://github.com/org/repo.git',
    resolved_ref_kind: 'branch',
    configured_ref: 'main',
    repo_identity_json: '{"host":"github.com","pathname":"/org/repo.git"}',
    manifest_version: 0,
    candidate_dir: `generations/candidate-${id}`,
    applied_dir: `generations/applied-${id}-0`,
    expected_invocation_json: '{"composeFileOrder":[],"projectName":null,"projectDirectory":null,"envFileOrder":[]}',
    materialization_fingerprint: 'a'.repeat(64),
    validation_ok: 1,
    plan_blocked: 0,
    change_plan_fingerprint: null,
    operation_id: `op-${id}`,
    trigger: 'manual',
    actor: 'tester',
    previous_generation_id: null,
    redacted_limitations_json: '[]',
    created_at: 1,
  };
}
