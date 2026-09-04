/**
 * Durable reconcile-attempt reservation and settlement: a bare history
 * insert in its own transaction, never through mutateApp, so a reservation
 * writes no application-row state and can be safely repeated.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions, type EventEnvelope } from '../services/gitops/transitions';
import { DatabaseService } from '../services/DatabaseService';
import type { GitOpsApplicationRow } from '../services/gitops/types';

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  GitOpsStore.resetForTests();
  GitOpsTransitions.resetForTests();
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

describe('reconcile attempt reservation and settlement', () => {
  it('reserves an attempt without touching application state', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-res', 'res-web'), nodeId: 1, envelope: env('op-act-res') });
    const before = store.getApplication('app-res')!;

    const result = tx.reserveReconcileAttempt('app-res', env('op-res-1'));

    expect(result.reserved).toBe(true);
    const after = store.getApplication('app-res')!;
    expect(after.updated_at).toBe(before.updated_at);
    expect(after.desired_commit_sha).toBe(before.desired_commit_sha);
  });

  it('returns reserved: false on a repeated reservation for the same operation', () => {
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-res2', 'res2-web'), nodeId: 1, envelope: env('op-act-res2') });

    const first = tx.reserveReconcileAttempt('app-res2', env('op-res2-1'));
    const second = tx.reserveReconcileAttempt('app-res2', env('op-res2-1'));

    expect(first.reserved).toBe(true);
    expect(second.reserved).toBe(false);
  });

  it('allows two different operations to each reserve their own attempt', () => {
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-res3', 'res3-web'), nodeId: 1, envelope: env('op-act-res3') });

    const first = tx.reserveReconcileAttempt('app-res3', env('op-res3-a'));
    const second = tx.reserveReconcileAttempt('app-res3', env('op-res3-b'));

    expect(first.reserved).toBe(true);
    expect(second.reserved).toBe(true);
  });

  it('settles a reserved attempt and finds it by operation id afterward', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-settle', 'settle-web'), nodeId: 1, envelope: env('op-act-settle') });
    tx.reserveReconcileAttempt('app-settle', env('op-settle-1'));

    const settleResult = tx.settleReconcileAttempt('app-settle', env('op-settle-1'), {
      outcome: 'no_source_change',
      reason: 'Nothing new to fetch.',
      nextAction: 'none',
    });

    expect(settleResult.settled).toBe(true);
    const settled = store.getSettledAttempt('app-settle', 'op-settle-1');
    expect(settled).toBeDefined();
  });

  it('settling twice for the same operation is a no-op the second time', () => {
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-settle2', 'settle2-web'), nodeId: 1, envelope: env('op-act-settle2') });
    tx.reserveReconcileAttempt('app-settle2', env('op-settle2-1'));

    const first = tx.settleReconcileAttempt('app-settle2', env('op-settle2-1'), {
      outcome: 'no_source_change',
      reason: 'first',
      nextAction: 'none',
    });
    const second = tx.settleReconcileAttempt('app-settle2', env('op-settle2-1'), {
      outcome: 'no_source_change',
      reason: 'second, must not overwrite',
      nextAction: 'none',
    });

    expect(first.settled).toBe(true);
    expect(second.settled).toBe(false);
  });

  it('has no settled attempt for a reservation that was never settled', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-orphan', 'orphan-web'), nodeId: 1, envelope: env('op-act-orphan') });
    tx.reserveReconcileAttempt('app-orphan', env('op-orphan-1'));

    expect(store.getSettledAttempt('app-orphan', 'op-orphan-1')).toBeUndefined();
  });

  it('lists an unsettled reservation but not one that has settled', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-unsettled', 'unsettled-web'), nodeId: 1, envelope: env('op-act-unsettled') });
    tx.reserveReconcileAttempt('app-unsettled', env('op-unsettled-orphan'));
    tx.reserveReconcileAttempt('app-unsettled', env('op-unsettled-done'));
    tx.settleReconcileAttempt('app-unsettled', env('op-unsettled-done'), {
      outcome: 'no_source_change',
      reason: 'done',
      nextAction: 'none',
    });

    const unsettled = store.listUnsettledReconcileAttempts();
    const operationIds = unsettled.filter((r) => r.application_id === 'app-unsettled').map((r) => r.operation_id);
    expect(operationIds).toContain('op-unsettled-orphan');
    expect(operationIds).not.toContain('op-unsettled-done');
  });

  it('allocates a fresh attemptSeq-derived operation id and reserves it in one transaction', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-alloc', 'alloc-web'), nodeId: 1, envelope: env('op-act-alloc') });
    const before = store.getApplication('app-alloc')!;

    const first = tx.allocateReconcileAttempt('app-alloc', 'tester', 'manual', Date.now());
    const second = tx.allocateReconcileAttempt('app-alloc', 'tester', 'manual', Date.now());

    expect(first.reserved).toBe(true);
    expect(second.reserved).toBe(true);
    expect(first.operationId).not.toBe(second.operationId);
    const after = store.getApplication('app-alloc')!;
    expect(after.attempt_seq).toBe(before.attempt_seq + 2);
  });

  it('records a follower link on a reservation made on behalf of a coalesced request', () => {
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-follower', 'follower-web'), nodeId: 1, envelope: env('op-act-follower') });

    const leader = tx.allocateReconcileAttempt('app-follower', 'tester', 'manual', Date.now());
    const follower = tx.allocateReconcileAttempt('app-follower', 'tester', 'manual', Date.now(), leader.operationId);

    expect(follower.reserved).toBe(true);
    const started = DatabaseService.getInstance().getDb()
      .prepare("SELECT after_json FROM gitops_history WHERE application_id = ? AND operation_id = ? AND stage = 'source_reconcile_started'")
      .get('app-follower', follower.operationId) as { after_json: string };
    expect(JSON.parse(started.after_json)).toEqual({ followerOf: leader.operationId });
  });

  it('reports the most recently settled attempt even when both share the same millisecond timestamp', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-latest', 'latest-web'), nodeId: 1, envelope: env('op-act-latest') });
    // Same `at` on purpose: created_at alone cannot tell these two apart,
    // so the query must break the tie by insertion order (rowid), not the
    // id column, which is a random UUID unrelated to recency.
    const sameInstant = 5_000;
    tx.reserveReconcileAttempt('app-latest', { operationId: 'op-latest-1', actor: 'tester', trigger: 'manual', at: sameInstant });
    tx.settleReconcileAttempt(
      'app-latest',
      { operationId: 'op-latest-1', actor: 'tester', trigger: 'manual', at: sameInstant },
      { outcome: 'no_source_change', reason: 'first', nextAction: 'none' },
    );
    tx.reserveReconcileAttempt('app-latest', { operationId: 'op-latest-2', actor: 'tester', trigger: 'manual', at: sameInstant });
    tx.settleReconcileAttempt(
      'app-latest',
      { operationId: 'op-latest-2', actor: 'tester', trigger: 'manual', at: sameInstant },
      { outcome: 'retry_scheduled', reason: 'second', nextAction: 'none' },
    );

    const latest = store.latestSettledAttempt('app-latest');
    expect(latest?.operation_id).toBe('op-latest-2');
  });
});

describe('poll and retry eligibility queries', () => {
  it('lists a source whose next_poll_at has arrived', () => {
    const store = GitOpsStore.getInstance();
    store.insertApplication({ ...app('app-poll-due', 'poll-due-web'), next_poll_at: 1_000 });
    const due = store.listSourcesDueForPoll(1_000);
    expect(due.map((a) => a.id)).toContain('app-poll-due');
  });

  it('excludes a source whose next_poll_at has not arrived yet', () => {
    const store = GitOpsStore.getInstance();
    store.insertApplication({ ...app('app-poll-future', 'poll-future-web'), next_poll_at: 5_000 });
    const due = store.listSourcesDueForPoll(1_000);
    expect(due.map((a) => a.id)).not.toContain('app-poll-future');
  });

  it('excludes a suspended source even when its poll time has arrived', () => {
    const store = GitOpsStore.getInstance();
    store.insertApplication({ ...app('app-poll-susp', 'poll-susp-web'), next_poll_at: 1_000, suspended_at: 500 });
    const due = store.listSourcesDueForPoll(1_000);
    expect(due.map((a) => a.id)).not.toContain('app-poll-susp');
  });

  it('excludes a source with an operation already in flight', () => {
    const store = GitOpsStore.getInstance();
    store.insertApplication({
      ...app('app-poll-busy', 'poll-busy-web'),
      next_poll_at: 1_000,
      active_operation_stage: 'fetch_started',
    });
    const due = store.listSourcesDueForPoll(1_000);
    expect(due.map((a) => a.id)).not.toContain('app-poll-busy');
  });

  it('excludes a Blueprint-mode application from polling', () => {
    const store = GitOpsStore.getInstance();
    store.insertApplication({
      ...app('app-poll-bp', 'unused-bp'),
      stack_name: null,
      blueprint_id: 42,
      target_mode: 'blueprint',
      configured_repo_url: 'https://github.com/org/repo.git',
      next_poll_at: 1_000,
    });
    const due = store.listSourcesDueForPoll(1_000);
    expect(due.map((a) => a.id)).not.toContain('app-poll-bp');
  });

  it('lists an application whose retry_at has arrived', () => {
    const store = GitOpsStore.getInstance();
    store.insertApplication({ ...app('app-retry-due', 'retry-due-web'), retry_at: 1_000 });
    const due = store.listApplicationsDueForRetry(1_000);
    expect(due.map((a) => a.id)).toContain('app-retry-due');
  });

  it('excludes an application with no retry scheduled', () => {
    const store = GitOpsStore.getInstance();
    store.insertApplication(app('app-retry-none', 'retry-none-web'));
    const due = store.listApplicationsDueForRetry(1_000);
    expect(due.map((a) => a.id)).not.toContain('app-retry-none');
  });

  it('excludes a suspended application even when its retry time has arrived', () => {
    const store = GitOpsStore.getInstance();
    store.insertApplication({ ...app('app-retry-susp', 'retry-susp-web'), retry_at: 1_000, suspended_at: 500 });
    const due = store.listApplicationsDueForRetry(1_000);
    expect(due.map((a) => a.id)).not.toContain('app-retry-susp');
  });
});

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
