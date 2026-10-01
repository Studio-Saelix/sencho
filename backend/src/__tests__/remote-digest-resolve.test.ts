/**
 * Remote digest freeze/repair and remote deploy observation must read the leaf
 * over HTTP. Never interpret the remote node's compose_dir as a hub-local path,
 * and never read a remote node's workload from the hub's own Docker.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions, type EventEnvelope } from '../services/gitops/transitions';
import {
  decodeArtifactEvidenceJson,
  decodeObservedArtifactIdentity,
  encodeArtifactEvidenceJson,
} from '../services/gitops/json';
import type { EffectiveArtifactContext } from '../services/gitops/effectiveArtifactContext';
import type { GitOpsApplicationRow, GitOpsGenerationRow } from '../services/gitops/types';
import { DEFAULT_PLACEMENT_POLICY, DEFAULT_ROLLOUT_AUTHORIZATION_POLICY } from '../services/gitops/policyComposition';

const mockBuildEffectiveServiceModel = vi.fn();
const mockDockerInfo = vi.fn();
const mockResolveRegistry = vi.fn();
const mockListContainers = vi.fn();
const mockContainerInspect = vi.fn();
const mockImageInspect = vi.fn();

vi.mock('../services/effectiveServiceModel', () => ({
  buildEffectiveServiceModel: (...args: unknown[]) => mockBuildEffectiveServiceModel(...args),
}));

vi.mock('../services/registry-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/registry-api')>();
  return {
    ...actual,
    resolveRegistryImageDigestForPlatform: (...args: unknown[]) => mockResolveRegistry(...args),
  };
});

vi.mock('../services/RegistryService', () => ({
  RegistryService: {
    getInstance: () => ({
      getAuthForRegistry: vi.fn().mockResolvedValue(null),
    }),
  },
}));

vi.mock('../services/DockerController', () => ({
  default: {
    getInstance: () => ({
      getDocker: () => ({
        info: (...args: unknown[]) => mockDockerInfo(...args),
        listContainers: (...args: unknown[]) => mockListContainers(...args),
        getContainer: () => ({ inspect: (...args: unknown[]) => mockContainerInspect(...args) }),
        getImage: () => ({ inspect: (...args: unknown[]) => mockImageInspect(...args) }),
      }),
    }),
  },
}));

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let NodeRegistry: typeof import('../services/NodeRegistry').NodeRegistry;
let resolveAndRecordArtifactSet: typeof import('../services/gitops/artifactResolve').resolveAndRecordArtifactSet;
let resolvePlatformLabelForNode: typeof import('../services/gitops/artifactResolve').resolvePlatformLabelForNode;
let recordObservedRuntimeArtifactForDeploy: typeof import('../services/gitops/artifactResolve').recordObservedRuntimeArtifactForDeploy;
let remoteNodeId: number;
let counter = 0;

const LEAF_PLATFORM = { os: 'linux', architecture: 'arm64' } as const;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ NodeRegistry } = await import('../services/NodeRegistry'));
  ({ resolveAndRecordArtifactSet, resolvePlatformLabelForNode, recordObservedRuntimeArtifactForDeploy } = await import('../services/gitops/artifactResolve'));
  remoteNodeId = DatabaseService.getInstance().addNode({
    name: `remote-digest-${Date.now()}`,
    type: 'remote',
    api_url: 'http://192.168.1.50:1852',
    api_token: 't'.repeat(64),
    compose_dir: '/tmp/remote-digest-unused',
    is_default: false,
  });
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  GitOpsStore.resetForTests();
  GitOpsTransitions.resetForTests();
  mockBuildEffectiveServiceModel.mockReset();
  mockDockerInfo.mockReset();
  mockResolveRegistry.mockReset();
  mockListContainers.mockReset();
  mockContainerInspect.mockReset();
  mockImageInspect.mockReset();
  mockBuildEffectiveServiceModel.mockResolvedValue({
    renderable: true,
    services: [{
      name: 'hub-ghost',
      declaredImage: 'should-not-resolve:latest',
      hasBuild: false,
      expectedReplicas: 1,
      dependsOn: [],
      hasHealthcheck: false,
    }],
  });
  mockDockerInfo.mockResolvedValue({ OSType: 'linux', Architecture: 'amd64' });
  mockListContainers.mockResolvedValue([]);
  mockResolveRegistry.mockResolvedValue({
    ok: true,
    indexDigest: `sha256:${'1'.repeat(64)}`,
    platformDigest: `sha256:${'a'.repeat(64)}`,
    platformLabel: 'linux/arm64',
    qualification: 'exact',
  });
  counter += 1;
  vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue({
    apiUrl: 'http://192.168.1.50:1852',
    apiToken: 't'.repeat(64),
    trustedLoopback: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function envelope(operationId: string): EventEnvelope {
  return { operationId, actor: 'tester', trigger: 'manual', at: Date.now() };
}

function mockLeafContext(data: EffectiveArtifactContext) {
  return vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data });
}

/** The leaf's platform alone, which is all the approved-intent path needs from it. */
function mockLeafPlatform(platform: { os: string; architecture: string }) {
  return vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { platform } });
}

function expectHubLocalSkipped(): void {
  expect(mockBuildEffectiveServiceModel).not.toHaveBeenCalled();
  expect(mockDockerInfo).not.toHaveBeenCalled();
  expect(mockListContainers).not.toHaveBeenCalled();
  expect(mockContainerInspect).not.toHaveBeenCalled();
  expect(mockImageInspect).not.toHaveBeenCalled();
}

function seedDirectApp(ids: {
  applicationId: string;
  generationId: string;
  stackName: string;
  artifactSetId: string;
}): void {
  const store = GitOpsStore.getInstance();
  const tx = GitOpsTransitions.getInstance();
  tx.activateDirect({
    application: app(ids.applicationId, ids.stackName, ids.generationId, ids.artifactSetId),
    nodeId: remoteNodeId,
    envelope: { operationId: `op-act-${ids.applicationId}`, actor: 'tester', trigger: 'manual', at: 1 },
  });
  store.insertGeneration(gen(ids.generationId, ids.applicationId));
  store.insertArtifactSet({
    id: ids.artifactSetId,
    generation_id: ids.generationId,
    evidence_version: 1,
    authoritative: 0,
    qualification: 'unresolved',
    evidence_json: encodeArtifactEvidenceJson({ kind: 'unresolved' }),
    created_at: 1,
  });
}

describe('remote effective artifact context for digest freeze', () => {
  it('reads only the leaf platform when resolving approved intent, never its compose', async () => {
    // The approved-intent path exists so a later reconcile tick does not read
    // the node's compose directory. That has to hold for a remote node too, so
    // it asks the leaf for the platform alone, over the platform route, rather
    // than for a rendered context. If it asked for the context instead, a hand
    // edit on the leaf would become the approved identity on the hub.
    const stackName = 'remote-intent-stack';
    const applicationId = `app-remote-intent-${counter}`;
    const generationId = `gen-remote-intent-${counter}`;
    seedDirectApp({
      applicationId,
      generationId,
      stackName,
      artifactSetId: `art-remote-intent-${counter}`,
    });

    const axiosGetSpy = mockLeafPlatform({ ...LEAF_PLATFORM });
    mockResolveRegistry.mockResolvedValue({
      ok: true,
      indexDigest: `sha256:${'2'.repeat(64)}`,
      platformDigest: `sha256:${'b'.repeat(64)}`,
      platformLabel: 'linux/arm64',
      qualification: 'exact',
    });

    await resolveAndRecordArtifactSet({
      stackName,
      nodeId: remoteNodeId,
      applicationId,
      generationId,
      buildContexts: [],
      envelope: envelope(`op-remote-intent-${counter}`),
      approvedServices: [{
        name: 'web',
        declaredImage: 'nginx:1.27',
        hasBuild: false,
        expectedReplicas: 1,
        dependsOn: [],
        hasHealthcheck: false,
      }],
    });

    expect(axiosGetSpy).toHaveBeenCalledWith(
      'http://192.168.1.50:1852/api/stacks/platform/docker-context',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${'t'.repeat(64)}`,
        }),
      }),
    );
    expect(
      axiosGetSpy.mock.calls.map((c) => String(c[0])),
      'and never asks the leaf for a rendered compose model',
    ).not.toContain(`http://192.168.1.50:1852/api/stacks/${stackName}/effective-artifact-context`);
    expectHubLocalSkipped();

    const latestId = GitOpsStore.getInstance().getApplication(applicationId)?.latest_artifact_set_id;
    const latest = latestId ? GitOpsStore.getInstance().getArtifactSet(latestId) : undefined;
    expect(latest?.qualification, 'the arm64 child the leaf runs is what was pinned').toBe('exact');
    const decoded = latest ? decodeArtifactEvidenceJson(latest.evidence_json) : null;
    const recorded = decoded && 'services' in decoded ? decoded.services ?? [] : [];
    expect(recorded[0]?.platformDigest).toBe(`sha256:${'b'.repeat(64)}`);
  });

  it('freezes from the leaf HTTP context and never reads hub-local model or Docker', async () => {
    const stackName = 'remote-only-stack';
    const applicationId = `app-remote-${counter}`;
    const generationId = `gen-remote-${counter}`;
    seedDirectApp({
      applicationId,
      generationId,
      stackName,
      artifactSetId: `art-remote-${counter}`,
    });

    const axiosGetSpy = mockLeafContext({
      renderable: true,
      platform: { ...LEAF_PLATFORM },
      services: [{
        name: 'web',
        declaredImage: 'nginx:1.27',
        hasBuild: false,
        expectedReplicas: 1,
        dependsOn: [],
        hasHealthcheck: false,
      }],
    });

    await resolveAndRecordArtifactSet({
      stackName,
      nodeId: remoteNodeId,
      applicationId,
      generationId,
      buildContexts: [],
      envelope: envelope(`op-remote-${counter}`),
    });

    expect(axiosGetSpy).toHaveBeenCalledWith(
      `http://192.168.1.50:1852/api/stacks/${stackName}/effective-artifact-context`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${'t'.repeat(64)}`,
        }),
      }),
    );
    expectHubLocalSkipped();

    const latestId = GitOpsStore.getInstance().getApplication(applicationId)?.latest_artifact_set_id;
    const latest = latestId ? GitOpsStore.getInstance().getArtifactSet(latestId) : undefined;
    expect(latest).toBeDefined();
    expect(latest?.qualification).toBe('exact');
    const decoded = JSON.parse(latest!.evidence_json) as {
      services: Array<{ serviceName: string; platform: string | null }>;
    };
    expect(decoded.services.map((s) => s.serviceName)).toEqual(['web']);
    expect(decoded.services.every((s) => s.platform === 'linux/arm64')).toBe(true);
  });

  it('reads platform label for digest repair from the leaf, not hub Docker', async () => {
    const axiosGetSpy = mockLeafContext({
      renderable: true,
      platform: { ...LEAF_PLATFORM },
      services: [],
    });

    const label = await resolvePlatformLabelForNode(remoteNodeId, 'remote-only-stack');
    expect(label).toBe('linux/arm64');
    expect(axiosGetSpy).toHaveBeenCalled();
    expectHubLocalSkipped();
  });

  it('does not treat a same-named hub stack as the remote target identity', async () => {
    const axiosGetSpy = mockLeafContext({
      renderable: false,
      services: [],
      platform: null,
      error: 'missing on leaf',
    });

    const applicationId = `app-collision-${counter}`;
    const generationId = `gen-collision-${counter}`;
    seedDirectApp({
      applicationId,
      generationId,
      stackName: 'collision-stack',
      artifactSetId: `art-collision-${counter}`,
    });

    await resolveAndRecordArtifactSet({
      stackName: 'collision-stack',
      nodeId: remoteNodeId,
      applicationId,
      generationId,
      buildContexts: [],
      envelope: envelope(`op-collision-${counter}`),
    });

    expect(axiosGetSpy).toHaveBeenCalled();
    expectHubLocalSkipped();
  });
});

describe('remote runtime observation after a deploy', () => {
  const LEAF_IDENTITY = `sha256:${'b'.repeat(64)}`;

  it('records the identity the leaf reports and never reads hub Docker', async () => {
    const stackName = 'observed-remote-stack';
    const applicationId = `app-observed-${counter}`;
    const generationId = `gen-observed-${counter}`;
    seedDirectApp({
      applicationId,
      generationId,
      stackName,
      artifactSetId: `art-observed-${counter}`,
    });

    const axiosGetSpy = vi.spyOn(axios, 'get').mockResolvedValue({
      status: 200,
      data: {
        kind: 'exact',
        identity: LEAF_IDENTITY,
        observedAt: 1_700_000_000_000,
        services: [{
          serviceName: 'web',
          authoredRef: 'nginx:1.27',
          source: 'registry',
          platform: 'linux/arm64',
          indexDigest: null,
          platformDigest: `sha256:${'a'.repeat(64)}`,
          localDigests: [`sha256:${'a'.repeat(64)}`],
          buildContextFingerprint: null,
          producedImageId: 'imagedeadbeef',
          failureClass: null,
          resolvedAt: 1_700_000_000_000,
        }],
      },
    });

    await recordObservedRuntimeArtifactForDeploy({
      stackName,
      nodeId: remoteNodeId,
      applicationId,
      envelope: envelope(`op-observed-${counter}`),
    });

    expect(axiosGetSpy).toHaveBeenCalledWith(
      `http://192.168.1.50:1852/api/stacks/${stackName}/runtime-artifact-identity`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${'t'.repeat(64)}`,
        }),
      }),
    );
    expectHubLocalSkipped();

    const observed = decodeObservedArtifactIdentity(
      GitOpsStore.getInstance().getTarget(applicationId, remoteNodeId)?.observed_artifact_identity_json ?? null,
    );
    expect(observed).toMatchObject({
      kind: 'exact',
      identity: LEAF_IDENTITY,
      observedAt: 1_700_000_000_000,
    });
    expect(observed).toHaveProperty('services', [
      expect.objectContaining({ serviceName: 'web', platform: 'linux/arm64' }),
    ]);
  });

  it('records an explicit unavailable when the leaf cannot be asked', async () => {
    const stackName = 'unreachable-remote-stack';
    const applicationId = `app-unreachable-${counter}`;
    const generationId = `gen-unreachable-${counter}`;
    seedDirectApp({
      applicationId,
      generationId,
      stackName,
      artifactSetId: `art-unreachable-${counter}`,
    });

    vi.spyOn(axios, 'get').mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(recordObservedRuntimeArtifactForDeploy({
      stackName,
      nodeId: remoteNodeId,
      applicationId,
      envelope: envelope(`op-unreachable-${counter}`),
    })).resolves.toBeUndefined();

    expectHubLocalSkipped();
    expect(decodeObservedArtifactIdentity(
      GitOpsStore.getInstance().getTarget(applicationId, remoteNodeId)?.observed_artifact_identity_json ?? null,
    )).toEqual({ kind: 'unavailable' });
  });

  it('records an explicit unavailable when the leaf answers with an unreadable payload', async () => {
    const stackName = 'malformed-remote-stack';
    const applicationId = `app-malformed-${counter}`;
    const generationId = `gen-malformed-${counter}`;
    seedDirectApp({
      applicationId,
      generationId,
      stackName,
      artifactSetId: `art-malformed-${counter}`,
    });

    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { kind: 'exact' } });

    await expect(recordObservedRuntimeArtifactForDeploy({
      stackName,
      nodeId: remoteNodeId,
      applicationId,
      envelope: envelope(`op-malformed-${counter}`),
    })).resolves.toBeUndefined();

    expectHubLocalSkipped();
    expect(decodeObservedArtifactIdentity(
      GitOpsStore.getInstance().getTarget(applicationId, remoteNodeId)?.observed_artifact_identity_json ?? null,
    )).toEqual({ kind: 'unavailable' });
  });
});

function app(
  id: string,
  stackName: string,
  generationId: string,
  artifactSetId: string,
): GitOpsApplicationRow {
  return {
    id,
    lifecycle_key: `direct:${stackName}`,
    lifecycle_status: 'active',
    target_mode: 'direct',
    stack_name: stackName,
    configured_source_stack_name: null,
    blueprint_id: null,
    configured_repo_url: 'https://github.com/org/repo.git',
    repo_identity_json: '{"host":"github.com","pathname":"/org/repo.git"}',
    configured_ref: 'main',
    compose_paths_json: '["compose.yml"]',
    context_dir: null,
    sync_env: 0,
    env_path: null,
    source_policy: 'manual',
    placement_policy: DEFAULT_PLACEMENT_POLICY,
    rollout_authorization_policy: DEFAULT_ROLLOUT_AUTHORIZATION_POLICY,
        placement_policy_refusal_reason: null,
        placement_policy_refused_at: null,
    poll_interval_secs: null,
    materialization_fingerprint: 'a'.repeat(64),
    desired_commit_sha: 'abc123',
    fetched_commit_sha: 'abc123',
    fetched_resolved_ref_kind: 'branch',
    candidate_generation_id: null,
    accepted_generation_id: generationId,
    candidate_plan_blocked: 0,
    review_required: 0,
    review_block_reason: null,
    artifact_set_id: artifactSetId,
    latest_artifact_set_id: artifactSetId,
    intent_revision_id: null,
    rollout_candidate_id: null,
    rollout_generation_id: null,
    source_acceptance_ref: 'acc-seed',
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
    source_suspended_reason: null,
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

function gen(id: string, applicationId: string): GitOpsGenerationRow {
  return {
    id,
    application_id: applicationId,
    commit_sha: 'abc123',
    repo_url: 'https://github.com/org/repo.git',
    resolved_ref_kind: 'branch',
    configured_ref: 'main',
    repo_identity_json: '{"host":"github.com","pathname":"/org/repo.git"}',
    manifest_version: 0,
    candidate_dir: `generations/candidate-${id}`,
    applied_dir: `generations/applied-${id}-0`,
    expected_invocation_json: '{"composeFileOrder":[],"projectName":null,"projectDirectory":null,"envFileOrder":[]}',
    materialization_fingerprint: 'a'.repeat(64),
    validation_ok: 1,
    plan_blocked: 0,
    change_plan_fingerprint: null,
    operation_id: `op-${id}`,
    trigger: 'manual',
    actor: 'tester',
    previous_generation_id: null,
    redacted_limitations_json: '[]',
    portable_manifest_json: null,
    compose_inputs_json: null,
    source_policy_evidence_json: null,
    security_policy_evidence_json: null,
    support_requirements_json: null,
    compatibility_requirements_json: null,
    secret_capability_json: null,
    created_at: 1,
  };
}
