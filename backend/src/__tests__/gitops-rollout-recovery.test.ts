/**
 * Rollout recovery coordination: which targets a scope resolves to, and how a
 * remote target's restore request is formed and interpreted.
 *
 * The route suite covers the recorded transitions; these tests pin the
 * evidence rules underneath them.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { directApplicationFixture } from './helpers/gitopsFixtures';
import { emptyTargetRow, GitOpsStore } from '../services/gitops/store';
import { encodeGitOpsRequiredTargetsJson } from '../services/gitops/json';
import {
  resolveRollbackTargets,
  restoreTargetToGeneration,
  rollbackCandidatesForApplication,
} from '../services/gitops/rolloutRecovery';
import { NodeRegistry } from '../services/NodeRegistry';
import { PROXY_SCOPED_STACK_ACTIONS_HEADER, PROXY_SCOPED_STACK_NAME_HEADER } from '../services/license-headers';
import type { GitOpsApplicationRow, GitOpsIntentRevisionRow, GitOpsRolloutCandidateRow, GitOpsRolloutGenerationRow } from '../services/gitops/types';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let counter = 0;

function insertNode(type: 'local' | 'remote', apiUrl?: string): number {
  counter += 1;
  return DatabaseService.getInstance().addNode({
    name: `rollout-recovery-${counter}`,
    type,
    mode: 'proxy',
    compose_dir: '/tmp/compose',
    is_default: false,
    api_url: apiUrl,
    api_token: apiUrl ? 'remote-tok' : undefined,
  });
}

function intentRow(id: string, applicationId: string, blueprintId: number, stackName: string): GitOpsIntentRevisionRow {
  return {
    id,
    application_id: applicationId,
    blueprint_id: blueprintId,
    compose_content_sha256: 'c'.repeat(64),
    blueprint_revision: 1,
    deploy_stack_name: stackName,
    selector_json: '{}',
    pinned_node_id: null,
    cordon_implications_json: '[]',
    rollout_strategy_json: '{}',
    runtime_drift_policy: null,
    stateful_policy_json: null,
    health_failure_rollback_policy_json: null,
    operation_id: 'op-intent',
    actor: 'tester',
    created_at: 1,
  };
}

function seedApplication(opts: { nodeIds: number[]; stackName: string; candidateRequired?: number[] }): {
  app: GitOpsApplicationRow;
} {
  const store = GitOpsStore.getInstance();
  counter += 1;
  const blueprintId = 9000 + counter;
  const applicationId = `app-${Math.random().toString(36).slice(2, 10)}`;
  const intentId = `intent-${applicationId}`;
  const candidateId = `cand-${applicationId}`;
  const app: GitOpsApplicationRow = {
    ...directApplicationFixture(applicationId, `src-${applicationId}`),
    target_mode: 'blueprint',
    lifecycle_key: `blueprint:${applicationId}`,
    stack_name: null,
    configured_source_stack_name: null,
    blueprint_id: blueprintId,
    intent_revision_id: intentId,
    rollout_candidate_id: candidateId,
  };
  store.insertApplication(app);
  store.insertIntentRevision(intentRow(intentId, applicationId, blueprintId, opts.stackName));
  const candidate: GitOpsRolloutCandidateRow = {
    id: candidateId,
    application_id: applicationId,
    intent_revision_id: intentId,
    compose_content_sha256: 'c'.repeat(64),
    accepted_generation_id: null,
    artifact_set_id: null,
    required_targets_json: encodeGitOpsRequiredTargetsJson(opts.candidateRequired ?? opts.nodeIds),
    authoritative: 1,
    provenance: 'intent_change',
    operation_id: 'op-cand',
    created_at: 1,
  };
  store.insertRolloutCandidate(candidate);
  for (const nodeId of opts.nodeIds) {
    store.upsertTarget(emptyTargetRow(applicationId, nodeId, 1));
  }
  return { app: store.getApplication(applicationId)! };
}

function seedRolloutGeneration(app: GitOpsApplicationRow, nodeIds: number[]): GitOpsRolloutGenerationRow {
  counter += 1;
  const row: GitOpsRolloutGenerationRow = {
    id: `rgen-${counter}`,
    application_id: app.id,
    intent_revision_id: app.intent_revision_id!,
    rollout_candidate_id: app.rollout_candidate_id!,
    accepted_generation_id: null,
    artifact_set_id: null,
    placement_approval_ref: null,
    source_acceptance_ref: null,
    rollout_authorization_ref: null,
    required_targets_json: encodeGitOpsRequiredTargetsJson(nodeIds),
    preflight_fingerprint: null,
    preflight_evidence_json: null,
    rollout_strategy_json: '{}',
    provenance: 'placement_approval',
    supersedes_generation_id: null,
    superseded_at: null,
    operation_id: 'op-rgen',
    actor: 'tester',
    trigger: 'test',
    created_at: 1,
  };
  GitOpsStore.getInstance().insertRolloutGeneration(row);
  DatabaseService.getInstance().getDb()
    .prepare('UPDATE gitops_applications SET rollout_generation_id = ? WHERE id = ?')
    .run(row.id, app.id);
  return row;
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  vi.restoreAllMocks();
  GitOpsStore.resetForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveRollbackTargets', () => {
  it('resolves all changed targets from the last rollout generation when no authorization is live', () => {
    const { app } = seedApplication({ nodeIds: [1, 2], stackName: 'bp-stack' });
    seedRolloutGeneration(app, [1, 2]);
    const resolved = resolveRollbackTargets(GitOpsStore.getInstance().getApplication(app.id)!, { kind: 'all_changed' }, 'gen-restore');
    expect(resolved).toEqual({ ok: true, nodeIds: [1, 2] });
  });

  it('returns only the failing target for the failed scope', () => {
    const { app } = seedApplication({ nodeIds: [1, 2], stackName: 'bp-stack' });
    seedRolloutGeneration(app, [1, 2]);
    const store = GitOpsStore.getInstance();
    const failing = store.getTarget(app.id, 2)!;
    store.upsertTarget({ ...failing, failure_stage: 'blueprint_deploy' });

    const resolved = resolveRollbackTargets(store.getApplication(app.id)!, { kind: 'failed' }, 'gen-restore');
    expect(resolved).toEqual({ ok: true, nodeIds: [2] });
  });

  it('refuses the failed scope when nothing failed', () => {
    const { app } = seedApplication({ nodeIds: [1, 2], stackName: 'bp-stack' });
    seedRolloutGeneration(app, [1, 2]);
    const resolved = resolveRollbackTargets(GitOpsStore.getInstance().getApplication(app.id)!, { kind: 'failed' }, 'gen-restore');
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.code).toBe('NO_FAILED_TARGETS');
  });

  it('refuses a named target that is not in the frozen set', () => {
    const { app } = seedApplication({ nodeIds: [1, 2], stackName: 'bp-stack' });
    seedRolloutGeneration(app, [1, 2]);
    const resolved = resolveRollbackTargets(GitOpsStore.getInstance().getApplication(app.id)!, {
      kind: 'target',
      nodeId: 99,
    }, 'gen-restore');
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.code).toBe('TARGET_NOT_IN_ROLLOUT');
  });

  it('refuses when the frozen set has no live targets left', () => {
    const { app } = seedApplication({ nodeIds: [1], stackName: 'bp-stack' });
    seedRolloutGeneration(app, [1]);
    const store = GitOpsStore.getInstance();
    const target = store.getTarget(app.id, 1)!;
    store.upsertTarget({ ...target, target_status: 'tombstoned' });
    const resolved = resolveRollbackTargets(store.getApplication(app.id)!, { kind: 'all_changed' }, 'gen-restore');
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.code).toBe('ROLLBACK_UNAVAILABLE');
  });

  it('refuses when there is no frozen set at all', () => {
    const { app } = seedApplication({ nodeIds: [1], stackName: 'bp-stack' });
    const resolved = resolveRollbackTargets(GitOpsStore.getInstance().getApplication(app.id)!, { kind: 'all_changed' }, 'gen-restore');
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.code).toBe('ROLLBACK_UNAVAILABLE');
  });

  it('skips targets already running the selected generation', () => {
    const { app } = seedApplication({ nodeIds: [1, 2], stackName: 'bp-stack' });
    seedRolloutGeneration(app, [1, 2]);
    const store = GitOpsStore.getInstance();
    const current = store.getTarget(app.id, 1)!;
    store.upsertTarget({ ...current, applied_generation_id: 'gen-restore' });

    const all = resolveRollbackTargets(store.getApplication(app.id)!, { kind: 'all_changed' }, 'gen-restore');
    expect(all).toEqual({ ok: true, nodeIds: [2] });

    const single = resolveRollbackTargets(store.getApplication(app.id)!, { kind: 'target', nodeId: 1 }, 'gen-restore');
    expect(single.ok).toBe(false);
    if (!single.ok) expect(single.code).toBe('TARGET_ALREADY_CURRENT');
  });

  it('returns no candidates for a Direct application or one with no rollout history', () => {
    const { app } = seedApplication({ nodeIds: [1], stackName: 'bp-stack' });
    expect(rollbackCandidatesForApplication(app.id)).toEqual([]);

    const directId = `direct-${app.id}`;
    GitOpsStore.getInstance().insertApplication({
      ...app,
      id: directId,
      target_mode: 'direct',
      lifecycle_key: `direct:${directId}`,
      stack_name: directId,
      blueprint_id: null,
      configured_source_stack_name: directId,
    });
    expect(rollbackCandidatesForApplication(directId)).toEqual([]);
  });

  it('lists prior generations newest first and excludes the current one', () => {
    const { app } = seedApplication({ nodeIds: [1], stackName: 'bp-stack' });
    const store = GitOpsStore.getInstance();
    const db = DatabaseService.getInstance().getDb();
    db.prepare('UPDATE gitops_applications SET accepted_generation_id = ? WHERE id = ?')
      .run('gen-current', app.id);
    const older = seedRolloutGeneration(store.getApplication(app.id)!, [1]);
    const current = seedRolloutGeneration(store.getApplication(app.id)!, [1]);
    db.prepare('UPDATE gitops_rollout_generations SET accepted_generation_id = ?, created_at = 1 WHERE id = ?')
      .run('gen-older', older.id);
    db.prepare('UPDATE gitops_rollout_generations SET accepted_generation_id = ?, created_at = 2 WHERE id = ?')
      .run('gen-current', current.id);

    expect(rollbackCandidatesForApplication(app.id)).toEqual([
      { generationId: 'gen-older', rolloutGenerationId: older.id, createdAt: 1 },
    ]);
  });
});

describe('restoreTargetToGeneration on a remote node', () => {
  function remoteApp(nodeId: number): GitOpsApplicationRow {
    const { app } = seedApplication({ nodeIds: [nodeId], stackName: 'bp-stack' });
    return GitOpsStore.getInstance().getApplication(app.id)!;
  }

  it('posts the expected generation with the acting user credential', async () => {
    const nodeId = insertNode('remote', 'https://remote.example.com:1852');
    const app = remoteApp(nodeId);
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
      status: 200,
      data: { message: 'rolled back', gitopsGenerationId: 'gen-restore' },
    });

    const outcome = await restoreTargetToGeneration({
      app,
      stackName: 'bp-stack',
      nodeId,
      generationId: 'gen-restore',
      actor: 'operator',
      role: 'deployer',
      scopedActions: ['stack:deploy'],
    });

    expect(outcome).toEqual({ ok: true });
    const [url, body, config] = postSpy.mock.calls[0] as [string, unknown, { headers: Record<string, string> }];
    expect(url).toBe('https://remote.example.com:1852/api/stacks/bp-stack/rollback');
    expect(body).toEqual({ expectedGitopsGenerationId: 'gen-restore' });
    expect(config.headers.Authorization).toBe('Bearer remote-tok');
    expect(config.headers[PROXY_SCOPED_STACK_NAME_HEADER]).toBe('bp-stack');
    expect(config.headers[PROXY_SCOPED_STACK_ACTIONS_HEADER]).toContain('stack:deploy');
  });

  it('carries the node refusal code and message back', async () => {
    const nodeId = insertNode('remote', 'https://remote.example.com:1852');
    const app = remoteApp(nodeId);
    vi.spyOn(axios, 'post').mockResolvedValue({
      status: 409,
      data: { error: 'The current recovery point does not restore the requested application generation.', code: 'RECOVERY_POINT_MISMATCH' },
    });

    const outcome = await restoreTargetToGeneration({
      app,
      stackName: 'bp-stack',
      nodeId,
      generationId: 'gen-restore',
      actor: null,
      role: 'admin',
      scopedActions: ['stack:deploy'],
    });

    expect(outcome).toEqual({
      ok: false,
      code: 'RECOVERY_POINT_MISMATCH',
      error: 'The current recovery point does not restore the requested application generation.',
    });
  });

  it('fails a 2xx that does not echo the requested generation', async () => {
    const nodeId = insertNode('remote', 'https://remote.example.com:1852');
    const app = remoteApp(nodeId);
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
      status: 200,
      data: { message: 'rolled back' },
    });

    const first = await restoreTargetToGeneration({
      app,
      stackName: 'bp-stack',
      nodeId,
      generationId: 'gen-restore',
      actor: null,
      role: 'admin',
      scopedActions: ['stack:deploy'],
    });
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.code).toBe('RECOVERY_POINT_MISMATCH');

    postSpy.mockResolvedValue({ status: 200, data: { gitopsGenerationId: 'gen-someone-else' } });
    const second = await restoreTargetToGeneration({
      app,
      stackName: 'bp-stack',
      nodeId,
      generationId: 'gen-restore',
      actor: null,
      role: 'admin',
      scopedActions: ['stack:deploy'],
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('RECOVERY_POINT_MISMATCH');
  });

  it('maps a bare 403 to PERMISSION_DENIED', async () => {
    const nodeId = insertNode('remote', 'https://remote.example.com:1852');
    const app = remoteApp(nodeId);
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 403, data: {} });

    const outcome = await restoreTargetToGeneration({
      app,
      stackName: 'bp-stack',
      nodeId,
      generationId: 'gen-restore',
      actor: null,
      role: 'viewer',
      scopedActions: [],
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('PERMISSION_DENIED');
  });

  it('fails closed when the node cannot be reached', async () => {
    const nodeId = insertNode('remote', 'https://remote.example.com:1852');
    const app = remoteApp(nodeId);
    vi.spyOn(axios, 'post').mockRejectedValue(new Error('ECONNREFUSED'));

    const outcome = await restoreTargetToGeneration({
      app,
      stackName: 'bp-stack',
      nodeId,
      generationId: 'gen-restore',
      actor: null,
      role: 'admin',
      scopedActions: ['stack:deploy'],
    });

    expect(outcome).toEqual({ ok: false, code: 'NODE_UNREACHABLE', error: 'The restore request to the owning node failed.' });
  });

  it('fails closed when the node has no proxy target', async () => {
    const nodeId = insertNode('remote');
    const app = remoteApp(nodeId);
    vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue(null);

    const outcome = await restoreTargetToGeneration({
      app,
      stackName: 'bp-stack',
      nodeId,
      generationId: 'gen-restore',
      actor: null,
      role: 'admin',
      scopedActions: ['stack:deploy'],
    });

    expect(outcome).toEqual({ ok: false, code: 'NODE_UNREACHABLE', error: 'The owning node is unreachable.' });
  });
});
