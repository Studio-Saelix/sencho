/**
 * Direct tests for StackUpdateRecoveryService artifact lifecycle and compensation probe.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockTag = vi.fn().mockResolvedValue(undefined);
const mockRemove = vi.fn().mockResolvedValue(undefined);
const mockListContainers = vi.fn().mockResolvedValue([]);
const mockInspectContainer = vi.fn();
const mockGetContainer = vi.fn(() => ({ inspect: mockInspectContainer }));
const mockGetImage = vi.fn((ref: string) => ({
  tag: mockTag,
  remove: mockRemove,
  inspect: vi.fn().mockResolvedValue({ RepoDigests: [] }),
  _ref: ref,
}));

vi.mock('../services/DockerController', () => ({
  default: {
    getInstance: () => ({
      getDocker: () => ({
        listContainers: mockListContainers,
        getContainer: mockGetContainer,
        getImage: mockGetImage,
      }),
    }),
  },
}));

vi.mock('../services/FileSystemService', () => ({
  FileSystemService: {
    getInstance: () => ({
      getBaseDir: () => '/test/compose',
      backupStackFiles: vi.fn().mockResolvedValue(undefined),
      restoreStackFiles: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

vi.mock('../services/composeProjectContext', () => ({
  classifyReferenceKind: () => 'moving_tag',
  resolveComposeProjectContext: vi.fn().mockResolvedValue({
    validateForMutation: vi.fn().mockResolvedValue(undefined),
    backupFromContext: vi.fn().mockResolvedValue('11111111-1111-4111-8111-111111111111'),
    restoreFromContext: vi.fn().mockResolvedValue(undefined),
  }),
  resolveComposeProjectContextForGeneration: vi.fn().mockResolvedValue({
    validateForMutation: vi.fn().mockResolvedValue(undefined),
    backupFromContext: vi.fn().mockResolvedValue('11111111-1111-4111-8111-111111111111'),
    restoreFromContext: vi.fn().mockResolvedValue(undefined),
    backupSlotId: '11111111-1111-4111-8111-111111111111',
  }),
}));

vi.mock('../services/RollbackGenerationStore', () => ({
  RollbackGenerationStore: {
    retireGenerationContent: vi.fn().mockResolvedValue(undefined),
    getGenerationDir: vi.fn(() => '/tmp/gen'),
    verifyGenerationContent: vi.fn().mockResolvedValue(false),
    commitRestoreTransaction: vi.fn().mockResolvedValue(undefined),
    reconcileInterruptedRestore: vi.fn().mockResolvedValue(false),
  },
  getBackupBaseDir: () => '/tmp/backups',
}));


vi.mock('../services/PolicyEnforcement', () => ({
  enforcePolicyPreDeploy: vi.fn().mockResolvedValue({ ok: true, bypassed: false, violations: [] }),
}));

vi.mock('../services/rollbackEligibility', () => ({
  assessGenerationEligibility: vi.fn().mockResolvedValue('eligible'),
  evaluateRollbackEligibility: vi.fn(),
}));

vi.mock('../services/effectiveServiceModel', () => ({
  buildEffectiveServiceModel: vi.fn().mockResolvedValue({
    renderable: true,
    services: [{ name: 'web', declaredImage: 'nginx:latest', hasBuild: false, expectedReplicas: 1 }],
  }),
}));

const mockValidateExact = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/ComposeService', async () => {
  const actual = await vi.importActual<typeof import('../services/ComposeService')>('../services/ComposeService');
  return {
    ...actual,
    ComposeService: {
      getInstance: () => ({
        validateExactComposeInvocation: mockValidateExact,
        buildAuthoredComposeArgs: vi.fn(),
      }),
    },
    getComposeCommandTimeoutMs: () => 60_000,
  };
});

const mockUnlink = vi.fn().mockResolvedValue(undefined);
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockRealpath = vi.fn(async (p: string) => p);
const mockAccess = vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
const mockReaddir = vi.fn().mockResolvedValue([]);
const mockStat = vi.fn();
const mockRm = vi.fn().mockResolvedValue(undefined);
vi.mock('fs/promises', () => ({
  default: {
    unlink: (p: string) => mockUnlink(p),
    writeFile: (p: string, data: string, enc?: string) => mockWriteFile(p, data, enc),
    realpath: (p: string) => mockRealpath(p),
    access: (p: string) => mockAccess(p),
    readdir: (p: string) => mockReaddir(p),
    stat: (p: string) => mockStat(p),
    rm: (p: string, opts?: unknown) => mockRm(p, opts),
  },
  unlink: (p: string) => mockUnlink(p),
  writeFile: (p: string, data: string, enc?: string) => mockWriteFile(p, data, enc),
  realpath: (p: string) => mockRealpath(p),
  access: (p: string) => mockAccess(p),
  readdir: (p: string) => mockReaddir(p),
  stat: (p: string) => mockStat(p),
  rm: (p: string, opts?: unknown) => mockRm(p, opts),
}));

import { DatabaseService } from '../services/DatabaseService';
import { StackUpdateRecoveryService } from '../services/StackUpdateRecoveryService';

describe('StackUpdateRecoveryService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    StackUpdateRecoveryService.resetForTests();
    vi.spyOn(DatabaseService.prototype, 'getGitSource').mockReturnValue(undefined as never);
    mockListContainers.mockResolvedValue([
      { Id: 'c1', State: 'running', Labels: {} },
    ]);
    mockInspectContainer.mockResolvedValue({
      State: { Status: 'running', ExitCode: 0 },
      Image: 'sha256:abc',
    });
    mockValidateExact.mockResolvedValue(undefined);
    mockUnlink.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockRealpath.mockImplementation(async (p: string) => p);
    mockRemove.mockResolvedValue(undefined);
    mockTag.mockResolvedValue(undefined);
  });

  it('validates exact invocation before tagging images', async () => {
    const order: string[] = [];
    mockValidateExact.mockImplementation(async () => { order.push('validate'); });
    mockTag.mockImplementation(async () => { order.push('tag'); });
    mockWriteFile.mockImplementation(async () => { order.push('write'); });

    const spyInsert = vi.spyOn(DatabaseService.prototype, 'insertStackUpdateRecoveryGeneration')
      .mockImplementation(() => { order.push('insert'); });
    vi.spyOn(DatabaseService.prototype, 'getGlobalSettings').mockReturnValue({});

    await StackUpdateRecoveryService.getInstance().captureCandidate({
      nodeId: 1,
      stackName: 'my-stack',
      createdBy: 'test',
    });

    expect(order.indexOf('validate')).toBeLessThan(order.indexOf('tag'));
    expect(order.indexOf('tag')).toBeLessThan(order.indexOf('write'));
    expect(order.indexOf('write')).toBeLessThan(order.indexOf('insert'));
    spyInsert.mockRestore();
  });

  it('retires opaque tags and override on abandon', async () => {
    const row = {
      id: 'gen-1',
      node_id: 1,
      stack_name: 'my-stack',
      status: 'candidate' as const,
      phase: 'captured' as const,
      is_current: 0,
      backup_slot_id: null,
      content_path: null,
      operation_kind: null,
      override_path: '/test/compose/my-stack/.sencho-recovery-aaaaaaaaaaaa.yml',
      services_json: JSON.stringify([{
        serviceName: 'web',
        scale: 1,
        hasBuild: false,
        declaredImageRef: 'nginx:latest',
        referenceKind: 'moving_tag',
        replicas: [{ containerId: 'c1', imageId: 'sha256:abc', repoDigest: null, state: 'running', rollbackTag: 'sencho-rb/aaaaaaaaaaaa/web:hold' }],
      }]),
      health_gate_id: null,
      gate_retain_until: null,
      artifact_expires_at: null,
      operation_lease_expires_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      created_by: null,
      artifacts_retired: 0,
      released_at: null,
      released_by: null,
    };

    vi.spyOn(DatabaseService.prototype, 'getStackUpdateRecoveryGeneration').mockReturnValue(row);
    vi.spyOn(DatabaseService.prototype, 'abandonStackUpdateRecoveryGeneration').mockReturnValue(true);
    const markRetired = vi.spyOn(DatabaseService.prototype, 'markStackUpdateRecoveryArtifactsRetired')
      .mockReturnValue(true);

    const ok = await StackUpdateRecoveryService.getInstance().abandon('gen-1');
    expect(ok).toBe(true);
    expect(mockRemove).toHaveBeenCalled();
    expect(mockUnlink).toHaveBeenCalledWith(row.override_path);
    expect(markRetired).toHaveBeenCalledWith('gen-1');
  });

  it('does not mark restored_current when recovery probe finds crashed containers', async () => {
    const servicesJson = JSON.stringify([{
      serviceName: 'web',
      scale: 1,
      hasBuild: false,
      declaredImageRef: 'nginx:latest',
      referenceKind: 'moving_tag',
      replicas: [{ containerId: 'c1', imageId: 'sha256:abc', repoDigest: null, state: 'running', rollbackTag: 'sencho-rb/x/web:hold' }],
    }]);
    const row = {
      id: 'gen-2',
      node_id: 1,
      stack_name: 'my-stack',
      status: 'active' as const,
      phase: 'reconciling' as const,
      is_current: 1,
      backup_slot_id: 'b1',
      content_path: null,
      operation_kind: null,
      override_path: '/test/compose/my-stack/.sencho-recovery-bbbbbbbbbbbb.yml',
      services_json: servicesJson,
      health_gate_id: null,
      gate_retain_until: null,
      artifact_expires_at: null,
      operation_lease_expires_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      created_by: null,
      artifacts_retired: 0,
      released_at: null,
      released_by: null,
    };
    vi.spyOn(DatabaseService.prototype, 'getStackUpdateRecoveryGeneration').mockReturnValue(row);
    const update = vi.spyOn(DatabaseService.prototype, 'updateStackUpdateRecoveryGeneration')
      .mockImplementation(() => undefined);

    mockListContainers.mockResolvedValue([{ Id: 'c1', State: 'exited', Labels: { 'com.docker.compose.service': 'web' } }]);
    mockInspectContainer.mockResolvedValue({ State: { ExitCode: 0 } });

    vi.useFakeTimers();
    const promise = StackUpdateRecoveryService.getInstance().compensateWithCandidate(
      'gen-2',
      async () => undefined,
    );
    await vi.advanceTimersByTimeAsync(3100);
    const ok = await promise;
    vi.useRealTimers();

    expect(ok).toBe(false);
    expect(update).toHaveBeenCalledWith('gen-2', expect.objectContaining({ status: 'recovery_required' }));
    expect(update).not.toHaveBeenCalledWith(
      'gen-2',
      expect.objectContaining({ status: 'restored_current' }),
    );
  });

  it('fails closed when content_path is set but generation dir is missing', async () => {
    const genId = '11111111-1111-4111-8111-111111111111';
    const restoreSpy = vi.fn().mockResolvedValue(undefined);
    const { resolveComposeProjectContext, resolveComposeProjectContextForGeneration } =
      await import('../services/composeProjectContext');
    vi.mocked(resolveComposeProjectContext).mockResolvedValue({
      validateForMutation: vi.fn().mockResolvedValue(undefined),
      backupFromContext: vi.fn().mockResolvedValue(genId),
      restoreFromContext: restoreSpy,
      nodeId: 1,
      stackName: 'my-stack',
      stackDir: '/test/compose/my-stack',
      backupSlotId: null,
      toComposeArgs: vi.fn(),
      resolveServiceImageMap: vi.fn(),
    });
    vi.mocked(resolveComposeProjectContextForGeneration).mockResolvedValue({
      validateForMutation: vi.fn().mockResolvedValue(undefined),
      backupFromContext: vi.fn().mockResolvedValue(genId),
      restoreFromContext: restoreSpy,
      nodeId: 1,
      stackName: 'my-stack',
      stackDir: '/test/compose/my-stack',
      backupSlotId: genId,
      toComposeArgs: vi.fn(),
      resolveServiceImageMap: vi.fn(),
    });

    const row = {
      id: genId,
      node_id: 1,
      stack_name: 'my-stack',
      status: 'active' as const,
      phase: 'reconciling' as const,
      is_current: 1,
      backup_slot_id: genId,
      content_path: genId,
      operation_kind: 'update' as const,
      override_path: '/test/compose/my-stack/.sencho-recovery-bbbbbbbbbbbb.yml',
      services_json: '[]',
      health_gate_id: null,
      gate_retain_until: null,
      artifact_expires_at: null,
      operation_lease_expires_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      created_by: null,
      artifacts_retired: 0,
      released_at: null,
      released_by: null,
    };
    vi.spyOn(DatabaseService.prototype, 'getStackUpdateRecoveryGeneration').mockReturnValue(row);
    const update = vi.spyOn(DatabaseService.prototype, 'updateStackUpdateRecoveryGeneration')
      .mockImplementation(() => undefined);
    mockAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await expect(
      StackUpdateRecoveryService.getInstance().compensateWithCandidate(genId, async () => undefined),
    ).rejects.toMatchObject({ code: 'GENERATION_CONTENT_MISSING' });

    expect(restoreSpy).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(genId, expect.objectContaining({ status: 'recovery_required' }));
  });

  const capturedWebReplica = {
    containerId: 'c1',
    imageId: 'sha256:oldimg',
    repoDigest: null,
    state: 'running' as const,
    rollbackTag: 'sencho-rb/aaaaaaaaaaaa/web:hold',
  };

  it('probeRecoveredStack rejects empty runtime when expected replicas were running', async () => {
    const servicesJson = JSON.stringify([{
      serviceName: 'web', scale: 1, hasBuild: false, declaredImageRef: 'nginx:latest',
      referenceKind: 'moving_tag', replicas: [capturedWebReplica],
    }]);
    mockListContainers.mockResolvedValue([]);
    vi.useFakeTimers();
    const promise = StackUpdateRecoveryService.getInstance().probeRecoveredStack(1, 'my-stack', servicesJson);
    await vi.advanceTimersByTimeAsync(3100);
    await expect(promise).resolves.toBe(false);
    vi.useRealTimers();
  });

  it('probeRecoveredStack rejects restarting and unhealthy expected containers', async () => {
    const servicesJson = JSON.stringify([{
      serviceName: 'web', scale: 1, hasBuild: false, declaredImageRef: 'nginx:latest',
      referenceKind: 'moving_tag', replicas: [capturedWebReplica],
    }]);

    mockListContainers.mockResolvedValue([
      { Id: 'c1', State: 'restarting', Labels: { 'com.docker.compose.service': 'web' } },
    ]);
    vi.useFakeTimers();
    let promise = StackUpdateRecoveryService.getInstance().probeRecoveredStack(1, 'my-stack', servicesJson);
    await vi.advanceTimersByTimeAsync(3100);
    await expect(promise).resolves.toBe(false);
    vi.useRealTimers();

    mockListContainers.mockResolvedValue([
      { Id: 'c1', State: 'running', Labels: { 'com.docker.compose.service': 'web' } },
    ]);
    mockInspectContainer.mockResolvedValue({
      Image: 'sha256:oldimg',
      State: { Status: 'running', Health: { Status: 'unhealthy' } },
    });
    vi.useFakeTimers();
    promise = StackUpdateRecoveryService.getInstance().probeRecoveredStack(1, 'my-stack', servicesJson);
    await vi.advanceTimersByTimeAsync(3100);
    await expect(promise).resolves.toBe(false);
    vi.useRealTimers();
  });

  it('probeRecoveredStack rejects healthy containers running a mismatched image', async () => {
    const servicesJson = JSON.stringify([{
      serviceName: 'web', scale: 1, hasBuild: false, declaredImageRef: 'nginx:latest',
      referenceKind: 'moving_tag', replicas: [capturedWebReplica],
    }]);
    mockListContainers.mockResolvedValue([
      { Id: 'c1', State: 'running', Labels: { 'com.docker.compose.service': 'web' } },
    ]);
    mockInspectContainer.mockResolvedValue({
      Image: 'sha256:newfailed',
      Config: { Image: 'nginx:alpine' },
      State: { Status: 'running' },
    });
    vi.useFakeTimers();
    const promise = StackUpdateRecoveryService.getInstance().probeRecoveredStack(1, 'my-stack', servicesJson);
    await vi.advanceTimersByTimeAsync(3100);
    await expect(promise).resolves.toBe(false);
    vi.useRealTimers();
  });

  it('probeRecoveredStack rejects a running replica for a service captured at scale zero', async () => {
    const servicesJson = JSON.stringify([{
      serviceName: 'worker', scale: 0, hasBuild: false, declaredImageRef: 'busybox:latest',
      referenceKind: 'moving_tag',
      replicas: [{
        containerId: 'c0', imageId: 'sha256:worker', repoDigest: null, state: 'stopped',
        rollbackTag: 'sencho-rb/aaaaaaaaaaaa/worker:hold',
      }],
    }]);
    mockListContainers.mockResolvedValue([
      { Id: 'c0', State: 'running', Labels: { 'com.docker.compose.service': 'worker' } },
    ]);
    mockInspectContainer.mockResolvedValue({
      Image: 'sha256:worker',
      State: { Status: 'running' },
    });
    vi.useFakeTimers();
    const promise = StackUpdateRecoveryService.getInstance().probeRecoveredStack(1, 'my-stack', servicesJson);
    await vi.advanceTimersByTimeAsync(3100);
    await expect(promise).resolves.toBe(false);
    vi.useRealTimers();
  });

  it('probeRecoveredStack accepts healthy running replicas matching capture scale and image', async () => {
    const servicesJson = JSON.stringify([{
      serviceName: 'web', scale: 1, hasBuild: false, declaredImageRef: 'nginx:latest',
      referenceKind: 'moving_tag', replicas: [capturedWebReplica],
    }]);
    mockListContainers.mockResolvedValue([
      { Id: 'c1', State: 'running', Labels: { 'com.docker.compose.service': 'web' } },
    ]);
    mockInspectContainer.mockResolvedValue({
      Image: 'sha256:oldimg',
      Config: { Image: 'sencho-rb/aaaaaaaaaaaa/web:hold' },
      State: { Status: 'running' },
    });
    vi.useFakeTimers();
    const promise = StackUpdateRecoveryService.getInstance().probeRecoveredStack(1, 'my-stack', servicesJson);
    await vi.advanceTimersByTimeAsync(3100);
    await expect(promise).resolves.toBe(true);
    vi.useRealTimers();
  });

  it('does not mark artifacts retired when tag removal fails', async () => {
    const row = {
      id: 'gen-3',
      node_id: 1,
      stack_name: 'my-stack',
      status: 'abandoned' as const,
      phase: 'captured' as const,
      is_current: 0,
      backup_slot_id: null,
      content_path: null,
      operation_kind: null,
      override_path: null,
      services_json: JSON.stringify([{
        serviceName: 'web', scale: 1, hasBuild: false, declaredImageRef: 'nginx:latest',
        referenceKind: 'moving_tag',
        replicas: [{ containerId: 'c1', imageId: 'sha256:abc', repoDigest: null, state: 'running', rollbackTag: 'sencho-rb/cccccccccccc/web:hold' }],
      }]),
      health_gate_id: null,
      gate_retain_until: null,
      artifact_expires_at: Date.now() - 1,
      operation_lease_expires_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      created_by: null,
      artifacts_retired: 0,
      released_at: null,
      released_by: null,
    };
    mockRemove.mockRejectedValueOnce(Object.assign(new Error('docker busy'), { statusCode: 500 }));
    const markRetired = vi.spyOn(DatabaseService.prototype, 'markStackUpdateRecoveryArtifactsRetired')
      .mockReturnValue(true);
    const ok = await StackUpdateRecoveryService.getInstance().retireGenerationArtifacts(row);
    expect(ok).toBe(false);
    expect(markRetired).not.toHaveBeenCalled();
  });
  it('uses legacy restore for UUID backup_slot_id when content_path is null (B1)', async () => {
    const legacyUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const { resolveComposeProjectContext, resolveComposeProjectContextForGeneration } =
      await import('../services/composeProjectContext');
    const restoreSpy = vi.fn().mockResolvedValue(undefined);
    vi.mocked(resolveComposeProjectContext).mockResolvedValue({
      validateForMutation: vi.fn().mockResolvedValue(undefined),
      backupFromContext: vi.fn().mockResolvedValue(legacyUuid),
      restoreFromContext: restoreSpy,
      nodeId: 1,
      stackName: 'my-stack',
      stackDir: '/test/compose/my-stack',
      backupSlotId: null,
      toComposeArgs: vi.fn(),
      resolveServiceImageMap: vi.fn(),
    } as never);
    vi.mocked(resolveComposeProjectContextForGeneration).mockClear();

    const row = {
      id: 'gen-legacy',
      node_id: 1,
      stack_name: 'my-stack',
      status: 'active' as const,
      phase: 'reconciling' as const,
      is_current: 1,
      backup_slot_id: legacyUuid,
      content_path: null,
      operation_kind: 'update' as const,
      override_path: '/test/compose/my-stack/.sencho-recovery-aaaaaaaaaaaa.yml',
      services_json: '[]',
      health_gate_id: null,
      gate_retain_until: null,
      artifact_expires_at: null,
      operation_lease_expires_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      created_by: null,
      artifacts_retired: 0,
      released_at: null,
      released_by: null,
    };
    vi.spyOn(DatabaseService.prototype, 'getStackUpdateRecoveryGeneration').mockReturnValue(row);
    vi.spyOn(DatabaseService.prototype, 'updateStackUpdateRecoveryGeneration').mockImplementation(() => undefined);
    mockListContainers.mockResolvedValue([]);

    vi.useFakeTimers();
    const promise = StackUpdateRecoveryService.getInstance().compensateWithCandidate(
      'gen-legacy',
      async () => undefined,
    );
    await vi.advanceTimersByTimeAsync(3100);
    const ok = await promise;
    vi.useRealTimers();

    expect(ok).toBe(true);
    expect(resolveComposeProjectContextForGeneration).not.toHaveBeenCalled();
    expect(resolveComposeProjectContext).toHaveBeenCalled();
    expect(restoreSpy).toHaveBeenCalled();
  });

  it('refuses compensation when restored target fails policy (B4)', async () => {
    const { enforcePolicyPreDeploy } = await import('../services/PolicyEnforcement');
    vi.mocked(enforcePolicyPreDeploy).mockResolvedValueOnce({
      ok: false,
      bypassed: false,
      violations: [{ imageRef: 'bad:latest', reasons: ['critical'] }] as never,
      policy: { name: 'block-crit' } as never,
    });

    const genId = '11111111-1111-4111-8111-111111111111';
    const restoreSpy = vi.fn().mockResolvedValue({
      priorRecords: { appliedDeploySpec: null, lkgHint: null },
    });
    const { resolveComposeProjectContextForGeneration, resolveComposeProjectContext } =
      await import('../services/composeProjectContext');
    vi.mocked(resolveComposeProjectContextForGeneration).mockResolvedValue({
      validateForMutation: vi.fn().mockResolvedValue(undefined),
      backupFromContext: vi.fn().mockResolvedValue(genId),
      restoreFromContext: restoreSpy,
      nodeId: 1,
      stackName: 'my-stack',
      stackDir: '/test/compose/my-stack',
      backupSlotId: genId,
      toComposeArgs: vi.fn(),
      resolveServiceImageMap: vi.fn(),
    } as never);
    vi.mocked(resolveComposeProjectContext).mockResolvedValue({
      validateForMutation: vi.fn().mockResolvedValue(undefined),
      backupFromContext: vi.fn().mockResolvedValue(genId),
      restoreFromContext: restoreSpy,
      nodeId: 1,
      stackName: 'my-stack',
      stackDir: '/test/compose/my-stack',
      backupSlotId: null,
      toComposeArgs: vi.fn(),
      resolveServiceImageMap: vi.fn(),
    } as never);

    const row = {
      id: genId,
      node_id: 1,
      stack_name: 'my-stack',
      status: 'active' as const,
      phase: 'reconciling' as const,
      is_current: 1,
      backup_slot_id: genId,
      content_path: genId,
      operation_kind: 'update' as const,
      override_path: '/test/compose/my-stack/.sencho-recovery-bbbbbbbbbbbb.yml',
      services_json: '[]',
      health_gate_id: null,
      gate_retain_until: null,
      artifact_expires_at: null,
      operation_lease_expires_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      created_by: null,
      artifacts_retired: 0,
      released_at: null,
      released_by: null,
    };
    vi.spyOn(DatabaseService.prototype, 'getStackUpdateRecoveryGeneration').mockReturnValue(row);
    const update = vi.spyOn(DatabaseService.prototype, 'updateStackUpdateRecoveryGeneration')
      .mockImplementation(() => undefined);
    mockAccess.mockResolvedValue(undefined);

    await expect(
      StackUpdateRecoveryService.getInstance().compensateWithCandidate(genId, async () => undefined),
    ).rejects.toMatchObject({ code: 'ROLLBACK_PROHIBITED' });
    expect(restoreSpy).toHaveBeenCalled();
    expect(update).not.toHaveBeenCalledWith(genId, expect.objectContaining({ status: 'restored_current' }));
  });


  it('restores captured Git appliedDeploySpec on compensate (B2)', async () => {
    const genId = '22222222-2222-4222-8222-222222222222';
    const priorSpec = { files: ['compose.yaml', 'docker-compose.override.yaml'], contextDir: 'app' };
    const restoreSpy = vi.fn().mockResolvedValue({
      priorRecords: {
        appliedDeploySpec: JSON.stringify(priorSpec),
        lkgHint: null,
        lastAppliedContentHash: 'hash-prior',
        manifestState: 'active',
        manifestGeneration: 'generations/prior',
      },
      git: {
        repoUrl: 'https://example.com/r.git',
        branch: 'main',
        commitSha: 'abc1234deadbeef',
        manifestVersion: 3,
      },
    });
    const { resolveComposeProjectContextForGeneration } = await import('../services/composeProjectContext');
    vi.mocked(resolveComposeProjectContextForGeneration).mockResolvedValue({
      validateForMutation: vi.fn().mockResolvedValue(undefined),
      backupFromContext: vi.fn().mockResolvedValue(genId),
      restoreFromContext: restoreSpy,
      nodeId: 1,
      stackName: 'my-stack',
      stackDir: '/test/compose/my-stack',
      backupSlotId: genId,
      toComposeArgs: vi.fn(),
      resolveServiceImageMap: vi.fn(),
    } as never);

    vi.spyOn(DatabaseService.prototype, 'getGitSource').mockReturnValue({
      stack_name: 'my-stack',
      applied_deploy_spec: { files: ['compose.yaml'], contextDir: null },
      last_applied_commit_sha: 'newsha',
      last_applied_content_hash: 'hash-new',
      manifest_version: 3,
      manifest_state: 'active',
      manifest_generation: 'generations/new',
    } as never);
    const setSpec = vi.spyOn(DatabaseService.prototype, 'setGitSourceAppliedSpec').mockImplementation(() => undefined);
    const markApplied = vi.spyOn(DatabaseService.prototype, 'markGitSourceApplied').mockImplementation(() => undefined);
    const setManifest = vi.spyOn(DatabaseService.prototype, 'setGitSourceManifestState').mockImplementation(() => undefined);

    const row = {
      id: genId,
      node_id: 1,
      stack_name: 'my-stack',
      status: 'active' as const,
      phase: 'reconciling' as const,
      is_current: 1,
      backup_slot_id: genId,
      content_path: genId,
      operation_kind: 'git_apply' as const,
      override_path: '/test/compose/my-stack/.sencho-recovery-bbbbbbbbbbbb.yml',
      services_json: '[]',
      health_gate_id: null,
      gate_retain_until: null,
      artifact_expires_at: null,
      operation_lease_expires_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      created_by: null,
      artifacts_retired: 0,
      released_at: null,
      released_by: null,
    };
    vi.spyOn(DatabaseService.prototype, 'getStackUpdateRecoveryGeneration').mockReturnValue(row);
    vi.spyOn(DatabaseService.prototype, 'updateStackUpdateRecoveryGeneration').mockImplementation(() => undefined);
    mockAccess.mockResolvedValue(undefined);
    mockListContainers.mockResolvedValue([]);

    vi.useFakeTimers();
    const promise = StackUpdateRecoveryService.getInstance().compensateWithCandidate(genId, async () => undefined);
    await vi.advanceTimersByTimeAsync(3100);
    const ok = await promise;
    vi.useRealTimers();

    expect(ok).toBe(true);
    expect(setSpec).toHaveBeenCalledWith('my-stack', priorSpec);
    expect(markApplied).toHaveBeenCalledWith('my-stack', 'abc1234deadbeef', 'hash-prior');
    expect(setManifest).toHaveBeenCalledWith('my-stack', 3, 'active', 'generations/prior');
  });


  it('clears null appliedDeploySpec on compensate', async () => {
    const genId = '33333333-3333-4333-8333-333333333333';
    const restoreSpy = vi.fn().mockResolvedValue({
      priorRecords: {
        appliedDeploySpec: null,
        lkgHint: null,
        lastAppliedContentHash: null,
        manifestState: null,
        manifestGeneration: null,
      },
      git: null,
    });
    const { resolveComposeProjectContextForGeneration } = await import('../services/composeProjectContext');
    vi.mocked(resolveComposeProjectContextForGeneration).mockResolvedValue({
      validateForMutation: vi.fn().mockResolvedValue(undefined),
      backupFromContext: vi.fn().mockResolvedValue(genId),
      restoreFromContext: restoreSpy,
      nodeId: 1,
      stackName: 'my-stack',
      stackDir: '/test/compose/my-stack',
      backupSlotId: genId,
      toComposeArgs: vi.fn(),
      resolveServiceImageMap: vi.fn(),
    } as never);

    vi.spyOn(DatabaseService.prototype, 'getGitSource').mockReturnValue({
      stack_name: 'my-stack',
      applied_deploy_spec: { files: ['compose.yaml'], contextDir: null },
      last_applied_commit_sha: 'newsha',
      last_applied_content_hash: 'hash-new',
      manifest_version: null,
      manifest_state: null,
      manifest_generation: null,
    } as never);
    const setSpec = vi.spyOn(DatabaseService.prototype, 'setGitSourceAppliedSpec').mockImplementation(() => undefined);

    const row = {
      id: genId,
      node_id: 1,
      stack_name: 'my-stack',
      status: 'active' as const,
      phase: 'reconciling' as const,
      is_current: 1,
      backup_slot_id: genId,
      content_path: genId,
      operation_kind: 'git_apply' as const,
      override_path: '/test/compose/my-stack/.sencho-recovery-bbbbbbbbbbbb.yml',
      services_json: '[]',
      health_gate_id: null,
      gate_retain_until: null,
      artifact_expires_at: null,
      operation_lease_expires_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      created_by: null,
      artifacts_retired: 0,
      released_at: null,
      released_by: null,
    };
    vi.spyOn(DatabaseService.prototype, 'getStackUpdateRecoveryGeneration').mockReturnValue(row);
    vi.spyOn(DatabaseService.prototype, 'updateStackUpdateRecoveryGeneration').mockImplementation(() => undefined);
    mockAccess.mockResolvedValue(undefined);
    mockListContainers.mockResolvedValue([]);

    const { RollbackGenerationStore } = await import('../services/RollbackGenerationStore');
    vi.mocked(RollbackGenerationStore.commitRestoreTransaction).mockClear();

    vi.useFakeTimers();
    const promise = StackUpdateRecoveryService.getInstance().compensateWithCandidate(genId, async () => undefined);
    await vi.advanceTimersByTimeAsync(3100);
    const ok = await promise;
    vi.useRealTimers();

    expect(ok).toBe(true);
    expect(setSpec).toHaveBeenCalledWith('my-stack', null);
    expect(RollbackGenerationStore.commitRestoreTransaction).toHaveBeenCalled();
  });

  it('commits restore transaction when probe fails after generation restore', async () => {
    const genId = '44444444-4444-4444-8444-444444444444';
    const restoreSpy = vi.fn().mockResolvedValue({
      priorRecords: { appliedDeploySpec: null, lkgHint: null, lastAppliedContentHash: null, manifestState: null, manifestGeneration: null },
      git: null,
    });
    const { resolveComposeProjectContextForGeneration } = await import('../services/composeProjectContext');
    vi.mocked(resolveComposeProjectContextForGeneration).mockResolvedValue({
      validateForMutation: vi.fn().mockResolvedValue(undefined),
      backupFromContext: vi.fn().mockResolvedValue(genId),
      restoreFromContext: restoreSpy,
      nodeId: 1,
      stackName: 'my-stack',
      stackDir: '/test/compose/my-stack',
      backupSlotId: genId,
      toComposeArgs: vi.fn(),
      resolveServiceImageMap: vi.fn(),
    } as never);

    const servicesJson = JSON.stringify([{
      serviceName: 'web',
      scale: 1,
      hasBuild: false,
      declaredImageRef: 'nginx:latest',
      referenceKind: 'moving_tag',
      replicas: [{ containerId: 'c1', imageId: 'sha256:abc', repoDigest: null, state: 'running', rollbackTag: 'sencho-rb/x/web:hold' }],
    }]);
    const row = {
      id: genId,
      node_id: 1,
      stack_name: 'my-stack',
      status: 'active' as const,
      phase: 'reconciling' as const,
      is_current: 1,
      backup_slot_id: genId,
      content_path: genId,
      operation_kind: 'update' as const,
      override_path: '/test/compose/my-stack/.sencho-recovery-bbbbbbbbbbbb.yml',
      services_json: servicesJson,
      health_gate_id: null,
      gate_retain_until: null,
      artifact_expires_at: null,
      operation_lease_expires_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      created_by: null,
      artifacts_retired: 0,
      released_at: null,
      released_by: null,
    };
    vi.spyOn(DatabaseService.prototype, 'getStackUpdateRecoveryGeneration').mockReturnValue(row);
    vi.spyOn(DatabaseService.prototype, 'updateStackUpdateRecoveryGeneration').mockImplementation(() => undefined);
    mockAccess.mockResolvedValue(undefined);
    mockListContainers.mockResolvedValue([{ Id: 'c1', State: 'exited', Labels: { 'com.docker.compose.service': 'web' } }]);
    mockInspectContainer.mockResolvedValue({ State: { ExitCode: 1 } });

    const { RollbackGenerationStore } = await import('../services/RollbackGenerationStore');
    vi.mocked(RollbackGenerationStore.commitRestoreTransaction).mockClear();

    vi.useFakeTimers();
    const promise = StackUpdateRecoveryService.getInstance().compensateWithCandidate(genId, async () => undefined);
    await vi.advanceTimersByTimeAsync(3100);
    const ok = await promise;
    vi.useRealTimers();

    expect(ok).toBe(false);
    expect(RollbackGenerationStore.commitRestoreTransaction).toHaveBeenCalledWith(1, 'my-stack', genId);
  });


});
