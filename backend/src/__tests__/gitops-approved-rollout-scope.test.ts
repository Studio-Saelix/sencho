/**
 * The approved rollout scope a confirmation is allowed to promise.
 *
 * The property under test is that this reads the placement approval's frozen
 * target set and not the observed target rows. The two disagree whenever
 * placement has moved since the last rollout ran: an approved node no rollout
 * has reached has no row, and a node the Blueprint was withdrawn from keeps
 * one. A confirmation built from the rows would name somewhere the action will
 * not go, which is why the derivation is pinned against both shapes rather than
 * only against the matching case.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions, type EventEnvelope } from '../services/gitops/transitions';
import { deriveGitOpsRevision } from '../services/gitops/derive';
import {
  decodeGitOpsRequiredTargetsJson,
  encodeGitOpsApprovedTargetEffectJson,
  encodeGitOpsRequiredTargetsJson,
} from '../services/gitops/json';
import type {
  GitOpsApplicationRow,
  GitOpsIntentRevisionRow,
  GitOpsRolloutCandidateRow,
} from '../services/gitops/types';

let tmpDir: string;
// The Blueprint column is unique, and these ids read as words rather than
// numbers, so each application takes the next one rather than hashing its name.
let nextBlueprintId = 700;

let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

function envelope(trigger: string): EventEnvelope {
  return { operationId: `op-${trigger}`, actor: 'tester', trigger, at: 1000 };
}

function app(id: string, overrides: Partial<GitOpsApplicationRow> = {}): GitOpsApplicationRow {
  nextBlueprintId += 1;
  return {
    id,
    lifecycle_key: `blueprint:${id}`,
    lifecycle_status: 'active',
    target_mode: 'blueprint',
    stack_name: null,
    configured_source_stack_name: 'source-stack',
    blueprint_id: nextBlueprintId,
    configured_repo_url: `https://example.invalid/${id}.git`,
    repo_identity_json: '{"host":"example.invalid","pathname":"/x.git"}',
    configured_ref: 'main',
    compose_paths_json: '["compose.yaml"]',
    context_dir: null,
    sync_env: 0,
    env_path: null,
    materialization_fingerprint: 'a'.repeat(64),
    desired_commit_sha: 'a'.repeat(40),
    fetched_commit_sha: 'a'.repeat(40),
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
    pause_origin: 'operator',
    source_suspended_reason: null,
    source_policy: 'manual',
    placement_policy: 'operator',
    rollout_authorization_policy: 'manual',
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

function intent(id: string, applicationId: string, blueprintId: number): GitOpsIntentRevisionRow {
  return {
    id,
    application_id: applicationId,
    blueprint_id: blueprintId,
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

/** An application with an intent and a candidate, and no placement approval yet. */
function seed(id: string, requiredNodeIds: number[]): GitOpsApplicationRow {
  const store = GitOpsStore.getInstance();
  const row = app(id);
  store.insertIntentRevision(intent(row.intent_revision_id as string, row.id, row.blueprint_id as number));
  store.insertRolloutCandidate(candidate(row.rollout_candidate_id as string, row.id, row.intent_revision_id as string, requiredNodeIds));
  store.insertApplication(row);
  return row;
}

function approve(
  row: GitOpsApplicationRow,
  nodeIds: number[],
  blast: Array<{ nodeId: number; outcome: 'place' | 'remove' }> = nodeIds.map((nodeId) => ({ nodeId, outcome: 'place' as const })),
): void {
  GitOpsTransitions.getInstance().placementApproved({
    applicationId: row.id,
    approvalId: `${row.id}-place`,
    intentRevisionId: row.intent_revision_id as string,
    blastJson: encodeGitOpsApprovedTargetEffectJson(blast),
    requiredNodeIds: nodeIds,
    fingerprint: null,
    actor: 'tester',
    envelope: envelope(`${row.id}-approve`),
    rolloutGenerationId: `${row.id}-gen`,
    candidateId: row.rollout_candidate_id as string,
    authority: 'operator',
    policyProvenanceJson: null,
  });
}

/** An observed target row, which is what the scope must not be read from. */
function observed(applicationId: string, nodeId: number): void {
  // Written straight through, because the store refuses a target row whose
  // generation it cannot resolve and that invariant is not what this test is
  // about. What matters here is only that a row exists on this node.
  db().prepare(
    `INSERT INTO gitops_target_current (application_id, node_id, target_status, updated_at)
     VALUES (?, ?, 'active', 1)`,
  ).run(applicationId, nodeId);
}

/** The raw handle, for the three cases that corrupt or remove a stored row. */
function db() {
  return DatabaseService.getInstance().getDb();
}

function scope(applicationId: string) {
  const store = GitOpsStore.getInstance();
  const projection = deriveGitOpsRevision(
    {
      application: store.getApplication(applicationId) ?? null,
      targets: store.listTargets(applicationId),
      healthDisabled: false,
    },
    null,
  );
  if (projection.targetMode === 'not_applicable') throw new Error('expected a live projection');
  return projection.approvedRolloutScope;
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  GitOpsStore.resetForTests();
  GitOpsTransitions.resetForTests();
});

afterAll(() => cleanupTestDb(tmpDir));

describe('the approved rollout scope', () => {
  it('names the approved node even when only the old one has an observed target', () => {
    // The failure the audit describes. A ran the Blueprint, placement moved to
    // B, no rollout has run since, so A still has a target row and B has none.
    // Reading the rows would tell the operator this acceptance deploys to A.
    const row = seed('scope-moved', [3]);
    observed(row.id, 1);
    approve(row, [3]);

    expect(scope(row.id)).toEqual({ status: 'approved', approvalRef: `${row.id}-place`, nodeIds: [3] });
  });

  it('reports the first placement as approved even though no target row exists', () => {
    // The other half. An approved-but-unplaced node has no row at all, so a
    // rows-based reader would call an approved first placement "no targets".
    const row = seed('scope-first', [3]);
    approve(row, [3]);

    expect(scope(row.id)).toEqual({ status: 'approved', approvalRef: `${row.id}-place`, nodeIds: [3] });
  });

  it('names every approved node in a multi-node scope', () => {
    const row = seed('scope-many', [1, 3, 4]);
    observed(row.id, 1);
    approve(row, [1, 3, 4]);

    expect(scope(row.id)).toMatchObject({ status: 'approved', nodeIds: [1, 3, 4] });
  });

  it('reports an approved scope of zero nodes rather than dropping the approval', () => {
    // A Blueprint withdrawn from every node still holds a standing approval.
    // Reporting it as approved and empty keeps "approved for nothing" distinct
    // from "not approved", which are different facts with different next steps.
    const row = seed('scope-empty', []);
    observed(row.id, 1);
    approve(row, []);

    expect(scope(row.id)).toEqual({ status: 'approved', approvalRef: `${row.id}-place`, nodeIds: [] });
  });

  it('reports no approval when there is none', () => {
    const row = seed('scope-none', [1]);
    observed(row.id, 1);

    expect(scope(row.id)).toEqual({ status: 'unapproved' });
  });

  it('reports an approval whose row is gone as unresolved, not as approved', () => {
    // The ref survives a row that does not. A reader that trusted the ref would
    // name a scope no dispatch could authorize, which is the same defect as
    // reading the wrong rows.
    const row = seed('scope-dangling', [1]);
    approve(row, [1]);
    db().prepare('DELETE FROM gitops_approvals WHERE id = ?').run(`${row.id}-place`);

    expect(scope(row.id)).toEqual({ status: 'unresolved', approvalRef: `${row.id}-place`, reason: 'approval_does_not_resolve' });
  });

  it('reports a live approval whose blast no longer matches the frozen set as unresolved', () => {
    // The other half of a stale approval, and the one that does not need a
    // deleted row to reach. The approval still resolves as an approval, but it
    // does not stand for the set the candidate froze, so it names no scope.
    const row = seed('scope-blast-mismatch', [1, 3]);
    approve(row, [1, 3]);
    // The approval still places 1 and 3 while the candidate's frozen set has
    // narrowed to 1, so the blast names a node the required set does not
    // contain. `placementEffectCompatible` refuses that pairing, and so does
    // the dispatch boundary: naming [1] here would be a scope nothing can
    // authorize against.
    db().prepare('UPDATE gitops_rollout_candidates SET required_targets_json = ? WHERE id = ?')
      .run(encodeGitOpsRequiredTargetsJson([1]), row.rollout_candidate_id);

    expect(scope(row.id)).toEqual({ status: 'unresolved', approvalRef: `${row.id}-place`, reason: 'approval_does_not_resolve' });
  });

  it('reports unreadable required targets as unresolved, naming the evidence', () => {
    // The same distinction one level down: the approval resolves, but the
    // candidate's frozen set does not decode, so no scope is proven.
    const row = seed('scope-corrupt', [1]);
    approve(row, [1]);
    db().prepare('UPDATE gitops_rollout_candidates SET required_targets_json = ? WHERE id = ?')
      .run('{not json', row.rollout_candidate_id);

    expect(scope(row.id)).toEqual({ status: 'unresolved', approvalRef: `${row.id}-place`, reason: 'unreadable_required_targets' });
  });

  it('reports a missing candidate as unresolved rather than naming the approval alone', () => {
    const row = seed('scope-no-candidate', [1]);
    approve(row, [1]);
    db().prepare('DELETE FROM gitops_rollout_candidates WHERE id = ?').run(row.rollout_candidate_id);

    expect(scope(row.id)).toEqual({ status: 'unresolved', approvalRef: `${row.id}-place`, reason: 'no_candidate' });
  });

  it('reports not applicable for a Direct application, which has no placement', () => {
    // The Direct shape has no placement and no rollout, so it carries no scope
    // at all rather than an empty approved one. A confirmation reading this
    // says nothing about a rollout, which is the truth for a Direct stack.
    const store = GitOpsStore.getInstance();
    store.insertApplication(app('scope-direct', {
      target_mode: 'direct',
      stack_name: 'direct-stack',
      blueprint_id: null,
    }));

    expect(scope('scope-direct')).toEqual({ status: 'not_applicable' });
  });

  it('reports the same required set the dispatch boundary resolves against', () => {
    // The reader is only worth having if it names what execution uses.
    // `store.authorizationIngredients` hands the dispatch boundary
    // `requiredNodeIds` decoded from the candidate's frozen target set, and
    // validates the placement approval against exactly that set, so this
    // compares the projected scope against the same decode rather than
    // restating the node ids the fixture was seeded with.
    const row = seed('scope-agrees', [2, 3]);
    approve(row, [2, 3]);
    const frozen = GitOpsStore.getInstance().getRolloutCandidate(row.rollout_candidate_id as string);
    const reported = scope(row.id);

    expect(reported.status).toBe('approved');
    if (reported.status !== 'approved') throw new Error('expected an approved scope');
    expect(reported.nodeIds).toEqual(decodeGitOpsRequiredTargetsJson(frozen!.required_targets_json).nodeIds);
  });
});
