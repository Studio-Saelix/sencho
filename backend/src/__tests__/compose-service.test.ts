/**
 * Unit tests for ComposeService — subprocess handling, deploy/rollback,
 * registry auth temp dir management, and WebSocket output.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Hoisted mocks ──────────────────────────────────────────────────────

const {
  mockSpawn,
  mockGetContainersByStack, mockRemoveContainers, mockListContainers,
  mockContainerInspect, mockContainerLogs,
  mockGetRegistries, mockResolveDockerConfig,
  mockBackupStackFiles, mockRestoreStackFiles,
  mockMkdtempSync, mockWriteFileSync, mockUnlinkSync, mockRmdirSync,
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
  mockMkdtempSync: vi.fn().mockReturnValue('/tmp/sencho-docker-test'),
  mockWriteFileSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockRmdirSync: vi.fn(),
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
    }),
  },
}));

vi.mock('../services/LogFormatter', () => ({
  LogFormatter: { formatLine: (line: string) => line },
}));

import { ComposeService } from '../services/ComposeService';

/** Creates an EventEmitter that mimics a child_process spawn result */
function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
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

function createMockWs() {
  return {
    readyState: 1,
    send: vi.fn(),
    on: vi.fn(),
    close: vi.fn(),
    OPEN: 1,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

// ── runCommand ─────────────────────────────────────────────────────────

describe('ComposeService - runCommand', () => {
  it('spawns docker compose with the correct action', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const svc = ComposeService.getInstance(1);
    const promise = svc.runCommand('my-stack', 'restart');
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
    proc.emit('close', 0);

    await expect(promise).resolves.toBeUndefined();
  });

  it('rejects on non-zero exit code', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const svc = ComposeService.getInstance(1);
    const promise = svc.runCommand('my-stack', 'stop');
    proc.stderr.emit('data', Buffer.from('service not found'));
    proc.emit('close', 1);

    await expect(promise).rejects.toThrow('service not found');
  });

  it('redacts secrets from command failure errors', async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const svc = ComposeService.getInstance(1);
    const promise = svc.runCommand('my-stack', 'stop');
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
    const promise = svc.runCommand('my-stack', 'restart', ws as any);
    proc.stdout.emit('data', Buffer.from('Restarting...'));
    proc.emit('close', 0);
    await promise;

    expect(ws.send).toHaveBeenCalledWith('Restarting...');
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

  it('throws CONTAINER_CRASHED when exited container has non-zero exit code', async () => {
    setupAutoCloseSpawn();
    mockListContainers.mockResolvedValue([{
      Id: 'crashed-c1',
      State: 'exited',
      Labels: { 'com.docker.compose.project': 'my-stack' },
    }]);
    mockContainerInspect.mockResolvedValue({ State: { ExitCode: 1 } });
    mockContainerLogs.mockResolvedValue(Buffer.from('Error: something failed'));

    const svc = ComposeService.getInstance(1);
    // Attach catch handler immediately so rejection is never "unhandled"
    const result = svc.deployStack('my-stack').then(() => null, (e: Error) => e);

    await vi.runAllTimersAsync();
    const error = await result;
    expect(error).not.toBeNull();
    expect(error!.message).toContain('CONTAINER_CRASHED');
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
    expect(mockRestoreStackFiles).toHaveBeenCalledWith('my-stack');
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

// ── withRegistryAuth ───────────────────────────────────────────────────

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
    const promise = svc.deployStack('my-stack', ws as any);

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
