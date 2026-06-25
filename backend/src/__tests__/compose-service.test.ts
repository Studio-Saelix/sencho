/**
 * Unit tests for ComposeService — subprocess handling, deploy/rollback,
 * registry auth temp dir management, and WebSocket output.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import os from 'os';
import type WebSocket from 'ws';

// ── Hoisted mocks ──────────────────────────────────────────────────────

const {
  mockSpawn,
  mockGetContainersByStack, mockRemoveContainers, mockListContainers,
  mockContainerInspect, mockContainerLogs,
  mockGetRegistries, mockResolveDockerConfig,
  mockBackupStackFiles, mockRestoreStackFiles,
  mockGetComposeFilename, mockGetOverrideFilename, mockEnsureStackOverride,
  mockMkdtempSync, mockWriteFileSync, mockUnlinkSync, mockRmdirSync,
  mockGetGlobalSettings, mockPruneDanglingImages,
} = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockGetContainersByStack: vi.fn().mockResolvedValue([]),
  mockRemoveContainers: vi.fn().mockResolvedValue([]),
  mockListContainers: vi.fn().mockResolvedValue([]),
  mockContainerInspect: vi.fn().mockResolvedValue({ State: { ExitCode: 0 } }),
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
}));

vi.mock('child_process', () => ({ spawn: mockSpawn, execFile: vi.fn() }));

vi.mock('fs', () => ({
  default: {
    mkdtempSync: (...args: unknown[]) => mockMkdtempSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
    rmdirSync: (...args: unknown[]) => mockRmdirSync(...args),
  },
  mkdtempSync: (...args: unknown[]) => mockMkdtempSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
  rmdirSync: (...args: unknown[]) => mockRmdirSync(...args),
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
      removeContainers: mockRemoveContainers,
      pruneDanglingImages: mockPruneDanglingImages,
      getDocker: () => ({
        listContainers: mockListContainers,
        getContainer: () => ({
          inspect: mockContainerInspect,
          logs: mockContainerLogs,
        }),
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

import { ComposeService, getComposeRollbackInfo } from '../services/ComposeService';
import { DriftLedgerService } from '../services/DriftLedgerService';

const originalComposeTimeout = process.env.SENCHO_COMPOSE_COMMAND_TIMEOUT_MS;
const originalStallTimeout = process.env.SENCHO_COMPOSE_STALL_TIMEOUT_MS;

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

describe('ComposeService - deployStack', () => {
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

  it('creates backup when atomic=true', async () => {
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([]);

    const svc = ComposeService.getInstance(1);
    const promise = svc.deployStack('my-stack', undefined, true);

    await vi.advanceTimersByTimeAsync(3100);
    await promise;

    expect(mockBackupStackFiles).toHaveBeenCalledWith('my-stack');
  });

  it('aborts atomic deploy before docker side effects when backup fails', async () => {
    mockBackupStackFiles.mockRejectedValueOnce(new Error('disk full'));

    const svc = ComposeService.getInstance(1);

    await expect(svc.deployStack('my-stack', undefined, true)).rejects.toThrow(
      'Atomic deployment backup failed',
    );
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockGetContainersByStack).not.toHaveBeenCalled();
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
    expect(mockRestoreStackFiles).toHaveBeenCalledWith('my-stack');
  });

  it('reports rollback failure when atomic restore fails', async () => {
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([{
      Id: 'crashed-c1',
      State: 'exited',
      Labels: { 'com.docker.compose.project': 'my-stack' },
    }]);
    mockContainerInspect.mockResolvedValue({ State: { ExitCode: 1 } });
    mockRestoreStackFiles.mockRejectedValueOnce(new Error('restore denied'));

    const svc = ComposeService.getInstance(1);
    const result = svc.deployStack('my-stack', undefined, true).then(() => null, (e: Error) => e);

    await vi.runAllTimersAsync();
    const error = await result;
    expect(error).not.toBeNull();
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
});

// ── updateStack: prune-on-update ───────────────────────────────────────

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
    await expect(promise).resolves.toBeUndefined();
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

    await expect(promise).resolves.toBeUndefined();
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
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([]);

    const svc = ComposeService.getInstance(1);
    const promise = svc.deployStack('my-stack');

    await vi.advanceTimersByTimeAsync(3100);
    await promise;

    expect(mockMkdtempSync).toHaveBeenCalled();
    expect(mockWriteFileSync).toHaveBeenCalled();
    expect(mockUnlinkSync).toHaveBeenCalled();
    expect(mockRmdirSync).toHaveBeenCalled();
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
    mockResolveDockerConfig.mockResolvedValue({ config: { auths: {} }, warnings: [] });

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
    expect(mockUnlinkSync).toHaveBeenCalled();
  });
});

// ── downStack ──────────────────────────────────────────────────────────

describe('ComposeService - downStack', () => {
  it('runs docker compose down with volumes and remove-orphans', async () => {
    setupAutoCloseSpawn();

    const svc = ComposeService.getInstance(1);
    await svc.downStack('my-stack');

    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      ['compose', 'down', '--volumes', '--remove-orphans'],
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

  it('preserves STACK_STALLED_OUTPUT through the atomic rollback wrapper', async () => {
    process.env.SENCHO_COMPOSE_STALL_TIMEOUT_MS = '1000';
    const pullProc = createMockProcess();
    let call = 0;
    // First spawn is the stalling pull; later spawns (the rollback restore's
    // `up`) close cleanly, proving the restore is not idle-timeout armed.
    mockSpawn.mockImplementation(() => {
      call += 1;
      if (call === 1) return pullProc;
      const p = createMockProcess();
      Promise.resolve().then(() => p.emit('close', 0));
      return p;
    });

    const svc = ComposeService.getInstance(1);
    const result = svc.updateStack('my-stack', undefined, true).then(() => null, (e: Error) => e);
    await vi.advanceTimersByTimeAsync(1000); // idle backstop fires on the silent pull
    pullProc.emit('close', null);
    await vi.runAllTimersAsync();

    const error = await result;
    expect(error).not.toBeNull();
    expect(error!.message).toContain('STACK_STALLED_OUTPUT');
    expect(getComposeRollbackInfo(error)).toMatchObject({ attempted: true });
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
});
