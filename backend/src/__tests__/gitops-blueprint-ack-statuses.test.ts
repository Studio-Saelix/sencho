/**
 * The three Blueprint statuses the projection declared but never produced.
 *
 * A Blueprint target has no `deployed_generation_id` writer: nothing resolves a
 * Direct application for a Blueprint-managed stack, so the ack's applied
 * pointer is the only thing that names what the node acknowledged running. Every
 * acked Blueprint target therefore fell through to the `!deployed` check and
 * reported `applied_not_deployed`, which says "awaiting deploy" for a deploy
 * that does not exist, and which `targetDeployLegal` correctly refuses to
 * recommend. The status named what was true and no action could resolve it.
 *
 * Each status below replaces that reading with the one that is true, and each
 * is pinned against the states that must outrank it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { blueprintApplicationFixture, directApplicationFixture } from './helpers/gitopsFixtures';
import { GitOpsStore, emptyTargetRow } from '../services/gitops/store';
import { GitOpsTransitions } from '../services/gitops/transitions';
import { projectApplication } from '../services/gitops/derive';
import { attentionReasons } from '../services/gitops/attention';
import { postureOf } from '../services/gitops/portfolioAggregator';
import {
  encodeArtifactEvidenceJson,
  encodeObservedArtifactIdentity,
  type ObservedArtifactIdentity,
} from '../services/gitops/json';
import type {
  GitOpsApplicationRow,
  GitOpsGenerationRow,
  GitOpsRevisionProjection,
} from '../services/gitops/types';

describe('the Blueprint acknowledgement statuses reach the projection', () => {
  let tmpDir: string;
  let blueprintId = 4000;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    GitOpsStore.resetForTests();
    GitOpsTransitions.resetForTests();
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  /**
   * An acked Inline Blueprint target on the shape production actually produces:
   * applied set, deployed null, and an intent revision the ack recorded. Every
   * test below varies one thing from here, so a case that passes is passing for
   * the reason it names and not because a neighbouring pointer happened to
   * cooperate.
   */
  function ackedBlueprint(
    suffix: string,
    overrides: {
      application?: Partial<GitOpsApplicationRow>;
      target?: Partial<ReturnType<typeof emptyTargetRow>>;
      observed?: ObservedArtifactIdentity;
    } = {},
  ): { applicationId: string } {
    const store = GitOpsStore.getInstance();
    // One live application per Blueprint, so each case takes the next id.
    blueprintId += 1;
    const applicationId = `app-ack-${suffix}`;
    const intentRevisionId = `ir-${suffix}`;
    const generationId = `gen-${suffix}`;
    store.insertGeneration(generation(generationId, applicationId));
    store.insertApplication({
      ...blueprintApplicationFixture(applicationId, blueprintId),
      intent_revision_id: intentRevisionId,
      accepted_generation_id: generationId,
      ...overrides.application,
    });
    store.upsertTarget({
      ...emptyTargetRow(applicationId, 1, 1),
      desired_generation_id: generationId,
      applied_generation_id: generationId,
      // Left null deliberately: a Blueprint target has no deploy-bound writer,
      // and a fixture that set it would be a shape production cannot produce.
      deployed_generation_id: null,
      intent_revision_id: intentRevisionId,
      observed_artifact_identity_json: overrides.observed
        ? encodeObservedArtifactIdentity(overrides.observed)
        : null,
      ...overrides.target,
    });
    return { applicationId };
  }

  function project(applicationId: string, healthDisabled = false): GitOpsRevisionProjection {
    return projectApplication(applicationId, healthDisabled);
  }

  function runtimeStatus(applicationId: string, healthDisabled = false): string {
    const projection = project(applicationId, healthDisabled);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    return projection.targets[0]?.runtime.status ?? 'no_target';
  }

  describe('a superseded acknowledgement', () => {
    it('reports the node as running a generation the application has left', () => {
      const { applicationId } = ackedBlueprint('stale', {
        application: { intent_revision_id: 'ir-new' },
        target: { intent_revision_id: 'ir-old' },
      });

      expect(runtimeStatus(applicationId)).toBe('stale_acknowledgement');
    });

    it('is decided by the candidate too, not only the intent', () => {
      // A new candidate under the same intent is the same fact: this node
      // acknowledged a placement the application has moved past.
      const { applicationId } = ackedBlueprint('stalecand', {
        application: { rollout_candidate_id: 'rc-new' },
        target: { rollout_candidate_id: 'rc-old' },
      });

      expect(runtimeStatus(applicationId)).toBe('stale_acknowledgement');
    });

    it('never masks a drift observation recorded on the same target', () => {
      // The precedence the issue asked to be ratified: a live report about this
      // node now outranks a historical fact about what it acknowledged.
      const { applicationId } = ackedBlueprint('staledrift', {
        application: { intent_revision_id: 'ir-new' },
        target: { intent_revision_id: 'ir-old', latest_stage: 'blueprint_drifted' },
        observed: { kind: 'exact', identity: `sha256:${'a'.repeat(64)}`, observedAt: 42 },
      });

      expect(runtimeStatus(applicationId)).toBe('drifted');
    });

    it('never masks a recorded mutation failure', () => {
      const { applicationId } = ackedBlueprint('stalefail', {
        application: { intent_revision_id: 'ir-new' },
        target: {
          intent_revision_id: 'ir-old',
          failure_stage: 'blueprint_deploy',
          failure_class: 'post_mutation',
        },
      });

      expect(runtimeStatus(applicationId)).toBe('failed_after_mutation');
    });

    it('never masks a health run in flight', () => {
      const { applicationId } = ackedBlueprint('stalehealth', {
        application: { intent_revision_id: 'ir-new' },
        target: { intent_revision_id: 'ir-old', pending_health_run_id: 'run-1' },
      });

      expect(runtimeStatus(applicationId)).toBe('health_checking');
    });

    it('is not reported for a retired target', () => {
      const { applicationId } = ackedBlueprint('staletomb', {
        application: { intent_revision_id: 'ir-new' },
        target: { intent_revision_id: 'ir-old', target_status: 'tombstoned' },
      });

      expect(runtimeStatus(applicationId)).toBe('tombstoned');
    });

    it('survives a health verdict and a later drift check, which cannot make it current', () => {
      // The identity test is about the request, not the evidence since. Testing
      // it after the evidence gates let a superseded acknowledgement read
      // `synced_and_healthy`, which is the over-report this change exists to
      // remove, reintroduced through the evidence check.
      const { applicationId } = ackedBlueprint('staleverdict', {
        application: { intent_revision_id: 'ir-new' },
        target: {
          intent_revision_id: 'ir-old',
          last_health_status: 'passed',
          healthy_generation_id: 'gen-staleverdict',
        },
      });

      expect(runtimeStatus(applicationId)).toBe('stale_acknowledgement');
    });

    it('survives an exact observation recorded after the acknowledgement', () => {
      const { applicationId } = ackedBlueprint('staleseen', {
        application: { intent_revision_id: 'ir-new' },
        target: { intent_revision_id: 'ir-old' },
        observed: { kind: 'exact', identity: `sha256:${'a'.repeat(64)}`, observedAt: 42 },
      });

      expect(runtimeStatus(applicationId)).toBe('stale_acknowledgement');
    });

    it('reaches the attention queue with its own reason, so an operator can act', () => {
      // The reason is pending, not failure: nothing has gone wrong, and the
      // newer rollout resolves it. `rollout_completion_unknown` would send the
      // operator looking for a fault that does not exist.
      const { applicationId } = ackedBlueprint('stalereason', {
        application: { intent_revision_id: 'ir-new' },
        target: { intent_revision_id: 'ir-old' },
      });

      const projection = project(applicationId);
      const reasons = attentionReasons(projection);
      expect(reasons).toContain('rollout_stale_acknowledgement');
      expect(reasons).not.toContain('rollout_completion_unknown');
      expect(postureOf(projection)).not.toBe('failed');
    });

    it('reaches the canonical drift list, so the two surfaces cannot disagree', () => {
      // The runtime facet and the drift list are two readings of the same
      // rows. While the drift list required a populated deployed pointer, a
      // superseded Blueprint acknowledgement showed in one and contributed
      // nothing to the other, which is the disagreement this whole change
      // exists to remove. A node running a generation the application has left
      // has to be visible to the operator through both.
      const { applicationId } = ackedBlueprint('staledriftlist', {
        application: { intent_revision_id: 'ir-new' },
        target: { intent_revision_id: 'ir-old', applied_generation_id: 'gen-older' },
      });

      const projection = project(applicationId);
      if (projection.targetMode === 'not_applicable') throw new Error('expected application');
      expect(projection.targets[0]?.runtime.status).toBe('stale_acknowledgement');
      const generationDrift = projection.drift.find((item) => item.class === 'runtime');
      expect(generationDrift).toBeDefined();
      // Desired is what the application asks for, observed is what the node
      // acknowledged running: the two sides the item exists to name.
      expect(generationDrift?.expected).toEqual({ kind: 'generation', id: 'gen-staledriftlist' });
      expect(generationDrift?.observed).toEqual({ kind: 'generation', id: 'gen-older' });
      // And it reaches the attention queue through the confirmed-drift reason.
      expect(attentionReasons(projection)).toContain('drift');
    });

    it('does not claim a generation divergence no writer can produce', () => {
      // Every Blueprint writer sets desired and applied together, so the
      // generation-mismatch item is not what carries this fact. Pinning that
      // here is what stops the next reader from re-adding the structurally
      // impossible fixture the earlier version of this suite used.
      const { applicationId } = ackedBlueprint('stalegen', {
        application: { intent_revision_id: 'ir-new' },
        target: { intent_revision_id: 'ir-old' },
      });

      const projection = project(applicationId);
      if (projection.targetMode === 'not_applicable') throw new Error('expected application');
      expect(projection.targets[0]?.runtime.status).toBe('stale_acknowledgement');
      expect(projection.drift.find((item) => item.class === 'runtime')).toBeUndefined();
    });

    it('offers no deploy action, because a Blueprint target has none to offer', () => {
      // `targetDeployLegal` refuses a Direct deploy for this mode, and the
      // status that used to name the dead end is gone, so the item must not
      // start advertising a move the transitions would refuse.
      const { applicationId } = ackedBlueprint('stalenoaction', {
        application: { intent_revision_id: 'ir-new' },
        target: { intent_revision_id: 'ir-old', applied_generation_id: 'gen-older' },
      });

      const projection = project(applicationId);
      if (projection.targetMode === 'not_applicable') throw new Error('expected application');
      expect(projection.availableActions).not.toContain('deploy');
      expect(projection.drift.find((item) => item.class === 'runtime')?.action).toBe('none');
    });

    it('is not reported for a Direct target, which has a deploy-bound writer', () => {
      const store = GitOpsStore.getInstance();
      const applicationId = 'app-ack-direct';
      store.insertGeneration(generation('gen-direct', applicationId));
      store.insertApplication({
        ...directApplicationFixture(applicationId, 'ack-stack'),
        intent_revision_id: 'ir-new',
        accepted_generation_id: 'gen-direct',
      });
      store.upsertTarget({
        ...emptyTargetRow(applicationId, 1, 1),
        desired_generation_id: 'gen-direct',
        applied_generation_id: 'gen-direct',
        // Null on purpose: a Direct target that has applied but not yet
        // deployed is the ordinary applied-not-deployed case, which is true
        // and actionable there because a Direct deploy can resolve it. The
        // same status on a Blueprint target would be a dead end, which is the
        // whole reason the two modes are read differently.
        deployed_generation_id: null,
        intent_revision_id: 'ir-old',
      });

      expect(runtimeStatus(applicationId)).toBe('applied_not_deployed');
    });
  });

  describe('an acknowledgement whose outcome was never confirmed', () => {
    it('reports the work as confirmed-by-nobody rather than awaiting a deploy', () => {
      const { applicationId } = ackedBlueprint('unconf');

      expect(runtimeStatus(applicationId)).toBe('acknowledged_completion_unknown');
    });

    it('is reported when the node answered but could not look at its own workload', () => {
      const { applicationId } = ackedBlueprint('unavail', {
        observed: { kind: 'unavailable' },
      });

      expect(runtimeStatus(applicationId)).toBe('acknowledged_completion_unknown');
    });

    it('does not report artifact drift for an identity recorded before the ack', () => {
      // An image-changing rollout. The acknowledgement binds the new expected
      // artifact set, while the recorded identity still describes the old one,
      // so comparing them without dropping the stale observation reports
      // confirmed drift for a stack that has simply not been re-checked yet.
      // That comparison is unreachable for Blueprint targets before this change,
      // because they stopped at the applied-not-deployed reading, so the
      // projection change is what exposed it.
      const store = GitOpsStore.getInstance();
      const applicationId = 'app-ack-staleobs';
      const generationId = 'gen-staleobs';
      const blueprintId = 4600;
      const oldSetId = 'art-staleobs-old';
      const newSetId = 'art-staleobs-new';
      store.insertGeneration(generation(generationId, applicationId));
      store.insertArtifactSet({
        id: oldSetId,
        generation_id: generationId,
        evidence_version: 1,
        authoritative: 0,
        qualification: 'exact',
        evidence_json: encodeArtifactEvidenceJson({ kind: 'exact', identity: `sha256:${'a'.repeat(64)}` }),
        created_at: 1,
      });
      store.insertArtifactSet({
        id: newSetId,
        generation_id: generationId,
        evidence_version: 2,
        authoritative: 0,
        qualification: 'exact',
        evidence_json: encodeArtifactEvidenceJson({ kind: 'exact', identity: `sha256:${'b'.repeat(64)}` }),
        created_at: 1,
      });
      store.insertApplication({
        ...blueprintApplicationFixture(applicationId, blueprintId),
        intent_revision_id: 'ir-staleobs',
        accepted_generation_id: generationId,
        artifact_set_id: newSetId,
        latest_artifact_set_id: newSetId,
      });
      store.upsertTarget({
        ...emptyTargetRow(applicationId, 1, 1),
        desired_generation_id: generationId,
        applied_generation_id: generationId,
        intent_revision_id: 'ir-staleobs',
        // Expecting the old set, and holding an identity that matched it.
        expected_artifact_set_id: oldSetId,
        latest_artifact_set_id: oldSetId,
        observed_artifact_identity_json: encodeObservedArtifactIdentity({
          kind: 'exact',
          identity: `sha256:${'a'.repeat(64)}`,
          observedAt: 7,
        }),
      });

      const tx = GitOpsTransitions.getInstance();
      const app = store.getApplication(applicationId)!;
      tx.blueprintDeployStarted({
        applicationId,
        nodeId: 1,
        intentRevisionId: 'ir-staleobs',
        rolloutCandidateId: null,
        envelope: { operationId: 'op-staleobs-deploy', actor: 'tester', trigger: 'test', at: 2 },
      });
      tx.blueprintAckRecorded({
        applicationId,
        nodeId: 1,
        intentRevisionId: 'ir-staleobs',
        rolloutCandidateId: null,
        legacyAppliedRevision: null,
        envelope: { operationId: 'op-staleobs-ack', actor: 'tester', trigger: 'test', at: 3 },
      });
      expect(app.id).toBe(applicationId);

      // The new expectation is bound, and the identity that described the old
      // one is gone rather than compared against an expectation it never met.
      const target = store.getTarget(applicationId, 1)!;
      expect(target.expected_artifact_set_id).toBe(newSetId);
      expect(target.observed_artifact_identity_json).toBeNull();
      expect(runtimeStatus(applicationId)).not.toBe('rollout_artifact_drift');
      expect(runtimeStatus(applicationId)).not.toBe('runtime_artifact_drift');
    });

    it('is not reported once the reconciler has confirmed what the node runs', () => {
      // The narrow rule: a target the reconciler actually checked is not an
      // unconfirmed acknowledgement, however long ago that check was. Reporting
      // it here would put every unconverged-but-observed target in the attention
      // queue as a failure.
      const { applicationId } = ackedBlueprint('confirmed', {
        observed: { kind: 'exact', identity: `sha256:${'a'.repeat(64)}`, observedAt: 42 },
      });

      expect(runtimeStatus(applicationId)).toBe('fully_deployed_health_pending');
    });

    it('is not reported once a health verdict has landed', () => {
      const { applicationId } = ackedBlueprint('verdict', {
        target: { last_health_status: 'passed', healthy_generation_id: 'gen-verdict' },
      });

      const projection = project(applicationId);
      if (projection.targetMode === 'not_applicable') throw new Error('expected application');
      expect(projection.targets[0]?.health.status).toBe('passed');
      expect(projection.targets[0]?.runtime.status).toBe('synced_and_healthy');
    });

    it('reaches the attention queue and fails the posture, because the outcome is unknown', () => {
      const { applicationId } = ackedBlueprint('unconfattn');

      const projection = project(applicationId);
      expect(attentionReasons(projection)).toContain('rollout_completion_unknown');
      expect(postureOf(projection)).toBe('failed');
    });

    it('is not reported when nothing is ever going to confirm the outcome', () => {
      // The permanent-failure case, and the one the health gate off path hides:
      // with no health contract, the only thing that could confirm an
      // acknowledgement is the reconciler's drift check, and this fixture has no
      // Blueprint row and no intent revision for it to read a drift policy from,
      // so no observation is ever going to be recorded. Reporting the outcome as
      // unknown would pin the target, and every application built from it, to a
      // failure-toned status for ever. The operator asked Sencho not to check, so
      // the absence of a check says nothing about the workload.
      const { applicationId } = ackedBlueprint('unchecked', {
        target: { intent_revision_id: 'ir-unchecked' },
      });

      expect(runtimeStatus(applicationId, true)).not.toBe('acknowledged_completion_unknown');
    });

    it('is still reported with the health gate on, where a verdict can arrive', () => {
      // The counterpart to the case above, so the gate is proven to key off the
      // confirmation that can arrive rather than off the health flag alone.
      const { applicationId } = ackedBlueprint('healthon', {
        target: { intent_revision_id: 'ir-healthon' },
      });

      expect(runtimeStatus(applicationId, false)).toBe('acknowledged_completion_unknown');
    });

    it('is reported for a target in Git-managed Blueprint mode, not only Inline', () => {
      // Both Blueprint modes lack a deploy-bound writer, so both were reading
      // the dead end. The narrowing is per-target-mode and must hold for the
      // Git-managed mode as well, which the Inline-only fixtures above cannot
      // show.
      const store = GitOpsStore.getInstance();
      const applicationId = 'app-ack-gitmanaged';
      const generationId = 'gen-gitmanaged';
      store.insertGeneration(generation(generationId, applicationId));
      store.insertApplication({
        ...blueprintApplicationFixture(applicationId, ++blueprintId),
        target_mode: 'blueprint',
        configured_repo_url: 'https://github.com/org/repo.git',
        configured_ref: 'main',
        repo_identity_json: '{"host":"github.com","pathname":"/org/repo.git"}',
        intent_revision_id: 'ir-gitmanaged',
        accepted_generation_id: generationId,
      });
      store.upsertTarget({
        ...emptyTargetRow(applicationId, 1, 1),
        desired_generation_id: generationId,
        applied_generation_id: generationId,
        deployed_generation_id: null,
        intent_revision_id: 'ir-gitmanaged',
      });

      expect(runtimeStatus(applicationId)).toBe('acknowledged_completion_unknown');
    });

    it('is not reported for an application with no intent of its own', () => {
      // Nothing was ever established, so there is no acknowledgement to doubt.
      // Reporting the identity test here would call an unplaced target stale.
      const { applicationId } = ackedBlueprint('noappintent', {
        application: { intent_revision_id: null },
      });

      expect(runtimeStatus(applicationId)).toBe('acknowledged_completion_unknown');
    });

    it('is not reported for a target that never acknowledged anything', () => {
      const { applicationId } = ackedBlueprint('neveracked', {
        target: { applied_generation_id: null, intent_revision_id: null },
      });

      // Nothing was acknowledged, so there is no acknowledgement to doubt.
      expect(runtimeStatus(applicationId)).toBe('never_applied');
    });
  });

  describe('a target holding stateful changes for review', () => {
    it('makes the placement read as awaiting an operator confirmation', () => {
      const { applicationId } = ackedBlueprint('hold', {
        target: { latest_stage: 'blueprint_state_review' },
      });

      const projection = project(applicationId);
      if (projection.targetMode === 'not_applicable') throw new Error('expected application');
      expect(projection.facets.placement.status).toBe('stateful_confirmation_required');
    });

    it('does not outrank a placement approval that has not been granted', () => {
      // Placement approval is an earlier authority step than a per-node hold,
      // so reporting the hold over it would send the operator to confirm
      // something they have no authority to act on yet.
      const { applicationId } = ackedBlueprint('holdapproval', {
        application: { legacy_combined_approval_ref: 'legacy-1' },
        target: { latest_stage: 'blueprint_state_review' },
      });

      const projection = project(applicationId);
      if (projection.targetMode === 'not_applicable') throw new Error('expected application');
      expect(projection.facets.placement.status).toBe('placement_review_pending');
    });

    it('does not fire for a target that drifted rather than held', () => {
      // Drift is a runtime fact about a node, not a decision about the
      // placement, and the runtime facet already reports it.
      const { applicationId } = ackedBlueprint('holdvsdrift', {
        target: { latest_stage: 'blueprint_drifted' },
        observed: { kind: 'exact', identity: `sha256:${'a'.repeat(64)}`, observedAt: 42 },
      });

      const projection = project(applicationId);
      if (projection.targetMode === 'not_applicable') throw new Error('expected application');
      expect(projection.facets.placement.status).not.toBe('stateful_confirmation_required');
      expect(projection.targets[0]?.runtime.status).toBe('drifted');
    });

    it('does not fire for a retired target', () => {
      const { applicationId } = ackedBlueprint('holdtomb', {
        target: { latest_stage: 'blueprint_state_review', target_status: 'tombstoned' },
      });

      const projection = project(applicationId);
      if (projection.targetMode === 'not_applicable') throw new Error('expected application');
      expect(projection.facets.placement.status).not.toBe('stateful_confirmation_required');
    });

    it('does not fire for a Direct application, which has no Blueprint placement', () => {
      const store = GitOpsStore.getInstance();
      const applicationId = 'app-ack-directhold';
      store.insertGeneration(generation('gen-direct-hold', applicationId));
      store.insertApplication({
        ...directApplicationFixture(applicationId, 'ack-hold'),
        intent_revision_id: 'ir-direct-hold',
        accepted_generation_id: 'gen-direct-hold',
      });
      store.upsertTarget({
        ...emptyTargetRow(applicationId, 1, 1),
        applied_generation_id: 'gen-direct-hold',
        latest_stage: 'blueprint_state_review',
      });

      const projection = project(applicationId);
      if (projection.targetMode === 'not_applicable') throw new Error('expected application');
      expect(projection.facets.placement.status).toBe('unbound_direct');
    });
  });
});

/**
 * A generation row the target's desired pointer can bind to. The store refuses a
 * pointer to a row that does not exist, so every fixture that names a desired
 * generation needs one.
 */
function generation(id: string, applicationId: string): GitOpsGenerationRow {
  return {
    id,
    application_id: applicationId,
    commit_sha: 'abc123',
    // Source identity, not placement: an Inline Blueprint application has no
    // configured repo of its own, and the generation it mints records the
    // inline-owned identity the freeze produced.
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

