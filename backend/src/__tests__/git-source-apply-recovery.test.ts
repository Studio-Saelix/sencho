/**
 * R1: Git apply promote succeeds, deploy fails → applied true, generation current,
 * compensateWithCandidate is not called.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GIT_CHANGE_PLAN_SCHEMA_VERSION } from '../types/gitChangePlan';

const mockCaptureCandidate = vi.fn();
const mockAbandon = vi.fn();
const mockMarkAcquired = vi.fn().mockReturnValue(true);
const mockHandoff = vi.fn().mockReturnValue(true);
const mockMarkReconciling = vi.fn().mockReturnValue(true);
const mockMarkImmediateVerified = vi.fn().mockReturnValue(true);
const mockGet = vi.fn();
const mockCompensate = vi.fn();

vi.mock('../services/StackUpdateRecoveryService', () => ({
  StackUpdateRecoveryService: {
    getInstance: () => ({
      captureCandidate: mockCaptureCandidate,
      abandon: mockAbandon,
      markAcquired: mockMarkAcquired,
      handoff: mockHandoff,
      markReconciling: mockMarkReconciling,
      markImmediateVerified: mockMarkImmediateVerified,
      get: mockGet,
      compensateWithCandidate: mockCompensate,
    }),
  },
}));

const mockDeployStack = vi.fn();
vi.mock('../services/ComposeService', () => ({
  ComposeService: {
    getInstance: () => ({
      deployStack: mockDeployStack,
    }),
  },
}));

vi.mock('../services/StackOpLockService', () => ({
  StackOpLockService: {
    getInstance: () => ({
      runExclusive: async (
        _n: number,
        _s: string,
        _a: string,
        _who: string,
        fn: () => Promise<unknown>,
      ) => {
        const result = await fn();
        return { ran: true, result };
      },
    }),
  },
}));

vi.mock('../helpers/policyGate', () => ({
  assertPolicyGateAllows: vi.fn().mockResolvedValue(undefined),
  buildSystemPolicyGateOptions: vi.fn().mockReturnValue({}),
}));

vi.mock('../services/HealthGateService', () => ({
  HealthGateService: {
    getInstance: () => ({
      beginStack: vi.fn(),
    }),
  },
}));

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getDefaultNodeId: () => 1,
    }),
  },
}));

const mockPromoteGeneration = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/GitProjectManifestService', async () => {
  const actual = await vi.importActual<typeof import('../services/GitProjectManifestService')>(
    '../services/GitProjectManifestService',
  );
  return {
    ...actual,
    GitProjectManifestService: {
      getInstance: () => ({
        readManifest: vi.fn().mockResolvedValue(null),
        buildManifest: vi.fn().mockReturnValue({
          manifestVersion: 1,
          state: 'active',
          inputs: [],
          refusals: [],
          generation: { candidateDir: 'c', appliedDir: 'a', previousDir: null },
        }),
        promoteGeneration: mockPromoteGeneration,
        boundsConfig: vi.fn().mockReturnValue({}),
        hashStackFile: vi.fn(),
        verifyContextOnDisk: vi.fn().mockResolvedValue([]),
        writeManifest: vi.fn(),
        buildMigratedManifest: vi.fn(),
      }),
    },
  };
});

vi.mock('../utils/authoredComposeArgs', () => ({
  authoredComposeFileArgs: vi.fn().mockResolvedValue(['-f', 'compose.yaml']),
  authoredComposeEnvFileArgs: vi.fn().mockResolvedValue([]),
  candidateValidationEnvFileArgs: vi.fn().mockResolvedValue([]),
}));

const mockGetGitSource = vi.fn();
const mockMarkGitSourceApplied = vi.fn();
const mockSetGitSourceAppliedSpec = vi.fn();
const mockSetGitSourceManifestState = vi.fn();
const mockUpdateGitSourcePendingPlan = vi.fn();
const mockSetGitSourceLastPlan = vi.fn();
const mockAddNotificationHistory = vi.fn();

vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({
      getGitSource: mockGetGitSource,
      markGitSourceApplied: mockMarkGitSourceApplied,
      setGitSourceAppliedSpec: mockSetGitSourceAppliedSpec,
      setGitSourceManifestState: mockSetGitSourceManifestState,
      updateGitSourcePendingPlan: mockUpdateGitSourcePendingPlan,
      setGitSourceLastPlan: mockSetGitSourceLastPlan,
      addNotificationHistory: mockAddNotificationHistory,
      getStackProjectEnvFiles: vi.fn().mockReturnValue([]),
    }),
  },
}));

vi.mock('../services/DriftLedgerService', () => ({
  DriftLedgerService: {
    getInstance: () => ({
      upsertManagedPathConflicts: vi.fn(),
      resolveManagedPathConflicts: vi.fn(),
    }),
  },
}));

vi.mock('../services/CryptoService', () => ({
  CryptoService: {
    getInstance: () => ({
      decrypt: (v: string) => v,
      encrypt: (v: string) => v,
    }),
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      access: vi.fn().mockResolvedValue(undefined),
    },
  };
});

describe('git-source apply recovery (R1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCaptureCandidate.mockResolvedValue({
      id: 'rec-1',
      node_id: 1,
      stack_name: 'app',
      status: 'candidate',
      phase: 'captured',
      is_current: 0,
    });
    mockGet.mockReturnValue({
      id: 'rec-1',
      is_current: 1,
      status: 'active',
      phase: 'reconciling',
    });
    mockDeployStack.mockRejectedValue(new Error('compose up failed'));
    mockGetGitSource.mockReturnValue({
      stack_name: 'app',
      repo_url: 'https://example.com/repo.git',
      branch: 'main',
      pending_commit_sha: 'abc1234deadbeef',
      pending_compose_content: JSON.stringify({
        v: 4,
        files: { 'compose.yaml': 'services:\n  web:\n    image: nginx\n' },
        contextDir: null,
        candidateRelPath: 'generations/cand',
        inventory: {
          inputs: [],
          refusals: [],
          buildContexts: [],
        },
        planFingerprint: 'fp-test',
        planSchemaVersion: GIT_CHANGE_PLAN_SCHEMA_VERSION,
        operationId: 'op-aaaaaaaa',
      }),
      pending_env_content: null,
      pending_plan_blocked: false,
      sync_env: false,
      compose_paths: ['compose.yaml'],
      context_dir: null,
      auto_deploy_on_apply: true,
      applied_deploy_spec: null,
    });
  });

  const CLEAN_PLAN = {
    schemaVersion: GIT_CHANGE_PLAN_SCHEMA_VERSION,
    fingerprint: 'fp-test',
    blocked: false,
    invocationBlocked: false,
    candidateInvocation: ['-f', 'compose.yaml', '-p', 'app'],
    liveInvocation: ['-f', 'compose.yaml', '-p', 'app'],
    priorInvocation: ['-f', 'compose.yaml', '-p', 'app'],
    operations: [],
    counts: {
      add: 0, modify: 0, delete: 0, rename: 0, unchanged: 0,
      localModified: 0, localMissing: 0, typeChanged: 0, unmanagedCollision: 0, invocation: 0,
    },
  };

  function stubApplyPath(svc: {
    withStackLock: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
    validateCandidate: (...args: unknown[]) => Promise<{ ok: boolean }>;
    decodePendingCompose: (raw: string) => unknown;
    deriveAppliedSpec: (...args: unknown[]) => unknown;
    hashContent: (...args: unknown[]) => string;
    computeChangePlan: (...args: unknown[]) => Promise<typeof CLEAN_PLAN>;
  }) {
    vi.spyOn(svc, 'withStackLock').mockImplementation(async (_name, fn) => fn());
    vi.spyOn(svc, 'validateCandidate').mockResolvedValue({ ok: true });
    vi.spyOn(svc, 'decodePendingCompose').mockReturnValue({
      version: 4,
      files: [{ path: 'compose.yaml', content: 'services:\n  web:\n    image: nginx\n' }],
      contextDir: null,
      candidateRelPath: 'generations/cand',
      inventory: { inputs: [], refusals: [], buildContexts: [] },
      planFingerprint: 'fp-test',
      planSchemaVersion: GIT_CHANGE_PLAN_SCHEMA_VERSION,
      operationId: 'op-aaaaaaaa',
      reviewedLive: [],
    });
    vi.spyOn(svc, 'computeChangePlan').mockResolvedValue(CLEAN_PLAN);
    vi.spyOn(svc, 'deriveAppliedSpec').mockReturnValue({ files: ['compose.yaml'], contextDir: null });
    vi.spyOn(svc, 'hashContent').mockReturnValue('hash');
  }

  it('keeps applied=true and generation current without compensate when deploy fails', async () => {
    const { GitSourceService } = await import('../services/GitSourceService');
    const svc = GitSourceService.getInstance();
    stubApplyPath(svc as never);

    const result = await svc.apply('app', 'abc1234deadbeef', {
      deploy: true,
      actor: 'tester',
      requirePlanFingerprint: false,
    });

    expect(result.applied).toBe(true);
    expect(result.deployed).toBe(false);
    expect(result.deployError).toBeTruthy();
    expect(result.recoveryId).toBe('rec-1');
    expect(mockPromoteGeneration).toHaveBeenCalled();
    expect(mockCaptureCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ operationKind: 'git_apply', stackName: 'app' }),
    );
    expect(mockHandoff).toHaveBeenCalled();
    expect(mockCompensate).not.toHaveBeenCalled();
    expect(mockAbandon).not.toHaveBeenCalled();
    expect(mockSetGitSourceLastPlan).toHaveBeenCalledWith('app', 'fp-test', 'applied');
  });

  it('refuses to promote when recovery capture fails', async () => {
    mockCaptureCandidate.mockRejectedValue(new Error('Exact authored-project rollback coverage is unavailable'));
    mockDeployStack.mockResolvedValue({ recoveryId: null });

    const { GitSourceService, GitSourceError } = await import('../services/GitSourceService');
    const svc = GitSourceService.getInstance();
    stubApplyPath(svc as never);

    await expect(svc.apply('app', 'abc1234deadbeef', {
      deploy: true,
      actor: 'tester',
      requirePlanFingerprint: false,
    })).rejects.toBeInstanceOf(GitSourceError);
    expect(mockPromoteGeneration).not.toHaveBeenCalled();
    expect(mockCaptureCandidate).toHaveBeenCalled();
    expect(mockMarkGitSourceApplied).not.toHaveBeenCalled();
    expect(mockHandoff).not.toHaveBeenCalled();
    expect(mockAbandon).not.toHaveBeenCalled();
  });

  it('records git_apply_failed when promote fails before mutation', async () => {
    const { PromoteGenerationError } = await import('../services/GitProjectManifestService');
    mockPromoteGeneration.mockRejectedValueOnce(new PromoteGenerationError('pre_mutation', new Error('refused')));
    const { GitSourceService, GitSourceError } = await import('../services/GitSourceService');
    const svc = GitSourceService.getInstance();
    stubApplyPath(svc as never);

    await expect(svc.apply('app', 'abc1234deadbeef', { requirePlanFingerprint: false })).rejects.toBeInstanceOf(GitSourceError);
    expect(mockSetGitSourceLastPlan).toHaveBeenCalledWith('app', 'fp-test', 'failed');
    expect(mockAddNotificationHistory).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ category: 'git_apply_failed' }),
    );
  });

  it('records git_apply_rolled_back when promote restore succeeds', async () => {
    const { PromoteGenerationError } = await import('../services/GitProjectManifestService');
    mockPromoteGeneration.mockRejectedValueOnce(new PromoteGenerationError('restored', new Error('write failed')));
    const { GitSourceService, GitSourceError } = await import('../services/GitSourceService');
    const svc = GitSourceService.getInstance();
    stubApplyPath(svc as never);

    await expect(svc.apply('app', 'abc1234deadbeef', { requirePlanFingerprint: false })).rejects.toBeInstanceOf(GitSourceError);
    expect(mockSetGitSourceLastPlan).toHaveBeenCalledWith('app', 'fp-test', 'rolled_back');
    expect(mockAddNotificationHistory).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ category: 'git_apply_rolled_back' }),
    );
  });

  it('records git_apply_failed when restore itself fails', async () => {
    const { PromoteGenerationError } = await import('../services/GitProjectManifestService');
    mockPromoteGeneration.mockRejectedValueOnce(new PromoteGenerationError('recovery_required', new Error('restore failed')));
    const { GitSourceService, GitSourceError } = await import('../services/GitSourceService');
    const svc = GitSourceService.getInstance();
    stubApplyPath(svc as never);

    await expect(svc.apply('app', 'abc1234deadbeef', { requirePlanFingerprint: false })).rejects.toBeInstanceOf(GitSourceError);
    expect(mockSetGitSourceLastPlan).toHaveBeenCalledWith('app', 'fp-test', 'failed');
    expect(mockAddNotificationHistory).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ category: 'git_apply_failed' }),
    );
  });
});
