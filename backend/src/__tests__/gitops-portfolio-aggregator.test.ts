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
import { aggregateGitOpsPortfolio, freshestFacetTimestamp, PORTFOLIO_MERGE_CAP, postureOf, rowFromProjection } from '../services/gitops/portfolioAggregator';
import { directApplicationFixture } from './helpers/gitopsFixtures';
import type { GitOpsRevisionProjection, GitOpsTargetProjection } from '../services/gitops/types';
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
      artifact: { status: 'not_applicable' },
      placement: { status: 'unbound_direct' },
      rollout: { status: 'not_applicable' },
    },
  });
}

function targetProjection(
  connectivity: GitOpsTargetProjection['connectivity'],
  rolloutGenerationId: string | null = null,
  nodeId = 1,
  stackName = 'p-web',
): GitOpsTargetProjection {
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
    expectedArtifactSetId: null,
    latestArtifactSetId: null,
    artifact: { status: 'not_applicable' },
    observedArtifactIdentity: { kind: 'unknown' },
    intentRevisionId: null,
    rolloutCandidateId: null,
    rolloutGenerationId,
    approvals: {
      sourceAcceptanceRef: null,
      placementApprovalRef: null,
      rolloutAuthorizationRef: null,
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

function artifactFacet(qualification: 'exact' | 'qualified' = 'exact'): ArtifactFacet {
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
      let target = targetProjection('reachable');
      if (facet === 'rollout') {
        revision.facets.artifact = artifactFacet();
      } else {
        revision.targetMode = 'blueprint';
        revision.rolloutGenerationId = 'rg-1';
        revision.facets.rollout = { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' };
        target = targetProjection('reachable', 'rg-1');
      }
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
  const malformedRemoteCases: Array<{ kind: string; mutate: MalformedMutation }> = [
    { kind: 'null_target', mutate: projection => { projection.targets = [null]; } },
    { kind: 'missing_runtime', mutate: withTarget(target => { delete target.runtime; }) },
    { kind: 'missing_health', mutate: withTarget(target => { delete target.health; }) },
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
    { kind: 'missing_artifact_proof', mutate: withArtifact(() => ({ status: 'artifact_exact' } as ArtifactFacet)) },
    { kind: 'missing_qualified_artifact_proof', mutate: withArtifact(() => ({ status: 'artifact_qualified' } as ArtifactFacet)) },
    {
      kind: 'missing_latest_evidence',
      mutate: withArtifact(() => Object.assign(artifactFacet(), { latestEvidence: undefined })),
    },
    { kind: 'malformed_drift', mutate: projection => { projection.drift = [null]; } },
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
    revision.targets = [targetProjection('reachable')];
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
    revision.targets = [targetProjection('reachable')];

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
    outOfSet.rolloutGenerationId = 'rg-1';
    outOfSet.facets.rollout = { status: 'exactly_converged_healthy', rolloutGenerationId: 'rg-1' };
    outOfSet.targets = [targetProjection('reachable', 'rg-old')];
    const tombstonedOnly = remoteProjection('app-remote-tombstoned-only', 'remote-tombstoned-only');
    tombstonedOnly.targetMode = 'blueprint';
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
    const target = targetProjection('reachable');
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
        targetProjection('reachable', mode === 'blueprint' ? 'rg-1' : null),
        historicalTarget('unreachable', 2, 'unreachable-web'),
        historicalTarget('unknown', 3, 'unknown-web'),
        historicalTarget('stale', 5, 'stale-web'),
        malformed,
      ];
      const row = rowForProjection(projection, `tombstoned-${mode}-row`);
      expect(row.posture).toBe(expectedPosture);
      expect(row.evidence).toEqual({ partial: false, unreachableNodes: [], unknown: false });
      expect(row.targets.map(target => target.evidence)).toEqual(['fresh', 'unknown', 'unknown', 'stale', 'unknown']);
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
    projection.facets.rollout = { status: 'configuration_converged_artifact_qualified', rolloutGenerationId: 'rg-1' };
    projection.targets = [targetProjection('reachable', 'rg-1')];
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
    return liveProjectionFixture({
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
        artifact: overrides?.artifact ?? { status: 'not_applicable' },
        placement: { status: 'unbound_direct' },
        rollout: overrides?.rollout ?? { status: 'not_applicable' },
      },
    });
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
    projection.targets = [targetProjection('reachable', 'rg-1')];
    expect(postureOf(projection)).toBe(posture);
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
    projection.targets = [targetProjection('unknown', 'rg-1')];
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
    const stale = baseFixture({ rollout: { status, rolloutGenerationId: 'rg-1' } });
    stale.targets = [targetProjection('stale', 'rg-1')];
    expect(postureOf(stale)).toBe('attention');
    const unreachable = baseFixture({ rollout: { status, rolloutGenerationId: 'rg-1' } });
    unreachable.targets = [targetProjection('unreachable', 'rg-1')];
    expect(postureOf(unreachable)).toBe('failed');
  });

  it.each([
    { qualification: 'exact', posture: 'converged' },
    { qualification: 'qualified', posture: 'converged_qualified' },
  ] as const)('claims direct $posture with one reachable target', ({ qualification, posture }) => {
    const projection = baseFixture({ artifact: artifactFacet(qualification) });
    projection.targets = [targetProjection('reachable')];
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
      const target = targetProjection('reachable', direct ? null : 'rg-1');
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
