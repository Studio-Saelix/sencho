import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { FACET_EVIDENCE_SOURCE } from '../services/gitops/types';
import { GitOpsStore, emptyTargetRow } from '../services/gitops/store';
import { GitOpsTransitions, type EventEnvelope } from '../services/gitops/transitions';
import { projectApplication } from '../services/gitops/derive';
import type { GitOpsApplicationRow, GitOpsGenerationRow } from '../services/gitops/types';

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
    expect(FACET_EVIDENCE_SOURCE.runtime.rollout_artifact_drift).toBe('future');
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
    store.insertGeneration(gen('gen-fd-b', 'app-fail-drift'));
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
    expect(projection.targets[0]?.runtime.status).toBe('completion_unknown');
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

    // A superseded intent revision means the recorded operation names an
    // identity nobody requires anymore, so the retry disappears even though
    // the divergence itself still reports.
    store.upsertTarget({
      ...store.getTarget('app-bp-r-match', 1)!,
      interruption_intent_revision_id: 'ir-superseded',
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

  it('offers apply after an interrupted apply only while the candidate still matches', () => {
    const store = GitOpsStore.getInstance();
    // Matching: the crash interrupted an apply whose generation is still the
    // current candidate, so finishing the apply remains legal.
    store.insertApplication(rawApp('app-int-ap-match', {
      interruption_stage: 'apply_started',
      interruption_at: 1,
      interruption_operation_id: 'op-ap-m',
      interruption_generation_id: 'gen-ap-m',
      candidate_generation_id: 'gen-ap-m',
    }));
    let projection = projectApplication('app-int-ap-match', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    if (projection.facets.source.status !== 'source_unknown') throw new Error('expected source_unknown');
    expect(projection.facets.source.interruptedStage).toBe('apply_started');
    expect(projection.availableActions).toContain('apply');

    // Stale: the candidate moved on after the crash, so the recorded apply
    // can no longer prove what it was applying and apply must not be offered.
    store.insertApplication(rawApp('app-int-ap-stale', {
      stack_name: 'int-ap-stale-web',
      interruption_stage: 'apply_started',
      interruption_at: 1,
      interruption_operation_id: 'op-ap-s',
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
    store.insertApplication(rawApp('app-int-ap-block', {
      stack_name: 'int-ap-block-web',
      interruption_stage: 'apply_started',
      interruption_at: 1,
      interruption_operation_id: 'op-ap-b',
      interruption_generation_id: 'gen-ap-b',
      candidate_generation_id: 'gen-ap-b',
      candidate_plan_blocked: 1,
    }));
    projection = projectApplication('app-int-ap-block', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.availableActions).toEqual(['dismiss']);
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
