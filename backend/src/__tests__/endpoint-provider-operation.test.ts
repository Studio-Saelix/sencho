/**
 * ImageOperationService side of the Docker endpoint replacement: the claim
 * records the confirmed provider, the process that spawned the helper reports
 * a provider-phase failure, and the new process answers the helper (ack) and
 * marks success only on the helper's positive verdict.
 */
import fs from 'fs/promises';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanupTestDb, setupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let ImageOperationService: typeof import('../services/ImageOperationService').ImageOperationService;
let SelfUpdateService: typeof import('../services/SelfUpdateService').default;
let selfUpdateModule: typeof import('../services/SelfUpdateService');
let DockerController: typeof import('../services/DockerController').default;
let FleetUpdateTrackerService: typeof import('../services/FleetUpdateTrackerService').FleetUpdateTrackerService;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ ImageOperationService } = await import('../services/ImageOperationService'));
  selfUpdateModule = await import('../services/SelfUpdateService');
  SelfUpdateService = selfUpdateModule.default;
  DockerController = (await import('../services/DockerController')).default;
  ({ FleetUpdateTrackerService } = await import('../services/FleetUpdateTrackerService'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  const service = ImageOperationService.getInstance() as unknown as {
    endpointProviderPending: boolean;
    endpointProviderTimings: Record<string, number>;
  };
  service.endpointProviderPending = false;
  service.endpointProviderTimings = {
    pollMs: 2_000,
    requestMs: 10_000,
    verifyMs: 90_000,
    outcomeMs: selfUpdateModule.SELF_UPDATE_PULL_TIMEOUT_MS + selfUpdateModule.ENDPOINT_PROVIDER_STAGE_TIMEOUT_MS
      + selfUpdateModule.ENDPOINT_PROVIDER_LAUNCH_TIMEOUT_MS + selfUpdateModule.ENDPOINT_PROVIDER_HELPER_MAX_LIFETIME_MS + 60_000,
    watchMs: selfUpdateModule.ENDPOINT_PROVIDER_HELPER_MAX_LIFETIME_MS,
    recoveryMs: 15_000,
  };
  SelfUpdateService.getInstance().clearLastError();
  for (const [nodeId] of [...FleetUpdateTrackerService.getInstance().entries()]) FleetUpdateTrackerService.getInstance().delete(nodeId);
  await fs.rm(path.join(tmpDir, 'image-operation-current.json'), { force: true });
  await fs.rm(path.join(tmpDir, 'image-operations'), { recursive: true, force: true });
  await fs.rm(path.join(tmpDir, 'endpoint-provider'), { recursive: true, force: true });
});

afterAll(() => cleanupTestDb(tmpDir));

function fastTimings() {
  const service = ImageOperationService.getInstance();
  service.endpointProviderTimings = { pollMs: 5, requestMs: 20, verifyMs: 60, outcomeMs: 200, watchMs: 200, recoveryMs: 20 };
  return service;
}

function mockAvailableProvider() {
  const selfUpdate = SelfUpdateService.getInstance();
  vi.spyOn(selfUpdate, 'getEndpointProviderOption').mockResolvedValue({ state: 'available', service: 'socket-proxy', containerName: 'stack-socket-proxy-1', providerOnly: true, project: 'stack' });
  vi.spyOn(selfUpdate, 'getComposeProject').mockReturnValue('stack');
  vi.spyOn(selfUpdate, 'getResolvedComposeImageForUpdate').mockResolvedValue(null);
  vi.spyOn(selfUpdate, 'getComposeServiceName').mockReturnValue('sencho');
  return selfUpdate;
}

function handoff(operationId: string, file: 'ack' | 'outcome' | 'plan') {
  return path.join(tmpDir, 'endpoint-provider', operationId, `${file}.json`);
}

async function writeOutcome(operationId: string, outcome: Record<string, unknown>) {
  await fs.mkdir(path.dirname(handoff(operationId, 'outcome')), { recursive: true });
  await fs.writeFile(handoff(operationId, 'outcome'), JSON.stringify({ operationId, ...outcome }));
}

/** A Docker that answers through the new provider, with the provider running and the given health. */
interface MockDockerOptions {
  ping?: (options?: { abortSignal?: AbortSignal }) => Promise<unknown>;
  listContainers?: (options?: { filters?: { label?: string[] } }) => Promise<unknown>;
  inspect?: () => Promise<unknown>;
  running?: boolean;
  health?: string;
  /** Whether the detached helper still appears in Docker's list. */
  helperRunning?: boolean;
}

function mockDocker(options: MockDockerOptions = {}) {
  const defaultList = async (listOptions?: { filters?: { label?: string[] } }) => {
    const labels = listOptions?.filters?.label ?? [];
    if (labels.some(label => label.startsWith('io.sencho.operation='))) {
      return options.helperRunning ? [{ Id: 'helper-container', State: 'running' }] : [];
    }
    return options.running === false ? [] : [{ Id: 'new-proxy', State: 'running' }];
  };
  const docker = {
    ping: options.ping ?? (async () => 'OK'),
    listContainers: vi.fn(options.listContainers ?? defaultList),
    getContainer: () => ({
      inspect: options.inspect ?? (async () => ({ State: { Health: options.health ? { Status: options.health } : undefined } })),
    }),
  };
  const resetDockerConnection = vi.fn();
  vi.spyOn(DockerController, 'getInstance').mockReturnValue({
    getDocker: () => docker,
    resetDockerConnection,
  } as unknown as ReturnType<typeof DockerController.getInstance>);
  return { ...docker, resetDockerConnection };
}

function recreatedMarker(operationId: string) {
  return path.join(tmpDir, 'endpoint-provider', operationId, 'provider-recreated.json');
}

async function writeRecreatedMarker(operationId: string) {
  await fs.mkdir(path.dirname(recreatedMarker(operationId)), { recursive: true });
  await fs.writeFile(recreatedMarker(operationId), JSON.stringify({ operationId, at: 1 }));
}

function localNodeId(): number {
  return DatabaseService.getInstance().getNodes().find(node => node.type === 'local')!.id;
}

describe('claim', () => {
  it('records the confirmed provider on the operation', async () => {
    mockAvailableProvider();
    const service = ImageOperationService.getInstance();
    await expect(service.claimComposeReapply({ replace: true })).resolves.toEqual({ ok: true });
    const operation = await service.getCurrentOperation();
    expect(operation?.endpointProvider).toEqual({ project: 'stack', service: 'socket-proxy', containerName: 'stack-socket-proxy-1', scope: 'stack' });
  });

  it('refuses with the reason when the provider cannot be replaced, and claims nothing', async () => {
    const selfUpdate = mockAvailableProvider();
    vi.mocked(selfUpdate.getEndpointProviderOption).mockResolvedValue({ state: 'unavailable', service: 'proxy', reason: '"proxy" does not bind-mount the host Docker socket.' });
    const service = ImageOperationService.getInstance();
    await expect(service.claimCommunityUpdate({ replaceEndpointProvider: true })).resolves.toEqual({
      ok: false, failureCode: 'endpoint_provider_unavailable', reason: '"proxy" does not bind-mount the host Docker socket.',
    });
    await expect(service.getCurrentOperation()).resolves.toBeNull();
  });

  it('refuses when there is no provider at all', async () => {
    const selfUpdate = mockAvailableProvider();
    vi.mocked(selfUpdate.getEndpointProviderOption).mockResolvedValue({ state: 'none' });
    const result = await ImageOperationService.getInstance().claimComposeReapply({ replace: true });
    expect(result).toMatchObject({ ok: false, failureCode: 'endpoint_provider_unavailable' });
  });

  it('rejects a concurrent operation while a replacement is claimed', async () => {
    mockAvailableProvider();
    const service = ImageOperationService.getInstance();
    await service.claimComposeReapply({ replace: true });
    await expect(service.claimCommunityUpdate()).resolves.toEqual({ ok: false, failureCode: 'IMAGE_OPERATION_IN_FLIGHT' });
  });

  it('leaves a Sencho-only claim without a provider and never asks for one', async () => {
    const selfUpdate = mockAvailableProvider();
    await ImageOperationService.getInstance().claimComposeReapply();
    expect((await ImageOperationService.getInstance().getCurrentOperation())?.endpointProvider).toBeUndefined();
    expect(selfUpdate.getEndpointProviderOption).not.toHaveBeenCalled();
  });
});

describe('execute (the process that spawns the helper)', () => {
  it('passes the provider request to the helper and stays pending', async () => {
    const selfUpdate = mockAvailableProvider();
    const trigger = vi.spyOn(selfUpdate, 'triggerComposeReapply').mockResolvedValue(undefined);
    const service = fastTimings();
    await service.claimComposeReapply({ replace: true });
    const operation = (await service.getCurrentOperation())!;
    await expect(service.executeClaimedComposeReapply()).resolves.toEqual({ ok: true });
    expect(trigger).toHaveBeenCalledWith(expect.objectContaining({
      endpointProvider: {
        operationId: operation.operationId,
        service: 'socket-proxy',
        scope: 'stack',
        handoffDir: path.join(tmpDir, 'endpoint-provider', operation.operationId),
        planFile: handoff(operation.operationId, 'plan'),
      },
    }));
    expect(service.isEndpointProviderPending()).toBe(true);
  });

  it('fails with the staging refusal and clears pending when nothing was stopped', async () => {
    const selfUpdate = mockAvailableProvider();
    vi.spyOn(selfUpdate, 'triggerComposeReapply').mockImplementation(async () => {
      selfUpdate.recordUpdateFailure('Nothing was stopped. Socket unreachable.', 'update_failed');
    });
    const service = fastTimings();
    await service.claimComposeReapply({ replace: true });
    await expect(service.executeClaimedComposeReapply()).resolves.toEqual({ ok: false, failureCode: 'update_failed' });
    const operation = await service.getCurrentOperation();
    expect(operation).toMatchObject({ state: 'failed', failureCode: 'update_failed', failureDetail: 'Nothing was stopped. Socket unreachable.' });
    expect(service.isEndpointProviderPending()).toBe(false);
  });

  it('records a provider-phase failure the helper restored while this process still runs', async () => {
    const selfUpdate = mockAvailableProvider();
    const service = fastTimings();
    const docker = mockDocker();
    await service.claimComposeReapply({ replace: true });
    const operationId = (await service.getCurrentOperation())!.operationId;
    vi.spyOn(selfUpdate, 'triggerComposeReapply').mockImplementation(async () => {
      await writeOutcome(operationId, { ok: false, phase: 'provider', error: 'container is unhealthy', rollback: { restored: true, error: null } });
    });
    await service.executeClaimedComposeReapply();
    await vi.waitFor(async () => expect((await service.getCurrentOperation())?.state).toBe('failed'));
    const operation = await service.getCurrentOperation();
    expect(operation).toMatchObject({
      failureCode: 'endpoint_provider_restored',
      rollback: { attempted: true, restored: true, error: null },
      failureDetail: expect.stringContaining('was restored and Sencho reaches Docker again'),
    });
    expect(docker.listContainers).toHaveBeenCalled();
    expect(selfUpdate.getLastErrorCode()).toBe('endpoint_provider_restored');
    expect(service.isEndpointProviderPending()).toBe(false);
  });

  it('marks recovery required when the helper never reports within the bound', async () => {
    const selfUpdate = mockAvailableProvider();
    vi.spyOn(selfUpdate, 'triggerComposeReapply').mockResolvedValue(undefined);
    const service = fastTimings();
    await service.claimComposeReapply({ replace: true });
    await service.executeClaimedComposeReapply();
    await vi.waitFor(async () => expect((await service.getCurrentOperation())?.state).toBe('failed'), { timeout: 2_000 });
    expect(await service.getCurrentOperation()).toMatchObject({
      failureCode: 'endpoint_provider_recovery_required',
      rollback: { attempted: false },
      failureDetail: expect.stringContaining('did not report an outcome in time'),
    });
  });

  it('does not claim a restore when the helper failed before touching the endpoint', async () => {
    const selfUpdate = mockAvailableProvider();
    const service = fastTimings();
    const docker = mockDocker();
    await service.claimComposeReapply({ replace: true });
    const operationId = (await service.getCurrentOperation())!.operationId;
    await writeOutcome(operationId, {
      ok: false,
      phase: 'provider',
      error: 'Failed to write the updated compose file: ENOSPC',
      rollback: { attempted: false, restored: false, error: null },
    });
    vi.spyOn(selfUpdate, 'triggerComposeReapply').mockResolvedValue(undefined);
    await service.executeClaimedComposeReapply();
    await vi.waitFor(async () => expect((await service.getCurrentOperation())?.state).toBe('failed'));
    const operation = await service.getCurrentOperation();
    expect(operation).toMatchObject({
      failureCode: 'update_failed',
      rollback: { attempted: false },
      failureDetail: expect.stringContaining('did not start'),
    });
    expect(operation?.failureDetail).not.toContain('was restored');
    expect(docker.listContainers).not.toHaveBeenCalled();
    expect(selfUpdate.getLastErrorCode()).toBe('update_failed');
    expect(FleetUpdateTrackerService.getInstance().get(localNodeId())).toMatchObject({ status: 'failed' });
  });

  it('does not claim a stack-scope restore reaches Docker when this process still cannot', async () => {
    const selfUpdate = mockAvailableProvider();
    vi.spyOn(selfUpdate, 'triggerComposeReapply').mockResolvedValue(undefined);
    const service = fastTimings();
    mockDocker({ ping: async () => { throw new Error('connect ECONNREFUSED'); } });
    await service.claimComposeReapply({ replace: true });
    const operationId = (await service.getCurrentOperation())!.operationId;
    await writeOutcome(operationId, { ok: false, phase: 'verify', error: 'Sencho could not use Docker', rollback: { restored: true, error: null } });
    await service.executeClaimedComposeReapply();
    await vi.waitFor(async () => expect((await service.getCurrentOperation())?.state).toBe('failed'));
    const operation = await service.getCurrentOperation();
    expect(operation).toMatchObject({ failureCode: 'endpoint_provider_recovery_required' });
    expect(operation?.failureDetail).toContain('was restored, but Sencho could not reach Docker through it');
  });

  it('terminalizes the operation when the stack-scope watcher throws', async () => {
    const selfUpdate = mockAvailableProvider();
    vi.spyOn(selfUpdate, 'triggerComposeReapply').mockResolvedValue(undefined);
    const service = fastTimings();
    vi.spyOn(DockerController, 'getInstance').mockImplementation(() => {
      throw new Error('probe: Docker controller unavailable');
    });
    await service.claimComposeReapply({ replace: true });
    const operationId = (await service.getCurrentOperation())!.operationId;
    await writeOutcome(operationId, { ok: false, phase: 'verify', error: 'restored', rollback: { attempted: true, restored: true, error: null } });
    await service.executeClaimedComposeReapply();
    await vi.waitFor(async () => expect((await service.getCurrentOperation())?.state).toBe('failed'), { timeout: 2_000 });
    const operation = await service.getCurrentOperation();
    expect(operation).toMatchObject({ failureCode: 'endpoint_provider_recovery_required' });
    expect(operation?.failureDetail).toContain('waiting for or applying the helper');
    expect(service.isEndpointProviderPending()).toBe(false);
    expect(selfUpdate.getLastErrorCode()).toBe('endpoint_provider_recovery_required');
    expect(FleetUpdateTrackerService.getInstance().get(localNodeId())).toMatchObject({ status: 'failed' });
    await expect(service.claimComposeReapply({ replace: true })).resolves.toEqual({ ok: true });
  });

  it('checks restored connectivity for a shared Update too, not only Reapply', async () => {
    const selfUpdate = mockAvailableProvider();
    vi.spyOn(selfUpdate, 'triggerUpdate').mockResolvedValue(undefined);
    const service = fastTimings();
    mockDocker({ ping: async () => { throw new Error('connect ECONNREFUSED'); } });
    await service.claimCommunityUpdate({ replaceEndpointProvider: true });
    const operation = (await service.getCurrentOperation())!;
    expect(operation.endpointProvider).toMatchObject({ scope: 'stack' });
    await writeOutcome(operation.operationId, { ok: false, phase: 'verify', error: 'Sencho could not use Docker', rollback: { restored: true, error: null } });
    await service.executeClaimedCommunityUpdate();
    await vi.waitFor(async () => expect((await service.getCurrentOperation())?.state).toBe('failed'));
    expect((await service.getCurrentOperation())?.failureCode).toBe('endpoint_provider_recovery_required');
  });
});


describe('provider-only reapply (Sencho stays running)', () => {
  it('records the provider-only scope on the claim', async () => {
    mockAvailableProvider();
    const service = ImageOperationService.getInstance();
    await expect(service.claimComposeReapply({ replace: true, only: true })).resolves.toEqual({ ok: true });
    expect((await service.getCurrentOperation())?.endpointProvider).toMatchObject({ scope: 'provider' });
  });

  it('waits for the helper phase marker before answering, then succeeds on its verdict', async () => {
    const selfUpdate = mockAvailableProvider();
    vi.spyOn(selfUpdate, 'triggerComposeReapply').mockResolvedValue(undefined);
    const service = fastTimings();
    service.endpointProviderTimings = { ...service.endpointProviderTimings, watchMs: 5_000 };
    mockDocker({ health: 'healthy', helperRunning: true });
    await service.claimComposeReapply({ replace: true, only: true });
    const operationId = (await service.getCurrentOperation())!.operationId;
    await service.executeClaimedComposeReapply();
    // The row this process installs replaces the route's row; it must keep the
    // flag that stops the five-minute sweep from timing out a replacement.
    expect(FleetUpdateTrackerService.getInstance().get(localNodeId())).toMatchObject({
      status: 'updating',
      endpointProviderPending: true,
    });

    // Before the provider exists there is nothing to verify: no ack may be written.
    await new Promise(resolve => setTimeout(resolve, 50));
    await expect(fs.access(handoff(operationId, 'ack'))).rejects.toThrow();
    expect(vi.mocked(DockerController.getInstance().resetDockerConnection)).not.toHaveBeenCalled();

    await writeRecreatedMarker(operationId);
    await vi.waitFor(async () => {
      const ack = JSON.parse(await fs.readFile(handoff(operationId, 'ack'), 'utf8'));
      expect(ack).toEqual({ operationId, ok: true, detail: null });
    });
    expect(FleetUpdateTrackerService.getInstance().get(localNodeId())).toMatchObject({ status: 'updating', operationKind: 'reapply_configuration' });

    await writeOutcome(operationId, { ok: true });
    await vi.waitFor(async () => expect((await service.getCurrentOperation())?.state).toBe('succeeded'));
    expect(service.isEndpointProviderPending()).toBe(false);
    expect(FleetUpdateTrackerService.getInstance().get(localNodeId())).toMatchObject({ status: 'completed' });
  });

  it('answers negatively when Docker does not answer through the replacement, and never clears the guard by itself', async () => {
    const selfUpdate = mockAvailableProvider();
    vi.spyOn(selfUpdate, 'triggerComposeReapply').mockResolvedValue(undefined);
    const service = fastTimings();
    mockDocker({ ping: async () => { throw new Error('connect ECONNREFUSED'); }, helperRunning: true });
    await service.claimComposeReapply({ replace: true, only: true });
    const operationId = (await service.getCurrentOperation())!.operationId;
    await service.executeClaimedComposeReapply();
    await writeRecreatedMarker(operationId);
    await vi.waitFor(async () => {
      const ack = JSON.parse(await fs.readFile(handoff(operationId, 'ack'), 'utf8'));
      expect(ack).toMatchObject({ ok: false });
    });
    await writeOutcome(operationId, { ok: false, phase: 'verify', error: 'Sencho could not use Docker', rollback: { restored: true, error: null } });
    await vi.waitFor(async () => expect((await service.getCurrentOperation())?.state).toBe('failed'));
    const operation = await service.getCurrentOperation();
    // Docker is unreachable in this fixture, so the restored container cannot be
    // confirmed reachable either: that is a recovery state, not a clean restore.
    expect(operation).toMatchObject({ failureCode: 'endpoint_provider_recovery_required' });
    expect(operation?.failureDetail).toContain('was restored, but Sencho could not reach Docker through it');
  });

  it('never answers the helper before the provider exists: no marker, no ack, no success', async () => {
    const selfUpdate = mockAvailableProvider();
    vi.spyOn(selfUpdate, 'triggerComposeReapply').mockResolvedValue(undefined);
    const service = fastTimings();
    const docker = mockDocker({ health: 'healthy' });
    await service.claimComposeReapply({ replace: true, only: true });
    const operationId = (await service.getCurrentOperation())!.operationId;
    await service.executeClaimedComposeReapply();
    // A stalled recreate (no phase marker) must not be verified against the old,
    // still-healthy provider: that would let the helper accept a false ack.
    await vi.waitFor(async () => expect((await service.getCurrentOperation())?.state).toBe('failed'), { timeout: 2_000 });
    await expect(fs.access(handoff(operationId, 'ack'))).rejects.toThrow();
    expect(docker.resetDockerConnection).not.toHaveBeenCalled();
    expect((await service.getCurrentOperation())?.failureCode).toBe('endpoint_provider_recovery_required');
  });

  it('still reports the restore as successful after re-checking Docker through the restored container', async () => {
    const selfUpdate = mockAvailableProvider();
    vi.spyOn(selfUpdate, 'triggerComposeReapply').mockImplementation(async () => {
      // The helper recreates and then restores the provider within this call.
    });
    const service = fastTimings();
    const docker = mockDocker();
    await service.claimComposeReapply({ replace: true, only: true });
    const operationId = (await service.getCurrentOperation())!.operationId;
    await writeRecreatedMarker(operationId);
    await writeOutcome(operationId, { ok: false, phase: 'provider', error: 'container is unhealthy', rollback: { restored: true, error: null } });
    await service.executeClaimedComposeReapply();
    await vi.waitFor(async () => expect((await service.getCurrentOperation())?.state).toBe('failed'));
    expect(docker.resetDockerConnection).toHaveBeenCalled();
    expect((await service.getCurrentOperation())?.failureCode).toBe('endpoint_provider_restored');
  });

  it('does not claim a restore worked when Sencho still cannot reach the restored container', async () => {
    const selfUpdate = mockAvailableProvider();
    vi.spyOn(selfUpdate, 'triggerComposeReapply').mockResolvedValue(undefined);
    const service = fastTimings();
    mockDocker({ ping: async () => { throw new Error('connect ECONNREFUSED'); } });
    await service.claimComposeReapply({ replace: true, only: true });
    const operationId = (await service.getCurrentOperation())!.operationId;
    await writeOutcome(operationId, { ok: false, phase: 'provider', error: 'container is unhealthy', rollback: { restored: true, error: null } });
    await service.executeClaimedComposeReapply();
    await vi.waitFor(async () => expect((await service.getCurrentOperation())?.state).toBe('failed'));
    const operation = await service.getCurrentOperation();
    expect(operation?.failureCode).toBe('endpoint_provider_recovery_required');
    expect(operation?.failureDetail).toContain('was restored, but Sencho could not reach Docker through it');
  });
});

describe('bounded verification', () => {
  const never = () => new Promise<never>(() => {});

  it.each([
    ['ping', { ping: never }],
    ['container list', { listContainers: never }],
    ['inspect', { inspect: never }],
  ] as Array<[string, MockDockerOptions]>)('settles the operation when %s never answers and the helper reports a failed restore', async (_label, dockerOptions) => {
    const selfUpdate = mockAvailableProvider();
    vi.spyOn(selfUpdate, 'triggerComposeReapply').mockResolvedValue(undefined);
    const service = fastTimings();
    service.endpointProviderTimings = { pollMs: 5, requestMs: 15, verifyMs: 50, outcomeMs: 200, watchMs: 200, recoveryMs: 30 };
    const docker = mockDocker({ ...dockerOptions, helperRunning: true });
    await service.claimComposeReapply({ replace: true, only: true });
    const operationId = (await service.getCurrentOperation())!.operationId;
    await service.executeClaimedComposeReapply();
    await writeRecreatedMarker(operationId);
    // The bounded verification gives up and answers the helper negatively while
    // the outcome is still unpublished.
    await vi.waitFor(async () => {
      const ack = JSON.parse(await fs.readFile(handoff(operationId, 'ack'), 'utf8'));
      expect(ack).toMatchObject({ operationId, ok: false });
    }, { timeout: 2_000 });
    // The helper then reports that its restore failed after the bounded request
    // had already timed out and the negative ack was written.
    await writeOutcome(operationId, {
      ok: false,
      phase: 'verify',
      error: 'Sencho did not answer',
      rollback: { attempted: true, restored: false, error: 'the new proxy did not start' },
    });

    await vi.waitFor(async () => expect((await service.getCurrentOperation())?.state).toBe('failed'), { timeout: 3_000 });
    const operation = await service.getCurrentOperation();
    expect(operation).toMatchObject({
      failureCode: 'endpoint_provider_recovery_required',
      rollback: { attempted: true, restored: false, error: 'the new proxy did not start' },
    });
    // The helper's own verdict was consumed, not replaced by a timeout message.
    expect(operation?.failureDetail).toContain('Sencho did not answer');
    expect(service.isEndpointProviderPending()).toBe(false);
    // Entry reset plus at least one timeout reset: the stalled client is dropped,
    // not merely abandoned.
    expect(docker.resetDockerConnection.mock.calls.length).toBeGreaterThanOrEqual(2);
    // The terminal verdict released the claim.
    await expect(service.claimComposeReapply({ replace: true, only: true })).resolves.toEqual({ ok: true });
  });

  it('aborts a stalled Docker request and drops the cached client', async () => {
    const selfUpdate = mockAvailableProvider();
    vi.spyOn(selfUpdate, 'triggerComposeReapply').mockResolvedValue(undefined);
    const service = fastTimings();
    service.endpointProviderTimings = { pollMs: 5, requestMs: 15, verifyMs: 50, outcomeMs: 200, watchMs: 200, recoveryMs: 30 };
    let aborted = false;
    const docker = mockDocker({
      helperRunning: true,
      ping: (options) => new Promise<unknown>((_resolve, reject) => {
        options?.abortSignal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      }),
    });
    await service.claimComposeReapply({ replace: true, only: true });
    const operationId = (await service.getCurrentOperation())!.operationId;
    await service.executeClaimedComposeReapply();
    await writeRecreatedMarker(operationId);
    await vi.waitFor(async () => {
      const ack = JSON.parse(await fs.readFile(handoff(operationId, 'ack'), 'utf8'));
      expect(ack).toMatchObject({ operationId, ok: false });
    }, { timeout: 2_000 });
    await writeOutcome(operationId, { ok: false, phase: 'verify', error: 'stalled', rollback: { restored: true, error: null } });
    await vi.waitFor(async () => expect((await service.getCurrentOperation())?.state).toBe('failed'), { timeout: 3_000 });
    expect(aborted).toBe(true);
    expect(docker.resetDockerConnection).toHaveBeenCalled();
  });
});

describe('ownership lifetime', () => {
  it('covers the helper\'s full permitted lifetime, not only its marker wait', () => {
    const service = ImageOperationService.getInstance();
    const { ENDPOINT_PROVIDER_HELPER_MAX_LIFETIME_MS } = selfUpdateModule;
    expect(ENDPOINT_PROVIDER_HELPER_MAX_LIFETIME_MS).toBeGreaterThan(20 * 60_000);
    expect(service.endpointProviderTimings.watchMs).toBeGreaterThanOrEqual(ENDPOINT_PROVIDER_HELPER_MAX_LIFETIME_MS);
    expect(service.endpointProviderTimings.outcomeMs).toBeGreaterThanOrEqual(ENDPOINT_PROVIDER_HELPER_MAX_LIFETIME_MS);
  });

  it('keeps the claim while the helper can still mutate, then consumes a late marker and verdict', async () => {
    const selfUpdate = mockAvailableProvider();
    vi.spyOn(selfUpdate, 'triggerComposeReapply').mockResolvedValue(undefined);
    const service = ImageOperationService.getInstance();
    // Scaled lifecycle: the claim is held for the helper's whole window, not
    // only for the first marker poll.
    service.endpointProviderTimings = { pollMs: 5, requestMs: 20, verifyMs: 60, outcomeMs: 5_000, watchMs: 5_000, recoveryMs: 20 };
    mockDocker({ helperRunning: true });
    await service.claimComposeReapply({ replace: true, only: true });
    const operationId = (await service.getCurrentOperation())!.operationId;
    await service.executeClaimedComposeReapply();

    // The old watcher terminalized after its marker deadline even though the
    // helper was still inside Compose. While the helper runs, the claim must
    // stay active and a second replacement must be refused.
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(await service.getCurrentOperation()).toMatchObject({ state: 'recreating' });
    await expect(service.claimComposeReapply({ replace: true, only: true })).resolves.toEqual({
      ok: false, failureCode: 'IMAGE_OPERATION_IN_FLIGHT',
    });
    expect(service.isEndpointProviderPending()).toBe(true);

    // A late marker is still verified and acknowledged; a late verdict decides.
    await writeRecreatedMarker(operationId);
    await vi.waitFor(async () => {
      const ack = JSON.parse(await fs.readFile(handoff(operationId, 'ack'), 'utf8'));
      expect(ack).toEqual({ operationId, ok: true, detail: null });
    });
    await writeOutcome(operationId, { ok: true });
    await vi.waitFor(async () => expect((await service.getCurrentOperation())?.state).toBe('succeeded'));
  });

  it('does not grant a restarted process a fresh helper lifetime', async () => {
    mockAvailableProvider();
    const service = ImageOperationService.getInstance();
    await service.claimComposeReapply({ replace: true });
    const operation = (await service.getCurrentOperation())!;
    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'image-operation-current.json'), 'utf8'));
    raw.state = 'recreating';
    raw.startedAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    await fs.writeFile(path.join(tmpDir, 'image-operation-current.json'), JSON.stringify(raw));
    mockDocker({ helperRunning: false });
    const started = Date.now();
    await service.reconcileOnStartup();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await service.getCurrentOperation()).toMatchObject({
      state: 'failed',
      failureCode: 'endpoint_provider_recovery_required',
    });
    expect(operation.operationId).toBe((await service.getCurrentOperation())?.operationId);
  });
});

describe('reconcileOnStartup (the new process)', () => {
  async function claimRecreating(scope: 'stack' | 'provider' = 'stack') {
    mockAvailableProvider();
    const service = fastTimings();
    await service.claimComposeReapply({ replace: true, only: scope === 'provider' });
    const operation = (await service.getCurrentOperation())!;
    // Persist the state the old process left: recreating, provider recorded.
    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'image-operation-current.json'), 'utf8'));
    raw.state = 'recreating';
    await fs.writeFile(path.join(tmpDir, 'image-operation-current.json'), JSON.stringify(raw));
    return { service, operationId: operation.operationId };
  }

  it('reports pending while startup is still reading the previous operation', async () => {
    const service = ImageOperationService.getInstance();
    let release!: (value: null) => void;
    vi.spyOn(service, 'getCurrentOperation').mockReturnValue(new Promise<null>(resolve => { release = resolve; }));
    const reconcile = service.reconcileOnStartup();
    // /api/meta can answer before the operation file is read. Without this the
    // changed process start alone would complete a remote Reapply.
    expect(service.isEndpointProviderPending()).toBe(true);
    release(null);
    await reconcile;
    expect(service.isEndpointProviderPending()).toBe(false);
  });

  it('answers the helper after Docker works through the new provider, and succeeds on its verdict', async () => {
    const { service, operationId } = await claimRecreating();
    mockDocker({ health: 'healthy', helperRunning: true });
    await writeRecreatedMarker(operationId);
    const reconcile = service.reconcileOnStartup();
    await vi.waitFor(async () => {
      const ack = JSON.parse(await fs.readFile(handoff(operationId, 'ack'), 'utf8'));
      expect(ack).toEqual({ operationId, ok: true, detail: null });
    });
    expect(service.isEndpointProviderPending()).toBe(true);
    expect(FleetUpdateTrackerService.getInstance().get(localNodeId())).toMatchObject({ status: 'updating', operationKind: 'reapply_configuration' });
    await writeOutcome(operationId, { ok: true });
    await reconcile;
    expect(await service.getCurrentOperation()).toMatchObject({ state: 'succeeded' });
    expect(service.isEndpointProviderPending()).toBe(false);
    expect(FleetUpdateTrackerService.getInstance().get(localNodeId())).toMatchObject({ status: 'completed' });
    await expect(fs.access(path.dirname(handoff(operationId, 'ack')))).rejects.toThrow();
  });

  it('applies the same marker gate to a claimed Update and can succeed on its verdict', async () => {
    mockAvailableProvider();
    const service = fastTimings();
    await service.claimCommunityUpdate({ replaceEndpointProvider: true });
    const operation = (await service.getCurrentOperation())!;
    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'image-operation-current.json'), 'utf8'));
    raw.state = 'recreating';
    await fs.writeFile(path.join(tmpDir, 'image-operation-current.json'), JSON.stringify(raw));
    mockDocker({ health: 'healthy', helperRunning: true });
    await writeRecreatedMarker(operation.operationId);
    const reconcile = service.reconcileOnStartup();
    await vi.waitFor(async () => {
      const ack = JSON.parse(await fs.readFile(handoff(operation.operationId, 'ack'), 'utf8'));
      expect(ack).toEqual({ operationId: operation.operationId, ok: true, detail: null });
    });
    await writeOutcome(operation.operationId, { ok: true });
    await reconcile;
    expect(await service.getCurrentOperation()).toMatchObject({ kind: 'community_update', state: 'succeeded' });
  });

  it('bounds startup verification when Docker never answers and still consumes a failed outcome', async () => {
    const { service, operationId } = await claimRecreating();
    service.endpointProviderTimings = { pollMs: 5, requestMs: 15, verifyMs: 40, outcomeMs: 200, watchMs: 200, recoveryMs: 20 };
    mockDocker({ ping: () => new Promise<never>(() => {}), helperRunning: true });
    await writeRecreatedMarker(operationId);
    const reconcile = service.reconcileOnStartup();
    await vi.waitFor(async () => {
      const ack = JSON.parse(await fs.readFile(handoff(operationId, 'ack'), 'utf8'));
      expect(ack).toMatchObject({ operationId, ok: false });
    }, { timeout: 2_000 });
    await writeOutcome(operationId, {
      ok: false,
      phase: 'verify',
      error: 'helper timed out',
      rollback: { attempted: true, restored: true, error: null },
    });
    await reconcile;
    expect(await service.getCurrentOperation()).toMatchObject({
      failureCode: 'endpoint_provider_recovery_required',
      rollback: { attempted: true, restored: false },
    });
    expect(service.isEndpointProviderPending()).toBe(false);
  });

  it('applies the marker gate to a claimed Update as well: no marker, no ack, recovery required', async () => {
    const selfUpdate = mockAvailableProvider();
    const service = fastTimings();
    await service.claimCommunityUpdate({ replaceEndpointProvider: true });
    const operation = (await service.getCurrentOperation())!;
    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'image-operation-current.json'), 'utf8'));
    raw.state = 'recreating';
    await fs.writeFile(path.join(tmpDir, 'image-operation-current.json'), JSON.stringify(raw));
    const docker = mockDocker({ health: 'healthy' });
    await service.reconcileOnStartup();
    await expect(fs.access(handoff(operation.operationId, 'ack'))).rejects.toThrow();
    expect(docker.resetDockerConnection).not.toHaveBeenCalled();
    expect(await service.getCurrentOperation()).toMatchObject({
      kind: 'community_update',
      state: 'failed',
      failureCode: 'endpoint_provider_recovery_required',
    });
    expect(selfUpdate.getLastErrorCode()).toBe('endpoint_provider_recovery_required');
    expect(FleetUpdateTrackerService.getInstance().get(localNodeId())).toMatchObject({ status: 'failed' });
  });

  it('does not answer or succeed after a restart alone: no marker, no verdict means recovery required', async () => {
    const { service, operationId } = await claimRecreating();
    const docker = mockDocker();
    await service.reconcileOnStartup();
    await expect(fs.access(handoff(operationId, 'ack'))).rejects.toThrow();
    expect(docker.resetDockerConnection).not.toHaveBeenCalled();
    expect(await service.getCurrentOperation()).toMatchObject({ state: 'failed', failureCode: 'endpoint_provider_recovery_required' });
    expect(FleetUpdateTrackerService.getInstance().get(localNodeId())).toMatchObject({ status: 'failed', error: expect.stringContaining('did not report an outcome in time') });
  });

  it.each(['stack', 'provider'] as const)(
    'refuses to acknowledge the old provider before the %s-scope recreation marker exists',
    async (scope) => {
      const { service, operationId } = await claimRecreating(scope);
      service.endpointProviderTimings = { ...service.endpointProviderTimings, outcomeMs: 5_000 };
      // The old provider still answers perfectly, which is exactly why startup
      // must not accept it as proof of a replacement.
      let replaced = false;
      const docker = mockDocker({
        health: 'healthy',
        helperRunning: true,
        ping: async () => {
          if (replaced) throw new Error('connect ECONNREFUSED');
          return 'OK';
        },
      });
      const reconcile = service.reconcileOnStartup();
      await new Promise(resolve => setTimeout(resolve, 60));
      await expect(fs.access(handoff(operationId, 'ack'))).rejects.toThrow();
      expect(docker.resetDockerConnection).not.toHaveBeenCalled();

      // The helper installs a running proxy that denies Docker access; only now
      // may Sencho verify it, answer, and report a failed replacement.
      replaced = true;
      await writeRecreatedMarker(operationId);
      await vi.waitFor(async () => {
        const ack = JSON.parse(await fs.readFile(handoff(operationId, 'ack'), 'utf8'));
        expect(ack).toMatchObject({ operationId, ok: false });
      });
      await writeOutcome(operationId, {
        ok: false,
        phase: 'verify',
        error: 'Sencho could not use Docker through the new proxy',
        rollback: { restored: true, error: null },
      });
      await reconcile;
      expect(await service.getCurrentOperation()).toMatchObject({ state: 'failed', failureCode: 'endpoint_provider_recovery_required' });
      expect(service.isEndpointProviderPending()).toBe(false);
    },
  );

  it('ignores a recreation marker written for another operation and never acknowledges the old provider', async () => {
    const { service, operationId } = await claimRecreating();
    const docker = mockDocker({ health: 'healthy' });
    await fs.mkdir(path.dirname(recreatedMarker(operationId)), { recursive: true });
    await fs.writeFile(recreatedMarker(operationId), JSON.stringify({ operationId: '00000000-0000-4000-8000-000000000000', at: 1 }));
    await service.reconcileOnStartup();
    await expect(fs.access(handoff(operationId, 'ack'))).rejects.toThrow();
    expect(docker.resetDockerConnection).not.toHaveBeenCalled();
    expect(await service.getCurrentOperation()).toMatchObject({ state: 'failed', failureCode: 'endpoint_provider_recovery_required' });
  });

  it('answers negatively when Docker does not answer through the new provider', async () => {
    const { service, operationId } = await claimRecreating();
    mockDocker({ ping: async () => { throw new Error('(HTTP code 403) unexpected - <html><body><h1>403 Forbidden</h1>\nRequest forbidden by administrative rules.\n</body></html>\n'); } });
    await writeRecreatedMarker(operationId);
    const reconcile = service.reconcileOnStartup();
    await vi.waitFor(async () => {
      const ack = JSON.parse(await fs.readFile(handoff(operationId, 'ack'), 'utf8'));
      expect(ack).toMatchObject({ ok: false, detail: 'Docker did not answer through "socket-proxy": (HTTP code 403) unexpected - 403 Forbidden Request forbidden by administrative rules.' });
    });
    await writeOutcome(operationId, { ok: false, phase: 'verify', error: 'Sencho could not use Docker', rollback: { restored: true, error: null } });
    await reconcile;
    // Docker is unreachable in this fixture, so the restored container cannot be
    // confirmed reachable either: that is a recovery state, not a clean restore.
    expect(await service.getCurrentOperation()).toMatchObject({ state: 'failed', failureCode: 'endpoint_provider_recovery_required' });
  });

  it.each([
    ['not running', { running: false }, 'is not running'],
    ['unhealthy', { health: 'unhealthy' }, 'healthcheck is unhealthy'],
    ['still starting', { health: 'starting' }, 'healthcheck is starting'],
  ])('answers negatively when the new provider is %s', async (_label, docker, detail) => {
    const { service, operationId } = await claimRecreating();
    mockDocker(docker);
    await writeRecreatedMarker(operationId);
    const reconcile = service.reconcileOnStartup();
    await vi.waitFor(async () => {
      const ack = JSON.parse(await fs.readFile(handoff(operationId, 'ack'), 'utf8'));
      expect(ack).toMatchObject({ ok: false, detail: expect.stringContaining(detail) });
    });
    await reconcile;
  });

  it('takes an outcome already on disk without waiting (a Sencho-phase failure the helper restored)', async () => {
    const { service, operationId } = await claimRecreating();
    const docker = mockDocker();
    await writeOutcome(operationId, { ok: false, phase: 'sencho', error: 'pull access denied', rollback: { restored: false, error: 'image gone' } });
    await service.reconcileOnStartup();
    expect(await service.getCurrentOperation()).toMatchObject({
      failureCode: 'endpoint_provider_recovery_required',
      rollback: { attempted: true, restored: false, error: 'image gone' },
    });
    expect(docker.listContainers).not.toHaveBeenCalled();
  });

  it('reports a stack-scope restore as clean only after checking Docker through it', async () => {
    const { service, operationId } = await claimRecreating();
    const docker = mockDocker();
    await writeOutcome(operationId, { ok: false, phase: 'verify', error: 'Sencho could not use Docker', rollback: { restored: true, error: null } });
    await service.reconcileOnStartup();
    expect(await service.getCurrentOperation()).toMatchObject({
      failureCode: 'endpoint_provider_restored',
      rollback: { attempted: true, restored: true, error: null },
    });
    expect(docker.listContainers).toHaveBeenCalled();
    expect((await service.getCurrentOperation())?.failureDetail).toContain('was restored and Sencho reaches Docker again');
  });

  it('ignores a verdict written for another operation', async () => {
    const { service, operationId } = await claimRecreating();
    mockDocker();
    await fs.mkdir(path.dirname(handoff(operationId, 'outcome')), { recursive: true });
    await fs.writeFile(handoff(operationId, 'outcome'), JSON.stringify({ operationId: '00000000-0000-4000-8000-000000000000', ok: true }));
    await service.reconcileOnStartup();
    expect(await service.getCurrentOperation()).toMatchObject({ state: 'failed', failureCode: 'endpoint_provider_recovery_required' });
  });

  it('leaves a terminal operation alone', async () => {
    const { service, operationId } = await claimRecreating();
    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'image-operation-current.json'), 'utf8'));
    raw.state = 'failed';
    await fs.writeFile(path.join(tmpDir, 'image-operation-current.json'), JSON.stringify(raw));
    await service.reconcileOnStartup();
    await expect(fs.access(handoff(operationId, 'ack'))).rejects.toThrow();
    expect(service.isEndpointProviderPending()).toBe(false);
  });
});
