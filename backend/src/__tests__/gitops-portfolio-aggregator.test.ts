/**
 * Integration coverage for the hub-owned GitOps portfolio aggregator
 * (services/gitops/portfolioAggregator.ts).
 *
 * The portfolio is a control-plane read model over canonical projections.
 * These tests pin the aggregation contract: local Direct + Blueprint rows land
 * with the right identity, remote rows are identity-rewritten and
 * re-authorized per caller, an unreachable node surfaces as coverage evidence
 * rather than vanishing, and rows carrying statuses this build does not know
 * are reported as unknown evidence instead of being reinterpreted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { Request } from 'express';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions, type EventEnvelope } from '../services/gitops/transitions';
import { aggregateGitOpsPortfolio, PORTFOLIO_MERGE_CAP, postureOf } from '../services/gitops/portfolioAggregator';
import { directApplicationFixture } from './helpers/gitopsFixtures';
import type { GitOpsRevisionProjection } from '../services/gitops/types';
import type { ArtifactFacet } from '../services/gitops/types';

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  GitOpsStore.resetForTests();
  GitOpsTransitions.resetForTests();
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

function env(operationId: string): EventEnvelope {
  return { operationId, actor: 'tester', trigger: 'manual', at: 1 };
}

type ReqUser = { userId: number; username: string; role: 'admin' | 'viewer' | 'deployer' | 'node-admin' | 'auditor' };

function fakeReq(user: ReqUser, nodeId: number): Request {
  return { user, nodeId, headers: {}, query: {}, params: {} } as unknown as Request;
}

function adminReq(nodeId: number): Request {
  return fakeReq({ userId: 1, username: 'admin', role: 'admin' }, nodeId);
}

async function createDirectApp(id: string, stackName: string): Promise<string> {
  const tx = GitOpsTransitions.getInstance();
  tx.activateDirect({
    application: directApplicationFixture(id, stackName),
    nodeId: DatabaseService.getInstance().getNodes()[0]!.id,
    envelope: env(`op-${id}`),
  });
  return id;
}

function createBlueprintApplication(id: string, blueprintId: number): void {
  GitOpsStore.getInstance().insertApplication({
    ...directApplicationFixture(id, `source-${id}`),
    lifecycle_key: `blueprint:${blueprintId}`,
    target_mode: 'blueprint',
    stack_name: null,
    configured_source_stack_name: null,
    blueprint_id: blueprintId,
  });
}

/** A minimal live remote row, as a remote node's GET /api/git-sources returns it. */
function remoteSourceRow(
  applicationId: string,
  stackName: string,
  revision: GitOpsRevisionProjection,
  stackResourcePresent = true,
): unknown[] {
  return [{
    id: 7,
    stack_name: stackName,
    repo_url: 'https://github.com/example/remote.git',
    branch: 'main',
    compose_path: 'compose.yaml',
    compose_paths: ['compose.yaml'],
    context_dir: null,
    sync_env: false,
    env_path: null,
    auth_type: 'none',
    has_token: false,
    has_deploy_key: false,
    has_ca_bundle: false,
    ssh_host_key_fingerprint: null,
    source_policy: 'manual',
    auto_apply_on_webhook: false,
    auto_deploy_on_apply: false,
    last_applied_commit_sha: null,
    pending_commit_sha: null,
    pending_fetched_at: null,
    created_at: 1000,
    updated_at: 1500,
    manifest_state: null,
    pending_plan: null,
    last_plan_fingerprint: null,
    last_plan_outcome: null,
    gitopsRevision: revision,
    stackResourcePresent,
  }];
}

function remoteProjection(applicationId: string, stackName: string): GitOpsRevisionProjection {
  return {
    schemaVersion: 1,
    targetMode: 'direct',
    applicationId,
    lifecycleStatus: 'active',
    stackName,
    blueprintId: null,
    rolloutGenerationId: null,
    approvals: {
      sourceAcceptanceRef: null,
      placementApprovalRef: null,
      rolloutAuthorizationRef: null,
      legacyCombinedApprovalRef: null,
    },
    facets: {
      source: {
        status: 'source_poll_scheduled',
        nextPollAt: 2000,
        configuredRepoUrl: 'https://github.com/example/remote.git',
        repoIdentity: { host: 'github.com', pathname: '/example/remote.git' },
        configuredRef: 'main',
        desiredCommitSha: null,
        fetchedCommitSha: null,
        candidateGenerationId: null,
        acceptedGenerationId: 'gen-1',
      },
      artifact: { status: 'not_applicable' },
      placement: { status: 'unbound_direct' },
      rollout: { status: 'not_applicable' },
    },
    targets: [],
    drift: [],
    limitations: [],
    availableActions: [],
  };
}

describe('aggregateGitOpsPortfolio', () => {
  it('returns an empty portfolio with the local node in coverage on a fresh instance', async () => {
    const nodeId = DatabaseService.getInstance().getNodes()[0]!.id;
    const { rows, coverage, truncated } = await aggregateGitOpsPortfolio(adminReq(nodeId), { fetchRows: async () => null });
    expect(rows).toEqual([]);
    // The local node is always a coverage entry: the node dimension of the
    // workplace must be able to address the hub itself.
    expect(coverage).toEqual([{ nodeId, nodeName: DatabaseService.getInstance().getNodes()[0]!.name, state: 'ok' }]);
    expect(truncated).toBe(false);
  });

  it('lists a local Direct application with identity, repository, and history recency', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getNodes()[0]!.id;
    await createDirectApp('app-port-local', 'port-local-web');

    const { rows } = await aggregateGitOpsPortfolio(adminReq(nodeId));
    const row = rows.find(candidate => candidate.stackName === 'port-local-web');
    expect(row).toBeDefined();
    expect(row!.id).toBe(`${nodeId}:app-port-local`);
    expect(row!.targetMode).toBe('direct');
    expect(row!.nodeId).toBe(nodeId);
    expect(row!.repository?.host).toBe('github.com');
    expect(row!.repository?.configuredRef).toBe('main');
    // activateDirect records one history row; it is the freshest transition
    // the row reports.
    expect(row!.lastActivityAt).not.toBeNull();
    // Never-reconciled source, never-applied runtime: nothing claims health.
    expect(row!.posture).toBe('unknown');
  });

  it('never exposes credentials on the row', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getNodes()[0]!.id;
    const { rows } = await aggregateGitOpsPortfolio(adminReq(nodeId));
    for (const row of rows) {
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain('token');
      expect(serialized).not.toContain('deploy_key');
      expect(serialized).not.toContain('private_key');
      expect(serialized).not.toContain('password');
    }
  });

  it('includes Blueprint applications with their bp: identity', async () => {
    const db = DatabaseService.getInstance();
    const blueprint = db.createBlueprint({
      name: 'port-blueprint',
      description: null,
      compose_content: 'services:\n  app:\n    image: nginx\n',
      selector: { type: 'nodes', ids: [] },
      drift_mode: 'observe',
      classification: 'stateless',
      classification_reasons: [],
      enabled: true,
      created_by: 'tester',
    });
    createBlueprintApplication('app-port-blueprint', blueprint.id);

    const nodeId = db.getNodes()[0]!.id;
    const { rows } = await aggregateGitOpsPortfolio(adminReq(nodeId));
    const row = rows.find(candidate => candidate.id === `bp:${blueprint.id}`);
    expect(row).toBeDefined();
    expect(row!.name).toBe('port-blueprint');
    expect(row!.targetMode).toBe('blueprint');
    expect(row!.nodeId).toBeNull();
  });

  it('merges remote rows with hub node ids applied', async () => {
    const db = DatabaseService.getInstance();
    const localNodeId = db.getNodes()[0]!.id;
    const remoteId = db.addNode({
      name: 'port-remote',
      type: 'remote',
      api_url: 'http://127.0.0.1:29999',
      api_token: 'tok',
      compose_dir: '/app/compose',
      is_default: false,
    });

    const { rows, coverage } = await aggregateGitOpsPortfolio(adminReq(localNodeId), {
      fetchRows: async (nodeId: number) => {
        if (nodeId !== remoteId) return null;
        return remoteSourceRow('app-remote-1', 'remote-web', remoteProjection('app-remote-1', 'remote-web'));
      },
    });

    const remote = rows.find(candidate => candidate.id === `${remoteId}:app-remote-1`);
    expect(remote).toBeDefined();
    expect(remote!.nodeName).toBe('port-remote');
    expect(remote!.repository?.host).toBe('github.com');
    expect(coverage.find(candidate => candidate.nodeId === remoteId)?.state).toBe('ok');
  });

  it('keeps failures inside the merge cap, dropping settled rows first', async () => {
    const db = DatabaseService.getInstance();
    const localNodeId = db.getNodes()[0]!.id;
    const remoteId = db.addNode({
      name: 'port-remote-cap',
      type: 'remote',
      api_url: 'http://127.0.0.1:29998',
      api_token: 'tok',
      compose_dir: '/app/compose',
      is_default: false,
    });
    // One more row than the cap; the failing one sorts last by id, so an
    // id-ordered cap would drop exactly the row triage needs.
    const payload: unknown[] = [];
    for (let i = 0; i < PORTFOLIO_MERGE_CAP; i++) {
      const appId = `app-cap-${String(i).padStart(4, '0')}`;
      payload.push(...remoteSourceRow(appId, `cap-${i}`, remoteProjection(appId, `cap-${i}`)));
    }
    const failing = remoteProjection('app-cap-zzzz', 'cap-failing');
    failing.facets!.rollout = { status: 'rollback_partial_failed', recoveryRef: 'r', recoveryGenerationId: null, failureClass: 'x', failureAt: 1 } as never;
    payload.push(...remoteSourceRow('app-cap-zzzz', 'cap-failing', failing));

    const { rows, truncated } = await aggregateGitOpsPortfolio(adminReq(localNodeId), {
      fetchRows: async (nodeId: number) => (nodeId === remoteId ? payload : null),
    });

    expect(truncated).toBe(true);
    expect(rows).toHaveLength(PORTFOLIO_MERGE_CAP);
    expect(rows[0]!.id).toBe(`${remoteId}:app-cap-zzzz`);
    expect(rows[0]!.posture).toBe('failed');
  });

  it('marks an unreachable remote in coverage and fabricates no rows for it', async () => {
    const db = DatabaseService.getInstance();
    const localNodeId = db.getNodes()[0]!.id;
    const remoteId = db.addNode({
      name: 'port-remote-dead',
      type: 'remote',
      api_url: 'http://127.0.0.1:29998',
      api_token: 'tok',
      compose_dir: '/app/compose',
      is_default: false,
    });

    const { rows, coverage } = await aggregateGitOpsPortfolio(adminReq(localNodeId), {
      fetchRows: async () => null,
    });
    expect(coverage).toContainEqual({ nodeId: remoteId, nodeName: 'port-remote-dead', state: 'unreachable' });
    expect(rows.some(row => row.id.startsWith(`${remoteId}:`))).toBe(false);
    const respondedIds = rows.filter(row => row.id.startsWith(`${remoteId}:`)).length;
    expect(respondedIds).toBe(0);
  });

  it('marks a remote that cannot answer the envelope as unsupported', async () => {
    const db = DatabaseService.getInstance();
    const localNodeId = db.getNodes()[0]!.id;
    const remoteId = db.addNode({
      name: 'port-remote-old',
      type: 'remote',
      api_url: 'http://127.0.0.1:29997',
      api_token: 'tok',
      compose_dir: '/app/compose',
      is_default: false,
    });

    const { coverage, rows } = await aggregateGitOpsPortfolio(adminReq(localNodeId), {
      fetchRows: async () => 'unsupported',
    });
    expect(coverage).toContainEqual({ nodeId: remoteId, nodeName: 'port-remote-old', state: 'unsupported' });
    expect(rows.some(row => row.id.startsWith(`${remoteId}:`))).toBe(false);
  });

  it('reinterprets no statuses on a projection carrying an unknown runtime state', async () => {
    const db = DatabaseService.getInstance();
    const localNodeId = db.getNodes()[0]!.id;
    const remoteId = db.addNode({
      name: 'port-remote-new',
      type: 'remote',
      api_url: 'http://127.0.0.1:29996',
      api_token: 'tok',
      compose_dir: '/app/compose',
      is_default: false,
    });

    const newer = remoteProjection('app-remote-new', 'new-stack') as unknown as Record<string, unknown>;
    (newer.targets as unknown[]).push({
      nodeId: 1,
      stackName: 'new-stack',
      connectivity: 'reachable',
      runtime: { status: 'brand_new_status' },
      health: { status: 'passed' },
    });
    const { rows } = await aggregateGitOpsPortfolio(adminReq(localNodeId), {
      fetchRows: async (nodeId: number) =>
        nodeId === remoteId ? remoteSourceRow('app-remote-new', 'new-stack', newer as unknown as GitOpsRevisionProjection) : null,
    });
    const row = rows.find(candidate => candidate.id === `${remoteId}:app-remote-new`);
    expect(row).toBeDefined();
    expect(row!.runtimeStatus).toBe('brand_new_status');
    expect(row!.evidence.unknown).toBe(true);
    // A status this build does not know cannot accidentally count as a known
    // bad or good one for the page's sort order.
    expect(['failed', 'converged']).not.toContain(row!.posture);
  });

  it('keeps Blueprint applications hidden from callers without the fleet read grant', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getNodes()[0]!.id;
    // The Direct row is only stack-readable while the stack directory exists;
    // stackResourcePresent is the owning instance's "this stack is real" claim,
    // and a directory only counts once it actually holds a compose file.
    const stackDir = path.join(process.env.COMPOSE_DIR!, 'port-local-web');
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  app:\n    image: nginx\n');
    // deployer holds stack:read globally but not node:read, so the Blueprint
    // catalog is closed to them; the portfolio must apply the same rule.
    const deployer = fakeReq({ userId: 92, username: 'port-deployer', role: 'deployer' }, nodeId);
    const { rows } = await aggregateGitOpsPortfolio(deployer, { fetchRows: async () => null });
    expect(rows.some(row => row.id.startsWith('bp:'))).toBe(false);
    // Direct applications remain visible: deployer holds the global stack:read
    // the classifier asks for.
    expect(rows.some(row => row.stackName === 'port-local-web')).toBe(true);
  });

  it('drops a remote row whose evidence cannot authorize a stack read', async () => {
    const db = DatabaseService.getInstance();
    const localNodeId = db.getNodes()[0]!.id;
    const remoteId = db.addNode({
      name: 'port-remote-unauthz',
      type: 'remote',
      api_url: 'http://127.0.0.1:29994',
      api_token: 'tok',
      compose_dir: '/app/compose',
      is_default: false,
    });
    // A deployer reads the portfolio but is not an admin; a remote row whose
    // owning instance cannot state that its stack is present classifies to the
    // fail-closed Admin requirement, so the row is dropped rather than shown.
    const deployer = fakeReq({ userId: 93, username: 'port-deployer-2', role: 'deployer' }, localNodeId);
    const { rows } = await aggregateGitOpsPortfolio(deployer, {
      fetchRows: async (nodeId: number) => nodeId === remoteId
        ? remoteSourceRow('app-remote-hidden', 'hidden-web', remoteProjection('app-remote-hidden', 'hidden-web'), false)
        : null,
    });
    expect(rows.some(row => row.id === `${remoteId}:app-remote-hidden`)).toBe(false);
  });
});

describe('postureOf', () => {
  type LiveFacets = Extract<GitOpsRevisionProjection, { applicationId: string }>['facets'];
  function baseFixture(overrides?: {
    source?: LiveFacets['source'];
    rollout?: LiveFacets['rollout'];
    artifact?: ArtifactFacet;
  }): GitOpsRevisionProjection {
    return {
      schemaVersion: 1,
      targetMode: 'direct',
      applicationId: 'app-p',
      lifecycleStatus: 'active',
      stackName: 'p-web',
      blueprintId: null,
      rolloutGenerationId: null,
      approvals: {
        sourceAcceptanceRef: null,
        placementApprovalRef: null,
        rolloutAuthorizationRef: null,
        legacyCombinedApprovalRef: null,
      },
      facets: {
        source: overrides?.source ?? {
          status: 'application_generation_accepted',
          configuredRepoUrl: 'https://github.com/example/p.git',
          repoIdentity: { host: 'github.com', pathname: '/example/p.git' },
          configuredRef: 'main',
          desiredCommitSha: null,
          fetchedCommitSha: null,
          candidateGenerationId: null,
          acceptedGenerationId: 'gen-1',
        },
        artifact: overrides?.artifact ?? { status: 'not_applicable' },
        placement: { status: 'unbound_direct' },
        rollout: overrides?.rollout ?? { status: 'not_applicable' },
      },
      targets: [],
      drift: [],
      limitations: [],
      availableActions: [],
    };
  }

  it('claims exact convergence only from the rollout proof', () => {
    const projection = baseFixture({ rollout: { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' } });
    expect(postureOf(projection)).toBe('converged');
  });

  it('keeps qualified convergence distinct from exact convergence', () => {
    const projection = baseFixture({ rollout: { status: 'configuration_converged_artifact_qualified', rolloutGenerationId: 'rg-1' } });
    expect(postureOf(projection)).toBe('converged_qualified');
  });

  it('marks a never-reconciled application unknown rather than healthy', () => {
    expect(postureOf(baseFixture())).toBe('unknown');
  });

  it('marks in-flight work in_progress instead of unknown', () => {
    const projection = baseFixture({
      source: {
        status: 'checking_fetching',
        configuredRepoUrl: 'https://github.com/example/p.git',
        repoIdentity: { host: 'github.com', pathname: '/example/p.git' },
        configuredRef: 'main',
        desiredCommitSha: null,
        fetchedCommitSha: null,
        candidateGenerationId: null,
        acceptedGenerationId: null,
      },
    });
    expect(postureOf(projection)).toBe('in_progress');
  });

  it('never claims convergence from an artifact status this build does not know', () => {
    const projection = baseFixture({
      artifact: { status: 'artifact_future_unknown' } as unknown as ArtifactFacet,
    });
    expect(postureOf(projection)).toBe('unknown');
  });

  it('lets failure outrank everything else', () => {
    const projection = baseFixture({ rollout: { status: 'rollback_partial_failed', recoveryRef: 'r', recoveryGenerationId: null, failureClass: 'x', failureAt: 1 } as never });
    expect(postureOf(projection)).toBe('failed');
  });
});
