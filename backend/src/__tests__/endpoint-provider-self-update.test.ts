/**
 * SelfUpdateService side of the Docker endpoint replacement: when the option
 * is offered, what the staging and replacement helpers are given (the
 * provider's own host socket, never a guessed path), and that every refusal
 * lands before anything stops.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockerEndpointProvider } from '../services/DockerEndpointProvider';

const { mockExecFile, mockExecFileAsync, mockResolveProvider } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockExecFileAsync: vi.fn(),
  mockResolveProvider: vi.fn(),
}));

vi.mock('child_process', () => ({ exec: vi.fn(), execFile: mockExecFile }));
vi.mock('util', () => ({ promisify: () => mockExecFileAsync }));
vi.mock('../services/DatabaseService', () => ({
  DatabaseService: { getInstance: () => ({ getGlobalSettings: () => ({ prune_on_update: '1' }) }) },
}));
vi.mock('../services/DockerEndpointProvider', () => ({ resolveDockerEndpointProvider: mockResolveProvider }));

import SelfUpdateService, { buildEndpointProviderHelperArgs, parseStageResult, type EndpointProviderRequest } from '../services/SelfUpdateService';

const OP = '3f2b8c1e-5a4d-4e7f-9b2a-1c3d5e7f9a0b';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-endpoint-provider-'));
const handoffDir = path.join(tmp, 'endpoint-provider', OP);
const planFile = path.join(handoffDir, 'plan.json');

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const context = {
  workingDir: '/srv/stack',
  configFiles: '/srv/stack/compose.yaml',
  serviceName: 'sencho',
  imageName: 'saelix/sencho:0.99.0',
  dataDirHost: '/srv/stack/data',
  hostBindMounts: [
    { source: '/srv/stack/data', destination: '/app/data' },
    { source: '/etc/sencho/env', destination: '/env' },
  ],
  project: 'stack',
  runningImageId: 'sha256:running',
};

function resolved(overrides: Partial<Extract<DockerEndpointProvider, { state: 'resolved' }>['provider']> = {}): DockerEndpointProvider {
  return {
    state: 'resolved',
    provider: {
      containerId: 'proxy-id',
      containerName: 'stack-socket-proxy-1',
      project: 'stack',
      service: 'socket-proxy',
      workingDir: '/srv/stack',
      socketBindSource: '/run/user/1000/docker.sock',
      ...overrides,
    },
  };
}

function service() {
  const instance = SelfUpdateService.getInstance();
  const internals = instance as unknown as { composeContext: typeof context | null; canSelfUpdate: boolean };
  internals.composeContext = { ...context };
  internals.canSelfUpdate = true;
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  fs.rmSync(handoffDir, { recursive: true, force: true });
  mockResolveProvider.mockResolvedValue(resolved());
});

describe('getEndpointProviderOption', () => {
  it('offers the provider of Sencho\'s own project when it mounts the host socket', async () => {
    await expect(service().getEndpointProviderOption()).resolves.toEqual({
      state: 'available', service: 'socket-proxy', containerName: 'stack-socket-proxy-1', providerOnly: true, project: 'stack',
    });
  });

  it('is none when Sencho does not reach Docker through a container', async () => {
    mockResolveProvider.mockResolvedValue({ state: 'none', reason: 'local socket' });
    await expect(service().getEndpointProviderOption()).resolves.toEqual({ state: 'none' });
  });

  it('is unavailable with the guard\'s reason when the provider cannot be identified', async () => {
    mockResolveProvider.mockResolvedValue({ state: 'unresolved', reason: 'host did not resolve' });
    await expect(service().getEndpointProviderOption()).resolves.toEqual({ state: 'unavailable', service: null, reason: 'host did not resolve' });
  });

  it.each([
    ['another Compose project', { project: 'proxy-stack' }, "not a service of Sencho's own Compose project"],
    ['a different working directory', { workingDir: '/srv/other' }, "not a service of Sencho's own Compose project"],
    ['no Compose service label', { service: null }, "not a service of Sencho's own Compose project"],
    ['no host socket bind', { socketBindSource: null }, 'does not bind-mount the host Docker socket'],
    ['a relative socket source', { socketBindSource: 'docker.sock' }, 'does not bind-mount the host Docker socket'],
  ])('refuses a provider with %s', async (_label, overrides, reason) => {
    mockResolveProvider.mockResolvedValue(resolved(overrides));
    const option = await service().getEndpointProviderOption();
    expect(option).toMatchObject({ state: 'unavailable', reason: expect.stringContaining(reason) });
  });

  it('refuses when the data directory is not mounted (no handoff for the outcome)', async () => {
    const instance = service();
    (instance as unknown as { composeContext: typeof context }).composeContext.dataDirHost = null as unknown as string;
    await expect(instance.getEndpointProviderOption()).resolves.toMatchObject({ state: 'unavailable', reason: expect.stringContaining('data directory') });
  });
});

describe('buildEndpointProviderHelperArgs', () => {
  const input = {
    operationId: OP,
    socketSource: '/run/user/1000/docker.sock',
    workingDir: '/srv/stack',
    dataDirHost: '/srv/stack/data',
    hostBindMounts: context.hostBindMounts,
    imageId: 'sha256:running',
    composeWritable: false,
    envFile: null,
    handoffOwner: null,
  };

  it('mounts the provider\'s own host socket, not /var/run/docker.sock from the host', () => {
    const args = buildEndpointProviderHelperArgs({ ...input, mode: 'stage' });
    expect(args).toContain('/run/user/1000/docker.sock:/var/run/docker.sock');
    expect(args).not.toContain('/var/run/docker.sock:/var/run/docker.sock');
    expect(args).toContain('DOCKER_HOST=unix:///var/run/docker.sock');
  });

  it('disables the image healthcheck, which probes a server the helper never runs', () => {
    expect(buildEndpointProviderHelperArgs({ ...input, mode: 'replace' })).toContain('--no-healthcheck');
  });

  it('runs the running image by ID with the helper entry point', () => {
    const args = buildEndpointProviderHelperArgs({ ...input, mode: 'stage' });
    expect(args.slice(-4)).toEqual(['sha256:running', '/app/dist/endpointProviderHelper.js', 'stage', OP]);
    expect(args).toContain('/srv/stack/data:/app/data:rw');
    expect(args).toContain('/etc/sencho/env:/etc/sencho/env:ro');
  });

  it('detaches only the replace run, so recreating the provider cannot cut the client', () => {
    expect(buildEndpointProviderHelperArgs({ ...input, mode: 'replace' }).slice(0, 3)).toEqual(['run', '-d', '--rm']);
    expect(buildEndpointProviderHelperArgs({ ...input, mode: 'stage' })).not.toContain('-d');
  });

  it('mounts the working directory read-write only for a Sencho repin', () => {
    expect(buildEndpointProviderHelperArgs({ ...input, mode: 'replace' })).toContain('/srv/stack:/srv/stack:ro');
    expect(buildEndpointProviderHelperArgs({ ...input, mode: 'replace', composeWritable: true })).toContain('/srv/stack:/srv/stack:rw');
  });

  it('hands the application uid/gid to the root helper so it can publish readable files', () => {
    const args = buildEndpointProviderHelperArgs({
      ...input,
      mode: 'replace',
      handoffOwner: { uid: 1001, gid: 1002 },
    });
    expect(args).toContain('SENCHO_HANDOFF_UID=1001');
    expect(args).toContain('SENCHO_HANDOFF_GID=1002');
  });

  it('omits the owner when the runtime has no process ids', () => {
    const args = buildEndpointProviderHelperArgs({ ...input, mode: 'replace', handoffOwner: null });
    expect(args.some(arg => arg.startsWith('SENCHO_HANDOFF_'))).toBe(false);
  });

  it('passes the Compose environment by file, never on the command line', () => {
    const args = buildEndpointProviderHelperArgs({ ...input, mode: 'stage', envFile: '/run/sencho/compose.env' });
    expect(args).toContain('--env-file');
    expect(args).toContain('/run/sencho/compose.env');
    expect(args.join(' ')).not.toContain('SENCHO_HANDOFF_UID=');
  });
});

describe('triggerComposeReapply with the Docker endpoint', () => {
  const request: EndpointProviderRequest = { operationId: OP, service: 'socket-proxy', scope: 'stack', handoffDir, planFile };

  function dockerCalls(): string[][] {
    return mockExecFileAsync.mock.calls.map(call => call[1] as string[]);
  }

  it('validates, stages, writes the plan and spawns the detached helper', async () => {
    mockExecFileAsync.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes('stage')) return { stdout: JSON.stringify({ ok: true, providerImage: 'p:2', previousImageId: 'sha256:old', previousImageRef: 'p:1' }), stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const instance = service();
    await instance.triggerComposeReapply({ endpointProvider: request });

    expect(instance.getLastError()).toBeNull();
    const calls = dockerCalls();
    expect(calls).toHaveLength(3);
    expect(calls[0][calls[0].length - 1]).toMatch(/ config$/);
    expect(calls[1].slice(-2)).toEqual(['stage', OP]);
    expect(calls[2].slice(0, 2)).toEqual(['run', '-d']);
    expect(calls[2].slice(-2)).toEqual(['replace', OP]);
    // Both helper runs must carry this process's uid/gid, or a non-root Sencho
    // cannot read the marker and outcome the root helper writes.
    if (typeof process.getuid === 'function' && typeof process.getgid === 'function') {
      expect(calls[1]).toContain(`SENCHO_HANDOFF_UID=${process.getuid()}`);
      expect(calls[1]).toContain(`SENCHO_HANDOFF_GID=${process.getgid()}`);
      expect(calls[2]).toContain(`SENCHO_HANDOFF_UID=${process.getuid()}`);
      expect(calls[2]).toContain(`SENCHO_HANDOFF_GID=${process.getgid()}`);
    }
    expect(mockExecFile).not.toHaveBeenCalled();
    const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    expect(plan).toMatchObject({
      operationId: OP, mode: 'reapply', project: 'stack', providerService: 'socket-proxy', senchoService: 'sencho',
      providerContainerId: 'proxy-id', composeCopy: null, pruneOnUpdate: false,
    });
  });

  it('hands the process environment to both helper runs and removes the private file afterwards', async () => {
    process.env.SENCHO_ENDPOINT_TEST_TOKEN = 'compose-value';
    const seen: string[] = [];
    const files: string[] = [];
    mockExecFileAsync.mockImplementation(async (_cmd: string, args: string[]) => {
      const index = args.indexOf('--env-file');
      if (index !== -1) {
        const file = args[index + 1];
        files.push(file);
        expect(fs.existsSync(file)).toBe(true);
        seen.push(fs.readFileSync(file, 'utf8'));
      }
      if (args.includes('stage')) return { stdout: JSON.stringify({ ok: true, providerImage: 'p:2', previousImageId: 'sha256:old', previousImageRef: null }), stderr: '' };
      return { stdout: '', stderr: '' };
    });
    try {
      await service().triggerComposeReapply({ endpointProvider: request });
      expect(seen.join('\n')).toContain('SENCHO_ENDPOINT_TEST_TOKEN=compose-value');
      expect(files.length).toBeGreaterThanOrEqual(2);
      for (const file of files) expect(fs.existsSync(file)).toBe(false);
    } finally {
      delete process.env.SENCHO_ENDPOINT_TEST_TOKEN;
    }
  });

  it('writes a provider-scoped plan when the operator chose endpoint-only', async () => {
    mockExecFileAsync.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes('stage')) return { stdout: JSON.stringify({ ok: true, providerImage: 'p:2', previousImageId: 'sha256:old', previousImageRef: 'p:1' }), stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const instance = service();
    await instance.triggerComposeReapply({ endpointProvider: { ...request, scope: 'provider' } });
    expect(instance.getLastError()).toBeNull();
    expect(JSON.parse(fs.readFileSync(planFile, 'utf8'))).toMatchObject({ mode: 'reapply', scope: 'provider' });
    expect(dockerCalls()).toHaveLength(3);
  });

  it('refuses an endpoint-only replacement from an image update, which recreates Sencho', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
    const instance = service();
    await instance.triggerUpdate({ endpointProvider: { ...request, scope: 'provider' } });
    expect(instance.getLastError()).toContain('cannot replace only the Docker endpoint');
    expect(dockerCalls().some(args => args.includes('stage'))).toBe(false);
  });

  it('stops before anything is recreated when staging refuses', async () => {
    mockExecFileAsync.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes('stage')) {
        throw Object.assign(new Error('exit 1'), { stdout: JSON.stringify({ ok: false, message: 'The host socket the Docker endpoint mounts does not show its container.' }), stderr: '' });
      }
      return { stdout: '', stderr: '' };
    });
    const instance = service();
    await instance.triggerComposeReapply({ endpointProvider: request });
    expect(instance.getLastError()).toBe('Nothing was stopped. The host socket the Docker endpoint mounts does not show its container.');
    expect(instance.getLastErrorCode()).toBe('endpoint_provider_refused');
    expect(dockerCalls().some(args => args.includes('replace'))).toBe(false);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('refuses when the provider changed since the operator confirmed', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
    mockResolveProvider.mockResolvedValue(resolved({ service: 'docker-proxy' }));
    const instance = service();
    await instance.triggerComposeReapply({ endpointProvider: request });
    expect(instance.getLastError()).toContain('changed from "socket-proxy" to "docker-proxy"');
    expect(dockerCalls().some(args => args.includes('stage'))).toBe(false);
  });

  it('refuses when the provider is no longer replaceable at run time', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
    mockResolveProvider.mockResolvedValue(resolved({ socketBindSource: null }));
    const instance = service();
    await instance.triggerComposeReapply({ endpointProvider: request });
    expect(instance.getLastError()).toContain('does not bind-mount the host Docker socket');
  });

  it('reports a helper that cannot start as nothing stopped', async () => {
    mockExecFileAsync.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes('stage')) return { stdout: JSON.stringify({ ok: true, providerImage: 'p', previousImageId: 'sha256:old', previousImageRef: null }), stderr: '' };
      if (args.includes('replace')) throw Object.assign(new Error('exit 125'), { stderr: 'No such image: sha256:running' });
      return { stdout: '', stderr: '' };
    });
    const instance = service();
    await instance.triggerComposeReapply({ endpointProvider: request });
    expect(instance.getLastError()).toContain('Nothing was stopped. The replacement helper could not start: No such image');
    expect(instance.getLastErrorCode()).toBe('endpoint_provider_refused');
  });

  it('does not claim nothing stopped when the detached helper start is unconfirmed', async () => {
    mockExecFileAsync.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes('stage')) return { stdout: JSON.stringify({ ok: true, providerImage: 'p', previousImageId: 'sha256:old', previousImageRef: null }), stderr: '' };
      if (args.includes('replace')) throw Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM', stderr: '' });
      return { stdout: '', stderr: '' };
    });
    const instance = service();
    await instance.triggerComposeReapply({ endpointProvider: request });
    // The helper may have been created before its answer was lost. The outcome
    // watcher decides instead of a false "nothing was stopped" failure.
    expect(instance.getLastError()).toBeNull();
    expect(instance.getLastErrorCode()).toBeNull();
  });

  it('keeps the Sencho-only Reapply on the attached helper with --no-deps', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
    await service().triggerComposeReapply();
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain('/var/run/docker.sock:/var/run/docker.sock');
    expect(args[args.length - 1]).toContain("up -d --no-deps --force-recreate 'sencho'");
    expect(mockResolveProvider).not.toHaveBeenCalled();
  });
});

describe('triggerUpdate with the Docker endpoint', () => {
  it('pulls Sencho first, then stages the provider in update mode with prune enabled', async () => {
    mockExecFileAsync.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes('stage')) return { stdout: JSON.stringify({ ok: true, providerImage: 'p:2', previousImageId: 'sha256:old', previousImageRef: 'p:1' }), stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const instance = service();
    await instance.triggerUpdate({ endpointProvider: { operationId: OP, service: 'socket-proxy', scope: 'stack', handoffDir, planFile } });
    const calls = mockExecFileAsync.mock.calls.map(call => call[1] as string[]);
    expect(calls[0]).toEqual(['pull', 'saelix/sencho:0.99.0']);
    expect(calls[1].slice(-2)).toEqual(['stage', OP]);
    expect(JSON.parse(fs.readFileSync(planFile, 'utf8'))).toMatchObject({ mode: 'update', pruneOnUpdate: true });
  });

  it('does not stage when the Sencho pull fails', async () => {
    mockExecFileAsync.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'pull') throw Object.assign(new Error('pull'), { stderr: 'manifest unknown' });
      return { stdout: '', stderr: '' };
    });
    const instance = service();
    await instance.triggerUpdate({ endpointProvider: { operationId: OP, service: 'socket-proxy', scope: 'stack', handoffDir, planFile } });
    expect(instance.getLastError()).toBe('manifest unknown');
    expect(mockExecFileAsync.mock.calls.some(call => (call[1] as string[]).includes('stage'))).toBe(false);
  });
});

describe('parseStageResult', () => {
  it('reads the helper JSON and treats anything else as unreadable', () => {
    expect(parseStageResult('{"ok":false,"message":"no socket"}')).toEqual({ ok: false, message: 'no socket' });
    expect(parseStageResult('garbage')).toEqual({ ok: false, message: 'The staging helper returned no readable result.' });
    expect(parseStageResult('{"ok":true}')).toMatchObject({ ok: false });
  });
});
