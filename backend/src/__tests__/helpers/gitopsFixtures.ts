/**
 * Shared GitOps row fixtures for route and projection tests.
 *
 * Type-only imports, so this module pulls no service in at load time and stays
 * safe to import statically from a test file whose singletons are only wired up
 * once setupTestDb has run.
 */
import type { GitOpsApplicationRow } from '../../services/gitops/types';
import { DEFAULT_PLACEMENT_POLICY, DEFAULT_ROLLOUT_AUTHORIZATION_POLICY } from '../../services/gitops/policyComposition';

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
        configured_source_stack_name: null,
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
        pause_origin: 'operator',
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
        created_at: now,
        updated_at: now,
    };
}

/**
 * A minimal live Inline Blueprint application row.
 *
 * The Blueprint shape rather than the Direct one, and the difference is
 * load-bearing rather than cosmetic. A Blueprint application is stored without
 * a stack identity (the reconciler materializes each Blueprint as a stack
 * directory of the Blueprint's name), so the row carries a Blueprint id, a null
 * stack name, and no configured source at all; a test that reused the Direct
 * fixture with a Blueprint mode would build a row the schema cannot hold.
 *
 * Spread from the Direct fixture so the column list lives in one place, with
 * every field whose value is mode-specific spelled out. A Direct source
 * fingerprint and compose path are not merely defaults here: a Blueprint
 * revision names neither until an intent revision describes the content.
 */
export function blueprintApplicationFixture(id: string, blueprintId: number): GitOpsApplicationRow {
    const now = Date.now();
    return {
        ...directApplicationFixture(id, `${id}-unused-stack`),
        lifecycle_key: `blueprint:${blueprintId}`,
        target_mode: 'inline_blueprint',
        stack_name: null,
        blueprint_id: blueprintId,
        configured_repo_url: null,
        repo_identity_json: null,
        configured_ref: null,
        compose_paths_json: null,
        materialization_fingerprint: null,
        created_at: now,
        updated_at: now,
    };
}
