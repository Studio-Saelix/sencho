import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions } from '../services/gitops/transitions';
import { resolveAndRecordArtifactSet } from '../services/gitops/artifactResolve';
import { encodeArtifactEvidenceJson } from '../services/gitops/json';

const mockBuildEffectiveServiceModel = vi.fn();
const mockResolveRegistryImageDigestForPlatform = vi.fn();
const mockGetAuthForRegistry = vi.fn();
const mockDockerInfo = vi.fn();

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
      }),
    }),
  },
}));

describe('gitops artifact resolve', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await setupTestDb();
    GitOpsStore.resetForTests();
    GitOpsTransitions.resetForTests();
    mockBuildEffectiveServiceModel.mockReset();
    mockResolveRegistryImageDigestForPlatform.mockReset();
    mockGetAuthForRegistry.mockReset();
    mockDockerInfo.mockReset();
    mockGetAuthForRegistry.mockResolvedValue(null);
    mockDockerInfo.mockResolvedValue({ OSType: 'linux', Architecture: 'amd64' });
  });

  afterEach(() => {
    cleanupTestDb(tmpDir);
  });

  it('reduces mixed apps with weakest-wins and distinct failure classes', async () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({
      application: {
        id: 'app-mix',
        lifecycle_key: 'direct:mix-web',
        lifecycle_status: 'active',
        target_mode: 'direct',
        stack_name: 'mix-web',
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
        accepted_generation_id: 'gen-mix',
        candidate_plan_blocked: 0,
        review_required: 0,
        artifact_set_id: 'art-mix-v1',
        latest_artifact_set_id: 'art-mix-v1',
        intent_revision_id: null,
        rollout_candidate_id: null,
        rollout_generation_id: null,
        source_acceptance_ref: 'acc-mix',
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
      },
      nodeId: 1,
      envelope: { operationId: 'op-act-mix', actor: 'tester', trigger: 'manual', at: 1 },
    });
    store.insertGeneration({
      id: 'gen-mix',
      application_id: 'app-mix',
      commit_sha: 'abc123',
      repo_url: 'https://github.com/org/repo.git',
      resolved_ref_kind: 'branch',
      configured_ref: 'main',
      repo_identity_json: '{"host":"github.com","pathname":"/org/repo.git"}',
      manifest_version: 0,
      candidate_dir: 'generations/candidate-gen-mix',
      applied_dir: 'generations/applied-gen-mix-0',
      expected_invocation_json: '{"composeFileOrder":[],"projectName":null,"projectDirectory":null,"envFileOrder":[]}',
      materialization_fingerprint: 'a'.repeat(64),
      validation_ok: 1,
      plan_blocked: 0,
      change_plan_fingerprint: null,
      operation_id: 'op-gen-mix',
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
    });
    store.insertArtifactSet({
      id: 'art-mix-v1',
      generation_id: 'gen-mix',
      evidence_version: 1,
      authoritative: 0,
      qualification: 'unresolved',
      evidence_json: encodeArtifactEvidenceJson({ kind: 'unresolved' }),
      created_at: 1,
    });

    mockBuildEffectiveServiceModel.mockResolvedValue({
      renderable: true,
      services: [
        { name: 'web', declaredImage: 'nginx:latest', hasBuild: false, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false },
        { name: 'worker', declaredImage: null, hasBuild: true, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false },
      ],
    });
    mockResolveRegistryImageDigestForPlatform.mockResolvedValue({
      ok: true,
      indexDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      platformDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      platformLabel: 'linux/amd64',
      qualification: 'exact',
    });

    await resolveAndRecordArtifactSet({
      stackName: 'mix-web',
      nodeId: 1,
      applicationId: 'app-mix',
      generationId: 'gen-mix',
      buildContexts: [],
      envelope: { operationId: 'op-resolve-mix', actor: 'tester', trigger: 'manual', at: 2 },
    });

    const latestId = store.getApplication('app-mix')?.latest_artifact_set_id;
    const latest = latestId ? store.getArtifactSet(latestId) : undefined;
    expect(latest?.qualification).toBe('local_build_unverified');
    const decoded = JSON.parse(latest!.evidence_json);
    type ServiceRow = { serviceName: string; failureClass: string | null; source: string };
    const byName = new Map<string, ServiceRow>(
      (decoded.services as ServiceRow[]).map((service) => [service.serviceName, service]),
    );
    expect(byName.get('web')?.source).toBe('registry');
    expect(byName.get('worker')?.source).toBe('build');
  });
});
