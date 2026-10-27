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
let DockerController: typeof import('../services/DockerController').default;
let FleetUpdateTrackerService: typeof import('../services/FleetUpdateTrackerService').FleetUpdateTrackerService;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ ImageOperationService } = await import('../services/ImageOperationService'));
  SelfUpdateService = (await import('../services/SelfUpdateService')).default;
  DockerController = (await import('../services/DockerController')).default;
  ({ FleetUpdateTrackerService } = await import('../services/FleetUpdateTrackerService'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  const service = ImageOperationService.getInstance() as unknown as { endpointProviderPending: boolean };
  service.endpointProviderPending = false;
  SelfUpdateService.getInstance().clearLastError();
  for (const [nodeId] of [...FleetUpdateTrackerService.getInstance().entries()]) FleetUpdateTrackerService.getInstance().delete(nodeId);
  await fs.rm(path.join(tmpDir, 'image-operation-current.json'), { force: true });
  await fs.rm(path.join(tmpDir, 'image-operations'), { recursive: true, force: true });
  await fs.rm(path.join(tmpDir, 'endpoint-provider'), { recursive: true, force: true });
});

afterAll(() => cleanupTestDb(tmpDir));

function fastTimings() {
  const service = ImageOperationService.getInstance();
  service.endpointProviderTimings = { pollMs: 5, verifyMs: 60, outcomeMs: 200, watchMs: 200 };
  return service;
}

function mockAvailableProvider() {
  const selfUpdate = SelfUpdateService.getInstance();
  vi.spyOn(selfUpdate, 'getEndpointProviderOption').mockResolvedValue({ state: 'available', service: 'socket-proxy', containerName: 'stack-socket-proxy-1' });
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
function mockDocker(options: { ping?: () => Promise<unknown>; running?: boolean; health?: string } = {}) {
  const docker = {
    ping: options.ping ?? (async () => 'OK'),
    listContainers: vi.fn(async () => (options.running === false ? [] : [{ Id: 'new-proxy', State: 'running' }])),
    getContainer: () => ({ inspect: async () => ({ State: { Health: options.health ? { Status: options.health } : undefined } }) }),
  };
  vi.spyOn(DockerController, 'getInstance').mockReturnValue({ getDocker: () => docker } as unknown as ReturnType<typeof DockerController.getInstance>);
  return docker;
}

function localNodeId(): number {
  return DatabaseService.getInstance().getNodes().find(node => node.type === 'local')!.id;
}

describe('claim', () => {
  it('records the confirmed provider on the operation', async () => {
    mockAvailableProvider();
    const service = ImageOperationService.getInstance();
    await expect(service.claimComposeReapply({ replaceEndpointProvider: true })).resolves.toEqual({ ok: true });
    const operation = await service.getCurrentOperation();
    expect(operation?.endpointProvider).toEqual({ project: 'stack', service: 'socket-proxy', containerName: 'stack-socket-proxy-1' });
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
    const result = await ImageOperationService.getInstance().claimComposeReapply({ replaceEndpointProvider: true });
    expect(result).toMatchObject({ ok: false, failureCode: 'endpoint_provider_unavailable' });
  });

  it('rejects a concurrent operation while a replacement is claimed', async () => {
    mockAvailableProvider();
    const service = ImageOperationService.getInstance();
    await service.claimComposeReapply({ replaceEndpointProvider: true });
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
    await service.claimComposeReapply({ replaceEndpointProvider: true });
    const operation = (await service.getCurrentOperation())!;
    await expect(service.executeClaimedComposeReapply()).resolves.toEqual({ ok: true });
    expect(trigger).toHaveBeenCalledWith(expect.objectContaining({
      endpointProvider: {
        operationId: operation.operationId,
        service: 'socket-proxy',
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
    await service.claimComposeReapply({ replaceEndpointProvider: true });
    await expect(service.executeClaimedComposeReapply()).resolves.toEqual({ ok: false, failureCode: 'update_failed' });
    const operation = await service.getCurrentOperation();
    expect(operation).toMatchObject({ state: 'failed', failureCode: 'update_failed', failureDetail: 'Nothing was stopped. Socket unreachable.' });
    expect(service.isEndpointProviderPending()).toBe(false);
  });

  it('records a provider-phase failure the helper restored while this process still runs', async () => {
    const selfUpdate = mockAvailableProvider();
    const service = fastTimings();
    await service.claimComposeReapply({ replaceEndpointProvider: true });
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
    expect(selfUpdate.getLastErrorCode()).toBe('endpoint_provider_restored');
    expect(service.isEndpointProviderPending()).toBe(false);
  });

  it('marks recovery required when the helper never reports within the bound', async () => {
    const selfUpdate = mockAvailableProvider();
    vi.spyOn(selfUpdate, 'triggerComposeReapply').mockResolvedValue(undefined);
    const service = fastTimings();
    await service.claimComposeReapply({ replaceEndpointProvider: true });
    await service.executeClaimedComposeReapply();
    await vi.waitFor(async () => expect((await service.getCurrentOperation())?.state).toBe('failed'), { timeout: 2_000 });
    expect(await service.getCurrentOperation()).toMatchObject({
      failureCode: 'endpoint_provider_recovery_required',
      rollback: { attempted: false },
      failureDetail: expect.stringContaining('docker compose up -d socket-proxy'),
    });
  });
});

describe('reconcileOnStartup (the new process)', () => {
  async function claimRecreating() {
    mockAvailableProvider();
    const service = fastTimings();
    await service.claimComposeReapply({ replaceEndpointProvider: true });
    const operation = (await service.getCurrentOperation())!;
    // Persist the state the old process left: recreating, provider recorded.
    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'image-operation-current.json'), 'utf8'));
    raw.state = 'recreating';
    await fs.writeFile(path.join(tmpDir, 'image-operation-current.json'), JSON.stringify(raw));
    return { service, operationId: operation.operationId };
  }

  it('answers the helper after Docker works through the new provider, and succeeds on its verdict', async () => {
    const { service, operationId } = await claimRecreating();
    mockDocker({ health: 'healthy' });
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

  it('does not mark success from a restart alone: no verdict means recovery required', async () => {
    const { service } = await claimRecreating();
    mockDocker();
    await service.reconcileOnStartup();
    expect(await service.getCurrentOperation()).toMatchObject({ state: 'failed', failureCode: 'endpoint_provider_recovery_required' });
    expect(FleetUpdateTrackerService.getInstance().get(localNodeId())).toMatchObject({ status: 'failed', error: expect.stringContaining('could not be restored') });
  });

  it('answers negatively when Docker does not answer through the new provider', async () => {
    const { service, operationId } = await claimRecreating();
    mockDocker({ ping: async () => { throw new Error('(HTTP code 403) unexpected - <html><body><h1>403 Forbidden</h1>\nRequest forbidden by administrative rules.\n</body></html>\n'); } });
    const reconcile = service.reconcileOnStartup();
    await vi.waitFor(async () => {
      const ack = JSON.parse(await fs.readFile(handoff(operationId, 'ack'), 'utf8'));
      expect(ack).toMatchObject({ ok: false, detail: 'Docker did not answer through "socket-proxy": (HTTP code 403) unexpected - 403 Forbidden Request forbidden by administrative rules.' });
    });
    await writeOutcome(operationId, { ok: false, phase: 'verify', error: 'Sencho could not use Docker', rollback: { restored: true, error: null } });
    await reconcile;
    expect(await service.getCurrentOperation()).toMatchObject({ state: 'failed', failureCode: 'endpoint_provider_restored' });
  });

  it.each([
    ['not running', { running: false }, 'is not running'],
    ['unhealthy', { health: 'unhealthy' }, 'healthcheck is unhealthy'],
    ['still starting', { health: 'starting' }, 'healthcheck is starting'],
  ])('answers negatively when the new provider is %s', async (_label, docker, detail) => {
    const { service, operationId } = await claimRecreating();
    mockDocker(docker);
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
