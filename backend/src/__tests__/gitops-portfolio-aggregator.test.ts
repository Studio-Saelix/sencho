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
  revision: unknown,
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

type RemoteProjectionFixture = Omit<Extract<GitOpsRevisionProjection, { applicationId: string }>, 'targets'> & { targets: unknown[] };

function remoteProjection(applicationId: string, stackName: string): RemoteProjectionFixture {
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

  it('keeps a malformed remote application addressable instead of relabeling it as legacy', async () => {
    const db = DatabaseService.getInstance();
    const localNodeId = db.getNodes()[0]!.id;
    const remoteId = db.addNode({
      name: 'port-remote-evidence-gap',
      type: 'remote',
      api_url: 'http://127.0.0.1:29995',
      api_token: 'tok',
      compose_dir: '/app/compose',
      is_default: false,
    });

    const { rows } = await aggregateGitOpsPortfolio(adminReq(localNodeId), {
      fetchRows: async (nodeId: number) => nodeId === remoteId ? [{
        stack_name: 'remote-gap',
        stackResourcePresent: true,
        gitopsRevision: { applicationId: 'app-evidence-gap', targetMode: 'direct' },
      }] : null,
    });

    const row = rows.find(candidate => candidate.id === `${remoteId}:app-evidence-gap`);
    expect(row).toBeDefined();
    expect(row!.evidence).toEqual({ partial: true, unreachableNodes: [], unknown: true });
    expect(row!.limitations).toContain('evidence_unavailable');
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

    const newer = remoteProjection('app-remote-new', 'new-stack');
    newer.targets.push({
      nodeId: 1,
      stackName: 'new-stack',
      desiredGenerationId: null,
      candidateGenerationId: null,
      appliedGenerationId: null,
      deployedGenerationId: null,
      healthyGenerationId: null,
      lkgGenerationId: null,
      lkgArtifactSetId: null,
      lkgUnavailableAt: null,
      lkgUnavailableReason: null,
      expectedArtifactSetId: null,
      latestArtifactSetId: null,
      artifact: { status: 'not_applicable' },
      observedArtifactIdentity: { kind: 'unknown' },
      intentRevisionId: null,
      rolloutCandidateId: null,
      rolloutGenerationId: null,
      approvals: {
        sourceAcceptanceRef: null,
        placementApprovalRef: null,
        rolloutAuthorizationRef: null,
        legacyCombinedApprovalRef: null,
      },
      connectivity: 'from_a_newer_node',
      legacyAppliedRevision: null,
      runtime: { status: 'brand_new_status' },
      health: { status: 'passed', runId: 'health-1', deployedGenerationId: 'gen-1' },
      lkg: { status: 'none' },
      tombstoned: false,
    });
    const { rows } = await aggregateGitOpsPortfolio(adminReq(localNodeId), {
      fetchRows: async (nodeId: number) =>
        nodeId === remoteId ? remoteSourceRow('app-remote-new', 'new-stack', newer) : null,
    });
    const row = rows.find(candidate => candidate.id === `${remoteId}:app-remote-new`);
    expect(row).toBeDefined();
    expect(row!.runtimeStatus).toBe('brand_new_status');
    expect(row!.targets[0].evidence).toBe('unknown');
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
  type LiveProjection = Extract<GitOpsRevisionProjection, { applicationId: string }>;
  function baseFixture(overrides?: {
    source?: LiveFacets['source'];
    rollout?: LiveFacets['rollout'];
    artifact?: ArtifactFacet;
  }): LiveProjection {
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

  function settledFixture(rollout: LiveFacets['rollout']): LiveProjection {
    const base = baseFixture({ rollout });
    const exact = rollout.status === 'exactly_converged_healthy';
    // One facet, shared: a target reporting a different status than the
    // application is exactly the disagreement this fixture must not be able to
    // express.
    const artifact: ArtifactFacet = {
      status: exact ? 'artifact_exact' : 'artifact_qualified',
      artifactSetId: 'artifact-1',
      generationId: 'gen-1',
      evidenceVersion: 1,
      qualification: exact ? 'exact' : 'qualified',
      freshnessAt: 1,
      expected: null,
      latestEvidence: {
        artifactSetId: 'artifact-1',
        evidenceVersion: 1,
        qualification: exact ? 'exact' : 'qualified',
        identity: 'sha256:artifact',
      },
    };
    return {
      ...base,
      targetMode: 'blueprint',
      blueprintId: 1,
      stackName: null,
      rolloutGenerationId: 'rg-1',
      facets: {
        ...base.facets,
        artifact,
        placement: { status: 'blueprint_bound', completion: 'unknown' },
      },
      targets: [{
        nodeId: 1,
        stackName: 'p-web',
        desiredGenerationId: 'gen-1',
        candidateGenerationId: null,
        appliedGenerationId: 'gen-1',
        deployedGenerationId: 'gen-1',
        healthyGenerationId: 'gen-1',
        lkgGenerationId: null,
        lkgArtifactSetId: null,
        lkgUnavailableAt: null,
        lkgUnavailableReason: null,
        expectedArtifactSetId: 'artifact-1',
        latestArtifactSetId: 'artifact-1',
        artifact,
        observedArtifactIdentity: {
          kind: exact ? 'exact' : 'qualified',
          identity: 'sha256:artifact',
          observedAt: 1,
        },
        intentRevisionId: 'intent-1',
        rolloutCandidateId: 'candidate-1',
        rolloutGenerationId: 'rg-1',
        approvals: {
          sourceAcceptanceRef: null,
          placementApprovalRef: 'placement-1',
          rolloutAuthorizationRef: 'rollout-1',
          legacyCombinedApprovalRef: null,
        },
        connectivity: 'reachable',
        legacyAppliedRevision: null,
        runtime: { status: 'synced_and_healthy' },
        health: { status: 'passed', runId: 'health-1', deployedGenerationId: 'gen-1' },
        lkg: { status: 'none' },
        tombstoned: false,
      }],
    };
  }

  it('claims exact convergence only from the rollout proof', () => {
    const projection = settledFixture({ status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' });
    expect(postureOf(projection)).toBe('converged');
  });

  it('keeps qualified convergence distinct from exact convergence', () => {
    const projection = settledFixture({ status: 'configuration_converged_artifact_qualified', rolloutGenerationId: 'rg-1' });
    expect(postureOf(projection)).toBe('converged_qualified');
  });

  it('does not claim convergence when a target reports another rollout generation', () => {
    const projection = settledFixture({ status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' });
    projection.targets[0].rolloutGenerationId = 'rg-other';
    expect(postureOf(projection)).toBe('unknown');
  });

  it('ignores retired targets when proving convergence', () => {
    const projection = settledFixture({ status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' });
    projection.targets.push({ ...projection.targets[0], nodeId: 2, tombstoned: true });
    expect(postureOf(projection)).toBe('converged');
  });

  it('allows a health-gate-disabled target to keep a stale healthy pointer', () => {
    const projection = settledFixture({ status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' });
    projection.targets[0].health = { status: 'not_applicable' };
    projection.targets[0].healthyGenerationId = 'gen-old';
    expect(postureOf(projection)).toBe('converged');
  });

  it('accepts an exact observation for a qualified artifact claim', () => {
    const projection = settledFixture({ status: 'configuration_converged_artifact_qualified', rolloutGenerationId: 'rg-1' });
    expect(projection.facets.artifact.status).toBe('artifact_qualified');
    expect(projection.targets[0].observedArtifactIdentity.kind).toBe('qualified');
    projection.targets[0].observedArtifactIdentity = { kind: 'exact', identity: 'sha256:artifact', observedAt: 1 };
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

  it('never claims convergence from a known artifact status carrying an unknown qualification', () => {
    const projection = settledFixture({ status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' });
    const artifact = projection.facets.artifact as unknown as Record<string, unknown>;
    artifact.qualification = 'future_qualification';
    expect(postureOf(projection)).toBe('unknown');
  });

  it.each([
    ['the application expected artifact', (projection: LiveProjection) => {
      const artifact = projection.facets.artifact as unknown as { expected: Record<string, unknown> | null };
      artifact.expected = { artifactSetId: 'artifact-1', evidenceVersion: 1, qualification: 'future_qualification', identity: 'sha256:artifact' };
    }],
    ['the target expected artifact', (projection: LiveProjection) => {
      const artifact = projection.targets[0].artifact as unknown as { expected: Record<string, unknown> | null };
      artifact.expected = { artifactSetId: 'artifact-1', evidenceVersion: 1, qualification: 'future_qualification', identity: 'sha256:artifact' };
    }],
  ])('never claims convergence from a future qualification in %s', (_label, mutate) => {
    const projection = settledFixture({ status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' });
    mutate(projection);
    expect(postureOf(projection)).toBe('unknown');
  });

  it('never claims convergence from a blank rollout generation', () => {
    const projection = settledFixture({ status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' });
    projection.rolloutGenerationId = '';
    projection.facets.rollout = { status: 'exactly_converged_healthy', rolloutGenerationId: '' } as typeof projection.facets.rollout;
    projection.targets[0].rolloutGenerationId = '';
    expect(postureOf(projection)).toBe('unknown');
  });

  it('never claims convergence for an inline Blueprint, which has no rollout facet of its own', () => {
    const projection = settledFixture({ status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' });
    projection.targetMode = 'inline_blueprint';
    expect(postureOf(projection)).toBe('unknown');
  });

  function directSettledFixture(artifactStatus: 'artifact_exact' | 'artifact_qualified'): LiveProjection {
    const base = baseFixture();
    const qualification = artifactStatus === 'artifact_exact' ? 'exact' as const : 'qualified' as const;
    const artifact: ArtifactFacet = {
      status: artifactStatus,
      artifactSetId: 'artifact-1',
      generationId: 'gen-1',
      evidenceVersion: 1,
      qualification,
      freshnessAt: 1,
      expected: null,
      latestEvidence: {
        artifactSetId: 'artifact-1',
        evidenceVersion: 1,
        qualification,
        identity: 'sha256:artifact',
      },
    };
    const target: LiveProjection['targets'][number] = {
      nodeId: 1,
      stackName: 'p-web',
      desiredGenerationId: 'gen-1',
      candidateGenerationId: null,
      appliedGenerationId: 'gen-1',
      deployedGenerationId: 'gen-1',
      healthyGenerationId: 'gen-1',
      lkgGenerationId: null,
      lkgArtifactSetId: null,
      lkgUnavailableAt: null,
      lkgUnavailableReason: null,
      expectedArtifactSetId: 'artifact-1',
      latestArtifactSetId: 'artifact-1',
      artifact,
      observedArtifactIdentity: { kind: 'exact' as const, identity: 'sha256:artifact', observedAt: 1 },
      intentRevisionId: 'intent-1',
      rolloutCandidateId: null,
      rolloutGenerationId: null,
      approvals: base.approvals,
      connectivity: 'reachable' as const,
      legacyAppliedRevision: null,
      runtime: { status: 'synced_and_healthy' as const },
      health: { status: 'passed' as const, runId: 'health-1', deployedGenerationId: 'gen-1' },
      lkg: { status: 'none' as const },
      tombstoned: false,
    };
    return {
      ...base,
      facets: {
        ...base.facets,
        source: { ...(base.facets.source as Extract<LiveFacets['source'], { status: 'source_poll_scheduled' }>), status: 'source_poll_scheduled', acceptedGenerationId: 'gen-1' },
        artifact,
      },
      targets: [target],
    };
  }

  it('claims a settled Direct application converged from its own target evidence', () => {
    expect(postureOf(directSettledFixture('artifact_exact'))).toBe('converged');
    expect(postureOf(directSettledFixture('artifact_qualified'))).toBe('converged_qualified');
  });

  it('never reads a Direct application with an unreachable target as converged', () => {
    const projection = directSettledFixture('artifact_exact');
    projection.targets[0].connectivity = 'unreachable';
    expect(postureOf(projection)).not.toBe('converged');
    expect(postureOf(projection)).not.toBe('converged_qualified');
  });

  it.each([
    ['an unknown target artifact status', (projection: LiveProjection) => {
      projection.targets[0].artifact = { status: 'artifact_future_verdict' } as unknown as ArtifactFacet;
    }],
    ['an unknown LKG status', (projection: LiveProjection) => {
      projection.targets[0].lkg = { status: 'future_lkg' } as unknown as LiveProjection['targets'][number]['lkg'];
    }],
    ['an unknown observed artifact kind', (projection: LiveProjection) => {
      projection.targets[0].observedArtifactIdentity = { kind: 'future_kind', identity: 'sha256:artifact', observedAt: 1 } as unknown as LiveProjection['targets'][number]['observedArtifactIdentity'];
    }],
    ['an unknown connectivity', (projection: LiveProjection) => {
      projection.targets[0].connectivity = 'future' as 'reachable';
    }],
  ])('reports %s as unknown evidence rather than convergence', (_label, mutate) => {
    const projection = directSettledFixture('artifact_exact');
    mutate(projection);
    expect(postureOf(projection)).toBe('unknown');
  });

  it('lets failure outrank everything else', () => {
    const projection = baseFixture({ rollout: { status: 'rollback_partial_failed', recoveryRef: 'r', recoveryGenerationId: null, failureClass: 'x', failureAt: 1 } as never });
    expect(postureOf(projection)).toBe('failed');
  });
});
