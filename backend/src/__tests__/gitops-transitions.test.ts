import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { encodeArtifactEvidenceJson } from '../services/gitops/json';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions, type EventEnvelope } from '../services/gitops/transitions';
import { projectApplication } from '../services/gitops/derive';
import type { GitOpsApplicationRow, GitOpsGenerationRow } from '../services/gitops/types';

describe('gitops transitions', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    GitOpsStore.resetForTests();
    GitOpsTransitions.resetForTests();
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  it('binds desired+applied and source acceptance on Direct apply', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    const env = envelope('op-apply');
    tx.activateDirect({ application: app('app-apply', 'apply-web'), nodeId: 1, envelope: env });
    store.insertGeneration(gen('gen-apply', 'app-apply'));
    tx.fetchStarted('app-apply', envelope('op-fetch'));
    tx.fetched('app-apply', 'deadbeef', envelope('op-fetch'));
    tx.candidateReady('app-apply', 'gen-apply', false, envelope('op-cand'));
    tx.applyStarted('app-apply', 'gen-apply', envelope('op-apply'));
    tx.applied({
      applicationId: 'app-apply',
      generationId: 'gen-apply',
      artifactSetId: 'art-apply',
      sourceAcceptanceId: 'acc-apply',
      authority: 'operator',
      envelope: env,
    });
    const application = store.getApplication('app-apply')!;
    const target = store.getTarget('app-apply', 1)!;
    expect(application.accepted_generation_id).toBe('gen-apply');
    expect(application.source_acceptance_ref).toBe('acc-apply');
    expect(target.desired_generation_id).toBe('gen-apply');
    expect(target.applied_generation_id).toBe('gen-apply');
    expect(target.candidate_generation_id).toBeNull();
    expect(target.source_acceptance_ref).toBe('acc-apply');
    expect(target.expected_artifact_set_id).toBe('art-apply');
    expect(store.resolveApprovalRef('acc-apply', {
      kind: 'source_acceptance',
      applicationId: 'app-apply',
      generationId: 'gen-apply',
    })?.authoritative).toBe(1);
    expect(() => tx.applied({
      applicationId: 'app-apply',
      generationId: 'gen-other',
      artifactSetId: 'art-x',
      sourceAcceptanceId: 'acc-x',
      authority: 'operator',
      envelope: envelope('op-apply-2'),
    })).toThrow(/not the current candidate/);
  });

  it('advances expected only on first exact after unaccepted rows', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-art', 'art-web', 'gen-art', 'art-v1', 'acc-art');
    tx.recordArtifactEvidence({
      applicationId: 'app-art',
      generationId: 'gen-art',
      artifactSetId: 'art-v2',
      evidenceVersion: 2,
      qualification: 'unavailable',
      evidenceJson: encodeArtifactEvidenceJson({ kind: 'unavailable' }),
      authoritative: 0,
      envelope: envelope('op-art-2'),
    });
    tx.recordArtifactEvidence({
      applicationId: 'app-art',
      generationId: 'gen-art',
      artifactSetId: 'art-v3',
      evidenceVersion: 3,
      qualification: 'exact',
      evidenceJson: encodeArtifactEvidenceJson({ kind: 'exact', identity: 'sha256:aaa' }),
      authoritative: 0,
      envelope: envelope('op-art-3'),
    });
    const application = store.getApplication('app-art')!;
    expect(application.artifact_set_id).toBe('art-v3');
    expect(application.latest_artifact_set_id).toBe('art-v3');
    tx.recordArtifactEvidence({
      applicationId: 'app-art',
      generationId: 'gen-art',
      artifactSetId: 'art-v4',
      evidenceVersion: 4,
      qualification: 'stale',
      evidenceJson: encodeArtifactEvidenceJson({ kind: 'stale', identity: 'sha256:aaa' }),
      authoritative: 0,
      envelope: envelope('op-art-4'),
    });
    expect(store.getApplication('app-art')?.artifact_set_id).toBe('art-v3');
    expect(store.getApplication('app-art')?.latest_artifact_set_id).toBe('art-v4');
    tx.recordArtifactEvidence({
      applicationId: 'app-art',
      generationId: 'gen-art',
      artifactSetId: 'art-v5',
      evidenceVersion: 5,
      qualification: 'exact',
      evidenceJson: encodeArtifactEvidenceJson({ kind: 'exact', identity: 'sha256:bbb' }),
      authoritative: 0,
      envelope: envelope('op-art-5'),
    });
    expect(store.getApplication('app-art')?.artifact_set_id).toBe('art-v3');
    expect(store.getApplication('app-art')?.latest_artifact_set_id).toBe('art-v5');
    expect(store.getTarget('app-art', 1)?.expected_artifact_set_id).toBe('art-v3');
    expect(store.getTarget('app-art', 1)?.latest_artifact_set_id).toBe('art-v5');
  });

  it('clears fetch failure on successful fetch and keeps accepted pointers', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-fail', 'fail-web', 'gen-fail', 'art-fail', 'acc-fail');
    tx.fetchStarted('app-fail', envelope('op-fail'));
    tx.fetchFailed('app-fail', envelope('op-fail'));
    expect(store.getApplication('app-fail')?.failure_stage).toBe('fetch');
    expect(store.getApplication('app-fail')?.accepted_generation_id).toBe('gen-fail');
    tx.fetchStarted('app-fail', envelope('op-fail-2'));
    tx.fetched('app-fail', 'cafebabe', envelope('op-fail-2'));
    const application = store.getApplication('app-fail')!;
    expect(application.failure_stage).toBeNull();
    expect(application.desired_commit_sha).toBe('cafebabe');
    expect(application.accepted_generation_id).toBe('gen-fail');
    expect(store.getTarget('app-fail', 1)?.applied_generation_id).toBe('gen-fail');
  });

  it('rejects a candidate whose fingerprint no longer matches configuration', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-fp', 'fp-web'), nodeId: 1, envelope: envelope('op-act-fp') });
    store.insertGeneration(gen('gen-fp', 'app-fp'));
    DatabaseService.getInstance().getDb().prepare(
      "UPDATE gitops_applications SET materialization_fingerprint = ? WHERE id = 'app-fp'",
    ).run('b'.repeat(64));
    expect(() => tx.candidateReady('app-fp', 'gen-fp', false, envelope('op-c-fp'))).toThrow(/fingerprint/);
    DatabaseService.getInstance().getDb().prepare(
      "UPDATE gitops_applications SET materialization_fingerprint = ? WHERE id = 'app-fp'",
    ).run('a'.repeat(64));
    tx.fetchStarted('app-fp', envelope('op-f-fp'));
    tx.fetched('app-fp', 'abc123', envelope('op-f-fp'));
    tx.candidateReady('app-fp', 'gen-fp', false, envelope('op-c-fp2'));
    DatabaseService.getInstance().getDb().prepare(
      "UPDATE gitops_applications SET materialization_fingerprint = ? WHERE id = 'app-fp'",
    ).run('c'.repeat(64));
    expect(() => tx.applyStarted('app-fp', 'gen-fp', envelope('op-a-fp'))).toThrow(/fingerprint/);
  });

  it('refuses to replace the candidate while an apply is in flight', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-race', 'race-web'), nodeId: 1, envelope: envelope('op-act-race') });
    store.insertGeneration(gen('gen-race-a', 'app-race'));
    store.insertGeneration(gen('gen-race-b', 'app-race'));
    tx.fetchStarted('app-race', envelope('op-f-race'));
    tx.fetched('app-race', 'abc123', envelope('op-f-race'));
    tx.candidateReady('app-race', 'gen-race-a', false, envelope('op-c-race-a'));
    tx.applyStarted('app-race', 'gen-race-a', envelope('op-a-race'));
    expect(() => tx.candidateReady('app-race', 'gen-race-b', false, envelope('op-c-race-b')))
      .toThrow(/apply is in flight/);
    expect(store.getApplication('app-race')?.candidate_generation_id).toBe('gen-race-a');
    tx.applied({
      applicationId: 'app-race',
      generationId: 'gen-race-a',
      artifactSetId: 'art-race',
      sourceAcceptanceId: 'acc-race',
      authority: 'operator',
      envelope: envelope('op-a-race'),
    });
    expect(store.getApplication('app-race')?.accepted_generation_id).toBe('gen-race-a');
  });

  it('rejects re-accepting a generation that is already accepted', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-reapply', 'reapply-web', 'gen-reapply', 'art-reapply', 'acc-reapply');
    tx.candidateReady('app-reapply', 'gen-reapply', false, envelope('op-c-reapply-2'));
    expect(() => tx.applied({
      applicationId: 'app-reapply',
      generationId: 'gen-reapply',
      artifactSetId: 'art-reapply-2',
      sourceAcceptanceId: 'acc-reapply-2',
      authority: 'operator',
      envelope: envelope('op-a-reapply-2'),
    })).toThrow(/already accepted/);
    expect(store.getArtifactSet('art-reapply-2')).toBeUndefined();
  });

  it('surfaces an invalid stored observation as a limitation instead of a clean unknown', () => {
    const store = GitOpsStore.getInstance();
    seedApplied('app-obs', 'obs-web', 'gen-obs', 'art-obs', 'acc-obs');
    DatabaseService.getInstance().getDb().prepare(
      "UPDATE gitops_target_current SET observed_artifact_identity_json = ? WHERE application_id = 'app-obs'",
    ).run('{"kind":"nonsense"}');
    const projection = mustProject('app-obs');
    expect(projection.limitations.map((l) => l.code)).toContain('artifact_observation_invalid');
    expect(store.getTarget('app-obs', 1)?.observed_artifact_identity_json).toBe('{"kind":"nonsense"}');
  });

  it('advances the fetched SHA on an invalid commit without minting a candidate', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-inv', 'inv-web'), nodeId: 1, envelope: envelope('op-act-inv') });
    tx.fetchStarted('app-inv', envelope('op-f-inv'));
    tx.fetchedInvalid('app-inv', 'bad1234', envelope('op-f-inv'));
    const application = store.getApplication('app-inv')!;
    expect(application.desired_commit_sha).toBe('bad1234');
    expect(application.fetched_commit_sha).toBe('bad1234');
    expect(application.candidate_generation_id).toBeNull();
    expect(application.failure_stage).toBe('validation');
    expect(mustProject('app-inv').facets.source.status).toBe('source_failed');
  });

  it('exposes a blocked candidate without allowing it to apply', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-blk', 'blk-web'), nodeId: 1, envelope: envelope('op-act-blk') });
    store.insertGeneration({ ...gen('gen-blk', 'app-blk'), plan_blocked: 1 });
    tx.fetchStarted('app-blk', envelope('op-f-blk'));
    tx.fetched('app-blk', 'abc123', envelope('op-f-blk'));
    tx.sourceConflictBlocker('app-blk', 'gen-blk', envelope('op-b-blk'));
    expect(store.getApplication('app-blk')?.candidate_plan_blocked).toBe(1);
    expect(store.getTarget('app-blk', 1)?.candidate_generation_id).toBe('gen-blk');
    const projection = mustProject('app-blk');
    expect(projection.facets.source.status).toBe('source_conflict_blocker');
    expect(projection.availableActions).not.toContain('apply');
    expect(() => tx.applyStarted('app-blk', 'gen-blk', envelope('op-a-blk'))).toThrow(/blocked/);
  });

  it('dismisses a candidate without touching what is already applied', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-dis', 'dis-web', 'gen-dis', 'art-dis', 'acc-dis');
    store.insertGeneration(gen('gen-dis-2', 'app-dis'));
    tx.candidateReady('app-dis', 'gen-dis-2', false, envelope('op-c-dis'));
    tx.dismissed('app-dis', envelope('op-d-dis'));
    const application = store.getApplication('app-dis')!;
    expect(application.candidate_generation_id).toBeNull();
    expect(application.accepted_generation_id).toBe('gen-dis');
    expect(store.getTarget('app-dis', 1)?.applied_generation_id).toBe('gen-dis');
    expect(store.getTarget('app-dis', 1)?.candidate_generation_id).toBeNull();
  });

  it('refuses to dismiss while an operation is in flight', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-dis2', 'dis2-web'), nodeId: 1, envelope: envelope('op-act-dis2') });
    store.insertGeneration(gen('gen-dis2', 'app-dis2'));
    tx.fetchStarted('app-dis2', envelope('op-f-dis2'));
    tx.fetched('app-dis2', 'abc123', envelope('op-f-dis2'));
    tx.candidateReady('app-dis2', 'gen-dis2', false, envelope('op-c-dis2'));
    tx.applyStarted('app-dis2', 'gen-dis2', envelope('op-a-dis2'));
    expect(() => tx.dismissed('app-dis2', envelope('op-d-dis2'))).toThrow(/in flight/);
    expect(store.getApplication('app-dis2')?.candidate_generation_id).toBe('gen-dis2');
  });

  it('invalidates a staged candidate when the material configuration changes', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-cfg', 'cfg-web', 'gen-cfg', 'art-cfg', 'acc-cfg');
    store.insertGeneration(gen('gen-cfg-2', 'app-cfg'));
    tx.candidateReady('app-cfg', 'gen-cfg-2', false, envelope('op-c-cfg'));
    tx.configChangedPendingCleared({
      applicationId: 'app-cfg',
      identity: {
        repoUrl: 'https://github.com/org/other.git',
        repoIdentityJson: '{"host":"github.com","pathname":"/org/other.git"}',
        configuredRef: 'release',
      },
      material: {
        composePathsJson: '["compose.yml","compose.prod.yml"]',
        contextDir: null,
        syncEnv: 0,
        envPath: null,
        fingerprint: 'd'.repeat(64),
      },
      envelope: envelope('op-cfg'),
    });
    const application = store.getApplication('app-cfg')!;
    expect(application.configured_ref).toBe('release');
    expect(application.materialization_fingerprint).toBe('d'.repeat(64));
    expect(application.desired_commit_sha).toBeNull();
    expect(application.candidate_generation_id).toBeNull();
    // The workload that is running did not change because the config did.
    expect(application.accepted_generation_id).toBe('gen-cfg');
    expect(store.getTarget('app-cfg', 1)?.applied_generation_id).toBe('gen-cfg');
    const projection = mustProject('app-cfg');
    expect(projection.facets.source.status).toBe('source_reconcile_required');
    expect(projection.availableActions).toContain('fetch');
  });

  it('records deploy failures without moving the deployed generation', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-dep', 'dep-web', 'gen-dep', 'art-dep', 'acc-dep');
    tx.deployStarted('app-dep', 1, 'gen-dep', envelope('op-dep-1'));
    tx.deployUnbound('app-dep', 1, 'gen-dep', envelope('op-dep-1'));
    let target = store.getTarget('app-dep', 1)!;
    expect(target.deployed_generation_id).toBeNull();
    expect(target.failure_class).toBe('unbound');
    expect(mustProject('app-dep').targets[0]?.runtime.status).toBe('failed_previous_workload_intact');

    tx.deployStarted('app-dep', 1, 'gen-dep', envelope('op-dep-2'));
    tx.deployFailed('app-dep', 1, 'post_mutation', envelope('op-dep-2'));
    target = store.getTarget('app-dep', 1)!;
    expect(target.deployed_generation_id).toBeNull();
    expect(target.failure_class).toBe('post_mutation');
    expect(mustProject('app-dep').targets[0]?.runtime.status).toBe('failed_after_mutation');

    // A later success clears the failure in the same move as the pointer.
    tx.deployStarted('app-dep', 1, 'gen-dep', envelope('op-dep-3'));
    tx.deployBound('app-dep', 1, 'gen-dep', envelope('op-dep-3'));
    target = store.getTarget('app-dep', 1)!;
    expect(target.deployed_generation_id).toBe('gen-dep');
    expect(target.failure_stage).toBeNull();
  });

  it('promotes healthy and last-known-good only for the generation the run watched', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-hl', 'hl-web', 'gen-hl', 'art-hl', 'acc-hl');
    tx.deployStarted('app-hl', 1, 'gen-hl', envelope('op-hl-dep'));
    tx.deployBound('app-hl', 1, 'gen-hl', envelope('op-hl-dep'));

    // A verdict for a generation that is not the deployed one proves nothing.
    tx.healthFinalized({
      applicationId: 'app-hl',
      nodeId: 1,
      healthRunId: 'run-stale',
      healthStatus: 'passed',
      deployedGenerationId: 'gen-other',
      targetScope: 'stack',
      envelope: envelope('op-hl-stale'),
    });
    expect(store.getTarget('app-hl', 1)?.healthy_generation_id).toBeNull();

    // Nor does a service-scoped run, which never observed the whole stack.
    tx.healthFinalized({
      applicationId: 'app-hl',
      nodeId: 1,
      healthRunId: 'run-service',
      healthStatus: 'passed',
      deployedGenerationId: 'gen-hl',
      targetScope: 'service',
      envelope: envelope('op-hl-service'),
    });
    expect(store.getTarget('app-hl', 1)?.healthy_generation_id).toBeNull();

    // Nor does a failure.
    tx.healthFinalized({
      applicationId: 'app-hl',
      nodeId: 1,
      healthRunId: 'run-failed',
      healthStatus: 'failed',
      deployedGenerationId: 'gen-hl',
      targetScope: 'stack',
      envelope: envelope('op-hl-failed'),
    });
    expect(store.getTarget('app-hl', 1)?.healthy_generation_id).toBeNull();

    tx.healthFinalized({
      applicationId: 'app-hl',
      nodeId: 1,
      healthRunId: 'run-pass',
      healthStatus: 'passed',
      deployedGenerationId: 'gen-hl',
      targetScope: 'stack',
      envelope: envelope('op-hl-pass'),
    });
    const target = store.getTarget('app-hl', 1)!;
    expect(target.healthy_generation_id).toBe('gen-hl');
    expect(target.lkg_generation_id).toBe('gen-hl');
    // The expected artifact belongs to this generation, so it is kept as the
    // qualification evidence for the last-known-good.
    expect(target.lkg_artifact_set_id).toBe('art-hl');
    expect(target.lkg_unavailable_at).toBeNull();
    const projection = mustProject('app-hl');
    expect(projection.targets[0]?.runtime.status).toBe('synced_and_healthy');
    expect(projection.targets[0]?.lkg.status).not.toBe('none');
  });

  it('keeps the last-known-good generation when its artifact belongs elsewhere', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-lkg', 'lkg-web', 'gen-lkg', 'art-lkg', 'acc-lkg');
    tx.deployStarted('app-lkg', 1, 'gen-lkg', envelope('op-lkg-dep'));
    tx.deployBound('app-lkg', 1, 'gen-lkg', envelope('op-lkg-dep'));
    // Clear the expectation so the promotion has no artifact to qualify with.
    DatabaseService.getInstance().getDb().prepare(
      "UPDATE gitops_target_current SET expected_artifact_set_id = NULL WHERE application_id = 'app-lkg'",
    ).run();

    tx.healthFinalized({
      applicationId: 'app-lkg',
      nodeId: 1,
      healthRunId: 'run-lkg',
      healthStatus: 'passed',
      deployedGenerationId: 'gen-lkg',
      targetScope: 'stack',
      envelope: envelope('op-lkg-pass'),
    });

    const target = store.getTarget('app-lkg', 1)!;
    // The generation is still good; only its executable identity is unproven.
    expect(target.lkg_generation_id).toBe('gen-lkg');
    expect(target.lkg_artifact_set_id).toBeNull();
    expect(mustProject('app-lkg').targets[0]?.lkg.status).toBe('available');
  });

  it('tombstones an application and its target, and never reactivates it', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-tomb', 'tomb-web', 'gen-tomb', 'art-tomb', 'acc-tomb');
    tx.targetTombstoned('app-tomb', 1, envelope('op-tomb'));
    tx.applicationTombstoned('app-tomb', 'detached', envelope('op-tomb'));
    const application = store.getApplication('app-tomb')!;
    expect(application.lifecycle_status).toBe('detached');
    // Configured identity survives as a frozen fact.
    expect(application.configured_repo_url).toBe('https://github.com/org/repo.git');
    expect(application.desired_commit_sha).toBe('abc123');
    expect(store.getTarget('app-tomb', 1)?.target_status).toBe('tombstoned');
    expect(store.getLiveDirectApplication('tomb-web')).toBeUndefined();
    expect(() => tx.applicationTombstoned('app-tomb', 'deleted', envelope('op-tomb-2')))
      .toThrow(/already tombstoned/);
    expect(mustProject('app-tomb').facets.source.status).toBe('not_live');
  });

  it('retires every live target on a node without touching its applications', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-node-a', 'node-a-web', 'gen-node-a', 'art-node-a', 'acc-node-a');
    seedApplied('app-node-b', 'node-b-web', 'gen-node-b', 'art-node-b', 'acc-node-b');

    tx.tombstoneNodeTargets(1, envelope('op-node-del'));

    expect(store.getTarget('app-node-a', 1)?.target_status).toBe('tombstoned');
    expect(store.getTarget('app-node-b', 1)?.target_status).toBe('tombstoned');
    // The applications still describe real stacks, so they stay live.
    expect(store.getApplication('app-node-a')?.lifecycle_status).toBe('active');
    expect(store.getApplication('app-node-b')?.lifecycle_status).toBe('active');
    // Replaying finds nothing left to retire.
    expect(tx.tombstoneNodeTargets(1, envelope('op-node-del-2')).historyIds).toHaveLength(0);
  });

  it('rejects terminal events with no matching operation', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-guard', 'guard-web'), nodeId: 1, envelope: envelope('op-act-guard') });
    store.insertGeneration(gen('gen-guard', 'app-guard'));
    expect(() => tx.applyFailed('app-guard', 'apply', envelope('op-g1')))
      .toThrow(/no matching apply operation/);
    expect(() => tx.deployStarted('app-guard', 1, 'gen-guard', envelope('op-g2')))
      .toThrow(/not applied/);
    expect(() => tx.deployBound('app-guard', 1, 'gen-guard', envelope('op-g3')))
      .toThrow(/no matching deploy operation/);
    expect(store.getTarget('app-guard', 1)?.deployed_generation_id).toBeNull();
  });

  it('writes one history row per transition with the bound identity', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-hist', 'hist-web'), nodeId: 1, envelope: envelope('op-act-hist') });
    store.insertGeneration(gen('gen-hist', 'app-hist'));
    tx.fetchStarted('app-hist', envelope('op-f-hist'));
    tx.fetched('app-hist', 'abc123', envelope('op-f-hist'));
    tx.candidateReady('app-hist', 'gen-hist', false, envelope('op-c-hist'));
    const applied = tx.applied({
      applicationId: 'app-hist',
      generationId: 'gen-hist',
      artifactSetId: 'art-hist',
      sourceAcceptanceId: 'acc-hist',
      authority: 'operator',
      envelope: envelope('op-a-hist'),
    });
    expect(applied.replayed).toBe(false);
    expect(applied.historyIds).toHaveLength(1);
    const row = DatabaseService.getInstance().getDb().prepare(
      'SELECT stage, outcome, dedupe_target, generation_id, artifact_set_id, source_acceptance_ref, node_id FROM gitops_history WHERE id = ?',
    ).get(applied.historyIds[0]) as Record<string, unknown>;
    expect(row.stage).toBe('applied');
    expect(row.outcome).toBe('committed');
    expect(row.dedupe_target).toBe('app');
    expect(row.generation_id).toBe('gen-hist');
    expect(row.artifact_set_id).toBe('art-hist');
    expect(row.source_acceptance_ref).toBe('acc-hist');
    expect(row.node_id).toBeNull();
  });

  it('interrupts live apply and binds deploy after applied', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-int', 'int-web'), nodeId: 1, envelope: envelope('op-act-int') });
    store.insertGeneration(gen('gen-int', 'app-int'));
    tx.fetchStarted('app-int', envelope('op-f-int'));
    tx.fetched('app-int', 'abc123', envelope('op-f-int'));
    tx.candidateReady('app-int', 'gen-int', false, envelope('op-c-int'));
    tx.applyStarted('app-int', 'gen-int', envelope('op-apply-live'));
    expect(mustProject('app-int').facets.source.status).toBe('applying');
    tx.interruptActiveOperations('app-int', envelope('op-boot'));
    expect(mustProject('app-int').facets.source.status).toBe('source_unknown');
    tx.applied({
      applicationId: 'app-int',
      generationId: 'gen-int',
      artifactSetId: 'art-int',
      sourceAcceptanceId: 'acc-int',
      authority: 'operator',
      envelope: envelope('op-a-int'),
    });
    tx.deployStarted('app-int', 1, 'gen-int', envelope('op-dep'));
    tx.deployBound('app-int', 1, 'gen-int', envelope('op-dep'));
    expect(store.getTarget('app-int', 1)?.deployed_generation_id).toBe('gen-int');
    expect(store.getTarget('app-int', 1)?.failure_stage).toBeNull();
  });
});

function mustProject(applicationId: string) {
  const projection = projectApplication(applicationId, false);
  if (projection.targetMode === 'not_applicable') throw new Error('expected application');
  return projection;
}

function seedApplied(
  applicationId: string,
  stackName: string,
  generationId: string,
  artifactSetId: string,
  sourceAcceptanceId: string,
): void {
  const store = GitOpsStore.getInstance();
  const tx = GitOpsTransitions.getInstance();
  tx.activateDirect({ application: app(applicationId, stackName), nodeId: 1, envelope: envelope(`op-act-${applicationId}`) });
  store.insertGeneration(gen(generationId, applicationId));
  tx.fetchStarted(applicationId, envelope(`op-f-${applicationId}`));
  tx.fetched(applicationId, 'abc123', envelope(`op-f-${applicationId}`));
  tx.candidateReady(applicationId, generationId, false, envelope(`op-c-${applicationId}`));
  tx.applied({
    applicationId,
    generationId,
    artifactSetId,
    sourceAcceptanceId,
    authority: 'operator',
    envelope: envelope(`op-a-${applicationId}`),
  });
}

function envelope(operationId: string): EventEnvelope {
  return { operationId, actor: 'tester', trigger: 'manual', at: Date.now() };
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
