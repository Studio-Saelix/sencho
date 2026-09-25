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
import { aggregateGitOpsPortfolio, freshestFacetTimestamp, isUsableRevision, PORTFOLIO_MERGE_CAP, postureOf, rowFromProjection } from '../services/gitops/portfolioAggregator';
import { directApplicationFixture } from './helpers/gitopsFixtures';
import type { GitOpsIdentityRef, GitOpsRevisionProjection, GitOpsTargetProjection } from '../services/gitops/types';
import type { ArtifactFacet } from '../services/gitops/types';
import type { ServiceArtifactEvidence } from '../services/gitops/json';

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

function addRemoteNode(name: string, port: number): number {
  return DatabaseService.getInstance().addNode({
    name,
    type: 'remote',
    api_url: `http://127.0.0.1:${port}`,
    api_token: 'tok',
    compose_dir: '/app/compose',
    is_default: false,
  });
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

type LiveProjection = Extract<GitOpsRevisionProjection, { applicationId: string }>;
type LiveFacets = LiveProjection['facets'];

function liveProjectionFixture(input: {
  applicationId: string;
  targetMode: LiveProjection['targetMode'];
  stackName: string;
  rolloutGenerationId: string | null;
  facets: LiveFacets;
}): LiveProjection {
  return {
    schemaVersion: 1,
    targetMode: input.targetMode,
    applicationId: input.applicationId,
    lifecycleStatus: 'active',
    stackName: input.stackName,
    blueprintId: null,
    rolloutGenerationId: input.rolloutGenerationId,
    approvals: {
      sourceAcceptanceRef: null,
      placementApprovalRef: null,
      rolloutAuthorizationRef: null,
      legacyCombinedApprovalRef: null,
    },
    facets: input.facets,
    targets: [],
    drift: [],
    limitations: [],
    availableActions: [],
  };
}

function remoteProjection(applicationId: string, stackName: string): LiveProjection {
  return liveProjectionFixture({
    applicationId,
    targetMode: 'direct',
    stackName,
    rolloutGenerationId: null,
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
      artifact: artifactFacet(),
      placement: { status: 'unbound_direct' },
      rollout: { status: 'not_applicable' },
    },
  });
}

function bindBlueprintAuthority(projection: LiveProjection): void {
  projection.targetMode = 'blueprint';
  projection.stackName = null;
  projection.blueprintId = 1;
  projection.approvals.rolloutAuthorizationRef = 'auth-1';
  projection.facets.placement = { status: 'blueprint_bound', completion: 'unknown' };
}

function targetProjection(
  connectivity: GitOpsTargetProjection['connectivity'],
  rolloutGenerationId: string | null = null,
  nodeId = 1,
  stackName = 'p-web',
  qualification: 'exact' | 'qualified' = 'exact',
): GitOpsTargetProjection {
  const artifact = artifactFacet(qualification);
  return {
    nodeId,
    stackName,
    desiredGenerationId: 'gen-1',
    candidateGenerationId: null,
    appliedGenerationId: 'gen-1',
    deployedGenerationId: 'gen-1',
    healthyGenerationId: 'gen-1',
    lkgGenerationId: 'gen-1',
    lkgArtifactSetId: null,
    lkgUnavailableAt: null,
    lkgUnavailableReason: null,
    expectedArtifactSetId: artifact.artifactSetId,
    latestArtifactSetId: artifact.artifactSetId,
    artifact,
    observedArtifactIdentity: {
      kind: qualification,
      identity: 'sha256:abc',
      observedAt: 1,
    },
    intentRevisionId: rolloutGenerationId === null ? null : 'intent-1',
    rolloutCandidateId: null,
    rolloutGenerationId,
    approvals: {
      sourceAcceptanceRef: null,
      placementApprovalRef: null,
      rolloutAuthorizationRef: rolloutGenerationId === null ? null : 'auth-1',
      legacyCombinedApprovalRef: null,
    },
    connectivity,
    legacyAppliedRevision: null,
    runtime: { status: 'synced_and_healthy' },
    health: { status: 'passed', runId: 'run-1', deployedGenerationId: 'gen-1' },
    lkg: { status: 'available', generationId: 'gen-1', artifactSetId: null },
    tombstoned: false,
  };
}

function remoteTarget(
  projection: LiveProjection,
  connectivity: GitOpsTargetProjection['connectivity'],
  rolloutGenerationId: string | null = null,
  nodeId = 1,
  stackName = projection.stackName ?? 'p-web',
  qualification: 'exact' | 'qualified' = 'exact',
): GitOpsTargetProjection {
  return targetProjection(connectivity, rolloutGenerationId, nodeId, stackName, qualification);
}

function artifactFacet(
  qualification: 'exact' | 'qualified' = 'exact',
): ArtifactFacet & { status: 'artifact_exact' | 'artifact_qualified' } {
  return {
    status: qualification === 'exact' ? 'artifact_exact' : 'artifact_qualified',
    artifactSetId: 'artifact-1',
    generationId: 'gen-1',
    evidenceVersion: 1,
    qualification,
    freshnessAt: 1,
    expected: {
      artifactSetId: 'artifact-1',
      evidenceVersion: 1,
      qualification,
      identity: 'sha256:abc',
    },
    latestEvidence: {
      artifactSetId: 'artifact-1',
      evidenceVersion: 1,
      qualification,
      identity: 'sha256:abc',
    },
  };
}

function serviceEvidence(platformDigest: string): ServiceArtifactEvidence {
  return {
    serviceName: 'app',
    authoredRef: null,
    source: 'registry',
    platform: null,
    indexDigest: null,
    platformDigest,
    buildContextFingerprint: null,
    producedImageId: null,
    failureClass: null,
    resolvedAt: 1,
  };
}

function rowForProjection(
  projection: Extract<GitOpsRevisionProjection, { applicationId: string }>,
  name: string,
  partialNodes: number[] = [],
): ReturnType<typeof rowFromProjection> {
  return rowFromProjection({
    id: `1:${name}`,
    projection,
    name,
    stackName: projection.stackName,
    blueprintId: projection.blueprintId,
    nodeId: 1,
    nodeName: null,
    lastActivityAt: null,
    partialNodes,
    nodeNames: new Map(projection.targets.map(target => [target.nodeId, null])),
  });
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
    const remoteId = addRemoteNode('port-remote', 29999);

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
    const remoteId = addRemoteNode('port-remote-cap', 29998);
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
    const remoteId = addRemoteNode('port-remote-dead', 29998);

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
    const remoteId = addRemoteNode('port-remote-old', 29997);

    const { coverage, rows } = await aggregateGitOpsPortfolio(adminReq(localNodeId), {
      fetchRows: async () => 'unsupported',
    });
    expect(coverage).toContainEqual({ nodeId: remoteId, nodeName: 'port-remote-old', state: 'unsupported' });
    expect(rows.some(row => row.id.startsWith(`${remoteId}:`))).toBe(false);
  });

  it('reinterprets no statuses on a projection carrying an unknown runtime state', async () => {
    const db = DatabaseService.getInstance();
    const localNodeId = db.getNodes()[0]!.id;
    const remoteId = addRemoteNode('port-remote-new', 29996);

    const newer = remoteProjection('app-remote-new', 'new-stack');
    newer.targetMode = 'blueprint';
    newer.rolloutGenerationId = 'rg-1';
    bindBlueprintAuthority(newer);
    newer.facets.rollout = { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' };
    const target = targetProjection('reachable', 'rg-1');
    Object.assign(target.runtime, { status: 'brand_new_status' });
    newer.targets = [target];
    const { rows } = await aggregateGitOpsPortfolio(adminReq(localNodeId), {
      fetchRows: async (nodeId: number) =>
        nodeId === remoteId ? remoteSourceRow('app-remote-new', 'new-stack', newer) : null,
    });
    const row = rows.find(candidate => candidate.id === `${remoteId}:app-remote-new`);
    expect(row).toBeDefined();
    expect(row!.runtimeStatus).toBe('brand_new_status');
    expect(row!.evidence.unknown).toBe(true);
    expect(row!.posture).toBe('unknown');
  });

  it('keeps every unknown remote status as a live unknown row', async () => {
    const db = DatabaseService.getInstance();
    const localNodeId = db.getNodes()[0]!.id;
    const remoteId = addRemoteNode('port-remote-unknown-statuses', 29995);
    const facets = ['source', 'artifact', 'placement', 'rollout', 'health', 'connectivity'] as const;
    const payload = facets.flatMap(facet => {
      const applicationId = `app-remote-unknown-${facet}`;
      const revision = remoteProjection(applicationId, `unknown-${facet}`);
      revision.facets.artifact = artifactFacet();
      let target = targetProjection('reachable');
      if (facet !== 'rollout') {
        revision.targetMode = 'blueprint';
        revision.rolloutGenerationId = 'rg-1';
        bindBlueprintAuthority(revision);
        revision.facets.rollout = { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' };
        target = targetProjection('reachable', 'rg-1');
      }
      target.stackName = revision.stackName;
      revision.targets = [target];
      expect(rowForProjection(revision, `baseline-${facet}`).posture).toBe('converged');

      if (facet === 'health') {
        Object.assign(target.health, { status: 'health_future_status' });
      } else if (facet === 'connectivity') {
        Object.assign(target, { connectivity: 'connectivity_future_status' });
      } else {
        Object.assign(revision.facets[facet], { status: `${facet}_future_status` });
      }
      return remoteSourceRow(applicationId, `unknown-${facet}`, revision);
    });

    const { rows, coverage } = await aggregateGitOpsPortfolio(adminReq(localNodeId), {
      fetchRows: async (nodeId: number) => nodeId === remoteId ? payload : null,
    });

    const remoteRows = rows.filter(row => row.id.startsWith(`${remoteId}:`));
    for (const facet of facets) {
      const row = remoteRows.find(candidate => candidate.id === `${remoteId}:app-remote-unknown-${facet}`);
      const expectedStatus = `${facet}_future_status`;
      expect(row).toBeDefined();
      if (facet === 'source') expect(row!.sourceStatus).toBe(expectedStatus);
      if (facet === 'artifact') expect(row!.artifactStatus).toBe(expectedStatus);
      if (facet === 'placement') expect(row!.placementStatus).toBe(expectedStatus);
      if (facet === 'rollout') expect(row!.rolloutStatus).toBe(expectedStatus);
      if (facet === 'health') expect(row!.targets[0]?.health).toBe(expectedStatus);
      if (facet === 'connectivity') expect(row!.targets[0]?.connectivity).toBe(expectedStatus);
      expect(row!.evidence).toEqual({ partial: true, unreachableNodes: [], unknown: true });
    }
    expect(remoteRows).toHaveLength(facets.length);
    expect(remoteRows.every(row => row.id.startsWith(`${remoteId}:app-remote-unknown-`))).toBe(true);
    expect(remoteRows.every(row => row.posture === 'unknown' && row.evidence.unknown)).toBe(true);
    expect(coverage.find(candidate => candidate.nodeId === remoteId)?.state).toBe('ok');
  });

  type MalformedProjection = Record<string, unknown>;
  type MalformedMutation = (projection: MalformedProjection, target: Record<string, unknown>) => void;
  const facetsOf = (projection: MalformedProjection): Record<string, unknown> =>
    projection.facets as Record<string, unknown>;
  const withTarget = (mutate: (target: Record<string, unknown>) => void): MalformedMutation =>
    (projection, target) => {
      mutate(target);
      projection.targets = [target];
    };
  const withArtifact = (mutate: () => ArtifactFacet): MalformedMutation =>
    (projection, target) => {
      facetsOf(projection).artifact = mutate();
      projection.targets = [target];
    };
  const validDrift: Record<string, unknown> = {
    class: 'runtime',
    expected: { kind: 'generation', id: 'gen-1' },
    observed: { kind: 'generation', id: 'gen-old' },
    freshnessAt: null,
    owner: 'test',
    reason: 'test',
    configuredPolicy: null,
    affectedTargets: [],
    action: 'none',
  };
  it('keeps a valid current remote drift item visible', async () => {
    const db = DatabaseService.getInstance();
    const localNodeId = db.getNodes()[0]!.id;
    const remoteId = addRemoteNode('port-remote-valid-drift', 29975);
    const revision = remoteProjection('app-remote-valid-drift', 'remote-valid-drift');
    revision.targets = [targetProjection('reachable')];
    revision.drift = [{
      class: 'runtime',
      expected: { kind: 'generation', id: 'gen-1' },
      observed: { kind: 'generation', id: 'gen-old' },
      freshnessAt: null,
      owner: 'test',
      reason: 'test',
      configuredPolicy: null,
      affectedTargets: [{ nodeId: 1, stackName: 'p-web' }],
      action: 'none',
    }];

    const { rows } = await aggregateGitOpsPortfolio(adminReq(localNodeId), {
      fetchRows: async (nodeId: number) => nodeId === remoteId
        ? remoteSourceRow('app-remote-valid-drift', 'remote-valid-drift', revision)
        : null,
    });

    const row = rows.find(candidate => candidate.id === `${remoteId}:app-remote-valid-drift`);
    expect(row).toBeDefined();
    expect(row!.drift).toEqual({ count: 1, classes: ['runtime'] });
    expect(row!.attention).toContain('drift');
  });

  const validDriftIdentities: Array<{ kind: string; value: GitOpsIdentityRef }> = [
    { kind: 'generation', value: { kind: 'generation', id: 'gen-1' } },
    { kind: 'commit', value: { kind: 'commit', sha: 'abc', repoUrl: 'https://example.test/repo.git', ref: 'main' } },
    { kind: 'artifact_set', value: { kind: 'artifact_set', id: 'artifact-1', qualification: 'exact', evidenceVersion: 1 } },
    { kind: 'runtime_artifact', value: { kind: 'runtime_artifact', identity: 'sha256:abc', observedAt: 1 } },
    { kind: 'intent', value: { kind: 'intent', id: 'intent-1', composeContentSha256: 'abc' } },
    {
      kind: 'invocation',
      value: {
        kind: 'invocation',
        authored: { composeFileOrder: ['compose.yaml'], projectName: null, projectDirectory: null, envFileOrder: [] },
      },
    },
    { kind: 'health_run', value: { kind: 'health_run', runId: 'run-1', deployedGenerationId: 'gen-1' } },
  ];
  it.each(validDriftIdentities)('accepts $kind drift identity references', ({ value }) => {
    const projection = remoteProjection(`app-drift-${value.kind}`, `drift-${value.kind}`);
    projection.drift = [{
      class: 'runtime',
      expected: value,
      observed: value,
      freshnessAt: null,
      owner: 'test',
      reason: 'test',
      configuredPolicy: null,
      affectedTargets: [],
      action: 'none',
    }];
    expect(isUsableRevision(projection)).toBe(true);
  });

  const malformedRemoteCases: Array<{ kind: string; mutate: MalformedMutation }> = [
    { kind: 'null_target', mutate: projection => { projection.targets = [null]; } },
    {
      kind: 'malformed_blueprint_bound_placement',
      mutate: (projection, target) => {
        projection.targetMode = 'blueprint';
        projection.stackName = null;
        projection.blueprintId = 1;
        facetsOf(projection).placement = { status: 'blueprint_bound' };
        projection.targets = [target];
      },
    },
    {
      kind: 'invalid_direct_mode_shape',
      mutate: projection => { projection.stackName = null; },
    },
    {
      kind: 'invalid_blueprint_mode_shape',
      mutate: projection => { projection.targetMode = 'blueprint'; projection.stackName = null; projection.blueprintId = null; },
    },
    {
      kind: 'malformed_configured_policy',
      mutate: projection => { projection.drift = [{ ...validDrift, configuredPolicy: { kind: 'future_policy' } }]; },
    },
    { kind: 'missing_runtime', mutate: withTarget(target => { delete target.runtime; }) },
    { kind: 'missing_health', mutate: withTarget(target => { delete target.health; }) },
    { kind: 'malformed_passed_health', mutate: withTarget(target => { target.health = { status: 'passed' }; }) },
    { kind: 'missing_observed_identity', mutate: withTarget(target => { delete target.observedArtifactIdentity; }) },
    { kind: 'missing_target_artifact', mutate: withTarget(target => { delete target.artifact; }) },
    {
      kind: 'malformed_observation_services',
      mutate: withTarget(target => { target.observedArtifactIdentity = { kind: 'future_kind', services: {} }; }),
    },
    {
      kind: 'future_observation_kind',
      mutate: withTarget(target => { target.observedArtifactIdentity = { kind: 'future_kind', identity: 'x', observedAt: 1 }; }),
    },
    {
      kind: 'empty_observed_identity',
      mutate: withTarget(target => { target.observedArtifactIdentity = { kind: 'exact', identity: '', observedAt: 1 }; }),
    },
    {
      kind: 'empty_latest_evidence_identity',
      mutate: withArtifact(() => Object.assign(artifactFacet(), { latestEvidence: { ...artifactFacet().latestEvidence, identity: '' } })),
    },
    {
      kind: 'null_latest_evidence_identity',
      mutate: withArtifact(() => Object.assign(artifactFacet(), { latestEvidence: { ...artifactFacet().latestEvidence, identity: null } })),
    },
    {
      kind: 'malformed_service_order',
      mutate: withTarget(target => {
        const expected = artifactFacet().expected;
        if (!expected) throw new Error('expected artifact fixture');
        target.artifact = { ...artifactFacet(), expected: {
          ...expected,
          services: [
            Object.assign(serviceEvidence(`sha256:${'b'.repeat(64)}`), { serviceName: 'z-service' }),
            Object.assign(serviceEvidence(`sha256:${'a'.repeat(64)}`), { serviceName: 'a-service' }),
          ],
        } };
      }),
    },
    {
      kind: 'duplicate_service',
      mutate: withTarget(target => {
        const expected = artifactFacet().expected;
        if (!expected) throw new Error('expected artifact fixture');
        target.artifact = { ...artifactFacet(), expected: {
          ...expected,
          services: [serviceEvidence(`sha256:${'a'.repeat(64)}`), serviceEvidence(`sha256:${'b'.repeat(64)}`)],
        } };
      }),
    },
    {
      kind: 'malformed_platform_variant_order',
      mutate: withTarget(target => {
        const expected = artifactFacet().expected;
        if (!expected) throw new Error('expected artifact fixture');
        target.artifact = { ...artifactFacet(), expected: {
          ...expected,
          services: [Object.assign(serviceEvidence(`sha256:${'a'.repeat(64)}`), {
            platformVariants: [
              { platform: 'linux/arm64', digest: 'sha256:arm' },
              { platform: 'linux/amd64', digest: 'sha256:amd' },
            ],
          })],
        } };
      }),
    },
    {
      kind: 'malformed_local_digest_order',
      mutate: withTarget(target => {
        const expected = artifactFacet().expected;
        if (!expected) throw new Error('expected artifact fixture');
        target.artifact = { ...artifactFacet(), expected: {
          ...expected,
          services: [Object.assign(serviceEvidence(`sha256:${'a'.repeat(64)}`), {
            localDigests: ['sha256:z', 'sha256:a'],
          })],
        } };
      }),
    },
    {
      kind: 'malformed_target_artifact_services',
      mutate: withTarget(target => {
        target.artifact = { ...artifactFacet(), expected: { ...artifactFacet().expected, services: {} } };
      }),
    },
    {
      kind: 'future_service_failure_class',
      mutate: withTarget(target => {
        const expected = artifactFacet().expected;
        if (!expected) throw new Error('expected artifact fixture');
        target.artifact = { ...artifactFacet(), expected: {
          ...expected,
          services: [Object.assign(serviceEvidence('sha256:abc'), { failureClass: 'future_failure' })],
        } };
      }),
    },
    {
      kind: 'future_top_level_service_failure_class',
      mutate: withArtifact(() => {
        const artifact = artifactFacet();
        if (!artifact.expected) throw new Error('expected artifact fixture');
        artifact.expected.services = [
          Object.assign(serviceEvidence('sha256:abc'), { failureClass: 'future_failure' }),
        ];
        return artifact;
      }),
    },
    {
      kind: 'empty_expected_artifact_set_id',
      mutate: withArtifact(() => {
        const artifact = artifactFacet();
        if (!artifact.expected) throw new Error('expected artifact fixture');
        artifact.expected.artifactSetId = '';
        return artifact;
      }),
    },
    {
      kind: 'empty_expected_identity',
      mutate: withArtifact(() => {
        const artifact = artifactFacet();
        if (!artifact.expected) throw new Error('expected artifact fixture');
        artifact.expected.identity = '';
        return artifact;
      }),
    },
    {
      kind: 'empty_artifact_set_id',
      mutate: withArtifact(() => {
        const artifact = artifactFacet();
        return Object.assign(artifact, {
          artifactSetId: '',
          latestEvidence: { ...artifact.latestEvidence, artifactSetId: '' },
        });
      }),
    },
    {
      kind: 'future_target_artifact_status',
      mutate: withTarget(target => { target.artifact = { status: 'artifact_future_status' }; }),
    },
    {
      kind: 'infinite_artifact_version',
      mutate: withArtifact(() => Object.assign(artifactFacet(), { evidenceVersion: Number.POSITIVE_INFINITY })),
    },
    {
      kind: 'malformed_target_approval',
      mutate: withTarget(target => { Object.assign(target, { approvals: { rolloutAuthorizationRef: 42 } }); }),
    },
    { kind: 'malformed_target_lkg', mutate: withTarget(target => { target.lkg = { status: 'available' }; }) },
    {
      kind: 'lkg_empty_generation',
      mutate: withTarget(target => { target.lkg = { status: 'available', generationId: '', artifactSetId: null }; }),
    },
    {
      kind: 'lkg_empty_qualified_artifact',
      mutate: withTarget(target => { target.lkg = { status: 'qualified', generationId: 'gen-1', artifactSetId: '' }; }),
    },
    {
      kind: 'lkg_none_with_unavailable_marker',
      mutate: withTarget(target => {
        target.lkg = { status: 'none' };
        target.lkgUnavailableAt = 1;
        target.lkgUnavailableReason = 'generation_missing';
      }),
    },
    {
      kind: 'lkg_unavailable_without_reason',
      mutate: withTarget(target => { target.lkgUnavailableAt = 1; }),
    },
    {
      kind: 'lkg_reason_without_timestamp',
      mutate: withTarget(target => { target.lkgUnavailableReason = 'generation_missing'; }),
    },
    {
      kind: 'lkg_unavailable_with_pointers',
      mutate: withTarget(target => {
        target.lkgUnavailableAt = 1;
        target.lkgUnavailableReason = 'generation_missing';
      }),
    },
    { kind: 'malformed_qualified_lkg', mutate: withTarget(target => { target.lkg = { status: 'qualified', generationId: 'gen-1' }; }) },
    { kind: 'future_lkg_status', mutate: withTarget(target => { target.lkg = { status: 'future_lkg' }; }) },
    {
      kind: 'invalid_lkg_unavailable_reason',
      mutate: withTarget(target => {
        target.lkgUnavailableAt = 1;
        target.lkgUnavailableReason = 'future_reason';
      }),
    },
    { kind: 'missing_runtime_status', mutate: withTarget(target => { target.runtime = {}; }) },
    { kind: 'missing_health_status', mutate: withTarget(target => { target.health = {}; }) },
    { kind: 'malformed_facet', mutate: projection => { facetsOf(projection).source = null; } },
    {
      kind: 'missing_top_level_rollout_generation',
      mutate: (projection, target) => {
        projection.targetMode = 'blueprint';
        delete projection.rolloutGenerationId;
        facetsOf(projection).rollout = { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' };
        target.rolloutGenerationId = 'rg-1';
        projection.targets = [target];
      },
    },
    {
      kind: 'missing_facet_rollout_generation',
      mutate: (projection, target) => {
        projection.targetMode = 'blueprint';
        projection.rolloutGenerationId = 'rg-1';
        facetsOf(projection).rollout = { status: 'exactly_converged_healthy' };
        target.rolloutGenerationId = 'rg-1';
        projection.targets = [target];
      },
    },
    {
      kind: 'missing_target_rollout_generation',
      mutate: (projection, target) => {
        projection.targetMode = 'blueprint';
        projection.rolloutGenerationId = 'rg-1';
        facetsOf(projection).rollout = { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' };
        delete target.rolloutGenerationId;
        projection.targets = [target];
      },
    },
    { kind: 'missing_desired_generation', mutate: withTarget(target => { delete target.desiredGenerationId; }) },
    { kind: 'missing_applied_generation', mutate: withTarget(target => { delete target.appliedGenerationId; }) },
    { kind: 'missing_healthy_generation', mutate: withTarget(target => { delete target.healthyGenerationId; }) },
    { kind: 'missing_artifact_proof', mutate: withArtifact(() => ({ status: 'artifact_exact' } as ArtifactFacet)) },
    { kind: 'missing_qualified_artifact_proof', mutate: withArtifact(() => ({ status: 'artifact_qualified' } as ArtifactFacet)) },
    {
      kind: 'missing_latest_evidence',
      mutate: withArtifact(() => Object.assign(artifactFacet(), { latestEvidence: undefined })),
    },
    { kind: 'malformed_drift', mutate: projection => { projection.drift = [null]; } },
    {
      kind: 'drift_missing_affected_targets',
      mutate: projection => {
        const drift = { ...validDrift };
        delete drift.affectedTargets;
        projection.drift = [drift];
      },
    },
    {
      kind: 'drift_malformed_affected_target',
      mutate: projection => {
        projection.drift = [{ ...validDrift, affectedTargets: [{ nodeId: 'one' }] }];
      },
    },
    {
      kind: 'drift_missing_identity',
      mutate: projection => {
        const drift = { ...validDrift };
        delete drift.expected;
        projection.drift = [drift];
      },
    },
    {
      kind: 'drift_future_identity_kind',
      mutate: projection => { projection.drift = [{ ...validDrift, expected: { kind: 'future_kind', id: 'gen-1' } }]; },
    },
    {
      kind: 'drift_empty_identity_id',
      mutate: projection => { projection.drift = [{ ...validDrift, expected: { kind: 'generation', id: '' } }]; },
    },
    {
      kind: 'drift_future_class',
      mutate: projection => { projection.drift = [{ ...validDrift, class: 'future_drift' }]; },
    },
    {
      kind: 'drift_future_action',
      mutate: projection => { projection.drift = [{ ...validDrift, action: 'future_action' }]; },
    },
    { kind: 'malformed_limitation', mutate: projection => { projection.limitations = [null]; } },
    { kind: 'malformed_available_action', mutate: projection => { projection.availableActions = [null]; } },
    {
      kind: 'missing_source_field',
      mutate: projection => { delete (facetsOf(projection).source as Record<string, unknown>).acceptedGenerationId; },
    },
    {
      kind: 'mismatched_artifact_qualification',
      mutate: withArtifact(() => Object.assign(artifactFacet(), { qualification: 'qualified' })),
    },
    {
      kind: 'identity_changed_exact_proof',
      mutate: withArtifact(() => Object.assign(artifactFacet(), {
        expected: { artifactSetId: 'artifact-1', evidenceVersion: 1, qualification: 'exact', identity: 'sha256:different' },
      })),
    },
    {
      kind: 'future_expected_qualification',
      mutate: withArtifact(() => Object.assign(artifactFacet(), {
        expected: { artifactSetId: 'artifact-1', evidenceVersion: 1, qualification: 'future_qualification', identity: 'sha256:abc' },
      })),
    },
    { kind: 'missing_schema_version', mutate: projection => { delete projection.schemaVersion; } },
    { kind: 'invalid_stack_name', mutate: projection => { projection.stackName = 42; } },
    { kind: 'invalid_blueprint_id', mutate: projection => { projection.blueprintId = 'blueprint-1'; } },
    {
      kind: 'missing_source_poll_time',
      mutate: projection => { delete (facetsOf(projection).source as Record<string, unknown>).nextPollAt; },
    },
  ];

  it.each(malformedRemoteCases)(
    'degrades a structurally malformed remote projection to an unknown row: $kind',
    async ({ kind, mutate }) => {
      const db = DatabaseService.getInstance();
      const localNodeId = db.getNodes()[0]!.id;
      const remoteId = addRemoteNode(
        `port-remote-${kind}`,
        29990 + malformedRemoteCases.findIndex(testCase => testCase.kind === kind),
      );
      const stackName = `malformed-${kind}`;
      const revision = remoteProjection(`app-${kind}`, stackName);
      const malformed = revision as unknown as Record<string, unknown>;
      const target = targetProjection('reachable') as unknown as Record<string, unknown>;
      mutate(malformed, target);

      const { rows, coverage } = await aggregateGitOpsPortfolio(adminReq(localNodeId), {
        fetchRows: async (nodeId: number) => nodeId === remoteId
          ? remoteSourceRow(`app-${kind}`, stackName, malformed as unknown as GitOpsRevisionProjection)
          : null,
      });

      const row = rows.find(candidate => candidate.id === `${remoteId}:legacy:${stackName}`);
      expect(row).toBeDefined();
      expect(row!.posture).toBe('unknown');
      expect(row!.evidence).toEqual({ partial: true, unreachableNodes: [], unknown: true });
      expect(coverage.find(candidate => candidate.nodeId === remoteId)?.state).toBe('ok');
    },
  );

  it.each([null, 'run-1'])('accepts pending health with run identifier %s as explicit progress', runId => {
    const projection = remoteProjection('app-pending-health', 'pending-health');
    projection.targets = [targetProjection('reachable')];
    const target = projection.targets[0]!;
    target.health = { status: 'pending', runId };
    expect(isUsableRevision(projection)).toBe(true);
    expect(rowForProjection(projection, 'pending-health').posture).toBe('in_progress');
  });

  it('accepts a paired unavailable last-known-good record', () => {
    const projection = remoteProjection('app-lkg-unavailable', 'lkg-unavailable');
    const target = remoteTarget(projection, 'reachable');
    target.lkg = { status: 'unavailable' };
    target.lkgGenerationId = null;
    target.lkgArtifactSetId = null;
    target.lkgUnavailableAt = 1;
    target.lkgUnavailableReason = 'generation_missing';
    projection.targets = [target];
    expect(isUsableRevision(projection)).toBe(true);
  });

  it('accepts a qualified last-known-good record as settled evidence', () => {
    const projection = remoteProjection('app-qualified-lkg', 'qualified-lkg');
    const target = remoteTarget(projection, 'reachable');
    target.lkg = { status: 'qualified', generationId: 'gen-1', artifactSetId: 'artifact-1' };
    target.lkgArtifactSetId = 'artifact-1';
    projection.targets = [target];
    expect(isUsableRevision(projection)).toBe(true);
    expect(rowForProjection(projection, 'qualified-lkg').posture).toBe('converged');
  });

  it.each([
    { status: 'not_applicable' as const, expected: 'converged' },
    { status: 'unbound' as const, expected: 'unknown' },
  ])('distinguishes $status health from settled health', ({ status, expected }) => {
    const projection = remoteProjection(`app-health-${status}`, `health-${status}`);
    const target = remoteTarget(projection, 'reachable');
    target.health = { status };
    projection.targets = [target];
    expect(rowForProjection(projection, `health-${status}`).posture).toBe(expected);
  });

  it('accepts a canonical top-level service failure class', () => {
    const projection = remoteProjection('app-service-failure', 'service-failure');
    const artifact = artifactFacet();
    if (!artifact.expected) throw new Error('expected artifact fixture');
    const service = Object.assign(serviceEvidence(`sha256:${'a'.repeat(64)}`), { failureClass: 'digest_unavailable' });
    artifact.expected.services = [service];
    projection.facets.artifact = artifact;
    const target = remoteTarget(projection, 'reachable');
    target.artifact = artifact;
    target.expectedArtifactSetId = artifact.artifactSetId;
    target.latestArtifactSetId = artifact.artifactSetId;
    target.observedArtifactIdentity = {
      kind: 'exact',
      identity: 'sha256:abc',
      observedAt: 1,
      services: [service],
    };
    projection.targets = [target];
    expect(isUsableRevision(projection)).toBe(true);
    expect(rowForProjection(projection, 'service-failure').posture).toBe('converged');
  });

  it('accepts the canonical locale ordering for service names', () => {
    const projection = remoteProjection('app-service-order', 'service-order');
    const artifact = artifactFacet();
    if (!artifact.expected) throw new Error('expected artifact fixture');
    const lower = Object.assign(serviceEvidence(`sha256:${'a'.repeat(64)}`), { serviceName: 'a-service' });
    const upper = Object.assign(serviceEvidence(`sha256:${'b'.repeat(64)}`), { serviceName: 'B-service' });
    artifact.expected.services = [lower, upper];
    projection.facets.artifact = artifact;
    const target = remoteTarget(projection, 'reachable');
    target.artifact = artifact;
    target.observedArtifactIdentity = {
      kind: 'exact',
      identity: 'sha256:abc',
      observedAt: 1,
      services: [lower, upper],
    };
    projection.targets = [target];
    expect(isUsableRevision(projection)).toBe(true);
  });

  it('degrades incomplete remote source rows without dropping valid live rows', async () => {
    const db = DatabaseService.getInstance();
    const localNodeId = db.getNodes()[0]!.id;
    const remoteId = addRemoteNode('port-remote-row-shapes', 29981);
    const live = remoteProjection('app-valid-without-source-name', 'projection-name');
    const payload: unknown[] = [
      null,
      { stack_name: 'legacy-without-revision' },
      ...remoteSourceRow('app-valid-without-source-name', 'ignored-name', live),
    ];
    payload[2] = { ...(payload[2] as Record<string, unknown>), stack_name: null };

    const { rows, coverage } = await aggregateGitOpsPortfolio(adminReq(localNodeId), {
      fetchRows: async (nodeId: number) => nodeId === remoteId ? payload : null,
    });

    const remoteRows = rows.filter(row => row.id.startsWith(`${remoteId}:`));
    expect(remoteRows.some(row => row.id === `${remoteId}:legacy:legacy-without-revision`)).toBe(true);
    expect(remoteRows.some(row => row.id === `${remoteId}:app-valid-without-source-name`)).toBe(true);
    expect(remoteRows).toHaveLength(2);
    expect(coverage.find(candidate => candidate.nodeId === remoteId)?.state).toBe('ok');
  });

  it('keeps a canonical exact artifact usable when the expected identity is absent', async () => {
    const db = DatabaseService.getInstance();
    const localNodeId = db.getNodes()[0]!.id;
    const remoteId = addRemoteNode('port-remote-null-expected', 29980);
    const revision = remoteProjection('app-null-expected', 'null-expected');
    const artifact = artifactFacet();
    Object.assign(artifact, { expected: null });
    revision.facets.artifact = artifact;
    revision.targets = [remoteTarget(revision, 'reachable')];
    revision.availableActions = ['fetch', 'deploy'];

    const { rows } = await aggregateGitOpsPortfolio(adminReq(localNodeId), {
      fetchRows: async (nodeId: number) => nodeId === remoteId
        ? remoteSourceRow('app-null-expected', 'null-expected', revision)
        : null,
    });

    const row = rows.find(candidate => candidate.id === `${remoteId}:app-null-expected`);
    expect(row).toBeDefined();
    expect(row!.posture).toBe('converged');
    expect(row!.availableActions).toEqual(['fetch', 'deploy']);
    expect(row!.evidence).toEqual({ partial: false, unreachableNodes: [], unknown: false });
  });

  it.each([
    {
      label: 'absent expected identity',
      applicationId: 'app-null-expected-conflict',
      port: 29983,
      mutate: (artifact: ReturnType<typeof artifactFacet>) => { Object.assign(artifact, { expected: null }); },
    },
    {
      label: 'null expected identity',
      applicationId: 'app-null-identity-conflict',
      port: 29984,
      mutate: (artifact: ReturnType<typeof artifactFacet>) => {
        if (!artifact.expected) throw new Error('expected artifact fixture');
        artifact.expected.identity = null;
      },
    },
  ])('does not accept a conflicting observation when $label', async ({ applicationId, port, mutate }) => {
    const db = DatabaseService.getInstance();
    const localNodeId = db.getNodes()[0]!.id;
    const remoteId = addRemoteNode(`port-remote-${applicationId}`, port);
    const revision = remoteProjection(applicationId, applicationId);
    const artifact = artifactFacet();
    mutate(artifact);
    revision.facets.artifact = artifact;
    const target = remoteTarget(revision, 'reachable');
    target.artifact = artifact;
    target.observedArtifactIdentity = { kind: 'exact', identity: 'sha256:other', observedAt: 1 };
    revision.targets = [target];
    const { rows } = await aggregateGitOpsPortfolio(adminReq(localNodeId), {
      fetchRows: async (nodeId: number) => nodeId === remoteId
        ? remoteSourceRow(applicationId, applicationId, revision)
        : null,
    });
    const row = rows.find(candidate => candidate.id === `${remoteId}:${applicationId}`);
    expect(row).toBeDefined();
    expect(row!.posture).toBe('unknown');
  });

  it('accepts matching latest evidence when expected identity is null', () => {
    const projection = remoteProjection('app-null-identity-match', 'null-identity-match');
    const artifact = artifactFacet();
    if (!artifact.expected) throw new Error('expected artifact fixture');
    artifact.expected.identity = null;
    projection.facets.artifact = artifact;
    const target = remoteTarget(projection, 'reachable');
    target.artifact = artifact;
    projection.targets = [target];
    expect(isUsableRevision(projection)).toBe(true);
    expect(rowForProjection(projection, 'null-identity-match').posture).toBe('converged');
  });

  it('does not accept a dangling expected-artifact pointer without a target record', () => {
    const projection = remoteProjection('app-dangling-expected', 'dangling-expected');
    const artifact = artifactFacet();
    Object.assign(artifact, { expected: null });
    projection.facets.artifact = artifact;
    const target = remoteTarget(projection, 'reachable');
    target.artifact = artifact;
    Object.assign(target.artifact, { expected: undefined });
    projection.targets = [target];
    expect(rowForProjection(projection, 'dangling-expected').posture).toBe('unknown');
  });

  it('does not accept a conflicting target latest identity when expected identity is null', () => {
    const projection = remoteProjection('app-null-latest-conflict', 'null-latest-conflict');
    const artifact = artifactFacet();
    if (!artifact.expected) throw new Error('expected artifact fixture');
    artifact.expected.identity = null;
    projection.facets.artifact = artifact;
    const target = remoteTarget(projection, 'reachable');
    target.artifact = artifact;
    Object.assign(target.artifact, { latestEvidence: { ...artifact.latestEvidence, identity: 'sha256:other' } });
    projection.targets = [target];
    expect(rowForProjection(projection, 'null-latest-conflict').posture).toBe('unknown');
  });

  it('accepts canonical artifact metadata from different expected and latest artifact sets', async () => {
    const db = DatabaseService.getInstance();
    const localNodeId = db.getNodes()[0]!.id;
    const remoteId = addRemoteNode('port-remote-expected-drift', 29978);
    const revision = remoteProjection('app-expected-drift', 'expected-drift');
    const artifact = artifactFacet();
    Object.assign(artifact, {
      expected: {
        artifactSetId: 'artifact-0',
        evidenceVersion: 0,
        qualification: 'exact',
        identity: 'sha256:abc',
      },
    });
    revision.facets.artifact = artifact;
    if (!artifact.expected) throw new Error('expected artifact identity fixture');
    const target = remoteTarget(revision, 'reachable');
    target.expectedArtifactSetId = artifact.expected.artifactSetId;
    Object.assign(target.artifact, {
      expected: artifact.expected,
    });
    revision.targets = [target];

    const { rows } = await aggregateGitOpsPortfolio(adminReq(localNodeId), {
      fetchRows: async (nodeId: number) => nodeId === remoteId
        ? remoteSourceRow('app-expected-drift', 'expected-drift', revision)
        : null,
    });

    const row = rows.find(candidate => candidate.id === `${remoteId}:app-expected-drift`);
    expect(row).toBeDefined();
    expect(row!.posture).toBe('converged');
  });

  it('keeps semantically incomplete remote projections visible as live unknown rows', async () => {
    const db = DatabaseService.getInstance();
    const localNodeId = db.getNodes()[0]!.id;
    const remoteId = addRemoteNode('port-remote-semantic', 29979);
    const outOfSet = remoteProjection('app-remote-out-of-set', 'remote-out-of-set');
    outOfSet.targetMode = 'blueprint';
    bindBlueprintAuthority(outOfSet);
    outOfSet.rolloutGenerationId = 'rg-1';
    outOfSet.facets.rollout = { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' };
    outOfSet.targets = [targetProjection('reachable', 'rg-old')];
    const tombstonedOnly = remoteProjection('app-remote-tombstoned-only', 'remote-tombstoned-only');
    tombstonedOnly.targetMode = 'blueprint';
    bindBlueprintAuthority(tombstonedOnly);
    tombstonedOnly.rolloutGenerationId = 'rg-1';
    tombstonedOnly.facets.rollout = { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' };
    const tombstonedTarget = targetProjection('reachable', 'rg-1');
    Object.assign(tombstonedTarget, { tombstoned: true, runtime: { status: 'tombstoned' } });
    tombstonedOnly.targets = [tombstonedTarget];
    const rolloutOnDirect = remoteProjection('app-remote-rollout-direct', 'remote-rollout-direct');
    rolloutOnDirect.rolloutGenerationId = 'rg-1';
    rolloutOnDirect.facets.rollout = { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' };
    rolloutOnDirect.targets = [targetProjection('reachable', 'rg-1')];
    const generationMismatch = remoteProjection('app-remote-generation-mismatch', 'remote-generation-mismatch');
    generationMismatch.targetMode = 'blueprint';
    bindBlueprintAuthority(generationMismatch);
    generationMismatch.rolloutGenerationId = 'rg-other';
    generationMismatch.facets.rollout = { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' };
    generationMismatch.targets = [targetProjection('reachable', 'rg-1')];
    const applicationIds = [
      'app-remote-out-of-set',
      'app-remote-tombstoned-only',
      'app-remote-rollout-direct',
      'app-remote-generation-mismatch',
    ];
    const payload = [
      ...remoteSourceRow('app-remote-out-of-set', 'remote-out-of-set', outOfSet),
      ...remoteSourceRow('app-remote-tombstoned-only', 'remote-tombstoned-only', tombstonedOnly),
      ...remoteSourceRow('app-remote-rollout-direct', 'remote-rollout-direct', rolloutOnDirect),
      ...remoteSourceRow('app-remote-generation-mismatch', 'remote-generation-mismatch', generationMismatch),
    ];

    const { rows, coverage } = await aggregateGitOpsPortfolio(adminReq(localNodeId), {
      fetchRows: async (nodeId: number) => nodeId === remoteId ? payload : null,
    });

    for (const applicationId of applicationIds) {
      const row = rows.find(candidate => candidate.id === `${remoteId}:${applicationId}`);
      expect(row).toBeDefined();
      expect(row!.posture).toBe('unknown');
      expect(row!.evidence).toEqual({ partial: true, unreachableNodes: [], unknown: true });
    }
    const remoteRows = rows.filter(row => row.id.startsWith(`${remoteId}:`));
    expect(remoteRows.map(row => row.id).sort()).toEqual(applicationIds.map(id => `${remoteId}:${id}`).sort());
    expect(coverage.find(candidate => candidate.nodeId === remoteId)?.state).toBe('ok');
  });

  it('keeps remote convergence claims unknown without complete generation proof', async () => {
    const db = DatabaseService.getInstance();
    const localNodeId = db.getNodes()[0]!.id;
    const remoteId = addRemoteNode('port-remote-generation-proof', 29977);
    const missingAccepted = remoteProjection('app-remote-missing-accepted', 'remote-missing-accepted');
    missingAccepted.facets.artifact = artifactFacet();
    Object.assign(missingAccepted.facets.source, { acceptedGenerationId: null });
    missingAccepted.targets = [targetProjection('reachable')];
    const missingTargetProof = remoteProjection('app-remote-missing-target-proof', 'remote-missing-target-proof');
    missingTargetProof.facets.artifact = artifactFacet();
    missingTargetProof.targets = [{
      ...targetProjection('reachable'),
      desiredGenerationId: null,
      appliedGenerationId: null,
      deployedGenerationId: null,
      healthyGenerationId: null,
    }];
    const missingArtifactProof = remoteProjection('app-remote-missing-artifact-proof', 'remote-missing-artifact-proof');
    missingArtifactProof.facets.artifact = { status: 'not_applicable' };
    missingArtifactProof.targetMode = 'blueprint';
    bindBlueprintAuthority(missingArtifactProof);
    missingArtifactProof.rolloutGenerationId = 'rg-1';
    missingArtifactProof.facets.rollout = { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' };
    missingArtifactProof.targets = [targetProjection('reachable', 'rg-1')];
    const applicationIds = [
      'app-remote-missing-accepted',
      'app-remote-missing-target-proof',
      'app-remote-missing-artifact-proof',
    ];
    const payload = applicationIds.flatMap((applicationId, index) => {
      const revision = [missingAccepted, missingTargetProof, missingArtifactProof][index]!;
      return remoteSourceRow(applicationId, revision.stackName!, revision);
    });

    const { rows, coverage } = await aggregateGitOpsPortfolio(adminReq(localNodeId), {
      fetchRows: async (nodeId: number) => nodeId === remoteId ? payload : null,
    });

    for (const applicationId of applicationIds) {
      const row = rows.find(candidate => candidate.id === `${remoteId}:${applicationId}`);
      expect(row).toBeDefined();
      expect(row!.posture, applicationId).toBe('unknown');
      expect(row!.evidence).toEqual({ partial: true, unreachableNodes: [], unknown: true });
    }
    expect(coverage.find(candidate => candidate.nodeId === remoteId)?.state).toBe('ok');
  });

  it.each([
    { connectivity: 'unknown', unknown: true },
    { connectivity: 'stale', unknown: false },
  ] as const)('keeps $connectivity target evidence visible in row-level evidence', ({ connectivity, unknown }) => {
    const projection = remoteProjection(`app-${connectivity}-evidence`, `${connectivity}-evidence`);
    projection.targets = [targetProjection(connectivity)];
    const row = rowForProjection(projection, `${connectivity}-evidence`);
    expect(row.evidence).toEqual({ partial: true, unreachableNodes: [], unknown });
    expect(row.targets[0]?.evidence).toBe(connectivity);
  });

  it.each([
    {
      name: 'a single unreachable target',
      build: (projection: Extract<GitOpsRevisionProjection, { applicationId: string }>) => {
        projection.targets = [targetProjection('unreachable', null, 2, 'unreachable-web')];
      },
      posture: 'failed',
      evidence: { partial: true, unreachableNodes: [2], unknown: false },
      targetEvidence: ['unknown'],
    },
    {
      name: 'mixed reachable and stale rollout targets',
      build: (projection: Extract<GitOpsRevisionProjection, { applicationId: string }>) => {
        projection.targetMode = 'blueprint';
        projection.rolloutGenerationId = 'rg-1';
        bindBlueprintAuthority(projection);
        projection.facets.rollout = { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' };
        projection.targets = [targetProjection('reachable', 'rg-1', 1), targetProjection('stale', 'rg-1', 2, 'stale-web')];
      },
      posture: 'attention',
      evidence: { partial: true, unreachableNodes: [], unknown: false },
      targetEvidence: ['fresh', 'stale'],
    },
    {
      name: 'mixed reachable and unknown rollout targets',
      build: (projection: Extract<GitOpsRevisionProjection, { applicationId: string }>) => {
        projection.targetMode = 'blueprint';
        projection.rolloutGenerationId = 'rg-1';
        bindBlueprintAuthority(projection);
        projection.facets.rollout = { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' };
        projection.targets = [targetProjection('reachable', 'rg-1', 1), targetProjection('unknown', 'rg-1', 2, 'unknown-web')];
      },
      posture: 'unknown',
      evidence: { partial: true, unreachableNodes: [], unknown: true },
      targetEvidence: ['fresh', 'unknown'],
    },
    {
      name: 'mixed reachable and unreachable rollout targets',
      build: (projection: Extract<GitOpsRevisionProjection, { applicationId: string }>) => {
        projection.targetMode = 'blueprint';
        projection.rolloutGenerationId = 'rg-1';
        bindBlueprintAuthority(projection);
        projection.facets.rollout = { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' };
        projection.targets = [targetProjection('reachable', 'rg-1', 1), targetProjection('unreachable', 'rg-1', 2, 'unreachable-web')];
      },
      posture: 'failed',
      evidence: { partial: true, unreachableNodes: [2], unknown: false },
      targetEvidence: ['fresh', 'unknown'],
    },
  ] as const)('reports row-level evidence for $name', ({ build, posture, evidence, targetEvidence }) => {
    const projection = remoteProjection('app-row-evidence', 'row-evidence');
    build(projection);
    const row = rowForProjection(projection, 'row-evidence');
    expect(row.posture).toBe(posture);
    expect(row.evidence).toEqual(evidence);
    expect(row.targets.map(target => target.evidence)).toEqual(targetEvidence);
  });

  it('marks missing target evidence partial and unknown', () => {
    const projection = remoteProjection('app-missing-evidence', 'missing-evidence');
    const row = rowForProjection(projection, 'missing-evidence');
    expect(row.evidence).toEqual({ partial: true, unreachableNodes: [], unknown: true });
  });

  it('treats unrecognized target connectivity as unknown evidence', () => {
    const projection = remoteProjection('app-future-connectivity', 'future-connectivity');
    const target = remoteTarget(projection, 'reachable');
    Object.assign(target, { connectivity: 'future_state' });
    projection.targets = [target];
    const row = rowForProjection(projection, 'future-connectivity');
    expect(row.evidence).toEqual({ partial: true, unreachableNodes: [], unknown: true });
    expect(row.targets[0]?.evidence).toBe('unknown');
  });

  it('marks an active out-of-set target as partial unknown evidence', () => {
    const projection = remoteProjection('app-out-of-set', 'out-of-set');
    projection.targetMode = 'blueprint';
    projection.rolloutGenerationId = 'rg-1';
    projection.facets.rollout = { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' };
    projection.targets = [targetProjection('reachable', 'rg-old')];
    const row = rowForProjection(projection, 'out-of-set');
    expect(row.posture).toBe('unknown');
    expect(row.evidence).toEqual({ partial: true, unreachableNodes: [], unknown: true });
  });

  it.each([
    { label: 'settled direct', mode: 'direct', rolloutStatus: 'not_applicable', expectedPosture: 'converged' },
    { label: 'stale direct', mode: 'direct', rolloutStatus: 'target_stale', expectedPosture: 'converged' },
    { label: 'unreachable direct', mode: 'direct', rolloutStatus: 'target_unreachable', expectedPosture: 'converged' },
    { label: 'stale blueprint', mode: 'blueprint', rolloutStatus: 'target_stale', expectedPosture: 'unknown' },
    { label: 'unreachable blueprint', mode: 'blueprint', rolloutStatus: 'target_unreachable', expectedPosture: 'unknown' },
  ] as const)(
    'keeps tombstoned $label target history out of current row evidence',
    ({ mode, rolloutStatus, expectedPosture }) => {
      const projection = remoteProjection(`app-tombstoned-${mode}-row`, `tombstoned-${mode}-row`);
      projection.targetMode = mode;
      if (mode === 'direct') {
        projection.facets.artifact = artifactFacet();
        projection.facets.rollout = { status: rolloutStatus };
      } else {
        projection.rolloutGenerationId = 'rg-1';
        projection.facets.rollout = { status: rolloutStatus };
      }
      const historicalTarget = (
        connectivity: GitOpsTargetProjection['connectivity'],
        nodeId: number,
        stackName: string,
      ): GitOpsTargetProjection => ({
        ...targetProjection(connectivity, mode === 'blueprint' ? 'rg-1' : null, nodeId, stackName),
        tombstoned: true,
        runtime: { status: 'tombstoned' },
      });
      const malformed = historicalTarget('reachable', 4, 'malformed-web');
      Object.assign(malformed, { connectivity: 'future_state' });
      projection.targets = [
        remoteTarget(projection, 'reachable', mode === 'blueprint' ? 'rg-1' : null),
        historicalTarget('unreachable', 2, 'unreachable-web'),
        historicalTarget('unknown', 3, 'unknown-web'),
        historicalTarget('stale', 5, 'stale-web'),
        malformed,
      ];
      const row = rowForProjection(projection, `tombstoned-${mode}-row`);
      expect(row.posture).toBe(expectedPosture);
      expect(row.evidence).toEqual({ partial: false, unreachableNodes: [], unknown: false });
      expect(row.targets.map(target => target.evidence)).toEqual(['fresh', 'unknown', 'unknown', 'stale', 'unknown']);
      expect(row.targets.map(target => target.tombstoned)).toEqual([false, true, true, true, true]);
    },
  );

  it('reports an all-history row as missing current evidence', () => {
    const projection = remoteProjection('app-all-history', 'all-history');
    const historical = targetProjection('unreachable', null, 2, 'historical-web');
    Object.assign(historical, { tombstoned: true, runtime: { status: 'tombstoned' } });
    projection.targets = [historical];
    const row = rowForProjection(projection, 'all-history');
    expect(row.posture).toBe('unknown');
    expect(row.runtimeStatus).toBe('not_applicable');
    expect(row.healthStatus).toBe('not_applicable');
    expect(row.evidence).toEqual({ partial: true, unreachableNodes: [], unknown: true });
  });

  it('keeps qualified settled evidence complete in the row', () => {
    const projection = remoteProjection('app-qualified-row', 'qualified-row');
    projection.targetMode = 'blueprint';
    projection.rolloutGenerationId = 'rg-1';
    bindBlueprintAuthority(projection);
    projection.facets.artifact = artifactFacet('qualified');
    projection.facets.rollout = { status: 'configuration_converged_artifact_qualified', rolloutGenerationId: 'rg-1' };
    projection.targets = [targetProjection('reachable', 'rg-1', 1, 'p-web', 'qualified')];
    const row = rowForProjection(projection, 'qualified-row');
    expect(row.posture).toBe('converged_qualified');
    expect(row.evidence).toEqual({ partial: false, unreachableNodes: [], unknown: false });
  });

  it('deduplicates partial and unreachable node evidence', () => {
    const projection = remoteProjection('app-partial-nodes', 'partial-nodes');
    projection.targets = [targetProjection('unreachable', null, 2, 'unreachable-web')];
    const row = rowForProjection(projection, 'partial-nodes', [2, 3, 2]);
    expect(row.posture).toBe('failed');
    expect(row.evidence).toEqual({ partial: true, unreachableNodes: [2, 3], unknown: false });
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
    const remoteId = addRemoteNode('port-remote-unauthz', 29994);
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
  function baseFixture(overrides?: {
    source?: LiveFacets['source'];
    rollout?: LiveFacets['rollout'];
    artifact?: ArtifactFacet;
  }): LiveProjection {
    const rolloutArtifact = overrides?.rollout?.status === 'exactly_converged_healthy'
      ? artifactFacet()
      : overrides?.rollout?.status === 'configuration_converged_artifact_qualified'
        ? artifactFacet('qualified')
        : { status: 'not_applicable' as const };
    const projection = liveProjectionFixture({
      applicationId: 'app-p',
      targetMode: overrides?.rollout ? 'blueprint' : 'direct',
      stackName: 'p-web',
      rolloutGenerationId: overrides?.rollout && 'rolloutGenerationId' in overrides.rollout
        ? overrides.rollout.rolloutGenerationId
        : null,
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
        artifact: overrides?.artifact ?? rolloutArtifact,
        placement: overrides?.rollout
          ? { status: 'blueprint_bound', completion: 'unknown' }
          : { status: 'unbound_direct' },
        rollout: overrides?.rollout ?? { status: 'not_applicable' },
      },
    });
    if (overrides?.rollout) {
      projection.stackName = null;
      projection.blueprintId = 1;
      projection.approvals.rolloutAuthorizationRef = 'auth-1';
    }
    return projection;
  }

  it.each(['source', 'artifact', 'placement', 'rollout'] as const)(
    'does not accept a prototype key as a known %s status',
    facet => {
      const projection = facet === 'rollout'
        ? baseFixture({ rollout: { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' } })
        : baseFixture({ artifact: artifactFacet() });
      projection.targets = [targetProjection('reachable', facet === 'rollout' ? 'rg-1' : null)];
      Object.assign(projection.facets[facet], { status: 'toString' });
      const row = rowForProjection(projection, 'prototype-status');
      expect(row.posture).toBe('unknown');
      expect(row.evidence.unknown).toBe(true);
    },
  );

  const unknownStatusCases = (['source', 'artifact', 'placement', 'rollout', 'runtime', 'health', 'connectivity'] as const)
    .flatMap(facet => [
      { mode: 'direct_exact' as const, facet },
      { mode: 'direct_qualified' as const, facet },
      { mode: 'rollout_exact' as const, facet },
      { mode: 'rollout_qualified' as const, facet },
    ]);
  const settledRollouts = [
    { label: 'exact', status: 'exactly_converged_healthy', posture: 'converged' },
    { label: 'qualified', status: 'configuration_converged_artifact_qualified', posture: 'converged_qualified' },
  ] as const;

  it.each(settledRollouts)('claims $label convergence only from reachable current targets', ({ status, posture }) => {
    const projection = baseFixture({ rollout: { status, rolloutGenerationId: 'rg-1' } });
    const qualification = status === 'exactly_converged_healthy' ? 'exact' : 'qualified';
    projection.targets = [targetProjection('reachable', 'rg-1', 1, 'p-web', qualification)];
    expect(postureOf(projection)).toBe(posture);
  });

  it.each([
    { label: 'top-level rollout generation', mutate: (projection: LiveProjection) => { projection.rolloutGenerationId = 'rg-1'; } },
    { label: 'top-level rollout authority', mutate: (projection: LiveProjection) => { projection.approvals.rolloutAuthorizationRef = 'auth-1'; } },
    { label: 'target intent', mutate: (_projection: LiveProjection, target: GitOpsTargetProjection) => { target.intentRevisionId = 'intent-1'; } },
    { label: 'target rollout candidate', mutate: (_projection: LiveProjection, target: GitOpsTargetProjection) => { target.rolloutCandidateId = 'candidate-1'; } },
    { label: 'target rollout generation', mutate: (_projection: LiveProjection, target: GitOpsTargetProjection) => { target.rolloutGenerationId = 'rg-1'; } },
    { label: 'target rollout authority', mutate: (_projection: LiveProjection, target: GitOpsTargetProjection) => { target.approvals.rolloutAuthorizationRef = 'auth-1'; } },
  ])('does not claim Direct convergence with $label', ({ mutate }) => {
    const projection = baseFixture({ artifact: artifactFacet() });
    const target = remoteTarget(projection, 'reachable');
    mutate(projection, target);
    projection.targets = [target];
    expect(postureOf(projection)).toBe('unknown');
  });

  it.each(['creating', 'detached', 'deleted', 'future_lifecycle'] as const)(
    'does not claim convergence while lifecycle is $lifecycle',
    lifecycle => {
      const projection = baseFixture({ artifact: artifactFacet() });
      Object.assign(projection, { lifecycleStatus: lifecycle });
      projection.targets = [targetProjection('reachable')];
      expect(postureOf(projection)).toBe('unknown');
    },
  );

  it.each([
    { label: 'Direct', create: () => baseFixture({ artifact: artifactFacet() }) },
    { label: 'Blueprint', create: () => baseFixture({ rollout: { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' } }) },
  ])('does not claim $label convergence with a staged source candidate', ({ create }) => {
    const projection = create();
    if (projection.facets.source.status !== 'not_applicable') {
      projection.facets.source.candidateGenerationId = 'candidate-1';
    }
    projection.targets = [targetProjection('reachable', projection.rolloutGenerationId)];
    expect(postureOf(projection)).toBe('unknown');
  });

  it('does not claim Direct convergence with a staged target generation candidate', () => {
    const projection = baseFixture({ artifact: artifactFacet() });
    const target = targetProjection('reachable');
    target.candidateGenerationId = 'candidate-1';
    projection.targets = [target];
    expect(postureOf(projection)).toBe('unknown');
  });

  it('allows a staged target generation candidate left by mode conversion', () => {
    const projection = baseFixture({ rollout: { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' } });
    const target = targetProjection('reachable', 'rg-1');
    target.candidateGenerationId = 'candidate-1';
    projection.targets = [target];
    expect(postureOf(projection)).toBe('converged');
  });

  it('does not claim Direct convergence with the wrong placement status', () => {
    const projection = baseFixture({ artifact: artifactFacet() });
    projection.facets.placement = { status: 'not_applicable' };
    projection.targets = [targetProjection('reachable')];
    const row = rowForProjection(projection, 'direct-wrong-placement');
    expect(row.posture).toBe('unknown');
    expect(row.evidence.unknown).toBe(true);
  });

  it.each(settledRollouts)('does not claim $label convergence without settled Blueprint placement', ({ status }) => {
    const projection = baseFixture({ rollout: { status, rolloutGenerationId: 'rg-1' } });
    const qualification = status === 'exactly_converged_healthy' ? 'exact' : 'qualified';
    projection.facets.placement = { status: 'not_applicable' };
    projection.targets = [targetProjection('reachable', 'rg-1', 1, 'p-web', qualification)];
    expect(postureOf(projection)).toBe('unknown');
  });

  it.each(settledRollouts)('does not claim $label convergence without a rollout authority reference', ({ status }) => {
    const projection = baseFixture({ rollout: { status, rolloutGenerationId: 'rg-1' } });
    const qualification = status === 'exactly_converged_healthy' ? 'exact' : 'qualified';
    projection.approvals.rolloutAuthorizationRef = null;
    projection.targets = [targetProjection('reachable', 'rg-1', 1, 'p-web', qualification)];
    expect(postureOf(projection)).toBe('unknown');
  });

  it.each(settledRollouts)('does not claim $label convergence without a target intent binding', ({ status }) => {
    const projection = baseFixture({ rollout: { status, rolloutGenerationId: 'rg-1' } });
    const qualification = status === 'exactly_converged_healthy' ? 'exact' : 'qualified';
    const target = targetProjection('reachable', 'rg-1', 1, 'p-web', qualification);
    target.intentRevisionId = null;
    projection.targets = [target];
    expect(postureOf(projection)).toBe('unknown');
  });

  it.each(settledRollouts)('does not claim $label convergence when a target authority differs', ({ status }) => {
    const projection = baseFixture({ rollout: { status, rolloutGenerationId: 'rg-1' } });
    const qualification = status === 'exactly_converged_healthy' ? 'exact' : 'qualified';
    const target = targetProjection('reachable', 'rg-1', 1, 'p-web', qualification);
    target.approvals.rolloutAuthorizationRef = 'auth-other';
    projection.targets = [target];
    expect(postureOf(projection)).toBe('unknown');
  });

  it.each([
    {
      label: 'empty artifact generation',
      mutate: (projection: LiveProjection) => { projection.facets.artifact = Object.assign(artifactFacet(), { generationId: '' }); },
    },
    {
      label: 'empty artifact set',
      mutate: (projection: LiveProjection) => { projection.facets.artifact = Object.assign(artifactFacet(), { artifactSetId: '' }); },
    },
    {
      label: 'empty rollout generation',
      mutate: (projection: LiveProjection) => {
        projection.rolloutGenerationId = '';
        projection.facets.rollout = { status: 'exactly_converged_healthy', rolloutGenerationId: '' };
      },
    },
  ])('does not claim convergence from $label', ({ mutate }) => {
    const projection = baseFixture({ rollout: { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' } });
    projection.targets = [targetProjection('reachable', 'rg-1')];
    mutate(projection);
    expect(postureOf(projection)).toBe('unknown');
  });

  it('accepts an acknowledged Blueprint candidate on a settled target', () => {
    const projection = baseFixture({ rollout: { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' } });
    const target = targetProjection('reachable', 'rg-1');
    target.candidateGenerationId = 'staged-candidate';
    target.rolloutCandidateId = 'candidate-1';
    projection.targets = [target];
    expect(postureOf(projection)).toBe('converged');
  });

  it.each(settledRollouts)('does not claim $label convergence from an unsettled target runtime', ({ status }) => {
    const projection = baseFixture({ rollout: { status, rolloutGenerationId: 'rg-1' } });
    const qualification = status === 'exactly_converged_healthy' ? 'exact' : 'qualified';
    projection.targets = [{
      ...targetProjection('reachable', 'rg-1', 1, 'p-web', qualification),
      runtime: { status: 'applied_not_deployed' },
    }];
    expect(postureOf(projection)).toBe('unknown');
  });

  it.each(settledRollouts)('does not claim $label convergence from duplicate target identities', ({ status }) => {
    const projection = baseFixture({ rollout: { status, rolloutGenerationId: 'rg-1' } });
    const qualification = status === 'exactly_converged_healthy' ? 'exact' : 'qualified';
    projection.targets = [
      targetProjection('reachable', 'rg-1', 1, 'p-web', qualification),
      targetProjection('reachable', 'rg-1', 1, 'p-web', qualification),
    ];
    expect(postureOf(projection)).toBe('unknown');
  });

  it('does not report a queued Blueprint with duplicate targets as clean progress', () => {
    const projection = baseFixture({ rollout: { status: 'rollout_queued', rolloutGenerationId: 'rg-1' } });
    projection.targets = [targetProjection('reachable', 'rg-1'), targetProjection('reachable', 'rg-1')];
    expect(postureOf(projection)).toBe('unknown');
  });

  it.each([
    { label: 'direct exact', direct: true, qualification: 'exact' as const },
    { label: 'direct qualified', direct: true, qualification: 'qualified' as const },
    { label: 'Blueprint exact', direct: false, qualification: 'exact' as const },
    { label: 'Blueprint qualified', direct: false, qualification: 'qualified' as const },
  ])('does not claim $label convergence from a mismatched service digest', ({ direct, qualification }) => {
    const expectedArtifact = artifactFacet(qualification);
    if (!expectedArtifact.expected) throw new Error('expected artifact identity fixture');
    expectedArtifact.expected = {
      ...expectedArtifact.expected,
      services: [serviceEvidence(`sha256:${'a'.repeat(64)}`)],
    };
    const projection = direct
      ? baseFixture({ artifact: expectedArtifact })
      : baseFixture({
        rollout: {
          status: qualification === 'exact' ? 'exactly_converged_healthy' : 'configuration_converged_artifact_qualified',
          rolloutGenerationId: 'rg-1',
        },
      });
    if (!direct) projection.facets.artifact = expectedArtifact;
    const target = targetProjection('reachable', direct ? null : 'rg-1', 1, 'p-web', qualification);
    target.artifact = expectedArtifact;
    target.observedArtifactIdentity = {
      kind: qualification,
      identity: 'sha256:abc',
      observedAt: 1,
      services: [serviceEvidence(`sha256:${'b'.repeat(64)}`)],
    };
    projection.targets = [target];
    expect(postureOf(projection)).toBe('unknown');
  });

  it.each([
    { label: 'exact', qualification: 'exact' as const },
    { label: 'qualified', qualification: 'qualified' as const },
  ])('does not claim $label convergence when target service evidence differs from the application', ({ qualification }) => {
    const topArtifact = artifactFacet(qualification);
    const targetArtifact = artifactFacet(qualification);
    if (!topArtifact.expected || !targetArtifact.expected) throw new Error('expected artifact identity fixture');
    topArtifact.expected.services = [serviceEvidence(`sha256:${'a'.repeat(64)}`)];
    targetArtifact.expected.services = [serviceEvidence(`sha256:${'b'.repeat(64)}`)];
    const projection = baseFixture(
      qualification === 'exact'
        ? { artifact: topArtifact }
        : { rollout: { status: 'configuration_converged_artifact_qualified', rolloutGenerationId: 'rg-1' } },
    );
    if (qualification === 'qualified') projection.facets.artifact = topArtifact;
    const target = targetProjection('reachable', qualification === 'exact' ? null : 'rg-1', 1, 'p-web', qualification);
    target.artifact = targetArtifact;
    target.observedArtifactIdentity = {
      kind: qualification,
      identity: 'sha256:abc',
      observedAt: 1,
      services: [serviceEvidence(`sha256:${'a'.repeat(64)}`)],
    };
    projection.targets = [target];
    expect(postureOf(projection)).toBe('unknown');
  });

  it('does not claim exact convergence from a conflicting target artifact evidence version', () => {
    const projection = baseFixture({ rollout: { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' } });
    const target = targetProjection('reachable', 'rg-1');
    Object.assign(target.artifact, { evidenceVersion: 2 });
    projection.targets = [target];
    expect(postureOf(projection)).toBe('unknown');
  });

  it.each([
    {
      label: 'artifact status',
      mutate: (target: GitOpsTargetProjection) => { target.artifact = artifactFacet('qualified'); },
    },
    {
      label: 'artifact set',
      mutate: (target: GitOpsTargetProjection) => { target.artifact = { ...artifactFacet(), artifactSetId: 'artifact-other' }; },
    },
    {
      label: 'latest artifact set pointer',
      mutate: (target: GitOpsTargetProjection) => { target.latestArtifactSetId = 'artifact-other'; },
    },
    {
      label: 'expected artifact set pointer',
      mutate: (target: GitOpsTargetProjection) => { target.expectedArtifactSetId = 'artifact-other'; },
    },
  ])('does not claim exact convergence from a conflicting $label', ({ mutate }) => {
    const projection = baseFixture({ rollout: { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' } });
    const target = targetProjection('reachable', 'rg-1');
    mutate(target);
    projection.targets = [target];
    expect(postureOf(projection)).toBe('unknown');
  });

  it.each([
    { label: 'exact', status: 'exactly_converged_healthy' as const, qualification: 'exact' as const },
    { label: 'qualified', status: 'configuration_converged_artifact_qualified' as const, qualification: 'qualified' as const },
  ])('does not claim $label convergence from health for an older generation', ({ status, qualification }) => {
    const projection = baseFixture({ rollout: { status, rolloutGenerationId: 'rg-1' } });
    const target = targetProjection('reachable', 'rg-1', 1, 'p-web', qualification);
    Object.assign(target.health, { deployedGenerationId: 'gen-old' });
    projection.targets = [target];
    expect(postureOf(projection)).toBe('unknown');
  });

  it.each([
    { label: 'exact', status: 'exactly_converged_healthy' as const, qualification: 'exact' as const },
    { label: 'qualified', status: 'configuration_converged_artifact_qualified' as const, qualification: 'qualified' as const },
  ])('does not claim $label convergence from a conflicting latest evidence version', ({ status, qualification }) => {
    const projection = baseFixture({ rollout: { status, rolloutGenerationId: 'rg-1' } });
    const target = targetProjection('reachable', 'rg-1', 1, 'p-web', qualification);
    const latestEvidence = target.artifact.status === 'not_applicable' ? null : target.artifact.latestEvidence;
    if (!latestEvidence) throw new Error('expected latest target evidence');
    Object.assign(target.artifact, { latestEvidence: { ...latestEvidence, evidenceVersion: 2 } });
    projection.targets = [target];
    expect(postureOf(projection)).toBe('unknown');
  });

  it('does not claim exact convergence from a conflicting target artifact generation', () => {
    const projection = baseFixture({ rollout: { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' } });
    const target = targetProjection('reachable', 'rg-1');
    target.artifact = { ...artifactFacet(), generationId: 'gen-other' };
    projection.targets = [target];
    expect(postureOf(projection)).toBe('unknown');
  });

  it('does not claim exact convergence from a conflicting observed identity', () => {
    const projection = baseFixture({ rollout: { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' } });
    projection.targets = [{
      ...targetProjection('reachable', 'rg-1'),
      observedArtifactIdentity: { kind: 'exact', identity: 'sha256:other', observedAt: 1 },
    }];
    expect(postureOf(projection)).toBe('unknown');
  });

  it.each(settledRollouts)('does not claim $label convergence from a conflicting target expected identity', ({ status }) => {
    const projection = baseFixture({ rollout: { status, rolloutGenerationId: 'rg-1' } });
    const qualification = status === 'exactly_converged_healthy' ? 'exact' : 'qualified';
    const target = targetProjection('reachable', 'rg-1', 1, 'p-web', qualification);
    if (!('expected' in target.artifact) || !target.artifact.expected) throw new Error('expected target artifact');
    Object.assign(target.artifact.expected, { identity: 'sha256:other' });
    projection.targets = [target];
    expect(postureOf(projection)).toBe('unknown');
  });

  it.each([
    { label: 'direct', create: () => baseFixture({ artifact: artifactFacet() }) },
    ...settledRollouts.map(rollout => ({
      label: rollout.label,
      create: () => baseFixture({ rollout: { status: rollout.status, rolloutGenerationId: 'rg-1' } }),
    })),
  ])('does not claim $label convergence without target evidence', ({ create }) => {
    expect(postureOf(create())).toBe('unknown');
  });

  it('does not treat tombstoned target history as required convergence evidence', () => {
    const projection = baseFixture({
      rollout: { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' },
    });
    projection.targets = [{ ...targetProjection('reachable', 'rg-1'), tombstoned: true }];
    expect(postureOf(projection)).toBe('unknown');
  });

  it.each(settledRollouts)('does not treat an active out-of-set target as $label rollout evidence', ({ status }) => {
    const projection = baseFixture({ rollout: { status, rolloutGenerationId: 'rg-1' } });
    projection.targets = [targetProjection('reachable', 'rg-old')];
    expect(postureOf(projection)).toBe('unknown');
  });

  it('does not accept a rollout facet from a different top-level generation', () => {
    const projection = baseFixture({
      rollout: { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' },
    });
    projection.rolloutGenerationId = 'rg-other';
    projection.targets = [targetProjection('reachable', 'rg-1')];
    expect(postureOf(projection)).toBe('unknown');
  });

  it('requires every active rollout target to belong to the current generation', () => {
    const projection = baseFixture({
      rollout: { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' },
    });
    projection.targets = [
      targetProjection('reachable', 'rg-1', 1, 'current-web'),
      targetProjection('reachable', 'rg-old', 2, 'old-web'),
    ];
    expect(postureOf(projection)).toBe('unknown');
  });

  it.each(settledRollouts)('does not claim $label convergence when target evidence is unknown', ({ status }) => {
    const projection = baseFixture({ rollout: { status, rolloutGenerationId: 'rg-1' } });
    const qualification = status === 'exactly_converged_healthy' ? 'exact' : 'qualified';
    projection.targets = [targetProjection('unknown', 'rg-1', 1, 'p-web', qualification)];
    expect(postureOf(projection)).toBe('unknown');
  });

  it('does not claim convergence when only one of several targets is reachable', () => {
    const projection = baseFixture({
      rollout: { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' },
    });
    projection.targets = [targetProjection('reachable', 'rg-1'), targetProjection('stale', 'rg-1')];
    expect(postureOf(projection)).toBe('attention');
  });

  it.each(settledRollouts)('reports settled $label postures for non-fresh target evidence', ({ status }) => {
    const qualification = status === 'exactly_converged_healthy' ? 'exact' : 'qualified';
    const stale = baseFixture({ rollout: { status, rolloutGenerationId: 'rg-1' } });
    stale.targets = [targetProjection('stale', 'rg-1', 1, 'p-web', qualification)];
    expect(postureOf(stale)).toBe('attention');
    const unreachable = baseFixture({ rollout: { status, rolloutGenerationId: 'rg-1' } });
    unreachable.targets = [targetProjection('unreachable', 'rg-1', 1, 'p-web', qualification)];
    expect(postureOf(unreachable)).toBe('failed');
  });

  it.each([
    { qualification: 'exact', posture: 'converged' },
    { qualification: 'qualified', posture: 'converged_qualified' },
  ] as const)('claims direct $posture with one reachable target', ({ qualification, posture }) => {
    const projection = baseFixture({ artifact: artifactFacet(qualification) });
    projection.targets = [targetProjection('reachable', null, 1, 'p-web', qualification)];
    expect(postureOf(projection)).toBe(posture);
  });

  it('ignores tombstoned target history when direct evidence is complete', () => {
    const projection = baseFixture({ artifact: artifactFacet() });
    projection.targets = [
      targetProjection('reachable'),
      { ...targetProjection('reachable'), tombstoned: true, runtime: { status: 'tombstoned' } },
    ];
    expect(postureOf(projection)).toBe('converged');
  });

  it('ignores tombstoned runtime, health, in-flight, and activity evidence in current posture consumers', () => {
    const projection = baseFixture({ artifact: artifactFacet() });
    const failed = targetProjection('reachable', null, 2, 'failed-web');
    Object.assign(failed, {
      tombstoned: true,
      runtime: { status: 'failed_after_mutation' },
      health: { status: 'failed' },
      lkgUnavailableAt: 9000,
    });
    const deploying = targetProjection('reachable', null, 3, 'deploying-web');
    Object.assign(deploying, {
      tombstoned: true,
      runtime: { status: 'deploying' },
      health: { status: 'checking' },
      lkgUnavailableAt: 8000,
    });
    const current = targetProjection('reachable');
    Object.assign(current, { lkgUnavailableAt: 4000 });
    projection.targets = [current, failed, deploying];
    const row = rowForProjection(projection, 'tombstoned-consumers');
    expect(row.posture).toBe('converged');
    expect(row.runtimeStatus).toBe('synced_and_healthy');
    expect(row.healthStatus).toBe('passed');
    expect(row.attention).toEqual([]);
    expect(freshestFacetTimestamp(projection)).toBe(4000);
  });

  it('keeps tombstoned-only drift out of current row evidence', () => {
    const projection = baseFixture({ artifact: artifactFacet() });
    projection.targets = [
      targetProjection('reachable'),
      { ...targetProjection('reachable', null, 2), tombstoned: true },
    ];
    projection.drift = [{
      class: 'runtime',
      expected: { kind: 'generation', id: 'gen-1' },
      observed: { kind: 'generation', id: 'gen-old' },
      freshnessAt: null,
      owner: 'test',
      reason: 'test',
      configuredPolicy: null,
      affectedTargets: [{ nodeId: 2, stackName: 'historical' }],
      action: 'none',
    }];

    const row = rowForProjection(projection, 'tombstoned-drift');
    expect(row.posture).toBe('converged');
    expect(row.attention).toEqual([]);
    expect(row.drift).toEqual({ count: 0, classes: [] });
  });

  it('does not claim direct convergence with extra active target history', () => {
    const projection = baseFixture({ artifact: artifactFacet() });
    projection.targets = [targetProjection('reachable', null, 1, 'primary-web'), targetProjection('reachable', null, 2, 'secondary-web')];
    const row = rowForProjection(projection, 'direct-extra-target');
    expect(row.posture).toBe('unknown');
    expect(row.evidence).toEqual({ partial: true, unreachableNodes: [], unknown: true });
  });

  it('does not claim direct convergence when target evidence is unknown', () => {
    const projection = baseFixture({ artifact: artifactFacet() });
    projection.targets = [targetProjection('unknown')];
    expect(postureOf(projection)).toBe('unknown');
  });

  it.each([
    { connectivity: 'stale', posture: 'attention' },
    { connectivity: 'unreachable', posture: 'failed' },
  ] as const)(
    'reports $posture when direct target evidence is $connectivity',
    ({ connectivity, posture }) => {
      const projection = baseFixture({ artifact: artifactFacet() });
      projection.targets = [targetProjection(connectivity)];
      expect(postureOf(projection)).toBe(posture);
    },
  );

  it.each(unknownStatusCases)(
    'does not claim $mode convergence from an unknown $facet status',
    ({ mode, facet }) => {
      const direct = mode.startsWith('direct');
      const qualified = mode.endsWith('qualified');
      const projection = direct
        ? baseFixture({ artifact: qualified ? artifactFacet('qualified') : artifactFacet() })
        : baseFixture({
          rollout: qualified
            ? { status: 'configuration_converged_artifact_qualified', rolloutGenerationId: 'rg-1' }
            : { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' },
        });
      const target = targetProjection(
        'reachable',
        direct ? null : 'rg-1',
        1,
        'p-web',
        qualified ? 'qualified' : 'exact',
      );
      projection.targets = [target];
      if (facet === 'runtime') {
        Object.assign(target.runtime, { status: 'runtime_future_status' });
      } else if (facet === 'health') {
        Object.assign(target.health, { status: 'health_future_status' });
      } else if (facet === 'connectivity') {
        Object.assign(target, { connectivity: 'connectivity_future_status' });
      } else {
        Object.assign(projection.facets[facet], { status: `${facet}_future_status` });
      }
      const row = rowForProjection(projection, 'unknown-status');
      expect(row.posture).toBe('unknown');
      expect(row.evidence.unknown).toBe(true);
    },
  );

  it('does not claim Blueprint convergence from an unsettled source', () => {
    const projection = baseFixture({ rollout: { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' } });
    Object.assign(projection.facets.source, { status: 'never_reconciled' });
    projection.targets = [targetProjection('reachable', 'rg-1')];
    expect(postureOf(projection)).toBe('unknown');
  });

  it('does not claim Git-managed Blueprint convergence without a source facet', () => {
    const projection = baseFixture({ rollout: { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' } });
    projection.facets.source = { status: 'not_applicable' };
    projection.targets = [targetProjection('reachable', 'rg-1')];
    expect(postureOf(projection)).toBe('unknown');
  });

  it('marks a Direct row with an incompatible source mode as unknown evidence', () => {
    const projection = baseFixture({ artifact: artifactFacet() });
    projection.facets.source = { status: 'not_applicable' };
    projection.targets = [targetProjection('reachable')];
    const row = rowForProjection(projection, 'direct-source-mode');
    expect(row.posture).toBe('unknown');
    expect(row.evidence.unknown).toBe(true);
  });

  it('marks queued Git Blueprint rows with a missing source as unknown evidence', () => {
    const projection = baseFixture({ rollout: { status: 'rollout_queued', rolloutGenerationId: 'rg-1' } });
    projection.facets.source = { status: 'not_applicable' };
    projection.targets = [targetProjection('reachable', 'rg-1')];
    const row = rowForProjection(projection, 'queued-source-mode');
    expect(row.posture).toBe('unknown');
    expect(row.evidence.unknown).toBe(true);
  });

  it('marks queued Inline Blueprint rows with a source facet as unknown evidence', () => {
    const projection = baseFixture({ rollout: { status: 'rollout_queued', rolloutGenerationId: 'rg-1' } });
    projection.targetMode = 'inline_blueprint';
    projection.stackName = null;
    projection.blueprintId = 1;
    projection.targets = [targetProjection('reachable', 'rg-1')];
    const row = rowForProjection(projection, 'queued-inline-source-mode');
    expect(row.posture).toBe('unknown');
    expect(row.evidence.unknown).toBe(true);
  });

  it('allows Inline Blueprint convergence without a source facet', () => {
    const projection = baseFixture({ rollout: { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' } });
    projection.targetMode = 'inline_blueprint';
    projection.stackName = null;
    projection.blueprintId = 1;
    projection.facets.source = { status: 'not_applicable' };
    projection.targets = [targetProjection('reachable', 'rg-1')];
    expect(postureOf(projection)).toBe('converged');
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

  it('lets failure outrank everything else', () => {
    const projection = baseFixture({ rollout: { status: 'rollback_partial_failed', recoveryRef: 'r', recoveryGenerationId: null, failureClass: 'x', failureAt: 1 } as never });
    expect(postureOf(projection)).toBe('failed');
  });
});
