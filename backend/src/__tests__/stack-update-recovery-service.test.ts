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
    backupFromContext: vi.fn().mockResolvedValue('backup-1'),
    restoreFromContext: vi.fn().mockResolvedValue(undefined),
  }),
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
vi.mock('fs/promises', () => ({
  default: {
    unlink: (p: string) => mockUnlink(p),
    writeFile: (p: string, data: string, enc?: string) => mockWriteFile(p, data, enc),
    realpath: (p: string) => mockRealpath(p),
  },
  unlink: (p: string) => mockUnlink(p),
  writeFile: (p: string, data: string, enc?: string) => mockWriteFile(p, data, enc),
  realpath: (p: string) => mockRealpath(p),
}));

import { DatabaseService } from '../services/DatabaseService';
import { StackUpdateRecoveryService } from '../services/StackUpdateRecoveryService';

describe('StackUpdateRecoveryService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    StackUpdateRecoveryService.resetForTests();
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
});
