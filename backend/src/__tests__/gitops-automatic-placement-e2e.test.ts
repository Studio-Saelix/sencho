/**
 * The automatic placement path, end to end.
 *
 * The pure decision is covered exhaustively elsewhere. What this file proves is
 * the part that only shows up when the real evidence is gathered: that a
 * bounded_auto application actually reaches an approval, and that each refusal
 * reason is reachable from real state rather than only from a hand-built input.
 *
 * The first version of this could not reach `auto_approved` at all. Node
 * evidence was read from the target row, which an added node does not have and
 * never will until the placement lands, so every addition resolved to unknown
 * and the feature was inert. Node health for an addition comes from the node
 * registry, and a removal is judged by the observation of the workload that ran
 * there.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions } from '../services/gitops/transitions';
import { applyAutomaticPlacement } from '../services/gitops/automaticPlacement';
import { projectApplication } from '../services/gitops/derive';
import { stackManagedRoot } from '../services/gitops/directApplication';
import { emptyTargetRow } from '../services/gitops/store';
import { decodeApprovalPolicySnapshot } from '../services/gitops/policyComposition';
import {
  encodeGitOpsApprovedTargetEffectJson,
  encodeGitOpsRequiredTargetsJson,
} from '../services/gitops/json';
import type { GitOpsApplicationRow, GitOpsGenerationRow } from '../services/gitops/types';

let tmpDir: string;

/** Write the staged compose a generation would carry, so it can be read back. */
/**
 * Stage compose content where generations actually live.
 *
 * Under the application's own source stack identity, which is what the source
 * path reads. Staging under the Blueprint's `deploy_stack_name` made the
 * placement decision look correct while it was reading a directory the source
 * path never writes to, and that is how a renamed stack went unnoticed.
 */
function writeComposeInto(
  stackName: string,
  dir: string,
  compose: string,
  composePaths: readonly string[],
): void {
  const base = path.resolve(stackManagedRoot(stackName), dir);
  fs.mkdirSync(base, { recursive: true });
  for (const local of composePaths) {
    fs.mkdirSync(path.dirname(path.join(base, local)), { recursive: true });
    fs.writeFileSync(path.join(base, local), compose, 'utf8');
  }
}

/**
 * Stage a generation the way one that has been promoted exists on disk.
 *
 * Promotion removes the applied directory and renames the candidate over it, so
 * a promoted generation has content under the applied directory and nothing at
 * all under the candidate path its row still names. Staging only the candidate,
 * as this file did for every case, describes a generation that has been accepted
 * but not yet promoted, which is the narrowest window in the whole lifecycle and
 * the one an install spends least time in. A reader resolving only the candidate
 * passed every test here and then found nothing on every real generation.
 */
function writeStagedCompose(
  stackName: string,
  generationId: string,
  compose: string,
  composePaths: readonly string[] = ['compose.yaml'],
): string {
  const candidateDir = `generations/candidate-${generationId}`;
  writeComposeInto(stackName, candidateDir, compose, composePaths);
  return candidateDir;
}

function writePromotedCompose(
  stackName: string,
  generationId: string,
  compose: string,
  composePaths: readonly string[] = ['compose.yaml'],
): { candidateDir: string; appliedDir: string } {
  const candidateDir = `generations/candidate-${generationId}`;
  const appliedDir = `generations/applied-${generationId}-0`;
  // Only the applied directory exists. The candidate path is left absent on
  // purpose, because that is what the rename leaves behind.
  writeComposeInto(stackName, appliedDir, compose, composePaths);
  return { candidateDir, appliedDir };
}

function generation(id: string, applicationId: string, candidateDir: string, appliedDir?: string): GitOpsGenerationRow {
  return {
    id,
    application_id: applicationId,
    commit_sha: 'c'.repeat(40),
    repo_url: 'https://example.invalid/x.git',
    resolved_ref_kind: 'branch',
    configured_ref: 'main',
    repo_identity_json: '{"host":"example.invalid","pathname":"/x.git"}',
    manifest_version: 0,
    candidate_dir: candidateDir,
    applied_dir: appliedDir ?? `generations/applied-${id}-0`,
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

function application(overrides: Partial<GitOpsApplicationRow>): GitOpsApplicationRow {
  const id = overrides.id ?? `app-${randomUUID().slice(0, 8)}`;
  return {
    id,
    lifecycle_key: `blueprint:${id}`,
    lifecycle_status: 'active',
    target_mode: 'blueprint',
    stack_name: null,
    configured_source_stack_name: `src-${id}`,
    blueprint_id: Number(id.replace(/\D/g, '').slice(0, 6)) + 7000,
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
    pause_origin: 'operator',
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

function addNode(name: string, cordoned = false): number {
  const db = DatabaseService.getInstance().getDb();
  const result = db
    .prepare(
      `INSERT INTO nodes (name, type, mode, compose_dir, is_default, status, cordoned, created_at)
       VALUES (?, 'local', 'proxy', ?, 0, 'online', ?, ?)`,
    )
    .run(name, path.join(tmpDir, 'compose'), cordoned ? 1 : 0, Date.now());
  return result.lastInsertRowid as number;
}

function seed(opts: {
  compose?: string;
  nodeIds: number[];
  cordoned?: boolean;
  accepted?: boolean;
  /** The multi-file shape, which is analyzed one file at a time. */
  composePaths?: readonly string[];
  /** Stage the generation as promoted: content under applied_dir only. */
  promoted?: boolean;
}): GitOpsApplicationRow {
  const store = GitOpsStore.getInstance();
  const app = application({
    accepted_generation_id: null,
    compose_paths_json: JSON.stringify(opts.composePaths ?? ['compose.yaml']),
  });
  const generationId = `gen-${randomUUID().slice(0, 8)}`;
  // The Blueprint's own name, which is deliberately not where generations are
  // staged: a Blueprint can be renamed, and the directory the source path writes
  // follows the stack, not the Blueprint.
  const deployStackName = `bp-${app.id}`;
  const stagedStackName = app.configured_source_stack_name ?? deployStackName;
  const compose = opts.compose ?? 'services:\n  web:\n    image: nginx:1.25\n';
  const composePaths = opts.composePaths ?? ['compose.yaml'];
  const dirs = opts.promoted
    ? writePromotedCompose(stagedStackName, generationId, compose, composePaths)
    : { candidateDir: writeStagedCompose(stagedStackName, generationId, compose, composePaths), appliedDir: undefined };
  if (opts.accepted !== false) {
    app.accepted_generation_id = generationId;
  }
  // The application row first: the transitions are single-writer and refuse an
  // application they cannot read.
  store.insertApplication(app);
  GitOpsTransitions.getInstance().intentRevised({
    applicationId: app.id,
    intent: {
      id: `${app.id}-intent`,
      application_id: app.id,
      blueprint_id: app.blueprint_id!,
      compose_content_sha256: 'b'.repeat(64),
      blueprint_revision: 1,
      deploy_stack_name: `bp-${app.id}`,
      selector_json: '{"labels":{}}',
      pinned_node_id: null,
      cordon_implications_json: '{"pinnedOverridesCordon":false}',
      rollout_strategy_json: '{"driftMode":"observe","enabled":true}',
      runtime_drift_policy: 'observe',
      stateful_policy_json: null,
      health_failure_rollback_policy_json: null,
      operation_id: `op-${app.id}`,
      actor: 'tester',
      created_at: 1,
    },
    envelope: { operationId: `op-${app.id}`, actor: 'tester', trigger: 'test', at: 1 },
  });
  GitOpsTransitions.getInstance().rolloutCandidateOpened({
    applicationId: app.id,
    candidate: {
      id: `${app.id}-cand`,
      application_id: app.id,
      intent_revision_id: `${app.id}-intent`,
      compose_content_sha256: 'b'.repeat(64),
      accepted_generation_id: null,
      artifact_set_id: null,
      required_targets_json: encodeGitOpsRequiredTargetsJson(opts.nodeIds),
      authoritative: 1,
      provenance: 'roster_change',
      operation_id: `op-${app.id}`,
      created_at: 1,
    },
    envelope: { operationId: `op-${app.id}`, actor: 'tester', trigger: 'test', at: 1 },
  });
  store.insertGeneration(generation(generationId, app.id, dirs.candidateDir, dirs.appliedDir));
  void opts.cordoned;
  return app;
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  GitOpsStore.resetForTests();
  GitOpsTransitions.resetForTests();
});

afterAll(() => cleanupTestDb(tmpDir));

describe('a bounded_auto application reaches an approval', () => {
  it('approves one stateless addition and records the policy that decided it', () => {
    const nodeId = addNode(`n-${randomUUID().slice(0, 6)}`);
    const app = seed({ nodeIds: [nodeId] });

    const outcome = applyAutomaticPlacement(app.id, {
      operationId: 'op-auto-1', actor: null, trigger: 'test', at: 2,
    });

    expect(outcome).toEqual({ status: 'auto_approved', reason: 'stateless_addition' });

    const store = GitOpsStore.getInstance();
    const live = store.getApplication(app.id)!;
    // A first placement of exactly one node is an ordinary single addition.
    expect(live.placement_approval_ref).toBeTruthy();

    const approval = store.getApproval(live.placement_approval_ref!)!;
    expect(approval.authority).toBe('configured_policy');
    // The decision is attributable: the snapshot that authorized it is on the
    // record, not only on the generation.
    expect(decodeApprovalPolicySnapshot(approval.policy_provenance_json)).toMatchObject({
      placement: 'bounded_auto',
    });
  });

  it('refuses an addition onto a node that is not answering', () => {
    const db = DatabaseService.getInstance().getDb();
    const nodeId = addNode(`n-${randomUUID().slice(0, 6)}`);
    db.prepare("UPDATE nodes SET status = 'offline' WHERE id = ?").run(nodeId);
    const app = seed({ nodeIds: [nodeId] });

    const outcome = applyAutomaticPlacement(app.id, {
      operationId: 'op-auto-2', actor: null, trigger: 'test', at: 2,
    });
    expect(outcome).toEqual({ status: 'operator_review', reason: 'stale_node' });
    expect(GitOpsStore.getInstance().getApplication(app.id)!.placement_approval_ref).toBeNull();
  });

  it('refuses an addition onto a cordoned node', () => {
    const nodeId = addNode(`n-${randomUUID().slice(0, 6)}`, true);
    const app = seed({ nodeIds: [nodeId] });

    const outcome = applyAutomaticPlacement(app.id, {
      operationId: 'op-auto-3', actor: null, trigger: 'test', at: 2,
    });
    expect(outcome).toEqual({ status: 'operator_review', reason: 'cordon_override' });
    expect(GitOpsStore.getInstance().getApplication(app.id)!.placement_approval_ref).toBeNull();
  });

  it('refuses a stateful workload, read from the compose rather than a column', () => {
    const nodeId = addNode(`n-${randomUUID().slice(0, 6)}`);
    const app = seed({
      nodeIds: [nodeId],
      compose: 'services:\n  db:\n    image: postgres:16\n    volumes:\n      - data:/var/lib/postgresql\n',
    });

    const outcome = applyAutomaticPlacement(app.id, {
      operationId: 'op-auto-4', actor: null, trigger: 'test', at: 2,
    });
    expect(outcome).toEqual({ status: 'operator_review', reason: 'stateful_workload' });
    expect(GitOpsStore.getInstance().getApplication(app.id)!.placement_approval_ref).toBeNull();
    // Recorded, because otherwise the review this left behind has no stated
    // reason and a policy set to automatic looks like one that never fires.
    const recorded = GitOpsStore.getInstance().getApplication(app.id)!;
    expect(recorded.placement_policy_refusal_reason).toBe('stateful_workload');
    expect(recorded.placement_policy_refused_at).toBe(2);
  });

  it('does not drain a node that was cordoned', () => {
    // The finding this pins. Cordoning a node removed it from the candidate set,
    // and a single stateless removal is inside what the policy may approve, so
    // one cordon silently stopped the workload running there. The operator who
    // cordoned a node has said where work may not go; they have not said the
    // workload there should stop.
    const kept = addNode(`n-${randomUUID().slice(0, 6)}`);
    const cordoned = addNode(`n-${randomUUID().slice(0, 6)}`);
    const app = seed({ nodeIds: [kept, cordoned], compose: 'services:\n  web:\n    image: nginx:1.25\n' });

    // A hand-approved baseline over both nodes, so there is something to withdraw from.
    GitOpsTransitions.getInstance().placementApproved({
      applicationId: app.id,
      approvalId: 'place-baseline',
      intentRevisionId: GitOpsStore.getInstance().getApplication(app.id)!.intent_revision_id!,
      blastJson: encodeGitOpsApprovedTargetEffectJson([
        { nodeId: kept, outcome: 'place' as const },
        { nodeId: cordoned, outcome: 'place' as const },
      ]),
      requiredNodeIds: [kept, cordoned],
      fingerprint: null,
      actor: 'tester',
      envelope: { operationId: 'op-cordon-base', actor: 'tester', trigger: 'test', at: 2 },
      rolloutGenerationId: 'rgen-cordon',
      candidateId: GitOpsStore.getInstance().getApplication(app.id)!.rollout_candidate_id!,
      authority: 'operator',
      policyProvenanceJson: null,
    });

    DatabaseService.getInstance().getDb()
      .prepare('UPDATE nodes SET cordoned = 1 WHERE id = ?')
      .run(cordoned);
    // A new intent, because the cordon moved the desired set and an intent
    // revision is what records that. Reusing the old row would collide on its id.
    const previous = GitOpsStore.getInstance().getIntentRevision(
      GitOpsStore.getInstance().getApplication(app.id)!.intent_revision_id!,
    )!;
    GitOpsTransitions.getInstance().intentRevised({
      applicationId: app.id,
      intent: { ...previous, id: 'intent-after-cordon', operation_id: 'op-cordon-2' },
      envelope: { operationId: 'op-cordon-2', actor: 'tester', trigger: 'test', at: 3 },
    });
    GitOpsTransitions.getInstance().rolloutCandidateOpened({
      applicationId: app.id,
      candidate: {
        id: 'cand-after-cordon',
        application_id: app.id,
        intent_revision_id: 'intent-after-cordon',
        required_targets_json: encodeGitOpsRequiredTargetsJson([kept]),
        compose_content_sha256: 'a'.repeat(64),
        accepted_generation_id: null,
        artifact_set_id: null,
        authoritative: 1,
        provenance: 'roster_change',
        created_at: 3,
        operation_id: 'op-cordon-2',
      } as never,
      envelope: { operationId: 'op-cordon-2', actor: 'tester', trigger: 'test', at: 3 },
    });

    const outcome = applyAutomaticPlacement(app.id, { operationId: 'op-cordon-3', actor: null, trigger: 'test', at: 4 });
    expect(outcome).toEqual({ status: 'operator_review', reason: 'cordon_driven_removal' });
    // No second approval exists. The intent revision cleared the pointer, which
    // is its own documented behavior, so the claim is about the approval history
    // rather than the pointer: the cordon produced a review, not an approval.
    expect(GitOpsStore.getInstance().hasPlacementApprovalFor(app.id, 'intent-after-cordon', 'cand-after-cordon')).toBe(false);
  });

  it('still approves a withdrawal of a node that is not cordoned', async () => {
    // The other half of the cordon refusal, and the part only this level can
    // pin. A pure decision test passes the flag in directly, so it cannot catch a
    // caller that sets it for every removal rather than for a cordoned one. That
    // would refuse every withdrawal the Blueprint asked for on its own, which is
    // the policy's whole purpose.
    const kept = addNode(`n-${randomUUID().slice(0, 6)}`);
    const withdrawn = addNode(`n-${randomUUID().slice(0, 6)}`);
    const app = seed({ nodeIds: [kept, withdrawn], compose: 'services:\n  web:\n    image: nginx:1.25\n' });
    const store = GitOpsStore.getInstance();

    GitOpsTransitions.getInstance().placementApproved({
      applicationId: app.id,
      approvalId: 'place-both',
      intentRevisionId: store.getApplication(app.id)!.intent_revision_id!,
      blastJson: encodeGitOpsApprovedTargetEffectJson([
        { nodeId: kept, outcome: 'place' as const },
        { nodeId: withdrawn, outcome: 'place' as const },
      ]),
      requiredNodeIds: [kept, withdrawn],
      fingerprint: null,
      actor: 'tester',
      envelope: { operationId: 'op-wd-base', actor: 'tester', trigger: 'test', at: 1 },
      rolloutGenerationId: 'rgen-wd',
      candidateId: store.getApplication(app.id)!.rollout_candidate_id!,
      authority: 'operator',
      policyProvenanceJson: null,
    });

    // The withdrawn node must read as reachable: a removal is judged by the
    // observation of the workload that ran there, and a node with no observation
    // is unknown, which is its own refusal.
    store.upsertTarget({
      ...emptyTargetRow(app.id, withdrawn, 1),
      target_status: 'active',
      connectivity: 'reachable',
    });
    // Neither node is cordoned, and the Blueprint itself now asks for one of them.
    const previous = store.getIntentRevision(store.getApplication(app.id)!.intent_revision_id!)!;
    GitOpsTransitions.getInstance().intentRevised({
      applicationId: app.id,
      intent: { ...previous, id: 'intent-wd', operation_id: 'op-wd-2' },
      envelope: { operationId: 'op-wd-2', actor: 'tester', trigger: 'test', at: 2 },
    });
    GitOpsTransitions.getInstance().rolloutCandidateOpened({
      applicationId: app.id,
      candidate: {
        id: 'cand-wd',
        application_id: app.id,
        intent_revision_id: 'intent-wd',
        required_targets_json: encodeGitOpsRequiredTargetsJson([kept]),
        compose_content_sha256: 'a'.repeat(64),
        accepted_generation_id: null,
        artifact_set_id: null,
        authoritative: 1,
        provenance: 'roster_change',
        created_at: 2,
        operation_id: 'op-wd-2',
      } as never,
      envelope: { operationId: 'op-wd-2', actor: 'tester', trigger: 'test', at: 2 },
    });

    const outcome = applyAutomaticPlacement(app.id, { operationId: 'op-wd-3', actor: null, trigger: 'test', at: 3 });
    expect(outcome).toEqual({ status: 'auto_approved', reason: 'stateless_removal' });
    expect(store.hasPlacementApprovalFor(app.id, 'intent-wd', 'cand-wd')).toBe(true);
  });

  it('does not read a migrated application as a first placement', () => {
    // The migration that carries a forward approval records a pre-decomposition
    // row, which names no target set. With no decomposed approval to read, the
    // baseline fell back to the running targets and reported no prior approval,
    // so every removal that left more than one node was refused as a first
    // placement. For ever, on exactly the installations the migration was for.
    const kept = addNode(`n-${randomUUID().slice(0, 6)}`);
    const alsoKept = addNode(`n-${randomUUID().slice(0, 6)}`);
    const withdrawn = addNode(`n-${randomUUID().slice(0, 6)}`);
    const app = seed({ nodeIds: [kept, alsoKept, withdrawn], compose: 'services:\n  web:\n    image: nginx:1.25\n' });
    const store = GitOpsStore.getInstance();

    // The carried-forward row, with no placement_approval beside it.
    store.insertApproval({
      id: 'legacy-combined',
      kind: 'legacy_combined',
      authority: 'legacy_combined',
      authoritative: 0,
      application_id: app.id,
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
      actor: null,
      created_at: 1,
    } as never);
    for (const nodeId of [kept, alsoKept, withdrawn]) {
      store.upsertTarget({ ...emptyTargetRow(app.id, nodeId, 1), target_status: 'active', connectivity: 'reachable' });
    }

    const previous = store.getIntentRevision(store.getApplication(app.id)!.intent_revision_id!)!;
    GitOpsTransitions.getInstance().intentRevised({
      applicationId: app.id,
      intent: { ...previous, id: 'intent-narrow', operation_id: 'op-narrow' },
      envelope: { operationId: 'op-narrow', actor: 'tester', trigger: 'test', at: 2 },
    });
    GitOpsTransitions.getInstance().rolloutCandidateOpened({
      applicationId: app.id,
      candidate: {
        id: 'cand-narrow',
        application_id: app.id,
        intent_revision_id: 'intent-narrow',
        required_targets_json: encodeGitOpsRequiredTargetsJson([kept, alsoKept]),
        compose_content_sha256: 'a'.repeat(64),
        accepted_generation_id: null,
        artifact_set_id: null,
        authoritative: 1,
        provenance: 'roster_change',
        created_at: 2,
        operation_id: 'op-narrow',
      } as never,
      envelope: { operationId: 'op-narrow', actor: 'tester', trigger: 'test', at: 2 },
    });

    // Two nodes left, so the first-placement rule would fire if this were read
    // as a first placement.
    const outcome = applyAutomaticPlacement(app.id, { operationId: 'op-narrow-2', actor: null, trigger: 'test', at: 3 });
    expect(outcome).toEqual({ status: 'auto_approved', reason: 'stateless_removal' });
  });

  it('reads an application with no approval at all as never having been placed', () => {
    // The other half, asserted on the reader the decision depends on rather than
    // through a refusal that has several other possible causes. The fix must not
    // turn a genuine first placement into something the policy may approve.
    const app = seed({ nodeIds: [1], compose: 'services:\n  web:\n    image: nginx:1.25\n' });
    expect(GitOpsStore.getInstance().hasEverHadPlacementAuthority(app.id)).toBe(false);
  });

  it('approves a stateless addition on a Blueprint whose name is not its stack', async () => {
    // The renamed-stack case. Generations are staged under the application's
    // source stack while the Blueprint carries its own name, so reading through
    // the Blueprint's name found no content and every placement on a renamed
    // stack read as an unknown workload.
    const nodeId = addNode(`n-${randomUUID().slice(0, 6)}`);
    const app = seed({ nodeIds: [nodeId], compose: 'services:\n  web:\n    image: nginx:1.25\n' });
    expect(app.configured_source_stack_name).not.toBe(`bp-${app.id}`);

    const outcome = applyAutomaticPlacement(app.id, { operationId: 'op-renamed', actor: null, trigger: 'test', at: 1 });
    expect(outcome).toEqual({ status: 'auto_approved', reason: 'stateless_addition' });
  });

  it('approves a stateless addition from a multi-file compose', async () => {
    // The multi-file case. Concatenating the files put the same service key in
    // one document twice, which does not parse, so a multi-file project always
    // read as an unknown workload and the policy could never approve it.
    const nodeId = addNode(`n-${randomUUID().slice(0, 6)}`);
    const app = seed({
      nodeIds: [nodeId],
      compose: 'services:\n  web:\n    image: nginx:1.25\n',
      composePaths: ['compose.yaml', 'compose.override.yaml'],
    });

    const outcome = applyAutomaticPlacement(app.id, { operationId: 'op-multifile', actor: null, trigger: 'test', at: 1 });
    expect(outcome).toEqual({ status: 'auto_approved', reason: 'stateless_addition' });
  });

  it('still refuses a multi-file compose when one file is stateful', async () => {
    // The other half of the per-file loop: analyzing files separately must not
    // become analyzing only the first one.
    const nodeId = addNode(`n-${randomUUID().slice(0, 6)}`);
    const app = seed({
      nodeIds: [nodeId],
      compose: 'services:\n  web:\n    image: nginx:1.25\n',
      composePaths: ['compose.yaml', 'compose.override.yaml'],
    });
    // Put a volume in the second file only.
    const dir = path.resolve(
      stackManagedRoot(app.configured_source_stack_name!),
      `generations/candidate-${app.accepted_generation_id}`,
      'compose.override.yaml',
    );
    fs.writeFileSync(
      dir,
      'services:\n  db:\n    image: postgres:16\n    volumes:\n      - data:/var/lib\n',
      'utf8',
    );

    const outcome = applyAutomaticPlacement(app.id, { operationId: 'op-multifile-2', actor: null, trigger: 'test', at: 1 });
    expect(outcome).toEqual({ status: 'operator_review', reason: 'stateful_workload' });
  });

  it('approves a stateless addition on a generation that has already been promoted', () => {
    // The steady-state case, and the one bounded-auto exists for. Promotion
    // renames the candidate directory over the applied one, so a promoted
    // generation has no candidate directory at all. Reading only the candidate
    // meant every placement after the first rollout read as an unknown workload,
    // and the feature only worked between source acceptance and the first
    // promotion.
    const nodeId = addNode(`n-${randomUUID().slice(0, 6)}`);
    const app = seed({ nodeIds: [nodeId], compose: 'services:\n  web:\n    image: nginx:1.25\n', promoted: true });
    const generationDir = path.resolve(
      stackManagedRoot(app.configured_source_stack_name!),
      `generations/candidate-${app.accepted_generation_id}`,
    );
    expect(fs.existsSync(generationDir)).toBe(false);

    const outcome = applyAutomaticPlacement(app.id, { operationId: 'op-promoted', actor: null, trigger: 'test', at: 1 });
    expect(outcome).toEqual({ status: 'auto_approved', reason: 'stateless_addition' });
  });

  it('still refuses a stateful workload on a promoted generation', () => {
    // The other half, so the applied-first read cannot become "anything goes".
    const nodeId = addNode(`n-${randomUUID().slice(0, 6)}`);
    const app = seed({
      nodeIds: [nodeId],
      compose: 'services:\n  db:\n    image: postgres:16\n    volumes:\n      - data:/var/lib\n',
      promoted: true,
    });

    const outcome = applyAutomaticPlacement(app.id, { operationId: 'op-promoted-stateful', actor: null, trigger: 'test', at: 1 });
    expect(outcome).toEqual({ status: 'operator_review', reason: 'stateful_workload' });
  });

  it('reads a promoted generation rather than an unpromoted candidate when both exist', () => {
    // The applied copy is what a target would receive, so it is the copy that
    // decides. A candidate still sitting beside it has not been promoted and
    // describes something no target is running.
    const nodeId = addNode(`n-${randomUUID().slice(0, 6)}`);
    const app = seed({ nodeIds: [nodeId], promoted: true });
    const generationId = app.accepted_generation_id!;
    // The in-force copy is stateless, and a stateless candidate is staged beside it.
    writeComposeInto(
      app.configured_source_stack_name!,
      `generations/candidate-${generationId}`,
      'services:\n  web:\n    image: nginx:1.25\n',
      ['compose.yaml'],
    );
    fs.writeFileSync(path.resolve(
      stackManagedRoot(app.configured_source_stack_name!),
      `generations/applied-${generationId}-0`,
      'compose.yaml',
    ), 'services:\n  db:\n    image: postgres:16\n    volumes:\n      - data:/var/lib\n', 'utf8');

    const outcome = applyAutomaticPlacement(app.id, { operationId: 'op-both', actor: null, trigger: 'test', at: 1 });
    expect(outcome).toEqual({ status: 'operator_review', reason: 'stateful_workload' });
  });

  it('refuses an addition while one of its targets is mid-deploy', async () => {
    // A sequential rollout sets its stage on the target, not on the application,
    // so a check reading only the application pointer could approve a placement
    // mid-deploy, clear the authorization, and supersede the generation that
    // deploy was running under.
    const nodeId = addNode(`n-${randomUUID().slice(0, 6)}`);
    const other = addNode(`n-${randomUUID().slice(0, 6)}`);
    const app = seed({ nodeIds: [nodeId, other], compose: 'services:\n  web:\n    image: nginx:1.25\n' });
    const store = GitOpsStore.getInstance();
    store.upsertTarget({
      ...emptyTargetRow(app.id, other, 1),
      target_status: 'active',
      active_operation_stage: 'blueprint_deploy_started',
      active_operation_id: 'op-deploy',
    });

    const outcome = applyAutomaticPlacement(app.id, { operationId: 'op-inflight', actor: null, trigger: 'test', at: 1 });
    expect(outcome).toEqual({ status: 'operator_review', reason: 'conflicting_operation' });
    expect(store.getApplication(app.id)!.placement_approval_ref).toBeNull();
  });

  it('refuses an addition while one of its targets is awaiting a health verdict', () => {
    // The half of the same window the stage cannot see. The apply lands and the
    // ack clears the stage, so a health-gated rollout spends the rest of its
    // observation window acked-but-unsettled: no stage, and a health run the
    // fleet is still waiting on. Approving here supersedes a rollout that has
    // not finished, which is what stops a gated rollout part-way across a fleet.
    //
    // The pointer is the evidence, so the pointer is what the fixture sets. The
    // run behind it is what the startup reconciliation reads back, and that path
    // is covered against real reservations in the rollout suite.
    const nodeId = addNode(`n-${randomUUID().slice(0, 6)}`);
    const other = addNode(`n-${randomUUID().slice(0, 6)}`);
    const app = seed({ nodeIds: [nodeId, other], compose: 'services:\n  web:\n    image: nginx:1.25\n' });
    const store = GitOpsStore.getInstance();
    store.upsertTarget({
      ...emptyTargetRow(app.id, other, 1),
      target_status: 'active',
      latest_stage: 'blueprint_ack_recorded',
      pending_health_run_id: `run-${randomUUID()}`,
    });

    const outcome = applyAutomaticPlacement(app.id, { operationId: 'op-awaiting-verdict', actor: null, trigger: 'test', at: 1 });
    expect(outcome).toEqual({ status: 'operator_review', reason: 'conflicting_operation' });
    expect(store.getApplication(app.id)!.placement_approval_ref).toBeNull();
    expect(store.getApplication(app.id)!.placement_policy_refusal_reason).toBe('conflicting_operation');
  });

  it('records no reason when it approves, so nothing is left to explain', () => {
    // The opposite direction. A reason left on an approved application would be
    // read as the explanation for whatever review comes next.
    const nodeId = addNode(`n-${randomUUID().slice(0, 6)}`);
    const app = seed({ nodeIds: [nodeId], compose: 'services:\n  web:\n    image: nginx:1.25\n' });

    const outcome = applyAutomaticPlacement(app.id, {
      operationId: 'op-auto-clean', actor: null, trigger: 'test', at: 3,
    });
    expect(outcome.status).toBe('auto_approved');
    const recorded = GitOpsStore.getInstance().getApplication(app.id)!;
    expect(recorded.placement_approval_ref).not.toBeNull();
    expect(recorded.placement_policy_refusal_reason).toBeNull();
    expect(recorded.placement_policy_refused_at).toBeNull();
  });

  it('refuses a first placement across two nodes before considering its size', () => {
    const first = addNode(`n-${randomUUID().slice(0, 6)}`);
    const second = addNode(`n-${randomUUID().slice(0, 6)}`);
    const app = seed({ nodeIds: [first, second] });

    const outcome = applyAutomaticPlacement(app.id, {
      operationId: 'op-auto-5', actor: null, trigger: 'test', at: 2,
    });
    // The widest thing this policy could be asked to approve, so it is refused
    // ahead of the cardinality rule rather than by it.
    expect(outcome).toEqual({ status: 'operator_review', reason: 'first_multi_node_placement' });
  });

  it('refuses two additions once something has already been approved', () => {
    const first = addNode(`n-${randomUUID().slice(0, 6)}`);
    const app = seed({ nodeIds: [first] });
    expect(
      applyAutomaticPlacement(app.id, { operationId: 'op-seed-a', actor: null, trigger: 'test', at: 2 }),
    ).toEqual({ status: 'auto_approved', reason: 'stateless_addition' });

    // The approved set already holds one node, so the change is whatever else
    // the candidate adds. One more would be a single addition and is allowed;
    // two at once is the case the bound exists for.
    const second = addNode(`n-${randomUUID().slice(0, 6)}`);
    const third = addNode(`n-${randomUUID().slice(0, 6)}`);
    // The transition owns the insert, so the row is handed to it rather than
    // written first.
    GitOpsTransitions.getInstance().intentRevised({
      applicationId: app.id,
      intent: {
        id: `${app.id}-intent-2`, application_id: app.id, blueprint_id: app.blueprint_id!,
        compose_content_sha256: 'b'.repeat(64), blueprint_revision: 1,
        deploy_stack_name: `bp-${app.id}`, selector_json: '{"labels":{}}', pinned_node_id: null,
        cordon_implications_json: '{"pinnedOverridesCordon":false}',
        rollout_strategy_json: '{}', runtime_drift_policy: 'observe', stateful_policy_json: null,
        health_failure_rollback_policy_json: null, operation_id: 'op-i2', actor: 'tester', created_at: 2,
      },
      envelope: { operationId: 'op-i2', actor: 'tester', trigger: 'test', at: 2 },
    });
    GitOpsTransitions.getInstance().rolloutCandidateOpened({
      applicationId: app.id,
      candidate: {
        id: `${app.id}-cand-2`, application_id: app.id, intent_revision_id: `${app.id}-intent-2`,
        compose_content_sha256: 'b'.repeat(64), accepted_generation_id: null, artifact_set_id: null,
        required_targets_json: encodeGitOpsRequiredTargetsJson([first, second, third]),
        authoritative: 1, provenance: 'roster_change', operation_id: 'op-i2', created_at: 2,
      },
      envelope: { operationId: 'op-i2', actor: 'tester', trigger: 'test', at: 2 },
    });

    const outcome = applyAutomaticPlacement(app.id, {
      operationId: 'op-auto-5b', actor: null, trigger: 'test', at: 3,
    });
    expect(outcome).toEqual({ status: 'operator_review', reason: 'multiple_additions' });
  });

  it('refuses when the workload is unreadable rather than reading it as stateless', () => {
    const nodeId = addNode(`n-${randomUUID().slice(0, 6)}`);
    const app = seed({ nodeIds: [nodeId], compose: 'services: [this is not: valid: yaml' });

    const outcome = applyAutomaticPlacement(app.id, {
      operationId: 'op-auto-6', actor: null, trigger: 'test', at: 2,
    });
    expect(outcome).toMatchObject({ status: 'operator_review', reason: 'unknown_workload' });
  });

  it('refuses when there is no accepted generation to read compose from', () => {
    const nodeId = addNode(`n-${randomUUID().slice(0, 6)}`);
    const app = seed({ nodeIds: [nodeId], accepted: false });

    const outcome = applyAutomaticPlacement(app.id, {
      operationId: 'op-auto-7', actor: null, trigger: 'test', at: 2,
    });
    // No generation means no content-derived evidence, and missing evidence is
    // never read as the stateless answer that approves.
    expect(outcome).toEqual({ status: 'operator_review', reason: 'unknown_workload' });
  });
});

describe('a refusal recorded for an operation that has since finished', () => {
  it('keeps the recorded reason and the time it was recorded, on the real projection', () => {
    // The finding this pins. A reason is written once, when the policy runs, and
    // is cleared only when an operator approves, edits the policy, or a later
    // change re-decides. A decision runs only when a placement change is pending,
    // so a refusal recorded because an operation was in flight outlives that
    // operation and nothing corrects it on its own. The projection therefore
    // reports a conflict that had already ended, and the operator arriving after
    // a deploy is told the system is withholding a placement over a conflict
    // that is over.
    //
    // The record is kept, and the projection carries the moment it was made, so
    // the reason reads as what the policy found then rather than as a claim about
    // now. Re-deciding here instead would need a trigger that does not exist, and
    // would make an automatic approval land at a moment the operator is not
    // watching, which is a larger claim than the evidence supports.
    const nodeId = addNode(`n-${randomUUID().slice(0, 6)}`);
    const app = seed({ nodeIds: [nodeId] });
    const store = GitOpsStore.getInstance();

    // An operation genuinely in flight, through the transition that starts one.
    GitOpsTransitions.getInstance().fetchStarted(app.id, {
      operationId: 'op-inflight-refusal', actor: 'tester', trigger: 'test', at: 3_000,
    });
    const outcome = applyAutomaticPlacement(app.id, {
      operationId: 'op-decide', actor: null, trigger: 'test', at: 4_000,
    });
    expect(outcome).toEqual({ status: 'operator_review', reason: 'conflicting_operation' });
    expect(store.getApplication(app.id)!.placement_policy_refused_at).toBe(4_000);

    // The operation finishes, and nothing else changes: no new candidate, no
    // policy edit, no approval. `fetched` is the terminal that releases the
    // in-flight stage.
    GitOpsTransitions.getInstance().fetched(
      app.id,
      'c'.repeat(40),
      { operationId: 'op-inflight-refusal', actor: 'tester', trigger: 'test', at: 5_000 },
    );
    const settled = store.getApplication(app.id)!;
    expect(settled.active_operation_stage).toBeNull();
    expect(settled.placement_policy_refusal_reason).toBe('conflicting_operation');
    expect(settled.placement_policy_refused_at).toBe(4_000);
    // Nothing re-decided, so nothing approved either. The review is still the
    // operator's to take, which is the direction a stale reason has to stay in.
    expect(settled.placement_approval_ref).toBeNull();

    // What the operator is shown. The decline is still reported, carrying the
    // moment it was recorded rather than asserting it of the present.
    const projection = projectApplication(app.id, false);
    const entry = projection.authorityPolicies.find((p) => p.domain === 'placement');
    expect(entry).toMatchObject({
      decision: 'policy_declined',
      reason: 'conflicting_operation',
      decidedAt: 4_000,
    });
    // Not the current time, which is what would make it read as a live claim.
    expect(entry!.decidedAt).not.toBe(5_000);
  });

  it('reports a settled application as awaiting an operator, with no reason', () => {
    // The other arm of the same question. A reason left on an application whose
    // review has closed would be read as the explanation for whatever comes next.
    const nodeId = addNode(`n-${randomUUID().slice(0, 6)}`);
    const app = seed({ nodeIds: [nodeId] });
    const store = GitOpsStore.getInstance();
    GitOpsTransitions.getInstance().placementPolicyRefused({
      applicationId: app.id,
      reason: 'cordon_override',
      at: 6_000,
    });
    GitOpsTransitions.getInstance().placementApproved({
      applicationId: app.id,
      approvalId: `${app.id}-placement`,
      intentRevisionId: store.getApplication(app.id)!.intent_revision_id!,
      blastJson: encodeGitOpsApprovedTargetEffectJson([{ nodeId, outcome: 'place' as const }]),
      requiredNodeIds: [nodeId],
      fingerprint: null,
      actor: 'tester',
      envelope: { operationId: 'op-approve', actor: 'tester', trigger: 'test', at: 7_000 },
      rolloutGenerationId: `${app.id}-gen`,
      candidateId: store.getApplication(app.id)!.rollout_candidate_id!,
      authority: 'operator',
      policyProvenanceJson: null,
    });

    const entry = projectApplication(app.id, false).authorityPolicies
      .find((p) => p.domain === 'placement');
    expect(entry).toMatchObject({ decision: 'operator_authorized', reason: null });
    expect(entry!.decidedAt).toBe(7_000);
  });
});
