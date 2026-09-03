import type Database from 'better-sqlite3';
import { DatabaseService } from '../DatabaseService';
import {
  decodeArtifactEvidenceJson,
  decodeGitOpsApprovedTargetEffectJson,
  decodeGitOpsJson,
  decodeGitOpsRequiredTargetsJson,
  GitOpsJsonError,
  isPreflightFingerprint,
} from './json';
import type {
  FutureRolloutAuthorizationBinding,
  GitOpsApplicationRow,
  GitOpsApprovalRow,
  GitOpsArtifactSetRow,
  GitOpsCreateCheckpointRow,
  GitOpsCreatePhase,
  GitOpsGenerationRow,
  GitOpsIntentRevisionRow,
  GitOpsRolloutCandidateRow,
  GitOpsTargetCurrentRow,
  ResolveApprovalExpected,
} from './types';

export type LiveBlueprintApplication = {
  id: string;
  targetMode: GitOpsApplicationRow['target_mode'];
  lifecycleStatus: GitOpsApplicationRow['lifecycle_status'];
};

export type AssertNoLiveBlueprintResult =
  | { ok: true }
  | { ok: false; existing: LiveBlueprintApplication };

export class GitOpsStore {
  private static instance: GitOpsStore | undefined;

  static getInstance(): GitOpsStore {
    if (!GitOpsStore.instance) {
      GitOpsStore.instance = new GitOpsStore();
    }
    return GitOpsStore.instance;
  }

  static resetForTests(): void {
    GitOpsStore.instance = undefined;
  }

  private db(): Database.Database {
    return DatabaseService.getInstance().getDb();
  }

  assertNoLiveBlueprintApplication(blueprintId: number): AssertNoLiveBlueprintResult {
    const row = this.db().prepare(
      `SELECT id, target_mode, lifecycle_status
       FROM gitops_applications
       WHERE blueprint_id = ?
         AND lifecycle_status IN ('active','creating')
         AND target_mode IN ('inline_blueprint','blueprint')
       LIMIT 1`,
    ).get(blueprintId) as {
      id: string;
      target_mode: GitOpsApplicationRow['target_mode'];
      lifecycle_status: GitOpsApplicationRow['lifecycle_status'];
    } | undefined;
    if (!row) return { ok: true };
    return {
      ok: false,
      existing: {
        id: row.id,
        targetMode: row.target_mode,
        lifecycleStatus: row.lifecycle_status,
      },
    };
  }

  getApplication(id: string): GitOpsApplicationRow | undefined {
    return this.db().prepare('SELECT * FROM gitops_applications WHERE id = ?').get(id) as GitOpsApplicationRow | undefined;
  }

  getLiveDirectApplication(stackName: string): GitOpsApplicationRow | undefined {
    return this.db().prepare(
      `SELECT * FROM gitops_applications
       WHERE stack_name = ? AND target_mode = 'direct' AND lifecycle_status IN ('active','creating')`,
    ).get(stackName) as GitOpsApplicationRow | undefined;
  }

  /**
   * The live application for a Blueprint, in either Blueprint mode.
   *
   * One query across both modes because a Blueprint owns at most one live
   * application whichever way it is delivered, and the unique live index
   * enforces exactly that.
   */
  getLiveBlueprintApplication(blueprintId: number): GitOpsApplicationRow | undefined {
    return this.db().prepare(
      `SELECT * FROM gitops_applications
       WHERE blueprint_id = ?
         AND target_mode IN ('inline_blueprint','blueprint')
         AND lifecycle_status IN ('active','creating')`,
    ).get(blueprintId) as GitOpsApplicationRow | undefined;
  }

  /**
   * The most recently detached Direct application for a stack, if any.
   *
   * Consulted only after the live lookup misses. `applicationTombstoned` keeps
   * the configured identity and SHA pointers as frozen facts precisely so the
   * projection can still say what an application was, and `deriveSource` has a
   * `not_live` status for it, but neither could be reached while every entry
   * point filtered to the live rows.
   *
   * `detached` only, never `deleted`. A detached application's files are still
   * on disk and still describe that stack. A deleted one means the stack is
   * gone, so any directory of that name now belongs to something else, and
   * `readAuth` refuses stack-grant reads on deleted rows for the same
   * name-reuse reason.
   *
   * Newest first, because a stack name can be detached and reattached
   * repeatedly and only the latest detachment describes what was there last.
   * `rowid` breaks a tie rather than `id`, which is a random UUID and orders
   * arbitrarily; ties are reachable because a transaction stamps every row it
   * touches with one `envelope.at`.
   */
  getDetachedDirectApplication(stackName: string): GitOpsApplicationRow | undefined {
    return this.db().prepare(
      `SELECT * FROM gitops_applications
       WHERE stack_name = ? AND target_mode = 'direct' AND lifecycle_status = 'detached'
       ORDER BY updated_at DESC, rowid DESC
       LIMIT 1`,
    ).get(stackName) as GitOpsApplicationRow | undefined;
  }

  /** Direct applications that never reached their success boundary. */
  listCreatingDirectApplications(): GitOpsApplicationRow[] {
    return this.db().prepare(
      `SELECT * FROM gitops_applications
       WHERE target_mode = 'direct' AND lifecycle_status = 'creating'
       ORDER BY created_at ASC`,
    ).all() as GitOpsApplicationRow[];
  }

  getGeneration(id: string): GitOpsGenerationRow | undefined {
    return this.db().prepare('SELECT * FROM gitops_generations WHERE id = ?').get(id) as GitOpsGenerationRow | undefined;
  }

  getArtifactSet(id: string): GitOpsArtifactSetRow | undefined {
    return this.db().prepare('SELECT * FROM gitops_artifact_sets WHERE id = ?').get(id) as GitOpsArtifactSetRow | undefined;
  }

  getIntentRevision(id: string): GitOpsIntentRevisionRow | undefined {
    return this.db().prepare('SELECT * FROM gitops_intent_revisions WHERE id = ?').get(id) as GitOpsIntentRevisionRow | undefined;
  }

  getRolloutCandidate(id: string): GitOpsRolloutCandidateRow | undefined {
    return this.db().prepare('SELECT * FROM gitops_rollout_candidates WHERE id = ?').get(id) as GitOpsRolloutCandidateRow | undefined;
  }

  getApproval(id: string): GitOpsApprovalRow | undefined {
    return this.db().prepare('SELECT * FROM gitops_approvals WHERE id = ?').get(id) as GitOpsApprovalRow | undefined;
  }

  getTarget(applicationId: string, nodeId: number): GitOpsTargetCurrentRow | undefined {
    return this.db().prepare(
      'SELECT * FROM gitops_target_current WHERE application_id = ? AND node_id = ?',
    ).get(applicationId, nodeId) as GitOpsTargetCurrentRow | undefined;
  }

  listTargets(applicationId: string): GitOpsTargetCurrentRow[] {
    return this.db().prepare(
      'SELECT * FROM gitops_target_current WHERE application_id = ? ORDER BY node_id ASC',
    ).all(applicationId) as GitOpsTargetCurrentRow[];
  }

  /**
   * Live applications that were mid-operation, on the application row or on any
   * of their targets.
   *
   * Read at boot to reclassify work the previous process never finished. An
   * operation left open reports as still running forever, and offers no actions
   * while it does.
   */
  listApplicationsWithOpenOperations(): GitOpsApplicationRow[] {
    return this.db().prepare(
      `SELECT a.* FROM gitops_applications a
       WHERE a.lifecycle_status IN ('active','creating')
         AND (
           a.active_operation_stage IS NOT NULL
           OR EXISTS (
             SELECT 1 FROM gitops_target_current t
             WHERE t.application_id = a.id AND t.active_operation_stage IS NOT NULL
           )
         )
       ORDER BY a.created_at ASC`,
    ).all() as GitOpsApplicationRow[];
  }

  /** Every live target on one node, across all applications. */
  listActiveTargetsForNode(nodeId: number): GitOpsTargetCurrentRow[] {
    return this.db().prepare(
      `SELECT * FROM gitops_target_current
       WHERE node_id = ? AND target_status = 'active'
       ORDER BY application_id ASC`,
    ).all(nodeId) as GitOpsTargetCurrentRow[];
  }

  newestSourceAcceptanceId(applicationId: string, generationId: string): string | null {
    const row = this.db().prepare(
      `SELECT id FROM gitops_approvals
       WHERE application_id = ? AND kind = 'source_acceptance' AND authoritative = 1 AND generation_id = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(applicationId, generationId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  getMigrationCheckpoint(scope: string): { scope: string; schema_version: number; fingerprint: string } | undefined {
    return this.db().prepare(
      'SELECT scope, schema_version, fingerprint FROM gitops_migration_checkpoints WHERE scope = ?',
    ).get(scope) as { scope: string; schema_version: number; fingerprint: string } | undefined;
  }

  /**
   * Record that this scope has been migrated at this schema version and
   * configuration fingerprint.
   *
   * Replay is decided from the triple: an unchanged fingerprint skips, a
   * changed one re-runs the matrix. It never licenses upgrading an already
   * justified pointer to a stronger claim.
   */
  upsertMigrationCheckpoint(scope: string, schemaVersion: number, fingerprint: string, at: number): void {
    this.db().prepare(
      `INSERT INTO gitops_migration_checkpoints (scope, schema_version, fingerprint, migrated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(scope) DO UPDATE SET
         schema_version=excluded.schema_version,
         fingerprint=excluded.fingerprint,
         migrated_at=excluded.migrated_at`,
    ).run(scope, schemaVersion, fingerprint, at);
  }

  /**
   * Persist an application's mutable columns without going through a
   * transition.
   *
   * Used only by migration, which builds a whole row from evidence rather than
   * moving one pointer at a time. Every other writer goes through the
   * transitions so the change lands in history.
   */
  writeApplicationPointers(app: GitOpsApplicationRow): void {
    this.db().prepare(
      `UPDATE gitops_applications SET
        desired_commit_sha=?, fetched_commit_sha=?, accepted_generation_id=?,
        artifact_set_id=?, latest_artifact_set_id=?, evidence_limitations_json=?, updated_at=?
       WHERE id=?`,
    ).run(
      app.desired_commit_sha, app.fetched_commit_sha, app.accepted_generation_id,
      app.artifact_set_id, app.latest_artifact_set_id, app.evidence_limitations_json,
      app.updated_at, app.id,
    );
  }

  insertCreateCheckpoint(row: GitOpsCreateCheckpointRow): void {
    decodeGitOpsJson(row.compose_paths_json);
    this.db().prepare(
      `INSERT INTO gitops_create_checkpoints (
        application_id, stack_name, phase, generation_id, operation_id, repo_url, branch,
        compose_path, compose_paths_json, context_dir, sync_env, env_path, auth_type,
        encrypted_token, encrypted_deploy_key, ssh_known_hosts_entry, ssh_host_key_fingerprint,
        encrypted_ca_bundle,
        auto_apply_on_webhook, auto_deploy_on_apply, commit_sha,
        applied_spec_json, created_managed_root, created_at, updated_at
      ) VALUES (${Array(25).fill('?').join(', ')})`,
    ).run(
      row.application_id, row.stack_name, row.phase, row.generation_id, row.operation_id,
      row.repo_url, row.branch, row.compose_path, row.compose_paths_json, row.context_dir,
      row.sync_env, row.env_path, row.auth_type, row.encrypted_token, row.encrypted_deploy_key,
      row.ssh_known_hosts_entry, row.ssh_host_key_fingerprint, row.encrypted_ca_bundle,
      row.auto_apply_on_webhook,
      row.auto_deploy_on_apply, row.commit_sha, row.applied_spec_json, row.created_managed_root,
      row.created_at, row.updated_at,
    );
  }

  getCreateCheckpoint(applicationId: string): GitOpsCreateCheckpointRow | undefined {
    return this.db().prepare(
      'SELECT * FROM gitops_create_checkpoints WHERE application_id = ?',
    ).get(applicationId) as GitOpsCreateCheckpointRow | undefined;
  }

  listCreateCheckpoints(): GitOpsCreateCheckpointRow[] {
    return this.db().prepare(
      'SELECT * FROM gitops_create_checkpoints ORDER BY created_at ASC',
    ).all() as GitOpsCreateCheckpointRow[];
  }

  /** Advance the phase, and optionally record facts the phase depends on. */
  updateCreateCheckpoint(
    applicationId: string,
    patch: {
      phase?: GitOpsCreatePhase;
      generationId?: string | null;
      commitSha?: string | null;
      appliedSpecJson?: string | null;
      createdManagedRoot?: number;
    },
    at: number,
  ): void {
    const current = this.getCreateCheckpoint(applicationId);
    if (!current) throw new Error('create checkpoint not found');
    this.db().prepare(
      `UPDATE gitops_create_checkpoints SET
        phase=?, generation_id=?, commit_sha=?, applied_spec_json=?,
        created_managed_root=?, updated_at=?
       WHERE application_id=?`,
    ).run(
      patch.phase ?? current.phase,
      patch.generationId === undefined ? current.generation_id : patch.generationId,
      patch.commitSha === undefined ? current.commit_sha : patch.commitSha,
      patch.appliedSpecJson === undefined ? current.applied_spec_json : patch.appliedSpecJson,
      patch.createdManagedRoot ?? current.created_managed_root,
      at,
      applicationId,
    );
  }

  deleteCreateCheckpoint(applicationId: string): void {
    this.db().prepare('DELETE FROM gitops_create_checkpoints WHERE application_id = ?').run(applicationId);
  }

  insertApproval(row: GitOpsApprovalRow): void {
    // Decode every JSON column the resolver will later read, so a malformed
    // payload aborts the write instead of persisting an approval that reads
    // back as absent. Rollout-authorization blast is reserved policy payload
    // and is never a node set, so it is only checked for well-formedness.
    if (row.required_targets_json !== null) decodeGitOpsRequiredTargetsJson(row.required_targets_json);
    if (row.blast_json !== null) {
      if (row.kind === 'placement_approval') decodeGitOpsApprovedTargetEffectJson(row.blast_json);
      else decodeGitOpsJson(row.blast_json);
    }
    if (row.policy_provenance_json !== null) decodeGitOpsJson(row.policy_provenance_json);
    this.db().prepare(
      `INSERT INTO gitops_approvals (
        id, kind, authority, authoritative, application_id, generation_id, intent_revision_id,
        artifact_set_id, rollout_candidate_id, rollout_generation_id, source_acceptance_ref,
        placement_approval_ref, required_targets_json, preflight_fingerprint, fingerprint,
        blast_json, policy_provenance_json, actor, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id, row.kind, row.authority, row.authoritative, row.application_id, row.generation_id,
      row.intent_revision_id, row.artifact_set_id, row.rollout_candidate_id, row.rollout_generation_id,
      row.source_acceptance_ref, row.placement_approval_ref, row.required_targets_json,
      row.preflight_fingerprint, row.fingerprint, row.blast_json, row.policy_provenance_json,
      row.actor, row.created_at,
    );
  }

  insertApplication(row: GitOpsApplicationRow): void {
    this.db().prepare(
      `INSERT INTO gitops_applications (
        id, lifecycle_key, lifecycle_status, target_mode, stack_name, blueprint_id,
        configured_repo_url, repo_identity_json, configured_ref, compose_paths_json,
        context_dir, sync_env, env_path, materialization_fingerprint, desired_commit_sha,
        fetched_commit_sha, fetched_resolved_ref_kind, candidate_generation_id, accepted_generation_id,
        candidate_plan_blocked, review_required, artifact_set_id, latest_artifact_set_id,
        intent_revision_id, rollout_candidate_id, rollout_generation_id, source_acceptance_ref,
        placement_approval_ref, rollout_authorization_ref, legacy_combined_approval_ref,
        preflight_fingerprint, latest_operation_id, active_operation_id, active_operation_stage,
        active_operation_at, active_generation_id, pause_at, pause_reason, source_suspended_reason,
        source_policy, poll_interval_secs, next_poll_at, attempt_seq, partial_json,
        failure_stage, failure_class, failure_at, retry_at, retry_count, suspended_at,
        recovery_ref, recovery_phase, interruption_stage, interruption_at,
        interruption_operation_id, interruption_generation_id, evidence_fresh_at,
        evidence_limitations_json, created_at, updated_at
      ) VALUES (${Array(60).fill('?').join(', ')})`,
    ).run(
      row.id, row.lifecycle_key, row.lifecycle_status, row.target_mode, row.stack_name, row.blueprint_id,
      row.configured_repo_url, row.repo_identity_json, row.configured_ref, row.compose_paths_json,
      row.context_dir, row.sync_env, row.env_path, row.materialization_fingerprint, row.desired_commit_sha,
      row.fetched_commit_sha, row.fetched_resolved_ref_kind, row.candidate_generation_id, row.accepted_generation_id,
      row.candidate_plan_blocked, row.review_required, row.artifact_set_id, row.latest_artifact_set_id,
      row.intent_revision_id, row.rollout_candidate_id, row.rollout_generation_id, row.source_acceptance_ref,
      row.placement_approval_ref, row.rollout_authorization_ref, row.legacy_combined_approval_ref,
      row.preflight_fingerprint, row.latest_operation_id, row.active_operation_id, row.active_operation_stage,
      row.active_operation_at, row.active_generation_id, row.pause_at, row.pause_reason, row.source_suspended_reason,
      row.source_policy, row.poll_interval_secs, row.next_poll_at, row.attempt_seq, row.partial_json,
      row.failure_stage, row.failure_class, row.failure_at, row.retry_at, row.retry_count, row.suspended_at,
      row.recovery_ref, row.recovery_phase, row.interruption_stage, row.interruption_at,
      row.interruption_operation_id, row.interruption_generation_id, row.evidence_fresh_at,
      row.evidence_limitations_json, row.created_at, row.updated_at,
    );
  }

  insertGeneration(row: GitOpsGenerationRow): void {
    this.db().prepare(
      `INSERT INTO gitops_generations (
        id, application_id, commit_sha, repo_url, configured_ref, resolved_ref_kind, repo_identity_json,
        manifest_version, candidate_dir, applied_dir, expected_invocation_json,
        materialization_fingerprint, validation_ok, plan_blocked, change_plan_fingerprint,
        operation_id, trigger, actor, previous_generation_id, redacted_limitations_json,
        portable_manifest_json, compose_inputs_json, source_policy_evidence_json,
        security_policy_evidence_json, support_requirements_json, compatibility_requirements_json,
        created_at
      ) VALUES (${Array(27).fill('?').join(', ')})`,
    ).run(
      row.id, row.application_id, row.commit_sha, row.repo_url, row.configured_ref, row.resolved_ref_kind, row.repo_identity_json,
      row.manifest_version, row.candidate_dir, row.applied_dir, row.expected_invocation_json,
      row.materialization_fingerprint, row.validation_ok, row.plan_blocked, row.change_plan_fingerprint,
      row.operation_id, row.trigger, row.actor, row.previous_generation_id, row.redacted_limitations_json,
      row.portable_manifest_json, row.compose_inputs_json, row.source_policy_evidence_json,
      row.security_policy_evidence_json, row.support_requirements_json, row.compatibility_requirements_json,
      row.created_at,
    );
  }

  insertArtifactSet(row: GitOpsArtifactSetRow): void {
    const evidence = decodeArtifactEvidenceJson(row.evidence_json);
    if (evidence.kind !== row.qualification) {
      throw new GitOpsJsonError('artifact qualification must match evidence_json.kind');
    }
    if (row.authoritative !== 0) {
      throw new Error('artifact rows must be non-authoritative until qualification is accepted');
    }
    this.db().prepare(
      `INSERT INTO gitops_artifact_sets (
        id, generation_id, evidence_version, authoritative, qualification, evidence_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id, row.generation_id, row.evidence_version, row.authoritative,
      row.qualification, row.evidence_json, row.created_at,
    );
  }

  insertIntentRevision(row: GitOpsIntentRevisionRow): void {
    this.db().prepare(
      `INSERT INTO gitops_intent_revisions (
        id, application_id, blueprint_id, compose_content_sha256, blueprint_revision,
        deploy_stack_name, selector_json, pinned_node_id, cordon_implications_json,
        rollout_strategy_json, runtime_drift_policy, stateful_policy_json,
        health_failure_rollback_policy_json, operation_id, actor, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id, row.application_id, row.blueprint_id, row.compose_content_sha256, row.blueprint_revision,
      row.deploy_stack_name, row.selector_json, row.pinned_node_id, row.cordon_implications_json,
      row.rollout_strategy_json, row.runtime_drift_policy, row.stateful_policy_json,
      row.health_failure_rollback_policy_json, row.operation_id, row.actor, row.created_at,
    );
  }

  insertRolloutCandidate(row: GitOpsRolloutCandidateRow): void {
    decodeGitOpsRequiredTargetsJson(row.required_targets_json);
    this.db().prepare(
      `INSERT INTO gitops_rollout_candidates (
        id, application_id, intent_revision_id, compose_content_sha256, accepted_generation_id,
        artifact_set_id, required_targets_json, authoritative, provenance, operation_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id, row.application_id, row.intent_revision_id, row.compose_content_sha256,
      row.accepted_generation_id, row.artifact_set_id, row.required_targets_json,
      row.authoritative, row.provenance, row.operation_id, row.created_at,
    );
  }

  upsertTarget(row: GitOpsTargetCurrentRow): void {
    this.assertTargetInvariants(row);
    this.db().prepare(
      `INSERT INTO gitops_target_current (
        application_id, node_id, target_status, desired_generation_id, candidate_generation_id,
        applied_generation_id, deployed_generation_id, healthy_generation_id, lkg_generation_id,
        lkg_artifact_set_id, lkg_unavailable_at, lkg_unavailable_reason, expected_artifact_set_id,
        latest_artifact_set_id, observed_artifact_identity_json, intent_revision_id,
        rollout_candidate_id, rollout_generation_id, source_acceptance_ref, placement_approval_ref,
        rollout_authorization_ref, legacy_combined_approval_ref, legacy_applied_revision,
        connectivity, latest_stage, active_operation_id, active_operation_stage, active_operation_at,
        active_generation_id, active_intent_revision_id, active_rollout_candidate_id,
        failure_stage, failure_class, failure_at, recovery_ref, recovery_generation_id,
        recovery_phase, interruption_stage, interruption_at, interruption_operation_id,
        interruption_generation_id, interruption_intent_revision_id, interruption_rollout_candidate_id,
        pause_at, pause_reason, retry_at, suspended_at, partial_json, evidence_limitations_json, updated_at
      ) VALUES (${Array(50).fill('?').join(', ')})
      ON CONFLICT(application_id, node_id) DO UPDATE SET
        target_status=excluded.target_status,
        desired_generation_id=excluded.desired_generation_id,
        candidate_generation_id=excluded.candidate_generation_id,
        applied_generation_id=excluded.applied_generation_id,
        deployed_generation_id=excluded.deployed_generation_id,
        healthy_generation_id=excluded.healthy_generation_id,
        lkg_generation_id=excluded.lkg_generation_id,
        lkg_artifact_set_id=excluded.lkg_artifact_set_id,
        lkg_unavailable_at=excluded.lkg_unavailable_at,
        lkg_unavailable_reason=excluded.lkg_unavailable_reason,
        expected_artifact_set_id=excluded.expected_artifact_set_id,
        latest_artifact_set_id=excluded.latest_artifact_set_id,
        observed_artifact_identity_json=excluded.observed_artifact_identity_json,
        intent_revision_id=excluded.intent_revision_id,
        rollout_candidate_id=excluded.rollout_candidate_id,
        rollout_generation_id=excluded.rollout_generation_id,
        source_acceptance_ref=excluded.source_acceptance_ref,
        placement_approval_ref=excluded.placement_approval_ref,
        rollout_authorization_ref=excluded.rollout_authorization_ref,
        legacy_combined_approval_ref=excluded.legacy_combined_approval_ref,
        legacy_applied_revision=excluded.legacy_applied_revision,
        connectivity=excluded.connectivity,
        latest_stage=excluded.latest_stage,
        active_operation_id=excluded.active_operation_id,
        active_operation_stage=excluded.active_operation_stage,
        active_operation_at=excluded.active_operation_at,
        active_generation_id=excluded.active_generation_id,
        active_intent_revision_id=excluded.active_intent_revision_id,
        active_rollout_candidate_id=excluded.active_rollout_candidate_id,
        failure_stage=excluded.failure_stage,
        failure_class=excluded.failure_class,
        failure_at=excluded.failure_at,
        recovery_ref=excluded.recovery_ref,
        recovery_generation_id=excluded.recovery_generation_id,
        recovery_phase=excluded.recovery_phase,
        interruption_stage=excluded.interruption_stage,
        interruption_at=excluded.interruption_at,
        interruption_operation_id=excluded.interruption_operation_id,
        interruption_generation_id=excluded.interruption_generation_id,
        interruption_intent_revision_id=excluded.interruption_intent_revision_id,
        interruption_rollout_candidate_id=excluded.interruption_rollout_candidate_id,
        pause_at=excluded.pause_at,
        pause_reason=excluded.pause_reason,
        retry_at=excluded.retry_at,
        suspended_at=excluded.suspended_at,
        partial_json=excluded.partial_json,
        evidence_limitations_json=excluded.evidence_limitations_json,
        updated_at=excluded.updated_at`,
    ).run(
      row.application_id, row.node_id, row.target_status, row.desired_generation_id, row.candidate_generation_id,
      row.applied_generation_id, row.deployed_generation_id, row.healthy_generation_id, row.lkg_generation_id,
      row.lkg_artifact_set_id, row.lkg_unavailable_at, row.lkg_unavailable_reason, row.expected_artifact_set_id,
      row.latest_artifact_set_id, row.observed_artifact_identity_json, row.intent_revision_id,
      row.rollout_candidate_id, row.rollout_generation_id, row.source_acceptance_ref, row.placement_approval_ref,
      row.rollout_authorization_ref, row.legacy_combined_approval_ref, row.legacy_applied_revision,
      row.connectivity, row.latest_stage, row.active_operation_id, row.active_operation_stage, row.active_operation_at,
      row.active_generation_id, row.active_intent_revision_id, row.active_rollout_candidate_id,
      row.failure_stage, row.failure_class, row.failure_at, row.recovery_ref, row.recovery_generation_id,
      row.recovery_phase, row.interruption_stage, row.interruption_at, row.interruption_operation_id,
      row.interruption_generation_id, row.interruption_intent_revision_id, row.interruption_rollout_candidate_id,
      row.pause_at, row.pause_reason, row.retry_at, row.suspended_at, row.partial_json,
      row.evidence_limitations_json, row.updated_at,
    );
  }

  resolveApprovalRef(id: string, expected: ResolveApprovalExpected): GitOpsApprovalRow | null {
    const row = this.getApproval(id);
    if (!row) return null;
    if (row.application_id !== expected.applicationId) return null;
    if (row.kind !== expected.kind) return null;
    // legacy_combined inverts the flag on purpose. It is a migration marker for
    // an approval made before source acceptance and placement were separable,
    // so it can never stand as proof for either one. Requiring
    // authoritative = 0 is what stops it being copied into a decomposed slot.
    if (expected.kind === 'legacy_combined') {
      if (row.authoritative !== 0 || row.authority !== 'legacy_combined') return null;
      return row;
    }
    if (row.authoritative !== 1) return null;
    if (row.authority !== 'operator' && row.authority !== 'configured_policy') return null;

    if (expected.kind === 'source_acceptance') {
      if (!row.generation_id) return null;
      const generation = this.getGeneration(row.generation_id);
      if (!generation || generation.application_id !== expected.applicationId) return null;
      if (row.generation_id !== expected.generationId) return null;
      return row;
    }

    if (expected.kind === 'placement_approval') {
      if (!row.intent_revision_id || row.intent_revision_id !== expected.intentRevisionId) return null;
      if (!row.blast_json) return null;
      let effect;
      try {
        effect = decodeGitOpsApprovedTargetEffectJson(row.blast_json);
      } catch {
        return null;
      }
      if (!placementEffectCompatible(effect, expected.requiredNodeIds)) return null;
      return row;
    }

    const reconstructed = this.reconstructAuthorizationBinding(row);
    if (!reconstructed) return null;
    if (!authorizationBindingsEqual(reconstructed, expected.binding)) return null;
    const source = this.resolveApprovalRef(reconstructed.sourceAcceptanceRef, {
      kind: 'source_acceptance',
      applicationId: expected.applicationId,
      generationId: expected.binding.acceptedGenerationId,
    });
    if (!source) return null;
    const placement = this.resolveApprovalRef(reconstructed.placementApprovalRef, {
      kind: 'placement_approval',
      applicationId: expected.applicationId,
      intentRevisionId: expected.binding.intentRevisionId,
      requiredNodeIds: expected.binding.requiredNodeIds,
    });
    if (!placement) return null;
    return row;
  }

  reconstructAuthorizationBinding(row: GitOpsApprovalRow): FutureRolloutAuthorizationBinding | null {
    if (row.kind !== 'rollout_authorization') return null;
    if (
      !row.rollout_candidate_id
      || !row.generation_id
      || !row.artifact_set_id
      || !row.intent_revision_id
      || !row.source_acceptance_ref
      || !row.placement_approval_ref
      || !row.required_targets_json
      || !row.preflight_fingerprint
    ) {
      return null;
    }
    if (!isPreflightFingerprint(row.preflight_fingerprint)) return null;
    let required;
    try {
      required = decodeGitOpsRequiredTargetsJson(row.required_targets_json);
    } catch {
      return null;
    }
    return {
      rolloutCandidateId: row.rollout_candidate_id,
      acceptedGenerationId: row.generation_id,
      artifactSetId: row.artifact_set_id,
      intentRevisionId: row.intent_revision_id,
      requiredNodeIds: required.nodeIds,
      sourceAcceptanceRef: row.source_acceptance_ref,
      placementApprovalRef: row.placement_approval_ref,
      preflightFingerprint: row.preflight_fingerprint,
    };
  }

  currentAuthorizationBinding(app: GitOpsApplicationRow): FutureRolloutAuthorizationBinding | null {
    if (
      !app.rollout_candidate_id
      || !app.accepted_generation_id
      || !app.artifact_set_id
      || !app.intent_revision_id
      || !app.source_acceptance_ref
      || !app.placement_approval_ref
      || !app.preflight_fingerprint
    ) {
      return null;
    }
    if (!isPreflightFingerprint(app.preflight_fingerprint)) return null;
    const candidate = this.getRolloutCandidate(app.rollout_candidate_id);
    if (!candidate || candidate.application_id !== app.id) return null;
    if (candidate.accepted_generation_id !== app.accepted_generation_id) return null;
    if (candidate.artifact_set_id !== app.artifact_set_id) return null;
    if (candidate.intent_revision_id !== app.intent_revision_id) return null;
    const generation = this.getGeneration(app.accepted_generation_id);
    if (!generation || generation.application_id !== app.id) return null;
    const artifact = this.getArtifactSet(app.artifact_set_id);
    if (!artifact || artifact.generation_id !== app.accepted_generation_id) return null;
    let required;
    try {
      required = decodeGitOpsRequiredTargetsJson(candidate.required_targets_json);
    } catch {
      return null;
    }
    const source = this.resolveApprovalRef(app.source_acceptance_ref, {
      kind: 'source_acceptance',
      applicationId: app.id,
      generationId: app.accepted_generation_id,
    });
    if (!source) return null;
    const placement = this.resolveApprovalRef(app.placement_approval_ref, {
      kind: 'placement_approval',
      applicationId: app.id,
      intentRevisionId: app.intent_revision_id,
      requiredNodeIds: required.nodeIds,
    });
    if (!placement) return null;
    return {
      rolloutCandidateId: app.rollout_candidate_id,
      acceptedGenerationId: app.accepted_generation_id,
      artifactSetId: app.artifact_set_id,
      intentRevisionId: app.intent_revision_id,
      requiredNodeIds: required.nodeIds,
      sourceAcceptanceRef: app.source_acceptance_ref,
      placementApprovalRef: app.placement_approval_ref,
      preflightFingerprint: app.preflight_fingerprint,
    };
  }

  private assertTargetInvariants(row: GitOpsTargetCurrentRow): void {
    if (row.lkg_artifact_set_id) {
      const artifact = this.getArtifactSet(row.lkg_artifact_set_id);
      if (!artifact || artifact.generation_id !== row.lkg_generation_id) {
        throw new Error('lkg_artifact_set_id must belong to lkg_generation_id');
      }
    }
    if (row.lkg_unavailable_at !== null && row.lkg_generation_id !== null) {
      throw new Error('lkg unavailability cannot coexist with an LKG generation');
    }
    this.assertArtifactPointer(row.expected_artifact_set_id, row.desired_generation_id);
    this.assertArtifactPointer(row.latest_artifact_set_id, row.desired_generation_id);
    // A pointer to a row that does not exist is rejected, not tolerated: the
    // write is where the bad reference is cheap to find. Tolerating it moves
    // the symptom to derivation, far from the transition that caused it.
    if (row.desired_generation_id) {
      const generation = this.getGeneration(row.desired_generation_id);
      if (!generation || generation.application_id !== row.application_id) {
        throw new Error('target desired generation must belong to the application');
      }
    }
    if (row.candidate_generation_id) {
      const generation = this.getGeneration(row.candidate_generation_id);
      if (!generation || generation.application_id !== row.application_id) {
        throw new Error('target candidate generation must belong to the application');
      }
    }
  }

  private assertArtifactPointer(artifactSetId: string | null, desiredGenerationId: string | null): void {
    if (!artifactSetId) return;
    if (!desiredGenerationId) {
      throw new Error('artifact pointer requires desired_generation_id');
    }
    const artifact = this.getArtifactSet(artifactSetId);
    if (!artifact || artifact.generation_id !== desiredGenerationId) {
      throw new Error('target artifact pointer must belong to desired_generation_id');
    }
  }
}

/**
 * Whether an approved placement effect can authorize this required target set.
 *
 * This is a non-contradiction check, not a coverage check. A node the approval
 * places must be required, and a node it removes must not be, but a required
 * node absent from the effect is fine: it is already converged, so the approved
 * action list has nothing to say about it. An empty effect is therefore valid
 * against any required set. Do not tighten this into set equality; a converged
 * fleet legitimately produces no actions to approve.
 */
export function placementEffectCompatible(
  effect: Array<{ nodeId: number; outcome: 'place' | 'remove' }>,
  requiredNodeIds: readonly number[],
): boolean {
  const required = new Set(requiredNodeIds);
  for (const entry of effect) {
    if (entry.outcome === 'place' && !required.has(entry.nodeId)) return false;
    if (entry.outcome === 'remove' && required.has(entry.nodeId)) return false;
  }
  return true;
}

export function authorizationBindingsEqual(
  left: FutureRolloutAuthorizationBinding,
  right: FutureRolloutAuthorizationBinding,
): boolean {
  if (left.rolloutCandidateId !== right.rolloutCandidateId) return false;
  if (left.acceptedGenerationId !== right.acceptedGenerationId) return false;
  if (left.artifactSetId !== right.artifactSetId) return false;
  if (left.intentRevisionId !== right.intentRevisionId) return false;
  if (left.sourceAcceptanceRef !== right.sourceAcceptanceRef) return false;
  if (left.placementApprovalRef !== right.placementApprovalRef) return false;
  if (left.preflightFingerprint !== right.preflightFingerprint) return false;
  if (left.requiredNodeIds.length !== right.requiredNodeIds.length) return false;
  for (let i = 0; i < left.requiredNodeIds.length; i += 1) {
    if (left.requiredNodeIds[i] !== right.requiredNodeIds[i]) return false;
  }
  return true;
}

export function emptyTargetRow(
  applicationId: string,
  nodeId: number,
  now: number,
): GitOpsTargetCurrentRow {
  return {
    application_id: applicationId,
    node_id: nodeId,
    target_status: 'active',
    desired_generation_id: null,
    candidate_generation_id: null,
    applied_generation_id: null,
    deployed_generation_id: null,
    healthy_generation_id: null,
    lkg_generation_id: null,
    lkg_artifact_set_id: null,
    lkg_unavailable_at: null,
    lkg_unavailable_reason: null,
    expected_artifact_set_id: null,
    latest_artifact_set_id: null,
    observed_artifact_identity_json: null,
    intent_revision_id: null,
    rollout_candidate_id: null,
    rollout_generation_id: null,
    source_acceptance_ref: null,
    placement_approval_ref: null,
    rollout_authorization_ref: null,
    legacy_combined_approval_ref: null,
    legacy_applied_revision: null,
    connectivity: null,
    latest_stage: null,
    active_operation_id: null,
    active_operation_stage: null,
    active_operation_at: null,
    active_generation_id: null,
    active_intent_revision_id: null,
    active_rollout_candidate_id: null,
    failure_stage: null,
    failure_class: null,
    failure_at: null,
    recovery_ref: null,
    recovery_generation_id: null,
    recovery_phase: null,
    interruption_stage: null,
    interruption_at: null,
    interruption_operation_id: null,
    interruption_generation_id: null,
    interruption_intent_revision_id: null,
    interruption_rollout_candidate_id: null,
    pause_at: null,
    pause_reason: null,
    retry_at: null,
    suspended_at: null,
    partial_json: null,
    evidence_limitations_json: null,
    updated_at: now,
  };
}
