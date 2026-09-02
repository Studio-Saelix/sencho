/**
 * Shared GitOps row fixtures for route and projection tests.
 *
 * Type-only imports, so this module pulls no service in at load time and stays
 * safe to import statically from a test file whose singletons are only wired up
 * once setupTestDb has run.
 */
import type { GitOpsApplicationRow } from '../../services/gitops/types';

/**
 * A minimal live Direct application row.
 *
 * Every column is spelled out because the row type mirrors the table, so a
 * partial object would not type-check and a cast would let a schema change land
 * without a compile error here. Only the identifiers vary between tests; the
 * rest is the quiet, freshly activated state a Direct attachment starts in.
 */
export function directApplicationFixture(id: string, stackName: string): GitOpsApplicationRow {
    const now = Date.now();
    return {
        id,
        lifecycle_key: `direct:${stackName}`,
        lifecycle_status: 'active',
        target_mode: 'direct',
        stack_name: stackName,
        blueprint_id: null,
        configured_repo_url: 'https://github.com/example/repo.git',
        repo_identity_json: '{"host":"github.com","pathname":"/example/repo.git"}',
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
        source_suspended_reason: null,
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
        created_at: now,
        updated_at: now,
    };
}
