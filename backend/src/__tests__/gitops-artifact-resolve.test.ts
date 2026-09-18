import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions, type EventEnvelope } from '../services/gitops/transitions';
import {
  recordObservedRuntimeArtifactForDeploy,
  resolveAndRecordArtifactSet,
} from '../services/gitops/artifactResolve';
import { decodeObservedArtifactIdentity, encodeArtifactEvidenceJson } from '../services/gitops/json';
import type { GitOpsApplicationRow, GitOpsGenerationRow } from '../services/gitops/types';

const mockBuildEffectiveServiceModel = vi.fn();
const mockResolveRegistryImageDigestForPlatform = vi.fn();
const mockGetAuthForRegistry = vi.fn();
const mockDockerInfo = vi.fn();
const mockListContainers = vi.fn();

vi.mock('../services/effectiveServiceModel', () => ({
  buildEffectiveServiceModel: (...args: unknown[]) => mockBuildEffectiveServiceModel(...args),
}));

vi.mock('../services/registry-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/registry-api')>();
  return {
    ...actual,
    resolveRegistryImageDigestForPlatform: (...args: unknown[]) => mockResolveRegistryImageDigestForPlatform(...args),
    parseImageRef: actual.parseImageRef,
  };
});

vi.mock('../services/RegistryService', () => ({
  RegistryService: {
    getInstance: () => ({
      getAuthForRegistry: (...args: unknown[]) => mockGetAuthForRegistry(...args),
    }),
  },
}));

vi.mock('../services/DockerController', () => ({
  default: {
    getInstance: () => ({
      getDocker: () => ({
        info: (...args: unknown[]) => mockDockerInfo(...args),
        listContainers: (...args: unknown[]) => mockListContainers(...args),
      }),
    }),
  },
}));

const EXACT_DIGEST = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';

describe('gitops artifact resolve', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  beforeEach(() => {
    GitOpsStore.resetForTests();
    GitOpsTransitions.resetForTests();
    mockBuildEffectiveServiceModel.mockReset();
    mockResolveRegistryImageDigestForPlatform.mockReset();
    mockGetAuthForRegistry.mockReset();
    mockDockerInfo.mockReset();
    mockListContainers.mockReset();
    mockGetAuthForRegistry.mockResolvedValue(null);
    mockDockerInfo.mockResolvedValue({ OSType: 'linux', Architecture: 'amd64' });
    mockListContainers.mockResolvedValue([]);
  });

  it('reduces mixed apps with weakest-wins and distinct failure classes', async () => {
    seedDirectApp({ applicationId: 'app-mix', generationId: 'gen-mix', stackName: 'mix-web', artifactSetId: 'art-mix-v1' });

    mockBuildEffectiveServiceModel.mockResolvedValue({
      renderable: true,
      services: [
        { name: 'web', declaredImage: 'nginx:latest', hasBuild: false, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false },
        { name: 'worker', declaredImage: null, hasBuild: true, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false },
      ],
    });
    mockResolveRegistryImageDigestForPlatform.mockResolvedValue({
      ok: true,
      indexDigest: EXACT_DIGEST,
      platformDigest: EXACT_DIGEST,
      platformLabel: 'linux/amd64',
      qualification: 'exact',
    });

    await resolveAndRecordArtifactSet({
      stackName: 'mix-web',
      nodeId: 1,
      applicationId: 'app-mix',
      generationId: 'gen-mix',
      buildContexts: [],
      envelope: envelope('op-resolve-mix'),
    });

    const latestId = GitOpsStore.getInstance().getApplication('app-mix')?.latest_artifact_set_id;
    const latest = latestId ? GitOpsStore.getInstance().getArtifactSet(latestId) : undefined;
    expect(latest?.qualification).toBe('local_build_unverified');
    const decoded = JSON.parse(latest!.evidence_json);
    type ServiceRow = { serviceName: string; failureClass: string | null; source: string };
    const byName = new Map<string, ServiceRow>(
      (decoded.services as ServiceRow[]).map((service) => [service.serviceName, service]),
    );
    expect(byName.get('web')?.source).toBe('registry');
    expect(byName.get('worker')?.source).toBe('build');
  });

  it('records independently failing registry services in one pass', async () => {
    seedDirectApp({ applicationId: 'app-par', generationId: 'gen-par', stackName: 'par-web', artifactSetId: 'art-par-v1' });

    mockBuildEffectiveServiceModel.mockResolvedValue({
      renderable: true,
      services: [
        { name: 'web', declaredImage: 'nginx:latest', hasBuild: false, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false },
        { name: 'api', declaredImage: 'private.example/api:latest', hasBuild: false, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false },
      ],
    });
    mockResolveRegistryImageDigestForPlatform.mockImplementation(async (_registry: string, repo: string) => {
      if (repo.includes('api')) {
        return { ok: false, reason: 'unauthorized: credentials rejected' };
      }
      return {
        ok: true,
        indexDigest: EXACT_DIGEST,
        platformDigest: EXACT_DIGEST,
        platformLabel: 'linux/amd64',
        qualification: 'exact',
      };
    });

    await resolveAndRecordArtifactSet({
      stackName: 'par-web',
      nodeId: 1,
      applicationId: 'app-par',
      generationId: 'gen-par',
      buildContexts: [],
      envelope: envelope('op-resolve-par'),
    });

    const latestId = GitOpsStore.getInstance().getApplication('app-par')?.latest_artifact_set_id;
    const latest = latestId ? GitOpsStore.getInstance().getArtifactSet(latestId) : undefined;
    expect(latest?.qualification).toBe('unavailable');
    const decoded = JSON.parse(latest!.evidence_json);
    type ServiceRow = { serviceName: string; failureClass: string | null; source: string };
    const byName = new Map<string, ServiceRow>(
      (decoded.services as ServiceRow[]).map((service) => [service.serviceName, service]),
    );
    expect(byName.get('web')?.failureClass).toBeNull();
    expect(byName.get('web')?.source).toBe('registry');
    expect(byName.get('api')?.failureClass).toBe('credential_failure');
  });

  it('keeps a successful registry service when a sibling resolve throws', async () => {
    seedDirectApp({ applicationId: 'app-thr', generationId: 'gen-thr', stackName: 'thr-web', artifactSetId: 'art-thr-v1' });

    mockBuildEffectiveServiceModel.mockResolvedValue({
      renderable: true,
      services: [
        { name: 'web', declaredImage: 'nginx:latest', hasBuild: false, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false },
        { name: 'api', declaredImage: 'private.example/api:latest', hasBuild: false, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false },
      ],
    });
    mockResolveRegistryImageDigestForPlatform.mockImplementation(async (_registry: string, repo: string) => {
      if (repo.includes('api')) {
        throw new Error('socket hang up');
      }
      return {
        ok: true,
        indexDigest: EXACT_DIGEST,
        platformDigest: EXACT_DIGEST,
        platformLabel: 'linux/amd64',
        qualification: 'exact',
      };
    });

    await resolveAndRecordArtifactSet({
      stackName: 'thr-web',
      nodeId: 1,
      applicationId: 'app-thr',
      generationId: 'gen-thr',
      buildContexts: [],
      envelope: envelope('op-resolve-thr'),
    });

    const latestId = GitOpsStore.getInstance().getApplication('app-thr')?.latest_artifact_set_id;
    const latest = latestId ? GitOpsStore.getInstance().getArtifactSet(latestId) : undefined;
    expect(latest?.qualification).toBe('unavailable');
    const decoded = JSON.parse(latest!.evidence_json);
    type ServiceRow = { serviceName: string; failureClass: string | null; source: string };
    const byName = new Map<string, ServiceRow>(
      (decoded.services as ServiceRow[]).map((service) => [service.serviceName, service]),
    );
    expect(byName.get('web')?.failureClass).toBeNull();
    expect(byName.get('api')?.failureClass).toBe('registry_unavailable');
  });

  it('records unavailable observation when the model read throws and does not rethrow', async () => {
    seedDirectApp({ applicationId: 'app-obs', generationId: 'gen-obs', stackName: 'obs-web', artifactSetId: 'art-obs-v1' });
    mockBuildEffectiveServiceModel.mockRejectedValue(new Error('docker info failed'));

    await expect(recordObservedRuntimeArtifactForDeploy({
      stackName: 'obs-web',
      nodeId: 1,
      applicationId: 'app-obs',
      envelope: envelope('op-observe-fail'),
    })).resolves.toBeUndefined();

    expect(decodeObservedArtifactIdentity(
      GitOpsStore.getInstance().getTarget('app-obs', 1)?.observed_artifact_identity_json ?? null,
    )).toEqual({ kind: 'unavailable' });
  });

  it('records unavailable observation when listing containers throws', async () => {
    seedDirectApp({ applicationId: 'app-list', generationId: 'gen-list', stackName: 'list-web', artifactSetId: 'art-list-v1' });
    mockBuildEffectiveServiceModel.mockResolvedValue({
      renderable: true,
      services: [
        { name: 'web', declaredImage: 'nginx:latest', hasBuild: false, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false },
      ],
    });
    mockListContainers.mockRejectedValue(new Error('socket hang up'));

    await expect(recordObservedRuntimeArtifactForDeploy({
      stackName: 'list-web',
      nodeId: 1,
      applicationId: 'app-list',
      envelope: envelope('op-observe-list'),
    })).resolves.toBeUndefined();

    expect(decodeObservedArtifactIdentity(
      GitOpsStore.getInstance().getTarget('app-list', 1)?.observed_artifact_identity_json ?? null,
    )).toEqual({ kind: 'unavailable' });
  });
});

function envelope(operationId: string): EventEnvelope {
  return { operationId, actor: 'tester', trigger: 'manual', at: 2 };
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
    nodeId: 1,
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
    poll_interval_secs: null,
    materialization_fingerprint: 'a'.repeat(64),
    desired_commit_sha: 'abc123',
    fetched_commit_sha: 'abc123',
    fetched_resolved_ref_kind: 'branch',
    candidate_generation_id: null,
    accepted_generation_id: generationId,
    candidate_plan_blocked: 0,
    review_required: 0,
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
    created_at: 1,
  };
}
