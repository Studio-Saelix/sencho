import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { FACET_EVIDENCE_SOURCE } from '../services/gitops/types';
import { GitOpsStore, emptyTargetRow } from '../services/gitops/store';
import { GitOpsTransitions, type EventEnvelope } from '../services/gitops/transitions';
import { deriveGitOpsRevision, projectApplication } from '../services/gitops/derive';
import { DatabaseService } from '../services/DatabaseService';
import type {
  FutureGitOpsEvidence,
  GitOpsApplicationRow,
  GitOpsGenerationRow,
  GitOpsIntentRevisionRow,
  GitOpsRevisionProjection,
} from '../services/gitops/types';
import {
  encodeArtifactEvidenceJson,
  encodeObservedArtifactIdentity,
  type ServiceArtifactEvidence,
} from '../services/gitops/json';

describe('gitops derivation', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    GitOpsStore.resetForTests();
    GitOpsTransitions.resetForTests();
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  it('registers every facet status exactly once', () => {
    expect(FACET_EVIDENCE_SOURCE.source.applying).toBe('current');
    expect(FACET_EVIDENCE_SOURCE.rollout.completion_unknown).toBe('current_or_future');
    expect(FACET_EVIDENCE_SOURCE.source.source_superseded).toBe('future');
    expect(FACET_EVIDENCE_SOURCE.runtime.rollout_artifact_drift).toBe('current');
    expect(FACET_EVIDENCE_SOURCE.lkg.none).toBe('current');
  });

  it('projects applying with no fetch/apply/dismiss actions', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-apply-facet', 'facet-web'), nodeId: 1, envelope: env('op-act') });
    store.insertGeneration(gen('gen-facet', 'app-apply-facet'));
    tx.fetchStarted('app-apply-facet', env('op-f'));
    tx.fetched('app-apply-facet', 'abc123', env('op-f'));
    tx.candidateReady('app-apply-facet', 'gen-facet', false, env('op-c'));
    tx.applyStarted('app-apply-facet', 'gen-facet', env('op-a'));
    const projection = projectApplication('app-apply-facet', false);
    expect(projection.targetMode).toBe('direct');
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.facets.source.status).toBe('applying');
    expect(projection.availableActions).toEqual(['none']);
    expect(projection.targets[0]?.desiredGenerationId).toBeNull();
    expect(projection.targets[0]?.candidateGenerationId).toBe('gen-facet');
  });

  it('projects a freshly activated target as never applied and offers no deploy', () => {
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-idle', 'idle-web'), nodeId: 1, envelope: env('op-act-idle') });
    const projection = projectApplication('app-idle', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.targets[0]?.runtime.status).toBe('never_applied');
    expect(projection.availableActions).not.toContain('deploy');
    expect(projection.availableActions).toContain('fetch');
  });

  it('keeps a never-applied target out of deploy actions when health gating is disabled', () => {
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-idle-nohealth', 'idle-nohealth-web'), nodeId: 1, envelope: env('op-act-idle-2') });
    const projection = projectApplication('app-idle-nohealth', true);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.targets[0]?.runtime.status).toBe('never_applied');
    expect(projection.availableActions).not.toContain('deploy');
  });

  it('projects accepted application and applied-not-deployed after apply', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-done', 'done-web'), nodeId: 1, envelope: env('op-act-2') });
    store.insertGeneration(gen('gen-done', 'app-done'));
    tx.fetchStarted('app-done', env('op-f2'));
    tx.fetched('app-done', 'abc123', env('op-f2'));
    tx.candidateReady('app-done', 'gen-done', false, env('op-c2'));
    tx.applied({
      applicationId: 'app-done',
      generationId: 'gen-done',
      artifactSetId: 'art-done',
      sourceAcceptanceId: 'acc-done',
      authority: 'operator',
      envelope: env('op-a2'),
    });
    const projection = projectApplication('app-done', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.facets.source.status).toBe('application_generation_accepted');
    expect(projection.facets.artifact.status).toBe('artifact_resolution_pending');
    expect(projection.facets.placement.status).toBe('unbound_direct');
    expect(projection.targets[0]?.runtime.status).toBe('applied_not_deployed');
    expect(projection.targets[0]?.lkg.status).toBe('none');
    expect(projection.availableActions).toContain('deploy');
  });

  it('keeps a stale deployment deploy-pending instead of synced and healthy', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-stale-deploy', 'stale-deploy-web'), nodeId: 1, envelope: env('op-stale') });
    store.insertGeneration(gen('gen-a-stale', 'app-stale-deploy'));
    store.insertGeneration(gen('gen-b-stale', 'app-stale-deploy'));
    // Generation A is deployed and healthy; generation B is applied and
    // desired, with automatic deployment off so nothing moves it.
    const target = {
      ...emptyTargetRow('app-stale-deploy', 1, 1),
      desired_generation_id: 'gen-b-stale',
      applied_generation_id: 'gen-b-stale',
      deployed_generation_id: 'gen-a-stale',
      healthy_generation_id: 'gen-a-stale',
    };
    store.upsertTarget(target);

    let projection = projectApplication('app-stale-deploy', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.targets[0]?.runtime.status).toBe('applied_not_deployed');
    expect(projection.targets[0]?.health.status).toBe('pending');
    expect(projection.availableActions).toContain('deploy');
    // The mismatch is a confirmed drift item, not only a facet status: the
    // canonical drift list must not contradict what the runtime facet says.
    expect(projection.drift).toHaveLength(1);
    expect(projection.drift[0]).toEqual({
      class: 'runtime',
      expected: { kind: 'generation', id: 'gen-b-stale' },
      observed: { kind: 'generation', id: 'gen-a-stale' },
      freshnessAt: null,
      owner: 'ComposeService',
      reason: 'the target is running a different generation than the one it was asked to run',
      configuredPolicy: null,
      affectedTargets: [{ nodeId: 1, stackName: 'stale-deploy-web' }],
      action: 'deploy',
    });

    // Re-derived from the store rows rather than any carried-over state, so a
    // restart reads the same answer, item included.
    expect(GitOpsStore.getInstance().getTarget('app-stale-deploy', 1)?.deployed_generation_id).toBe('gen-a-stale');
    projection = projectApplication('app-stale-deploy', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.targets[0]?.runtime.status).toBe('applied_not_deployed');
    expect(projection.drift).toHaveLength(1);

    // Once the deploy lands the target awaits its own health run instead of
    // inheriting generation A's green verdict, and the mismatch item clears:
    // desired and deployed now agree, so there is nothing left to report.
    store.upsertTarget({ ...target, deployed_generation_id: 'gen-b-stale' });
    projection = projectApplication('app-stale-deploy', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.targets[0]?.runtime.status).toBe('fully_deployed_health_pending');
    expect(projection.targets[0]?.health.status).toBe('pending');
    expect(projection.drift).toHaveLength(0);

    // A passing run recorded against the desired generation answers for it
    // even while a different generation is deployed. No producer reaches this
    // combination today; the pin keeps any tightening of the comparison a
    // conscious decision rather than an accident.
    store.upsertTarget({ ...target, healthy_generation_id: 'gen-b-stale' });
    projection = projectApplication('app-stale-deploy', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.targets[0]?.runtime.status).toBe('applied_not_deployed');
    expect(projection.targets[0]?.health.status).toBe('passed');
  });

  it('keeps the generation-mismatch drift item after a failed redeploy', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-fail-drift', 'fail-drift-web'), nodeId: 1, envelope: env('op-fd-act') });
    store.insertGeneration(gen('gen-fd-a', 'app-fail-drift'));
    // B is built from the commit the second fetch resolves, so its accepted
    // commit matches the configured ref: the point of this fixture is the
    // runtime mismatch, not a source one.
    store.insertGeneration({ ...gen('gen-fd-b', 'app-fail-drift'), commit_sha: 'def456' });
    // Generation A ships and binds, then B is applied as the new desired
    // state while A keeps serving.
    tx.fetchStarted('app-fail-drift', env('op-fd-f1'));
    tx.fetched('app-fail-drift', 'abc123', env('op-fd-f1'));
    tx.candidateReady('app-fail-drift', 'gen-fd-a', false, env('op-fd-c1'));
    tx.applied({
      applicationId: 'app-fail-drift',
      generationId: 'gen-fd-a',
      artifactSetId: 'art-fd-a',
      sourceAcceptanceId: 'acc-fd-a',
      authority: 'operator',
      envelope: env('op-fd-a1'),
    });
    tx.deployStarted('app-fail-drift', 1, 'gen-fd-a', env('op-fd-d1'));
    tx.deployBound('app-fail-drift', 1, 'gen-fd-a', env('op-fd-d1'));
    tx.fetchStarted('app-fail-drift', env('op-fd-f2'));
    tx.fetched('app-fail-drift', 'def456', env('op-fd-f2'));
    tx.candidateReady('app-fail-drift', 'gen-fd-b', false, env('op-fd-c2'));
    tx.applied({
      applicationId: 'app-fail-drift',
      generationId: 'gen-fd-b',
      artifactSetId: 'art-fd-b',
      sourceAcceptanceId: 'acc-fd-b',
      authority: 'operator',
      envelope: env('op-fd-a2'),
    });

    // Sanity: the clean mismatch reports one item offering deploy.
    let projection = projectApplication('app-fail-drift', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.targets[0]?.runtime.status).toBe('applied_not_deployed');
    expect(projection.drift).toHaveLength(1);
    expect(projection.drift[0].action).toBe('deploy');

    // Mid-deploy the divergence is factual while nothing can offer deploying
    // again: one item, action none, gone the moment B binds.
    tx.deployStarted('app-fail-drift', 1, 'gen-fd-b', env('op-fd-d2'));
    projection = projectApplication('app-fail-drift', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.targets[0]?.runtime.status).toBe('deploying');
    expect(projection.drift).toHaveLength(1);
    expect(projection.drift[0].action).toBe('none');

    // The deploy of B fails before mutating anything; A keeps serving and the
    // deployed pointer stays on it. The runtime facet now shows the failure,
    // but the mismatch between what was asked for and what is running did not
    // go anywhere, so the drift item must survive the presentation change.
    tx.deployStarted('app-fail-drift', 1, 'gen-fd-b', env('op-fd-d2'));
    tx.deployFailed('app-fail-drift', 1, 'pre_mutation', env('op-fd-d2'));
    projection = projectApplication('app-fail-drift', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(store.getTarget('app-fail-drift', 1)?.deployed_generation_id).toBe('gen-fd-a');
    expect(projection.targets[0]?.runtime.status).toBe('failed_previous_workload_intact');
    // No target reads applied_not_deployed here, so availableActions withholds
    // deploy and the item must agree instead of advertising an absent action.
    expect(projection.availableActions).not.toContain('deploy');
    expect(projection.drift).toHaveLength(1);
    expect(projection.drift[0]).toEqual({
      class: 'runtime',
      expected: { kind: 'generation', id: 'gen-fd-b' },
      observed: { kind: 'generation', id: 'gen-fd-a' },
      freshnessAt: null,
      owner: 'ComposeService',
      reason: 'the target is running a different generation than the one it was asked to run',
      configuredPolicy: null,
      affectedTargets: [{ nodeId: 1, stackName: 'fail-drift-web' }],
      action: 'none',
    });

    // Re-derived from the same rows, the report is stable.
    projection = projectApplication('app-fail-drift', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.drift).toHaveLength(1);
    expect(projection.drift[0].expected).toEqual({ kind: 'generation', id: 'gen-fd-b' });
    expect(projection.drift[0].action).toBe('none');

    // The artifact observation describing the workload that is being replaced
    // stays suppressed while the generation question stands.
    // Version 2 because the apply already seeded an unresolved v1 row for
    // this generation and the table is unique per generation and version.
    store.insertArtifactSet({
      id: 'art-fd-b-expected',
      generation_id: 'gen-fd-b',
      evidence_version: 2,
      authoritative: 0,
      qualification: 'exact',
      evidence_json: JSON.stringify({ kind: 'exact', identity: 'sha256:wanted' }),
      created_at: 1,
    });
    const failed = store.getTarget('app-fail-drift', 1)!;
    store.upsertTarget({
      ...failed,
      expected_artifact_set_id: 'art-fd-b-expected',
      observed_artifact_identity_json: JSON.stringify({ kind: 'exact', identity: 'sha256:serving', observedAt: 7 }),
    });
    projection = projectApplication('app-fail-drift', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.drift).toHaveLength(1);
    expect(projection.drift[0].expected.kind).toBe('generation');

    // The post-mutation variant reports the same way. Even when Compose was
    // handed off, the deployed pointer stays on the old generation until a
    // successful bind proves the new one, so the report stays anchored to
    // whatever is actually serving.
    tx.deployStarted('app-fail-drift', 1, 'gen-fd-b', env('op-fd-d4'));
    tx.deployFailed('app-fail-drift', 1, 'post_mutation', env('op-fd-d4'));
    projection = projectApplication('app-fail-drift', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.targets[0]?.runtime.status).toBe('failed_after_mutation');
    expect(projection.drift).toHaveLength(1);
    expect(projection.drift[0].observed).toEqual({ kind: 'generation', id: 'gen-fd-a' });
    expect(projection.drift[0].action).toBe('none');

    // Binding B clears the item along with the failure. The artifact probe
    // from the suppression check goes with it, so the converged target is
    // judged on pointers and health alone.
    tx.deployStarted('app-fail-drift', 1, 'gen-fd-b', env('op-fd-d3'));
    tx.deployBound('app-fail-drift', 1, 'gen-fd-b', env('op-fd-d3'));
    store.upsertTarget({
      ...store.getTarget('app-fail-drift', 1)!,
      expected_artifact_set_id: null,
      observed_artifact_identity_json: null,
    });
    projection = projectApplication('app-fail-drift', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.targets[0]?.runtime.status).toBe('fully_deployed_health_pending');
    expect(projection.drift).toHaveLength(0);
  });

  it('does not report generation mismatch on a retired target', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-tomb-drift', 'tomb-drift-web'), nodeId: 1, envelope: env('op-td-act') });
    store.insertGeneration(gen('gen-td-a', 'app-tomb-drift'));
    store.insertGeneration(gen('gen-td-b', 'app-tomb-drift'));
    // Retirement clears failure and LKG state but leaves the pointers alone,
    // so a target retired mid-pending-deploy keeps divergent pointers. No
    // transition can rebind it afterwards, so the mismatch must stay silent
    // instead of becoming an item nothing could ever clear.
    store.upsertTarget({
      ...emptyTargetRow('app-tomb-drift', 1, 1),
      target_status: 'tombstoned',
      desired_generation_id: 'gen-td-b',
      applied_generation_id: 'gen-td-b',
      deployed_generation_id: 'gen-td-a',
    });

    const projection = projectApplication('app-tomb-drift', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.targets[0]?.runtime.status).toBe('tombstoned');
    expect(projection.drift).toHaveLength(0);
  });

  it('keeps a failed sibling out of another target\'s deploy action', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-sib', 'sib-web'), nodeId: 1, envelope: env('op-sib') });
    store.insertGeneration(gen('gen-a-sib', 'app-sib'));
    store.insertGeneration(gen('gen-b-sib', 'app-sib'));
    // Node 1 diverges cleanly; node 2 carries the same divergence but sits in
    // a failed state. The deploy question is per target: node 2 must not be
    // told to deploy because node 1 legally can.
    store.upsertTarget({
      ...emptyTargetRow('app-sib', 1, 1),
      desired_generation_id: 'gen-b-sib',
      applied_generation_id: 'gen-b-sib',
      deployed_generation_id: 'gen-a-sib',
      healthy_generation_id: 'gen-a-sib',
    });
    store.upsertTarget({
      ...emptyTargetRow('app-sib', 2, 2),
      desired_generation_id: 'gen-b-sib',
      applied_generation_id: 'gen-b-sib',
      deployed_generation_id: 'gen-a-sib',
      failure_stage: 'deploy',
      failure_class: 'pre_mutation',
    });
    // Node 3 carries the same divergence under an operator pause: a paused
    // target cannot act, so its item stays none like the failed one.
    store.upsertTarget({
      ...emptyTargetRow('app-sib', 3, 3),
      desired_generation_id: 'gen-b-sib',
      applied_generation_id: 'gen-b-sib',
      deployed_generation_id: 'gen-a-sib',
      pause_at: 1,
      pause_reason: 'operator',
    });

    const projection = projectApplication('app-sib', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.availableActions).toContain('deploy');
    expect(projection.drift).toHaveLength(3);
    expect(projection.drift[0].affectedTargets[0]?.nodeId).toBe(1);
    expect(projection.drift[0].action).toBe('deploy');
    expect(projection.drift[1].affectedTargets[0]?.nodeId).toBe(2);
    expect(projection.drift[1].action).toBe('none');
    expect(projection.drift[2].affectedTargets[0]?.nodeId).toBe(3);
    expect(projection.drift[2].action).toBe('none');
  });

  it('never advertises Direct deployment for a Blueprint-mode application', () => {
    const store = GitOpsStore.getInstance();
    store.insertGeneration(gen('gen-bp-wanted', 'app-bp-deploy'));
    store.insertGeneration(gen('gen-bp-serving', 'app-bp-deploy'));
    store.insertApplication(rawApp('app-bp-deploy', {
      target_mode: 'inline_blueprint',
      blueprint_id: 9,
      lifecycle_key: 'blueprint:9',
      stack_name: null,
      configured_repo_url: null,
      repo_identity_json: null,
      configured_ref: null,
    }));
    // A divergent Blueprint target reads applied_not_deployed like any other,
    // but Direct deployment is not a legal move for this mode: only an
    // identity-matched interruption retry ever deploys here.
    store.upsertTarget({
      ...emptyTargetRow('app-bp-deploy', 1, 1),
      desired_generation_id: 'gen-bp-wanted',
      applied_generation_id: 'gen-bp-wanted',
      deployed_generation_id: 'gen-bp-serving',
    });

    const projection = projectApplication('app-bp-deploy', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.availableActions).not.toContain('deploy');
    expect(projection.drift).toHaveLength(1);
    expect(projection.drift[0].action).toBe('none');
  });

  it('retries an interrupted Blueprint deploy only while the recorded identities still match', () => {
    const store = GitOpsStore.getInstance();
    const bpApp = (id: string, blueprintId: number, overrides: Partial<GitOpsApplicationRow>) =>
      rawApp(id, {
        target_mode: 'inline_blueprint',
        blueprint_id: blueprintId,
        lifecycle_key: `blueprint:${blueprintId}`,
        stack_name: null,
        configured_repo_url: null,
        repo_identity_json: null,
        configured_ref: null,
        ...overrides,
      });
    const divergentTarget = (appId: string) => ({
      ...emptyTargetRow(appId, 1, 1),
      desired_generation_id: `wanted-${appId}`,
      applied_generation_id: `wanted-${appId}`,
      deployed_generation_id: `serving-${appId}`,
      interruption_stage: 'blueprint_deploy_started' as const,
      interruption_at: 1,
    });

    // Inline reality today: no rollout candidate producer has run, so the
    // application and the recorded crash carry no candidate id at all. The
    // absent pair matches, leaving the intent revision as the live identity
    // that decides the retry.
    store.insertGeneration(gen('wanted-app-bp-r-vac', 'app-bp-r-vac'));
    store.insertGeneration(gen('serving-app-bp-r-vac', 'app-bp-r-vac'));
    store.insertApplication(bpApp('app-bp-r-vac', 12, { intent_revision_id: 'ir-v' }));
    store.upsertTarget({
      ...divergentTarget('app-bp-r-vac'),
      interruption_intent_revision_id: 'ir-v',
    });

    let projection = projectApplication('app-bp-r-vac', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    const vacRuntime = projection.targets[0]?.runtime;
    if (!vacRuntime || vacRuntime.status !== 'completion_unknown') throw new Error('expected completion_unknown');
    expect(vacRuntime.interruptedStage).toBe('blueprint_deploy_started');
    expect(projection.availableActions).toContain('deploy');

    // With a candidate in play, both recorded identities must equal what the
    // application requires for the repeat to stay legal.
    store.insertGeneration(gen('wanted-app-bp-r-match', 'app-bp-r-match'));
    store.insertGeneration(gen('serving-app-bp-r-match', 'app-bp-r-match'));
    store.insertApplication(bpApp('app-bp-r-match', 13, { intent_revision_id: 'ir-m', rollout_candidate_id: 'rc-m' }));
    store.upsertTarget({
      ...divergentTarget('app-bp-r-match'),
      interruption_intent_revision_id: 'ir-m',
      interruption_rollout_candidate_id: 'rc-m',
    });
    projection = projectApplication('app-bp-r-match', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.availableActions).toContain('deploy');

    // Candidate-only mismatch: the intent still matches but the recorded
    // rollout candidate was superseded. Both persisted identities are
    // contractually significant, so either one drifting alone suppresses
    // the retry.
    store.upsertTarget({
      ...store.getTarget('app-bp-r-match', 1)!,
      interruption_rollout_candidate_id: 'rc-superseded',
    });
    projection = projectApplication('app-bp-r-match', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.availableActions).not.toContain('deploy');
    expect(projection.drift[0]?.action).toBe('none');

    // A superseded intent revision means the recorded operation names an
    // identity nobody requires anymore, so the retry disappears even though
    // the divergence itself still reports.
    store.upsertTarget({
      ...store.getTarget('app-bp-r-match', 1)!,
      interruption_intent_revision_id: 'ir-superseded',
      interruption_rollout_candidate_id: 'rc-m',
    });
    projection = projectApplication('app-bp-r-match', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.targets[0]?.runtime.status).toBe('completion_unknown');
    expect(projection.availableActions).not.toContain('deploy');
    expect(projection.drift).toHaveLength(1);
    expect(projection.drift[0].action).toBe('none');
  });

  it('retries an interrupted Direct deploy only while the interrupted generation still matches', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-int-dep', 'int-dep-web'), nodeId: 1, envelope: env('op-id-act') });
    store.insertGeneration(gen('gen-a-id', 'app-int-dep'));
    // Cycle B fetches a different commit; carrying that sha keeps the fixture
    // in the accepted state instead of a reconcile-required one.
    store.insertGeneration({ ...gen('gen-b-id', 'app-int-dep'), commit_sha: 'def456' });
    store.insertGeneration(gen('gen-c-id', 'app-int-dep'));
    tx.fetchStarted('app-int-dep', env('op-id-f1'));
    tx.fetched('app-int-dep', 'abc123', env('op-id-f1'));
    tx.candidateReady('app-int-dep', 'gen-a-id', false, env('op-id-c1'));
    tx.applied({
      applicationId: 'app-int-dep',
      generationId: 'gen-a-id',
      artifactSetId: 'art-id-a',
      sourceAcceptanceId: 'acc-id-a',
      authority: 'operator',
      envelope: env('op-id-a1'),
    });
    tx.deployStarted('app-int-dep', 1, 'gen-a-id', env('op-id-d1'));
    tx.deployBound('app-int-dep', 1, 'gen-a-id', env('op-id-d1'));
    tx.fetchStarted('app-int-dep', env('op-id-f2'));
    tx.fetched('app-int-dep', 'def456', env('op-id-f2'));
    tx.candidateReady('app-int-dep', 'gen-b-id', false, env('op-id-c2'));
    tx.applied({
      applicationId: 'app-int-dep',
      generationId: 'gen-b-id',
      artifactSetId: 'art-id-b',
      sourceAcceptanceId: 'acc-id-b',
      authority: 'operator',
      envelope: env('op-id-a2'),
    });
    // Crash mid-deploy: the interruption records the generation that was
    // being deployed, and a retry is legal while that still matches what the
    // target wants applied.
    tx.deployStarted('app-int-dep', 1, 'gen-b-id', env('op-id-d2'));
    tx.interruptActiveOperations('app-int-dep', env('op-id-x'));

    let projection = projectApplication('app-int-dep', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    const runtime = projection.targets[0]?.runtime;
    if (!runtime || runtime.status !== 'completion_unknown') throw new Error('expected completion_unknown');
    expect(runtime.interruptedStage).toBe('deploy_started');
    expect(projection.availableActions).toContain('deploy');

    // Once the target's applied and desired identities move on, the recorded
    // interruption names a generation nobody wants anymore, so the retry
    // disappears even though the divergence itself still reports.
    const interrupted = store.getTarget('app-int-dep', 1)!;
    store.upsertTarget({
      ...interrupted,
      desired_generation_id: 'gen-c-id',
      applied_generation_id: 'gen-c-id',
      // The old generation's artifact expectations cannot follow the new
      // desired id; clearing them keeps the interruption the only reported
      // divergence here.
      expected_artifact_set_id: null,
      latest_artifact_set_id: null,
    });
    projection = projectApplication('app-int-dep', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.targets[0]?.runtime.status).toBe('completion_unknown');
    expect(projection.drift).toHaveLength(1);
    expect(projection.availableActions).not.toContain('deploy');
    expect(projection.drift[0].action).toBe('none');
  });

  it('offers apply after an interrupted apply only when every apply precondition holds', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    const interruptedApp = (id: string, overrides: Partial<GitOpsApplicationRow> = {}) =>
      rawApp(id, {
        stack_name: `${id}-web`,
        interruption_stage: 'apply_started',
        interruption_at: 1,
        interruption_operation_id: `op-${id}`,
        interruption_generation_id: `gen-${id}`,
        candidate_generation_id: `gen-${id}`,
        ...overrides,
      });

    // Transition-legal positive: the recorded generation exists under this
    // application with an unchanged materialization fingerprint, remains the
    // current candidate, and neither suspension nor blockage intervenes, so
    // finishing the apply is exactly what applyStarted would accept.
    store.insertGeneration(gen('gen-app-int-ap-match', 'app-int-ap-match'));
    store.insertApplication(interruptedApp('app-int-ap-match'));
    let projection = projectApplication('app-int-ap-match', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    if (projection.facets.source.status !== 'source_unknown') throw new Error('expected source_unknown');
    expect(projection.facets.source.interruptedStage).toBe('apply_started');
    expect(projection.availableActions).toContain('apply');
    // The recommendation is only as good as the transition it names, so the
    // projected action is executed rather than trusted: this must not throw.
    tx.applyStarted('app-int-ap-match', 'gen-app-int-ap-match', env('op-ap-resume'));

    // Missing row: the recorded generation is gone, so applyStarted would
    // refuse and the recommendation must fail closed.
    store.insertApplication(interruptedApp('app-int-ap-missing'));
    projection = projectApplication('app-int-ap-missing', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.availableActions).not.toContain('apply');

    // Foreign owner: the candidate row exists but belongs to another
    // application, which applyStarted refuses just the same.
    store.insertGeneration(gen('gen-app-int-ap-foreign', 'app-not-the-owner'));
    store.insertApplication(interruptedApp('app-int-ap-foreign'));
    projection = projectApplication('app-int-ap-foreign', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.availableActions).not.toContain('apply');

    // Fingerprint mismatch: finishing the recorded apply would use bytes built
    // from different configuration. Defensive today, since shipped producers
    // clear the candidate when configuration changes; the gate mirrors the
    // transition's refusal either way.
    store.insertGeneration({
      ...gen('gen-app-int-ap-fp', 'app-int-ap-fp'),
      materialization_fingerprint: 'b'.repeat(64),
    });
    store.insertApplication(interruptedApp('app-int-ap-fp'));
    projection = projectApplication('app-int-ap-fp', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.availableActions).not.toContain('apply');

    // Suspended: identities line up, but the source was suspended after the
    // crash and applyStarted refuses suspended sources outright.
    store.insertGeneration(gen('gen-app-int-ap-susp', 'app-int-ap-susp'));
    store.insertApplication(interruptedApp('app-int-ap-susp', { suspended_at: 1 }));
    projection = projectApplication('app-int-ap-susp', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.availableActions).not.toContain('apply');

    // Stale: the candidate moved on after the crash, so the recorded apply
    // can no longer prove what it was applying and apply must not be offered.
    store.insertGeneration(gen('gen-ap-new', 'app-int-ap-stale'));
    store.insertApplication(interruptedApp('app-int-ap-stale', {
      interruption_generation_id: 'gen-ap-old',
      candidate_generation_id: 'gen-ap-new',
    }));
    projection = projectApplication('app-int-ap-stale', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.facets.source.status).toBe('source_unknown');
    expect(projection.availableActions).not.toContain('apply');

    // Blocked: the recorded apply still names the current candidate, but a
    // later classification blocked that candidate, so finishing it is refused
    // even though every identity still lines up.
    store.insertGeneration(gen('gen-ap-b', 'app-int-ap-block'));
    store.insertApplication(interruptedApp('app-int-ap-block', { candidate_plan_blocked: 1 }));
    projection = projectApplication('app-int-ap-block', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.availableActions).toEqual(['dismiss', 'suspend']);
  });

  it('offers ordinary apply only when the candidate generation is present, owned, and current', () => {
    const store = GitOpsStore.getInstance();
    // Valid: an owned, fingerprint-matched candidate reads ready and offers
    // apply exactly as the transition would accept it.
    store.insertGeneration(gen('gen-cr-valid', 'app-cr-valid'));
    store.insertApplication(rawApp('app-cr-valid', { stack_name: 'cr-valid-web', candidate_generation_id: 'gen-cr-valid' }));
    let projection = projectApplication('app-cr-valid', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.facets.source.status).toBe('candidate_ready');
    expect(projection.availableActions).toContain('apply');

    // Missing: the candidate names a generation that does not exist, so
    // ready would recommend an apply the transition refuses; the source must
    // fail closed to reconcile-required instead, naming what was lost, and
    // fetch stays on offer as the way out.
    store.insertApplication(rawApp('app-cr-missing', { stack_name: 'cr-missing-web', candidate_generation_id: 'gen-cr-gone' }));
    projection = projectApplication('app-cr-missing', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.facets.source.status).toBe('source_reconcile_required');
    expect(projection.limitations.map((item) => item.code)).toContain('candidate_generation_invalid');
    expect(projection.limitations.some((item) => item.evidence === 'gen-cr-gone')).toBe(true);
    expect(projection.availableActions).not.toContain('apply');
    expect(projection.availableActions).toContain('fetch');

    // Foreign: the candidate row exists but belongs to another application,
    // which applyStarted refuses just as surely as a missing one.
    store.insertGeneration(gen('gen-cr-foreign', 'app-not-the-owner'));
    store.insertApplication(rawApp('app-cr-foreign', { stack_name: 'cr-foreign-web', candidate_generation_id: 'gen-cr-foreign' }));
    projection = projectApplication('app-cr-foreign', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.facets.source.status).toBe('source_reconcile_required');
    expect(projection.availableActions).not.toContain('apply');

    // Fingerprint mismatch: the generation's recorded fingerprint no longer
    // equals the application's current one. No shipped producer leaves a
    // candidate pointer across a configuration change today, so this pins
    // the derivation's fail-safe side of that refusal.
    store.insertGeneration({
      ...gen('gen-cr-stalefp', 'app-cr-fp'),
      materialization_fingerprint: 'b'.repeat(64),
    });
    store.insertApplication(rawApp('app-cr-fp', { stack_name: 'cr-fp-web', candidate_generation_id: 'gen-cr-stalefp' }));
    projection = projectApplication('app-cr-fp', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.facets.source.status).toBe('source_reconcile_required');
    expect(projection.availableActions).not.toContain('apply');
  });

  it('reports a scheduled poll before the accepted and never-reconciled fallbacks', () => {
    const store = GitOpsStore.getInstance();
    // A poll cursor with no failure, no retry cursor, and no candidate means
    // the controller is waiting for the next poll, not that the source is idle.
    store.insertApplication(rawApp('app-poll-due', { stack_name: 'poll-due-web', next_poll_at: 12345 }));
    const projection = projectApplication('app-poll-due', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    if (projection.facets.source.status !== 'source_poll_scheduled') throw new Error('expected poll facet');
    expect(projection.facets.source.nextPollAt).toBe(12345);
    // An accepted generation is still the stronger evidence, so the poll
    // cursor must not mask it.
    store.insertApplication(rawApp('app-poll-accepted', {
      stack_name: 'poll-accepted-web',
      next_poll_at: 12345,
      desired_commit_sha: 'abc123',
      accepted_generation_id: 'gen-poll-accepted',
    }));
    store.insertGeneration(gen('gen-poll-accepted', 'app-poll-accepted'));
    const acceptedProjection = projectApplication('app-poll-accepted', false);
    if (acceptedProjection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(acceptedProjection.facets.source.status).toBe('application_generation_accepted');
    // A failure beats the cursor the same way the cursor beats the fallbacks:
    // a poll schedule is never an excuse to hide a fetch failure.
    store.insertApplication(rawApp('app-poll-failed', {
      stack_name: 'poll-failed-web',
      next_poll_at: 12345,
      failure_stage: 'fetch',
      failure_class: 'NETWORK_TIMEOUT',
      failure_at: 1,
    }));
    const failedProjection = projectApplication('app-poll-failed', false);
    if (failedProjection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(failedProjection.facets.source.status).toBe('source_failed');
  });

  it('reports an accepted generation only when its evidence is present, owned, and current', () => {
    const store = GitOpsStore.getInstance();
    const acceptedApp = (id: string, overrides: Partial<GitOpsApplicationRow> = {}) =>
      rawApp(id, {
        stack_name: `${id}-web`,
        accepted_generation_id: `gen-${id}`,
        desired_commit_sha: 'abc123',
        ...overrides,
      });

    // Valid: the accepted row exists under this application with the
    // materialization fingerprint it was built from and the commit the
    // configuration asks for, so success is the honest answer.
    store.insertGeneration(gen('gen-app-acc-valid', 'app-acc-valid'));
    store.insertApplication(acceptedApp('app-acc-valid'));
    let projection = projectApplication('app-acc-valid', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.facets.source.status).toBe('application_generation_accepted');
    expect(projection.availableActions).toEqual(['suspend']);

    // Missing: the accepted pointer names a generation that is gone, so
    // neither the fingerprint nor the sha comparison can run and success
    // would be claimed without any evidence behind it.
    store.insertApplication(acceptedApp('app-acc-missing'));
    projection = projectApplication('app-acc-missing', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.facets.source.status).toBe('source_reconcile_required');
    expect(projection.limitations.map((item) => item.code)).toContain('accepted_generation_invalid');
    expect(projection.limitations.some((item) => item.evidence === 'gen-app-acc-missing')).toBe(true);
    expect(projection.availableActions).toContain('fetch');

    // Foreign: the row exists but belongs to another application, which is
    // the same refusal with the same recovery path.
    store.insertGeneration(gen('gen-app-acc-foreign', 'app-not-the-owner'));
    store.insertApplication(acceptedApp('app-acc-foreign'));
    projection = projectApplication('app-acc-foreign', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.facets.source.status).toBe('source_reconcile_required');
    expect(projection.limitations.map((item) => item.code)).toContain('accepted_generation_invalid');
    expect(projection.availableActions).toContain('fetch');

    // Fingerprint mismatch: the accepted row is present and owned but its
    // materialization fingerprint differs from the application's current one.
    store.insertGeneration({
      ...gen('gen-app-acc-fp', 'app-acc-fp'),
      materialization_fingerprint: 'b'.repeat(64),
    });
    store.insertApplication(acceptedApp('app-acc-fp'));
    projection = projectApplication('app-acc-fp', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.facets.source.status).toBe('source_reconcile_required');
    expect(projection.availableActions).toContain('fetch');

    // Sha mismatch: built from the right configuration but not the commit the
    // configuration currently names.
    store.insertGeneration({
      ...gen('gen-app-acc-sha', 'app-acc-sha'),
      commit_sha: 'def456',
    });
    store.insertApplication(acceptedApp('app-acc-sha', { desired_commit_sha: '789abc' }));
    projection = projectApplication('app-acc-sha', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.facets.source.status).toBe('source_reconcile_required');
    expect(projection.availableActions).toContain('fetch');
  });

  it('limits fetch to live Direct applications', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    // Direct control: a never-reconciled stack is offered fetch.
    tx.activateDirect({ application: app('app-fetch-direct', 'fetch-direct-web'), nodeId: 1, envelope: env('op-fd') });
    const direct = projectApplication('app-fetch-direct', false);
    if (direct.targetMode === 'not_applicable') throw new Error('expected application');
    expect(direct.availableActions).toContain('fetch');

    // A Git-backed Blueprint application with the same unreconciled source
    // state gets no fetch: the revision-state action rules reserve fetch for
    // Direct applications, and Blueprint source integration ships later.
    store.insertApplication(rawApp('app-fetch-bp', {
      target_mode: 'blueprint',
      blueprint_id: 21,
      lifecycle_key: 'blueprint:21',
      stack_name: null,
    }));
    const bp = projectApplication('app-fetch-bp', false);
    if (bp.targetMode === 'not_applicable') throw new Error('expected application');
    expect(bp.availableActions).not.toContain('fetch');
  });

  it('offers approve_legacy while Inline placement review is pending', () => {
    const store = GitOpsStore.getInstance();
    store.insertApplication(rawApp('app-bp-legacy', {
      target_mode: 'inline_blueprint',
      blueprint_id: 11,
      lifecycle_key: 'blueprint:11',
      stack_name: null,
      configured_repo_url: null,
      repo_identity_json: null,
      configured_ref: null,
      intent_revision_id: 'ir-11',
      legacy_combined_approval_ref: 'legacy-combined-11',
    }));

    const projection = projectApplication('app-bp-legacy', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.facets.placement.status).toBe('placement_review_pending');
    expect(projection.availableActions).toEqual(['approve_legacy']);
  });

  it('projects placement review pending for a Git-managed candidate with no placement approval', () => {
    const store = GitOpsStore.getInstance();
    store.insertApplication(rawApp('app-bp-git-placement', {
      target_mode: 'blueprint',
      blueprint_id: 91,
      lifecycle_key: 'blueprint:91',
      stack_name: null,
      intent_revision_id: 'ir-91',
      rollout_candidate_id: 'cand-91',
      source_acceptance_ref: 'acc-91',
    }));

    const projection = projectApplication('app-bp-git-placement', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.facets.placement.status).toBe('placement_review_pending');
    // The combined Apply action belongs to the Inline flow; a Git-managed
    // review is the decomposed placement action.
    expect(projection.availableActions).not.toContain('approve_legacy');
  });

  it('projects source acceptance pending for a Git-managed candidate newer than the accepted generation', () => {
    const store = GitOpsStore.getInstance();
    store.insertApplication(rawApp('app-bp-git-followup', {
      target_mode: 'blueprint',
      blueprint_id: 93,
      lifecycle_key: 'blueprint:93',
      stack_name: null,
      intent_revision_id: 'ir-93',
      candidate_generation_id: 'gen-new',
      accepted_generation_id: 'gen-old',
      source_acceptance_ref: 'acc-old',
      placement_approval_ref: 'place-old',
      rollout_candidate_id: 'cand-93',
    }));

    const projection = projectApplication('app-bp-git-followup', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.facets.placement.status).toBe('source_acceptance_pending');
    if (projection.facets.placement.status !== 'source_acceptance_pending') throw new Error('expected pending');
    expect(projection.facets.placement.candidateGenerationId).toBe('gen-new');
    expect(projection.facets.placement.sourceAcceptanceRef).toBe('acc-old');
  });

  it('keeps blueprint_bound for an Inline candidate with no placement approval', () => {
    const store = GitOpsStore.getInstance();
    store.insertApplication(rawApp('app-bp-inline-placement', {
      target_mode: 'inline_blueprint',
      blueprint_id: 92,
      lifecycle_key: 'blueprint:92',
      stack_name: null,
      configured_repo_url: null,
      repo_identity_json: null,
      configured_ref: null,
      intent_revision_id: 'ir-92',
      rollout_candidate_id: 'cand-92',
      source_acceptance_ref: 'acc-92',
    }));

    const projection = projectApplication('app-bp-inline-placement', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.facets.placement.status).toBe('blueprint_bound');
  });

  it('does not report source acceptance pending for a stale candidate binding', () => {
    const store = GitOpsStore.getInstance();
    store.insertApplication(rawApp('app-bp-git-rebound', {
      target_mode: 'blueprint',
      blueprint_id: 94,
      lifecycle_key: 'blueprint:94',
      stack_name: null,
      intent_revision_id: 'ir-94',
      candidate_generation_id: null,
      accepted_generation_id: 'gen-new',
      source_acceptance_ref: 'acc-new',
      placement_approval_ref: 'place-94',
      artifact_set_id: 'art-94',
      latest_artifact_set_id: 'art-94',
      rollout_candidate_id: 'cand-94',
    }));
    // The candidate was bound by an earlier rollout to the previous
    // generation. Its binding is not a generation awaiting acceptance.
    store.insertRolloutCandidate({
      id: 'cand-94',
      application_id: 'app-bp-git-rebound',
      intent_revision_id: 'ir-94',
      compose_content_sha256: 'c'.repeat(64),
      accepted_generation_id: 'gen-old',
      artifact_set_id: null,
      required_targets_json: '{"nodeIds":[1]}',
      authoritative: 1,
      provenance: 'intent_change',
      operation_id: 'op-cand-94',
      created_at: 1,
    });
    store.insertArtifactSet({
      id: 'art-94',
      generation_id: 'gen-new',
      evidence_version: 1,
      authoritative: 0,
      qualification: 'unresolved',
      evidence_json: '{"kind":"unresolved"}',
      created_at: 1,
    });

    const projection = projectApplication('app-bp-git-rebound', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.facets.placement.status).toBe('blueprint_bound');
  });

  it('names the unresolved artifact identity as the placement block reason', () => {
    const store = GitOpsStore.getInstance();
    store.insertApplication(rawApp('app-bp-git-artifact', {
      target_mode: 'blueprint',
      blueprint_id: 95,
      lifecycle_key: 'blueprint:95',
      stack_name: null,
      intent_revision_id: 'ir-95',
      candidate_generation_id: null,
      accepted_generation_id: 'gen-95',
      source_acceptance_ref: 'acc-95',
      placement_approval_ref: 'place-95',
      artifact_set_id: 'art-95',
      latest_artifact_set_id: 'art-95',
      rollout_candidate_id: 'cand-95',
    }));
    store.insertRolloutCandidate({
      id: 'cand-95',
      application_id: 'app-bp-git-artifact',
      intent_revision_id: 'ir-95',
      compose_content_sha256: 'c'.repeat(64),
      accepted_generation_id: null,
      artifact_set_id: null,
      required_targets_json: '{"nodeIds":[1]}',
      authoritative: 1,
      provenance: 'intent_change',
      operation_id: 'op-cand-95',
      created_at: 1,
    });
    store.insertArtifactSet({
      id: 'art-95',
      generation_id: 'gen-95',
      evidence_version: 1,
      authoritative: 0,
      qualification: 'unresolved',
      evidence_json: '{"kind":"unresolved"}',
      created_at: 1,
    });
    store.insertGeneration(gen('gen-95', 'app-bp-git-artifact'));
    const approvalBase = {
      application_id: 'app-bp-git-artifact',
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
    };
    store.insertApproval({
      ...approvalBase,
      id: 'acc-95',
      kind: 'source_acceptance',
      authority: 'operator',
      authoritative: 1,
      generation_id: 'gen-95',
    });
    store.insertApproval({
      ...approvalBase,
      id: 'place-95',
      kind: 'placement_approval',
      authority: 'operator',
      authoritative: 1,
      intent_revision_id: 'ir-95',
      required_targets_json: '{"nodeIds":[1]}',
      blast_json: '[]',
    });

    const projection = projectApplication('app-bp-git-artifact', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.facets.placement.status).toBe('preflight_blocked');
    if (projection.facets.placement.status !== 'preflight_blocked') throw new Error('expected blocked');
    expect(projection.facets.placement.reason).toMatch(/artifact identity/i);
  });

  it('still judges a target with no desired id against its deployed pointer', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-null-desired', 'null-desired-web'), nodeId: 1, envelope: env('op-null') });
    store.insertGeneration(gen('gen-a-null', 'app-null-desired'));
    // Recovered and legacy rows can carry pointers with no desired id. The
    // deployed pointer stays their only basis to judge.
    store.upsertTarget({
      ...emptyTargetRow('app-null-desired', 1, 1),
      applied_generation_id: 'gen-a-null',
      deployed_generation_id: 'gen-a-null',
      healthy_generation_id: 'gen-a-null',
    });

    const projection = projectApplication('app-null-desired', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.targets[0]?.runtime.status).toBe('synced_and_healthy');
    expect(projection.targets[0]?.health.status).toBe('passed');
  });

  it('emits the runtime drift item when a comparable observation disagrees', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-drift-item', 'drift-item-web'), nodeId: 1, envelope: env('op-drift') });
    store.insertGeneration(gen('gen-drift', 'app-drift-item'));
    store.insertArtifactSet({
      id: 'art-expected-drift',
      generation_id: 'gen-drift',
      evidence_version: 1,
      authoritative: 0,
      qualification: 'exact',
      evidence_json: JSON.stringify({ kind: 'exact', identity: 'sha256:wanted' }),
      created_at: 1,
    });
    store.upsertTarget({
      ...emptyTargetRow('app-drift-item', 1, 1),
      desired_generation_id: 'gen-drift',
      applied_generation_id: 'gen-drift',
      deployed_generation_id: 'gen-drift',
      expected_artifact_set_id: 'art-expected-drift',
      observed_artifact_identity_json: JSON.stringify({ kind: 'exact', identity: 'sha256:serving', observedAt: 42 }),
    });

    let projection = projectApplication('app-drift-item', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.targets[0]?.runtime.status).toBe('runtime_artifact_drift');
    expect(projection.drift).toHaveLength(1);
    expect(projection.drift[0]).toEqual({
      class: 'runtime',
      expected: { kind: 'artifact_set', id: 'art-expected-drift', qualification: 'exact', evidenceVersion: 1 },
      observed: { kind: 'runtime_artifact', identity: 'sha256:serving', observedAt: 42 },
      freshnessAt: 42,
      owner: 'observed_artifact_identity',
      reason: 'the running workload reports an artifact identity other than the expected artifact set',
      configuredPolicy: null,
      affectedTargets: [{ nodeId: 1, stackName: 'drift-item-web' }],
      action: 'none',
    });

    // Equal comparable identities are not drift: the item disappears and the
    // chain continues to health instead of parking in verification pending.
    store.upsertTarget({
      ...emptyTargetRow('app-drift-item', 1, 1),
      desired_generation_id: 'gen-drift',
      applied_generation_id: 'gen-drift',
      deployed_generation_id: 'gen-drift',
      expected_artifact_set_id: 'art-expected-drift',
      observed_artifact_identity_json: JSON.stringify({ kind: 'qualified', identity: 'sha256:wanted', observedAt: 43 }),
    });
    projection = projectApplication('app-drift-item', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.drift).toHaveLength(0);

    // An observation that is not comparable never becomes a confirmed item.
    store.upsertTarget({
      ...emptyTargetRow('app-drift-item', 1, 1),
      desired_generation_id: 'gen-drift',
      applied_generation_id: 'gen-drift',
      deployed_generation_id: 'gen-drift',
      expected_artifact_set_id: 'art-expected-drift',
      observed_artifact_identity_json: JSON.stringify({ kind: 'stale', identity: 'sha256:serving', observedAt: 44 }),
    });
    projection = projectApplication('app-drift-item', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.targets[0]?.runtime.status).toBe('artifact_verification_pending');
    expect(projection.drift).toHaveLength(0);

    // Ordering pin: a stale deployment outranks artifact verification. With
    // the desired generation applied but an older one deployed, the deploy
    // question comes first, so the mismatch item is emitted while the artifact
    // observation describing the workload about to be replaced is not.
    store.insertGeneration(gen('gen-b-drift', 'app-drift-item'));
    store.upsertTarget({
      ...emptyTargetRow('app-drift-item', 1, 1),
      desired_generation_id: 'gen-drift',
      applied_generation_id: 'gen-drift',
      deployed_generation_id: 'gen-b-drift',
      healthy_generation_id: 'gen-b-drift',
      expected_artifact_set_id: 'art-expected-drift',
      observed_artifact_identity_json: JSON.stringify({ kind: 'exact', identity: 'sha256:serving', observedAt: 45 }),
    });
    projection = projectApplication('app-drift-item', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.targets[0]?.runtime.status).toBe('applied_not_deployed');
    expect(projection.drift).toHaveLength(1);
    expect(projection.drift[0]).toEqual({
      class: 'runtime',
      expected: { kind: 'generation', id: 'gen-drift' },
      observed: { kind: 'generation', id: 'gen-b-drift' },
      // Pointer-to-pointer comparison carries no observation timestamp.
      freshnessAt: null,
      owner: 'ComposeService',
      reason: 'the target is running a different generation than the one it was asked to run',
      configuredPolicy: null,
      affectedTargets: [{ nodeId: 1, stackName: 'drift-item-web' }],
      action: 'deploy',
    });

    // An application-level gate withholds the action without removing the
    // fact: a fetch in flight makes availableActions none, so the item must
    // say none too rather than contradicting the payload it travels in.
    tx.fetchStarted('app-drift-item', env('op-f-drift'));
    projection = projectApplication('app-drift-item', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.availableActions).toEqual(['none']);
    expect(projection.drift).toHaveLength(1);
    expect(projection.drift[0].action).toBe('none');
  });

  it('offers suspend on a live Direct source and never retry', () => {
    const store = GitOpsStore.getInstance();
    store.insertGeneration(gen('gen-app-live-suspend', 'app-live-suspend'));
    store.insertApplication(rawApp('app-live-suspend', {
      stack_name: 'live-suspend-web',
      accepted_generation_id: 'gen-app-live-suspend',
      desired_commit_sha: 'abc123',
    }));
    const projection = projectApplication('app-live-suspend', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.availableActions).toContain('suspend');
    expect(projection.availableActions).not.toContain('resume');
    expect(projection.availableActions).not.toContain('retry');
  });

  it('offers resume on a suspended Direct source and never retry', () => {
    const store = GitOpsStore.getInstance();
    store.insertApplication(rawApp('app-suspended', {
      stack_name: 'suspended-web',
      suspended_at: 10,
      source_suspended_reason: 'paused',
      retry_at: 99,
      retry_count: 2,
      failure_stage: 'fetch',
      failure_class: 'NETWORK_TIMEOUT',
      failure_at: 1,
    }));
    const projection = projectApplication('app-suspended', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.facets.source.status).toBe('source_suspended');
    expect(projection.availableActions).toContain('resume');
    expect(projection.availableActions).not.toContain('suspend');
    expect(projection.availableActions).not.toContain('retry');
  });

  it('offers retry only for retry-eligible failures that are not suspended', () => {
    const store = GitOpsStore.getInstance();
    store.insertApplication(rawApp('app-failed-retry', {
      stack_name: 'failed-retry-web',
      failure_stage: 'fetch',
      failure_class: 'NETWORK_TIMEOUT',
      failure_at: 1,
    }));
    let projection = projectApplication('app-failed-retry', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.facets.source.status).toBe('source_failed');
    expect(projection.availableActions).toContain('retry');
    expect(projection.availableActions).toContain('suspend');
    expect(projection.availableActions).not.toContain('resume');

    store.insertApplication(rawApp('app-retry-sched', {
      stack_name: 'retry-sched-web',
      retry_at: 50,
      retry_count: 1,
    }));
    projection = projectApplication('app-retry-sched', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.facets.source.status).toBe('source_retry_scheduled');
    expect(projection.availableActions).toContain('retry');
    expect(projection.availableActions).toContain('suspend');
  });

  it('does not offer controller actions on Blueprint applications', () => {
    const store = GitOpsStore.getInstance();
    store.insertApplication(rawApp('app-bp-ctrl', {
      target_mode: 'blueprint',
      blueprint_id: 31,
      lifecycle_key: 'blueprint:31',
      stack_name: null,
    }));
    const projection = projectApplication('app-bp-ctrl', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.availableActions).not.toContain('suspend');
    expect(projection.availableActions).not.toContain('resume');
    expect(projection.availableActions).not.toContain('retry');
  });

  it('keeps Inline artifact not_applicable until a frozen generation exists', () => {
    const store = GitOpsStore.getInstance();
    store.insertApplication(rawApp('app-inline-nofreeze', {
      target_mode: 'inline_blueprint',
      blueprint_id: 40,
      lifecycle_key: 'blueprint:40',
      stack_name: null,
      configured_repo_url: null,
      repo_identity_json: null,
      configured_ref: null,
    }));
    store.upsertTarget(emptyTargetRow('app-inline-nofreeze', 1, 1));

    const projection = projectApplication('app-inline-nofreeze', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.facets.artifact.status).toBe('not_applicable');
    expect(projection.targets[0]?.artifact.status).toBe('not_applicable');
    expect(projection.facets.rollout.status).not.toBe('exactly_converged_healthy');
  });

  it('projects runtime_artifact_drift for Inline once a frozen exact set disagrees with observation', () => {
    const store = GitOpsStore.getInstance();
    store.insertGeneration(gen('gen-inline-freeze', 'app-inline-freeze'));
    store.insertArtifactSet({
      id: 'art-inline-freeze',
      generation_id: 'gen-inline-freeze',
      evidence_version: 1,
      authoritative: 0,
      qualification: 'exact',
      evidence_json: JSON.stringify({ kind: 'exact', identity: 'sha256:wanted-inline' }),
      created_at: 1,
    });
    store.insertApplication(rawApp('app-inline-freeze', {
      target_mode: 'inline_blueprint',
      blueprint_id: 41,
      lifecycle_key: 'blueprint:41',
      stack_name: null,
      configured_repo_url: null,
      repo_identity_json: null,
      configured_ref: null,
      accepted_generation_id: 'gen-inline-freeze',
      artifact_set_id: 'art-inline-freeze',
      latest_artifact_set_id: 'art-inline-freeze',
    }));
    store.upsertTarget({
      ...emptyTargetRow('app-inline-freeze', 1, 1),
      desired_generation_id: 'gen-inline-freeze',
      applied_generation_id: 'gen-inline-freeze',
      deployed_generation_id: 'gen-inline-freeze',
      expected_artifact_set_id: 'art-inline-freeze',
      latest_artifact_set_id: 'art-inline-freeze',
      observed_artifact_identity_json: JSON.stringify({
        kind: 'exact',
        identity: 'sha256:serving-inline',
        observedAt: 7,
      }),
    });

    const projection = projectApplication('app-inline-freeze', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.facets.artifact.status).toBe('artifact_exact');
    expect(projection.targets[0]?.runtime.status).toBe('runtime_artifact_drift');
    expect(projection.drift).toHaveLength(1);
    expect(projection.drift[0]?.class).toBe('runtime');
    expect(projection.drift[0]?.observed).toEqual({
      kind: 'runtime_artifact',
      identity: 'sha256:serving-inline',
      observedAt: 7,
    });
  });

  it('treats mixed-platform observations as matched against each target\'s approved child', () => {
    const amd = `sha256:${'a'.repeat(64)}`;
    const arm = `sha256:${'b'.repeat(64)}`;
    const index = `sha256:${'1'.repeat(64)}`;
    const expectedService: ServiceArtifactEvidence = {
      serviceName: 'web',
      authoredRef: 'nginx:latest',
      source: 'registry',
      platform: 'linux/amd64',
      indexDigest: index,
      platformDigest: amd,
      platformVariants: [
        { platform: 'linux/amd64', digest: amd },
        { platform: 'linux/arm64', digest: arm },
      ],
      localDigests: null,
      buildContextFingerprint: null,
      producedImageId: null,
      failureClass: null,
      resolvedAt: 1,
    };
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-mixed-arch', 'mixed-arch-web'), nodeId: 1, envelope: env('op-mixed') });
    store.insertGeneration(gen('gen-mixed-arch', 'app-mixed-arch'));
    store.insertArtifactSet({
      id: 'art-mixed-arch',
      generation_id: 'gen-mixed-arch',
      evidence_version: 1,
      authoritative: 0,
      qualification: 'exact',
      evidence_json: encodeArtifactEvidenceJson({
        kind: 'exact',
        identity: `sha256:${'e'.repeat(64)}`,
        services: [expectedService],
      }),
      created_at: 1,
    });
    store.upsertTarget({
      ...emptyTargetRow('app-mixed-arch', 1, 1),
      desired_generation_id: 'gen-mixed-arch',
      applied_generation_id: 'gen-mixed-arch',
      deployed_generation_id: 'gen-mixed-arch',
      healthy_generation_id: 'gen-mixed-arch',
      expected_artifact_set_id: 'art-mixed-arch',
      observed_artifact_identity_json: encodeObservedArtifactIdentity({
        kind: 'exact',
        identity: `sha256:${'f'.repeat(64)}`,
        observedAt: 11,
        services: [{
          ...expectedService,
          platform: 'linux/arm64',
          platformDigest: arm,
          localDigests: [arm],
          platformVariants: null,
        }],
      }),
    });

    const projection = projectApplication('app-mixed-arch', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.targets[0]?.runtime.status).toBe('synced_and_healthy');
    expect(projection.drift).toHaveLength(0);
  });

  /**
   * The application-level drift classes beyond the runtime family. Each class
   * is pinned in three directions: an item when the rows prove divergence, no
   * item when they agree, and no item (never a fabricated convergence or
   * divergence claim) when the evidence a comparison would need is missing.
   */
  /**
   * The same projection with an explicit rollout facet. The stored rows for a
   * completed rollout are the subject of the rollout suites; these tests need
   * the settled and queued statuses as the given fact, and the rows still have
   * to satisfy every other producer.
   */
  function projectionWithRollout(
    applicationId: string,
    rollout: NonNullable<FutureGitOpsEvidence['rollout']>,
  ): GitOpsRevisionProjection {
    const store = GitOpsStore.getInstance();
    const application = store.getApplication(applicationId);
    if (!application) throw new Error('application missing');
    return deriveGitOpsRevision(
      { application, targets: store.listTargets(applicationId), healthDisabled: false },
      { applicationId, source: null, placement: null, rollout, targetRuntime: [] },
    );
  }

  function seedGitSource(stackName: string, overrides: Partial<{
    autoApplyOnWebhook: boolean;
    autoDeployOnApply: boolean;
  }> = {}): void {
    DatabaseService.getInstance().upsertGitSource({
      stack_name: stackName,
      repo_url: 'https://github.com/org/repo.git',
      branch: 'main',
      compose_path: 'compose.yml',
      compose_paths: ['compose.yml'],
      context_dir: null,
      sync_env: false,
      env_path: null,
      auth_type: 'none',
      encrypted_token: null,
      encrypted_deploy_key: null,
      ssh_known_hosts_entry: null,
      ssh_host_key_fingerprint: null,
      encrypted_ca_bundle: null,
      auto_apply_on_webhook: overrides.autoApplyOnWebhook ?? false,
      auto_deploy_on_apply: overrides.autoDeployOnApply ?? false,
      last_applied_commit_sha: null,
      last_applied_content_hash: null,
      pending_commit_sha: null,
      pending_compose_content: null,
      pending_env_content: null,
      pending_fetched_at: null,
      last_debounce_at: null,
    });
  }

  function setManifestCache(
    stackName: string,
    cache: { version: number | null; state: string | null; generation: string | null; commit: string | null; updatedAt?: number },
  ): void {
    DatabaseService.getInstance().getDb().prepare(
      `UPDATE stack_git_sources
         SET manifest_version = ?, manifest_state = ?, manifest_generation = ?, last_applied_commit_sha = ?, updated_at = ?
       WHERE stack_name = ?`,
    ).run(cache.version, cache.state, cache.generation, cache.commit, cache.updatedAt ?? 1, stackName);
  }

  function intentRev(
    id: string,
    applicationId: string,
    sha: string,
    driftPolicy: string | null = null,
  ): GitOpsIntentRevisionRow {
    return {
      id,
      application_id: applicationId,
      blueprint_id: 1,
      compose_content_sha256: sha,
      blueprint_revision: 1,
      deploy_stack_name: `${applicationId}-stack`,
      selector_json: '{}',
      pinned_node_id: null,
      cordon_implications_json: '[]',
      rollout_strategy_json: '{}',
      runtime_drift_policy: driftPolicy,
      stateful_policy_json: null,
      health_failure_rollback_policy_json: null,
      operation_id: `op-${id}`,
      actor: 'tester',
      created_at: 1,
    };
  }

  function gitManagedApp(id: string, blueprintId: number, overrides: Partial<GitOpsApplicationRow> = {}): GitOpsApplicationRow {
    // The blueprint CHECK requires blueprint_id, a null stack name, and a
    // configured repo URL; the URL is the source identity the mode carries.
    // One live application per blueprint, so every caller names its own id.
    return rawApp(id, {
      target_mode: 'blueprint',
      blueprint_id: blueprintId,
      lifecycle_key: `blueprint:${blueprintId}:${id}`,
      stack_name: null,
      ...overrides,
    });
  }

  it('reports source drift when the accepted generation trails the configured ref', () => {
    const store = GitOpsStore.getInstance();
    seedGitSource('src-drift-web', { autoApplyOnWebhook: true });
    store.insertApplication(rawApp('app-src-drift', {
      stack_name: 'src-drift-web',
      desired_commit_sha: 'newsha',
      accepted_generation_id: 'gen-src-drift',
    }));
    store.insertGeneration({ ...gen('gen-src-drift', 'app-src-drift'), commit_sha: 'oldsha' });

    const projection = projectApplication('app-src-drift', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    const item = projection.drift.find((entry) => entry.class === 'source');
    expect(item).toMatchObject({
      class: 'source',
      expected: { kind: 'commit', sha: 'newsha', repoUrl: 'https://github.com/org/repo.git', ref: 'main' },
      observed: { kind: 'commit', sha: 'oldsha' },
      owner: 'GitSourceService',
      configuredPolicy: { kind: 'git_source', autoApplyOnWebhook: true, autoDeployOnApply: false },
      action: 'fetch',
    });
  });

  it('does not call a settings-only change source drift, and asks for a reconcile instead', () => {
    const store = GitOpsStore.getInstance();
    seedGitSource('src-drift-fp', { autoApplyOnWebhook: true });
    // The accepted commit is still the commit the ref names, and only the
    // materialization settings moved on. Source drift compares commits, so there
    // is no expected-versus-observed pair of commits to report, and the shape is
    // an attention item instead. This is the decided behavior, pinned here so it
    // cannot drift silently in either direction.
    store.insertApplication(rawApp('app-src-drift-fp', {
      stack_name: 'src-drift-fp',
      desired_commit_sha: 'oldsha',
      accepted_generation_id: 'gen-src-drift-fp',
      materialization_fingerprint: 'f'.repeat(64),
    }));
    store.insertGeneration({
      ...gen('gen-src-drift-fp', 'app-src-drift-fp'),
      commit_sha: 'oldsha',
      materialization_fingerprint: 'e'.repeat(64),
    });

    const projection = projectApplication('app-src-drift-fp', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.drift.filter((entry) => entry.class === 'source')).toEqual([]);
    expect(projection.facets.source.status).toBe('source_reconcile_required');
    expect(projection.availableActions).toContain('fetch');
  });

  it('does not call a staged or held candidate source drift', () => {
    const store = GitOpsStore.getInstance();
    // The ref has already advanced to a commit nobody accepted, which is
    // exactly the pointer state a staged candidate and a held review create.
    const staged = [
      { appId: 'app-src-ready', stackName: 'src-ready-web', reviewRequired: 0, facet: 'candidate_ready' },
      { appId: 'app-src-held', stackName: 'src-held-web', reviewRequired: 1, facet: 'source_review_pending' },
    ] as const;
    for (const { appId, stackName, reviewRequired } of staged) {
      seedGitSource(stackName);
      store.insertApplication(rawApp(appId, {
        stack_name: stackName,
        desired_commit_sha: 'newsha',
        fetched_commit_sha: 'newsha',
        accepted_generation_id: `gen-src-staged-${appId}`,
        candidate_generation_id: `gen-src-candidate-${appId}`,
        review_required: reviewRequired,
      }));
      store.insertGeneration({ ...gen(`gen-src-staged-${appId}`, appId), commit_sha: 'oldsha' });
      store.insertGeneration({ ...gen(`gen-src-candidate-${appId}`, appId), commit_sha: 'newsha' });
    }

    for (const { appId, facet } of staged) {
      const projection = projectApplication(appId, false);
      if (projection.targetMode === 'not_applicable') throw new Error('expected application');
      expect(projection.facets?.source.status).toBe(facet);
      expect(projection.drift.filter((entry) => entry.class === 'source')).toEqual([]);
    }
  });

  it('reports a failed fetch as source drift and stays quiet once the ref is accepted', () => {
    const store = GitOpsStore.getInstance();
    store.insertApplication(rawApp('app-src-fail', {
      stack_name: 'src-fail-web',
      failure_stage: 'fetch',
      failure_class: 'NETWORK_TIMEOUT',
      failure_at: 42,
    }));
    let projection = projectApplication('app-src-fail', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.drift).toEqual([
      expect.objectContaining({
        class: 'source',
        expected: { kind: 'none' },
        observed: { kind: 'unknown' },
        freshnessAt: 42,
        action: 'fetch',
      }),
    ]);

    // Converged: the accepted generation is the commit the ref names.
    store.insertApplication(rawApp('app-src-ok', {
      stack_name: 'src-ok-web',
      desired_commit_sha: 'abc123',
      accepted_generation_id: 'gen-src-ok',
    }));
    store.insertGeneration(gen('gen-src-ok', 'app-src-ok'));
    projection = projectApplication('app-src-ok', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.drift).toEqual([]);
  });

  it('reports a stale placement approval that no longer binds the current intent', () => {
    const store = GitOpsStore.getInstance();
    store.insertApplication(gitManagedApp('app-place-stale', 71, {
      intent_revision_id: 'ir-place-current',
      rollout_candidate_id: 'cand-place',
      placement_approval_ref: 'place-stale',
    }));
    store.insertIntentRevision(intentRev('ir-place-current', 'app-place-stale', 'a'.repeat(64), 'suggest'));
    store.insertIntentRevision(intentRev('ir-place-old', 'app-place-stale', 'b'.repeat(64)));
    store.insertRolloutCandidate({
      id: 'cand-place',
      application_id: 'app-place-stale',
      intent_revision_id: 'ir-place-current',
      compose_content_sha256: 'a'.repeat(64),
      accepted_generation_id: null,
      artifact_set_id: null,
      required_targets_json: '{"nodeIds":[1]}',
      authoritative: 1,
      provenance: 'intent_change',
      operation_id: 'op-cand-place',
      created_at: 1,
    });
    store.insertApproval({
      id: 'place-stale',
      kind: 'placement_approval',
      authority: 'operator',
      authoritative: 1,
      application_id: 'app-place-stale',
      generation_id: null,
      intent_revision_id: 'ir-place-old',
      artifact_set_id: null,
      rollout_candidate_id: null,
      rollout_generation_id: null,
      source_acceptance_ref: null,
      placement_approval_ref: null,
      required_targets_json: '{"nodeIds":[1]}',
      preflight_fingerprint: null,
      fingerprint: null,
      blast_json: '[]',
      policy_provenance_json: null,
      actor: 'tester',
      created_at: 9,
    });

    const projection = projectApplication('app-place-stale', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    const items = projection.drift.filter((entry) => entry.class === 'placement');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      expected: { kind: 'intent', id: 'ir-place-current', composeContentSha256: 'a'.repeat(64) },
      observed: { kind: 'intent', id: 'ir-place-old', composeContentSha256: 'b'.repeat(64) },
      freshnessAt: 9,
      owner: 'BlueprintReconciler',
      configuredPolicy: { kind: 'blueprint_drift', driftMode: 'suggest' },
      action: 'none',
    });
  });

  it('reports a target holding authority outside the current required set once the rollout settles', () => {
    const store = GitOpsStore.getInstance();
    // A placement approval that does bind the current intent and target set,
    // so the application is settled rather than waiting for a decision.
    store.insertApproval({
      id: 'place-ok',
      kind: 'placement_approval',
      authority: 'operator',
      authoritative: 1,
      application_id: 'app-place-outside',
      generation_id: null,
      intent_revision_id: 'ir-place-set',
      artifact_set_id: null,
      rollout_candidate_id: null,
      rollout_generation_id: null,
      source_acceptance_ref: null,
      placement_approval_ref: null,
      required_targets_json: '{"nodeIds":[1]}',
      preflight_fingerprint: null,
      fingerprint: null,
      blast_json: '[]',
      policy_provenance_json: null,
      actor: 'tester',
      created_at: 1,
    });
    store.insertApplication(gitManagedApp('app-place-outside', 72, {
      intent_revision_id: 'ir-place-set',
      rollout_candidate_id: 'cand-place-set',
      placement_approval_ref: 'place-ok',
    }));
    store.insertIntentRevision(intentRev('ir-place-set', 'app-place-outside', 'c'.repeat(64)));
    store.insertRolloutCandidate({
      id: 'cand-place-set',
      application_id: 'app-place-outside',
      intent_revision_id: 'ir-place-set',
      compose_content_sha256: 'c'.repeat(64),
      accepted_generation_id: null,
      artifact_set_id: null,
      required_targets_json: '{"nodeIds":[1]}',
      authoritative: 1,
      provenance: 'intent_change',
      operation_id: 'op-cand-place-set',
      created_at: 1,
    });
    // Node 1 is in the required set and is not drift; node 2 applied under the
    // same intent but is outside it.
    store.upsertTarget({
      ...emptyTargetRow('app-place-outside', 1, 1),
      applied_generation_id: 'gen-place',
      intent_revision_id: 'ir-place-set',
    });
    store.upsertTarget({
      ...emptyTargetRow('app-place-outside', 2, 1),
      applied_generation_id: 'gen-place',
      intent_revision_id: 'ir-place-set',
    });

    // Settled: the rollout that should have withdrawn node 2 has converged.
    const settled = projectionWithRollout('app-place-outside', {
      kind: 'configuration_converged_artifact_qualified',
      rolloutGenerationId: 'rg-place',
    });
    if (settled.targetMode === 'not_applicable') throw new Error('expected application');
    expect(settled.facets?.placement.status).toBe('blueprint_bound');
    expect(settled.facets?.rollout.status).toBe('configuration_converged_artifact_qualified');
    const items = settled.drift.filter((entry) => entry.class === 'placement');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      owner: 'BlueprintReconciler',
      freshnessAt: 1,
      affectedTargets: [{ nodeId: 2, stackName: 'app-place-outside-stack' }],
      action: 'none',
    });
    expect(items[0].observed).toEqual({
      kind: 'intent',
      id: 'ir-place-set',
      composeContentSha256: 'c'.repeat(64),
    });

    // Queued: the same extra target is the shape of a rollout in progress.
    const queued = projectionWithRollout('app-place-outside', {
      kind: 'queued',
      rolloutGenerationId: 'rg-place',
    });
    if (queued.targetMode === 'not_applicable') throw new Error('expected application');
    expect(queued.drift.filter((entry) => entry.class === 'placement')).toEqual([]);

    // Interrupted withdrawal: the outcome of the operation is unknown, so the
    // extra target is not a settled divergence.
    store.upsertTarget({
      ...emptyTargetRow('app-place-outside', 2, 3),
      applied_generation_id: 'gen-place',
      intent_revision_id: 'ir-place-set',
      interruption_stage: 'blueprint_withdraw_started',
      interruption_at: 3,
    });
    const interrupted = projectionWithRollout('app-place-outside', {
      kind: 'configuration_converged_artifact_qualified',
      rolloutGenerationId: 'rg-place',
    });
    if (interrupted.targetMode === 'not_applicable') throw new Error('expected application');
    expect(interrupted.drift.filter((entry) => entry.class === 'placement')).toEqual([]);
  });

  it('does not guess placement drift without a candidate that names the required set', () => {
    const store = GitOpsStore.getInstance();
    store.insertApplication(gitManagedApp('app-place-unknown', 73, {
      intent_revision_id: 'ir-place-unknown',
      placement_approval_ref: 'place-missing',
    }));
    store.insertIntentRevision(intentRev('ir-place-unknown', 'app-place-unknown', 'd'.repeat(64)));
    store.upsertTarget({
      ...emptyTargetRow('app-place-unknown', 2, 1),
      applied_generation_id: 'gen-place',
    });

    const projection = projectApplication('app-place-unknown', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.drift.filter((entry) => entry.class === 'placement')).toEqual([]);
  });

  it('reports health drift only for a failed run bound to the deployed generation', () => {
    const store = GitOpsStore.getInstance();
    const db = DatabaseService.getInstance();
    store.insertApplication(rawApp('app-health-drift', { stack_name: 'health-drift-web' }));
    store.insertGeneration(gen('gen-health', 'app-health-drift'));
    store.upsertTarget({
      ...emptyTargetRow('app-health-drift', 1, 1),
      desired_generation_id: 'gen-health',
      applied_generation_id: 'gen-health',
      deployed_generation_id: 'gen-health',
    });
    db.insertHealthGateRun({
      id: 'run-health-failed',
      node_id: 1,
      stack_name: 'health-drift-web',
      trigger_action: 'deploy',
      status: 'failed',
      reason: 'container exited',
      window_seconds: 30,
      containers_json: '[]',
      started_at: 10,
      ended_at: 20,
      created_by: 'tester',
      target_scope: 'stack',
      service_name: null,
      failure_source: null,
      deployed_generation_id: 'gen-health',
    });

    let projection = projectApplication('app-health-drift', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    const items = projection.drift.filter((entry) => entry.class === 'health');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      expected: { kind: 'generation', id: 'gen-health' },
      observed: { kind: 'health_run', runId: 'run-health-failed', deployedGenerationId: 'gen-health' },
      freshnessAt: 20,
      owner: 'HealthGateService',
      affectedTargets: [{ nodeId: 1, stackName: 'health-drift-web' }],
      action: 'none',
    });

    // Health disabled: the operator opted out, so the failed run claims nothing.
    const disabled = projectApplication('app-health-drift', true);
    if (disabled.targetMode === 'not_applicable') throw new Error('expected application');
    expect(disabled.drift.filter((entry) => entry.class === 'health')).toEqual([]);

    // A failed run bound to an older generation was superseded by the redeploy.
    db.getDb().prepare('DELETE FROM health_gate_runs').run();
    db.insertHealthGateRun({
      id: 'run-health-old',
      node_id: 1,
      stack_name: 'health-drift-web',
      trigger_action: 'deploy',
      status: 'failed',
      reason: 'container exited',
      window_seconds: 30,
      containers_json: '[]',
      started_at: 30,
      ended_at: 40,
      created_by: 'tester',
      target_scope: 'stack',
      service_name: null,
      failure_source: null,
      deployed_generation_id: 'gen-old',
    });
    projection = projectApplication('app-health-drift', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.drift.filter((entry) => entry.class === 'health')).toEqual([]);

    // A target mid-deploy has no verdict to read yet.
    store.upsertTarget({
      ...emptyTargetRow('app-health-drift', 1, 2),
      desired_generation_id: 'gen-health',
      applied_generation_id: 'gen-health',
      deployed_generation_id: 'gen-health',
      active_operation_stage: 'deploy_started',
    });
    db.getDb().prepare('DELETE FROM health_gate_runs').run();
    db.insertHealthGateRun({
      id: 'run-health-failed-2',
      node_id: 1,
      stack_name: 'health-drift-web',
      trigger_action: 'deploy',
      status: 'failed',
      reason: 'container exited',
      window_seconds: 30,
      containers_json: '[]',
      started_at: 50,
      ended_at: 60,
      created_by: 'tester',
      target_scope: 'stack',
      service_name: null,
      failure_source: null,
      deployed_generation_id: 'gen-health',
    });
    projection = projectApplication('app-health-drift', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.drift.filter((entry) => entry.class === 'health')).toEqual([]);
  });

  it('says why it cannot compare placement when the required targets are unreadable', () => {
    const store = GitOpsStore.getInstance();
    store.insertApplication(gitManagedApp('app-place-corrupt', 75, {
      intent_revision_id: 'ir-place-corrupt',
      rollout_candidate_id: 'cand-place-corrupt',
      placement_approval_ref: 'place-corrupt',
    }));
    store.insertIntentRevision(intentRev('ir-place-corrupt', 'app-place-corrupt', 'f'.repeat(64)));
    store.insertApproval({
      id: 'place-corrupt',
      kind: 'placement_approval',
      authority: 'operator',
      authoritative: 1,
      application_id: 'app-place-corrupt',
      generation_id: null,
      intent_revision_id: 'ir-place-corrupt',
      artifact_set_id: null,
      rollout_candidate_id: null,
      rollout_generation_id: null,
      source_acceptance_ref: null,
      placement_approval_ref: null,
      required_targets_json: '{"nodeIds":[1]}',
      preflight_fingerprint: null,
      fingerprint: null,
      blast_json: '[]',
      policy_provenance_json: null,
      actor: 'tester',
      created_at: 1,
    });
    store.insertRolloutCandidate({
      id: 'cand-place-corrupt',
      application_id: 'app-place-corrupt',
      intent_revision_id: 'ir-place-corrupt',
      compose_content_sha256: 'f'.repeat(64),
      accepted_generation_id: null,
      artifact_set_id: null,
      required_targets_json: '{"nodeIds":[1]}',
      authoritative: 1,
      provenance: 'intent_change',
      operation_id: 'op-cand-place-corrupt',
      created_at: 1,
    });
    // The store refuses this on write, so a row like it can only predate that
    // validation or arrive with a migration.
    DatabaseService.getInstance().getDb().prepare(
      "UPDATE gitops_rollout_candidates SET required_targets_json = 'not json' WHERE id = ?",
    ).run('cand-place-corrupt');
    store.upsertTarget({
      ...emptyTargetRow('app-place-corrupt', 2, 1),
      applied_generation_id: 'gen-place',
    });

    const projection = projectionWithRollout('app-place-corrupt', {
      kind: 'configuration_converged_artifact_qualified',
      rolloutGenerationId: 'rg-corrupt',
    });
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.drift.filter((entry) => entry.class === 'placement')).toEqual([]);
    expect(projection.limitations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'placement_required_targets_invalid' }),
    ]));
  });

  it('describes the observed source commit with the repository it was built from', () => {
    const store = GitOpsStore.getInstance();
    // The application has been rebound to a new repository and ref since the
    // accepted generation was built, so the old commit is not this repo's.
    store.insertApplication(rawApp('app-rebound', {
      stack_name: 'rebound-web',
      configured_repo_url: 'https://github.com/org/new.git',
      configured_ref: 'release',
      desired_commit_sha: 'newsha',
      accepted_generation_id: 'gen-rebound',
    }));
    store.insertGeneration({
      ...gen('gen-rebound', 'app-rebound'),
      commit_sha: 'oldsha',
      repo_url: 'https://github.com/org/old.git',
      configured_ref: 'main',
    });

    const projection = projectApplication('app-rebound', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    const item = projection.drift.find((entry) => entry.class === 'source');
    expect(item?.expected).toEqual({
      kind: 'commit',
      sha: 'newsha',
      repoUrl: 'https://github.com/org/new.git',
      ref: 'release',
    });
    expect(item?.observed).toEqual({
      kind: 'commit',
      sha: 'oldsha',
      repoUrl: 'https://github.com/org/old.git',
      ref: 'main',
    });
  });

  it('finds a health failure on the stack a converted application retained', () => {
    const store = GitOpsStore.getInstance();
    const db = DatabaseService.getInstance();
    // A Direct application converted to Blueprint mode keeps the stack it was
    // running under, and its target has no intent revision until the first
    // Blueprint rollout gives it one. That stack's deploys still open gates,
    // so its failed run is real evidence even though the application is no
    // longer Direct.
    store.insertApplication(gitManagedApp('app-converted', 74, {
      configured_source_stack_name: 'converted-web',
      intent_revision_id: 'ir-converted',
    }));
    store.insertIntentRevision(intentRev('ir-converted', 'app-converted', 'e'.repeat(64)));
    store.insertGeneration(gen('gen-converted', 'app-converted'));
    store.upsertTarget({
      ...emptyTargetRow('app-converted', 1, 1),
      applied_generation_id: 'gen-converted',
      deployed_generation_id: 'gen-converted',
    });
    db.insertHealthGateRun({
      id: 'run-converted',
      node_id: 1,
      stack_name: 'converted-web',
      trigger_action: 'deploy',
      status: 'failed',
      reason: 'container exited',
      window_seconds: 30,
      containers_json: '[]',
      started_at: 10,
      ended_at: 20,
      created_by: 'tester',
      target_scope: 'stack',
      service_name: null,
      failure_source: null,
      deployed_generation_id: 'gen-converted',
    });

    const projection = projectApplication('app-converted', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    const items = projection.drift.filter((entry) => entry.class === 'health');
    expect(items).toHaveLength(1);
    expect(items[0].affectedTargets).toEqual([{ nodeId: 1, stackName: 'converted-web' }]);
  });

  it('reports managed-project drift from the manifest cache and stays quiet when it agrees', () => {
    const store = GitOpsStore.getInstance();
    seedGitSource('mp-web');
    store.insertApplication(rawApp('app-mp', {
      stack_name: 'mp-web',
      desired_commit_sha: 'abc123',
      accepted_generation_id: 'gen-mp',
    }));
    store.insertGeneration({
      ...gen('gen-mp', 'app-mp'),
      manifest_version: 3,
      applied_dir: 'generations/applied-gen-mp-3',
    });
    store.upsertTarget({
      ...emptyTargetRow('app-mp', 1, 1),
      desired_generation_id: 'gen-mp',
      applied_generation_id: 'gen-mp',
      deployed_generation_id: 'gen-mp',
    });

    // Agreement: no item.
    setManifestCache('mp-web', {
      version: 3,
      state: 'active',
      generation: 'generations/applied-gen-mp-3',
      commit: 'abc123',
    });
    let projection = projectApplication('app-mp', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.drift.filter((entry) => entry.class === 'managed_project')).toEqual([]);

    // The applied project belongs to a different commit than the accepted one.
    setManifestCache('mp-web', {
      version: 3,
      state: 'active',
      generation: 'generations/applied-gen-mp-3',
      commit: 'othersha',
      updatedAt: 77,
    });
    projection = projectApplication('app-mp', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    const items = projection.drift.filter((entry) => entry.class === 'managed_project');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      expected: { kind: 'generation', id: 'gen-mp' },
      observed: { kind: 'commit', sha: 'othersha' },
      freshnessAt: 77,
      owner: 'GitProjectManifestService',
      action: 'none',
    });

    // A managed generation whose manifest went missing on disk is drift even
    // though the cache still names a version.
    setManifestCache('mp-web', {
      version: 3,
      state: 'absent',
      generation: 'generations/applied-gen-mp-3',
      commit: 'abc123',
    });
    projection = projectApplication('app-mp', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    const missing = projection.drift.filter((entry) => entry.class === 'managed_project');
    expect(missing).toHaveLength(1);
    expect(missing[0].reason).toContain('no usable manifest');
    expect(missing[0].observed).toEqual({ kind: 'unknown' });

    // A manifest this build cannot interpret proves nothing about the
    // generation, so it is the same claim as a missing one.
    setManifestCache('mp-web', {
      version: 3,
      state: 'unsupported',
      generation: 'generations/applied-gen-mp-3',
      commit: 'abc123',
    });
    projection = projectApplication('app-mp', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    const unsupported = projection.drift.filter((entry) => entry.class === 'managed_project');
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0].reason).toContain('unsupported');

    // A generation with no managed manifest expected carries no comparison.
    store.insertApplication(rawApp('app-mp-none', {
      stack_name: 'mp-none-web',
      accepted_generation_id: 'gen-mp-none',
    }));
    store.insertGeneration(gen('gen-mp-none', 'app-mp-none'));
    seedGitSource('mp-none-web');
    setManifestCache('mp-none-web', { version: 1, state: 'absent', generation: null, commit: null });
    projection = projectApplication('app-mp-none', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.drift.filter((entry) => entry.class === 'managed_project')).toEqual([]);

    // Version and generation identity each prove a mismatch on their own.
    setManifestCache('mp-web', {
      version: 2,
      state: 'active',
      generation: 'generations/applied-gen-mp-3',
      commit: 'abc123',
    });
    projection = projectApplication('app-mp', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    const versionDrift = projection.drift.filter((entry) => entry.class === 'managed_project');
    expect(versionDrift).toHaveLength(1);
    expect(versionDrift[0].observed).toEqual({ kind: 'unknown' });

    setManifestCache('mp-web', {
      version: 3,
      state: 'active',
      generation: 'generations/applied-somewhere-else',
      commit: 'abc123',
    });
    projection = projectApplication('app-mp', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.drift.filter((entry) => entry.class === 'managed_project')).toHaveLength(1);

    // Mid-apply the cache legitimately leads the accepted generation: the
    // manifest is written at promotion, the acceptance lands after it.
    seedGitSource('mp-applying-web');
    store.insertApplication(rawApp('app-mp-applying', {
      stack_name: 'mp-applying-web',
      desired_commit_sha: 'abc123',
      accepted_generation_id: 'gen-mp-applying',
      active_operation_id: 'op-mp',
      active_operation_stage: 'apply_started',
      active_operation_at: 90,
    }));
    store.insertGeneration({
      ...gen('gen-mp-applying', 'app-mp-applying'),
      manifest_version: 3,
      applied_dir: 'generations/applied-gen-mp-applying-3',
    });
    setManifestCache('mp-applying-web', {
      version: 4,
      state: 'active',
      generation: 'generations/applied-gen-mp-applying-4',
      commit: 'abc123',
    });
    projection = projectApplication('app-mp-applying', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.drift.filter((entry) => entry.class === 'managed_project')).toEqual([]);

    // Acceptance lands before the apply reaches the node, so a cache still on
    // the previous generation is behind rather than divergent.
    seedGitSource('mp-pending-web');
    store.insertApplication(rawApp('app-mp-pending', {
      stack_name: 'mp-pending-web',
      desired_commit_sha: 'abc123',
      accepted_generation_id: 'gen-mp-pending',
    }));
    store.insertGeneration({
      ...gen('gen-mp-pending', 'app-mp-pending'),
      manifest_version: 3,
      applied_dir: 'generations/applied-gen-mp-pending-3',
    });
    store.upsertTarget({
      ...emptyTargetRow('app-mp-pending', 1, 1),
      desired_generation_id: 'gen-mp-pending',
    });
    setManifestCache('mp-pending-web', {
      version: 2,
      state: 'active',
      generation: 'generations/applied-gen-mp-pending-2',
      commit: 'oldsha',
    });
    projection = projectApplication('app-mp-pending', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.drift.filter((entry) => entry.class === 'managed_project')).toEqual([]);

    // A Blueprint deploy runs on the target while the application sits idle.
    store.upsertTarget({
      ...emptyTargetRow('app-mp-pending', 1, 4),
      desired_generation_id: 'gen-mp-pending',
      applied_generation_id: 'gen-mp-pending',
      active_operation_stage: 'blueprint_deploy_started',
    });
    projection = projectApplication('app-mp-pending', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.drift.filter((entry) => entry.class === 'managed_project')).toEqual([]);
  });

  it('carries the expected per-service digests so a reader can compare service by service', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    const expected = `sha256:${'a'.repeat(64)}`;
    const observed = `sha256:${'b'.repeat(64)}`;
    const service = (platformDigest: string | null, localDigests: string[] | null = null): ServiceArtifactEvidence => ({
      serviceName: 'web',
      authoredRef: 'nginx:alpine',
      source: 'registry',
      platform: 'linux/amd64',
      indexDigest: `sha256:${'1'.repeat(64)}`,
      platformDigest,
      platformVariants: null,
      localDigests,
      buildContextFingerprint: null,
      producedImageId: null,
      failureClass: null,
      resolvedAt: 1,
    });
    tx.activateDirect({ application: app('app-digest-detail', 'digest-detail-web'), nodeId: 1, envelope: env('op-digest') });
    store.insertGeneration(gen('gen-digest-detail', 'app-digest-detail'));
    store.insertArtifactSet({
      id: 'art-digest-detail',
      generation_id: 'gen-digest-detail',
      evidence_version: 1,
      authoritative: 0,
      qualification: 'exact',
      evidence_json: encodeArtifactEvidenceJson({
        kind: 'exact',
        identity: `sha256:${'e'.repeat(64)}`,
        services: [service(expected)],
      }),
      created_at: 1,
    });
    store.upsertTarget({
      ...emptyTargetRow('app-digest-detail', 1, 1),
      desired_generation_id: 'gen-digest-detail',
      applied_generation_id: 'gen-digest-detail',
      deployed_generation_id: 'gen-digest-detail',
      expected_artifact_set_id: 'art-digest-detail',
      observed_artifact_identity_json: encodeObservedArtifactIdentity({
        kind: 'exact',
        identity: `sha256:${'f'.repeat(64)}`,
        observedAt: 5,
        services: [service(observed, [observed])],
      }),
    });

    const projection = projectApplication('app-digest-detail', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    const facet = projection.targets[0]?.artifact;
    if (!facet || facet.status === 'not_applicable' || !facet.expected) {
      throw new Error('expected artifact evidence');
    }
    expect(facet.expected.services).toEqual([service(expected, null)]);
    const observedIdentity = projection.targets[0]?.observedArtifactIdentity;
    if (observedIdentity.kind !== 'exact') throw new Error('expected an exact observation');
    expect(observedIdentity.services).toEqual([service(observed, [observed])]);
    expect(projection.drift.filter((entry) => entry.class === 'runtime')).toHaveLength(1);
  });

  it('omits the expected service list when the frozen set recorded none', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-digest-absent', 'digest-absent-web'), nodeId: 1, envelope: env('op-digest-absent') });
    store.insertGeneration(gen('gen-digest-absent', 'app-digest-absent'));
    store.insertArtifactSet({
      id: 'art-digest-absent',
      generation_id: 'gen-digest-absent',
      evidence_version: 1,
      authoritative: 0,
      qualification: 'exact',
      evidence_json: encodeArtifactEvidenceJson({ kind: 'exact', identity: 'sha256:wanted' }),
      created_at: 1,
    });
    store.upsertTarget({
      ...emptyTargetRow('app-digest-absent', 1, 1),
      desired_generation_id: 'gen-digest-absent',
      applied_generation_id: 'gen-digest-absent',
      deployed_generation_id: 'gen-digest-absent',
      expected_artifact_set_id: 'art-digest-absent',
    });

    const projection = projectApplication('app-digest-absent', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    const facet = projection.targets[0]?.artifact;
    if (!facet || facet.status === 'not_applicable' || !facet.expected) {
      throw new Error('expected artifact evidence');
    }
    // No per-service list is attached, so a reader knows there is nothing to
    // compare rather than comparing an empty list to something.
    expect(facet.expected.services).toBeUndefined();
  });
});

function env(operationId: string): EventEnvelope {
  return { operationId, actor: 'tester', trigger: 'manual', at: 1 };
}

function app(id: string, stackName: string): GitOpsApplicationRow {
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

/** Seeds application rows directly (the Direct fixture with overrides) rather than driving the transitions that would produce these modes and states. */
function rawApp(id: string, overrides: Partial<GitOpsApplicationRow>): GitOpsApplicationRow {
  return { ...app(id, 'raw-fixture-stack'), ...overrides };
}

function gen(id: string, applicationId: string): GitOpsGenerationRow {
  return {
    id,
    application_id: applicationId,
    commit_sha: 'abc123',
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
