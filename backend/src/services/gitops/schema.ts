/**
 * DatabaseService executes this at init, then separately seeds
 * gitops_schema_version, adds the gitops_* columns to
 * stack_update_recovery_generations, and adds deployed_generation_id to
 * health_gate_runs. Those three live outside this string because they alter
 * pre-existing tables rather than creating GitOps ones.
 */

export const GITOPS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS gitops_migration_checkpoints (
  scope TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  migrated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gitops_create_checkpoints (
  application_id TEXT PRIMARY KEY,
  stack_name TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN (
    'pre_stack','stack_created','promoting','manifest_committed','pointers_committed'
  )),
  generation_id TEXT NULL,
  operation_id TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  branch TEXT NOT NULL,
  compose_path TEXT NOT NULL,
  compose_paths_json TEXT NOT NULL,
  context_dir TEXT NULL,
  sync_env INTEGER NOT NULL DEFAULT 0,
  env_path TEXT NULL,
  auth_type TEXT NOT NULL,
  encrypted_token TEXT NULL,
  encrypted_deploy_key TEXT NULL,
  ssh_known_hosts_entry TEXT NULL,
  ssh_host_key_fingerprint TEXT NULL,
  encrypted_ca_bundle TEXT NULL,
  auto_apply_on_webhook INTEGER NOT NULL DEFAULT 0,
  auto_deploy_on_apply INTEGER NOT NULL DEFAULT 0,
  commit_sha TEXT NULL,
  applied_spec_json TEXT NULL,
  created_managed_root INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gitops_create_ck_stack
  ON gitops_create_checkpoints(stack_name);
CREATE INDEX IF NOT EXISTS idx_gitops_create_ck_phase
  ON gitops_create_checkpoints(phase);

CREATE TABLE IF NOT EXISTS gitops_applications (
  id TEXT PRIMARY KEY,
  lifecycle_key TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL CHECK (lifecycle_status IN (
    'active','creating','detached','deleted'
  )),
  target_mode TEXT NOT NULL CHECK (target_mode IN ('direct','inline_blueprint','blueprint')),
  stack_name TEXT NULL,
  blueprint_id INTEGER NULL,
  configured_repo_url TEXT NULL,
  repo_identity_json TEXT NULL,
  configured_ref TEXT NULL,
  compose_paths_json TEXT NULL,
  context_dir TEXT NULL,
  sync_env INTEGER NULL,
  env_path TEXT NULL,
  materialization_fingerprint TEXT NULL,
  desired_commit_sha TEXT NULL,
  fetched_commit_sha TEXT NULL,
  fetched_resolved_ref_kind TEXT NULL CHECK (
    fetched_resolved_ref_kind IS NULL OR fetched_resolved_ref_kind IN ('branch','tag','sha')
  ),
  candidate_generation_id TEXT NULL,
  accepted_generation_id TEXT NULL,
  candidate_plan_blocked INTEGER NOT NULL DEFAULT 0,
  review_required INTEGER NOT NULL DEFAULT 0,
  artifact_set_id TEXT NULL,
  latest_artifact_set_id TEXT NULL,
  intent_revision_id TEXT NULL,
  rollout_candidate_id TEXT NULL,
  rollout_generation_id TEXT NULL,
  source_acceptance_ref TEXT NULL,
  placement_approval_ref TEXT NULL,
  rollout_authorization_ref TEXT NULL,
  legacy_combined_approval_ref TEXT NULL,
  preflight_fingerprint TEXT NULL,
  latest_operation_id TEXT NULL,
  active_operation_id TEXT NULL,
  active_operation_stage TEXT NULL CHECK (
    active_operation_stage IS NULL OR active_operation_stage IN (
      'fetch_started','apply_started','deploy_started','recovery_started'
    )
  ),
  active_operation_at INTEGER NULL,
  active_generation_id TEXT NULL,
  pause_at INTEGER NULL,
  pause_reason TEXT NULL,
  -- Distinct from pause_reason: sourceSuspended/sourceUnsuspended write this
  -- field, not the one rolloutPaused/rolloutUnpaused share across app and
  -- target rows, so suspending a source can never clobber an unrelated
  -- rollout pause reason (or the reverse).
  source_suspended_reason TEXT NULL,
  partial_json TEXT NULL,
  failure_stage TEXT NULL CHECK (
    failure_stage IS NULL OR failure_stage IN (
      'fetch','validation','apply','create','recovery'
    )
  ),
  failure_class TEXT NULL,
  failure_at INTEGER NULL,
  retry_at INTEGER NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  suspended_at INTEGER NULL,
  recovery_ref TEXT NULL,
  recovery_phase TEXT NULL CHECK (
    recovery_phase IS NULL OR recovery_phase IN (
      'capturing','restoring','compensating','complete','failed'
    )
  ),
  interruption_stage TEXT NULL CHECK (
    interruption_stage IS NULL OR interruption_stage IN (
      'fetch_started','apply_started','deploy_started','recovery_started'
    )
  ),
  interruption_at INTEGER NULL,
  interruption_operation_id TEXT NULL,
  interruption_generation_id TEXT NULL,
  evidence_fresh_at INTEGER NULL,
  -- Why this row could not prove something, recorded at write time. Read-time
  -- limitations are derived; these are the ones only the writer knows.
  evidence_limitations_json TEXT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (target_mode != 'direct' OR (stack_name IS NOT NULL AND blueprint_id IS NULL)),
  CHECK (target_mode != 'inline_blueprint' OR (blueprint_id IS NOT NULL AND stack_name IS NULL AND configured_repo_url IS NULL)),
  CHECK (target_mode != 'blueprint' OR (blueprint_id IS NOT NULL AND stack_name IS NULL AND configured_repo_url IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gitops_app_active_direct
  ON gitops_applications(stack_name)
  WHERE lifecycle_status IN ('active','creating') AND target_mode = 'direct';
CREATE UNIQUE INDEX IF NOT EXISTS idx_gitops_app_active_blueprint_any
  ON gitops_applications(blueprint_id)
  WHERE lifecycle_status IN ('active','creating')
    AND target_mode IN ('inline_blueprint','blueprint');
CREATE INDEX IF NOT EXISTS idx_gitops_app_lifecycle_key
  ON gitops_applications(lifecycle_key);
CREATE INDEX IF NOT EXISTS idx_gitops_app_status
  ON gitops_applications(lifecycle_status);
-- The two unique indexes above are partial on the live rows, so neither serves
-- a lookup for a detached one. Without this the drift route's fallback is a
-- full scan and a sort. Direct only: Blueprint retirement writes 'deleted',
-- never 'detached', so the Blueprint equivalent would index an empty set.
CREATE INDEX IF NOT EXISTS idx_gitops_app_detached_direct
  ON gitops_applications(stack_name, updated_at DESC)
  WHERE lifecycle_status = 'detached' AND target_mode = 'direct';

CREATE TABLE IF NOT EXISTS gitops_generations (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  configured_ref TEXT NOT NULL,
  resolved_ref_kind TEXT NULL CHECK (
    resolved_ref_kind IS NULL OR resolved_ref_kind IN ('branch','tag','sha')
  ),
  repo_identity_json TEXT NOT NULL,
  manifest_version INTEGER NOT NULL,
  candidate_dir TEXT NOT NULL,
  applied_dir TEXT NOT NULL,
  expected_invocation_json TEXT NOT NULL,
  materialization_fingerprint TEXT NOT NULL,
  validation_ok INTEGER NOT NULL,
  plan_blocked INTEGER NOT NULL DEFAULT 0,
  change_plan_fingerprint TEXT NULL,
  operation_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  actor TEXT NULL,
  previous_generation_id TEXT NULL,
  redacted_limitations_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gitops_gen_app_created
  ON gitops_generations(application_id, created_at);
CREATE INDEX IF NOT EXISTS idx_gitops_gen_sha
  ON gitops_generations(commit_sha);
CREATE INDEX IF NOT EXISTS idx_gitops_gen_op
  ON gitops_generations(operation_id);
CREATE INDEX IF NOT EXISTS idx_gitops_gen_repo_ref
  ON gitops_generations(repo_url, configured_ref);

CREATE TABLE IF NOT EXISTS gitops_artifact_sets (
  id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL,
  evidence_version INTEGER NOT NULL,
  authoritative INTEGER NOT NULL DEFAULT 0,
  qualification TEXT NOT NULL CHECK (qualification IN (
    'unresolved','exact','qualified','stale','unavailable','local_build_unverified'
  )),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE (generation_id, evidence_version)
);
CREATE INDEX IF NOT EXISTS idx_gitops_artifact_gen
  ON gitops_artifact_sets(generation_id, evidence_version);

CREATE TABLE IF NOT EXISTS gitops_intent_revisions (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  blueprint_id INTEGER NOT NULL,
  compose_content_sha256 TEXT NOT NULL,
  blueprint_revision INTEGER NOT NULL,
  deploy_stack_name TEXT NOT NULL,
  selector_json TEXT NOT NULL,
  pinned_node_id INTEGER NULL,
  cordon_implications_json TEXT NOT NULL DEFAULT '[]',
  rollout_strategy_json TEXT NOT NULL DEFAULT '{}',
  runtime_drift_policy TEXT NULL,
  stateful_policy_json TEXT NULL,
  health_failure_rollback_policy_json TEXT NULL,
  operation_id TEXT NOT NULL,
  actor TEXT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gitops_intent_app_created
  ON gitops_intent_revisions(application_id, created_at);
CREATE INDEX IF NOT EXISTS idx_gitops_intent_blueprint
  ON gitops_intent_revisions(blueprint_id);
CREATE INDEX IF NOT EXISTS idx_gitops_intent_content
  ON gitops_intent_revisions(compose_content_sha256);

CREATE TABLE IF NOT EXISTS gitops_rollout_candidates (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  intent_revision_id TEXT NOT NULL,
  compose_content_sha256 TEXT NOT NULL,
  accepted_generation_id TEXT NULL,
  artifact_set_id TEXT NULL,
  required_targets_json TEXT NOT NULL,
  authoritative INTEGER NOT NULL DEFAULT 0,
  provenance TEXT NOT NULL CHECK (provenance IN (
    'intent_change','roster_change','legacy_inline'
  )),
  operation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gitops_rollout_app
  ON gitops_rollout_candidates(application_id, created_at);

CREATE TABLE IF NOT EXISTS gitops_approvals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN (
    'source_acceptance','placement_approval','rollout_authorization','legacy_combined'
  )),
  authority TEXT NOT NULL CHECK (authority IN (
    'operator','configured_policy','legacy_combined'
  )),
  authoritative INTEGER NOT NULL DEFAULT 0,
  application_id TEXT NOT NULL,
  generation_id TEXT NULL,
  intent_revision_id TEXT NULL,
  artifact_set_id TEXT NULL,
  rollout_candidate_id TEXT NULL,
  rollout_generation_id TEXT NULL,
  source_acceptance_ref TEXT NULL,
  placement_approval_ref TEXT NULL,
  required_targets_json TEXT NULL,
  preflight_fingerprint TEXT NULL,
  fingerprint TEXT NULL,
  blast_json TEXT NULL,
  policy_provenance_json TEXT NULL,
  actor TEXT NULL,
  created_at INTEGER NOT NULL,
  CHECK (
    kind != 'source_acceptance' OR (
      authoritative = 1
      AND authority IN ('operator','configured_policy')
      AND generation_id IS NOT NULL
    )
  ),
  CHECK (
    kind != 'placement_approval' OR (
      authoritative = 1
      AND authority IN ('operator','configured_policy')
      AND intent_revision_id IS NOT NULL
      AND blast_json IS NOT NULL
    )
  ),
  CHECK (
    kind != 'rollout_authorization' OR (
      authoritative = 1
      AND authority IN ('operator','configured_policy')
      AND generation_id IS NOT NULL
      AND artifact_set_id IS NOT NULL
      AND intent_revision_id IS NOT NULL
      AND rollout_candidate_id IS NOT NULL
      AND source_acceptance_ref IS NOT NULL
      AND placement_approval_ref IS NOT NULL
      AND required_targets_json IS NOT NULL
      AND preflight_fingerprint IS NOT NULL
    )
  ),
  CHECK (
    kind != 'legacy_combined' OR (
      authoritative = 0
      AND authority = 'legacy_combined'
    )
  )
);
CREATE INDEX IF NOT EXISTS idx_gitops_approval_app
  ON gitops_approvals(application_id, created_at);

CREATE TABLE IF NOT EXISTS gitops_target_current (
  application_id TEXT NOT NULL,
  node_id INTEGER NOT NULL,
  target_status TEXT NOT NULL CHECK (target_status IN ('active','tombstoned')),
  desired_generation_id TEXT NULL,
  candidate_generation_id TEXT NULL,
  applied_generation_id TEXT NULL,
  deployed_generation_id TEXT NULL,
  healthy_generation_id TEXT NULL,
  lkg_generation_id TEXT NULL,
  lkg_artifact_set_id TEXT NULL,
  lkg_unavailable_at INTEGER NULL,
  lkg_unavailable_reason TEXT NULL CHECK (
    lkg_unavailable_reason IS NULL OR lkg_unavailable_reason IN (
      'generation_missing','recovery_unretainable'
    )
  ),
  expected_artifact_set_id TEXT NULL,
  latest_artifact_set_id TEXT NULL,
  observed_artifact_identity_json TEXT NULL,
  intent_revision_id TEXT NULL,
  rollout_candidate_id TEXT NULL,
  rollout_generation_id TEXT NULL,
  source_acceptance_ref TEXT NULL,
  placement_approval_ref TEXT NULL,
  rollout_authorization_ref TEXT NULL,
  legacy_combined_approval_ref TEXT NULL,
  legacy_applied_revision INTEGER NULL,
  connectivity TEXT NULL CHECK (
    connectivity IS NULL OR connectivity IN ('unknown','reachable','unreachable','stale')
  ),
  latest_stage TEXT NULL,
  active_operation_id TEXT NULL,
  active_operation_stage TEXT NULL CHECK (
    active_operation_stage IS NULL OR active_operation_stage IN (
      'deploy_started','blueprint_deploy_started','blueprint_withdraw_started','recovery_started'
    )
  ),
  active_operation_at INTEGER NULL,
  active_generation_id TEXT NULL,
  active_intent_revision_id TEXT NULL,
  active_rollout_candidate_id TEXT NULL,
  failure_stage TEXT NULL CHECK (
    failure_stage IS NULL OR failure_stage IN (
      'deploy','recovery','blueprint_deploy','blueprint_withdraw'
    )
  ),
  failure_class TEXT NULL,
  failure_at INTEGER NULL,
  recovery_ref TEXT NULL,
  recovery_generation_id TEXT NULL,
  recovery_phase TEXT NULL CHECK (
    recovery_phase IS NULL OR recovery_phase IN (
      'capturing','restoring','compensating','complete','failed'
    )
  ),
  interruption_stage TEXT NULL CHECK (
    interruption_stage IS NULL OR interruption_stage IN (
      'deploy_started','blueprint_deploy_started','blueprint_withdraw_started','recovery_started'
    )
  ),
  interruption_at INTEGER NULL,
  interruption_operation_id TEXT NULL,
  interruption_generation_id TEXT NULL,
  interruption_intent_revision_id TEXT NULL,
  interruption_rollout_candidate_id TEXT NULL,
  pause_at INTEGER NULL,
  pause_reason TEXT NULL,
  retry_at INTEGER NULL,
  suspended_at INTEGER NULL,
  partial_json TEXT NULL,
  -- Why this target could not prove something, recorded at write time.
  evidence_limitations_json TEXT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (application_id, node_id),
  CHECK (
    (lkg_unavailable_at IS NULL AND lkg_unavailable_reason IS NULL)
    OR (lkg_unavailable_at IS NOT NULL AND lkg_unavailable_reason IS NOT NULL)
  ),
  CHECK (
    lkg_unavailable_at IS NULL
    OR (lkg_generation_id IS NULL AND lkg_artifact_set_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_gitops_target_status
  ON gitops_target_current(target_status);
CREATE INDEX IF NOT EXISTS idx_gitops_target_node
  ON gitops_target_current(node_id);

CREATE TABLE IF NOT EXISTS gitops_history (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  application_id TEXT NOT NULL,
  target_mode TEXT NOT NULL,
  lifecycle_key TEXT NOT NULL,
  stack_name TEXT NULL,
  blueprint_id INTEGER NULL,
  node_id INTEGER NULL,
  dedupe_target TEXT NOT NULL,
  repo_url TEXT NULL,
  configured_ref TEXT NULL,
  repo_identity_json TEXT NULL,
  commit_sha TEXT NULL,
  generation_id TEXT NULL,
  artifact_set_id TEXT NULL,
  intent_revision_id TEXT NULL,
  rollout_candidate_id TEXT NULL,
  rollout_generation_id TEXT NULL,
  source_acceptance_ref TEXT NULL,
  placement_approval_ref TEXT NULL,
  rollout_authorization_ref TEXT NULL,
  legacy_combined_approval_ref TEXT NULL,
  operation_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'committed','failed','skipped','superseded','recovered','unknown'
  )),
  trigger TEXT NOT NULL,
  actor TEXT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  required_targets_json TEXT NULL,
  validation_json TEXT NULL,
  per_target_results_json TEXT NULL,
  health_run_id TEXT NULL,
  health_snapshot_json TEXT NULL,
  invocation_observed_json TEXT NULL,
  recovery_ref TEXT NULL,
  redacted_reason_class TEXT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gitops_history_dedupe
  ON gitops_history(application_id, operation_id, stage, dedupe_target);
CREATE INDEX IF NOT EXISTS idx_gitops_history_app_created
  ON gitops_history(application_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_gitops_history_sha ON gitops_history(commit_sha);
CREATE INDEX IF NOT EXISTS idx_gitops_history_gen ON gitops_history(generation_id);
CREATE INDEX IF NOT EXISTS idx_gitops_history_artifact ON gitops_history(artifact_set_id);
CREATE INDEX IF NOT EXISTS idx_gitops_history_blueprint ON gitops_history(blueprint_id);
CREATE INDEX IF NOT EXISTS idx_gitops_history_rollout ON gitops_history(rollout_candidate_id);
CREATE INDEX IF NOT EXISTS idx_gitops_history_rollout_gen ON gitops_history(rollout_generation_id);
CREATE INDEX IF NOT EXISTS idx_gitops_history_node ON gitops_history(node_id);
CREATE INDEX IF NOT EXISTS idx_gitops_history_trigger ON gitops_history(trigger);
CREATE INDEX IF NOT EXISTS idx_gitops_history_actor ON gitops_history(actor);
CREATE INDEX IF NOT EXISTS idx_gitops_history_outcome ON gitops_history(outcome);
CREATE INDEX IF NOT EXISTS idx_gitops_history_repo_ref
  ON gitops_history(repo_url, configured_ref);
CREATE INDEX IF NOT EXISTS idx_gitops_history_stack_created
  ON gitops_history(stack_name, created_at DESC, id DESC);
-- Serves the cross-stack history page, whose ordering and cursor are on
-- (created_at, id) with no other filter. Every other index here leads with a
-- different column, so without this one that route sorts the whole table.
CREATE INDEX IF NOT EXISTS idx_gitops_history_created
  ON gitops_history(created_at DESC, id DESC);
`;
