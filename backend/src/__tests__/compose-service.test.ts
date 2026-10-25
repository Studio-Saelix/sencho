/**
 * Unit tests for ComposeService — subprocess handling, deploy/rollback,
 * registry auth temp dir management, and WebSocket output.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import os from 'os';
import path from 'path';
import type WebSocket from 'ws';
import { WITHHELD_DECRYPTED_COMPOSE_OUTPUT } from '../helpers/decryptedComposeOutput';
import { WITHHELD_DECRYPTED_RENDER_OUTPUT, WITHHELD_DECRYPTED_REQUIRED_ENV_OUTPUT } from '../helpers/decryptedComposeOutput';
import { gitSecretsAreaBase } from '../services/gitops/managedPaths';

// ── Hoisted mocks ──────────────────────────────────────────────────────

const {
  mockSpawn,
  mockGetContainersByStack, mockGetLegacyOrphanContainersByStack, mockRemoveContainers, mockListContainers,
  mockContainerInspect, mockContainerLogs, mockImageInspect,
  mockGetRegistries, mockResolveDockerConfig,
  mockBackupStackFiles, mockRestoreStackFiles,
  mockGetComposeFilename, mockGetOverrideFilename, mockEnsureStackOverride,
  mockMkdtempSync, mockWriteFileSync, mockUnlinkSync, mockRmdirSync,
  mockGetGlobalSettings, mockPruneDanglingImages, mockGetBindMounts,
  mockGetStackContent, mockGetEnvContent,
  mockLoadStackBuildServices,
  mockResolveMissingExternalNetworks,
  mockCreateNetwork,
  mockAddNotificationHistory,
  mockIsMeshStackEnabled,
  mockClassifyLegacyOrphansForUpdate,
  mockCaptureCandidate,
  mockMarkAcquired,
  mockHandoff,
  mockMarkReconciling,
  mockMarkImmediateVerified,
  mockInvalidateActiveServiceRecoveries,
  mockSupersedeForContainerOp,
  mockAbandon,
  mockCompensateWithCandidate,
  mockBuildUnifiedHeldImagePredicate,
  mockGetRecovery,
  mockFsStat,
  mockPromisesMkdtemp,
  mockPromisesWriteFile,
  mockPromisesRm,
  mockCleanupDockerAuthTempDir,
  mockCreateDockerAuthTempDir,
  mockRecordRegistryDeliveryEvent,
  mockPreparedSourceFinalize,
} = vi.hoisted(() => {
  const mockCleanupDockerAuthTempDir = vi.fn();
  return {
  mockSpawn: vi.fn(),
  mockGetContainersByStack: vi.fn().mockResolvedValue([]),
  mockGetLegacyOrphanContainersByStack: vi.fn().mockResolvedValue([]),
  mockRemoveContainers: vi.fn().mockResolvedValue([]),
  mockListContainers: vi.fn().mockResolvedValue([]),
  mockContainerInspect: vi.fn().mockResolvedValue({ State: { ExitCode: 0 } }),
  mockImageInspect: vi.fn(),
  mockContainerLogs: vi.fn().mockResolvedValue(Buffer.from('')),
  mockGetRegistries: vi.fn().mockReturnValue([]),
  mockResolveDockerConfig: vi.fn().mockResolvedValue({ config: { auths: {} }, warnings: [] }),
  mockBackupStackFiles: vi.fn().mockResolvedValue(undefined),
  mockRestoreStackFiles: vi.fn().mockResolvedValue(undefined),
  mockGetComposeFilename: vi.fn().mockResolvedValue('compose.yaml'),
  mockGetOverrideFilename: vi.fn().mockResolvedValue(null),
  mockEnsureStackOverride: vi.fn().mockResolvedValue(null),
  mockMkdtempSync: vi.fn().mockReturnValue('/tmp/sencho-docker-test'),
  mockWriteFileSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockRmdirSync: vi.fn(),
  mockGetGlobalSettings: vi.fn().mockReturnValue({}),
  mockPruneDanglingImages: vi.fn().mockResolvedValue({ reclaimedBytes: 0 }),
  mockGetBindMounts: vi.fn().mockResolvedValue(null),
  mockGetStackContent: vi.fn().mockResolvedValue(''),
  mockGetEnvContent: vi.fn().mockResolvedValue(''),
  mockLoadStackBuildServices: vi.fn().mockResolvedValue([]),
  mockResolveMissingExternalNetworks: vi.fn().mockResolvedValue({
    status: 'ok',
    autoCreateEnabled: false,
    stackName: 'my-stack',
    networks: [],
    declaredExternalCount: 0,
  }),
  mockCreateNetwork: vi.fn().mockResolvedValue({ id: 'net-1' }),
  mockAddNotificationHistory: vi.fn(),
  mockIsMeshStackEnabled: vi.fn().mockReturnValue(false),
  mockClassifyLegacyOrphansForUpdate: vi.fn().mockResolvedValue({ status: 'none' }),
  mockCaptureCandidate: vi.fn().mockResolvedValue({
    id: 'recovery-1',
    node_id: 1,
    stack_name: 'my-stack',
    status: 'candidate',
    phase: 'captured',
    override_path: '/test/compose/my-stack/.sencho-recovery-abc.yml',
  }),
  mockMarkAcquired: vi.fn().mockReturnValue(true),
  mockHandoff: vi.fn().mockReturnValue(true),
  mockMarkReconciling: vi.fn().mockReturnValue(true),
  mockMarkImmediateVerified: vi.fn().mockReturnValue(true),
  mockInvalidateActiveServiceRecoveries: vi.fn().mockReturnValue(0),
  mockSupersedeForContainerOp: vi.fn().mockReturnValue(0),
  mockAbandon: vi.fn().mockResolvedValue(true),
  mockCompensateWithCandidate: vi.fn().mockResolvedValue(true),
  mockBuildUnifiedHeldImagePredicate: vi.fn().mockReturnValue(() => false),
  mockGetRecovery: vi.fn().mockReturnValue(undefined),
  mockFsStat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
  mockPromisesMkdtemp: vi.fn<(prefix: string) => Promise<string>>().mockResolvedValue('/tmp/sencho-digest-pins-XXXX'),
  mockPromisesWriteFile: vi.fn<(path: string, data: string | Buffer, opts?: unknown) => Promise<void>>().mockResolvedValue(undefined),
  mockPromisesRm: vi.fn<(path: string, opts?: unknown) => Promise<void>>().mockResolvedValue(undefined),
  mockCleanupDockerAuthTempDir,
  mockCreateDockerAuthTempDir: vi.fn(() => ({
    dirPath: '/tmp/sencho-docker-test',
    kind: 'local' as const,
    cleanup: mockCleanupDockerAuthTempDir,
  })),
  mockRecordRegistryDeliveryEvent: vi.fn(),
  mockPreparedSourceFinalize: vi.fn(),
  };
});

vi.mock('../helpers/dockerAuthTempDir', () => ({
  createDockerAuthTempDir: mockCreateDockerAuthTempDir,
}));

vi.mock('../helpers/registryDeliveryEvidence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../helpers/registryDeliveryEvidence')>();
  return {
    ...actual,
    recordRegistryDeliveryEvent: (...args: unknown[]) => mockRecordRegistryDeliveryEvent(...args),
  };
});

vi.mock('../services/preparedSourceStore', () => ({
  PreparedSourceStore: {
    getInstance: () => ({
      finalize: (...args: unknown[]) => mockPreparedSourceFinalize(...args),
    }),
  },
}));

vi.mock('child_process', () => ({ spawn: mockSpawn, execFile: vi.fn() }));

vi.mock('fs', () => ({
  default: {
    existsSync: () => false,
    mkdtempSync: (...args: unknown[]) => mockMkdtempSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
    rmdirSync: (...args: unknown[]) => mockRmdirSync(...args),
    promises: {
      stat: (...args: unknown[]) => mockFsStat(...args),
      mkdtemp: (prefix: string) => mockPromisesMkdtemp(prefix),
      writeFile: (path: string, data: string | Buffer, opts?: unknown) => mockPromisesWriteFile(path, data, opts),
      rm: (path: string, opts?: unknown) => mockPromisesRm(path, opts),
    },
  },
  existsSync: () => false,
  mkdtempSync: (...args: unknown[]) => mockMkdtempSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
  rmdirSync: (...args: unknown[]) => mockRmdirSync(...args),
  promises: {
    stat: (...args: unknown[]) => mockFsStat(...args),
    mkdtemp: (prefix: string) => mockPromisesMkdtemp(prefix),
    writeFile: (path: string, data: string | Buffer, opts?: unknown) => mockPromisesWriteFile(path, data, opts),
    rm: (path: string, opts?: unknown) => mockPromisesRm(path, opts),
  },
}));

const { mockEvaluateDockerEndpointGuard } = vi.hoisted(() => ({
  mockEvaluateDockerEndpointGuard: vi.fn(),
}));

vi.mock('../helpers/dockerEndpointGuard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../helpers/dockerEndpointGuard')>()),
  evaluateDockerEndpointGuard: mockEvaluateDockerEndpointGuard,
}));

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getDefaultNodeId: () => 1,
      getComposeDir: () => '/test/compose',
    }),
  },
}));

vi.mock('../services/DockerController', () => ({
  default: {
    getInstance: () => ({
      getContainersByStack: mockGetContainersByStack,
      getLegacyOrphanContainersByStack: mockGetLegacyOrphanContainersByStack,
      classifyLegacyOrphansForUpdate: mockClassifyLegacyOrphansForUpdate,
      removeContainers: mockRemoveContainers,
      pruneDanglingImages: mockPruneDanglingImages,
      createNetwork: mockCreateNetwork,
      getDocker: () => ({
        listContainers: mockListContainers,
        getContainer: () => ({
          inspect: mockContainerInspect,
          logs: mockContainerLogs,
        }),
        getImage: () => ({ inspect: mockImageInspect }),
      }),
    }),
  },
}));

vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({
      getRegistries: mockGetRegistries,
      getGlobalSettings: mockGetGlobalSettings,
      getGitSource: () => undefined,
      getStackProjectEnvFiles: () => [],
      addNotificationHistory: mockAddNotificationHistory,
      isMeshStackEnabled: (...args: unknown[]) => mockIsMeshStackEnabled(...args),
      getDb: () => ({
        prepare: () => ({ get: () => undefined, all: () => [], run: () => undefined }),
      }),
    }),
  },
}));

vi.mock('../services/RegistryService', () => ({
  RegistryService: {
    getInstance: () => ({
      resolveDockerConfig: mockResolveDockerConfig,
    }),
  },
}));

vi.mock('../services/FileSystemService', () => ({
  FileSystemService: {
    getInstance: () => ({
      backupStackFiles: mockBackupStackFiles,
      restoreStackFiles: mockRestoreStackFiles,
      getComposeFilename: mockGetComposeFilename,
      getOverrideFilename: mockGetOverrideFilename,
      getStackContent: mockGetStackContent,
      getEnvContent: mockGetEnvContent,
    }),
  },
}));

vi.mock('../services/LogFormatter', () => ({
  LogFormatter: { process: (line: string) => line },
}));

// runCommand and the deploy/update paths route through authoredComposeArgs, which
// resolves the (optional) mesh override. The hoisted mock defaults to "no override"
// so a single-file stack yields plain `docker compose <action>` args deterministically;
// individual tests set a path to exercise the mesh-injection branch.
vi.mock('../services/MeshService', () => ({
  MeshService: {
    getInstance: () => ({ ensureStackOverride: mockEnsureStackOverride }),
  },
}));

vi.mock('../services/recoveryHeldImages', () => ({
  buildUnifiedHeldImagePredicate: mockBuildUnifiedHeldImagePredicate,
}));

vi.mock('../services/StackUpdateRecoveryService', () => ({
  StackUpdateRecoveryService: {
    getInstance: () => ({
      captureCandidate: mockCaptureCandidate,
      markAcquired: mockMarkAcquired,
      handoff: mockHandoff,
      markReconciling: mockMarkReconciling,
      markImmediateVerified: mockMarkImmediateVerified,
      abandon: mockAbandon,
      compensateWithCandidate: mockCompensateWithCandidate,
      get: mockGetRecovery,
      linkGateOrRetain: vi.fn(),
    }),
  },
}));


vi.mock('../services/HealthGateService', () => ({
  HealthGateService: {
    getInstance: () => ({
      supersedeForContainerOp: mockSupersedeForContainerOp,
    }),
  },
}));

vi.mock('../services/ServiceUpdateRecoveryService', () => ({
  ServiceUpdateRecoveryService: {
    getInstance: () => ({
      invalidateActiveForStack: mockInvalidateActiveServiceRecoveries,
    }),
  },
}));

vi.mock('../services/SelfIdentityService', () => ({
  default: {
    getInstance: () => ({ getBindMounts: mockGetBindMounts }),
  },
}));

vi.mock('../services/ImageUpdateService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/ImageUpdateService')>()),
  loadStackBuildServices: (...args: unknown[]) => mockLoadStackBuildServices(...args),
}));

vi.mock('../services/network/resolveMissingExternalNetworks', () => ({
  resolveMissingExternalNetworks: (...args: unknown[]) => mockResolveMissingExternalNetworks(...args),
}));

import { ComposeService, getComposeRollbackInfo, type GitOpsDeployHandle } from '../services/ComposeService';
import { DriftLedgerService } from '../services/DriftLedgerService';

const originalComposeTimeout = process.env.SENCHO_COMPOSE_COMMAND_TIMEOUT_MS;
const originalStallTimeout = process.env.SENCHO_COMPOSE_STALL_TIMEOUT_MS;
const originalSenchoMode = process.env.SENCHO_MODE;

/** Creates an EventEmitter that mimics a child_process spawn result */
function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
    return true;
  });
  return proc;
}

/**
 * runCommand now awaits the authored compose args (mesh override resolution) before
 * spawning, so the child is created one microtask after the call. Tests that drive
 * the mock child's events must wait for the spawn first, or the event fires before
 * any listener is attached.
 */
async function waitForSpawn() {
  await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
}

/** Sets up mockSpawn to auto-close with exit code 0 on next tick */
function setupAutoCloseSpawn(exitCode = 0) {
  mockSpawn.mockImplementation(() => {
    const proc = createMockProcess();
    // Emit close asynchronously (next microtask)
    Promise.resolve().then(() => proc.emit('close', exitCode));
    return proc;
  });
}

type MockWebSocket = EventEmitter & {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  OPEN: number;
} & WebSocket;

function createMockWs(): MockWebSocket {
  const ws = new EventEmitter() as MockWebSocket;
  Object.assign(ws, {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    OPEN: 1,
  });
  return ws;
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks() clears call records but not implementations, so a mockResolvedValue
  // set by one test persists into the next. Re-assert the safe "no mesh override, no user
  // override, base = compose.yaml" baseline here so a stray override from an earlier test
  // cannot leak forward and add phantom -f flags.
  mockGetComposeFilename.mockResolvedValue('compose.yaml');
  mockGetOverrideFilename.mockResolvedValue(null);
  mockEnsureStackOverride.mockResolvedValue(null);
  mockIsMeshStackEnabled.mockReturnValue(false);
  mockGetRegistries.mockReturnValue([]);
  mockResolveDockerConfig.mockResolvedValue({ config: { auths: {} }, warnings: [] });
  mockGetBindMounts.mockResolvedValue(null);
  mockEvaluateDockerEndpointGuard.mockResolvedValue(null);
  mockLoadStackBuildServices.mockResolvedValue([]);
  mockResolveMissingExternalNetworks.mockResolvedValue({
    status: 'ok',
    autoCreateEnabled: false,
    stackName: 'my-stack',
    networks: [],
    declaredExternalCount: 0,
  });
  mockCreateNetwork.mockResolvedValue({ id: 'net-1' });
  mockClassifyLegacyOrphansForUpdate.mockResolvedValue({ status: 'none' });
  mockCaptureCandidate.mockResolvedValue({
    id: 'recovery-1',
    node_id: 1,
    stack_name: 'my-stack',
    status: 'candidate',
    phase: 'captured',
    override_path: '/test/compose/my-stack/.sencho-recovery-abc.yml',
  });
  mockMarkAcquired.mockReturnValue(true);
  mockHandoff.mockReturnValue(true);
  mockMarkReconciling.mockReturnValue(true);
  mockMarkImmediateVerified.mockReturnValue(true);
  mockAbandon.mockResolvedValue(true);
  mockIsMeshStackEnabled.mockReturnValue(false);
  mockCompensateWithCandidate.mockResolvedValue(true);
  mockBuildUnifiedHeldImagePredicate.mockReturnValue(() => false);
  mockFsStat.mockResolvedValue({ isDirectory: () => true });
  mockPromisesMkdtemp.mockResolvedValue('/tmp/sencho-digest-pins-XXXX');
  mockPromisesWriteFile.mockResolvedValue(undefined);
  mockPromisesRm.mockResolvedValue(undefined);
  delete process.env.SENCHO_MODE;
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  if (originalComposeTimeout === undefined) {
    delete process.env.SENCHO_COMPOSE_COMMAND_TIMEOUT_MS;
  } else {
    process.env.SENCHO_COMPOSE_COMMAND_TIMEOUT_MS = originalComposeTimeout;
  }
  if (originalStallTimeout === undefined) {
    delete process.env.SENCHO_COMPOSE_STALL_TIMEOUT_MS;
  } else {
    process.env.SENCHO_COMPOSE_STALL_TIMEOUT_MS = originalStallTimeout;
  }
  if (originalSenchoMode === undefined) {
    delete process.env.SENCHO_MODE;
  } else {
    process.env.SENCHO_MODE = originalSenchoMode;
  }
});

// ── Docker endpoint guard wiring ───────────────────────────────────────

describe('ComposeService - Docker endpoint guard', () => {
  const refusal = {
    reason: 'provider' as const,
    service: 'socket-proxy',
    message: 'Service "socket-proxy" carries the Docker connection Sencho is using.',
  };

  it.each(['stop', 'restart', 'down'] as const)('refuses runCommand %s before spawning compose', async (action) => {
    mockEvaluateDockerEndpointGuard.mockResolvedValue(refusal);

    await expect(ComposeService.getInstance(1).runCommand('my-stack', action)).rejects.toMatchObject({
      name: 'DockerEndpointProtectedError',
      code: 'docker_endpoint_protected',
      reason: 'provider',
    });

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('classifies restart separately from stop, so restarting Sencho stays allowed', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const svc = ComposeService.getInstance(1);

    const restart = svc.runCommand('my-stack', 'restart');
    await waitForSpawn();
    proc.emit('close', 0);
    await restart;
    const stop = svc.runCommand('my-stack', 'stop');
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));
    proc.emit('close', 0);
    await stop;

    const kinds = mockEvaluateDockerEndpointGuard.mock.calls.map(call => call[0].mutation.kind);
    expect(kinds).toEqual(['restart', 'stop']);
  });

  it('does not consult the guard for start', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = ComposeService.getInstance(1).runCommand('my-stack', 'start');
    await waitForSpawn();
    proc.emit('close', 0);
    await promise;

    expect(mockEvaluateDockerEndpointGuard).not.toHaveBeenCalled();
  });

  it('refuses runDown, downStack, and a service-scoped update for the protected service', async () => {
    mockEvaluateDockerEndpointGuard.mockResolvedValue(refusal);
    const svc = ComposeService.getInstance(1);

    await expect(svc.runDown('my-stack')).rejects.toMatchObject({ code: 'docker_endpoint_protected' });
    // downStack swallows teardown failures; a refusal is not one of them.
    await expect(svc.downStack('my-stack')).rejects.toMatchObject({ code: 'docker_endpoint_protected' });
    await expect(svc.updateService('my-stack', 'socket-proxy', false)).rejects.toMatchObject({ code: 'docker_endpoint_protected' });
    await expect(svc.recreateServiceFromLocal('my-stack', 'socket-proxy')).rejects.toMatchObject({ code: 'docker_endpoint_protected' });

    const mutations = mockEvaluateDockerEndpointGuard.mock.calls.map(call => call[0].mutation);
    expect(mutations).toEqual([
      { kind: 'stop' },
      { kind: 'stop' },
      { kind: 'service', service: 'socket-proxy' },
      { kind: 'service', service: 'socket-proxy' },
    ]);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('refuses deployStack and updateStack before any compose work starts', async () => {
    mockEvaluateDockerEndpointGuard.mockResolvedValue(refusal);
    const svc = ComposeService.getInstance(1);

    await expect(svc.deployStack('my-stack')).rejects.toMatchObject({ code: 'docker_endpoint_protected' });
    await expect(svc.updateStack('my-stack')).rejects.toMatchObject({ code: 'docker_endpoint_protected' });

    const kinds = mockEvaluateDockerEndpointGuard.mock.calls.map(call => call[0].mutation.kind);
    expect(kinds).toEqual(['up', 'update']);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('refuses a recovery up, which pins every service to its rollback tag, as an update of the stack', async () => {
    mockEvaluateDockerEndpointGuard.mockResolvedValue(refusal);

    await expect(
      ComposeService.getInstance(1).composeUpWithRecoveryOverride('my-stack', '/tmp/override.yml'),
    ).rejects.toMatchObject({ code: 'docker_endpoint_protected' });

    expect(mockEvaluateDockerEndpointGuard.mock.calls.map(call => call[0].mutation)).toEqual([{ kind: 'update' }]);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('names the services a digest-pin overlay rewrites, which the config hash cannot see', async () => {
    mockEvaluateDockerEndpointGuard.mockResolvedValue(refusal);
    const pin = `socket-proxy@sha256:${'a'.repeat(64)}`;

    await expect(
      ComposeService.getInstance(1).deployStack('my-stack', undefined, false, { source: 'blueprint', actor: 'system:blueprint', digestPins: { 'socket-proxy': pin } }),
    ).rejects.toMatchObject({ code: 'docker_endpoint_protected' });

    expect(mockEvaluateDockerEndpointGuard.mock.calls[0][0].mutation).toEqual({ kind: 'up', pinnedServices: ['socket-proxy'] });
  });

  it('computes the hash against the overlay directory a GitOps deploy runs, not the live stack', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    mockEvaluateDockerEndpointGuard.mockImplementation(async (input: { probes: { configHash(s: string): Promise<string | null> } }) => {
      await input.probes.configHash('socket-proxy');
      return null;
    });

    const check = ComposeService.getInstance(1).evaluateDockerEndpoint('my-stack', { kind: 'up' }, '/tmp/overlay-dir');
    await waitForSpawn();
    proc.emit('close', 0);
    await check;

    expect(mockSpawn).toHaveBeenCalledWith('docker', expect.any(Array), expect.objectContaining({ cwd: '/tmp/overlay-dir' }));
  });

  it('looks up the local image id for the guard, and reports an uninspectable image as unknown', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const seen: unknown[] = [];
    mockEvaluateDockerEndpointGuard.mockImplementation(async (input: { probes: { localImage(ref: string): Promise<unknown> } }) => {
      mockImageInspect.mockResolvedValueOnce({ Id: 'sha256:abc' });
      seen.push(await input.probes.localImage('proxy:latest'));
      mockImageInspect.mockRejectedValueOnce(new Error('no such image'));
      seen.push(await input.probes.localImage('proxy:latest'));
      return null;
    });

    await ComposeService.getInstance(1).evaluateDockerEndpoint('my-stack', { kind: 'up' });

    expect(seen).toEqual([{ state: 'id', id: 'sha256:abc' }, { state: 'unknown' }]);
  });

  it('computes the config hash with the authored invocation and parses `service hash` output', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    let hash: string | null = null;
    mockEvaluateDockerEndpointGuard.mockImplementation(async (input: { probes: { configHash(s: string): Promise<string | null> } }) => {
      hash = await input.probes.configHash('socket-proxy');
      return null;
    });

    const svc = ComposeService.getInstance(1);
    const check = svc.evaluateDockerEndpoint('my-stack', { kind: 'up' });
    await waitForSpawn();
    proc.stdout.emit('data', Buffer.from('socket-proxy 4f9a1c\n'));
    proc.emit('close', 0);
    await check;

    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      ['compose', 'config', '--hash=socket-proxy'],
      expect.objectContaining({ cwd: expect.stringContaining('my-stack') }),
    );
    expect(hash).toBe('4f9a1c');
  });

  it('reports an unavailable hash as null rather than throwing', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    let hash: string | null = 'unset';
    mockEvaluateDockerEndpointGuard.mockImplementation(async (input: { probes: { configHash(s: string): Promise<string | null> } }) => {
      hash = await input.probes.configHash('socket-proxy');
      return null;
    });

    const check = ComposeService.getInstance(1).evaluateDockerEndpoint('my-stack', { kind: 'up' });
    await waitForSpawn();
    proc.stderr.emit('data', Buffer.from('invalid compose project'));
    proc.emit('close', 1);
    await check;

    expect(hash).toBeNull();
  });
});

// ── runCommand ─────────────────────────────────────────────────────────

describe('ComposeService - runCommand', () => {
  it('spawns docker compose with the correct action', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const svc = ComposeService.getInstance(1);
    const promise = svc.runCommand('my-stack', 'restart');
    await waitForSpawn();
    proc.emit('close', 0);
    await promise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      ['compose', 'restart'],
      expect.objectContaining({ cwd: expect.stringContaining('my-stack') })
    );
  });

  it('resolves on exit code 0', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const svc = ComposeService.getInstance(1);
    const promise = svc.runCommand('my-stack', 'start');
    await waitForSpawn();
    proc.emit('close', 0);

    await expect(promise).resolves.toBeUndefined();
  });

  it('rejects on non-zero exit code', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const svc = ComposeService.getInstance(1);
    const promise = svc.runCommand('my-stack', 'stop');
    await waitForSpawn();
    proc.stderr.emit('data', Buffer.from('service not found'));
    proc.emit('close', 1);

    await expect(promise).rejects.toThrow('service not found');
  });

  it('redacts secrets from command failure errors', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const svc = ComposeService.getInstance(1);
    const promise = svc.runCommand('my-stack', 'stop');
    await waitForSpawn();
    proc.stderr.emit('data', Buffer.from('token=abc123SECRET password=hunter2 Authorization: Bearer abc.def.ghi'));
    proc.emit('close', 1);

    await expect(promise).rejects.toThrow('token=[redacted]');
    await expect(promise).rejects.toThrow('password=[redacted]');
    await expect(promise).rejects.not.toThrow('abc.def.ghi');
  });

  it('sends output to WebSocket when provided', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const ws = createMockWs();

    const svc = ComposeService.getInstance(1);
    const promise = svc.runCommand('my-stack', 'restart', ws);
    await waitForSpawn();
    proc.stdout.emit('data', Buffer.from('Restarting...'));
    proc.emit('close', 0);
    await promise;

    expect(ws.send).toHaveBeenCalledWith('Restarting...');
  });

  it('kills and rejects commands that exceed the compose timeout', async () => {
    process.env.SENCHO_COMPOSE_COMMAND_TIMEOUT_MS = '1000';
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const svc = ComposeService.getInstance(1);
    const promise = svc.runCommand('my-stack', 'restart');
    const expectation = expect(promise).rejects.toThrow('Command timed out after 1s');
    let settled = false;
    promise.finally(() => { settled = true; }).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1000);

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(settled).toBe(false);
    proc.emit('close', null);
    await expectation;
  });

  it('keeps the command running when the WebSocket disconnects (progress socket is output-only)', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const ws = createMockWs();

    const svc = ComposeService.getInstance(1);
    const promise = svc.runCommand('my-stack', 'restart', ws);
    await waitForSpawn();
    // The deploy is owned by its HTTP request; closing the progress socket
    // (panel minimized, navigated away, connection blip) must not abort it.
    ws.emit('close');
    expect(proc.kill).not.toHaveBeenCalled();

    // The command still completes on its own exit, not the socket close.
    proc.emit('close', 0);
    await expect(promise).resolves.toBeUndefined();
  });

  it('rewrites ENOMEM spawn failures as host out-of-memory', async () => {
    const freememSpy = vi.spyOn(os, 'freemem').mockReturnValue(32 * 1024 * 1024);
    const totalmemSpy = vi.spyOn(os, 'totalmem').mockReturnValue(6612 * 1024 * 1024);
    try {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);
      const ws = createMockWs();

      const svc = ComposeService.getInstance(1);
      const promise = svc.runCommand('my-stack', 'restart', ws);
      await waitForSpawn();
      const err = Object.assign(new Error('spawn docker ENOMEM'), { code: 'ENOMEM' });
      proc.emit('error', err);

      await expect(promise).rejects.toThrow(/Out of memory while launching docker/);
      const sendCalls = ws.send.mock.calls.map(c => c[0] as string);
      expect(sendCalls.some(msg => msg.includes('Out of memory while launching docker'))).toBe(true);
    } finally {
      freememSpy.mockRestore();
      totalmemSpy.mockRestore();
    }
  });

  it('rewrites ENOENT spawn failures as host OOM when free memory is below the floor', async () => {
    const freememSpy = vi.spyOn(os, 'freemem').mockReturnValue(32 * 1024 * 1024);
    const totalmemSpy = vi.spyOn(os, 'totalmem').mockReturnValue(6612 * 1024 * 1024);
    try {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);
      const ws = createMockWs();

      const svc = ComposeService.getInstance(1);
      const promise = svc.runCommand('my-stack', 'restart', ws);
      await waitForSpawn();
      const err = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
      proc.emit('error', err);

      await expect(promise).rejects.toThrow(/Out of memory while launching docker/);
      const sendCalls = ws.send.mock.calls.map(c => c[0] as string);
      expect(sendCalls.some(msg => msg.includes('reported as ENOENT under memory pressure'))).toBe(true);
    } finally {
      freememSpy.mockRestore();
      totalmemSpy.mockRestore();
    }
  });

  it('preserves "Docker CLI unavailable" wording on healthy-memory ENOENT for docker', async () => {
    const freememSpy = vi.spyOn(os, 'freemem').mockReturnValue(2 * 1024 * 1024 * 1024);
    const totalmemSpy = vi.spyOn(os, 'totalmem').mockReturnValue(6612 * 1024 * 1024);
    try {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const svc = ComposeService.getInstance(1);
      const promise = svc.runCommand('my-stack', 'restart');
      await waitForSpawn();
      const err = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
      proc.emit('error', err);

      await expect(promise).rejects.toThrow('Docker CLI unavailable on this node');
    } finally {
      freememSpy.mockRestore();
      totalmemSpy.mockRestore();
    }
  });
});

// ── authoredComposeArgs: mesh + user override ──────────────────────────

// ── gate invalidation: end before the compose up, never on a refusal ──────

/**
 * The two commit points every stack-scoped runtime change passes through, and
 * the one ordering invariant they share: the gates a change invalidates end
 * after the compose arguments and the registry auth for the compose up have
 * resolved, so a run refused at either costs no live gate, and before Compose
 * can replace a container, so no poll in the compose up's own seconds records
 * the replacement as a failed update.
 *
 * `commitResolution` is which resolution belongs to the compose up: a deploy
 * resolves it on its first, an update on its second because the pull in the
 * acquisition phase resolves first.
 */
const STACK_RUNTIME_WRITES = [
  {
    label: 'deployStack',
    reason: 'redeployed during the observation',
    commitResolution: 1,
    write: (svc: ComposeService) => svc.deployStack('my-stack', undefined, true),
  },
  {
    label: 'updateStack',
    reason: 'updated during the observation',
    commitResolution: 2,
    write: (svc: ComposeService) => svc.updateStack('my-stack', undefined, true),
  },
];

describe.each(STACK_RUNTIME_WRITES)('ComposeService - $label and the health gates', ({ reason, commitResolution, write }) => {
  it('ends the gates before Compose can replace a container', async () => {
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([]);

    const promise = write(ComposeService.getInstance(1));
    await vi.advanceTimersByTimeAsync(3100);
    await promise;

    expect(mockSupersedeForContainerOp).toHaveBeenCalledWith(1, 'my-stack', expect.stringContaining(reason));
    // The up is the first spawn for a deploy and the second for an update that
    // pulls first, so the gate end is pinned against that one.
    const upIndex = mockSpawn.mock.calls.findIndex(c => (c[1] as string[]).includes('up'));
    expect(upIndex).toBeGreaterThanOrEqual(0);
    expect(mockSupersedeForContainerOp.mock.invocationCallOrder[0])
      .toBeLessThan(mockSpawn.mock.invocationCallOrder[upIndex]);
  });

  it('ends no gate when the compose up\'s own arguments cannot be resolved', async () => {
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([]);
    // A mesh stack whose override cannot be generated fails argument resolution,
    // which happens long before any handoff, so the previous workload is
    // provably intact and a gate must keep observing. Failing only the
    // resolution that belongs to the up is what makes this an assertion about
    // the gate end: the earlier resolutions, which run under both placements,
    // succeed here.
    mockIsMeshStackEnabled.mockReturnValue(true);
    let resolutions = 0;
    mockEnsureStackOverride.mockImplementation(async () => {
      resolutions += 1;
      if (resolutions === commitResolution) throw new Error('mesh override generation failed');
      // A mesh stack refuses a null override, so the resolutions that are not
      // the subject of this test have to hand one back.
      return '/data/mesh/overrides/1/my-stack.override.yml';
    });

    await write(ComposeService.getInstance(1)).then(() => null, () => null);

    // The up never ran, so nothing was replaced, and no gate was ended. An
    // update that pulled first has legitimately spawned by now.
    expect(mockSpawn.mock.calls.some(c => (c[1] as string[]).includes('up'))).toBe(false);
    expect(mockSupersedeForContainerOp).not.toHaveBeenCalled();
  });

  it('ends no gate when the compose up\'s own registry auth cannot be resolved', async () => {
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([]);
    mockGetRegistries.mockReturnValue([{ url: 'https://registry.example.com' }]);
    // Same shape as above, for the credential resolution the up depends on.
    let resolutions = 0;
    mockResolveDockerConfig.mockImplementation(async () => {
      resolutions += 1;
      if (resolutions === commitResolution) throw new Error('docker config unavailable');
      return { config: { auths: {} }, warnings: [] };
    });

    await write(ComposeService.getInstance(1)).then(() => null, () => null);

    // The up never ran, so nothing was replaced, and no gate was ended. An
    // update that pulled first has legitimately spawned by now.
    expect(mockSpawn.mock.calls.some(c => (c[1] as string[]).includes('up'))).toBe(false);
    expect(mockSupersedeForContainerOp).not.toHaveBeenCalled();
  });
});

describe('ComposeService - authoredComposeArgs mesh override', () => {
  const MESH_OVERRIDE = '/app/data/mesh/overrides/1/my-stack.override.yml';

  it('preserves a user compose.override.yml between the base and the mesh override', async () => {
    // Single-file stack opted into mesh, with a hand-authored override on disk.
    mockEnsureStackOverride.mockResolvedValue(MESH_OVERRIDE);
    mockGetComposeFilename.mockResolvedValue('compose.yaml');
    mockGetOverrideFilename.mockResolvedValue('compose.override.yml');

    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const svc = ComposeService.getInstance(1);
    const promise = svc.runCommand('my-stack', 'restart');
    await waitForSpawn();
    proc.emit('close', 0);
    await promise;

    // The user override sits between the base and the mesh override as a bare basename
    // (resolved against the stack-dir cwd); only the mesh override is an absolute path.
    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      ['compose', '-f', 'compose.yaml', '-f', 'compose.override.yml', '-f', MESH_OVERRIDE, 'restart'],
      expect.objectContaining({ cwd: expect.stringContaining('my-stack') })
    );
  });

  it('emits base + mesh override only when no user override exists', async () => {
    mockEnsureStackOverride.mockResolvedValue(MESH_OVERRIDE);
    mockGetComposeFilename.mockResolvedValue('compose.yaml');
    mockGetOverrideFilename.mockResolvedValue(null);

    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const svc = ComposeService.getInstance(1);
    const promise = svc.runCommand('my-stack', 'restart');
    await waitForSpawn();
    proc.emit('close', 0);
    await promise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      ['compose', '-f', 'compose.yaml', '-f', MESH_OVERRIDE, 'restart'],
      expect.objectContaining({ cwd: expect.stringContaining('my-stack') })
    );
  });

  it('does not look up or emit a user override when mesh is disabled', async () => {
    // A user override on disk must not introduce -f flags for a non-mesh stack;
    // implicit compose discovery already resolves it when no -f is passed.
    mockEnsureStackOverride.mockResolvedValue(null);
    mockGetOverrideFilename.mockResolvedValue('compose.override.yml');

    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const svc = ComposeService.getInstance(1);
    const promise = svc.runCommand('my-stack', 'restart');
    await waitForSpawn();
    proc.emit('close', 0);
    await promise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      ['compose', 'restart'],
      expect.objectContaining({ cwd: expect.stringContaining('my-stack') })
    );
    // The override lookup is gated inside the mesh branch.
    expect(mockGetOverrideFilename).not.toHaveBeenCalled();
  });

  it('drops the user override and still deploys when the lookup throws', async () => {
    // A present override that cannot be resolved (e.g. EACCES) must not crash the
    // deploy: the mesh override still applies and the deploy proceeds without the
    // user override, with a warning logged.
    mockEnsureStackOverride.mockResolvedValue(MESH_OVERRIDE);
    mockGetComposeFilename.mockResolvedValue('compose.yaml');
    mockGetOverrideFilename.mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const svc = ComposeService.getInstance(1);
    const promise = svc.runCommand('my-stack', 'restart');
    await waitForSpawn();
    proc.emit('close', 0);
    await promise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      ['compose', '-f', 'compose.yaml', '-f', MESH_OVERRIDE, 'restart'],
      expect.objectContaining({ cwd: expect.stringContaining('my-stack') })
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('could not resolve user compose override'),
      expect.anything()
    );
    warnSpy.mockRestore();
  });

  it('aborts the deploy when the override lookup hits a containment-guard rejection', async () => {
    // A symlink-escape (or invalid-name) rejection from the override lookup is a hard
    // error: it must propagate and abort the deploy, never degrade to "no override".
    mockEnsureStackOverride.mockResolvedValue(MESH_OVERRIDE);
    mockGetComposeFilename.mockResolvedValue('compose.yaml');
    mockGetOverrideFilename.mockRejectedValue(Object.assign(new Error('symlink escape'), { code: 'SYMLINK_ESCAPE' }));

    const svc = ComposeService.getInstance(1);
    await expect(svc.runCommand('my-stack', 'restart')).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    // The error is thrown while building the args, before docker is ever spawned.
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('leak sanity: a default single-file stack still emits no -f flags', async () => {
    // Proves the override-setting tests above do not leak through the shared mocks.
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const svc = ComposeService.getInstance(1);
    const promise = svc.runCommand('my-stack', 'restart');
    await waitForSpawn();
    proc.emit('close', 0);
    await promise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      ['compose', 'restart'],
      expect.objectContaining({ cwd: expect.stringContaining('my-stack') })
    );
  });
});

// ── deployStack ────────────────────────────────────────────────────────


  it('fails closed when a mesh-enabled stack cannot generate its override', async () => {
    mockIsMeshStackEnabled.mockReturnValue(true);
    mockEnsureStackOverride.mockRejectedValue(new Error('mesh override write failed'));

    const svc = ComposeService.getInstance(1);
    await expect(svc.validateExactComposeInvocation('my-stack')).rejects.toThrow(/mesh override write failed/i);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

describe('ComposeService - deployStack', () => {
  it('blocks a pilot deploy with relative binds before replacing containers when path mapping differs', async () => {
    process.env.SENCHO_MODE = 'pilot';
    const composeDir = path.resolve('/test/compose');
    mockGetBindMounts.mockResolvedValue([
      { source: '/opt/docker/sencho', destination: composeDir },
    ]);
    const configProc = createMockProcess();
    mockSpawn.mockReturnValue(configProc);

    const svc = ComposeService.getInstance(1);
    const result = svc.deployStack('my-stack').then(() => null, (error: Error) => error);
    await waitForSpawn();
    configProc.stdout.emit('data', Buffer.from(JSON.stringify({
      name: 'my-stack',
      services: {
        db: {
          image: 'postgres:17',
          volumes: [{
            type: 'bind',
            source: path.join(composeDir, 'my-stack', 'data'),
            target: '/var/lib/postgresql/data',
          }],
        },
      },
    })));
    configProc.emit('close', 0);

    const error = await result;
    expect(error?.message).toContain('1:1');
    expect(mockGetLegacyOrphanContainersByStack).not.toHaveBeenCalled();
    expect(mockRemoveContainers).not.toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('allows a pilot deploy that uses only absolute external bind sources', async () => {
    process.env.SENCHO_MODE = 'pilot';
    const composeDir = path.resolve('/test/compose');
    mockGetBindMounts.mockResolvedValue([
      { source: '/opt/docker/sencho', destination: composeDir },
    ]);
    let spawnCount = 0;
    mockSpawn.mockImplementation(() => {
      spawnCount += 1;
      const proc = createMockProcess();
      Promise.resolve().then(() => {
        if (spawnCount === 1) {
          proc.stdout.emit('data', Buffer.from(JSON.stringify({
            name: 'my-stack',
            services: {
              db: {
                image: 'postgres:17',
                volumes: [{
                  type: 'bind',
                  source: '/srv/postgres/data',
                  target: '/var/lib/postgresql/data',
                }],
              },
            },
          })));
        }
        proc.emit('close', 0);
      });
      return proc;
    });
    mockListContainers.mockResolvedValue([]);

    const promise = ComposeService.getInstance(1).deployStack('my-stack');
    await vi.advanceTimersByTimeAsync(3100);

    await expect(promise).resolves.toEqual({ recoveryId: null, deployedGenerationId: null, gitopsOperationId: null });
    expect(mockGetLegacyOrphanContainersByStack).toHaveBeenCalledWith('my-stack');
  });

  // A Git deploy runs Compose out of a decrypt overlay, so the guard has to read
  // the overlay: the live project may fail outright (a typed value held in an
  // encrypted env file), and where it does render it describes a model the deploy
  // is not about to run, which Compose can resolve differently once the values in
  // front of a bind are decrypted. The mock below branches on the spawn's cwd, so
  // each render is answered with the model that belongs to it: the live project
  // clears the bind below, the overlay does not, and the refusal has to come from
  // the overlay. Without a cwd branch one render would answer for both, which is
  // the mistake this test exists to catch.
  function setupOverlayBindRenders(options: {
    overlayDir: string;
    overlayBindSource: string;
  }): () => number {
    const composeDir = path.resolve('/test/compose');
    // Reset explicitly: the file's beforeEach clears call records but not
    // implementations, so a guard left on by an earlier test would put an extra
    // Compose render in front of the assertions below.
    mockGetGlobalSettings.mockReturnValue({});
    mockGetBindMounts.mockResolvedValue([
      { source: '/srv/example-apps', destination: composeDir },
    ]);
    let spawnCount = 0;
    mockSpawn.mockImplementation((_command: string, _args: string[], opts: { cwd?: string }) => {
      spawnCount += 1;
      const proc = createMockProcess();
      const source = opts?.cwd === options.overlayDir
        ? options.overlayBindSource
        : '/srv/postgres/data';
      Promise.resolve().then(() => {
        proc.stdout.emit('data', Buffer.from(JSON.stringify({
          name: 'my-stack',
          services: {
            db: {
              image: 'postgres:17',
              volumes: [{
                type: 'bind',
                source,
                target: '/var/lib/postgresql/data',
              }],
            },
          },
        })));
        proc.emit('close', 0);
      });
      return proc;
    });
    return () => spawnCount;
  }

  it('refuses a mismapped pilot overlay deploy whose overlay resolves a relative bind', async () => {
    process.env.SENCHO_MODE = 'pilot';
    const overlayDir = path.join(gitSecretsAreaBase(), '1', 'my-stack', 'op-1');
    const spawnCount = setupOverlayBindRenders({
      overlayDir,
      overlayBindSource: path.join(overlayDir, 'data'),
    });

    const error = await ComposeService.getInstance(1)
      .deployStack('my-stack', undefined, false, { source: 'git_apply', overlayDir })
      .then(() => null, (e: Error) => e);

    expect(error, 'the deploy must refuse, not resolve, on a relative bind only the overlay shows').not.toBeNull();
    expect(error?.message).toContain('1:1');
    expect(error?.message).toContain(path.resolve('/test/compose'));
    expect(error?.message).toContain('/srv/example-apps');
    // The refusal came before anything was cleaned up, removed, or started.
    expect(mockGetLegacyOrphanContainersByStack).not.toHaveBeenCalled();
    expect(mockRemoveContainers).not.toHaveBeenCalled();
    // One render, no compose up: the containers were never replaced.
    expect(spawnCount()).toBe(1);
    expect(
      mockSpawn.mock.calls.some((call) => Array.isArray(call[1]) && (call[1] as string[]).includes('up')),
      'compose up must never run for a refused deploy',
    ).toBe(false);
  });

  it('allows a mismapped pilot overlay deploy whose binds are all absolute external sources', async () => {
    process.env.SENCHO_MODE = 'pilot';
    const overlayDir = path.join(gitSecretsAreaBase(), '1', 'my-stack', 'op-1');
    setupOverlayBindRenders({ overlayDir, overlayBindSource: '/srv/postgres/data' });
    mockListContainers.mockResolvedValue([]);

    const promise = ComposeService.getInstance(1)
      .deployStack('my-stack', undefined, false, { source: 'git_apply', overlayDir });
    await vi.advanceTimersByTimeAsync(3100);

    await expect(promise).resolves.toEqual({
      recoveryId: null,
      deployedGenerationId: null,
      gitopsOperationId: null,
    });
    expect(mockGetLegacyOrphanContainersByStack).toHaveBeenCalledWith('my-stack');
  });

  it('blocks a pilot service restore with relative binds before Compose up', async () => {
    process.env.SENCHO_MODE = 'pilot';
    const composeDir = path.resolve('/test/compose');
    mockGetBindMounts.mockResolvedValue([
      { source: '/opt/docker/sencho', destination: composeDir },
    ]);
    const configProc = createMockProcess();
    mockSpawn.mockReturnValue(configProc);

    const svc = ComposeService.getInstance(1);
    const result = svc.recreateServiceFromLocal('my-stack', 'db').then(() => null, (error: Error) => error);
    await waitForSpawn();
    configProc.stdout.emit('data', Buffer.from(JSON.stringify({
      name: 'my-stack',
      services: {
        db: {
          image: 'postgres:17',
          volumes: [{
            type: 'bind',
            source: path.join(composeDir, 'my-stack', 'data'),
            target: '/var/lib/postgresql/data',
          }],
        },
      },
    })));
    configProc.emit('close', 0);

    const error = await result;
    expect(error?.message).toContain('1:1');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('does not remove compose-managed containers before deploy (#1565)', async () => {
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([]);
    mockGetLegacyOrphanContainersByStack.mockResolvedValue([]);

    const svc = ComposeService.getInstance(1);
    const promise = svc.deployStack('my-stack');
    await vi.advanceTimersByTimeAsync(3100);
    await promise;

    expect(mockGetLegacyOrphanContainersByStack).toHaveBeenCalledWith('my-stack');
    expect(mockRemoveContainers).not.toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      ['compose', 'up', '-d', '--remove-orphans'],
      expect.any(Object),
    );
  });

  it('removes legacy orphan containers when compose ps is empty', async () => {
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([]);
    mockGetLegacyOrphanContainersByStack.mockResolvedValue([
      { Id: 'legacy-c1' },
      { Id: 'legacy-c2' },
    ]);

    const svc = ComposeService.getInstance(1);
    const promise = svc.deployStack('my-stack');
    await vi.advanceTimersByTimeAsync(3100);
    await promise;

    expect(mockRemoveContainers).toHaveBeenCalledWith(['legacy-c1', 'legacy-c2']);
    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      ['compose', 'up', '-d', '--remove-orphans'],
      expect.any(Object),
    );
  });

  it('runs docker compose up -d --remove-orphans', async () => {
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([]);

    const svc = ComposeService.getInstance(1);
    const promise = svc.deployStack('my-stack');

    // Advance past the 3s health probe timeout
    await vi.advanceTimersByTimeAsync(3100);
    await promise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      ['compose', 'up', '-d', '--remove-orphans'],
      expect.any(Object)
    );
  });

  it('captures recovery generation when atomic=true', async () => {
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([]);

    const svc = ComposeService.getInstance(1);
    const promise = svc.deployStack('my-stack', undefined, true);

    await vi.advanceTimersByTimeAsync(3100);
    const result = await promise;

    expect(result).toEqual({ recoveryId: 'recovery-1', deployedGenerationId: null, gitopsOperationId: null });
    expect(mockCaptureCandidate).toHaveBeenCalledWith(expect.objectContaining({
      stackName: 'my-stack',
      operationKind: 'deployment',
      createdBy: 'atomic-deploy',
    }));
    expect(mockHandoff).toHaveBeenCalled();
    expect(mockMarkImmediateVerified).toHaveBeenCalledWith('recovery-1');
  });

  it('retires the stack service-recovery snapshots on success, atomic or not', async () => {
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([]);

    const svc = ComposeService.getInstance(1);
    const atomic = svc.deployStack('my-stack', undefined, true);
    await vi.advanceTimersByTimeAsync(3100);
    await atomic;
    expect(mockInvalidateActiveServiceRecoveries).toHaveBeenCalledWith(1, 'my-stack');

    // A deploy without a rollback generation still replaced every service's
    // image, so the per-service snapshots are just as stale.
    mockInvalidateActiveServiceRecoveries.mockClear();
    const plain = svc.deployStack('my-stack');
    await vi.advanceTimersByTimeAsync(3100);
    await plain;
    expect(mockInvalidateActiveServiceRecoveries).toHaveBeenCalledWith(1, 'my-stack');
  });

  it('leaves the stack service-recovery snapshots alone when the deploy fails', async () => {
    setupAutoCloseSpawn();
    mockSpawn.mockImplementation(() => { const e = new Error('compose failed'); (e as unknown as { code?: number }).code = 1; throw e; });

    await expect(ComposeService.getInstance(1).deployStack('my-stack', undefined, true)).rejects.toThrow();
    expect(mockInvalidateActiveServiceRecoveries).not.toHaveBeenCalled();
  });

  it('still reports the deploy as successful when retiring stale recoveries fails', async () => {
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([]);
    mockInvalidateActiveServiceRecoveries.mockImplementationOnce(() => {
      throw new Error('recovery table is locked');
    });

    const svc = ComposeService.getInstance(1);
    const promise = svc.deployStack('my-stack', undefined, true);
    await vi.advanceTimersByTimeAsync(3100);

    // The deploy landed and its evidence is recorded; failing to retire an offer
    // must not turn that into a failed deploy.
    await expect(promise).resolves.toMatchObject({ recoveryId: 'recovery-1' });
  });

  it('ends health gate observations before a stop or down runs, and never for a start', async () => {
    setupAutoCloseSpawn();
    const svc = ComposeService.getInstance(1);

    // Ordering is the point: the gate must be ended before Compose can change a
    // container, or a poll landing in the stop window records the deliberate
    // stop as a failed update.
    await svc.runCommand('my-stack', 'stop');
    expect(mockSupersedeForContainerOp).toHaveBeenCalledWith(1, 'my-stack', expect.stringContaining('stopped'));
    expect(mockSupersedeForContainerOp.mock.invocationCallOrder[0])
      .toBeLessThan(mockSpawn.mock.invocationCallOrder[0]);

    mockSupersedeForContainerOp.mockClear();
    await svc.runDown('my-stack');
    expect(mockSupersedeForContainerOp).toHaveBeenCalledWith(1, 'my-stack', expect.stringContaining('taken down'));

    // A start does not disturb the containers a gate is observing.
    mockSupersedeForContainerOp.mockClear();
    await svc.runCommand('my-stack', 'start');
    expect(mockSupersedeForContainerOp).not.toHaveBeenCalled();
  });

  it('ends the gates a completed deploy or update invalidated', async () => {
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([]);

    const deploy = ComposeService.getInstance(1).deployStack('my-stack', undefined, true);
    await vi.advanceTimersByTimeAsync(3100);
    await deploy;
    // The callers that open a replacement gate supersede again a moment later;
    // this is what covers the ones that never do (fleet, labels, templates,
    // mesh, blueprint, scheduled deploy).
    expect(mockSupersedeForContainerOp).toHaveBeenCalledWith(1, 'my-stack', expect.stringContaining('redeployed'));
    // Still before Compose can replace a container, whichever route the
    // arguments took to get there.
    expect(mockSupersedeForContainerOp.mock.invocationCallOrder[0])
      .toBeLessThan(mockSpawn.mock.invocationCallOrder[0]);
  });

  it('blocks deploy before backup when missing external networks need a prompt', async () => {
    const { MissingExternalNetworksError } = await import('../services/network/missingExternalNetworksError');
    mockResolveMissingExternalNetworks.mockResolvedValue({
      status: 'ok',
      autoCreateEnabled: false,
      stackName: 'my-stack',
      networks: [{
        name: 'arr-net',
        keys: ['arr'],
        declarations: [{ key: 'arr', driverKind: 'bridge', unsupportedFeatures: [] }],
        safe: true,
        unsupportedFeatures: [],
        creationSpec: { driver: 'bridge', options: 'default' },
      }],
      declaredExternalCount: 1,
    });

    const svc = ComposeService.getInstance(1);
    await expect(svc.deployStack('my-stack', undefined, true)).rejects.toBeInstanceOf(MissingExternalNetworksError);
    expect(mockCaptureCandidate).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockAddNotificationHistory).not.toHaveBeenCalled();
  });

  it('surfaces the resolver\'s render diagnosis instead of a generic sentence', async () => {
    const { MissingExternalNetworksError } = await import('../services/network/missingExternalNetworksError');
    // What the resolver reports for a compose file Docker Compose refuses,
    // e.g. a malformed port spec. The operator has to be told what to fix.
    mockResolveMissingExternalNetworks.mockResolvedValue({
      status: 'render_unavailable',
      autoCreateEnabled: false,
      stackName: 'my-stack',
      networks: [],
      declaredExternalCount: 0,
      renderError: 'Sencho could not render the effective Compose model: invalid proto: udp/tcp. Check the compose and env files.',
    });

    const svc = ComposeService.getInstance(1);
    const thrown = await svc.deployStack('my-stack', undefined, true).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(MissingExternalNetworksError);
    expect((thrown as Error).message).toContain('invalid proto: udp/tcp');
    expect((thrown as Error).message).not.toContain('could not render this stack');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('falls back to the generic render sentence when the resolver gives none', async () => {
    const { MissingExternalNetworksError } = await import('../services/network/missingExternalNetworksError');
    mockResolveMissingExternalNetworks.mockResolvedValue({
      status: 'render_unavailable',
      autoCreateEnabled: false,
      stackName: 'my-stack',
      networks: [],
      declaredExternalCount: 0,
    });

    const svc = ComposeService.getInstance(1);
    const thrown = await svc.deployStack('my-stack', undefined, true).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(MissingExternalNetworksError);
    expect((thrown as Error).message).toBe(
      'Sencho could not render this stack\'s Compose model to check external networks.',
    );
  });

  it('auto-creates safe missing networks and records history-only activity', async () => {
    const missing = [{
      name: 'arr-net',
      keys: ['arr'],
      declarations: [{ key: 'arr', driverKind: 'bridge' as const, unsupportedFeatures: [] as const }],
      safe: true,
      unsupportedFeatures: [] as const,
      creationSpec: { driver: 'bridge' as const, options: 'default' as const },
    }];
    mockResolveMissingExternalNetworks
      .mockResolvedValueOnce({
        status: 'ok',
        autoCreateEnabled: true,
        stackName: 'my-stack',
        networks: missing,
        declaredExternalCount: 1,
      })
      .mockResolvedValueOnce({
        status: 'ok',
        autoCreateEnabled: true,
        stackName: 'my-stack',
        networks: [],
        declaredExternalCount: 1,
      });
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([]);

    const svc = ComposeService.getInstance(1);
    const promise = svc.deployStack(
      'my-stack',
      undefined,
      true,
      { source: 'scheduler', actor: 'system:scheduler' },
    );
    await vi.advanceTimersByTimeAsync(3100);
    await promise;

    expect(mockCreateNetwork).toHaveBeenCalledWith({ Name: 'arr-net', Driver: 'bridge' });
    expect(mockAddNotificationHistory).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        category: 'network_auto_created',
        level: 'info',
        actor_username: 'system:scheduler',
        stack_name: 'my-stack',
      }),
    );
    expect(mockCaptureCandidate).toHaveBeenCalled();
  });

  it('does not wrap a missing-external prompt in ComposeRollbackError when atomic', async () => {
    mockResolveMissingExternalNetworks.mockResolvedValue({
      status: 'ok',
      autoCreateEnabled: false,
      stackName: 'my-stack',
      networks: [{
        name: 'arr-net',
        keys: ['arr'],
        declarations: [{ key: 'arr', driverKind: 'bridge', unsupportedFeatures: [] }],
        safe: true,
        unsupportedFeatures: [],
        creationSpec: { driver: 'bridge', options: 'default' },
      }],
      declaredExternalCount: 1,
    });

    const svc = ComposeService.getInstance(1);
    const error = await svc.deployStack('my-stack', undefined, true).then(() => null, (e: Error) => e);
    expect(getComposeRollbackInfo(error)).toBeNull();
    expect(error?.name).toBe('MissingExternalNetworksError');
  });

  it('aborts atomic deploy before docker side effects when capture fails', async () => {
    mockCaptureCandidate.mockRejectedValueOnce(new Error('disk full'));

    const svc = ComposeService.getInstance(1);

    await expect(svc.deployStack('my-stack', undefined, true)).rejects.toThrow('disk full');
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockGetLegacyOrphanContainersByStack).not.toHaveBeenCalled();
  });

  it('throws sanitized CONTAINER_CRASHED when exited container has non-zero exit code', async () => {
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([{
      Id: 'crashed-c1',
      State: 'exited',
      Labels: { 'com.docker.compose.project': 'my-stack' },
    }]);
    mockContainerInspect.mockResolvedValue({ State: { ExitCode: 1 } });
    mockContainerLogs.mockResolvedValue(Buffer.from('SECRET_TOKEN=leaked'));

    const svc = ComposeService.getInstance(1);
    // Attach catch handler immediately so rejection is never "unhandled"
    const result = svc.deployStack('my-stack').then(() => null, (e: Error) => e);

    await vi.runAllTimersAsync();
    const error = await result;
    expect(error).not.toBeNull();
    expect(error!.message).toContain('CONTAINER_CRASHED');
    expect(error!.message).not.toContain('SECRET_TOKEN');
    expect(mockContainerLogs).not.toHaveBeenCalled();
  });

  it('rolls back on failure when atomic=true', async () => {
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([{
      Id: 'crashed-c1',
      State: 'exited',
      Labels: { 'com.docker.compose.project': 'my-stack' },
    }]);
    mockContainerInspect.mockResolvedValue({ State: { ExitCode: 1 } });
    mockContainerLogs.mockResolvedValue(Buffer.from('Error'));

    const svc = ComposeService.getInstance(1);
    const result = svc.deployStack('my-stack', undefined, true).then(() => null, (e: Error) => e);

    await vi.runAllTimersAsync();
    const error = await result;
    expect(error).not.toBeNull();
    expect(error!.message).toContain('CONTAINER_CRASHED');
    expect(getComposeRollbackInfo(error)).toEqual({ attempted: true, rolledBack: true });
    expect(mockCompensateWithCandidate).toHaveBeenCalledWith('recovery-1', expect.any(Function));
  });

  it('reports rollback failure when atomic restore fails', async () => {
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([{
      Id: 'crashed-c1',
      State: 'exited',
      Labels: { 'com.docker.compose.project': 'my-stack' },
    }]);
    mockContainerInspect.mockResolvedValue({ State: { ExitCode: 1 } });
    mockCompensateWithCandidate.mockResolvedValueOnce(false);

    const svc = ComposeService.getInstance(1);
    const result = svc.deployStack('my-stack', undefined, true).then(() => null, (e: Error) => e);

    await vi.runAllTimersAsync();
    const error = await result;
    expect(error).not.toBeNull();
    expect(getComposeRollbackInfo(error)).toEqual({ attempted: true, rolledBack: false });
  });

  it('wraps a missing hold tag as rolledBack=false without replacing the original error', async () => {
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([{
      Id: 'crashed-c1',
      State: 'exited',
      Labels: { 'com.docker.compose.project': 'my-stack' },
    }]);
    mockContainerInspect.mockResolvedValue({ State: { ExitCode: 1 } });
    mockCompensateWithCandidate.mockRejectedValueOnce(
      Object.assign(new Error('Held recovery image is missing'), { code: 'HELD_IMAGE_MISSING' }),
    );

    const svc = ComposeService.getInstance(1);
    const result = svc.deployStack('my-stack', undefined, true).then(() => null, (e: Error) => e);

    await vi.runAllTimersAsync();
    const error = await result;
    expect(error).not.toBeNull();
    expect(error!.message).toContain('CONTAINER_CRASHED');
    expect(getComposeRollbackInfo(error)).toEqual({ attempted: true, rolledBack: false });
  });

  it('does not roll back when atomic=false', async () => {
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([{
      Id: 'crashed-c1',
      State: 'exited',
    }]);
    mockContainerInspect.mockResolvedValue({ State: { ExitCode: 1 } });
    mockContainerLogs.mockResolvedValue(Buffer.from('Error'));

    const svc = ComposeService.getInstance(1);
    const result = svc.deployStack('my-stack', undefined, false).then(() => null, (e: Error) => e);

    await vi.runAllTimersAsync();
    const error = await result;
    expect(error).not.toBeNull();
    expect(error!.message).toContain('CONTAINER_CRASHED');
    expect(mockRestoreStackFiles).not.toHaveBeenCalled();
  });

  // The Git dispatch settlement correlates a failed deploy to its GitOps
  // operation by reading the id ComposeService stamps on the error before
  // rethrowing. These tests spy the private tracking opener directly (the
  // suite's mocked DatabaseService never yields a live application for the
  // real store), so what they pin is the stamping contract on both rethrow
  // arms, not the store lookups behind it. GitOpsDeployHandle is imported
  // from the production module, so the spy cannot drift from its shape.
  function mockTrackedDeploy(handle: GitOpsDeployHandle | null) {
    return vi.spyOn(
      ComposeService.prototype as unknown as {
        beginGitOpsDeploy: (stackName: string) => GitOpsDeployHandle | null;
      },
      'beginGitOpsDeploy',
    ).mockReturnValue(handle);
  }
  const trackedHandle = (): GitOpsDeployHandle => ({
    generationId: 'gen-1',
    gitopsOperationId: 'deploy-op-tracked',
    bound: vi.fn(),
    failed: vi.fn(),
  });

  it('stamps the GitOps deploy operation id on a failed plain deploy error', async () => {
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([{ Id: 'crashed-c1', State: 'exited' }]);
    mockContainerInspect.mockResolvedValue({ State: { ExitCode: 1 } });
    mockContainerLogs.mockResolvedValue(Buffer.from('Error'));
    const spy = mockTrackedDeploy(trackedHandle());

    try {
      const svc = ComposeService.getInstance(1);
      const result = svc.deployStack('my-stack').then(() => null, (e: Error) => e);

      await vi.runAllTimersAsync();
      const error = await result;
      expect((error as Error & { gitopsDeployOperationId?: string }).gitopsDeployOperationId)
        .toBe('deploy-op-tracked');
    } finally {
      spy.mockRestore();
    }
  });

  it('stamps the GitOps deploy operation id on the atomic rollback wrapper', async () => {
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([{
      Id: 'crashed-c1',
      State: 'exited',
      Labels: { 'com.docker.compose.project': 'my-stack' },
    }]);
    mockContainerInspect.mockResolvedValue({ State: { ExitCode: 1 } });
    mockContainerLogs.mockResolvedValue(Buffer.from('Error'));
    const spy = mockTrackedDeploy(trackedHandle());

    try {
      const svc = ComposeService.getInstance(1);
      const result = svc.deployStack('my-stack', undefined, true).then(() => null, (e: Error) => e);

      await vi.runAllTimersAsync();
      const error = await result;
      expect(getComposeRollbackInfo(error)).toEqual({ attempted: true, rolledBack: true });
      // The caller catches the wrapper, not the inner error, so the id must be
      // mirrored onto the wrapper itself.
      expect((error as Error & { gitopsDeployOperationId?: string }).gitopsDeployOperationId)
        .toBe('deploy-op-tracked');
    } finally {
      spy.mockRestore();
    }
  });

  it('stamps the GitOps deploy operation id on a failed update error', async () => {
    // updateStack opens its GitOps deploy handle immediately before the
    // recreate, so the same crashed-container probe its post-mutation path
    // reaches must carry the id too: the stamp is mirrored on this seam so
    // any caller correlating a failed deploy reads it off the thrown error
    // whichever mutation method ran.
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([{ Id: 'crashed-c1', State: 'exited' }]);
    mockContainerInspect.mockResolvedValue({ State: { ExitCode: 1 } });
    mockContainerLogs.mockResolvedValue(Buffer.from('Error'));
    const spy = mockTrackedDeploy(trackedHandle());

    try {
      const svc = ComposeService.getInstance(1);
      const result = svc.updateStack('my-stack').then(() => null, (e: Error) => e);

      await vi.runAllTimersAsync();
      const error = await result;
      expect((error as Error).message).toContain('CONTAINER_CRASHED');
      expect((error as Error & { gitopsDeployOperationId?: string }).gitopsDeployOperationId)
        .toBe('deploy-op-tracked');
    } finally {
      spy.mockRestore();
    }
  });

  // A deploy against a GitOps decrypt overlay runs Compose over decrypted
  // secret files, and Compose echoes interpolated values back in its
  // diagnostics (`unable to get image 'audit-...?': invalid reference
  // format`). Nothing about that text is recognisable as a secret, so the
  // whole subprocess output is withheld for the life of the operation rather
  // than filtered. The control below pins the other side of the same
  // boundary: a deploy without an overlay still reports Compose's words.
  const leakingDiagnostic = 'unable to get image \'audit-decrypted-value-marker:?\': invalid reference format';

  async function runFailingDeploy(
    ctx?: { source: 'git_apply'; overlayDir: string },
  ): Promise<{ error: Error | null; streamed: string }> {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    mockGetGlobalSettings.mockReturnValue({});
    mockGetLegacyOrphanContainersByStack.mockResolvedValue([]);
    const ws = createMockWs();

    const result = ComposeService.getInstance(1)
      .deployStack('my-stack', ws, false, ctx)
      .then(() => null, (e: Error) => e);

    await waitForSpawn();
    proc.stderr.emit('data', Buffer.from(`${leakingDiagnostic}\n`));
    proc.emit('close', 1);

    const error = await result;
    const streamed = ws.send.mock.calls.map((call) => String(call[0])).join('');
    return { error, streamed };
  }

  it('withholds Compose output when the deploy runs against a decrypt overlay', async () => {
    const { error, streamed } = await runFailingDeploy({
      source: 'git_apply',
      overlayDir: '/tmp/git-secrets/1/my-stack/op-1',
    });
    expect(error?.message).toBe(WITHHELD_DECRYPTED_COMPOSE_OUTPUT);
    expect(streamed).not.toContain('audit-decrypted-value-marker');
    // Sencho's own framing still reaches the operator: it names no secret.
    expect(streamed).toContain('Command exited with code 1');
  });

  it('still surfaces the Compose diagnostic when no decrypt overlay is in play', async () => {
    const { error, streamed } = await runFailingDeploy();
    expect(error?.message).toContain(leakingDiagnostic);
    expect(streamed).toContain(leakingDiagnostic);
  });

  // The external-network gate renders the Compose model before `up`. On a Git
  // deploy the model the deploy will use is the decrypt overlay's, so the gate
  // has to read that one: a live render resolves typed values (a published
  // port, an external network name) out of ciphertext and refuses a deploy
  // whose own model already validated.
  it('gates external networks on the overlay the deploy runs Compose in', async () => {
    setupAutoCloseSpawn(0);
    mockListContainers.mockResolvedValue([]);
    const overlayDir = path.join(gitSecretsAreaBase(), '1', 'my-stack', 'op-1');

    await ComposeService.getInstance(1).deployStack('my-stack', undefined, false, {
      source: 'git_apply',
      overlayDir,
    });

    expect(mockResolveMissingExternalNetworks).toHaveBeenCalledWith(1, 'my-stack', {
      stackDirOverride: overlayDir,
    });
  });

  it('surfaces the withheld render text, not Compose words, when the gate cannot read the model', async () => {
    mockListContainers.mockResolvedValue([]);
    mockResolveMissingExternalNetworks.mockResolvedValue({
      status: 'render_unavailable',
      autoCreateEnabled: false,
      stackName: 'my-stack',
      networks: [],
      declaredExternalCount: 0,
      renderError: WITHHELD_DECRYPTED_RENDER_OUTPUT,
    });

    const error = await ComposeService.getInstance(1)
      .deployStack('my-stack', undefined, false, {
        source: 'git_apply',
        overlayDir: path.join(gitSecretsAreaBase(), '1', 'my-stack', 'op-1'),
      })
      .then(() => null, (e: Error) => e);

    expect(error?.message).toBe(WITHHELD_DECRYPTED_RENDER_OUTPUT);
    expect(error?.message).not.toContain('audit-decrypted-value-marker');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('gates external networks on the live project when no overlay is in play', async () => {
    setupAutoCloseSpawn(0);
    mockListContainers.mockResolvedValue([]);

    await ComposeService.getInstance(1).deployStack('my-stack');

    expect(mockResolveMissingExternalNetworks).toHaveBeenCalledWith(1, 'my-stack', {
      stackDirOverride: undefined,
    });
  });

  // The required-variable guard spawns its own `config --quiet` instead of going
  // through execute, so the overlay-substitution boundary does not come for
  // free: that render reads plaintext secrets, and a `:?` message is itself
  // interpolated, so Compose prints a decrypted value inside the very phrase the
  // name-only parser keys on. The guard must refuse on the exit code alone.
  const nestedGuardDiagnostic =
    'required variable MISSING is missing a value: required variable audit-decrypted-value-marker is missing\n';

  async function runOverlayGuardDeploy(): Promise<Error> {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    mockGetGlobalSettings.mockReturnValue({ env_block_deploy_on_missing_required: '1' });

    const result = ComposeService.getInstance(1)
      .deployStack('my-stack', undefined, false, {
        source: 'git_apply',
        overlayDir: path.join(gitSecretsAreaBase(), '1', 'my-stack', 'op-1'),
      })
      .then(() => null, (e: Error) => e);

    await waitForSpawn();
    proc.stderr.emit('data', Buffer.from(nestedGuardDiagnostic));
    proc.emit('close', 1);

    try {
      const error = await result;
      expect(error).not.toBeNull();
      return error as Error;
    } finally {
      // The file's beforeEach clears call records but not implementations, so a
      // guard left on here would put an extra config render in front of every
      // later test.
      mockGetGlobalSettings.mockReturnValue({});
    }
  }

  it('refuses an overlay deploy whose variable check failed, without naming a variable', async () => {
    const error = await runOverlayGuardDeploy();

    expect(error.message).toBe(`Deploy blocked: ${WITHHELD_DECRYPTED_REQUIRED_ENV_OUTPUT}then deploy again.`);
    expect(error.message).not.toContain('audit-decrypted-value-marker');
    expect(error.message).not.toContain('MISSING');
    // The refusal came before anything was pulled, created, or started.
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockResolveMissingExternalNetworks).not.toHaveBeenCalled();
    // The check is handed no stream to read at all, so the diagnostic could not
    // be collected even by a later change: this is not a promise about the code
    // that runs today, it is the shape of the spawn.
    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['config', '--quiet']),
      expect.objectContaining({ stdio: 'ignore' }),
    );
  });

  it('lets an overlay deploy through when its variable check resolved', async () => {
    mockListContainers.mockResolvedValue([]);
    setupAutoCloseSpawn(0);
    mockGetGlobalSettings.mockReturnValue({ env_block_deploy_on_missing_required: '1' });
    const overlayDir = path.join(gitSecretsAreaBase(), '1', 'my-stack', 'op-1');

    try {
      await ComposeService.getInstance(1).deployStack('my-stack', undefined, false, {
        source: 'git_apply',
        overlayDir,
      });

      // Reaching the network gate is proof the guard let the deploy past: a
      // failing check would have refused it first.
      expect(mockResolveMissingExternalNetworks).toHaveBeenCalledWith(1, 'my-stack', {
        stackDirOverride: overlayDir,
      });
    } finally {
      mockGetGlobalSettings.mockReturnValue({});
    }
  });

  it('refuses rather than waits on an overlay variable check that never returns', async () => {
    // The check reads nothing but an exit code, so an unbounded one would hold
    // the deploy open with no diagnostic to explain the wait. A killed child
    // closes with no code, which the guard treats as a refusal.
    const proc = createMockProcess();
    proc.kill = vi.fn(() => {
      proc.emit('close', null);
      return true;
    });
    mockSpawn.mockReturnValue(proc);
    mockGetGlobalSettings.mockReturnValue({ env_block_deploy_on_missing_required: '1' });

    try {
      const result = ComposeService.getInstance(1)
        .deployStack('my-stack', undefined, false, {
          source: 'git_apply',
          overlayDir: path.join(gitSecretsAreaBase(), '1', 'my-stack', 'op-1'),
        })
        .then(() => null, (e: Error) => e);

      await waitForSpawn();
      await vi.advanceTimersByTimeAsync(20_000);
      const error = await result;

      expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
      expect(error?.message).toBe(
        `Deploy blocked: ${WITHHELD_DECRYPTED_REQUIRED_ENV_OUTPUT}then deploy again.`,
      );
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    } finally {
      mockGetGlobalSettings.mockReturnValue({});
    }
  });
});

// ── renderConfig: the decrypt-overlay preflight render ────────────────

describe('ComposeService - renderConfig over a decrypt overlay', () => {
  const overlayDir = path.join(gitSecretsAreaBase(), '1', 'my-stack', 'op-1');

  it('renders from the overlay working directory', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = ComposeService.getInstance(1).renderConfig('my-stack', { stackDirOverride: overlayDir });
    await waitForSpawn();
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ name: 'my-stack', services: {}, networks: {} })));
    proc.emit('close', 0);
    const result = await promise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['compose', 'config', '--format', 'json']),
      expect.objectContaining({ cwd: overlayDir }),
    );
    expect(result.rendered).toContain('my-stack');
  });

  it('pins the stack project name on the overlay render, the way the deploy does', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = ComposeService.getInstance(1).renderConfig('my-stack', { stackDirOverride: overlayDir });
    await waitForSpawn();
    proc.emit('close', 0);
    await promise;

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args.slice(0, 3)).toEqual(['compose', '-p', 'my-stack']);
  });

  it('leaves the live render without a project-name pin', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = ComposeService.getInstance(1).renderConfig('my-stack');
    await waitForSpawn();
    proc.emit('close', 0);
    await promise;

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).not.toContain('-p');
  });

  it('withholds Compose stderr from the decrypted render while keeping the model', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = ComposeService.getInstance(1).renderConfig('my-stack', { stackDirOverride: overlayDir });
    await waitForSpawn();
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ name: 'my-stack', services: {}, networks: {} })));
    proc.stderr.emit('data', Buffer.from('invalid IP address: audit-decrypted-value-marker'));
    proc.emit('close', 0);
    const result = await promise;

    expect(result.rendered).toContain('my-stack');
    expect(result.stderr).toBe('');
    expect(result.withheld).toBe(true);
    expect(JSON.stringify(result)).not.toContain('audit-decrypted-value-marker');
  });

  it('withholds a failed decrypted render, which is the failure a typed ciphertext value produces', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = ComposeService.getInstance(1).renderConfig('my-stack', { stackDirOverride: overlayDir });
    await waitForSpawn();
    proc.stderr.emit('data', Buffer.from('invalid IP address: audit-decrypted-value-marker'));
    proc.emit('close', 1);
    const result = await promise;

    expect(result.rendered).toBeNull();
    expect(result.stderr).toBe('');
    expect(result.withheld).toBe(true);
    expect(JSON.stringify(result)).not.toContain('audit-decrypted-value-marker');
  });

  it('reports no model for a decrypted render that exceeded the size limit', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = ComposeService.getInstance(1).renderConfig('my-stack', { stackDirOverride: overlayDir });
    await waitForSpawn();
    // Past the 5 MiB cap renderConfig enforces, with a decrypted value in it.
    proc.stdout.emit('data', Buffer.from(`"AUDIT_TOKEN":"audit-decrypted-value-marker${'x'.repeat(5 * 1024 * 1024)}"`));
    proc.emit('close', 0);
    const result = await promise;

    expect(result.rendered).toBeNull();
    expect(result.stderr).toBe('');
    expect(result.withheld).toBe(true);
    expect(JSON.stringify(result)).not.toContain('audit-decrypted-value-marker');
  });

  it('refuses a working directory outside the git-secrets area, before any spawn', async () => {
    mockSpawn.mockClear();

    await expect(
      ComposeService.getInstance(1).renderConfig('my-stack', { stackDirOverride: '/etc' }),
    ).rejects.toThrow('Invalid stack path');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('keeps reporting Compose stderr for a live render', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = ComposeService.getInstance(1).renderConfig('my-stack');
    await waitForSpawn();
    proc.stderr.emit('data', Buffer.from('invalid proto: udp/tcp'));
    proc.emit('close', 1);
    const result = await promise;

    expect(result.stderr).toBe('invalid proto: udp/tcp');
    expect(result.withheld).toBeUndefined();
  });
});

// ── updateStack: build-aware ───────────────────────────────────────────

describe('ComposeService - updateStack build-aware', () => {
  it('runs build --pull, pull --ignore-buildable, and up when build services exist', async () => {
    mockLoadStackBuildServices.mockResolvedValueOnce(['app']);
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([]);

    const svc = ComposeService.getInstance(1);
    const promise = svc.updateStack('my-stack');
    await vi.advanceTimersByTimeAsync(3100);
    await promise;

    const spawnArgs = mockSpawn.mock.calls.map(c => c[1] as string[]);
    expect(spawnArgs.some(args => args.includes('build') && args.includes('--pull'))).toBe(true);
    expect(spawnArgs.some(args => args.includes('pull') && args.includes('--ignore-buildable'))).toBe(true);
    expect(spawnArgs.some(args => args.includes('up') && args.includes('-d'))).toBe(true);
  });

  it('runs plain pull + up when no build services exist', async () => {
    mockLoadStackBuildServices.mockResolvedValueOnce([]);
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([]);

    const svc = ComposeService.getInstance(1);
    const promise = svc.updateStack('my-stack');
    await vi.advanceTimersByTimeAsync(3100);
    await promise;

    const spawnArgs = mockSpawn.mock.calls.map(c => c[1] as string[]);
    expect(spawnArgs.some(args => args.includes('build'))).toBe(false);
    expect(spawnArgs.some(args => args.includes('pull') && !args.includes('--ignore-buildable'))).toBe(true);
  });

  it('abandons recovery and leaves runtime untouched when acquire fails before handoff', async () => {
    mockLoadStackBuildServices.mockResolvedValueOnce(['app']);
    let spawnCount = 0;
    mockSpawn.mockImplementation(() => {
      spawnCount += 1;
      const proc = createMockProcess();
      Promise.resolve().then(() => proc.emit('close', spawnCount === 1 ? 1 : 0));
      return proc;
    });
    mockListContainers.mockResolvedValue([]);

    const svc = ComposeService.getInstance(1);
    const result = svc.updateStack('my-stack', undefined, true).then(() => null, (e: Error) => e);
    await vi.advanceTimersByTimeAsync(3100);
    const error = await result;

    expect(error).not.toBeNull();
    expect(mockAbandon).toHaveBeenCalledWith('recovery-1');
    expect(mockHandoff).not.toHaveBeenCalled();
    expect(mockRemoveContainers).not.toHaveBeenCalled();
    expect(mockCompensateWithCandidate).not.toHaveBeenCalled();
    const spawnArgs = mockSpawn.mock.calls.map(c => c[1] as string[]);
    expect(spawnArgs.some(args => args.includes('up'))).toBe(false);
  });
});

// ── pullStackImages: acquire images, reconcile nothing ─────────────────

describe('ComposeService - pullStackImages', () => {
  it('pulls with --ignore-buildable and never builds when build services exist', async () => {
    mockGetRegistries.mockReturnValue([]);
    mockLoadStackBuildServices.mockResolvedValueOnce(['app']);
    setupAutoCloseSpawn();

    const svc = ComposeService.getInstance(1);
    const promise = svc.pullStackImages('my-stack');
    await vi.advanceTimersByTimeAsync(3100);
    const result = await promise;

    expect(result).toEqual({ skippedBuildBacked: ['app'] });
    const spawnArgs = mockSpawn.mock.calls.map(c => c[1] as string[]);
    expect(spawnArgs).toHaveLength(1);
    expect(spawnArgs[0]).toContain('pull');
    expect(spawnArgs[0]).toContain('--ignore-buildable');
    expect(spawnArgs[0]).not.toContain('build');
    expect(spawnArgs[0]).not.toContain('up');
    // A successful pull opens no recovery generation either: the same four
    // recovery entry points the failure case asserts stay cold on this path.
    expect(mockCaptureCandidate).not.toHaveBeenCalled();
    expect(mockMarkAcquired).not.toHaveBeenCalled();
    expect(mockHandoff).not.toHaveBeenCalled();
    expect(mockAbandon).not.toHaveBeenCalled();
  });

  it('always passes --ignore-buildable, even when the skip list is empty', async () => {
    // The safety promise is "skip, never build", and it must not depend on
    // loadStackBuildServices having seen every build: declaration. A build:
    // that only compose.override.yaml declares is invisible to that scan, so
    // the flag is unconditional and the list is only the report.
    mockGetRegistries.mockReturnValue([]);
    mockLoadStackBuildServices.mockResolvedValueOnce([]);
    setupAutoCloseSpawn();

    const svc = ComposeService.getInstance(1);
    const promise = svc.pullStackImages('my-stack');
    await vi.advanceTimersByTimeAsync(3100);
    const result = await promise;

    expect(result).toEqual({ skippedBuildBacked: [] });
    const spawnArgs = mockSpawn.mock.calls.map(c => c[1] as string[]);
    expect(spawnArgs).toHaveLength(1);
    expect(spawnArgs[0]).toContain('pull');
    expect(spawnArgs[0]).toContain('--ignore-buildable');
    expect(spawnArgs[0]).not.toContain('build');
  });

  it('refuses the pull when a required env var is missing, without running it', async () => {
    // A pull resolves the same project a deploy would, so the operator gets the
    // same operator-facing missing-variable message rather than a raw compose
    // failure, and the pull itself never starts.
    mockGetRegistries.mockReturnValue([]);
    mockGetGlobalSettings.mockReturnValue({ env_block_deploy_on_missing_required: '1' });
    mockSpawn.mockImplementation(() => {
      const proc = createMockProcess();
      Promise.resolve().then(() => {
        proc.stderr.emit('data', Buffer.from('required variable "API_KEY" is missing'));
        proc.emit('close', 1);
      });
      return proc;
    });

    const svc = ComposeService.getInstance(1);
    // No "Deploy blocked:" prefix: the editor wraps this in its own
    // "Image pull failed:" prefix, and the remedy names the chosen action rather
    // than telling the operator to deploy, which is a different action.
    await expect(svc.pullStackImages('my-stack')).rejects.toThrow(
      'required environment variable API_KEY is missing. Define it in a .env or env_file, then run Save & Pull Images again.',
    );

    // Only the config render ran; nothing reached the pull.
    const spawnArgs = mockSpawn.mock.calls.map(c => c[1] as string[]);
    expect(spawnArgs.some(args => args.includes('config'))).toBe(true);
    expect(spawnArgs.some(args => args.includes('pull'))).toBe(false);
  });

  it('keeps the published deploy wording byte-identical on the default path', async () => {
    // This exact sentence is quoted verbatim in a published tutorial and burned
    // into two committed screenshots, so the deploy refusal is frozen copy. The
    // pull path passes its own wording and must not be able to shift this.
    mockGetGlobalSettings.mockReturnValue({ env_block_deploy_on_missing_required: '1' });
    mockSpawn.mockImplementation(() => {
      const proc = createMockProcess();
      Promise.resolve().then(() => {
        proc.stderr.emit('data', Buffer.from('required variable "DB_PASSWORD" is missing'));
        proc.emit('close', 1);
      });
      return proc;
    });

    const svc = ComposeService.getInstance(1);
    await expect(svc.validateStackForMutation('my-stack')).rejects.toThrow(
      'Deploy blocked: required environment variable DB_PASSWORD is missing. ' +
        'Define it in a .env or env_file, then deploy again.',
    );
  });

  it('still pulls when the required-env guard is switched off', async () => {
    // The guard is opt-in by setting, so the default path must be unaffected.
    mockGetRegistries.mockReturnValue([]);
    mockGetGlobalSettings.mockReturnValue({ env_block_deploy_on_missing_required: '0' });
    mockLoadStackBuildServices.mockResolvedValueOnce([]);
    setupAutoCloseSpawn();

    const svc = ComposeService.getInstance(1);
    const promise = svc.pullStackImages('my-stack');
    await vi.advanceTimersByTimeAsync(3100);
    await promise;

    const spawnArgs = mockSpawn.mock.calls.map(c => c[1] as string[]);
    expect(spawnArgs.some(args => args.includes('pull'))).toBe(true);
  });

  it('runs the pull under the registry-auth temp config when registries exist', async () => {
    mockGetRegistries.mockReturnValue([{ url: 'https://registry.example.com' }]);
    mockResolveDockerConfig.mockResolvedValue({
      config: { auths: { 'registry.example.com': { auth: 'dGVzdA==' } } },
      warnings: [],
    });
    mockGetGlobalSettings.mockReturnValue({ delivery_source_id: 'test-delivery-source' });
    setupAutoCloseSpawn();

    const svc = ComposeService.getInstance(1);
    const promise = svc.pullStackImages('my-stack');
    await vi.advanceTimersByTimeAsync(3100);
    await promise;

    const spawnOptions = mockSpawn.mock.calls[0][2] as { env?: Record<string, string> };
    expect(spawnOptions.env?.DOCKER_CONFIG).toBe('/tmp/sencho-docker-test');
    expect(mockCleanupDockerAuthTempDir).toHaveBeenCalled();
  });

  it('names the skipped build-backed services on the terminal stream', async () => {
    mockGetRegistries.mockReturnValue([]);
    mockLoadStackBuildServices.mockResolvedValueOnce(['app', 'worker']);
    setupAutoCloseSpawn();
    const ws = createMockWs();

    const svc = ComposeService.getInstance(1);
    const promise = svc.pullStackImages('my-stack', ws);
    await vi.advanceTimersByTimeAsync(3100);
    await promise;

    const sendCalls = ws.send.mock.calls.map(c => c[0] as string);
    expect(
      sendCalls.some(msg => msg.includes('Skipping build-backed services') && msg.includes('app, worker')),
    ).toBe(true);
  });

  // The recovery generation is opened by deploy/update, and a pull must not open
  // one even when the compose call fails. These assertions pin that on the pull's
  // own paths; they are a regression tripwire, not a proof of the call graph.
  it('touches no recovery state when the pull fails', async () => {
    mockGetRegistries.mockReturnValue([]);
    mockLoadStackBuildServices.mockResolvedValueOnce(['app']);
    mockSpawn.mockImplementation(() => {
      const proc = createMockProcess();
      Promise.resolve().then(() => {
        proc.stderr.emit('data', Buffer.from('manifest unknown'));
        proc.emit('close', 1);
      });
      return proc;
    });

    const svc = ComposeService.getInstance(1);
    const result = svc.pullStackImages('my-stack').then(() => null, (e: Error) => e);
    await vi.runAllTimersAsync();
    const error = await result;

    expect(error).toBeInstanceOf(Error);
    expect(mockCaptureCandidate).not.toHaveBeenCalled();
    expect(mockMarkAcquired).not.toHaveBeenCalled();
    expect(mockHandoff).not.toHaveBeenCalled();
    expect(mockAbandon).not.toHaveBeenCalled();
  });
});

// ── updateStack: prune-on-update ───────────────────────────────────────

describe('ComposeService - updateStack service-recovery retirement', () => {
  it('retires the stack service-recovery snapshots after a successful update', async () => {
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([]);
    mockGetGlobalSettings.mockReturnValue({});

    const promise = ComposeService.getInstance(1).updateStack('my-stack');
    await vi.advanceTimersByTimeAsync(3100);
    await promise;

    // The update replaced every service's image, so the snapshots taken before
    // it stop being rollback targets.
    expect(mockInvalidateActiveServiceRecoveries).toHaveBeenCalledWith(1, 'my-stack');
  });

  it('leaves them alone when the update never reaches Compose', async () => {
    setupAutoCloseSpawn();
    mockClassifyLegacyOrphansForUpdate.mockResolvedValueOnce({
      status: 'classification_failed', error: 'daemon said no',
    });

    await expect(ComposeService.getInstance(1).updateStack('my-stack')).rejects.toThrow(/classification/i);
    expect(mockInvalidateActiveServiceRecoveries).not.toHaveBeenCalled();
  });
});

describe('ComposeService - updateStack prune-on-update', () => {
  it('prunes dangling images after a successful update when prune_on_update=1', async () => {
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([]);
    mockGetGlobalSettings.mockReturnValue({ prune_on_update: '1' });
    mockPruneDanglingImages.mockResolvedValue({ reclaimedBytes: 2_097_152 });

    const svc = ComposeService.getInstance(1);
    const promise = svc.updateStack('my-stack');
    await vi.advanceTimersByTimeAsync(3100);
    await promise;

    expect(mockPruneDanglingImages).toHaveBeenCalledTimes(1);
  });

  it('streams a reclaim figure only when the daemon reports bytes', async () => {
    mockListContainers.mockResolvedValue([]);
    mockGetGlobalSettings.mockReturnValue({ prune_on_update: '1' });
    const ws = createMockWs();

    // The containerd image store reports SpaceReclaimed=0 even when it removes
    // images, so a zero figure must be omitted rather than shown as "0.0 MB".
    setupAutoCloseSpawn();
    mockPruneDanglingImages.mockResolvedValueOnce({ reclaimedBytes: 0 });
    let p = ComposeService.getInstance(1).updateStack('my-stack', ws);
    await vi.advanceTimersByTimeAsync(3100);
    await p;
    expect(ws.send).toHaveBeenCalledWith('=== Pruned dangling images ===\n');

    ws.send.mockClear();
    setupAutoCloseSpawn();
    mockPruneDanglingImages.mockResolvedValueOnce({ reclaimedBytes: 5 * 1024 * 1024 });
    p = ComposeService.getInstance(1).updateStack('my-stack', ws);
    await vi.advanceTimersByTimeAsync(3100);
    await p;
    expect(ws.send).toHaveBeenCalledWith('=== Pruned dangling images · reclaimed 5.0 MB ===\n');
  });

  it('does not prune when prune_on_update=0', async () => {
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([]);
    mockGetGlobalSettings.mockReturnValue({ prune_on_update: '0' });

    const svc = ComposeService.getInstance(1);
    const promise = svc.updateStack('my-stack');
    await vi.advanceTimersByTimeAsync(3100);
    await promise;

    expect(mockPruneDanglingImages).not.toHaveBeenCalled();
  });

  it('does not prune when the setting key is absent (fail-safe for un-backfilled DBs)', async () => {
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([]);
    mockGetGlobalSettings.mockReturnValue({});

    const svc = ComposeService.getInstance(1);
    const promise = svc.updateStack('my-stack');
    await vi.advanceTimersByTimeAsync(3100);
    await promise;

    expect(mockPruneDanglingImages).not.toHaveBeenCalled();
  });

  it('does not prune when the update itself fails (prune is success-only)', async () => {
    setupAutoCloseSpawn();
    // A container that exited non-zero makes the post-update health probe throw,
    // so control never reaches the prune block that follows it.
    mockListContainers.mockResolvedValue([{ Id: 'c1', State: 'exited' }]);
    mockContainerInspect.mockResolvedValue({ State: { ExitCode: 1 } });
    mockGetGlobalSettings.mockReturnValue({ prune_on_update: '1' });

    const svc = ComposeService.getInstance(1);
    const promise = svc.updateStack('my-stack');
    // Attach the rejection expectation before advancing timers so the throw
    // (which fires mid-advance) is never momentarily unhandled.
    const rejection = expect(promise).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(3100);
    await rejection;

    expect(mockPruneDanglingImages).not.toHaveBeenCalled();
  });

  it('does not roll back an atomic update when the post-update prune throws', async () => {
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([]);
    mockGetGlobalSettings.mockReturnValue({ prune_on_update: '1' });
    mockPruneDanglingImages.mockRejectedValueOnce(new Error('docker busy'));

    const svc = ComposeService.getInstance(1);
    const promise = svc.updateStack('my-stack', undefined, true); // atomic
    await vi.advanceTimersByTimeAsync(3100);

    // The update already succeeded before the prune ran, so a prune failure
    // must neither reject nor trigger the atomic restore.
    await expect(promise).resolves.toEqual({ recoveryId: 'recovery-1', deployedGenerationId: null, gitopsOperationId: null });
    expect(mockRestoreStackFiles).not.toHaveBeenCalled();
  });

  it('does not fail the update when the prune throws', async () => {
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([]);
    mockGetGlobalSettings.mockReturnValue({ prune_on_update: '1' });
    mockPruneDanglingImages.mockRejectedValueOnce(new Error('docker busy'));

    const svc = ComposeService.getInstance(1);
    const promise = svc.updateStack('my-stack');
    await vi.advanceTimersByTimeAsync(3100);

    await expect(promise).resolves.toEqual({ recoveryId: 'recovery-1', deployedGenerationId: null, gitopsOperationId: null });
  });
});

// ── withRegistryAuth ───────────────────────────────────────────────────

describe('ComposeService - drift reconcile hook', () => {
  it('reconciles the drift ledger after a successful update', async () => {
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([]);
    mockGetGlobalSettings.mockReturnValue({});
    const spy = vi.spyOn(DriftLedgerService.getInstance(), 'reconcileStack').mockResolvedValue({ detected: 0, resolved: 0 });

    const promise = ComposeService.getInstance(1).updateStack('my-stack');
    await vi.advanceTimersByTimeAsync(3100);
    await promise;

    expect(spy).toHaveBeenCalledWith(1, 'my-stack');
    spy.mockRestore();
  });

  it('reconciles the drift ledger after a successful deploy', async () => {
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([]);
    mockGetGlobalSettings.mockReturnValue({});
    const spy = vi.spyOn(DriftLedgerService.getInstance(), 'reconcileStack').mockResolvedValue({ detected: 0, resolved: 0 });

    const promise = ComposeService.getInstance(1).deployStack('my-stack');
    await vi.advanceTimersByTimeAsync(3100);
    await promise;

    expect(spy).toHaveBeenCalledWith(1, 'my-stack');
    spy.mockRestore();
  });

  it('layers a digest overlay, keeps compose.override.yml, and uses --pull never', async () => {
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([]);
    mockGetOverrideFilename.mockResolvedValue('compose.override.yml');
    const overlayDir = '/tmp/sencho-digest-pins-testXXXX';
    mockPromisesMkdtemp.mockResolvedValue(overlayDir);

    const pin = `nginx@sha256:${'a'.repeat(64)}`;
    const promise = ComposeService.getInstance(1).deployStack('my-stack', undefined, false, {
      source: 'blueprint',
      digestPins: { web: pin },
    });
    await vi.advanceTimersByTimeAsync(3100);
    await promise;

    expect(mockPromisesWriteFile).toHaveBeenCalled();
    const writeArgs = mockPromisesWriteFile.mock.calls[0];
    expect(String(writeArgs[0])).toContain('overlay.yml');
    expect(String(writeArgs[1])).toContain(pin);
    const dockerArgs = mockSpawn.mock.calls.find((call) => call[0] === 'docker' && Array.isArray(call[1]) && call[1].includes('up'))?.[1] as string[];
    expect(dockerArgs).toEqual(expect.arrayContaining([
      '-f', 'compose.yaml',
      '-f', 'compose.override.yml',
      '-f', `${overlayDir}/overlay.yml`,
      'up', '-d', '--remove-orphans',
      '--pull', 'never',
    ]));
    expect(mockPromisesRm).toHaveBeenCalledWith(overlayDir, { recursive: true, force: true });
  });

  it('does not reconcile the ledger when a deploy fails', async () => {
    setupAutoCloseSpawn(1); // non-zero exit => the deploy rejects before the post-success hook
    mockListContainers.mockResolvedValue([]);
    mockGetGlobalSettings.mockReturnValue({});
    const spy = vi.spyOn(DriftLedgerService.getInstance(), 'reconcileStack').mockResolvedValue({ detected: 0, resolved: 0 });

    const result = await ComposeService.getInstance(1).deployStack('my-stack').then(() => null, (e: Error) => e);
    expect(result).toBeInstanceOf(Error);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('ComposeService - withRegistryAuth', () => {
  it('passes default env when no registries configured', async () => {
    mockGetRegistries.mockReturnValue([]);
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([]);

    const svc = ComposeService.getInstance(1);
    const promise = svc.deployStack('my-stack');

    await vi.advanceTimersByTimeAsync(3100);
    await promise;

    expect(mockMkdtempSync).not.toHaveBeenCalled();
  });

  it('creates temp config dir when registries exist', async () => {
    mockGetRegistries.mockReturnValue([{ url: 'https://registry.example.com', username: 'user', password: 'pass' }]);
    mockResolveDockerConfig.mockResolvedValue({ config: { auths: { 'registry.example.com': { auth: 'dXNlcjpwYXNz' } } }, warnings: [] });
    mockGetGlobalSettings.mockReturnValue({ delivery_source_id: 'test-delivery-source' });
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([]);

    const svc = ComposeService.getInstance(1);
    const promise = svc.deployStack('my-stack');

    await vi.advanceTimersByTimeAsync(3100);
    await promise;

    expect(mockCreateDockerAuthTempDir).toHaveBeenCalled();
    expect(mockCleanupDockerAuthTempDir).toHaveBeenCalled();
  });

  it('surfaces resolveDockerConfig warnings to the WebSocket output', async () => {
    mockGetRegistries.mockReturnValue([{ url: 'https://registry.example.com' }]);
    mockResolveDockerConfig.mockResolvedValue({
      config: { auths: {} },
      warnings: ['Registry "broken" credentials unavailable: bad key'],
    });
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([]);
    const ws = createMockWs();

    const svc = ComposeService.getInstance(1);
    const promise = svc.deployStack('my-stack', ws);

    await vi.advanceTimersByTimeAsync(3100);
    await promise;

    const sendCalls = ws.send.mock.calls.map(c => c[0]);
    expect(sendCalls.some((msg: string) => msg.includes('[Sencho] Warning') && msg.includes('bad key'))).toBe(true);
  });

  it('cleans up temp dir even on command failure', async () => {
    mockGetRegistries.mockReturnValue([{ url: 'https://registry.example.com' }]);
    mockResolveDockerConfig.mockResolvedValue({ config: { auths: { 'registry.example.com': { auth: 'dGVzdA==' } } }, warnings: [] });
    mockGetGlobalSettings.mockReturnValue({ delivery_source_id: 'test-delivery-source' });

    // Make spawn fail
    mockSpawn.mockImplementation(() => {
      const proc = createMockProcess();
      Promise.resolve().then(() => {
        proc.stderr.emit('data', Buffer.from('pull failed'));
        proc.emit('close', 1);
      });
      return proc;
    });

    const svc = ComposeService.getInstance(1);
    const result = svc.deployStack('my-stack').then(() => null, (e: Error) => e);

    await vi.runAllTimersAsync();
    const error = await result;
    expect(error).not.toBeNull();
    expect(mockCleanupDockerAuthTempDir).toHaveBeenCalled();
  });
});

describe('ComposeService - registry delivery cleanup logging', () => {
  const deliveryEnvelope = {
    attestation: 'test-token',
    auths: [],
    notAfter: Date.now() + 60_000,
    deliverySourceId: 'delivery-src-1',
  };

  async function deployWithDeliveryContext(): Promise<void> {
    const { runWithRegistryDeliveryContext } = await import('../helpers/registryDeliveryContext');
    const svc = ComposeService.getInstance(1);
    await runWithRegistryDeliveryContext({
      envelope: deliveryEnvelope,
      nodeId: 1,
      stack: 'my-stack',
      stage: 'stack-deploy',
      seamResult: { auths: { 'registry.example.com': { auth: 'dGVzdA==' } }, prepId: 'prep-1' },
      seamSettled: true,
    }, async () => {
      const promise = svc.deployStack('my-stack');
      await vi.advanceTimersByTimeAsync(3100);
      await promise;
    });
  }

  beforeEach(() => {
    mockGetRegistries.mockReturnValue([]);
    mockGetGlobalSettings.mockReturnValue({ delivery_source_id: 'delivery-src-1' });
    mockCleanupDockerAuthTempDir.mockReset();
    mockCleanupDockerAuthTempDir.mockImplementation(() => undefined);
    mockRecordRegistryDeliveryEvent.mockReset();
    mockPreparedSourceFinalize.mockReset();
    mockPreparedSourceFinalize.mockImplementation(() => undefined);
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([]);
  });

  it('logs cleanup failure when evidence records successfully', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockCleanupDockerAuthTempDir.mockImplementation(() => {
      throw new Error('cleanup failed');
    });

    await deployWithDeliveryContext();

    expect(mockRecordRegistryDeliveryEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'cleanup_failed',
    }));
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Registry delivery temp dir cleanup failed'),
      expect.any(String),
      'cleanup failed',
    );
    errorSpy.mockRestore();
  });

  it('logs both cleanup and evidence failures without changing deploy success', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockCleanupDockerAuthTempDir.mockImplementation(() => {
      throw new Error('cleanup failed');
    });
    mockRecordRegistryDeliveryEvent.mockImplementation(() => {
      throw new Error('evidence failed');
    });

    await deployWithDeliveryContext();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Registry delivery cleanup and evidence both failed'),
      expect.any(String),
      'evidence failed',
      'cleanup failed',
    );
    errorSpy.mockRestore();
  });

  it('logs prepared-source finalization failure without changing deploy success', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockPreparedSourceFinalize.mockImplementation(() => {
      throw new Error('finalize failed');
    });

    await deployWithDeliveryContext();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Registry delivery prepared-source finalize failed'),
      'prep-1',
      'finalize failed',
    );
    errorSpy.mockRestore();
  });
});

// ── runDown ────────────────────────────────────────────────────────────

describe('ComposeService - runDown', () => {
  it('runs plain docker compose down by default', async () => {
    setupAutoCloseSpawn();

    const svc = ComposeService.getInstance(1);
    await svc.runDown('my-stack');

    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      ['compose', 'down'],
      expect.any(Object)
    );
  });

  it('runs docker compose down --volumes when removeVolumes is true', async () => {
    setupAutoCloseSpawn();

    const svc = ComposeService.getInstance(1);
    await svc.runDown('my-stack', { removeVolumes: true });

    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      ['compose', 'down', '--volumes'],
      expect.any(Object)
    );
  });

  it('does not pass --volumes when removeVolumes is false', async () => {
    setupAutoCloseSpawn();

    const svc = ComposeService.getInstance(1);
    await svc.runDown('my-stack', { removeVolumes: false });

    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      ['compose', 'down'],
      expect.any(Object)
    );
  });
});

// ── downStack ──────────────────────────────────────────────────────────

describe('ComposeService - downStack', () => {
  it('runs docker compose down with volumes and remove-orphans when removeVolumes is true', async () => {
    setupAutoCloseSpawn();

    const svc = ComposeService.getInstance(1);
    await svc.downStack('my-stack', { removeVolumes: true });

    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      ['compose', 'down', '--volumes', '--remove-orphans'],
      expect.any(Object)
    );
  });

  it('runs docker compose down without --volumes when removeVolumes is false', async () => {
    setupAutoCloseSpawn();

    const svc = ComposeService.getInstance(1);
    await svc.downStack('my-stack', { removeVolumes: false });

    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      ['compose', 'down', '--remove-orphans'],
      expect.any(Object)
    );
  });

  it('defaults to no --volumes when options are omitted (safe default)', async () => {
    setupAutoCloseSpawn();

    const svc = ComposeService.getInstance(1);
    await svc.downStack('my-stack');

    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      ['compose', 'down', '--remove-orphans'],
      expect.any(Object)
    );
  });

  it('resolves even when command fails (throwOnError=false)', async () => {
    mockSpawn.mockImplementation(() => {
      const proc = createMockProcess();
      Promise.resolve().then(() => proc.emit('close', 1));
      return proc;
    });

    const svc = ComposeService.getInstance(1);
    await expect(svc.downStack('my-stack')).resolves.toBeUndefined();
  });
});

// ── stall (idle-output) backstop ───────────────────────────────────────

describe('ComposeService - idle-output stall backstop', () => {
  it('terminates a silent update step and rejects with STACK_STALLED_OUTPUT', async () => {
    process.env.SENCHO_COMPOSE_STALL_TIMEOUT_MS = '1000';
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const svc = ComposeService.getInstance(1);
    // The pull emits nothing; the idle backstop should fire after 1s.
    const result = svc.updateStack('my-stack').then(() => null, (e: Error) => e);
    await vi.advanceTimersByTimeAsync(1000);

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    proc.emit('close', null);
    const error = await result;
    expect(error).not.toBeNull();
    expect(error!.message).toContain('STACK_STALLED_OUTPUT');
  });

  it('sends a stalled marker to the WebSocket before terminating', async () => {
    process.env.SENCHO_COMPOSE_STALL_TIMEOUT_MS = '1000';
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const ws = createMockWs();

    const svc = ComposeService.getInstance(1);
    const result = svc.updateStack('my-stack', ws).then(() => null, (e: Error) => e);
    await vi.advanceTimersByTimeAsync(1000);
    proc.emit('close', null);
    await result;

    const sendCalls = ws.send.mock.calls.map(c => c[0] as string);
    expect(sendCalls.some(msg => msg.includes('appears stalled and was stopped'))).toBe(true);
  });

  it('does not stall when output keeps arriving within the idle window', async () => {
    process.env.SENCHO_COMPOSE_STALL_TIMEOUT_MS = '1000';
    mockListContainers.mockResolvedValue([]);
    const proc = createMockProcess();
    // deployStack now spawns a second child (exposure refresh via renderConfig)
    // after the up command closes. Return the controlled proc for the up spawn,
    // and a fresh auto-closing proc for the config spawn so the test does not
    // hang on the already-closed proc.
    let spawnCount = 0;
    mockSpawn.mockImplementation(() => {
      spawnCount += 1;
      if (spawnCount === 1) return proc;
      const configProc = createMockProcess();
      Promise.resolve().then(() => configProc.emit('close', 0));
      return configProc;
    });

    const svc = ComposeService.getInstance(1);
    // deployStack spawns a single `up`; emit output every 600ms (< 1s window)
    // so the idle timer resets and never fires.
    const promise = svc.deployStack('my-stack');
    await vi.advanceTimersByTimeAsync(600);
    proc.stdout.emit('data', Buffer.from('pulling layer a...'));
    await vi.advanceTimersByTimeAsync(600);
    proc.stdout.emit('data', Buffer.from('pulling layer b...'));
    await vi.advanceTimersByTimeAsync(600);
    expect(proc.kill).not.toHaveBeenCalled();

    proc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(3100); // health probe
    await promise;
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('does not arm the idle backstop for runCommand (down/restart/stop stay silent-safe)', async () => {
    process.env.SENCHO_COMPOSE_STALL_TIMEOUT_MS = '1000';
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const svc = ComposeService.getInstance(1);
    const promise = svc.runCommand('my-stack', 'restart');
    // A silent restart longer than the stall window must not be killed: the
    // idle backstop is only armed for deploy/update compose steps.
    await vi.advanceTimersByTimeAsync(1500);
    expect(proc.kill).not.toHaveBeenCalled();

    proc.emit('close', 0);
    await promise;
  });

  it('terminates compose when the registry delivery abort signal fires', async () => {
    const { runWithRegistryDeliveryContext } = await import('../helpers/registryDeliveryContext');
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const abortController = new AbortController();

    const svc = ComposeService.getInstance(1);
    const result = runWithRegistryDeliveryContext(
      {
        envelope: {
          attestation: 'unused',
          auths: [],
          notAfter: Date.now() + 60_000,
          deliverySourceId: 'test',
        },
        nodeId: 1,
        stack: 'my-stack',
        stage: 'stack-deploy',
        abortSignal: abortController.signal,
      },
      () => svc.runCommand('my-stack', 'restart'),
    ).then(() => null, (e: Error) => e);

    await waitForSpawn();
    abortController.abort();
    proc.emit('close', null);

    const error = await result;
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(error).not.toBeNull();
    expect((error as Error).message).toContain('OPERATION_ABORTED');
  });

  it('falls back to the default stall window when the env value is invalid', async () => {
    process.env.SENCHO_COMPOSE_STALL_TIMEOUT_MS = '0'; // invalid → default (10min)
    mockListContainers.mockResolvedValue([]);
    const proc = createMockProcess();
    // Same pattern as the stall test above: the second spawn (exposure refresh)
    // needs its own auto-closing proc so deployStack can resolve after close.
    let spawnCount = 0;
    mockSpawn.mockImplementation(() => {
      spawnCount += 1;
      if (spawnCount === 1) return proc;
      const configProc = createMockProcess();
      Promise.resolve().then(() => configProc.emit('close', 0));
      return configProc;
    });

    const svc = ComposeService.getInstance(1);
    const promise = svc.deployStack('my-stack');
    // Far below the 10-minute default: a '0' that leaked through would fire at 0ms.
    await vi.advanceTimersByTimeAsync(2000);
    expect(proc.kill).not.toHaveBeenCalled();

    proc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(3100); // health probe
    await promise;
  });

  it('surfaces STACK_STALLED_OUTPUT on acquire stall without runtime compensation', async () => {
    process.env.SENCHO_COMPOSE_STALL_TIMEOUT_MS = '1000';
    const pullProc = createMockProcess();
    mockSpawn.mockImplementation(() => pullProc);

    const svc = ComposeService.getInstance(1);
    const result = svc.updateStack('my-stack', undefined, true).then(() => null, (e: Error) => e);
    await vi.advanceTimersByTimeAsync(1000); // idle backstop fires on the silent pull
    pullProc.emit('close', null);
    await vi.runAllTimersAsync();

    const error = await result;
    expect(error).not.toBeNull();
    expect(error!.message).toContain('STACK_STALLED_OUTPUT');
    // Acquire failure is pre-handoff: abandon candidate, do not wrap as ComposeRollbackError.
    expect(getComposeRollbackInfo(error)).toBeNull();
    expect(mockAbandon).toHaveBeenCalledWith('recovery-1');
    expect(mockCompensateWithCandidate).not.toHaveBeenCalled();
  });
});

// ── streamLogs ─────────────────────────────────────────────────────────

describe('ComposeService - streamLogs', () => {
  it('emits a normalized container name prefix for each container', async () => {
    mockGetContainersByStack.mockResolvedValue([
      { Names: ['/mystack-redis-1'], State: 'running', Id: 'abc123' },
      { Names: ['/mystack-api-1'], State: 'running', Id: 'def456' },
    ]);

    const ws = createMockWs();
    const svc = ComposeService.getInstance(1);

    const proc1 = createMockProcess();
    const proc2 = createMockProcess();
    mockSpawn
      .mockReturnValueOnce(proc1)
      .mockReturnValueOnce(proc2);

    svc.streamLogs('mystack', ws);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));

    // Emit stdout from each container.
    proc1.stdout.emit('data', Buffer.from('2024-01-01T00:00:00Z redis log line\n'));
    proc2.stdout.emit('data', Buffer.from('2024-01-01T00:00:01Z api response\n'));

    const calls = (ws.send as ReturnType<typeof vi.fn>).mock.calls as string[][];
    const sentLines = calls.flatMap(c => c[0].split('\r\n')).filter(Boolean);

    expect(sentLines).toContain('redis | 2024-01-01T00:00:00Z redis log line');
    expect(sentLines).toContain('api | 2024-01-01T00:00:01Z api response');
  });

  it('prefixes flushBuffer trailing line on child close', async () => {
    mockGetContainersByStack.mockResolvedValue([
      { Names: ['/mystack-web-1'], State: 'running', Id: 'ghi789' },
    ]);

    const ws = createMockWs();
    const svc = ComposeService.getInstance(1);

    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    svc.streamLogs('mystack', ws);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

    // Emit a line without a trailing newline, then close.
    proc.stdout.emit('data', Buffer.from('trailing content'));
    proc.emit('close', 0);

    const calls = (ws.send as ReturnType<typeof vi.fn>).mock.calls as string[][];
    const sentLines = calls.flatMap(c => c[0].split('\r\n')).filter(Boolean);

    expect(sentLines).toContain('web | trailing content');
  });

  it('joins chunk-split lines and prefixes once', async () => {
    mockGetContainersByStack.mockResolvedValue([
      { Names: ['/mystack-db-1'], State: 'running', Id: 'jkl012' },
    ]);

    const ws = createMockWs();
    const svc = ComposeService.getInstance(1);

    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    svc.streamLogs('mystack', ws);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

    // Split a single line across two data events.
    proc.stdout.emit('data', Buffer.from('2024-01-01T00:00:00Z partial '));
    proc.stdout.emit('data', Buffer.from('end of line\n'));

    const calls = (ws.send as ReturnType<typeof vi.fn>).mock.calls as string[][];
    const sentLines = calls.flatMap(c => c[0].split('\r\n')).filter(Boolean);

    expect(sentLines).toContain('db | 2024-01-01T00:00:00Z partial end of line');
  });

  it('normalizes dotted container names', async () => {
    mockGetContainersByStack.mockResolvedValue([
      { Names: ['/mystack-api.v1-1'], State: 'running', Id: 'mno345' },
    ]);

    const ws = createMockWs();
    const svc = ComposeService.getInstance(1);

    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    svc.streamLogs('mystack', ws);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

    proc.stdout.emit('data', Buffer.from('2024-01-01T00:00:00Z started\n'));

    const calls = (ws.send as ReturnType<typeof vi.fn>).mock.calls as string[][];
    const sentLines = calls.flatMap(c => c[0].split('\r\n')).filter(Boolean);

    // normalizeContainerName strips stack prefix and -1 replica suffix, leaving 'api.v1'.
    expect(sentLines).toContain('api.v1 | 2024-01-01T00:00:00Z started');
  });

  it('passes raw container name to docker logs, not normalized name', async () => {
    mockGetContainersByStack.mockResolvedValue([
      { Names: ['/mystack-redis-1'], State: 'running', Id: 'pqr678' },
    ]);

    const ws = createMockWs();
    const svc = ComposeService.getInstance(1);

    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    svc.streamLogs('mystack', ws);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

    // Verify that docker logs uses the raw name, not the normalized one.
    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      ['logs', '-f', '-t', '--tail', '100', 'mystack-redis-1'],
      expect.anything(),
    );
  });

  it('does not reschedule when the stack directory is gone', async () => {
    mockFsStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const ws = createMockWs();
    const svc = ComposeService.getInstance(1);

    svc.streamLogs('mystack', ws);
    await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());

    const sent = (ws.send as ReturnType<typeof vi.fn>).mock.calls
      .flatMap((c) => String(c[0]).split(/\r?\n/))
      .filter(Boolean);
    expect(sent.some((line) => line.includes('Stack directory is gone'))).toBe(true);
    expect(mockGetContainersByStack).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4000);
    expect(mockGetContainersByStack).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('retries every 2s when the stack dir exists and no containers are found', async () => {
    mockGetContainersByStack.mockResolvedValue([]);
    const ws = createMockWs();
    const svc = ComposeService.getInstance(1);

    svc.streamLogs('mystack', ws);
    await vi.waitFor(() => expect(mockGetContainersByStack).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(2000);
    expect(mockGetContainersByStack).toHaveBeenCalledTimes(2);

    const sent = (ws.send as ReturnType<typeof vi.fn>).mock.calls
      .flatMap((c) => String(c[0]))
      .join('');
    expect(sent).toContain('No containers found. Waiting for activity');
  });

  it('stops retrying after the websocket closes', async () => {
    mockGetContainersByStack.mockResolvedValue([]);
    const ws = createMockWs();
    const svc = ComposeService.getInstance(1);

    svc.streamLogs('mystack', ws);
    await vi.waitFor(() => expect(mockGetContainersByStack).toHaveBeenCalledTimes(1));

    ws.readyState = 3;
    ws.emit('close');
    await vi.advanceTimersByTimeAsync(4000);
    expect(mockGetContainersByStack).toHaveBeenCalledTimes(1);
  });

  it('stops the empty-container retry after the stack directory disappears', async () => {
    mockGetContainersByStack.mockResolvedValue([]);
    const ws = createMockWs();
    const svc = ComposeService.getInstance(1);

    svc.streamLogs('mystack', ws);
    await vi.waitFor(() => expect(mockGetContainersByStack).toHaveBeenCalledTimes(1));

    mockFsStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await vi.advanceTimersByTimeAsync(2000);

    expect(mockGetContainersByStack).toHaveBeenCalledTimes(1);
    const sent = (ws.send as ReturnType<typeof vi.fn>).mock.calls
      .flatMap((c) => String(c[0]))
      .join('');
    expect(sent).toContain('No containers found. Waiting for activity');
    expect(sent).toContain('Stack directory is gone');
    expect(ws.close).not.toHaveBeenCalled();

    const sendsAfterGone = (ws.send as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(4000);
    expect(mockGetContainersByStack).toHaveBeenCalledTimes(1);
    expect(ws.send).toHaveBeenCalledTimes(sendsAfterGone);
    expect(ws.close).not.toHaveBeenCalled();
  });
});


describe('ComposeService - updateStack safe ordering', () => {
  it('never broad-removes Compose-managed containers before up', async () => {
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([]);
    mockGetContainersByStack.mockResolvedValue([{ Id: 'should-not-remove' }]);

    const svc = ComposeService.getInstance(1);
    const promise = svc.updateStack('my-stack');
    await vi.advanceTimersByTimeAsync(3100);
    await promise;

    expect(mockGetContainersByStack).not.toHaveBeenCalled();
    expect(mockRemoveContainers).not.toHaveBeenCalled();
    expect(mockCaptureCandidate).toHaveBeenCalled();
    expect(mockClassifyLegacyOrphansForUpdate).toHaveBeenCalledWith('my-stack');
    expect(mockHandoff).toHaveBeenCalled();
  });

  it('removes only classified orphans after handoff', async () => {
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([]);
    mockClassifyLegacyOrphansForUpdate.mockResolvedValueOnce({
      status: 'orphans',
      ids: ['orphan-1'],
    });
    mockRemoveContainers.mockResolvedValueOnce([{ id: 'orphan-1', success: true }]);

    const svc = ComposeService.getInstance(1);
    const promise = svc.updateStack('my-stack');
    await vi.advanceTimersByTimeAsync(3100);
    await promise;

    expect(mockHandoff).toHaveBeenCalled();
    expect(mockRemoveContainers).toHaveBeenCalledWith(['orphan-1']);
  });
});
