/**
 * Clearing a stale stateful guard retires the revision-state target behind it.
 *
 * The guard row is the operator's escape hatch for a stateful first placement
 * they no longer want. Clearing it deletes the deployment row, and the target
 * that was holding for review outlives that row: nothing else moves it, so the
 * projection keeps reporting a stateful confirmation for a placement that no
 * longer exists, and the operator has no way to perform the confirmation the
 * screen is asking for.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { GitOpsStore, emptyTargetRow } from '../services/gitops/store';
import { GitOpsTransitions } from '../services/gitops/transitions';
import { applyClearStaleGuard } from '../services/blueprintPreviewProjection';
import { projectApplication } from '../services/gitops/derive';
import { DEFAULT_PLACEMENT_POLICY, DEFAULT_ROLLOUT_AUTHORIZATION_POLICY } from '../services/gitops/policyComposition';

describe('clearing a stale stateful guard', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    GitOpsStore.resetForTests();
    GitOpsTransitions.resetForTests();
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  it('retires the held target so the placement stops awaiting a confirmation', () => {
    const db = DatabaseService.getInstance();
    const store = GitOpsStore.getInstance();
    const nodeId = 1;
    const applicationId = 'app-stale-guard';

    const created = db.createBlueprint({
      name: `guard-blueprint-${nodeId}-${Date.now()}`,
      description: null,
      compose_content: 'services:\n  web:\n    image: nginx:1.27\n',
      selector: { type: 'nodes', ids: [nodeId] },
      drift_mode: 'observe',
      classification: 'stateless',
      classification_reasons: [],
      enabled: true,
      created_by: null,
    });
    const blueprintId = created.id;
    // The guard row: a stateful hold on a node that was never deployed, which
    // is the only shape the clear path accepts.
    db.upsertDeployment({
      blueprint_id: blueprintId,
      node_id: nodeId,
      status: 'pending_state_review',
      applied_revision: 1,
      last_deployed_at: null,
      last_checked_at: 1,
      last_drift_at: null,
      drift_summary: 'Stateful blueprint awaiting operator confirmation',
      last_error: null,
    } as never);

    store.insertApplication({
      ...directLikeApplication(applicationId, blueprintId),
      target_mode: 'inline_blueprint',
      lifecycle_key: `blueprint:${blueprintId}`,
      stack_name: null,
      intent_revision_id: 'ir-stale-guard',
      accepted_generation_id: 'gen-stale-guard',
    });
    store.insertGeneration(generation('gen-stale-guard', applicationId));
    store.upsertTarget({
      ...emptyTargetRow(applicationId, nodeId, 1),
      intent_revision_id: 'ir-stale-guard',
      applied_generation_id: 'gen-stale-guard',
      latest_stage: 'blueprint_state_review',
    });

    const held = projectApplication(applicationId, false);
    if (held.targetMode === 'not_applicable') throw new Error('expected application');
    expect(held.targets[0]?.runtime.status).toBe('pending_state_review');

    applyClearStaleGuard(blueprintId, nodeId);

    expect(db.getDeployment(blueprintId, nodeId)).toBeUndefined();
    // Retired, not merely unheld: the node is no longer part of this placement,
    // and a later placement mints a fresh target on first contact.
    expect(store.getTarget(applicationId, nodeId)?.target_status).toBe('tombstoned');
    const after = projectApplication(applicationId, false);
    if (after.targetMode === 'not_applicable') throw new Error('expected application');
    expect(after.facets.placement.status).not.toBe('stateful_confirmation_required');
  });

  it('lets a later hold on the same node reach the projection again', () => {
    // The clear severs the target, and the node can come back: a stale guard is
    // cleared only for a node no longer desired, while a state review is
    // recorded only for a node that is, so the two cannot chase each other. A
    // hold that arrives after a clear has to be visible, or the deployment row
    // says "awaiting confirmation" while the projection says nothing, which is
    // the under-reporting this whole line of work exists to remove.
    const db = DatabaseService.getInstance();
    const store = GitOpsStore.getInstance();
    const nodeId = 1;
    const applicationId = 'app-rehold';
    const created = db.createBlueprint({
      name: `guard-blueprint-rehold-${Date.now()}`,
      description: null,
      compose_content: 'services:\n  web:\n    image: nginx:1.27\n',
      selector: { type: 'nodes', ids: [nodeId] },
      drift_mode: 'observe',
      classification: 'stateful',
      classification_reasons: [],
      enabled: true,
      created_by: null,
    });

    db.upsertDeployment({
      blueprint_id: created.id,
      node_id: nodeId,
      status: 'pending_state_review',
      applied_revision: 1,
      last_deployed_at: null,
      last_checked_at: 1,
      last_drift_at: null,
      drift_summary: null,
      last_error: null,
    } as never);
    store.insertGeneration(generation('gen-rehold', applicationId));
    store.insertApplication({
      ...directLikeApplication(applicationId, created.id),
      intent_revision_id: 'ir-rehold',
      accepted_generation_id: 'gen-rehold',
    });
    store.upsertTarget({
      ...emptyTargetRow(applicationId, nodeId, 1),
      intent_revision_id: 'ir-rehold',
      applied_generation_id: 'gen-rehold',
      latest_stage: 'blueprint_state_review',
    });

    applyClearStaleGuard(created.id, nodeId);
    expect(store.getTarget(applicationId, nodeId)?.target_status).toBe('tombstoned');

    // The node is wanted again, so the reconciler holds it for confirmation once
    // more. This is the re-hold the first version of the retirement lost.
    GitOpsTransitions.getInstance().blueprintObservation({
      applicationId,
      nodeId,
      stage: 'blueprint_state_review',
      envelope: { operationId: 'op-rehold-2', actor: null, trigger: 'reconcile', at: Date.now() },
    });

    expect(store.getTarget(applicationId, nodeId)?.target_status).toBe('active');
    const after = projectApplication(applicationId, false);
    if (after.targetMode === 'not_applicable') throw new Error('expected application');
    expect(after.targets[0]?.runtime.status).toBe('pending_state_review');
    expect(after.facets.placement.status).toBe('stateful_confirmation_required');
  });

  it('refuses to revive a severed target for an observation that only reports', () => {
    // Only the hold re-opens a placement. A drift report about a node nobody
    // wants must not resurrect it, or a retired target would come back to life
    // because the reconciler looked at it.
    const db = DatabaseService.getInstance();
    const store = GitOpsStore.getInstance();
    const nodeId = 1;
    const applicationId = 'app-norevive';
    const created = db.createBlueprint({
      name: `guard-blueprint-norevive-${Date.now()}`,
      description: null,
      compose_content: 'services:\n  web:\n    image: nginx:1.27\n',
      selector: { type: 'nodes', ids: [nodeId] },
      drift_mode: 'observe',
      classification: 'stateful',
      classification_reasons: [],
      enabled: true,
      created_by: null,
    });
    store.insertApplication({
      ...directLikeApplication(applicationId, created.id),
      intent_revision_id: 'ir-norevive',
      accepted_generation_id: 'gen-norevive',
    });
    store.insertGeneration(generation('gen-norevive', applicationId));
    store.upsertTarget({
      ...emptyTargetRow(applicationId, nodeId, 1),
      intent_revision_id: 'ir-norevive',
      applied_generation_id: 'gen-norevive',
      target_status: 'tombstoned',
    });

    expect(() => GitOpsTransitions.getInstance().blueprintObservation({
      applicationId,
      nodeId,
      stage: 'blueprint_drifted',
      envelope: { operationId: 'op-norevive', actor: null, trigger: 'reconcile', at: Date.now() },
    })).toThrow(/cannot observe a tombstoned target/);
    expect(store.getTarget(applicationId, nodeId)?.target_status).toBe('tombstoned');
  });

  it('leaves a deployed target alone, since its hold is not a stale guard', () => {
    const db = DatabaseService.getInstance();
    const nodeId = 1;
    const blueprintId = db.createBlueprint({
      name: `guard-blueprint-deployed-${Date.now()}`,
      description: null,
      compose_content: 'services:\n  web:\n    image: nginx:1.27\n',
      selector: { type: 'nodes', ids: [nodeId] },
      drift_mode: 'observe',
      classification: 'stateless',
      classification_reasons: [],
      enabled: true,
      created_by: null,
    }).id;
    db.upsertDeployment({
      blueprint_id: blueprintId,
      node_id: nodeId,
      status: 'pending_state_review',
      applied_revision: 1,
      last_deployed_at: 12345,
      last_checked_at: 1,
      last_drift_at: null,
      drift_summary: null,
      last_error: null,
    } as never);

    applyClearStaleGuard(blueprintId, nodeId);

    // Still there: this row records a hold on a live deployment, which the
    // operator resolves by confirming or withdrawing, not by clearing a guard.
    expect(db.getDeployment(blueprintId, nodeId)).toBeDefined();
  });
});

function directLikeApplication(id: string, blueprintId: number): import('../services/gitops/types').GitOpsApplicationRow {
  return {
    id,
    lifecycle_key: `blueprint:${blueprintId}`,
    lifecycle_status: 'active',
    target_mode: 'inline_blueprint',
    stack_name: null,
    configured_source_stack_name: null,
    blueprint_id: blueprintId,
    configured_repo_url: null,
    repo_identity_json: null,
    configured_ref: null,
    compose_paths_json: null,
    context_dir: null,
    sync_env: 0,
    env_path: null,
    materialization_fingerprint: null,
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
    intent_revision_id: null,
    rollout_candidate_id: null,
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
    source_policy: 'manual',
    placement_policy: DEFAULT_PLACEMENT_POLICY,
    rollout_authorization_policy: DEFAULT_ROLLOUT_AUTHORIZATION_POLICY,
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
  };
}

function generation(id: string, applicationId: string): import('../services/gitops/types').GitOpsGenerationRow {
  return {
    id,
    application_id: applicationId,
    commit_sha: 'abc123',
    repo_url: 'blueprint://inline',
    configured_ref: 'inline',
    resolved_ref_kind: null,
    repo_identity_json: '{}',
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
    portable_manifest_json: null,
    compose_inputs_json: null,
    source_policy_evidence_json: null,
    security_policy_evidence_json: null,
    support_requirements_json: null,
    compatibility_requirements_json: null,
    secret_capability_json: null,
    created_at: 1,
  };
}