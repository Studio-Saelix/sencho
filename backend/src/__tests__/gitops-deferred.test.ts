/**
 * Deferred-state events: retry, suspend, pause, and partial rollout.
 *
 * These have no production writer by design; later tickets emit them. They are
 * implemented and tested now so the deriver has no branch a writer cannot
 * reach, and so the shape a future producer must satisfy is pinned rather than
 * inferred from the deriver.
 *
 * The rule they all share is that none of them is a statement about health. A
 * suspended source, a paused rollout, and a partial rollout each leave every
 * success pointer exactly where it was.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { GitOpsStore, emptyTargetRow } from '../services/gitops/store';
import { GitOpsTransitions, type EventEnvelope } from '../services/gitops/transitions';
import { reclassifyInterruptedOperations } from '../services/gitops/createRecovery';
import { projectApplication } from '../services/gitops/derive';
import type { GitOpsApplicationRow, GitOpsGenerationRow } from '../services/gitops/types';
import { DEFAULT_PLACEMENT_POLICY, DEFAULT_ROLLOUT_AUTHORIZATION_POLICY } from '../services/gitops/policyComposition';

describe('gitops deferred state', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    GitOpsStore.resetForTests();
    GitOpsTransitions.resetForTests();
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  it('schedules a retry without hiding the failure that caused it', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-retry', 'retry-web');
    tx.fetchStarted('app-retry', env('op-retry-f'));
    tx.fetchFailed('app-retry', env('op-retry-f'));

    tx.sourceRetryScheduled('app-retry', 5_000, 2, env('op-retry-s'));

    const app = store.getApplication('app-retry')!;
    expect(app.retry_at).toBe(5_000);
    expect(app.retry_count).toBe(2);
    // A retry is a plan, not a resolution: a stack that keeps failing must not
    // read as merely busy.
    expect(app.failure_stage).toBe('fetch');
    expect(projectOf('app-retry').facets.source.status).toBe('source_failed');

    // Starting the retry clears the schedule and keeps the count.
    tx.fetchStarted('app-retry', env('op-retry-f2'));
    expect(store.getApplication('app-retry')?.retry_at).toBeNull();
    expect(store.getApplication('app-retry')?.retry_count).toBe(2);
  });

  it('suspends a source without forgetting what it had accepted', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-susp', 'susp-web');
    const accepted = store.getApplication('app-susp')!.accepted_generation_id;

    tx.sourceSuspended('app-susp', 'operator paused sync', env('op-susp'));

    const app = store.getApplication('app-susp')!;
    expect(app.suspended_at).not.toBeNull();
    expect(app.accepted_generation_id).toBe(accepted);
    const sourceFacet = projectOf('app-susp').facets.source;
    expect(sourceFacet.status).toBe('source_suspended');
    if (sourceFacet.status === 'source_suspended') {
      expect(sourceFacet.suspendedReason).toBe('operator paused sync');
    }
    // A suspended source refuses new work rather than queueing it.
    expect(() => tx.fetchStarted('app-susp', env('op-susp-f'))).toThrow(/suspended/);

    tx.sourceUnsuspended('app-susp', env('op-unsusp'));
    expect(store.getApplication('app-susp')?.suspended_at).toBeNull();
    expect(projectOf('app-susp').facets.source.status).toBe('application_generation_accepted');
  });

  it('interrupts an operation in flight when the source is suspended', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-susp2', 'susp2-web');
    tx.fetchStarted('app-susp2', env('op-susp2-f'));

    tx.sourceSuspended('app-susp2', 'operator paused sync', env('op-susp2'));

    const app = store.getApplication('app-susp2')!;
    // Abandoning the operation without recording it would leave the source
    // reporting a fetch in flight that nothing will ever finish.
    expect(app.active_operation_stage).toBeNull();
    expect(app.interruption_stage).toBe('fetch_started');
    expect(app.suspended_at).not.toBeNull();
  });

  it('keeps a source-suspension reason independent of an application-wide rollout pause reason', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-susp3', 'susp3-web');

    tx.sourceSuspended('app-susp3', 'operator paused sync', env('op-susp3'));
    // A later, unrelated application-wide rollout pause must not clobber the
    // suspension reason: the two events share the application row but not
    // its reason field.
    tx.rolloutPaused('app-susp3', null, 'awaiting approval', env('op-pause3'));

    const app = store.getApplication('app-susp3')!;
    expect(app.source_suspended_reason).toBe('operator paused sync');
    expect(app.pause_reason).toBe('awaiting approval');

    tx.sourceUnsuspended('app-susp3', env('op-unsusp3'));
    expect(store.getApplication('app-susp3')?.source_suspended_reason).toBeNull();
    // Unsuspending the source must not touch the unrelated rollout pause.
    expect(store.getApplication('app-susp3')?.pause_reason).toBe('awaiting approval');
  });

  it('pauses a rollout without claiming anything about health', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-pause', 'pause-web');
    tx.deployStarted('app-pause', 1, 'gen-app-pause', env('op-pause-d'));
    tx.deployBound('app-pause', 1, 'gen-app-pause', env('op-pause-d'));

    tx.rolloutPaused('app-pause', 1, 'awaiting approval', env('op-pause'));

    const target = store.getTarget('app-pause', 1)!;
    expect(target.pause_at).not.toBeNull();
    // What was deployed is still deployed.
    expect(target.deployed_generation_id).toBe('gen-app-pause');
    expect(projectOf('app-pause').targets[0]?.runtime.status).toBe('paused');

    tx.rolloutUnpaused('app-pause', 1, env('op-unpause'));
    expect(store.getTarget('app-pause', 1)?.pause_at).toBeNull();
    expect(projectOf('app-pause').targets[0]?.runtime.status).not.toBe('paused');
  });

  it('records a partial rollout without inventing a deployed pointer', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-partial', 'partial-web');

    tx.partiallyRolledOut('app-partial', 1, '{"reached":[1],"pending":[2]}', env('op-partial'));

    const target = store.getTarget('app-partial', 1)!;
    expect(target.partial_json).toBe('{"reached":[1],"pending":[2]}');
    expect(target.deployed_generation_id).toBeNull();
    expect(projectOf('app-partial').targets[0]?.runtime.status).toBe('partially_rolled_out');

    tx.partialCleared('app-partial', 1, env('op-partial-clear'));
    expect(store.getTarget('app-partial', 1)?.partial_json).toBeNull();
  });

  it('refuses partial state that is not decodable', () => {
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-partial-bad', 'partial-bad-web');
    expect(() => tx.partiallyRolledOut('app-partial-bad', 1, 'not json', env('op-partial-bad')))
      .toThrow();
  });

  it('reports a rollback in flight on both the application and the target', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-rb-start', 'rb-start-web');
    const generationId = 'gen-app-rb-start';

    tx.rollbackInProgress({
      applicationId: 'app-rb-start',
      nodeId: 1,
      recoveryRef: 'rb-1',
      recoveryGenerationId: generationId,
      envelope: env('op-rb-start'),
    });

    const target = store.getTarget('app-rb-start', 1)!;
    expect(target.recovery_phase).toBe('restoring');
    expect(target.recovery_ref).toBe('rb-1');
    expect(target.recovery_generation_id).toBe(generationId);
    // Written to both, because a target-only write left the source facet
    // reporting whatever the source last did instead of the rollback.
    expect(store.getApplication('app-rb-start')?.recovery_phase).toBe('restoring');
    expect(projectOf('app-rb-start').facets.rollout.status).toBe('rollback_in_progress');
  });

  it('persists the failure class a partial rollback was given', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-rb-partial', 'rb-partial-web');
    const applied = store.getTarget('app-rb-partial', 1)!.applied_generation_id;

    tx.rollbackPartialFailed({
      applicationId: 'app-rb-partial',
      nodeId: 1,
      recoveryRef: 'rb-2',
      failureClass: 'partial',
      envelope: env('op-rb-partial'),
    });

    const target = store.getTarget('app-rb-partial', 1)!;
    expect(target.recovery_phase).toBe('failed');
    expect(target.failure_stage).toBe('recovery');
    // Reported verbatim: the deriver reads these columns rather than inventing
    // a class, and `partial` is the one this alias adds over a recovery.
    expect(target.failure_class).toBe('partial');
    // A failed rollback moves no success pointer.
    expect(target.applied_generation_id).toBe(applied);
    expect(target.healthy_generation_id).toBeNull();
    // A failure that may have mutated the target keeps the application hold:
    // the source pipeline must not keep converging over a half-restored stack.
    expect(store.getApplication('app-rb-partial')?.recovery_phase).toBe('failed');
    expect(store.getApplication('app-rb-partial')?.failure_stage).toBe('recovery');
  });

  it('releases the application hold when a rollback is refused before it can mutate anything', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-rb-refused', 'rb-refused-web');

    tx.rollbackInProgress({
      applicationId: 'app-rb-refused',
      nodeId: 1,
      recoveryRef: 'rb-refused',
      recoveryGenerationId: 'gen-app-rb-refused',
      envelope: env('op-rb-refused-start'),
    });
    expect(store.getApplication('app-rb-refused')?.recovery_phase).toBe('restoring');

    tx.rollbackPartialFailed({
      applicationId: 'app-rb-refused',
      nodeId: 1,
      recoveryRef: 'rb-refused',
      failureClass: 'pre_mutation',
      envelope: env('op-rb-refused-fail'),
    });

    const target = store.getTarget('app-rb-refused', 1)!;
    expect(target.recovery_phase).toBe('failed');
    expect(target.failure_stage).toBe('recovery');
    expect(target.failure_class).toBe('pre_mutation');
    // The refusal stays visible on the target, but nothing was restored and
    // nothing was half-restored, so the application must not park in a
    // recovery that can never complete.
    const app = store.getApplication('app-rb-refused')!;
    expect(app.recovery_phase).toBeNull();
    expect(app.failure_stage).toBeNull();
    expect(projectOf('app-rb-refused').facets.rollout.status).toBe('rollback_partial_failed');
    expect(projectOf('app-rb-refused').facets.source.status).not.toBe('recovery_failed');
  });

  it('keeps the completion receipt when another target of the same rollback was restored', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-rb-mixed', 'rb-mixed-web');
    store.upsertTarget(emptyTargetRow('app-rb-mixed', 2, 1));

    tx.rollbackInProgress({
      applicationId: 'app-rb-mixed',
      nodeId: 1,
      recoveryRef: 'rb-mixed',
      recoveryGenerationId: 'gen-app-rb-mixed',
      envelope: env('op-rb-mixed-t1'),
    });
    tx.rollbackCompleted({
      applicationId: 'app-rb-mixed',
      nodeId: 1,
      recoveryRef: 'rb-mixed',
      recoveryGenerationId: 'gen-app-rb-mixed',
      capturedArtifactSetId: null,
      capturedSourceAcceptanceRef: null,
      envelope: env('op-rb-mixed-t1-done'),
    });
    tx.rollbackInProgress({
      applicationId: 'app-rb-mixed',
      nodeId: 2,
      recoveryRef: 'rb-mixed',
      recoveryGenerationId: 'gen-app-rb-mixed',
      envelope: env('op-rb-mixed-t2'),
    });
    tx.rollbackPartialFailed({
      applicationId: 'app-rb-mixed',
      nodeId: 2,
      recoveryRef: 'rb-mixed',
      failureClass: 'pre_mutation',
      envelope: env('op-rb-mixed-t2-fail'),
    });

    // Node 1 really did come back in this rollback, so the same ref keeps the
    // settled receipt instead of discarding it with the refusal.
    expect(store.getApplication('app-rb-mixed')?.recovery_phase).toBe('complete');
    expect(store.getApplication('app-rb-mixed')?.failure_stage).toBeNull();
    expect(store.getTarget('app-rb-mixed', 2)?.recovery_phase).toBe('failed');
    expect(projectOf('app-rb-mixed').facets.rollout.status).toBe('rollback_partial_failed');
  });

  it('does not release a restoring stamp another rollback owns', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-rb-owner2', 'rb-owner2-web');
    store.upsertTarget(emptyTargetRow('app-rb-owner2', 2, 1));

    // Two overlapping rollbacks: each opens its own target under its own ref,
    // so the application carries the second one's stamp when the first one's
    // refusal lands.
    tx.rollbackInProgress({
      applicationId: 'app-rb-owner2',
      nodeId: 1,
      recoveryRef: 'rb-owner2-a',
      recoveryGenerationId: 'gen-app-rb-owner2',
      envelope: env('op-rb-owner2-a'),
    });
    tx.rollbackInProgress({
      applicationId: 'app-rb-owner2',
      nodeId: 2,
      recoveryRef: 'rb-owner2-b',
      recoveryGenerationId: 'gen-app-rb-owner2',
      envelope: env('op-rb-owner2-b'),
    });

    tx.rollbackPartialFailed({
      applicationId: 'app-rb-owner2',
      nodeId: 1,
      recoveryRef: 'rb-owner2-a',
      failureClass: 'pre_mutation',
      envelope: env('op-rb-owner2-a-fail'),
    });

    expect(store.getApplication('app-rb-owner2')?.recovery_phase).toBe('restoring');
    expect(store.getApplication('app-rb-owner2')?.recovery_ref).toBe('rb-owner2-b');
  });


  it('never rewrites a restoring row while a deploy failure lands beside it', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-rb-beside', 'rb-beside-web');

    // A refusal, then a deploy starts and owns the marker, then a retry opens a
    // restore beside the deploy.
    tx.rollbackInProgress({
      applicationId: 'app-rb-beside',
      nodeId: 1,
      recoveryRef: 'rb-beside-a',
      recoveryGenerationId: 'gen-app-rb-beside',
      envelope: env('op-rb-beside-a'),
    });
    tx.rollbackPartialFailed({
      applicationId: 'app-rb-beside',
      nodeId: 1,
      recoveryRef: 'rb-beside-a',
      failureClass: 'pre_mutation',
      envelope: env('op-rb-beside-a-terminal'),
    });
    const applied = store.getTarget('app-rb-beside', 1)!.applied_generation_id!;
    tx.deployStarted('app-rb-beside', 1, applied, env('op-rb-beside-deploy'));
    tx.rollbackInProgress({
      applicationId: 'app-rb-beside',
      nodeId: 1,
      recoveryRef: 'rb-beside-b',
      recoveryGenerationId: 'gen-app-rb-beside',
      envelope: env('op-rb-beside-b'),
    });

    // The deploy fails. It must not clear the restore that is still moving, and
    // it must not take the marker away from the operation that owns it.
    tx.deployFailed('app-rb-beside', 1, 'post_mutation', env('op-rb-beside-deploy-fail'));
    const target = store.getTarget('app-rb-beside', 1)!;
    expect(target.recovery_phase).toBe('restoring');
    expect(target.recovery_ref).toBe('rb-beside-b');
    // The deploy's own marker is released with the deploy, and the restore that
    // is still moving takes it back so a crash remains boot-recoverable. The
    // handed-back marker carries no operation id: the restore's original
    // operation is not the one reporting.
    expect(target.active_operation_stage).toBe('recovery_started');
    expect(target.active_operation_id).toBeNull();
    expect(target.active_generation_id).toBe('gen-app-rb-beside');
    expect(store.getApplication('app-rb-beside')?.recovery_phase).toBe('restoring');

    // The retry's own terminal then lands normally.
    tx.rollbackPartialFailed({
      applicationId: 'app-rb-beside',
      nodeId: 1,
      recoveryRef: 'rb-beside-b',
      failureClass: 'partial',
      envelope: env('op-rb-beside-b-terminal'),
    });
    expect(store.getTarget('app-rb-beside', 1)?.recovery_phase).toBe('failed');
    expect(store.getTarget('app-rb-beside', 1)?.recovery_failure_class).toBe('partial');
    // The terminal clears the marker it took back.
    expect(store.getTarget('app-rb-beside', 1)?.active_operation_stage).toBeNull();
  });

  it('keeps a restore marker through a tombstone so boot can reclassify it', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-rb-tomb-live', 'rb-tomb-live-web');

    tx.rollbackInProgress({
      applicationId: 'app-rb-tomb-live',
      nodeId: 1,
      recoveryRef: 'rb-tomb-live',
      recoveryGenerationId: 'gen-app-rb-tomb-live',
      envelope: env('op-rb-tomb-live'),
    });
    tx.targetTombstoned('app-rb-tomb-live', 1, env('op-rb-tomb-live-retire'));

    // The target is retired, but its restore is still moving. Without the
    // marker, boot would never select the application and the phase would stay
    // `restoring` for ever.
    const target = store.getTarget('app-rb-tomb-live', 1)!;
    expect(target.target_status).toBe('tombstoned');
    expect(target.recovery_phase).toBe('restoring');
    expect(target.active_operation_stage).toBe('recovery_started');
    expect(store.listApplicationsWithOpenOperations().some((row) => row.id === 'app-rb-tomb-live'))
      .toBe(true);
  });

  it('does not let a completion lift a hold another target owns', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-rb-sib-complete', 'rb-sib-complete-web');
    store.upsertTarget(emptyTargetRow('app-rb-sib-complete', 2, 1));

    // Target 1 fails after a possible mutation and owns the application hold.
    tx.rollbackInProgress({
      applicationId: 'app-rb-sib-complete',
      nodeId: 1,
      recoveryRef: 'rb-sib-a',
      recoveryGenerationId: 'gen-app-rb-sib-complete',
      envelope: env('op-rb-sib-a'),
    });
    tx.rollbackPartialFailed({
      applicationId: 'app-rb-sib-complete',
      nodeId: 1,
      recoveryRef: 'rb-sib-a',
      failureClass: 'partial',
      envelope: env('op-rb-sib-a-terminal'),
    });

    // Target 2 is restored successfully. Its completion is a receipt for one
    // target, not evidence about the other, so the hold survives.
    tx.rollbackInProgress({
      applicationId: 'app-rb-sib-complete',
      nodeId: 2,
      recoveryRef: 'rb-sib-b',
      recoveryGenerationId: 'gen-app-rb-sib-complete',
      envelope: env('op-rb-sib-b'),
    });
    tx.rollbackCompleted({
      applicationId: 'app-rb-sib-complete',
      nodeId: 2,
      recoveryRef: 'rb-sib-b',
      recoveryGenerationId: 'gen-app-rb-sib-complete',
      capturedArtifactSetId: null,
      capturedSourceAcceptanceRef: null,
      envelope: env('op-rb-sib-b-terminal'),
    });

    expect(store.getTarget('app-rb-sib-complete', 2)?.recovery_phase).toBe('complete');
    expect(store.getTarget('app-rb-sib-complete', 1)?.recovery_phase).toBe('failed');
    const app = store.getApplication('app-rb-sib-complete')!;
    expect(app.recovery_phase).toBe('failed');
    expect(app.failure_stage).toBe('recovery');
    expect(app.recovery_ref).toBe('rb-sib-a');
    expect(app.failure_class).toBe('partial');
  });

  it('makes a crashed rollback open recoverable at boot', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-rb-crash', 'rb-crash-web');

    tx.rollbackInProgress({
      applicationId: 'app-rb-crash',
      nodeId: 1,
      recoveryRef: 'rb-crash',
      recoveryGenerationId: 'gen-app-rb-crash',
      envelope: env('op-rb-crash'),
    });
    // The open marks the target so the startup selection reads the application
    // as holding an open operation at all.
    expect(store.getTarget('app-rb-crash', 1)?.active_operation_stage).toBe('recovery_started');
    expect(store.listApplicationsWithOpenOperations().some((row) => row.id === 'app-rb-crash'))
      .toBe(true);

    reclassifyInterruptedOperations();

    const target = store.getTarget('app-rb-crash', 1)!;
    expect(target.active_operation_stage).toBeNull();
    expect(target.recovery_phase).toBe('failed');
    expect(target.failure_stage).toBe('recovery');
    expect(target.failure_class).toBe('interrupted');
    expect(target.interruption_stage).toBe('recovery_started');
    expect(store.getApplication('app-rb-crash')?.recovery_phase).toBe('failed');

    // A later terminal rollback retires the interruption instead of leaving the
    // target held as interrupted for ever.
    tx.rollbackPartialFailed({
      applicationId: 'app-rb-crash',
      nodeId: 1,
      recoveryRef: 'rb-crash',
      failureClass: 'pre_mutation',
      envelope: env('op-rb-crash-terminal'),
    });
    expect(store.getTarget('app-rb-crash', 1)?.interruption_stage).toBeNull();
  });

  it('keeps a proven moved class when boot reclassifies a retry', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-rb-boot-keep', 'rb-boot-keep-web');

    tx.rollbackInProgress({
      applicationId: 'app-rb-boot-keep',
      nodeId: 1,
      recoveryRef: 'rb-boot-keep-a',
      recoveryGenerationId: 'gen-app-rb-boot-keep',
      envelope: env('op-rb-boot-keep-a'),
    });
    // The first attempt fails after a possible mutation, then a retry opens
    // over the failed row and keeps the claim's class.
    tx.rollbackPartialFailed({
      applicationId: 'app-rb-boot-keep',
      nodeId: 1,
      recoveryRef: 'rb-boot-keep-a',
      failureClass: 'partial',
      envelope: env('op-rb-boot-keep-a-terminal'),
    });
    tx.rollbackInProgress({
      applicationId: 'app-rb-boot-keep',
      nodeId: 1,
      recoveryRef: 'rb-boot-keep-b',
      recoveryGenerationId: 'gen-app-rb-boot-keep',
      envelope: env('op-rb-boot-keep-b'),
    });

    // Boot finds the retry interrupted. The unknown outcome does not erase the
    // proof the earlier failure recorded.
    tx.interruptActiveOperations('app-rb-boot-keep', env('op-rb-boot-keep-boot'));
    const target = store.getTarget('app-rb-boot-keep', 1)!;
    expect(target.recovery_phase).toBe('failed');
    expect(target.recovery_failure_class).toBe('partial');
    expect(target.interruption_stage).toBe('recovery_started');
  });

  it('leaves a moving sibling stamp alone when another target fails', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-rb-scope', 'rb-scope-web');
    store.upsertTarget(emptyTargetRow('app-rb-scope', 2, 1));

    tx.rollbackInProgress({
      applicationId: 'app-rb-scope',
      nodeId: 1,
      recoveryRef: 'rb-scope-a',
      recoveryGenerationId: 'gen-app-rb-scope',
      envelope: env('op-rb-scope-a'),
    });

    // A failure on a target outside the first restore's scope must not flip the
    // application to its own ref while the first restore is still moving.
    tx.rollbackPartialFailed({
      applicationId: 'app-rb-scope',
      nodeId: 2,
      recoveryRef: 'rb-scope-b',
      failureClass: 'partial',
      envelope: env('op-rb-scope-b-fail'),
    });
    expect(store.getApplication('app-rb-scope')?.recovery_phase).toBe('restoring');
    expect(store.getApplication('app-rb-scope')?.recovery_ref).toBe('rb-scope-a');

    // Once the first restore settles as a refusal, the derivation lands the
    // hold the other target's failure claimed.
    tx.rollbackPartialFailed({
      applicationId: 'app-rb-scope',
      nodeId: 1,
      recoveryRef: 'rb-scope-a',
      failureClass: 'pre_mutation',
      envelope: env('op-rb-scope-a-terminal'),
    });
    const app = store.getApplication('app-rb-scope')!;
    expect(app.recovery_phase).toBe('failed');
    expect(app.recovery_ref).toBe('rb-scope-b');
    expect(app.failure_class).toBe('partial');
  });

  it('refuses a second rollback while the target is already restoring', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-rb-serialized', 'rb-serialized-web');

    tx.rollbackInProgress({
      applicationId: 'app-rb-serialized',
      nodeId: 1,
      recoveryRef: 'rb-serialized-a',
      recoveryGenerationId: 'gen-app-rb-serialized',
      envelope: env('op-rb-serialized-a'),
    });

    // One restore per target: the second open is refused, so it cannot take the
    // recovery slot while the first is still writing files.
    expect(() => tx.rollbackInProgress({
      applicationId: 'app-rb-serialized',
      nodeId: 1,
      recoveryRef: 'rb-serialized-b',
      recoveryGenerationId: 'gen-app-rb-serialized',
      envelope: env('op-rb-serialized-b'),
    })).toThrow(/already in progress/);

    const target = store.getTarget('app-rb-serialized', 1)!;
    expect(target.recovery_phase).toBe('restoring');
    expect(target.recovery_ref).toBe('rb-serialized-a');
    expect(target.active_operation_id).toBe('op-rb-serialized-a');
  });

  it('keeps a boot-interrupted recovery claim through a later failure', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-rb-interrupted', 'rb-interrupted-web');

    tx.rollbackInProgress({
      applicationId: 'app-rb-interrupted',
      nodeId: 1,
      recoveryRef: 'rb-interrupted',
      recoveryGenerationId: 'gen-app-rb-interrupted',
      envelope: env('op-rb-interrupted'),
    });
    // The process dies mid-restore; boot reclassifies it as unknown.
    tx.interruptActiveOperations('app-rb-interrupted', env('op-rb-interrupted-boot'));
    expect(store.getTarget('app-rb-interrupted', 1)?.recovery_failure_class).toBe('interrupted');

    // A later failure is not evidence about the files the interrupted restore
    // may have left behind, so the claim and the hold survive it.
    tx.blueprintDeployFailed({
      applicationId: 'app-rb-interrupted',
      nodeId: 1,
      failureClass: 'deploy_failed',
      envelope: env('op-rb-interrupted-deploy'),
    });
    const held = store.getTarget('app-rb-interrupted', 1)!;
    expect(held.recovery_phase).toBe('failed');
    expect(held.recovery_failure_class).toBe('interrupted');
    expect(store.getApplication('app-rb-interrupted')?.recovery_phase).toBe('failed');

    // A deploy that Compose binds is success evidence and retires it.
    const applied = held.applied_generation_id!;
    const deployOperation = env('op-rb-interrupted-bind');
    tx.deployStarted('app-rb-interrupted', 1, applied, deployOperation);
    tx.deployBound('app-rb-interrupted', 1, applied, deployOperation);
    const bound = store.getTarget('app-rb-interrupted', 1)!;
    expect(bound.recovery_phase).toBeNull();
    expect(bound.recovery_failure_class).toBeNull();
    expect(store.getApplication('app-rb-interrupted')?.recovery_phase).toBeNull();
  });


  it('settles a partial failure whose own record never landed', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-rb-missed-partial', 'rb-missed-partial-web');

    tx.rollbackInProgress({
      applicationId: 'app-rb-missed-partial',
      nodeId: 1,
      recoveryRef: 'rb-missed-partial',
      recoveryGenerationId: 'gen-app-rb-missed-partial',
      envelope: env('op-rb-missed-partial'),
    });
    // The record write failed, so the row is still restoring with no claim.
    tx.rollbackRefusalSettled({
      applicationId: 'app-rb-missed-partial',
      targets: [{ nodeId: 1, failureClass: 'partial' }],
      recoveryRef: 'rb-missed-partial',
      envelope: env('op-rb-missed-partial-settle'),
    });

    const target = store.getTarget('app-rb-missed-partial', 1)!;
    expect(target.recovery_phase).toBe('failed');
    expect(target.recovery_failure_class).toBe('partial');
    const app = store.getApplication('app-rb-missed-partial')!;
    expect(app.recovery_phase).toBe('failed');
    expect(app.failure_stage).toBe('recovery');
    expect(app.failure_class).toBe('partial');
  });

  it('does not let a deploy failure on a refused target re-park the application', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-rb-deployfail', 'rb-deployfail-web');
    store.upsertTarget(emptyTargetRow('app-rb-deployfail', 2, 1));

    // Target 1 was refused and holds nothing.
    tx.rollbackInProgress({
      applicationId: 'app-rb-deployfail',
      nodeId: 1,
      recoveryRef: 'rb-deployfail-a',
      recoveryGenerationId: 'gen-app-rb-deployfail',
      envelope: env('op-rb-deployfail-a'),
    });
    tx.rollbackPartialFailed({
      applicationId: 'app-rb-deployfail',
      nodeId: 1,
      recoveryRef: 'rb-deployfail-a',
      failureClass: 'pre_mutation',
      envelope: env('op-rb-deployfail-a-fail'),
    });

    // A later Blueprint deploy to that target fails. It replaces the recovery
    // failure; the class it writes is not a recovery class.
    tx.blueprintDeployFailed({
      applicationId: 'app-rb-deployfail',
      nodeId: 1,
      failureClass: 'deploy_failed',
      envelope: env('op-rb-deployfail-deploy'),
    });
    expect(store.getTarget('app-rb-deployfail', 1)?.recovery_phase).toBeNull();
    expect(store.getTarget('app-rb-deployfail', 1)?.failure_stage).toBe('blueprint_deploy');

    // A refusal on target 2 must not read target 1 as a recovery hold.
    tx.rollbackInProgress({
      applicationId: 'app-rb-deployfail',
      nodeId: 2,
      recoveryRef: 'rb-deployfail-b',
      recoveryGenerationId: 'gen-app-rb-deployfail',
      envelope: env('op-rb-deployfail-b'),
    });
    tx.rollbackPartialFailed({
      applicationId: 'app-rb-deployfail',
      nodeId: 2,
      recoveryRef: 'rb-deployfail-b',
      failureClass: 'pre_mutation',
      envelope: env('op-rb-deployfail-b-fail'),
    });

    const app = store.getApplication('app-rb-deployfail')!;
    expect(app.recovery_phase).toBeNull();
    expect(app.failure_stage).toBeNull();
  });

  // The four failure writers that can land on a target with a standing recovery
  // claim. A failure is not evidence the target is consistent, so a claim that
  // may have moved it survives every one of them.
  const movedClaimWriters: Array<{
    name: string;
    key: string;
    run: (tx: GitOpsTransitions, applicationId: string, nodeId: number) => void;
  }> = [
    {
      name: 'a blueprint deploy failure',
      key: 'bp-deploy',
      run: (tx, applicationId, nodeId) => tx.blueprintDeployFailed({
        applicationId, nodeId, failureClass: 'deploy_failed', envelope: env('op-replace-bp-deploy'),
      }),
    },
    {
      name: 'a blueprint withdraw failure',
      key: 'bp-withdraw',
      run: (tx, applicationId, nodeId) => tx.blueprintWithdrawFailed({
        applicationId, nodeId, failureClass: 'withdraw_failed', envelope: env('op-replace-bp-withdraw'),
      }),
    },
    {
      name: 'a direct deploy failure',
      key: 'direct-deploy',
      run: (tx, applicationId, nodeId) => tx.deployFailed(
        applicationId, nodeId, 'post_mutation', env('op-replace-direct-deploy'),
      ),
    },
    {
      name: 'a direct unbound deploy',
      key: 'direct-unbound',
      run: (tx, applicationId, nodeId) => {
        const applied = GitOpsStore.getInstance().getTarget(applicationId, nodeId)!.applied_generation_id!;
        // One operation owns the start and its unbound terminal.
        const operation = env('op-replace-unbound');
        tx.deployStarted(applicationId, nodeId, applied, operation);
        tx.deployUnbound(applicationId, nodeId, applied, operation);
      },
    },
  ];

  for (const writer of movedClaimWriters) {
    it(`keeps a moved recovery claim through ${writer.name}`, () => {
      const store = GitOpsStore.getInstance();
      const tx = GitOpsTransitions.getInstance();
      const appId = `app-rb-replaced-${writer.key}`;
      seedApplied(appId, `rb-replaced-${writer.key}-web`);

      // A rollback fails after a possible mutation: the target claims the hold.
      tx.rollbackInProgress({
        applicationId: appId,
        nodeId: 1,
        recoveryRef: `rb-replaced-${writer.key}`,
        recoveryGenerationId: `gen-${appId}`,
        envelope: env(`op-rb-replaced-${writer.key}`),
      });
      tx.rollbackPartialFailed({
        applicationId: appId,
        nodeId: 1,
        recoveryRef: `rb-replaced-${writer.key}`,
        failureClass: 'partial',
        envelope: env(`op-rb-replaced-${writer.key}-fail`),
      });
      expect(store.getApplication(appId)?.recovery_phase).toBe('failed');

      // The later failure records itself in the shared slot. It is not evidence
      // that the half-restored target is consistent, so the claim, its class and
      // the application hold all survive.
      writer.run(tx, appId, 1);

      const target = store.getTarget(appId, 1)!;
      expect(target.recovery_phase).toBe('failed');
      expect(target.recovery_failure_class).toBe('partial');
      expect(target.failure_stage).not.toBe('recovery');
      const app = store.getApplication(appId)!;
      expect(app.recovery_phase).toBe('failed');
      expect(app.failure_stage).toBe('recovery');
    });

    it(`retires a pre-mutation claim on ${writer.name}`, () => {
      const store = GitOpsStore.getInstance();
      const tx = GitOpsTransitions.getInstance();
      const appId = `app-rb-replaced-pre-${writer.key}`;
      seedApplied(appId, `rb-replaced-pre-${writer.key}-web`);

      // A refusal proves the restore moved nothing, so it holds nothing, and a
      // later failure is free to take the row over.
      tx.rollbackInProgress({
        applicationId: appId,
        nodeId: 1,
        recoveryRef: `rb-replaced-pre-${writer.key}`,
        recoveryGenerationId: `gen-${appId}`,
        envelope: env(`op-rb-replaced-pre-${writer.key}`),
      });
      tx.rollbackPartialFailed({
        applicationId: appId,
        nodeId: 1,
        recoveryRef: `rb-replaced-pre-${writer.key}`,
        failureClass: 'pre_mutation',
        envelope: env(`op-rb-replaced-pre-${writer.key}-fail`),
      });

      writer.run(tx, appId, 1);

      const target = store.getTarget(appId, 1)!;
      expect(target.recovery_phase).toBeNull();
      expect(target.recovery_failure_class).toBeNull();
      expect(target.failure_stage).not.toBe('recovery');
    });
  }

  it('leaves a later deploy failure in the shared slot when a refusal defers', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-rb-defer', 'rb-defer-web');

    tx.rollbackInProgress({
      applicationId: 'app-rb-defer',
      nodeId: 1,
      recoveryRef: 'rb-defer-a',
      recoveryGenerationId: 'gen-app-rb-defer',
      envelope: env('op-rb-defer-a'),
    });
    tx.rollbackPartialFailed({
      applicationId: 'app-rb-defer',
      nodeId: 1,
      recoveryRef: 'rb-defer-a',
      failureClass: 'partial',
      envelope: env('op-rb-defer-a-terminal'),
    });
    // A deploy failure records itself in the shared slot; it is not evidence
    // about the half-restored files, so the claim keeps its own columns.
    tx.deployFailed('app-rb-defer', 1, 'post_mutation', { ...env('op-rb-defer-deploy'), at: 3000 });

    // A retry opens over the failed row, then is refused before it moves
    // anything. The refusal defers to the moved claim and leaves the shared
    // slot describing the deploy failure.
    tx.rollbackInProgress({
      applicationId: 'app-rb-defer',
      nodeId: 1,
      recoveryRef: 'rb-defer-b',
      recoveryGenerationId: 'gen-app-rb-defer',
      envelope: env('op-rb-defer-b'),
    });
    tx.rollbackPartialFailed({
      applicationId: 'app-rb-defer',
      nodeId: 1,
      recoveryRef: 'rb-defer-b',
      failureClass: 'pre_mutation',
      envelope: env('op-rb-defer-b-terminal'),
    });

    const target = store.getTarget('app-rb-defer', 1)!;
    expect(target.recovery_phase).toBe('failed');
    expect(target.recovery_failure_class).toBe('partial');
    expect(target.failure_stage).toBe('deploy');
    expect(target.failure_class).toBe('post_mutation');
    expect(target.failure_at).toBe(3000);
    const app = store.getApplication('app-rb-defer')!;
    expect(app.recovery_phase).toBe('failed');
    expect(app.failure_class).toBe('partial');
  });

  it('does not let a retry refusal downgrade a target that already failed after mutation', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-rb-retry', 'rb-retry-web');

    tx.rollbackInProgress({
      applicationId: 'app-rb-retry',
      nodeId: 1,
      recoveryRef: 'rb-retry-a',
      recoveryGenerationId: 'gen-app-rb-retry',
      envelope: env('op-rb-retry-a'),
    });
    tx.rollbackPartialFailed({
      applicationId: 'app-rb-retry',
      nodeId: 1,
      recoveryRef: 'rb-retry-a',
      failureClass: 'partial',
      envelope: env('op-rb-retry-a-fail'),
    });
    const failedAt = store.getTarget('app-rb-retry', 1)!.failure_at;

    // The operator retries that target and the node refuses before moving
    // anything. The refusal must not erase the earlier failure's class.
    tx.rollbackInProgress({
      applicationId: 'app-rb-retry',
      nodeId: 1,
      recoveryRef: 'rb-retry-b',
      recoveryGenerationId: 'gen-app-rb-retry',
      envelope: env('op-rb-retry-b'),
    });
    tx.rollbackPartialFailed({
      applicationId: 'app-rb-retry',
      nodeId: 1,
      recoveryRef: 'rb-retry-b',
      failureClass: 'pre_mutation',
      envelope: env('op-rb-retry-b-fail'),
    });

    const target = store.getTarget('app-rb-retry', 1)!;
    expect(target.recovery_phase).toBe('failed');
    expect(target.failure_class).toBe('partial');
    expect(target.failure_at).toBe(failedAt);
    const app = store.getApplication('app-rb-retry')!;
    expect(app.recovery_phase).toBe('failed');
    expect(app.failure_class).toBe('partial');
  });

  it('settles a refused rollback whose per-target record never landed', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-rb-missed', 'rb-missed-web');

    tx.rollbackInProgress({
      applicationId: 'app-rb-missed',
      nodeId: 1,
      recoveryRef: 'rb-missed',
      recoveryGenerationId: 'gen-app-rb-missed',
      envelope: env('op-rb-missed-start'),
    });
    expect(store.getApplication('app-rb-missed')?.recovery_phase).toBe('restoring');

    // The route calls this when `rollbackPartialFailed` threw and its own
    // in-transaction settle never ran. The retry gives the target a terminal
    // state as well, so it does not stay restoring for ever.
    tx.rollbackRefusalSettled({
      applicationId: 'app-rb-missed',
      targets: [{ nodeId: 1, failureClass: 'pre_mutation' }],
      recoveryRef: 'rb-missed',
      envelope: env('op-rb-missed-settle'),
    });

    const target = store.getTarget('app-rb-missed', 1)!;
    expect(target.recovery_phase).toBe('failed');
    expect(target.failure_class).toBe('pre_mutation');
    expect(target.active_operation_stage).toBeNull();
    expect(store.getApplication('app-rb-missed')?.recovery_phase).toBeNull();
    expect(store.getApplication('app-rb-missed')?.failure_stage).toBeNull();
  });

  it('settles several missed refusal records at once', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-rb-missed2', 'rb-missed2-web');
    store.upsertTarget(emptyTargetRow('app-rb-missed2', 2, 1));

    // Both refusals open their target and neither terminal record lands, so
    // both targets still read as restoring. Settling one without excluding the
    // other would leave the stamp stuck on the sibling.
    tx.rollbackInProgress({
      applicationId: 'app-rb-missed2',
      nodeId: 1,
      recoveryRef: 'rb-missed2',
      recoveryGenerationId: 'gen-app-rb-missed2',
      envelope: env('op-rb-missed2-a'),
    });
    tx.rollbackInProgress({
      applicationId: 'app-rb-missed2',
      nodeId: 2,
      recoveryRef: 'rb-missed2',
      recoveryGenerationId: 'gen-app-rb-missed2',
      envelope: env('op-rb-missed2-b'),
    });

    tx.rollbackRefusalSettled({
      applicationId: 'app-rb-missed2',
      targets: [
        { nodeId: 1, failureClass: 'pre_mutation' },
        { nodeId: 2, failureClass: 'pre_mutation' },
      ],
      recoveryRef: 'rb-missed2',
      envelope: env('op-rb-missed2-settle'),
    });

    expect(store.getApplication('app-rb-missed2')?.recovery_phase).toBeNull();
    expect(store.getApplication('app-rb-missed2')?.failure_stage).toBeNull();
    for (const nodeId of [1, 2]) {
      const target = store.getTarget('app-rb-missed2', nodeId)!;
      expect(target.recovery_phase).toBe('failed');
      expect(target.failure_class).toBe('pre_mutation');
      expect(target.active_operation_stage).toBeNull();
    }
  });

  it('lets a fresh mutated failure replace an earlier one on a retry', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-rb-fresh', 'rb-fresh-web');
    const envAt = (operationId: string, at: number): EventEnvelope => ({
      operationId, actor: 'tester', trigger: 'manual', at,
    });

    tx.rollbackInProgress({
      applicationId: 'app-rb-fresh',
      nodeId: 1,
      recoveryRef: 'rb-fresh-a',
      recoveryGenerationId: 'gen-app-rb-fresh',
      envelope: envAt('op-rb-fresh-a', 100),
    });
    tx.rollbackPartialFailed({
      applicationId: 'app-rb-fresh',
      nodeId: 1,
      recoveryRef: 'rb-fresh-a',
      failureClass: 'partial',
      envelope: envAt('op-rb-fresh-a-fail', 100),
    });

    // The retry fails again, after a possible mutation. Its record is the
    // newer truth; only a refusal that moved nothing defers to the earlier one.
    tx.rollbackInProgress({
      applicationId: 'app-rb-fresh',
      nodeId: 1,
      recoveryRef: 'rb-fresh-b',
      recoveryGenerationId: 'gen-app-rb-fresh',
      envelope: envAt('op-rb-fresh-b', 200),
    });
    tx.rollbackPartialFailed({
      applicationId: 'app-rb-fresh',
      nodeId: 1,
      recoveryRef: 'rb-fresh-b',
      failureClass: 'partial',
      envelope: envAt('op-rb-fresh-b-fail', 200),
    });

    const target = store.getTarget('app-rb-fresh', 1)!;
    expect(target.failure_class).toBe('partial');
    expect(target.failure_at).toBe(200);
    expect(target.recovery_ref).toBe('rb-fresh-b');
    expect(store.getApplication('app-rb-fresh')?.failure_at).toBe(200);
  });

  it('completes a rollback only against a generation it can prove', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-rb-done', 'rb-done-web');
    const generationId = 'gen-app-rb-done';

    // Nothing bound yet, so there is no generation to complete against.
    expect(() => tx.rollbackCompleted({
      applicationId: 'app-rb-done',
      nodeId: 1,
      recoveryRef: 'rb-3',
      recoveryGenerationId: generationId,
      capturedArtifactSetId: null,
      capturedSourceAcceptanceRef: null,
      envelope: env('op-rb-done-early'),
    })).toThrow(/bound recovery generation/);

    tx.rollbackInProgress({
      applicationId: 'app-rb-done',
      nodeId: 1,
      recoveryRef: 'rb-3',
      recoveryGenerationId: generationId,
      envelope: env('op-rb-done-start'),
    });
    tx.rollbackCompleted({
      applicationId: 'app-rb-done',
      nodeId: 1,
      recoveryRef: 'rb-3',
      recoveryGenerationId: generationId,
      capturedArtifactSetId: null,
      capturedSourceAcceptanceRef: null,
      envelope: env('op-rb-done'),
    });

    const target = store.getTarget('app-rb-done', 1)!;
    expect(target.recovery_phase).toBe('complete');
    expect(target.desired_generation_id).toBe(generationId);
    expect(target.applied_generation_id).toBe(generationId);
    // The workload is back but nothing has observed it yet.
    expect(target.healthy_generation_id).toBeNull();
  });

  it('refuses to complete a rollback onto another application generation', () => {
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-rb-foreign', 'rb-foreign-web');
    seedApplied('app-rb-owner', 'rb-owner-web');

    tx.rollbackInProgress({
      applicationId: 'app-rb-foreign',
      nodeId: 1,
      recoveryRef: 'rb-4',
      recoveryGenerationId: 'gen-app-rb-owner',
      envelope: env('op-rb-foreign-start'),
    });

    expect(() => tx.rollbackCompleted({
      applicationId: 'app-rb-foreign',
      nodeId: 1,
      recoveryRef: 'rb-4',
      recoveryGenerationId: 'gen-app-rb-owner',
      capturedArtifactSetId: null,
      capturedSourceAcceptanceRef: null,
      envelope: env('op-rb-foreign'),
    })).toThrow(/does not own/);
  });
});

function projectOf(applicationId: string) {
  const projection = projectApplication(applicationId, true);
  if (projection.targetMode === 'not_applicable') throw new Error('expected an application');
  return projection;
}

function seedApplied(applicationId: string, stackName: string): void {
  const store = GitOpsStore.getInstance();
  const tx = GitOpsTransitions.getInstance();
  const generationId = `gen-${applicationId}`;
  tx.activateDirect({ application: app(applicationId, stackName), nodeId: 1, envelope: env(`op-act-${applicationId}`) });
  store.insertGeneration(gen(generationId, applicationId));
  tx.fetchStarted(applicationId, env(`op-f-${applicationId}`));
  tx.fetched(applicationId, 'abc123', env(`op-f-${applicationId}`));
  tx.candidateReady(applicationId, generationId, false, env(`op-c-${applicationId}`));
  tx.applied({
    applicationId,
    generationId,
    artifactSetId: `art-${applicationId}`,
    sourceAcceptanceId: `acc-${applicationId}`,
    authority: 'operator',
    envelope: env(`op-a-${applicationId}`),
  });
}

function env(operationId: string): EventEnvelope {
  return { operationId, actor: 'tester', trigger: 'manual', at: Date.now() };
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
