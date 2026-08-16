import { DatabaseService } from '../DatabaseService';
import { decodeArtifactEvidenceJson, encodeArtifactEvidenceJson } from './json';
import { insertHistory, type HistoryOutcome } from './history';
import { emptyTargetRow, GitOpsStore } from './store';
import type {
  ArtifactQualification,
  GitOpsApplicationRow,
  GitOpsApprovalAuthority,
  GitOpsArtifactSetRow,
  GitOpsGenerationRow,
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

  fetched(applicationId: string, commitSha: string, envelope: EventEnvelope): TransitionResult {
    return this.mutateApp(applicationId, envelope, 'fetched', 'committed', (app) => {
      this.requireMatchingFetch(app, envelope);
      this.clearActive(app);
      app.desired_commit_sha = commitSha;
      app.fetched_commit_sha = commitSha;
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
      if (app.candidate_generation_id && app.candidate_generation_id !== generationId) {
        const superseded = this.history(app, envelope, {
          stage: 'candidate_superseded',
          outcome: 'superseded',
          generationId: app.candidate_generation_id,
          before: { candidateGenerationId: app.candidate_generation_id },
          after: { candidateGenerationId: generationId },
        });
        if (superseded) extras.historyIds.push(superseded);
      }
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
      for (const target of targets) {
        if (app.target_mode === 'direct') {
          target.desired_generation_id = args.generationId;
          target.applied_generation_id = args.generationId;
          target.expected_artifact_set_id = args.artifactSetId;
          target.latest_artifact_set_id = args.artifactSetId;
          target.source_acceptance_ref = args.sourceAcceptanceId;
          target.candidate_generation_id = null;
        }
        this.store().upsertTarget(target);
      }
    }, {
      generationId: args.generationId,
      artifactSetId: args.artifactSetId,
      sourceAcceptanceRef: args.sourceAcceptanceId,
    });
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
      const live = target.active_operation_stage === 'deploy_started'
        && target.active_generation_id === generationId
        && (!target.active_operation_id || target.active_operation_id === envelope.operationId);
      const interrupted = target.interruption_stage === 'deploy_started'
        && target.interruption_generation_id === generationId
        && (!target.interruption_operation_id || target.interruption_operation_id === envelope.operationId);
      if (!live && !interrupted) throw new GitOpsTransitionError('no matching deploy operation');
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

  interruptActiveOperations(applicationId: string, envelope: EventEnvelope): TransitionResult {
    return this.raw().transaction(() => {
      const app = this.requireApp(applicationId);
      const historyIds: string[] = [];
      if (app.active_operation_stage) {
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
        if (!target.active_operation_stage) continue;
        target.interruption_stage = target.active_operation_stage;
        target.interruption_at = envelope.at;
        target.interruption_operation_id = target.active_operation_id;
        target.interruption_generation_id = target.active_generation_id;
        target.interruption_intent_revision_id = target.active_intent_revision_id;
        target.interruption_rollout_candidate_id = target.active_rollout_candidate_id;
        this.clearTargetActive(target);
        target.active_intent_revision_id = null;
        target.active_rollout_candidate_id = null;
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
  private acceptanceTargets(app: GitOpsApplicationRow, args: AppliedArgs): GitOpsTargetCurrentRow[] {
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
    stage: string,
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
    stage: string,
    generationId: string,
    mutate: (target: GitOpsTargetCurrentRow) => { before: unknown; after: unknown },
  ): TransitionResult {
    return this.raw().transaction(() => {
      const app = this.requireApp(applicationId);
      const target = this.store().getTarget(applicationId, nodeId);
      if (!target) throw new GitOpsTransitionError('target not found');
      const snapshots = mutate(target);
      target.updated_at = envelope.at;
      this.store().upsertTarget(target);
      const historyId = this.history(app, envelope, {
        nodeId,
        stage,
        outcome: 'committed',
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
      stage: string;
      outcome: HistoryOutcome;
      before: unknown;
      after: unknown;
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

  private clearTargetActive(target: GitOpsTargetCurrentRow): void {
    target.active_operation_id = null;
    target.active_operation_stage = null;
    target.active_operation_at = null;
    target.active_generation_id = null;
  }

  private clearTargetInterruption(
    target: GitOpsTargetCurrentRow,
    stage: GitOpsTargetCurrentRow['interruption_stage'],
  ): void {
    if (target.interruption_stage !== stage) return;
    target.interruption_stage = null;
    target.interruption_at = null;
    target.interruption_operation_id = null;
    target.interruption_generation_id = null;
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
   * Only the columns listed here can change after insert. The mutator callback
   * receives the whole row, so assigning a column that is absent from this
   * UPDATE compiles, shows up in the history snapshot, and is then silently
   * dropped at commit. Add the column here before any transition writes it.
   */
  private writeApplication(app: GitOpsApplicationRow): void {
    this.raw().prepare(
      `UPDATE gitops_applications SET
        lifecycle_status=?, desired_commit_sha=?, fetched_commit_sha=?,
        candidate_generation_id=?, accepted_generation_id=?, candidate_plan_blocked=?,
        review_required=?, artifact_set_id=?, latest_artifact_set_id=?,
        source_acceptance_ref=?, latest_operation_id=?, active_operation_id=?,
        active_operation_stage=?, active_operation_at=?, active_generation_id=?,
        failure_stage=?, failure_class=?, failure_at=?, retry_at=?, retry_count=?,
        interruption_stage=?, interruption_at=?, interruption_operation_id=?,
        interruption_generation_id=?, updated_at=?
       WHERE id=?`,
    ).run(
      app.lifecycle_status, app.desired_commit_sha, app.fetched_commit_sha,
      app.candidate_generation_id, app.accepted_generation_id, app.candidate_plan_blocked,
      app.review_required, app.artifact_set_id, app.latest_artifact_set_id,
      app.source_acceptance_ref, app.latest_operation_id, app.active_operation_id,
      app.active_operation_stage, app.active_operation_at, app.active_generation_id,
      app.failure_stage, app.failure_class, app.failure_at, app.retry_at, app.retry_count,
      app.interruption_stage, app.interruption_at, app.interruption_operation_id,
      app.interruption_generation_id, app.updated_at, app.id,
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
