import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions } from '../services/gitops/transitions';
import {
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
  HISTORY_SCAN_CAP,
  decodeHistoryCursor,
  encodeHistoryCursor,
  insertHistory,
  queryHistoryRows,
  toHistoryItem,
} from '../services/gitops/history';
import { parseHistoryFilters, parseLimit } from '../helpers/gitopsHistoryPage';
import {
  classifyHistoryRow,
  classifySourceRow,
  normalizeStackResourcePresent,
} from '../services/gitops/readAuth';
import type { GitOpsApplicationRow, GitOpsHistoryRow } from '../services/gitops/types';

describe('gitops history read layer', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    GitOpsStore.resetForTests();
    GitOpsTransitions.resetForTests();
    seedHistory();
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  describe('cursor', () => {
    const SAMPLE_ID = '0b3f4a1c-8d2e-4c7b-9f10-5a6b7c8d9e0f';

    it('round-trips a created_at and id pair', () => {
      const encoded = encodeHistoryCursor({ createdAt: 1700, id: SAMPLE_ID });
      expect(decodeHistoryCursor(encoded)).toEqual({ createdAt: 1700, id: SAMPLE_ID });
    });

    it('rejects malformed cursors rather than guessing a position', () => {
      expect(decodeHistoryCursor('')).toBeNull();
      expect(decodeHistoryCursor('nodot')).toBeNull();
      expect(decodeHistoryCursor(`.${SAMPLE_ID}`)).toBeNull();
      expect(decodeHistoryCursor('123.')).toBeNull();
      expect(decodeHistoryCursor(`notanumber.${SAMPLE_ID}`)).toBeNull();
      expect(decodeHistoryCursor(`-5.${SAMPLE_ID}`)).toBeNull();
    });

    it('rejects an id that is not a real row id', () => {
      // A truncated cursor is the likely case, and an unvalidated id would not
      // fail: it would shift the page boundary and quietly drop or repeat rows.
      expect(decodeHistoryCursor(`1700.${SAMPLE_ID.slice(0, 12)}`)).toBeNull();
      expect(decodeHistoryCursor('1700.not-a-uuid')).toBeNull();
      expect(decodeHistoryCursor(`1700.${SAMPLE_ID.toUpperCase()}`)).toBeNull();
    });

    it('accepts the cursor it emits for a stored row', () => {
      const row = query({ commitSha: 'sha-b' })[0] as GitOpsHistoryRow;
      const encoded = encodeHistoryCursor({ createdAt: row.created_at, id: row.id });
      expect(decodeHistoryCursor(encoded)).toEqual({ createdAt: row.created_at, id: row.id });
    });
  });

  describe('queryHistoryRows', () => {
    it('returns newest first', () => {
      const rows = query({ stackName: 'history-web' });
      expect(rows.map(r => r.commit_sha)).toEqual(['sha-c', 'sha-b', 'sha-a']);
    });

    // Every filter is asserted to reach the right column. A wrong column name
    // is not a subtly wrong page, it is a "no such column" throw at query
    // time, so an untested filter is a 500 waiting behind any link carrying it.
    it.each([
      ['applicationId', { applicationId: 'app-history' }, 'sha-b'],
      ['stackName', { stackName: 'history-web' }, 'sha-b'],
      ['repoIdentity', { repoIdentity: 'https://github.com/org/repo.git' }, 'sha-b'],
      ['configuredRef', { configuredRef: 'main' }, 'sha-b'],
      ['commitSha', { commitSha: 'sha-b' }, 'sha-b'],
      ['nodeId', { nodeId: 7 }, 'sha-b'],
      ['trigger', { trigger: 'webhook' }, 'sha-b'],
      ['actor', { actor: 'operator-2' }, 'sha-b'],
      ['outcome', { outcome: 'failed' as const }, 'sha-c'],
      ['rolloutCandidateId', { rolloutCandidateId: 'cand-1' }, 'sha-c'],
    ])('routes the %s filter to its own column', (_name, filters, expectedSha) => {
      const rows = query(filters);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.map(r => r.commit_sha)).toContain(expectedSha);
    });

    it('accepts the identity filters that match nothing in this fixture', () => {
      // Exercises the remaining column names so a typo still throws here.
      expect(query({ generationId: 'gen-absent' })).toHaveLength(0);
      expect(query({ artifactSetId: 'artifact-absent' })).toHaveLength(0);
      expect(query({ blueprintId: 4242 })).toHaveLength(0);
      expect(query({ rolloutGenerationId: 'rollout-gen-absent' })).toHaveLength(0);
    });

    it('narrows to the requested row rather than merely returning one', () => {
      const byNode = query({ nodeId: 7 });
      expect(byNode).toHaveLength(1);
      expect(byNode[0]?.commit_sha).toBe('sha-b');
      expect(query({ stackName: 'no-such-stack' })).toHaveLength(0);
    });

    it('never matches a rollout candidate id as a rollout generation id', () => {
      // The candidate is a proposal; a generation is a dispatch that ran.
      // Answering the generation filter from the candidate column would report
      // a rollout that never happened.
      expect(query({ rolloutCandidateId: 'cand-1' })).toHaveLength(1);
      expect(query({ rolloutGenerationId: 'cand-1' })).toHaveLength(0);
    });

    it('pages past the cursor without repeating a row', () => {
      const first = query({ stackName: 'history-web' }, null, 2);
      expect(first).toHaveLength(2);
      const last = first[1] as GitOpsHistoryRow;
      const second = query({ stackName: 'history-web' }, { createdAt: last.created_at, id: last.id }, 2);
      expect(second).toHaveLength(1);
      expect(second[0]?.id).not.toBe(last.id);
      expect(second[0]?.commit_sha).toBe('sha-a');
    });

    it('separates rows sharing one millisecond by id', () => {
      const sameMs = query({ commitSha: 'sha-tie' });
      expect(sameMs).toHaveLength(2);
      const [newer, older] = sameMs as [GitOpsHistoryRow, GitOpsHistoryRow];
      expect(newer.id > older.id).toBe(true);
      const after = query({ commitSha: 'sha-tie' }, { createdAt: newer.created_at, id: newer.id }, 10);
      expect(after.map(r => r.id)).toEqual([older.id]);
    });
  });

  describe('toHistoryItem', () => {
    it('exposes the producer delta as before and after', () => {
      const row = query({ commitSha: 'sha-b' })[0] as GitOpsHistoryRow;
      const item = toHistoryItem(row);
      expect(item.before).toEqual({ desiredCommitSha: null });
      expect(item.after).toEqual({ desiredCommitSha: 'sha-b' });
      expect(item.limitations).toEqual([]);
      expect(item.stage).toBe('fetched');
    });

    it('keeps identity and stage when the recorded delta cannot be read', () => {
      const row = query({ commitSha: 'sha-a' })[0] as GitOpsHistoryRow;
      const corrupt: GitOpsHistoryRow = { ...row, after_json: '{not json' };
      const item = toHistoryItem(corrupt);
      expect(item.after).toBeNull();
      expect(item.stage).toBe(row.stage);
      expect(item.applicationId).toBe(row.application_id);
      expect(item.limitations).toEqual([
        {
          code: 'history_json_invalid',
          message: 'Recorded change detail for this entry could not be read.',
          evidence: { before: false, after: true },
        },
      ]);
    });

    it('treats a non-object payload as unreadable', () => {
      const row = query({ commitSha: 'sha-a' })[0] as GitOpsHistoryRow;
      const item = toHistoryItem({ ...row, before_json: '"a string"' });
      expect(item.before).toBeNull();
      expect(item.limitations[0]?.code).toBe('history_json_invalid');
    });

    it('maps every identity column to its own field', () => {
      // The four approval refs are same-typed and same-shaped, so a swap
      // between them is invisible without asserting each one individually.
      const row = query({ commitSha: 'sha-b' })[0] as GitOpsHistoryRow;
      const populated: GitOpsHistoryRow = {
        ...row,
        generation_id: 'gen-x',
        artifact_set_id: 'art-x',
        intent_revision_id: 'intent-x',
        rollout_candidate_id: 'cand-x',
        rollout_generation_id: 'rgen-x',
        source_acceptance_ref: 'ref-source',
        placement_approval_ref: 'ref-placement',
        rollout_authorization_ref: 'ref-rollout',
        legacy_combined_approval_ref: 'ref-legacy',
        blueprint_id: 11,
      };
      const item = toHistoryItem(populated);
      expect(item).toMatchObject({
        id: row.id,
        createdAt: row.created_at,
        applicationId: row.application_id,
        targetMode: row.target_mode,
        stackName: row.stack_name,
        blueprintId: 11,
        nodeId: row.node_id,
        commitSha: row.commit_sha,
        generationId: 'gen-x',
        artifactSetId: 'art-x',
        intentRevisionId: 'intent-x',
        rolloutCandidateId: 'cand-x',
        rolloutGenerationId: 'rgen-x',
        operationId: row.operation_id,
        stage: row.stage,
        outcome: row.outcome,
        trigger: row.trigger,
        actor: row.actor,
        approvals: {
          sourceAcceptanceRef: 'ref-source',
          placementApprovalRef: 'ref-placement',
          rolloutAuthorizationRef: 'ref-rollout',
          legacyCombinedApprovalRef: 'ref-legacy',
        },
      });
    });
  });

  describe('stackResourcePresent validation', () => {
    it('accepts only a real boolean true', () => {
      expect(normalizeStackResourcePresent(true)).toBe(true);
      expect(normalizeStackResourcePresent(false)).toBe(false);
      expect(normalizeStackResourcePresent('true')).toBe(false);
      expect(normalizeStackResourcePresent(1)).toBe(false);
      expect(normalizeStackResourcePresent(null)).toBe(false);
      expect(normalizeStackResourcePresent(undefined)).toBe(false);
    });
  });

  describe('source-row classifier', () => {
    const revision = (lifecycleStatus: unknown): Record<string, unknown> => ({
      schemaVersion: 1,
      targetMode: 'direct',
      lifecycleStatus,
    });

    it('authorizes a live present stack by stack read', () => {
      expect(classifySourceRow({
        stackName: 'web',
        gitopsRevision: revision('active'),
        stackResourcePresent: true,
      })).toEqual({ kind: 'stack_read', stackName: 'web' });
    });

    it('authorizes a detached stack whose resource is present', () => {
      expect(classifySourceRow({
        stackName: 'web',
        gitopsRevision: revision('detached'),
        stackResourcePresent: true,
      })).toEqual({ kind: 'stack_read', stackName: 'web' });
    });

    it('falls back to Admin for every unprovable row', () => {
      const admin = { kind: 'admin' };
      expect(classifySourceRow({ stackName: '', gitopsRevision: revision('active'), stackResourcePresent: true })).toEqual(admin);
      expect(classifySourceRow({ stackName: null, gitopsRevision: revision('active'), stackResourcePresent: true })).toEqual(admin);
      expect(classifySourceRow({ stackName: 'web', gitopsRevision: null, stackResourcePresent: true })).toEqual(admin);
      expect(classifySourceRow({ stackName: 'web', gitopsRevision: 'nope', stackResourcePresent: true })).toEqual(admin);
      expect(classifySourceRow({ stackName: 'web', gitopsRevision: revision(undefined), stackResourcePresent: true })).toEqual(admin);
      expect(classifySourceRow({ stackName: 'web', gitopsRevision: revision('deleted'), stackResourcePresent: true })).toEqual(admin);
      expect(classifySourceRow({ stackName: 'web', gitopsRevision: revision('creating'), stackResourcePresent: true })).toEqual(admin);
      expect(classifySourceRow({ stackName: 'web', gitopsRevision: revision('active'), stackResourcePresent: false })).toEqual(admin);
      expect(classifySourceRow({ stackName: 'web', gitopsRevision: revision('active'), stackResourcePresent: 'yes' })).toEqual(admin);
    });

    it('sends a stack with no GitOps application to Admin', () => {
      // The not_applicable projection carries no lifecycleStatus at all.
      expect(classifySourceRow({
        stackName: 'web',
        gitopsRevision: { schemaVersion: 1, targetMode: 'not_applicable', applicationId: null },
        stackResourcePresent: true,
      })).toEqual({ kind: 'admin' });
    });
  });

  describe('history-row classifier', () => {
    it('authorizes from the application lifecycle, not the recorded delta', () => {
      expect(classifyHistoryRow({
        stackName: 'web',
        applicationLifecycleStatus: 'active',
        stackResourcePresent: true,
      })).toEqual({ kind: 'stack_read', stackName: 'web' });
    });

    it('falls back to Admin for every unprovable row', () => {
      const admin = { kind: 'admin' };
      expect(classifyHistoryRow({ stackName: null, applicationLifecycleStatus: 'active', stackResourcePresent: true })).toEqual(admin);
      expect(classifyHistoryRow({ stackName: '', applicationLifecycleStatus: 'active', stackResourcePresent: true })).toEqual(admin);
      expect(classifyHistoryRow({ stackName: 'web', applicationLifecycleStatus: undefined, stackResourcePresent: true })).toEqual(admin);
      expect(classifyHistoryRow({ stackName: 'web', applicationLifecycleStatus: 'deleted', stackResourcePresent: true })).toEqual(admin);
      expect(classifyHistoryRow({ stackName: 'web', applicationLifecycleStatus: 'creating', stackResourcePresent: true })).toEqual(admin);
      expect(classifyHistoryRow({ stackName: 'web', applicationLifecycleStatus: 'active', stackResourcePresent: false })).toEqual(admin);
    });
  });

  it('honours the scan cap as the query bound', () => {
    // Asserts the cap is actually applied to the read, not merely declared.
    expect(query({}, null, HISTORY_SCAN_CAP).length).toBeLessThanOrEqual(HISTORY_SCAN_CAP);
    expect(query({}, null, 1)).toHaveLength(1);
  });

  describe('filter and limit parsing', () => {
    it('reads every supported filter off the query string', () => {
      const parsed = parseHistoryFilters({
        applicationId: 'app-1',
        repoIdentity: 'https://github.com/org/repo.git',
        configuredRef: 'main',
        commitSha: 'sha-1',
        generationId: 'gen-1',
        artifactSetId: 'art-1',
        blueprintId: '9',
        rolloutCandidateId: 'cand-1',
        rolloutGenerationId: 'rgen-1',
        nodeId: '3',
        trigger: 'manual',
        actor: 'operator',
        outcome: 'failed',
      });
      if (!parsed.ok) throw new Error(parsed.message);
      expect(parsed.filters).toEqual({
        applicationId: 'app-1',
        repoIdentity: 'https://github.com/org/repo.git',
        configuredRef: 'main',
        commitSha: 'sha-1',
        generationId: 'gen-1',
        artifactSetId: 'art-1',
        blueprintId: 9,
        rolloutCandidateId: 'cand-1',
        rolloutGenerationId: 'rgen-1',
        nodeId: 3,
        trigger: 'manual',
        actor: 'operator',
        outcome: 'failed',
      });
    });

    it('never takes stackName from the caller', () => {
      const parsed = parseHistoryFilters({ stackName: 'somebody-elses-stack' });
      if (!parsed.ok) throw new Error(parsed.message);
      expect(parsed.filters.stackName).toBeUndefined();
    });

    it('rejects a recognized filter with an unusable value', () => {
      expect(parseHistoryFilters({ outcome: 'success' })).toEqual({
        ok: false,
        message: expect.stringContaining('outcome'),
      });
      expect(parseHistoryFilters({ nodeId: 'abc' })).toEqual({
        ok: false,
        message: expect.stringContaining('nodeId'),
      });
      expect(parseHistoryFilters({ blueprintId: '1.5' })).toEqual({
        ok: false,
        message: expect.stringContaining('blueprintId'),
      });
    });

    it('clamps the page size and falls back for nonsense', () => {
      expect(parseLimit('5000')).toBe(HISTORY_MAX_LIMIT);
      expect(parseLimit('10')).toBe(10);
      expect(parseLimit(undefined)).toBe(HISTORY_DEFAULT_LIMIT);
      expect(parseLimit('0')).toBe(HISTORY_DEFAULT_LIMIT);
      expect(parseLimit('-1')).toBe(HISTORY_DEFAULT_LIMIT);
      expect(parseLimit('abc')).toBe(HISTORY_DEFAULT_LIMIT);
    });
  });
});

function query(
  filters: Parameters<typeof queryHistoryRows>[1],
  cursor: Parameters<typeof queryHistoryRows>[2] = null,
  limit = 50,
): GitOpsHistoryRow[] {
  return queryHistoryRows(DatabaseService.getInstance().getDb(), filters, cursor, limit);
}

function seedHistory(): void {
  const db = DatabaseService.getInstance().getDb();
  const base = application();
  insertHistory(db, {
    application: base,
    nodeId: 1,
    dedupeTarget: 'app',
    operationId: 'op-a',
    stage: 'application_activated',
    outcome: 'committed',
    trigger: 'manual',
    actor: 'operator-1',
    before: { lifecycleStatus: null },
    after: { lifecycleStatus: 'active', targetMode: 'direct' },
    commitSha: 'sha-a',
    at: 1000,
  });
  insertHistory(db, {
    application: base,
    nodeId: 7,
    dedupeTarget: 'app',
    operationId: 'op-b',
    stage: 'fetched',
    outcome: 'committed',
    trigger: 'webhook',
    actor: 'operator-2',
    before: { desiredCommitSha: null },
    after: { desiredCommitSha: 'sha-b' },
    commitSha: 'sha-b',
    at: 2000,
  });
  insertHistory(db, {
    application: { ...base, rollout_candidate_id: 'cand-1' },
    nodeId: 1,
    dedupeTarget: 'app',
    operationId: 'op-c',
    stage: 'apply_failed',
    outcome: 'failed',
    trigger: 'manual',
    actor: 'operator-1',
    before: {},
    after: { failureClass: 'validation' },
    commitSha: 'sha-c',
    rolloutCandidateId: 'cand-1',
    at: 3000,
  });
  // Two rows inside one millisecond, which a real transaction produces.
  for (const operationId of ['op-tie-1', 'op-tie-2']) {
    insertHistory(db, {
      application: { ...base, stack_name: 'tie-web', lifecycle_key: 'direct:tie-web' },
      nodeId: 1,
      dedupeTarget: 'app',
      operationId,
      stage: 'fetched',
      outcome: 'committed',
      trigger: 'manual',
      actor: 'operator-1',
      before: {},
      after: {},
      commitSha: 'sha-tie',
      at: 4000,
    });
  }
}

function application(): GitOpsApplicationRow {
  return {
    id: 'app-history',
    lifecycle_key: 'direct:history-web',
    lifecycle_status: 'active',
    target_mode: 'direct',
    stack_name: 'history-web',
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
