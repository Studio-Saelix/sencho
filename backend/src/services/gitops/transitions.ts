import type { RefKind } from '../git/types';
import { DatabaseService } from '../DatabaseService';
import {
  decodeArtifactEvidenceJson,
  decodeGitOpsEvidenceLimitations,
  decodeGitOpsJson,
  encodeArtifactEvidenceJson,
  encodeGitOpsEvidenceLimitations,
} from './json';
import { insertHistory, type GitOpsHistoryStage, type HistoryOutcome } from './history';
import { emptyTargetRow, GitOpsStore } from './store';
import type {
  ArtifactQualification,
  GitOpsApplicationRow,
  GitOpsApprovalAuthority,
  GitOpsArtifactSetRow,
  GitOpsCreateCheckpointRow,
  GitOpsGenerationRow,
  GitOpsIntentRevisionRow,
  GitOpsRolloutCandidateRow,
  GitOpsTargetCurrentRow,
} from './types';

export type EventEnvelope = {
  operationId: string;
  actor: string | null;
  trigger: string;
  at: number;
};

export type AppliedArgs = {
  applicationId: string;
  generationId: string;
  artifactSetId: string;
  sourceAcceptanceId: string;
  authority: Exclude<GitOpsApprovalAuthority, 'legacy_combined'>;
  envelope: EventEnvelope;
  activateCreating?: boolean;
};

export type TransitionResult = {
  historyIds: string[];
  replayed: boolean;
};

/**
 * The stages the reconciler may record against a target as an observation.
 *
 * Exported because the deriver has to project every one of them, and a stage
 * added here that nothing projects is exactly the defect that made these
 * observations unreadable. `BLUEPRINT_OBSERVATION_STATUS` in `derive.ts` is
 * declared total over this union, so widening it fails that build rather than
 * silently dropping the new stage back into the pointer-derived states.
 */
export type BlueprintObservationStage =
  | 'blueprint_state_review'
  | 'blueprint_evict_blocked'
  | 'blueprint_drifted'
  | 'blueprint_correcting';

/**
 * What a health run claimed inside a recovery transaction reported back.
 *
 * `replayed` means the recovery already owned a run, so the caller arms that
 * one rather than opening a second observation of the same restore.
 */
export type HealthRunReservation = {
  outcome: 'reserved' | 'replayed' | 'disabled';
  runId: string | null;
};

export class GitOpsTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitOpsTransitionError';
  }
}

export class GitOpsTransitions {
  private static instance: GitOpsTransitions | undefined;

  static getInstance(): GitOpsTransitions {
    if (!GitOpsTransitions.instance) GitOpsTransitions.instance = new GitOpsTransitions();
    return GitOpsTransitions.instance;
  }

  static resetForTests(): void {
    GitOpsTransitions.instance = undefined;
  }

  private store(): GitOpsStore {
    return GitOpsStore.getInstance();
  }

  private raw() {
    return DatabaseService.getInstance().getDb();
  }

  activateDirect(args: {
    application: GitOpsApplicationRow;
    nodeId: number;
    envelope: EventEnvelope;
  }): TransitionResult {
    return this.raw().transaction(() => {
      const live = this.store().getLiveDirectApplication(args.application.stack_name ?? '');
      if (live) throw new GitOpsTransitionError('live direct application already exists');
      this.store().insertApplication(args.application);
      this.store().upsertTarget(emptyTargetRow(args.application.id, args.nodeId, args.envelope.at));
      const historyId = this.history(args.application, args.envelope, {
        stage: 'application_activated',
        outcome: 'committed',
        before: { lifecycleStatus: null },
        after: { lifecycleStatus: args.application.lifecycle_status, targetMode: 'direct' },
      });
      return { historyIds: historyId ? [historyId] : [], replayed: !historyId };
    })();
  }

  /**
   * Bring an Inline Blueprint into the model.
   *
   * No target is created. A Blueprint application has no targets until
   * something is deployed somewhere, unlike a Direct one which always has the
   * node its stack lives on.
   */
  activateInlineBlueprint(args: {
    application: GitOpsApplicationRow;
    envelope: EventEnvelope;
  }): TransitionResult {
    return this.raw().transaction(() => {
      const blueprintId = args.application.blueprint_id;
      if (blueprintId === null) {
        throw new GitOpsTransitionError('an inline blueprint application needs a blueprint id');
      }
      if (this.store().getLiveBlueprintApplication(blueprintId)) {
        throw new GitOpsTransitionError('live blueprint application already exists');
      }
      this.store().insertApplication(args.application);
      const historyId = this.history(args.application, args.envelope, {
        stage: 'application_activated',
        outcome: 'committed',
        before: { lifecycleStatus: null },
        after: { lifecycleStatus: args.application.lifecycle_status, targetMode: 'inline_blueprint' },
      });
      return { historyIds: historyId ? [historyId] : [], replayed: !historyId };
    })();
  }

  fetched(applicationId: string, commitSha: string, envelope: EventEnvelope, resolvedRefKind: RefKind | null = null): TransitionResult {
    return this.mutateApp(applicationId, envelope, 'fetched', 'committed', (app) => {
      this.requireMatchingFetch(app, envelope);
      this.clearActive(app);
      app.desired_commit_sha = commitSha;
      app.fetched_commit_sha = commitSha;
      app.fetched_resolved_ref_kind = resolvedRefKind;
      app.retry_count = 0;
      this.clearAppFailure(app, ['fetch', 'validation']);
      this.clearInterruption(app, 'fetch_started');
    });
  }

  fetchStarted(applicationId: string, envelope: EventEnvelope): TransitionResult {
    return this.mutateApp(applicationId, envelope, 'fetch_started', 'committed', (app) => {
      if (app.suspended_at) throw new GitOpsTransitionError('source is suspended');
      if (app.active_operation_stage === 'apply_started') {
        throw new GitOpsTransitionError('apply is already active');
      }
      if (app.active_operation_stage && app.active_operation_id !== envelope.operationId) {
        throw new GitOpsTransitionError('conflicting active operation');
      }
      app.active_operation_id = envelope.operationId;
      app.active_operation_stage = 'fetch_started';
      app.active_operation_at = envelope.at;
      app.active_generation_id = null;
      app.retry_at = null;
      this.clearInterruption(app, 'fetch_started');
    });
  }

  fetchFailed(applicationId: string, envelope: EventEnvelope): TransitionResult {
    return this.mutateApp(applicationId, envelope, 'fetch_failed', 'failed', (app) => {
      this.requireMatchingFetch(app, envelope);
      this.clearActive(app);
      app.failure_stage = 'fetch';
      app.failure_class = 'fetch';
      app.failure_at = envelope.at;
      this.clearInterruption(app, 'fetch_started');
    });
  }

  /**
   * A fetch that resolved a commit whose project does not validate.
   *
   * The SHA still advances: we know what the remote has, we just cannot build
   * from it. Retry count is deliberately not reset, because nothing about this
   * outcome suggests the next attempt will differ.
   */
  fetchedInvalid(applicationId: string, commitSha: string, envelope: EventEnvelope, resolvedRefKind: RefKind | null = null): TransitionResult {
    return this.mutateApp(applicationId, envelope, 'fetched_invalid', 'failed', (app) => {
      this.requireMatchingFetch(app, envelope);
      this.clearActive(app);
      app.desired_commit_sha = commitSha;
      app.fetched_commit_sha = commitSha;
      app.fetched_resolved_ref_kind = resolvedRefKind;
      app.failure_stage = 'validation';
      app.failure_class = 'validation';
      app.failure_at = envelope.at;
      this.clearInterruption(app, 'fetch_started');
    });
  }

  /**
   * A candidate whose change plan is blocked.
   *
   * It becomes the current candidate so the operator can see what is waiting,
   * but it is marked blocked and can never be applied.
   */
  sourceConflictBlocker(applicationId: string, generationId: string, envelope: EventEnvelope): TransitionResult {
    return this.mutateApp(applicationId, envelope, 'source_conflict_blocker', 'committed', (app, extras) => {
      const generation = this.requireOwnedGeneration(app.id, generationId);
      if (generation.plan_blocked !== 1) {
        throw new GitOpsTransitionError('generation is not blocked');
      }
      if (app.active_operation_stage === 'apply_started' && app.candidate_generation_id !== generationId) {
        throw new GitOpsTransitionError('cannot replace the candidate while an apply is in flight');
      }
      this.supersedeCandidate(app, generationId, envelope, extras);
      app.candidate_generation_id = generationId;
      app.candidate_plan_blocked = 1;
      this.forEachLiveDirectTarget(app, (target) => {
        target.candidate_generation_id = generationId;
        this.store().upsertTarget(target);
      });
    }, { generationId });
  }

  /**
   * The operator declined the pending candidate.
   *
   * Only the candidate is cleared. Whatever is accepted, applied, or deployed
   * stays exactly where it is, and an operation in flight blocks the dismissal
   * rather than pulling the candidate out from under it.
   */
  dismissed(applicationId: string, envelope: EventEnvelope): TransitionResult {
    return this.mutateApp(applicationId, envelope, 'dismissed', 'skipped', (app) => {
      if (!app.candidate_generation_id) throw new GitOpsTransitionError('no candidate to dismiss');
      if (app.active_operation_stage) {
        throw new GitOpsTransitionError('cannot dismiss while an operation is in flight');
      }
      app.candidate_generation_id = null;
      app.candidate_plan_blocked = 0;
      app.review_required = 0;
      this.forEachLiveDirectTarget(app, (target) => {
        target.candidate_generation_id = null;
        this.store().upsertTarget(target);
      });
    });
  }

  /**
   * The material source configuration changed under a staged candidate.
   *
   * Everything derived from the old configuration is cleared, including the
   * candidate, because a candidate built from a different repository, ref, or
   * file set can no longer be applied. Accepted, applied, deployed, and healthy
   * pointers survive: the workload that is running did not change just because
   * the configuration pointing at it did.
   */
  configChangedPendingCleared(args: {
    applicationId: string;
    identity: { repoUrl: string; repoIdentityJson: string; configuredRef: string };
    material: {
      composePathsJson: string;
      contextDir: string | null;
      syncEnv: number;
      envPath: string | null;
      fingerprint: string;
    };
    envelope: EventEnvelope;
  }): TransitionResult {
    return this.mutateApp(args.applicationId, args.envelope, 'config_changed_pending_cleared', 'committed', (app) => {
      if (app.target_mode !== 'direct') {
        throw new GitOpsTransitionError('material configuration applies to Direct applications only');
      }
      // The same guard dismissal and candidate replacement carry, and for the
      // same reason: pulling the candidate out from under a live operation
      // makes that operation's completion event unmatchable.
      if (app.active_operation_stage) {
        throw new GitOpsTransitionError('cannot change material configuration while an operation is in flight');
      }
      app.configured_repo_url = args.identity.repoUrl;
      app.repo_identity_json = args.identity.repoIdentityJson;
      app.configured_ref = args.identity.configuredRef;
      app.compose_paths_json = args.material.composePathsJson;
      app.context_dir = args.material.contextDir;
      app.sync_env = args.material.syncEnv;
      app.env_path = args.material.envPath;
      app.materialization_fingerprint = args.material.fingerprint;
      app.desired_commit_sha = null;
      app.fetched_commit_sha = null;
      app.fetched_resolved_ref_kind = null;
      app.candidate_generation_id = null;
      app.candidate_plan_blocked = 0;
      app.review_required = 0;
      this.clearAppFailure(app, ['fetch', 'validation']);
      this.forEachLiveDirectTarget(app, (target) => {
        target.candidate_generation_id = null;
        this.store().upsertTarget(target);
      });
    });
  }

  candidateReady(applicationId: string, generationId: string, reviewRequired: boolean, envelope: EventEnvelope): TransitionResult {
    return this.mutateApp(applicationId, envelope, 'candidate_ready', 'committed', (app, extras) => {
      const generation = this.requireOwnedGeneration(app.id, generationId);
      if (generation.validation_ok !== 1 || generation.plan_blocked !== 0) {
        throw new GitOpsTransitionError('generation is not a valid candidate');
      }
      if (generation.materialization_fingerprint !== app.materialization_fingerprint) {
        throw new GitOpsTransitionError('generation fingerprint does not match current configuration');
      }
      if (app.active_operation_stage === 'apply_started' && app.candidate_generation_id !== generationId) {
        throw new GitOpsTransitionError('cannot replace the candidate while an apply is in flight');
      }
      this.supersedeCandidate(app, generationId, envelope, extras);
      app.candidate_generation_id = generationId;
      app.candidate_plan_blocked = 0;
      app.review_required = reviewRequired ? 1 : 0;
      this.clearAppFailure(app, ['validation']);
      this.forEachLiveDirectTarget(app, (target) => {
        target.candidate_generation_id = generationId;
        this.store().upsertTarget(target);
      });
    }, { generationId });
  }

  applyStarted(applicationId: string, generationId: string, envelope: EventEnvelope): TransitionResult {
    return this.mutateApp(applicationId, envelope, 'apply_started', 'committed', (app) => {
      if (app.suspended_at) throw new GitOpsTransitionError('source is suspended');
      if (app.candidate_generation_id !== generationId) {
        throw new GitOpsTransitionError('apply generation is not the current candidate');
      }
      if (app.candidate_plan_blocked === 1) throw new GitOpsTransitionError('candidate is blocked');
      const generation = this.requireOwnedGeneration(app.id, generationId);
      if (generation.materialization_fingerprint !== app.materialization_fingerprint) {
        throw new GitOpsTransitionError('generation fingerprint does not match current configuration');
      }
      if (app.active_operation_stage && app.active_operation_id !== envelope.operationId) {
        throw new GitOpsTransitionError('conflicting active operation');
      }
      app.active_operation_id = envelope.operationId;
      app.active_operation_stage = 'apply_started';
      app.active_operation_at = envelope.at;
      app.active_generation_id = generationId;
      this.clearInterruption(app, 'apply_started');
    }, { generationId });
  }

  applyFailed(applicationId: string, failureClass: string, envelope: EventEnvelope): TransitionResult {
    return this.mutateApp(applicationId, envelope, 'apply_failed', 'failed', (app) => {
      if (app.active_operation_stage !== 'apply_started' && app.interruption_stage !== 'apply_started') {
        throw new GitOpsTransitionError('no matching apply operation');
      }
      this.clearActive(app);
      app.failure_stage = 'apply';
      app.failure_class = failureClass;
      app.failure_at = envelope.at;
      this.clearInterruption(app, 'apply_started');
    });
  }

  applied(args: AppliedArgs): TransitionResult {
    return this.mutateApp(args.applicationId, args.envelope, 'applied', 'committed', (app) => {
      const targets = this.acceptanceTargets(app, args);
      this.applySourceAcceptanceMutation(app, args);
      for (const target of targets) {
        if (app.target_mode === 'direct') {
          this.applyTargetAcceptanceMutation(target, args);
        }
        this.store().upsertTarget(target);
      }
    }, {
      generationId: args.generationId,
      artifactSetId: args.artifactSetId,
      sourceAcceptanceRef: args.sourceAcceptanceId,
    });
  }

  /**
   * Mode-neutral half of `applied`: accept the candidate at the application
   * level without binding any target. A Direct dispatch calls this before
   * promotion; `targetApplied` binds the target only after promotion commits.
   */
  sourceAccepted(args: AppliedArgs): TransitionResult {
    return this.mutateApp(args.applicationId, args.envelope, 'source_accepted', 'committed', (app) => {
      // Unlike applied() (preserved byte-identical, predates suspension),
      // this new entry point is the one a suspended source must refuse: no
      // new acceptance while suspended, so the check lives here rather than
      // in the shared requireAcceptableCandidate guard.
      if (app.suspended_at) throw new GitOpsTransitionError('source is suspended');
      this.requireAcceptableCandidate(app, args);
      this.applySourceAcceptanceMutation(app, args);
    }, {
      generationId: args.generationId,
      artifactSetId: args.artifactSetId,
      sourceAcceptanceRef: args.sourceAcceptanceId,
    });
  }

  /**
   * Direct-only half of `applied`: bind one target to an already-accepted
   * generation. Refuses a generation the application has not accepted, so a
   * dispatch cannot bind a target to source content nothing authorized.
   */
  targetApplied(nodeId: number, args: AppliedArgs): TransitionResult {
    const app = this.requireApp(args.applicationId);
    if (app.target_mode !== 'direct') {
      throw new GitOpsTransitionError('target application is not direct');
    }
    if (app.accepted_generation_id !== args.generationId) {
      throw new GitOpsTransitionError('generation is not accepted');
    }
    // The application's accepted_generation_id does not move again until a
    // later sourceAccepted call, so a delayed dispatch for a superseded-but-
    // still-accepted generation would otherwise pass the check above even
    // after a newer candidate has already been staged for this target. Only
    // an acceptance reference this application actually recorded may bind a
    // target; a caller passing any other id would otherwise write
    // unverifiable authorization evidence straight onto the target row.
    if (app.source_acceptance_ref !== args.sourceAcceptanceId) {
      throw new GitOpsTransitionError('source acceptance reference does not match the accepted generation');
    }
    return this.mutateTarget(args.applicationId, nodeId, args.envelope, 'target_applied', args.generationId, (target) => {
      if (target.target_status !== 'active') {
        throw new GitOpsTransitionError('cannot apply to a tombstoned target');
      }
      if (target.candidate_generation_id !== args.generationId) {
        throw new GitOpsTransitionError('target candidate does not match applied generation');
      }
      const before = { appliedGenerationId: target.applied_generation_id };
      this.applyTargetAcceptanceMutation(target, args);
      return { before, after: { appliedGenerationId: args.generationId } };
    });
  }

  /**
   * The single transaction that makes a create-from-Git durable.
   *
   * Nothing here runs until the fetch, the candidate build, and the change-plan
   * classification have all succeeded, so a create that fails early leaves no
   * GitOps rows at all. Once this commits, the crash matrix can finish the
   * create from the checkpoint instead of guessing what the process intended.
   *
   * History order is fixed: activation, then the fetch that resolved the SHA,
   * then the candidate that fetch produced. Source acceptance is deliberately
   * not written here; it belongs to `applied`, which is the success boundary.
   */
  activateCreateFromGit(args: {
    application: GitOpsApplicationRow;
    nodeId: number;
    commitSha: string;
    generation: GitOpsGenerationRow;
    checkpoint: GitOpsCreateCheckpointRow;
    envelope: EventEnvelope;
  }): TransitionResult {
    return this.raw().transaction(() => {
      const stackName = args.application.stack_name ?? '';
      if (this.store().getLiveDirectApplication(stackName)) {
        throw new GitOpsTransitionError('live direct application already exists');
      }
      if (args.application.lifecycle_status !== 'creating') {
        throw new GitOpsTransitionError('create activation requires a creating application');
      }
      if (args.generation.application_id !== args.application.id) {
        throw new GitOpsTransitionError('generation does not belong to the application');
      }
      if (args.generation.materialization_fingerprint !== args.application.materialization_fingerprint) {
        throw new GitOpsTransitionError('generation fingerprint does not match the application');
      }
      if (args.generation.validation_ok !== 1 || args.generation.plan_blocked !== 0) {
        throw new GitOpsTransitionError('create cannot persist an invalid or blocked candidate');
      }

      const app = { ...args.application };
      this.store().insertApplication(app);
      const target = emptyTargetRow(app.id, args.nodeId, args.envelope.at);
      this.store().upsertTarget(target);
      const historyIds: string[] = [];
      const pushHistory = (id: string | null): void => {
        if (id) historyIds.push(id);
      };

      pushHistory(this.history(app, args.envelope, {
        stage: 'application_activated',
        outcome: 'committed',
        before: { lifecycleStatus: null },
        after: { lifecycleStatus: 'creating', targetMode: app.target_mode },
      }));

      app.desired_commit_sha = args.commitSha;
      app.fetched_commit_sha = args.commitSha;
      app.fetched_resolved_ref_kind = args.generation.resolved_ref_kind;
      app.retry_count = 0;
      pushHistory(this.history(app, args.envelope, {
        stage: 'fetched',
        outcome: 'committed',
        before: { desiredCommitSha: null },
        after: { desiredCommitSha: args.commitSha },
      }));

      this.store().insertGeneration(args.generation);
      this.store().insertCreateCheckpoint({ ...args.checkpoint, generation_id: args.generation.id });

      app.candidate_generation_id = args.generation.id;
      app.candidate_plan_blocked = 0;
      app.review_required = 0;
      app.latest_operation_id = args.envelope.operationId;
      app.updated_at = args.envelope.at;
      this.writeApplication(app);
      target.candidate_generation_id = args.generation.id;
      target.updated_at = args.envelope.at;
      this.store().upsertTarget(target);
      pushHistory(this.history(app, args.envelope, {
        stage: 'candidate_ready',
        outcome: 'committed',
        generationId: args.generation.id,
        before: { candidateGenerationId: null },
        after: { candidateGenerationId: args.generation.id, reviewRequired: false },
      }));

      return { historyIds, replayed: historyIds.length === 0 };
    })();
  }

  /**
   * Tear down a create that never reached `applied`.
   *
   * Callers must have already removed this operation's files. Filesystem work
   * cannot join a SQLite transaction, so ordering it first is what keeps the
   * two consistent: if cleanup fails, the caller leaves the checkpoint in place
   * and never calls this, and the next boot retries from the crash matrix.
   */
  createFailed(applicationId: string, failureClass: string, envelope: EventEnvelope): TransitionResult {
    return this.raw().transaction(() => {
      const app = this.requireApp(applicationId);
      if (app.lifecycle_status !== 'creating') {
        throw new GitOpsTransitionError('create_failed requires a creating application');
      }
      app.failure_stage = 'create';
      app.failure_class = failureClass;
      app.failure_at = envelope.at;
      app.lifecycle_status = 'deleted';
      this.clearActive(app);
      app.latest_operation_id = envelope.operationId;
      app.updated_at = envelope.at;
      this.writeApplication(app);

      for (const target of this.store().listTargets(app.id)) {
        target.target_status = 'tombstoned';
        this.clearTargetActive(target);
        target.failure_stage = null;
        target.failure_class = null;
        target.failure_at = null;
        target.lkg_generation_id = null;
        target.lkg_artifact_set_id = null;
        target.lkg_unavailable_at = null;
        target.lkg_unavailable_reason = null;
        target.updated_at = envelope.at;
        this.store().upsertTarget(target);
      }

      this.store().deleteCreateCheckpoint(app.id);
      const id = this.history(app, envelope, {
        stage: 'create_failed',
        outcome: 'failed',
        before: { lifecycleStatus: 'creating' },
        after: { lifecycleStatus: 'deleted', failureClass },
      });
      return { historyIds: id ? [id] : [], replayed: !id };
    })();
  }

  recordArtifactEvidence(args: {
    applicationId: string;
    generationId: string;
    artifactSetId: string;
    evidenceVersion: number;
    qualification: ArtifactQualification;
    evidenceJson: string;
    authoritative: number;
    envelope: EventEnvelope;
  }): TransitionResult {
    return this.mutateApp(args.applicationId, args.envelope, 'artifact_evidence_recorded', 'committed', (app) => {
      if (args.authoritative !== 0) {
        throw new GitOpsTransitionError('artifact rows must be non-authoritative until qualification is accepted');
      }
      const generation = this.requireOwnedGeneration(app.id, args.generationId);
      const evidence = decodeArtifactEvidenceJson(args.evidenceJson);
      if (evidence.kind !== args.qualification) {
        throw new GitOpsTransitionError('qualification must match evidence_json.kind');
      }
      const maxRow = this.raw().prepare(
        'SELECT MAX(evidence_version) AS max FROM gitops_artifact_sets WHERE generation_id = ?',
      ).get(args.generationId) as { max: number | null };
      const expectedVersion = (maxRow.max ?? 0) + 1;
      if (args.evidenceVersion !== expectedVersion) {
        throw new GitOpsTransitionError('evidenceVersion must be max+1');
      }
      const loadedAppExpected = app.artifact_set_id;
      this.store().insertArtifactSet({
        id: args.artifactSetId,
        generation_id: generation.id,
        evidence_version: args.evidenceVersion,
        authoritative: 0,
        qualification: args.qualification,
        evidence_json: args.evidenceJson,
        created_at: args.envelope.at,
      });
      // Pointer advancement is decided from the values loaded at the top of
      // this transaction, never from evidenceVersion-1: intervening unaccepted
      // rows must not block the first real resolution. Write serialization
      // comes from the enclosing synchronous SQLite transaction.
      if (app.accepted_generation_id === args.generationId) {
        app.latest_artifact_set_id = args.artifactSetId;
        if (this.allowedExpectedAdvance(loadedAppExpected, args.qualification)) {
          app.artifact_set_id = args.artifactSetId;
        }
      }
      this.forEachLiveDirectTarget(app, (target) => {
        if (target.desired_generation_id !== args.generationId) return;
        const loadedExpected = target.expected_artifact_set_id;
        target.latest_artifact_set_id = args.artifactSetId;
        if (this.allowedExpectedAdvance(loadedExpected, args.qualification)) {
          target.expected_artifact_set_id = args.artifactSetId;
        }
        this.store().upsertTarget(target);
      });
    }, { generationId: args.generationId, artifactSetId: args.artifactSetId });
  }

  deployStarted(applicationId: string, nodeId: number, generationId: string, envelope: EventEnvelope): TransitionResult {
    return this.mutateTarget(applicationId, nodeId, envelope, 'deploy_started', generationId, (target) => {
      if (target.target_status !== 'active') throw new GitOpsTransitionError('target not found');
      if (target.applied_generation_id !== generationId) {
        throw new GitOpsTransitionError('deploy generation is not applied');
      }
      if (target.active_operation_stage && target.active_operation_id !== envelope.operationId) {
        throw new GitOpsTransitionError('conflicting target operation');
      }
      const before = { deployedGenerationId: target.deployed_generation_id };
      target.active_operation_id = envelope.operationId;
      target.active_operation_stage = 'deploy_started';
      target.active_operation_at = envelope.at;
      target.active_generation_id = generationId;
      this.clearTargetInterruption(target, 'deploy_started');
      return { before, after: { activeGenerationId: generationId } };
    });
  }

  deployBound(applicationId: string, nodeId: number, generationId: string, envelope: EventEnvelope): TransitionResult {
    return this.mutateTarget(applicationId, nodeId, envelope, 'deploy_bound', generationId, (target) => {
      if (target.target_status !== 'active') {
        throw new GitOpsTransitionError('cannot bind a deploy on a tombstoned target');
      }
      this.requireMatchingDeploy(target, generationId, envelope);
      target.deployed_generation_id = generationId;
      this.clearTargetActive(target);
      if (target.failure_stage === 'deploy') {
        target.failure_stage = null;
        target.failure_class = null;
        target.failure_at = null;
      }
      this.clearTargetInterruption(target, 'deploy_started');
      return { before: {}, after: { deployedGenerationId: generationId } };
    });
  }

  /**
   * The deploy ran but Compose did not bind the generation to the workload.
   *
   * Deployed does not move: the previous workload is what is still running, and
   * claiming otherwise would make health and rollback reason about a generation
   * that was never live.
   */
  deployUnbound(applicationId: string, nodeId: number, generationId: string, envelope: EventEnvelope): TransitionResult {
    return this.mutateTarget(applicationId, nodeId, envelope, 'deploy_unbound', generationId, (target) => {
      this.requireMatchingDeploy(target, generationId, envelope);
      this.clearTargetActive(target);
      target.failure_stage = 'deploy';
      target.failure_class = 'unbound';
      target.failure_at = envelope.at;
      this.clearTargetInterruption(target, 'deploy_started');
      return {
        before: { deployedGenerationId: target.deployed_generation_id },
        after: { failureClass: 'unbound' },
      };
    }, 'failed');
  }

  /**
   * The deploy failed outright.
   *
   * `pre_mutation` means the workload was never touched, `post_mutation` means
   * it was. The deriver reports those differently because only one of them
   * leaves the previous workload intact, so the caller must classify honestly
   * from whether the mutation was handed off.
   */
  deployFailed(
    applicationId: string,
    nodeId: number,
    failureClass: 'pre_mutation' | 'post_mutation',
    envelope: EventEnvelope,
  ): TransitionResult {
    return this.mutateTarget(applicationId, nodeId, envelope, 'deploy_failed', null, (target) => {
      this.clearTargetActive(target);
      target.failure_stage = 'deploy';
      target.failure_class = failureClass;
      target.failure_at = envelope.at;
      this.clearTargetInterruption(target, 'deploy_started');
      return {
        before: { deployedGenerationId: target.deployed_generation_id },
        after: { failureClass },
      };
    }, 'failed');
  }

  /**
   * A health gate reached a verdict on a deployed generation.
   *
   * Promotion is deliberately narrow. Healthy and last-known-good move only
   * when the run passed, it observed the whole stack, and the generation it
   * watched is still the one deployed. A run that observed generation A cannot
   * vouch for B, so a stale verdict records history and moves nothing.
   *
   * Last-known-good keeps the artifact expectation only when that expectation
   * belongs to the generation being promoted. Otherwise the generation is still
   * good, its executable identity just is not proven, so the artifact pointer is
   * left null rather than borrowed from a different generation.
   */
  healthFinalized(args: {
    applicationId: string;
    nodeId: number;
    healthRunId: string;
    healthStatus: 'passed' | 'failed' | 'unknown';
    deployedGenerationId: string | null;
    targetScope: 'stack' | 'service';
    envelope: EventEnvelope;
  }): TransitionResult {
    return this.mutateTarget(
      args.applicationId,
      args.nodeId,
      args.envelope,
      'health_finalized',
      args.deployedGenerationId,
      (target) => {
        const before = {
          healthyGenerationId: target.healthy_generation_id,
          lkgGenerationId: target.lkg_generation_id,
        };
        const promotable = args.healthStatus === 'passed'
          && target.target_status === 'active'
          && args.targetScope === 'stack'
          && !!args.deployedGenerationId
          && target.deployed_generation_id === args.deployedGenerationId;
        if (!promotable) {
          return { before, after: { ...before, promoted: false, healthStatus: args.healthStatus } };
        }

        const generationId = args.deployedGenerationId as string;
        target.healthy_generation_id = generationId;
        target.lkg_generation_id = generationId;

        const expected = target.expected_artifact_set_id
          ? this.store().getArtifactSet(target.expected_artifact_set_id)
          : undefined;
        target.lkg_artifact_set_id = expected && expected.generation_id === generationId
          ? expected.id
          : null;
        // A generation that just passed is available again, whatever made the
        // previous one unavailable.
        target.lkg_unavailable_at = null;
        target.lkg_unavailable_reason = null;

        return {
          before,
          after: {
            healthyGenerationId: generationId,
            lkgGenerationId: generationId,
            lkgArtifactSetId: target.lkg_artifact_set_id,
            promoted: true,
          },
        };
      },
      args.healthStatus === 'unknown' ? 'unknown' : 'committed',
    );
  }

  /**
   * Retire an application. Tombstones never reactivate.
   *
   * Configured identity and SHA pointers are kept as frozen facts so the
   * projection can still say what this application was, and a reattach must
   * mint a new application id rather than reviving this row.
   */
  applicationTombstoned(
    applicationId: string,
    lifecycleStatus: 'deleted' | 'detached',
    envelope: EventEnvelope,
  ): TransitionResult {
    return this.mutateApp(applicationId, envelope, 'application_tombstoned', 'committed', (app) => {
      if (app.lifecycle_status === 'deleted' || app.lifecycle_status === 'detached') {
        throw new GitOpsTransitionError('application is already tombstoned');
      }
      app.lifecycle_status = lifecycleStatus;
      this.clearActive(app);
      app.failure_stage = null;
      app.failure_class = null;
      app.failure_at = null;
    });
  }

  /** Retire one target, clearing its last-known-good along with its operation state. */
  targetTombstoned(applicationId: string, nodeId: number, envelope: EventEnvelope): TransitionResult {
    return this.mutateTarget(applicationId, nodeId, envelope, 'target_tombstoned', null, (target) => {
      const before = { targetStatus: target.target_status };
      target.target_status = 'tombstoned';
      this.clearTargetActive(target);
      target.failure_stage = null;
      target.failure_class = null;
      target.failure_at = null;
      target.lkg_generation_id = null;
      target.lkg_artifact_set_id = null;
      target.lkg_unavailable_at = null;
      target.lkg_unavailable_reason = null;
      return { before, after: { targetStatus: 'tombstoned' } };
    });
  }

  /**
   * Schedule a retry after a failed fetch.
   *
   * The failure stays visible: a scheduled retry is a plan, not a resolution,
   * and hiding the failure behind it would make a stack that keeps failing look
   * merely busy. `fetch_started` clears the schedule when the retry runs.
   */
  sourceRetryScheduled(
    applicationId: string,
    retryAt: number,
    retryCount: number,
    envelope: EventEnvelope,
  ): TransitionResult {
    return this.mutateApp(applicationId, envelope, 'source_retry_scheduled', 'committed', (app) => {
      if (app.suspended_at) throw new GitOpsTransitionError('source is suspended');
      if (app.active_operation_stage) {
        throw new GitOpsTransitionError('cannot schedule a retry while an operation is in flight');
      }
      app.retry_at = retryAt;
      app.retry_count = retryCount;
    });
  }

  /**
   * Stop acting on a source without forgetting anything about it.
   *
   * Suspension is a decision about future work, so every success pointer stays
   * exactly where it is. An operation in flight is interrupted rather than
   * abandoned, so it does not report as running for ever.
   */
  sourceSuspended(applicationId: string, reason: string, envelope: EventEnvelope): TransitionResult {
    return this.mutateApp(applicationId, envelope, 'source_suspended', 'committed', (app, extras) => {
      if (app.lifecycle_status !== 'active') throw new GitOpsTransitionError('source is not live');
      if (app.active_operation_stage) {
        const interrupted = this.interruptActiveOperations(applicationId, envelope);
        extras.historyIds.push(...interrupted.historyIds);
        const reloaded = this.requireApp(applicationId);
        app.interruption_stage = reloaded.interruption_stage;
        app.interruption_at = reloaded.interruption_at;
        app.interruption_operation_id = reloaded.interruption_operation_id;
        app.interruption_generation_id = reloaded.interruption_generation_id;
        this.clearActive(app);
      }
      app.suspended_at = envelope.at;
      app.source_suspended_reason = reason;
    });
  }

  /** Resume acting on a source. Does not fetch: the operator decides when. */
  sourceUnsuspended(applicationId: string, envelope: EventEnvelope): TransitionResult {
    return this.mutateApp(applicationId, envelope, 'source_unsuspended', 'committed', (app) => {
      if (!app.suspended_at) throw new GitOpsTransitionError('source is not suspended');
      app.suspended_at = null;
      app.source_suspended_reason = null;
    });
  }

  /**
   * Pause a rollout, application-wide or on one target.
   *
   * A pause says nothing about health: whatever was deployed is still deployed,
   * and treating a paused rollout as converged is the misreading this guards.
   */
  rolloutPaused(
    applicationId: string,
    nodeId: number | null,
    reason: string,
    envelope: EventEnvelope,
  ): TransitionResult {
    if (nodeId === null) {
      return this.mutateApp(applicationId, envelope, 'rollout_paused', 'committed', (app) => {
        if (app.lifecycle_status !== 'active') throw new GitOpsTransitionError('application is not live');
        app.pause_at = envelope.at;
        app.pause_reason = reason;
      });
    }
    return this.mutateTarget(applicationId, nodeId, envelope, 'rollout_paused', null, (target) => {
      if (target.target_status !== 'active') throw new GitOpsTransitionError('target is tombstoned');
      const before = { pauseAt: target.pause_at };
      target.pause_at = envelope.at;
      target.pause_reason = reason;
      return { before, after: { pauseAt: envelope.at, pauseReason: reason } };
    });
  }

  rolloutUnpaused(applicationId: string, nodeId: number | null, envelope: EventEnvelope): TransitionResult {
    if (nodeId === null) {
      return this.mutateApp(applicationId, envelope, 'rollout_unpaused', 'committed', (app) => {
        if (!app.pause_at) throw new GitOpsTransitionError('application is not paused');
        app.pause_at = null;
        app.pause_reason = null;
      });
    }
    return this.mutateTarget(applicationId, nodeId, envelope, 'rollout_unpaused', null, (target) => {
      if (!target.pause_at) throw new GitOpsTransitionError('target is not paused');
      const before = { pauseAt: target.pause_at };
      target.pause_at = null;
      target.pause_reason = null;
      return { before, after: { pauseAt: null } };
    });
  }

  /**
   * Record that a rollout reached some targets and not others.
   *
   * The partial record is descriptive only. It never stands in for a deployed
   * pointer: those move per target, from the deploy events, or not at all.
   */
  partiallyRolledOut(
    applicationId: string,
    nodeId: number | null,
    partialJson: string,
    envelope: EventEnvelope,
  ): TransitionResult {
    decodeGitOpsJson(partialJson);
    if (nodeId === null) {
      return this.mutateApp(applicationId, envelope, 'partially_rolled_out', 'committed', (app) => {
        app.partial_json = partialJson;
      });
    }
    return this.mutateTarget(applicationId, nodeId, envelope, 'partially_rolled_out', null, (target) => {
      const before = { partial: target.partial_json !== null };
      target.partial_json = partialJson;
      return { before, after: { partial: true } };
    });
  }

  /**
   * A Blueprint's effective source state changed, so a new intent describes it.
   *
   * Minting is the caller's decision, not this transition's: a no-op edit must
   * mint nothing, because every later comparison is against the intent that is
   * current, and a fresh id for an unchanged Blueprint would invalidate
   * acknowledgements that are still accurate.
   */
  intentRevised(args: {
    applicationId: string;
    intent: GitOpsIntentRevisionRow;
    envelope: EventEnvelope;
  }): TransitionResult {
    return this.mutateApp(args.applicationId, args.envelope, 'intent_revised', 'committed', (app) => {
      if (app.lifecycle_status !== 'active') throw new GitOpsTransitionError('application is not live');
      if (args.intent.application_id !== args.applicationId) {
        throw new GitOpsTransitionError('intent belongs to another application');
      }
      this.store().insertIntentRevision(args.intent);
      app.intent_revision_id = args.intent.id;
    });
  }

  /**
   * Open a rollout candidate for an intent and the nodes it must reach.
   *
   * Carries candidate-time facts only. Approval and preflight identities are
   * composed later from their own rows, so a candidate can be opened before
   * anything has authorized it without implying that anything has.
   */
  rolloutCandidateOpened(args: {
    applicationId: string;
    candidate: GitOpsRolloutCandidateRow;
    envelope: EventEnvelope;
  }): TransitionResult {
    return this.mutateApp(args.applicationId, args.envelope, 'rollout_candidate_opened', 'committed', (app) => {
      if (app.lifecycle_status !== 'active') throw new GitOpsTransitionError('application is not live');
      if (args.candidate.application_id !== args.applicationId) {
        throw new GitOpsTransitionError('candidate belongs to another application');
      }
      if (args.candidate.intent_revision_id !== app.intent_revision_id) {
        throw new GitOpsTransitionError('candidate does not name the current intent');
      }
      this.store().insertRolloutCandidate(args.candidate);
      app.rollout_candidate_id = args.candidate.id;
    });
  }

  /**
   * A Blueprint deploy was handed to one node.
   *
   * The intent and candidate it was launched for are recorded on the target, so
   * the acknowledgement can be matched against what was actually requested. A
   * later intent supersedes this one, and an ack that arrives for the older
   * request is then ignored rather than accepted as current.
   */
  blueprintDeployStarted(args: {
    applicationId: string;
    nodeId: number;
    intentRevisionId: string;
    rolloutCandidateId: string | null;
    envelope: EventEnvelope;
  }): TransitionResult {
    return this.mutateTarget(
      args.applicationId,
      args.nodeId,
      args.envelope,
      'blueprint_deploy_started',
      null,
      (target) => {
        // An explicit deploy re-opens a placement the model had severed. The
        // reconciler never starts one of these (it skips severed nodes), so a
        // start arriving here for a tombstoned target is a deliberate request
        // for this node, and the revival rides the same recorded event rather
        // than surfacing as a refusal the physical deploy would ignore.
        const before = {
          activeStage: target.active_operation_stage,
          targetStatus: target.target_status,
        };
        target.target_status = 'active';
        // A newer deploy supersedes an older one, which is how a redeploy of a
        // stuck request takes over. Anything else in flight is a different
        // operation, and displacing it would abandon it with no terminal event.
        if (
          target.active_operation_stage
          && target.active_operation_stage !== 'blueprint_deploy_started'
          && target.active_operation_id !== args.envelope.operationId
        ) {
          throw new GitOpsTransitionError('conflicting target operation');
        }
        target.active_operation_id = args.envelope.operationId;
        target.active_operation_stage = 'blueprint_deploy_started';
        target.active_operation_at = args.envelope.at;
        target.active_intent_revision_id = args.intentRevisionId;
        target.active_rollout_candidate_id = args.rolloutCandidateId;
        // This start supersedes an interrupted one, which would otherwise keep
        // matching terminals and report completion_unknown for ever.
        this.clearTargetInterruption(target, 'blueprint_deploy_started');
        return {
          before,
          after: {
            activeStage: 'blueprint_deploy_started',
            intentRevisionId: args.intentRevisionId,
            targetStatus: 'active',
          },
        };
      },
    );
  }

  /**
   * A node acknowledged the Blueprint deploy it was given.
   *
   * Accepted only for the identity the deploy was launched with, live or
   * interrupted. An ack naming a superseded intent is a statement about work
   * that no longer describes what is wanted, and recording it would report the
   * node as converged on something it is not running.
   */
  blueprintAckRecorded(args: {
    applicationId: string;
    nodeId: number;
    intentRevisionId: string;
    rolloutCandidateId: string | null;
    legacyAppliedRevision: number | null;
    envelope: EventEnvelope;
  }): TransitionResult {
    return this.mutateTarget(
      args.applicationId,
      args.nodeId,
      args.envelope,
      'blueprint_ack_recorded',
      null,
      (target) => {
        const request = this.matchBlueprintRequest(
          target, 'blueprint_deploy_started', args.intentRevisionId, 'acknowledge',
        );
        if (args.rolloutCandidateId !== request.rolloutCandidateId) {
          throw new GitOpsTransitionError('acknowledged candidate is not the one deployed');
        }
        const before = { intentRevisionId: target.intent_revision_id };
        this.clearTargetActive(target);
        this.clearTargetInterruption(target, 'blueprint_deploy_started');
        target.intent_revision_id = args.intentRevisionId;
        // From the matched request, never from the payload: the two can name
        // different sides, and pairing one request's intent with another's
        // candidate is the exact misattribution this guards.
        target.rollout_candidate_id = request.rolloutCandidateId;
        // Display only. The acknowledged identity is the intent, never this.
        target.legacy_applied_revision = args.legacyAppliedRevision;
        if (target.failure_stage === 'blueprint_deploy') {
          target.failure_stage = null;
          target.failure_class = null;
          target.failure_at = null;
        }
        return { before, after: { intentRevisionId: args.intentRevisionId } };
      },
    );
  }

  /** A Blueprint deploy failed. Acknowledgement pointers stay where they were. */
  blueprintDeployFailed(args: {
    applicationId: string;
    nodeId: number;
    failureClass: string;
    envelope: EventEnvelope;
  }): TransitionResult {
    return this.mutateTarget(
      args.applicationId,
      args.nodeId,
      args.envelope,
      'blueprint_deploy_failed',
      null,
      (target) => {
        const before = { failureStage: target.failure_stage };
        this.clearTargetActive(target);
        this.clearTargetInterruption(target, 'blueprint_deploy_started');
        target.failure_stage = 'blueprint_deploy';
        target.failure_class = args.failureClass;
        target.failure_at = args.envelope.at;
        return { before, after: { failureStage: 'blueprint_deploy', failureClass: args.failureClass } };
      },
      'failed',
    );
  }

  /**
   * A Blueprint deployment is being removed from one node.
   *
   * The intent recorded here is the one currently acknowledged, the thing being
   * taken away, not a later replacement. Withdrawing is finished only against
   * that same id.
   */
  blueprintWithdrawStarted(args: {
    applicationId: string;
    nodeId: number;
    intentRevisionId: string;
    envelope: EventEnvelope;
  }): TransitionResult {
    return this.mutateTarget(
      args.applicationId,
      args.nodeId,
      args.envelope,
      'blueprint_withdraw_started',
      null,
      (target) => {
        if (target.target_status !== 'active') {
          throw new GitOpsTransitionError('cannot withdraw from a tombstoned target');
        }
        if (target.active_operation_stage && target.active_operation_id !== args.envelope.operationId) {
          throw new GitOpsTransitionError('conflicting target operation');
        }
        const before = { activeStage: target.active_operation_stage };
        target.active_operation_id = args.envelope.operationId;
        target.active_operation_stage = 'blueprint_withdraw_started';
        target.active_operation_at = args.envelope.at;
        target.active_intent_revision_id = args.intentRevisionId;
        this.clearTargetInterruption(target, 'blueprint_withdraw_started');
        return { before, after: { activeStage: 'blueprint_withdraw_started' } };
      },
    );
  }

  /** The deployment is gone from this node, so the target stops claiming it. */
  blueprintWithdrawn(args: {
    applicationId: string;
    nodeId: number;
    intentRevisionId: string;
    envelope: EventEnvelope;
  }): TransitionResult {
    return this.mutateTarget(
      args.applicationId,
      args.nodeId,
      args.envelope,
      'blueprint_withdrawn',
      null,
      (target) => {
        this.matchBlueprintRequest(
          target, 'blueprint_withdraw_started', args.intentRevisionId, 'withdraw',
        );
        const before = { targetStatus: target.target_status };
        this.clearTargetActive(target);
        this.clearTargetInterruption(target, 'blueprint_withdraw_started');
        target.target_status = 'tombstoned';
        target.failure_stage = null;
        target.failure_class = null;
        target.failure_at = null;
        return { before, after: { targetStatus: 'tombstoned' } };
      },
    );
  }

  /** A withdraw failed, which is a different state from a deploy that failed. */
  blueprintWithdrawFailed(args: {
    applicationId: string;
    nodeId: number;
    failureClass: string;
    envelope: EventEnvelope;
  }): TransitionResult {
    return this.mutateTarget(
      args.applicationId,
      args.nodeId,
      args.envelope,
      'blueprint_withdraw_failed',
      null,
      (target) => {
        const before = { failureStage: target.failure_stage };
        this.clearTargetActive(target);
        this.clearTargetInterruption(target, 'blueprint_withdraw_started');
        target.failure_stage = 'blueprint_withdraw';
        target.failure_class = args.failureClass;
        target.failure_at = args.envelope.at;
        return { before, after: { failureStage: 'blueprint_withdraw', failureClass: args.failureClass } };
      },
      'failed',
    );
  }

  /**
   * The reconciler observed something worth recording against a target.
   *
   * History, plus the runtime status derived from the recorded stage. None of
   * these mints an intent or a candidate, and none acknowledges anything: they
   * say what was seen, not what was decided.
   */
  blueprintObservation(args: {
    applicationId: string;
    nodeId: number;
    stage: BlueprintObservationStage;
    envelope: EventEnvelope;
  }): TransitionResult {
    return this.mutateTarget(
      args.applicationId,
      args.nodeId,
      args.envelope,
      args.stage,
      null,
      (target) => {
        if (target.target_status !== 'active') {
          throw new GitOpsTransitionError('cannot observe a tombstoned target');
        }
        // The runtime facet projects these four stages, which is the only route
        // an observation has into the derived status: the reconciler records
        // what it saw rather than moving any pointer. The history row written
        // alongside is the separate, unprojected record. `mutateTarget` stamps
        // the stage.
        const before = { latestStage: target.latest_stage };
        return { before, after: { observed: args.stage } };
      },
    );
  }

  /**
   * The intent a Blueprint request was launched against, live or interrupted.
   *
   * A terminal event has to match what was actually requested. Accepting one
   * that names a superseded intent would report a node as converged on an
   * intent nobody asked it for.
   */
  private matchBlueprintRequest(
    target: GitOpsTargetCurrentRow,
    expectedStage: 'blueprint_deploy_started' | 'blueprint_withdraw_started',
    intentRevisionId: string,
    what: string,
  ): { rolloutCandidateId: string | null } {
    // Stage and identity have to come from the same side. Matching an id
    // against one request while a different one is in flight is what would let
    // a deploy be acknowledged out of a withdraw, or one request's intent be
    // paired with another's candidate.
    if (
      target.active_operation_stage === expectedStage
      && target.active_intent_revision_id === intentRevisionId
    ) {
      return { rolloutCandidateId: target.active_rollout_candidate_id };
    }
    if (
      target.interruption_stage === expectedStage
      && target.interruption_intent_revision_id === intentRevisionId
    ) {
      return { rolloutCandidateId: target.interruption_rollout_candidate_id };
    }
    throw new GitOpsTransitionError(
      `cannot ${what} an intent this target was not asked to run`,
    );
  }

  /**
   * A rollout-scoped rollback started.
   *
   * The same columns and the same rules as `recovery_started`; only the trigger
   * differs. Direct Git recovery emits the `recovery_*` names, and a later
   * rollout producer emits these. Nothing in this PR writes them.
   */
  rollbackInProgress(args: {
    applicationId: string;
    nodeId: number | null;
    recoveryRef: string;
    recoveryGenerationId: string | null;
    envelope: EventEnvelope;
  }): TransitionResult {
    if (args.nodeId === null) {
      return this.mutateApp(args.applicationId, args.envelope, 'rollback_in_progress', 'committed', (app) => {
        if (app.lifecycle_status !== 'active') throw new GitOpsTransitionError('application is not live');
        app.recovery_phase = 'restoring';
        app.recovery_ref = args.recoveryRef;
      });
    }
    return this.mutateTarget(
      args.applicationId,
      args.nodeId,
      args.envelope,
      'rollback_in_progress',
      args.recoveryGenerationId,
      (target) => {
        if (target.target_status !== 'active') {
          throw new GitOpsTransitionError('cannot roll back a tombstoned target');
        }
        const before = { recoveryPhase: target.recovery_phase };
        target.recovery_phase = 'restoring';
        target.recovery_ref = args.recoveryRef;
        target.recovery_generation_id = args.recoveryGenerationId;
        this.withApplication(args.applicationId, args.envelope, (app) => {
          app.recovery_phase = 'restoring';
          app.recovery_ref = args.recoveryRef;
        });
        return { before, after: { recoveryPhase: 'restoring', recoveryRef: args.recoveryRef } };
      },
    );
  }

  /**
   * A rollout-scoped rollback failed, wholly or on some targets.
   *
   * Persists the failure class it was given rather than deriving one, because
   * the projection reports these columns verbatim. `partial` is the class this
   * alias adds over `recovery_failed`: some targets came back and some did not,
   * which is neither of the recovery classes.
   */
  rollbackPartialFailed(args: {
    applicationId: string;
    nodeId: number | null;
    recoveryRef: string;
    failureClass: 'pre_mutation' | 'post_mutation' | 'partial';
    envelope: EventEnvelope;
  }): TransitionResult {
    const applyFailure = (row: {
      recovery_phase: string | null;
      recovery_ref: string | null;
      failure_stage: string | null;
      failure_class: string | null;
      failure_at: number | null;
    }): void => {
      row.recovery_phase = 'failed';
      row.recovery_ref = args.recoveryRef;
      row.failure_stage = 'recovery';
      row.failure_class = args.failureClass;
      row.failure_at = args.envelope.at;
    };

    if (args.nodeId === null) {
      return this.mutateApp(args.applicationId, args.envelope, 'rollback_partial_failed', 'failed', (app) => {
        applyFailure(app);
      });
    }
    return this.mutateTarget(
      args.applicationId,
      args.nodeId,
      args.envelope,
      'rollback_partial_failed',
      null,
      (target) => {
        const before = { recoveryPhase: target.recovery_phase, failureStage: target.failure_stage };
        applyFailure(target);
        return { before, after: { recoveryPhase: 'failed', failureClass: args.failureClass } };
      },
      'failed',
    );
  }

  /**
   * A rollout-scoped rollback finished and the target is back on its generation.
   *
   * Refuses without a generation it can prove, on the same rule as
   * `recovery_succeeded`: the target's own `recovery_generation_id` must name a
   * generation that still exists and belongs to this application. There is no
   * unproven variant, because a rollback nobody can bind to a generation has
   * nothing to complete against.
   */
  rollbackCompleted(args: {
    applicationId: string;
    nodeId: number;
    recoveryRef: string;
    capturedArtifactSetId: string | null;
    capturedSourceAcceptanceRef: string | null;
    envelope: EventEnvelope;
  }): TransitionResult {
    return this.mutateTarget(
      args.applicationId,
      args.nodeId,
      args.envelope,
      'rollback_completed',
      null,
      (target) => {
        const restored = target.recovery_generation_id;
        if (!restored) {
          throw new GitOpsTransitionError('rollback_completed requires a bound recovery generation');
        }
        const generation = this.store().getGeneration(restored);
        if (!generation || generation.application_id !== args.applicationId) {
          throw new GitOpsTransitionError('rollback_completed names a generation this application does not own');
        }

        const before = {
          desiredGenerationId: target.desired_generation_id,
          deployedGenerationId: target.deployed_generation_id,
          healthyGenerationId: target.healthy_generation_id,
        };
        this.clearTargetActive(target);
        target.recovery_phase = 'complete';
        target.recovery_ref = args.recoveryRef;
        if (target.failure_stage === 'recovery') {
          target.failure_stage = null;
          target.failure_class = null;
          target.failure_at = null;
        }
        this.withApplication(args.applicationId, args.envelope, (app) => {
          app.recovery_phase = 'complete';
          this.clearAppFailure(app, ['recovery']);
        });

        target.desired_generation_id = restored;
        target.applied_generation_id = restored;
        // A restored workload has not been observed healthy yet, whatever the
        // previous generation proved.
        target.healthy_generation_id = null;

        this.restoreArtifactPointers(target, restored, args.capturedArtifactSetId);
        this.restoreLastKnownGood(target, args.applicationId, args.envelope.at);
        this.restoreSourceAcceptance(target, args.applicationId, restored, args.capturedSourceAcceptanceRef);

        return {
          before,
          after: { desiredGenerationId: restored, deployedGenerationId: target.deployed_generation_id, healthyGenerationId: null },
        };
      },
      'recovered',
    );
  }

  partialCleared(applicationId: string, nodeId: number | null, envelope: EventEnvelope): TransitionResult {
    if (nodeId === null) {
      return this.mutateApp(applicationId, envelope, 'partial_cleared', 'committed', (app) => {
        if (!app.partial_json) throw new GitOpsTransitionError('application has no partial state');
        app.partial_json = null;
      });
    }
    return this.mutateTarget(applicationId, nodeId, envelope, 'partial_cleared', null, (target) => {
      if (!target.partial_json) throw new GitOpsTransitionError('target has no partial state');
      const before = { partial: true };
      target.partial_json = null;
      return { before, after: { partial: false } };
    });
  }

  /**
   * A restore is about to touch the filesystem.
   *
   * The recovery reference and the generation it intends to restore are made
   * durable before anything moves, so a crash mid-restore leaves a target that
   * says what it was doing rather than one that looks merely broken. Success
   * pointers are untouched here: nothing has been restored yet.
   */
  recoveryStarted(args: {
    applicationId: string;
    nodeId: number;
    recoveryRef: string;
    recoveryGenerationId: string | null;
    envelope: EventEnvelope;
  }): TransitionResult {
    return this.mutateTarget(
      args.applicationId,
      args.nodeId,
      args.envelope,
      'recovery_started',
      args.recoveryGenerationId,
      (target) => {
        if (target.target_status !== 'active') {
          throw new GitOpsTransitionError('cannot recover a tombstoned target');
        }
        const before = { recoveryPhase: target.recovery_phase };
        target.recovery_phase = 'restoring';
        target.recovery_ref = args.recoveryRef;
        target.recovery_generation_id = args.recoveryGenerationId;
        // The application carries the same phase so the source facet reports a
        // recovery in flight instead of whatever the source last did.
        this.withApplication(args.applicationId, args.envelope, (app) => {
          app.recovery_phase = 'restoring';
          app.recovery_ref = args.recoveryRef;
        });
        target.active_operation_id = args.envelope.operationId;
        target.active_operation_stage = 'recovery_started';
        target.active_operation_at = args.envelope.at;
        target.active_generation_id = args.recoveryGenerationId;
        return { before, after: { recoveryPhase: 'restoring', recoveryRef: args.recoveryRef } };
      },
    );
  }

  /**
   * A restore finished and the workload is back.
   *
   * `proven` is the whole question. It means the recovery row named a
   * generation, that generation still exists and belongs to this application,
   * and the restored files match it. Only then do pointers move, and they move
   * to the restored generation rather than to whatever the application has
   * since accepted: the target is running the old thing again, and saying
   * otherwise would make every later comparison wrong.
   *
   * An unproven restore is still a real operational recovery. It is recorded as
   * one and moves nothing, because there is no evidence to move pointers to.
   */
  recoverySucceeded(args: {
    applicationId: string;
    nodeId: number;
    recoveryRef: string;
    recoveryGenerationId: string | null;
    proven: boolean;
    gitopsBinding: 'bound' | 'unbound' | 'not_applicable' | 'service_only';
    capturedArtifactSetId: string | null;
    capturedSourceAcceptanceRef: string | null;
    envelope: EventEnvelope;
    /**
     * Claim a health run for this recovery, inside this transaction.
     *
     * Injected rather than reached for directly: the health gate reports its
     * verdicts back through this store, so importing it here would close a
     * module cycle. Called only for a recovery that both proved its generation
     * and bound the deployed pointer, because a run against an unproven restore
     * would be observing a generation nobody can name.
     */
    reserveHealthRun?: (deployedGenerationId: string) => HealthRunReservation;
  }): TransitionResult & { healthReservation: HealthRunReservation | null } {
    let healthReservation: HealthRunReservation | null = null;
    const result = this.mutateTarget(
      args.applicationId,
      args.nodeId,
      args.envelope,
      'recovery_succeeded',
      args.recoveryGenerationId,
      (target) => {
        const before = {
          desiredGenerationId: target.desired_generation_id,
          deployedGenerationId: target.deployed_generation_id,
          healthyGenerationId: target.healthy_generation_id,
        };
        this.clearTargetActive(target);
        target.recovery_phase = 'complete';
        if (target.failure_stage === 'recovery') {
          target.failure_stage = null;
          target.failure_class = null;
          target.failure_at = null;
        }
        this.withApplication(args.applicationId, args.envelope, (app) => {
          app.recovery_phase = 'complete';
          this.clearAppFailure(app, ['recovery']);
        });

        const generationId = args.recoveryGenerationId;
        const generation = generationId ? this.store().getGeneration(generationId) : undefined;
        const provable = args.proven
          && !!generationId
          && !!generation
          && generation.application_id === args.applicationId;
        if (!provable) {
          // Nothing moved, so every pointer still agrees with itself and the
          // target would otherwise read as healthy after a restore we could not
          // prove restored anything.
          this.noteTargetLimitation(
            target,
            'recovery_unproven',
            args.recoveryGenerationId ?? args.recoveryRef,
          );
          return { before, after: { ...before, proven: false } };
        }
        this.noteTargetLimitation(target, 'recovery_unproven', null);

        const restored = generationId as string;
        target.desired_generation_id = restored;
        target.applied_generation_id = restored;
        if (args.gitopsBinding === 'bound') target.deployed_generation_id = restored;
        // A restored workload has not been observed healthy yet, whatever the
        // previous generation proved.
        target.healthy_generation_id = null;

        this.restoreArtifactPointers(target, restored, args.capturedArtifactSetId);
        this.restoreLastKnownGood(target, args.applicationId, args.envelope.at);
        this.restoreSourceAcceptance(target, args.applicationId, restored, args.capturedSourceAcceptanceRef);

        if (args.gitopsBinding === 'bound' && args.reserveHealthRun) {
          healthReservation = args.reserveHealthRun(restored);
        }

        return {
          before,
          after: {
            desiredGenerationId: restored,
            deployedGenerationId: target.deployed_generation_id,
            healthyGenerationId: null,
            proven: true,
          },
        };
      },
      'recovered',
    );
    return { ...result, healthReservation };
  }

  /** A restore failed. Success pointers stay exactly where they were. */
  recoveryFailed(args: {
    applicationId: string;
    nodeId: number;
    recoveryRef: string;
    failureClass: 'pre_mutation' | 'post_mutation';
    envelope: EventEnvelope;
  }): TransitionResult {
    return this.mutateTarget(
      args.applicationId,
      args.nodeId,
      args.envelope,
      'recovery_failed',
      null,
      (target) => {
        const before = { recoveryPhase: target.recovery_phase };
        this.clearTargetActive(target);
        target.recovery_phase = 'failed';
        target.recovery_ref = args.recoveryRef;
        target.failure_stage = 'recovery';
        target.failure_class = args.failureClass;
        target.failure_at = args.envelope.at;
        this.withApplication(args.applicationId, args.envelope, (app) => {
          app.recovery_phase = 'failed';
          app.recovery_ref = args.recoveryRef;
          app.failure_stage = 'recovery';
          app.failure_class = args.failureClass;
          app.failure_at = args.envelope.at;
        });
        return { before, after: { recoveryPhase: 'failed', failureClass: args.failureClass } };
      },
      'failed',
    );
  }

  /**
   * Apply a change to the owning application inside the current transaction.
   *
   * Recovery state lives on both rows: the target says which node is being
   * restored, the application says the stack is in recovery at all. Writing
   * only one leaves the projection contradicting itself.
   */
  private withApplication(
    applicationId: string,
    envelope: EventEnvelope,
    mutate: (app: GitOpsApplicationRow) => void,
  ): void {
    const app = this.requireApp(applicationId);
    mutate(app);
    app.updated_at = envelope.at;
    this.writeApplication(app);
  }


  /**
   * Record, on the row itself, that a pointer was dropped because it could not
   * be proven.
   *
   * The deriver computes limitations it can re-derive from current rows. This
   * is for the ones only the writer knows: after the pointer is gone, "could
   * not prove it" and "there was never one" look identical. Passing null clears
   * the code, so a row that recovers its evidence stops reporting the old
   * limitation.
   */
  private noteTargetLimitation(
    target: GitOpsTargetCurrentRow,
    code: string,
    detail: string | null,
  ): void {
    const existing = decodeGitOpsEvidenceLimitations(target.evidence_limitations_json);
    target.evidence_limitations_json = encodeGitOpsEvidenceLimitations(
      existing,
      code,
      detail === null ? null : { code, detail },
    );
  }

  /**
   * Rebind the artifact expectation to the restored generation.
   *
   * The expectation comes from what the recovery point captured, never from
   * what the application expects now: those describe different generations
   * after a restore. Latest becomes the newest evidence for the restored
   * generation, which is a statement about what has been seen, not an
   * acceptance of it.
   */
  private restoreArtifactPointers(
    target: GitOpsTargetCurrentRow,
    generationId: string,
    capturedArtifactSetId: string | null,
  ): void {
    const captured = capturedArtifactSetId ? this.store().getArtifactSet(capturedArtifactSetId) : undefined;
    const usable = captured && captured.generation_id === generationId;
    target.expected_artifact_set_id = usable ? captured.id : null;
    // Dropping this silently would also disable the runtime artifact-drift
    // check for this target, so the projection would read healthier, not less
    // certain, than before the restore.
    this.noteTargetLimitation(
      target,
      'artifact_expectation_unprovable',
      capturedArtifactSetId && !usable ? capturedArtifactSetId : null,
    );

    const newest = this.raw().prepare(
      `SELECT id FROM gitops_artifact_sets
       WHERE generation_id = ?
       ORDER BY evidence_version DESC LIMIT 1`,
    ).get(generationId) as { id: string } | undefined;
    target.latest_artifact_set_id = newest?.id ?? target.expected_artifact_set_id;
  }

  /**
   * Decide what survives of the last-known-good after a restore.
   *
   * A last-known-good that still exists and still belongs to this application
   * is kept: restoring an older generation does not invalidate the knowledge
   * that some generation once passed. Only when that generation is gone, or
   * turns out to belong elsewhere, is the pointer cleared, and then the reason
   * is recorded so the projection can say "unavailable" rather than "none".
   */
  private restoreLastKnownGood(
    target: GitOpsTargetCurrentRow,
    applicationId: string,
    at: number,
  ): void {
    if (!target.lkg_generation_id) return;
    const lkg = this.store().getGeneration(target.lkg_generation_id);
    const reason = !lkg
      ? 'generation_missing'
      : lkg.application_id !== applicationId ? 'recovery_unretainable' : null;
    if (reason) {
      target.lkg_generation_id = null;
      target.lkg_artifact_set_id = null;
      target.lkg_unavailable_at = at;
      target.lkg_unavailable_reason = reason;
      return;
    }
    // The generation stands. Its captured artifact only stands with it.
    if (!target.lkg_artifact_set_id) return;
    const artifact = this.store().getArtifactSet(target.lkg_artifact_set_id);
    if (!artifact || artifact.generation_id !== target.lkg_generation_id) {
      // Without this the last-known-good silently drops from qualified to
      // merely available, which reads as "it never had qualifying evidence".
      this.noteTargetLimitation(target, 'lkg_artifact_unprovable', target.lkg_artifact_set_id);
      target.lkg_artifact_set_id = null;
    }
  }

  /**
   * Restore the acceptance that authorized the generation now running.
   *
   * Only a captured reference that still proves this exact generation is kept.
   * The application's current reference is never borrowed: it authorizes a
   * newer generation, and pointing it at this one would fabricate approval.
   */
  private restoreSourceAcceptance(
    target: GitOpsTargetCurrentRow,
    applicationId: string,
    generationId: string,
    capturedRef: string | null,
  ): void {
    if (!capturedRef) {
      target.source_acceptance_ref = null;
      this.noteTargetLimitation(target, 'source_acceptance_unprovable', null);
      return;
    }
    const resolved = this.store().resolveApprovalRef(capturedRef, {
      kind: 'source_acceptance',
      applicationId,
      generationId,
    });
    target.source_acceptance_ref = resolved ? capturedRef : null;
    // A workload running under an approval we can no longer prove is not the
    // same as one that was never approved, and the second reads better.
    this.noteTargetLimitation(
      target,
      'source_acceptance_unprovable',
      resolved ? null : capturedRef,
    );
  }

  /**
   * Retire every live target on a node that is going away.
   *
   * Must run before the node's rows are deleted, so the tombstones and their
   * history are written while the target rows still exist. Applications are
   * left alone: a Direct application whose only target was on this node still
   * describes a real stack, and a Blueprint application may have targets
   * elsewhere.
   */
  tombstoneNodeTargets(nodeId: number, envelope: EventEnvelope): TransitionResult {
    return this.raw().transaction(() => {
      const historyIds: string[] = [];
      for (const target of this.store().listActiveTargetsForNode(nodeId)) {
        const result = this.targetTombstoned(target.application_id, nodeId, envelope);
        historyIds.push(...result.historyIds);
      }
      return { historyIds, replayed: historyIds.length === 0 };
    })();
  }

  interruptActiveOperations(applicationId: string, envelope: EventEnvelope): TransitionResult {
    return this.raw().transaction(() => {
      const app = this.requireApp(applicationId);
      const historyIds: string[] = [];
      // A restore that never finished is not still running. Left alone, the
      // phase reports a live recovery for ever, because only the terminal
      // recovery events clear it and neither one is coming.
      const interruptedRecovery = app.recovery_phase === 'restoring' || app.recovery_phase === 'compensating';
      if (interruptedRecovery) {
        app.recovery_phase = 'failed';
        app.failure_stage = 'recovery';
        app.failure_class = 'interrupted';
        app.failure_at = envelope.at;
      }
      if (app.active_operation_stage || interruptedRecovery) {
        app.interruption_stage = app.active_operation_stage;
        app.interruption_at = envelope.at;
        app.interruption_operation_id = app.active_operation_id;
        app.interruption_generation_id = app.active_generation_id;
        this.clearActive(app);
        app.updated_at = envelope.at;
        this.writeApplication(app);
        const id = this.history(app, envelope, {
          stage: 'operation_interrupted',
          outcome: 'unknown',
          before: { interruptedStage: app.interruption_stage },
          after: { activeOperationStage: null },
        });
        if (id) historyIds.push(id);
      }
      for (const target of this.store().listTargets(applicationId)) {
        const targetRecoveryInterrupted = target.recovery_phase === 'restoring'
          || target.recovery_phase === 'compensating';
        if (!target.active_operation_stage && !targetRecoveryInterrupted) continue;
        if (targetRecoveryInterrupted) {
          target.recovery_phase = 'failed';
          target.failure_stage = 'recovery';
          target.failure_class = 'interrupted';
          target.failure_at = envelope.at;
        }
        target.interruption_stage = target.active_operation_stage;
        target.interruption_at = envelope.at;
        target.interruption_operation_id = target.active_operation_id;
        target.interruption_generation_id = target.active_generation_id;
        target.interruption_intent_revision_id = target.active_intent_revision_id;
        target.interruption_rollout_candidate_id = target.active_rollout_candidate_id;
        this.clearTargetActive(target);
        target.updated_at = envelope.at;
        this.store().upsertTarget(target);
        const id = this.history(app, envelope, {
          nodeId: target.node_id,
          stage: 'operation_interrupted',
          outcome: 'unknown',
          before: { interruptedStage: target.interruption_stage },
          after: { activeOperationStage: null },
        });
        if (id) historyIds.push(id);
      }
      return { historyIds, replayed: historyIds.length === 0 };
    })();
  }

  acceptArtifactExpectation(args: {
    applicationId: string;
    generationId: string;
    artifactSetId: string;
    envelope: EventEnvelope;
  }): TransitionResult {
    return this.mutateApp(args.applicationId, args.envelope, 'artifact_expectation_accepted', 'committed', (app) => {
      const artifact = this.store().getArtifactSet(args.artifactSetId);
      if (!artifact || artifact.generation_id !== args.generationId) {
        throw new GitOpsTransitionError('artifact set is not owned by the generation');
      }
      if (artifact.qualification !== 'exact' && artifact.qualification !== 'qualified') {
        throw new GitOpsTransitionError('only exact or qualified evidence can be accepted');
      }
      if (app.accepted_generation_id !== args.generationId) {
        throw new GitOpsTransitionError('application accepted generation does not match');
      }
      app.artifact_set_id = args.artifactSetId;
      this.forEachLiveDirectTarget(app, (target) => {
        if (target.desired_generation_id !== args.generationId) return;
        target.expected_artifact_set_id = args.artifactSetId;
        this.store().upsertTarget(target);
      });
    }, { generationId: args.generationId, artifactSetId: args.artifactSetId });
  }

  /**
   * Guard every precondition of `applied` and return the active targets the
   * acceptance has to bind.
   */
  /** Guard every application-level precondition of accepting a candidate. */
  private requireAcceptableCandidate(app: GitOpsApplicationRow, args: AppliedArgs): void {
    if (app.candidate_generation_id !== args.generationId) {
      throw new GitOpsTransitionError('applied generation is not the current candidate');
    }
    // The seed artifact row is always evidence_version 1, so re-accepting a
    // generation that is already accepted would collide on the version
    // uniqueness constraint. Reject it here as a domain error instead of
    // letting a raw driver error escape.
    if (app.accepted_generation_id === args.generationId) {
      throw new GitOpsTransitionError('generation is already accepted');
    }
    this.requireOwnedGeneration(app.id, args.generationId);
    if (app.active_operation_stage === 'apply_started') {
      if (app.active_generation_id !== args.generationId) {
        throw new GitOpsTransitionError('live apply is bound to a different generation');
      }
      if (app.active_operation_id && app.active_operation_id !== args.envelope.operationId) {
        throw new GitOpsTransitionError('live apply belongs to a different operation');
      }
    }
  }

  private acceptanceTargets(app: GitOpsApplicationRow, args: AppliedArgs): GitOpsTargetCurrentRow[] {
    this.requireAcceptableCandidate(app, args);
    const targets = this.store().listTargets(app.id).filter((row) => row.target_status === 'active');
    if (app.target_mode === 'direct') {
      for (const target of targets) {
        if (target.candidate_generation_id !== args.generationId) {
          throw new GitOpsTransitionError('direct target candidate does not match applied generation');
        }
      }
    }
    return targets;
  }

  /** The mode-neutral application-row mutation `applied` and `sourceAccepted` share. */
  private applySourceAcceptanceMutation(app: GitOpsApplicationRow, args: AppliedArgs): void {
    this.insertAcceptanceRecords(app, args);
    app.accepted_generation_id = args.generationId;
    app.artifact_set_id = args.artifactSetId;
    app.latest_artifact_set_id = args.artifactSetId;
    app.source_acceptance_ref = args.sourceAcceptanceId;
    app.candidate_generation_id = null;
    app.candidate_plan_blocked = 0;
    app.review_required = 0;
    if (args.activateCreating && app.lifecycle_status === 'creating') {
      app.lifecycle_status = 'active';
    }
    this.clearActive(app);
    this.clearAppFailure(app, ['apply', 'fetch', 'validation']);
    this.clearInterruption(app, 'apply_started');
  }

  /** The Direct-only target-row mutation `applied` and `targetApplied` share. */
  private applyTargetAcceptanceMutation(target: GitOpsTargetCurrentRow, args: AppliedArgs): void {
    target.desired_generation_id = args.generationId;
    target.applied_generation_id = args.generationId;
    target.expected_artifact_set_id = args.artifactSetId;
    target.latest_artifact_set_id = args.artifactSetId;
    target.source_acceptance_ref = args.sourceAcceptanceId;
    target.candidate_generation_id = null;
  }

  /** Seed the unresolved artifact row and the source acceptance this apply proves. */
  private insertAcceptanceRecords(app: GitOpsApplicationRow, args: AppliedArgs): void {
    const artifact: GitOpsArtifactSetRow = {
      id: args.artifactSetId,
      generation_id: args.generationId,
      evidence_version: 1,
      authoritative: 0,
      qualification: 'unresolved',
      evidence_json: encodeArtifactEvidenceJson({ kind: 'unresolved' }),
      created_at: args.envelope.at,
    };
    this.store().insertArtifactSet(artifact);
    this.store().insertApproval({
      id: args.sourceAcceptanceId,
      kind: 'source_acceptance',
      authority: args.authority,
      authoritative: 1,
      application_id: app.id,
      generation_id: args.generationId,
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
      actor: args.envelope.actor,
      created_at: args.envelope.at,
    });
  }

  /**
   * A terminal deploy event must name the operation it is settling.
   *
   * It matches either the live operation or, after a restart, the interruption
   * that operation left behind. A late result for a superseded operation is
   * rejected rather than allowed to move pointers a newer deploy now owns.
   */
  private requireMatchingDeploy(
    target: GitOpsTargetCurrentRow,
    generationId: string,
    envelope: EventEnvelope,
  ): void {
    const live = target.active_operation_stage === 'deploy_started'
      && target.active_generation_id === generationId
      && (!target.active_operation_id || target.active_operation_id === envelope.operationId);
    const interrupted = target.interruption_stage === 'deploy_started'
      && target.interruption_generation_id === generationId
      && (!target.interruption_operation_id || target.interruption_operation_id === envelope.operationId);
    if (!live && !interrupted) throw new GitOpsTransitionError('no matching deploy operation');
  }

  /** Record that a new candidate displaced the one already pending. */
  private supersedeCandidate(
    app: GitOpsApplicationRow,
    nextGenerationId: string,
    envelope: EventEnvelope,
    extras: { historyIds: string[] },
  ): void {
    if (!app.candidate_generation_id || app.candidate_generation_id === nextGenerationId) return;
    const superseded = this.history(app, envelope, {
      stage: 'candidate_superseded',
      outcome: 'superseded',
      generationId: app.candidate_generation_id,
      before: { candidateGenerationId: app.candidate_generation_id },
      after: { candidateGenerationId: nextGenerationId },
    });
    if (superseded) extras.historyIds.push(superseded);
  }

  private allowedExpectedAdvance(
    loadedExpectedId: string | null,
    qualification: ArtifactQualification,
  ): boolean {
    if (qualification !== 'exact' && qualification !== 'qualified') return false;
    if (!loadedExpectedId) return true;
    const loaded = this.store().getArtifactSet(loadedExpectedId);
    if (!loaded) return true;
    // An already-resolved expectation never advances here. A changed
    // executable identity is an explicit acceptance, not an implicit one, and
    // an identical identity is already the expectation.
    return loaded.qualification !== 'exact' && loaded.qualification !== 'qualified';
  }

  private mutateApp(
    applicationId: string,
    envelope: EventEnvelope,
    stage: GitOpsHistoryStage,
    outcome: HistoryOutcome,
    mutate: (app: GitOpsApplicationRow, extras: { historyIds: string[] }) => void,
    extraHistory: {
      generationId?: string;
      artifactSetId?: string;
      sourceAcceptanceRef?: string;
    } = {},
  ): TransitionResult {
    return this.raw().transaction(() => {
      const app = this.store().getApplication(applicationId);
      if (!app) throw new GitOpsTransitionError('application not found');
      const before = snapshotApp(app);
      const extras = { historyIds: [] as string[] };
      mutate(app, extras);
      app.latest_operation_id = envelope.operationId;
      app.updated_at = envelope.at;
      this.writeApplication(app);
      const historyId = this.history(app, envelope, {
        stage,
        outcome,
        generationId: extraHistory.generationId,
        artifactSetId: extraHistory.artifactSetId,
        sourceAcceptanceRef: extraHistory.sourceAcceptanceRef,
        before,
        after: snapshotApp(app),
      });
      if (historyId) extras.historyIds.push(historyId);
      return { historyIds: extras.historyIds, replayed: extras.historyIds.length === 0 };
    })();
  }

  /**
   * The per-target counterpart of `mutateApp`. The mutator returns its own
   * history snapshots because each target stage records a different slice of
   * the row.
   */
  private mutateTarget(
    applicationId: string,
    nodeId: number,
    envelope: EventEnvelope,
    stage: GitOpsHistoryStage,
    generationId: string | null,
    mutate: (target: GitOpsTargetCurrentRow) => { before: Record<string, unknown>; after: Record<string, unknown> },
    outcome: HistoryOutcome = 'committed',
  ): TransitionResult {
    return this.raw().transaction(() => {
      const app = this.requireApp(applicationId);
      const target = this.store().getTarget(applicationId, nodeId);
      if (!target) throw new GitOpsTransitionError('target not found');
      const snapshots = mutate(target);
      // Stamped for every target mutation, not just the observations that are
      // projected from it. That is what makes an observation stop being the
      // latest thing that happened: a deploy, withdraw or tombstone after it
      // overwrites the stage, and the projection falls back to the pointers.
      // Set after `mutate` so a transition can still snapshot the prior value.
      //
      // Safe to stamp unconditionally only because a Blueprint target receives
      // Blueprint transitions and nothing else, so every write that lands here
      // genuinely answers the observation it replaces. The deploy, health and
      // recovery producers all resolve their application through
      // `getLiveDirectApplication`, which filters `target_mode = 'direct'` and
      // can never return a Blueprint one. A producer that reached a Blueprint
      // target by some other route would silently erase a drift the reconciler
      // will not re-record, because it only records an observation when the
      // deployment status moves.
      target.latest_stage = stage;
      target.updated_at = envelope.at;
      this.store().upsertTarget(target);
      const historyId = this.history(app, envelope, {
        nodeId,
        stage,
        outcome,
        generationId,
        before: snapshots.before,
        after: snapshots.after,
      });
      return { historyIds: historyId ? [historyId] : [], replayed: !historyId };
    })();
  }

  /**
   * Append one history row for this application, scoped to a node when
   * `nodeId` is given. The dedupe target follows that scope, so an
   * application-wide row and a per-node row of the same stage and operation do
   * not collide on the dedupe index.
   */
  private history(
    app: GitOpsApplicationRow,
    envelope: EventEnvelope,
    fields: {
      stage: GitOpsHistoryStage;
      outcome: HistoryOutcome;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      nodeId?: number;
      generationId?: string | null;
      artifactSetId?: string | null;
      sourceAcceptanceRef?: string | null;
    },
  ): string | null {
    const nodeId = fields.nodeId ?? null;
    return insertHistory(this.raw(), {
      application: app,
      nodeId,
      dedupeTarget: nodeId === null ? 'app' : `node:${nodeId}`,
      operationId: envelope.operationId,
      stage: fields.stage,
      outcome: fields.outcome,
      trigger: envelope.trigger,
      actor: envelope.actor,
      before: fields.before,
      after: fields.after,
      generationId: fields.generationId,
      artifactSetId: fields.artifactSetId,
      sourceAcceptanceRef: fields.sourceAcceptanceRef,
      at: envelope.at,
    });
  }

  private requireMatchingFetch(app: GitOpsApplicationRow, envelope: EventEnvelope): void {
    const live = app.active_operation_stage === 'fetch_started'
      && (!app.active_operation_id || app.active_operation_id === envelope.operationId);
    const interrupted = app.interruption_stage === 'fetch_started'
      && (!app.interruption_operation_id || app.interruption_operation_id === envelope.operationId);
    if (!live && !interrupted) throw new GitOpsTransitionError('no matching fetch operation');
  }

  private requireApp(applicationId: string): GitOpsApplicationRow {
    const app = this.store().getApplication(applicationId);
    if (!app) throw new GitOpsTransitionError('application not found');
    return app;
  }

  private requireOwnedGeneration(applicationId: string, generationId: string): GitOpsGenerationRow {
    const generation = this.store().getGeneration(generationId);
    if (!generation || generation.application_id !== applicationId) {
      throw new GitOpsTransitionError('generation is not owned by this application');
    }
    return generation;
  }

  private clearActive(app: GitOpsApplicationRow): void {
    app.active_operation_id = null;
    app.active_operation_stage = null;
    app.active_operation_at = null;
    app.active_generation_id = null;
  }

  private clearInterruption(app: GitOpsApplicationRow, stage: GitOpsApplicationRow['interruption_stage']): void {
    if (app.interruption_stage !== stage) return;
    app.interruption_stage = null;
    app.interruption_at = null;
    app.interruption_operation_id = null;
    app.interruption_generation_id = null;
  }

  /**
   * Release the in-flight operation, identity included.
   *
   * The identity columns go with the stage. Leaving them behind lets a later
   * start that sets only the stage resurrect a superseded intent as though it
   * were live, which is how an acknowledgement for work nobody asked for gets
   * accepted.
   */
  private clearTargetActive(target: GitOpsTargetCurrentRow): void {
    target.active_operation_id = null;
    target.active_operation_stage = null;
    target.active_operation_at = null;
    target.active_generation_id = null;
    target.active_intent_revision_id = null;
    target.active_rollout_candidate_id = null;
  }

  /**
   * Retire an interruption once its stage has reached a real outcome.
   *
   * Identity goes with it, for the same reason as above: an interruption that
   * outlives its resolution keeps matching, so a late terminal for the
   * interrupted request is still accepted after two later ones have succeeded.
   */
  private clearTargetInterruption(
    target: GitOpsTargetCurrentRow,
    stage: GitOpsTargetCurrentRow['interruption_stage'],
  ): void {
    if (target.interruption_stage !== stage) return;
    target.interruption_stage = null;
    target.interruption_at = null;
    target.interruption_operation_id = null;
    target.interruption_generation_id = null;
    target.interruption_intent_revision_id = null;
    target.interruption_rollout_candidate_id = null;
  }

  private clearAppFailure(app: GitOpsApplicationRow, stages: Array<NonNullable<GitOpsApplicationRow['failure_stage']>>): void {
    if (!app.failure_stage || !stages.includes(app.failure_stage)) return;
    app.failure_stage = null;
    app.failure_class = null;
    app.failure_at = null;
  }

  private forEachLiveDirectTarget(app: GitOpsApplicationRow, fn: (target: GitOpsTargetCurrentRow) => void): void {
    if (app.target_mode !== 'direct') return;
    for (const target of this.store().listTargets(app.id)) {
      if (target.target_status !== 'active') continue;
      fn(target);
    }
  }

  /**
   * Persist the mutable half of an application row.
   *
   * Every column a transition is allowed to change is written here. The mutator
   * callback receives the whole row, so a column missing from this UPDATE would
   * compile, appear in the history snapshot, and then be silently dropped at
   * commit. Only identity and provenance are excluded, because they are fixed
   * at insert: id, lifecycle_key, target_mode, stack_name, blueprint_id,
   * created_at.
   */
  private writeApplication(app: GitOpsApplicationRow): void {
    this.raw().prepare(
      `UPDATE gitops_applications SET
        lifecycle_status=?, configured_repo_url=?, repo_identity_json=?, configured_ref=?,
        compose_paths_json=?, context_dir=?, sync_env=?, env_path=?,
        materialization_fingerprint=?, desired_commit_sha=?, fetched_commit_sha=?,
        fetched_resolved_ref_kind=?, candidate_generation_id=?, accepted_generation_id=?, candidate_plan_blocked=?,
        review_required=?, artifact_set_id=?, latest_artifact_set_id=?,
        intent_revision_id=?, rollout_candidate_id=?, rollout_generation_id=?,
        source_acceptance_ref=?, placement_approval_ref=?, rollout_authorization_ref=?,
        legacy_combined_approval_ref=?, preflight_fingerprint=?,
        latest_operation_id=?, active_operation_id=?,
        active_operation_stage=?, active_operation_at=?, active_generation_id=?,
        pause_at=?, pause_reason=?, source_suspended_reason=?,
        source_policy=?, poll_interval_secs=?, next_poll_at=?, attempt_seq=?, partial_json=?,
        failure_stage=?, failure_class=?, failure_at=?, retry_at=?, retry_count=?,
        suspended_at=?, recovery_ref=?, recovery_phase=?,
        interruption_stage=?, interruption_at=?, interruption_operation_id=?,
        interruption_generation_id=?, evidence_fresh_at=?, evidence_limitations_json=?, updated_at=?
       WHERE id=?`,
    ).run(
      app.lifecycle_status, app.configured_repo_url, app.repo_identity_json, app.configured_ref,
      app.compose_paths_json, app.context_dir, app.sync_env, app.env_path,
      app.materialization_fingerprint, app.desired_commit_sha, app.fetched_commit_sha,
      app.fetched_resolved_ref_kind, app.candidate_generation_id, app.accepted_generation_id, app.candidate_plan_blocked,
      app.review_required, app.artifact_set_id, app.latest_artifact_set_id,
      app.intent_revision_id, app.rollout_candidate_id, app.rollout_generation_id,
      app.source_acceptance_ref, app.placement_approval_ref, app.rollout_authorization_ref,
      app.legacy_combined_approval_ref, app.preflight_fingerprint,
      app.latest_operation_id, app.active_operation_id,
      app.active_operation_stage, app.active_operation_at, app.active_generation_id,
      app.pause_at, app.pause_reason, app.source_suspended_reason,
      app.source_policy, app.poll_interval_secs, app.next_poll_at, app.attempt_seq, app.partial_json,
      app.failure_stage, app.failure_class, app.failure_at, app.retry_at, app.retry_count,
      app.suspended_at, app.recovery_ref, app.recovery_phase,
      app.interruption_stage, app.interruption_at, app.interruption_operation_id,
      app.interruption_generation_id, app.evidence_fresh_at, app.evidence_limitations_json,
      app.updated_at, app.id,
    );
  }
}

function snapshotApp(app: GitOpsApplicationRow): Record<string, unknown> {
  return {
    lifecycleStatus: app.lifecycle_status,
    desiredCommitSha: app.desired_commit_sha,
    fetchedCommitSha: app.fetched_commit_sha,
    candidateGenerationId: app.candidate_generation_id,
    acceptedGenerationId: app.accepted_generation_id,
    artifactSetId: app.artifact_set_id,
    latestArtifactSetId: app.latest_artifact_set_id,
    sourceAcceptanceRef: app.source_acceptance_ref,
    activeOperationStage: app.active_operation_stage,
    failureStage: app.failure_stage,
  };
}
