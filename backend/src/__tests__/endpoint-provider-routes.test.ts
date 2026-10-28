/**
 * Route coverage for replacing the Docker endpoint during Update and Reapply:
 * the opt-in flag on the system and Fleet routes (local and remote, proxy and
 * Pilot share the remote dispatch), the option endpoints, the public meta
 * signals, and Fleet tracking that waits for the node's own verdict.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import type { RemoteMeta } from '../services/CapabilityRegistry';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import * as versionCheck from '../utils/version-check';

let tmpDir: string;
let app: import('express').Express;
let adminAuth: string;
let viewerAuth: string;
let proxyNodeId: number;
let localNodeId: number;
let NodeRegistry: typeof import('../services/NodeRegistry').NodeRegistry;
let FleetUpdateTrackerService: typeof import('../services/FleetUpdateTrackerService').FleetUpdateTrackerService;
let SelfUpdateService: typeof import('../services/SelfUpdateService').default;
let ImageOperationService: typeof import('../services/ImageOperationService').ImageOperationService;

const ONLINE = (over: Partial<RemoteMeta> = {}): RemoteMeta => ({
  version: '0.83.0',
  capabilities: ['stacks', 'self-update', 'endpoint-provider-replace', 'endpoint-provider-only'],
  startedAt: 1,
  updateError: null,
  online: true,
  imagePinKind: null,
  updateBlocked: false,
  imageChannel: null,
  ...over,
});

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ NodeRegistry } = await import('../services/NodeRegistry'));
  ({ FleetUpdateTrackerService } = await import('../services/FleetUpdateTrackerService'));
  SelfUpdateService = (await import('../services/SelfUpdateService')).default;
  ({ ImageOperationService } = await import('../services/ImageOperationService'));
  const { DatabaseService } = await import('../services/DatabaseService');
  const db = DatabaseService.getInstance();
  localNodeId = db.getNodes().find(n => n.type === 'local')!.id;
  proxyNodeId = db.addNode({
    name: 'endpoint-provider-remote',
    type: 'remote',
    mode: 'proxy',
    compose_dir: '/tmp',
    is_default: false,
    api_url: 'http://192.168.1.98:1852',
    api_token: 'proxy-token',
  });
  db.addUser({ username: 'viewer-endpoint-provider', password_hash: 'unused', role: 'viewer' });
  adminAuth = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' })}`;
  viewerAuth = `Bearer ${jwt.sign({ username: 'viewer-endpoint-provider' }, TEST_JWT_SECRET, { expiresIn: '1m' })}`;
});

afterAll(() => cleanupTestDb(tmpDir));

afterEach(() => {
  vi.restoreAllMocks();
  const tracker = FleetUpdateTrackerService.getInstance();
  for (const [id] of [...tracker.entries()]) tracker.delete(id);
});

function mockLocalSelfUpdate() {
  const svc = SelfUpdateService.getInstance();
  vi.spyOn(svc, 'isAvailable').mockReturnValue(true);
  vi.spyOn(svc, 'getPinInfo').mockResolvedValue(null);
  vi.spyOn(svc, 'canSelfUpdateTarget').mockResolvedValue({ ok: true });
  vi.spyOn(svc, 'triggerUpdate').mockResolvedValue(undefined);
  vi.spyOn(svc, 'triggerComposeReapply').mockResolvedValue(undefined);
  vi.spyOn(svc, 'getLastError').mockReturnValue(null);
  const operations = ImageOperationService.getInstance();
  const claimUpdate = vi.spyOn(operations, 'claimCommunityUpdate').mockResolvedValue({ ok: true });
  const claimReapply = vi.spyOn(operations, 'claimComposeReapply').mockResolvedValue({ ok: true });
  vi.spyOn(operations, 'executeClaimedCommunityUpdate').mockResolvedValue({ ok: true });
  vi.spyOn(operations, 'executeClaimedComposeReapply').mockResolvedValue({ ok: true });
  return { svc, claimUpdate, claimReapply };
}

function mockRemote(meta: RemoteMeta) {
  vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockImplementation((id: number) =>
    id === proxyNodeId ? { apiUrl: 'http://192.168.1.98:1852', apiToken: 'proxy-token', trustedLoopback: false } : null,
  );
  vi.spyOn(NodeRegistry.getInstance(), 'fetchMetaForNode').mockResolvedValue(meta);
  vi.spyOn(versionCheck, 'getLatestVersion').mockResolvedValue('0.99.0');
  const calls: Array<{ url: string; body: unknown }> = [];
  const respond = { status: 202, body: { message: 'ok' } as unknown };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(respond.body), { status: respond.status });
  });
  return { calls, respond };
}

describe('POST /api/system/reapply-compose and /update with replaceEndpointProvider', () => {
  it('rejects a non-boolean flag with 400 before claiming', async () => {
    const { claimReapply } = mockLocalSelfUpdate();
    const res = await request(app).post('/api/system/reapply-compose').set('Authorization', adminAuth).send({ replaceEndpointProvider: 'yes' });
    expect(res.status).toBe(400);
    expect(claimReapply).not.toHaveBeenCalled();
  });

  it('passes the flag to the claim and answers 202', async () => {
    const { claimReapply } = mockLocalSelfUpdate();
    const res = await request(app).post('/api/system/reapply-compose').set('Authorization', adminAuth).send({ replaceEndpointProvider: true });
    expect(res.status).toBe(202);
    expect(claimReapply).toHaveBeenCalledWith({ replace: true, only: false });
  });

  it('accepts the provider-only choice on Reapply and passes both flags', async () => {
    const { claimReapply } = mockLocalSelfUpdate();
    const res = await request(app).post('/api/system/reapply-compose').set('Authorization', adminAuth)
      .send({ replaceEndpointProvider: true, endpointProviderOnly: true });
    expect(res.status).toBe(202);
    expect(claimReapply).toHaveBeenCalledWith({ replace: true, only: true });
    expect(res.body.message).toContain('Sencho keeps running');
  });

  it('rejects endpointProviderOnly without replaceEndpointProvider', async () => {
    const { claimReapply } = mockLocalSelfUpdate();
    const res = await request(app).post('/api/system/reapply-compose').set('Authorization', adminAuth).send({ endpointProviderOnly: true });
    expect(res.status).toBe(400);
    expect(claimReapply).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean endpointProviderOnly', async () => {
    const { claimReapply } = mockLocalSelfUpdate();
    const res = await request(app).post('/api/system/reapply-compose').set('Authorization', adminAuth)
      .send({ replaceEndpointProvider: true, endpointProviderOnly: 'yes' });
    expect(res.status).toBe(400);
    expect(claimReapply).not.toHaveBeenCalled();
  });

  it('refuses provider-only on an image update, which always recreates Sencho', async () => {
    const { claimUpdate } = mockLocalSelfUpdate();
    const res = await request(app).post('/api/system/update').set('Authorization', adminAuth)
      .send({ replaceEndpointProvider: true, endpointProviderOnly: true });
    expect(res.status).toBe(400);
    expect(claimUpdate).not.toHaveBeenCalled();
  });

  it('answers 409 with the reason when the provider cannot be replaced', async () => {
    const { claimUpdate } = mockLocalSelfUpdate();
    claimUpdate.mockResolvedValue({ ok: false, failureCode: 'endpoint_provider_unavailable', reason: 'No direct socket.' });
    const res = await request(app).post('/api/system/update').set('Authorization', adminAuth).send({ replaceEndpointProvider: true });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'No direct socket.', code: 'endpoint_provider_unavailable' });
  });

  it('refuses the flag on a hardened image update', async () => {
    const { svc, claimUpdate } = mockLocalSelfUpdate();
    vi.mocked(svc.getPinInfo).mockResolvedValue({ pinKind: 'digest', composeImageRef: 'ghcr.io/studio-saelix/sencho-hardened@sha256:aaaa', filePath: '/c.yml' });
    const res = await request(app).post('/api/system/update').set('Authorization', adminAuth).send({ replaceEndpointProvider: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('endpoint_provider_unavailable');
    expect(claimUpdate).not.toHaveBeenCalled();
  });

  it('keeps the plain update path unchanged (flag defaults to false)', async () => {
    const { claimUpdate } = mockLocalSelfUpdate();
    const res = await request(app).post('/api/system/update').set('Authorization', adminAuth).send({});
    expect(res.status).toBe(202);
    expect(claimUpdate).toHaveBeenCalledWith({ targetVersion: undefined, replaceEndpointProvider: false });
  });

  it('requires the update permission', async () => {
    mockLocalSelfUpdate();
    const res = await request(app).post('/api/system/reapply-compose').set('Authorization', viewerAuth).send({ replaceEndpointProvider: true });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/system/endpoint-provider', () => {
  it('returns the option for an admin', async () => {
    vi.spyOn(SelfUpdateService.getInstance(), 'getEndpointProviderOption').mockResolvedValue({ state: 'available', service: 'socket-proxy', containerName: 'stack-socket-proxy-1', providerOnly: true, project: 'stack' });
    const res = await request(app).get('/api/system/endpoint-provider').set('Authorization', adminAuth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ state: 'available', service: 'socket-proxy', containerName: 'stack-socket-proxy-1', providerOnly: true, project: 'stack' });
  });

  it('is refused to a viewer', async () => {
    const res = await request(app).get('/api/system/endpoint-provider').set('Authorization', viewerAuth);
    expect(res.status).toBe(403);
  });
});

describe('Fleet local node', () => {
  it('forwards the flag on local Reapply and Update', async () => {
    const { claimUpdate, claimReapply } = mockLocalSelfUpdate();
    vi.spyOn(versionCheck, 'getLatestVersion').mockResolvedValue('0.99.0');
    const reapply = await request(app).post(`/api/fleet/nodes/${localNodeId}/reapply-compose`).set('Authorization', adminAuth).send({ replaceEndpointProvider: true });
    expect(reapply.status).toBe(202);
    expect(claimReapply).toHaveBeenCalledWith({ replace: true, only: false });
    FleetUpdateTrackerService.getInstance().delete(localNodeId);
    const update = await request(app).post(`/api/fleet/nodes/${localNodeId}/update`).set('Authorization', adminAuth).send({ replaceEndpointProvider: true });
    expect(update.status).toBe(202);
    expect(claimUpdate).toHaveBeenCalledWith(expect.objectContaining({ replaceEndpointProvider: true }));
  });

  it('dispatches a provider-only Reapply with both flags', async () => {
    const { claimReapply } = mockLocalSelfUpdate();
    const res = await request(app).post(`/api/fleet/nodes/${localNodeId}/reapply-compose`).set('Authorization', adminAuth)
      .send({ replaceEndpointProvider: true, endpointProviderOnly: true });
    expect(res.status).toBe(202);
    expect(claimReapply).toHaveBeenCalledWith({ replace: true, only: true });
    expect(res.body.message).toContain('Sencho keeps running');
  });

  it('leaves no tracker behind when the provider claim is refused', async () => {
    const { claimReapply } = mockLocalSelfUpdate();
    claimReapply.mockResolvedValue({ ok: false, failureCode: 'endpoint_provider_unavailable', reason: 'Not in Sencho\'s project.' });
    const res = await request(app).post(`/api/fleet/nodes/${localNodeId}/reapply-compose`).set('Authorization', adminAuth).send({ replaceEndpointProvider: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Not in Sencho\'s project.');
    expect(FleetUpdateTrackerService.getInstance().get(localNodeId)).toBeUndefined();
  });

  it('answers the option endpoint from the local service', async () => {
    vi.spyOn(SelfUpdateService.getInstance(), 'getEndpointProviderOption').mockResolvedValue({ state: 'none' });
    const res = await request(app).get(`/api/fleet/nodes/${localNodeId}/endpoint-provider`).set('Authorization', adminAuth);
    expect(res.body).toEqual({ state: 'none' });
  });

  it('does not early-fail a local tracker while the replacement is being verified', async () => {
    mockLocalSelfUpdate();
    vi.spyOn(versionCheck, 'getLatestVersion').mockResolvedValue('0.99.0');
    vi.spyOn(ImageOperationService.getInstance(), 'isEndpointProviderPending').mockReturnValue(true);
    const tracker = FleetUpdateTrackerService.getInstance();
    tracker.set(localNodeId, { ...tracker.create('updating', '0.83.0', null), startedAt: Date.now() - 240_000 });
    const res = await request(app).get('/api/fleet/update-status').set('Authorization', adminAuth);
    expect(res.body.nodes.find((n: { nodeId: number }) => n.nodeId === localNodeId).updateStatus).toBe('updating');
  });
});

describe('Fleet remote node (proxy and Pilot share this dispatch)', () => {
  it('forwards the flag to the node on Reapply and Update', async () => {
    const { calls } = mockRemote(ONLINE());
    const reapply = await request(app).post(`/api/fleet/nodes/${proxyNodeId}/reapply-compose`).set('Authorization', adminAuth).send({ replaceEndpointProvider: true });
    expect(reapply.status).toBe(202);
    expect(calls.find(call => call.url.endsWith('/api/system/reapply-compose'))?.body).toEqual({ replaceEndpointProvider: true });
    FleetUpdateTrackerService.getInstance().delete(proxyNodeId);
    const update = await request(app).post(`/api/fleet/nodes/${proxyNodeId}/update`).set('Authorization', adminAuth).send({ replaceEndpointProvider: true });
    expect(update.status).toBe(202);
    expect(calls.find(call => call.url.endsWith('/api/system/update'))?.body).toMatchObject({ replaceEndpointProvider: true });
  });

  it('refuses a provider-only Reapply to a node that cannot leave Sencho running', async () => {
    const { calls } = mockRemote(ONLINE({ capabilities: ['stacks', 'self-update', 'endpoint-provider-replace'] }));
    const res = await request(app).post(`/api/fleet/nodes/${proxyNodeId}/reapply-compose`).set('Authorization', adminAuth)
      .send({ replaceEndpointProvider: true, endpointProviderOnly: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('endpoint_provider_unavailable');
    expect(calls).toEqual([]);
  });

  it('reports provider-only unsupported for a node whose option answer cannot prove it', async () => {
    const { respond } = mockRemote(ONLINE({ capabilities: ['stacks', 'self-update', 'endpoint-provider-replace'] }));
    respond.status = 200;
    respond.body = { state: 'available', service: 'socket-proxy', containerName: 'c', project: 'stack', providerOnly: true };
    const res = await request(app).get(`/api/fleet/nodes/${proxyNodeId}/endpoint-provider`).set('Authorization', adminAuth);
    expect(res.body).toEqual({ state: 'available', service: 'socket-proxy', containerName: 'c', project: 'stack', providerOnly: false });
  });

  it('forwards a provider-only Reapply with both flags', async () => {
    const { calls } = mockRemote(ONLINE());
    const res = await request(app).post(`/api/fleet/nodes/${proxyNodeId}/reapply-compose`).set('Authorization', adminAuth)
      .send({ replaceEndpointProvider: true, endpointProviderOnly: true });
    expect(res.status).toBe(202);
    expect(calls.find(call => call.url.endsWith('/api/system/reapply-compose'))?.body).toEqual({
      replaceEndpointProvider: true,
      endpointProviderOnly: true,
    });
    expect(res.body.message).toContain('Sencho keeps running');
  });

  it('omits the flag for a plain remote Reapply', async () => {
    const { calls } = mockRemote(ONLINE());
    await request(app).post(`/api/fleet/nodes/${proxyNodeId}/reapply-compose`).set('Authorization', adminAuth).send({});
    expect(calls.find(call => call.url.endsWith('/api/system/reapply-compose'))?.body).toEqual({});
  });

  it('refuses the flag for a node that does not advertise the capability, without dispatching', async () => {
    const { calls } = mockRemote(ONLINE({ capabilities: ['stacks', 'self-update'] }));
    const res = await request(app).post(`/api/fleet/nodes/${proxyNodeId}/reapply-compose`).set('Authorization', adminAuth).send({ replaceEndpointProvider: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('endpoint_provider_unavailable');
    expect(calls).toEqual([]);
  });

  it('surfaces the node\'s own refusal', async () => {
    const { respond } = mockRemote(ONLINE());
    respond.status = 409;
    respond.body = { error: '"proxy" does not bind-mount the host Docker socket.', code: 'endpoint_provider_unavailable' };
    const res = await request(app).post(`/api/fleet/nodes/${proxyNodeId}/reapply-compose`).set('Authorization', adminAuth).send({ replaceEndpointProvider: true });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: '"proxy" does not bind-mount the host Docker socket.', code: 'endpoint_provider_unavailable' });
  });

  it('reads the option from the node, and reports unsupported for an older node', async () => {
    const { respond } = mockRemote(ONLINE());
    respond.status = 200;
    respond.body = { state: 'available', service: 'socket-proxy', containerName: 'stack-socket-proxy-1', project: 'stack', providerOnly: true };
    const res = await request(app).get(`/api/fleet/nodes/${proxyNodeId}/endpoint-provider`).set('Authorization', adminAuth);
    expect(res.body).toEqual({ state: 'available', service: 'socket-proxy', containerName: 'stack-socket-proxy-1', providerOnly: true, project: 'stack' });

    vi.restoreAllMocks();
    mockRemote(ONLINE({ capabilities: ['self-update'] }));
    const older = await request(app).get(`/api/fleet/nodes/${proxyNodeId}/endpoint-provider`).set('Authorization', adminAuth);
    expect(older.body).toEqual({ state: 'unsupported' });
  });

  it('reads a malformed node answer as unavailable', async () => {
    const { respond } = mockRemote(ONLINE());
    respond.status = 200;
    respond.body = { state: 'available', service: 42 };
    const res = await request(app).get(`/api/fleet/nodes/${proxyNodeId}/endpoint-provider`).set('Authorization', adminAuth);
    expect(res.body).toMatchObject({ state: 'unavailable' });
  });

  it('keeps the option endpoint admin-only', async () => {
    const res = await request(app).get(`/api/fleet/nodes/${proxyNodeId}/endpoint-provider`).set('Authorization', viewerAuth);
    expect(res.status).toBe(403);
  });

  function trackRemote(startedAgoMs: number) {
    const tracker = FleetUpdateTrackerService.getInstance();
    tracker.set(proxyNodeId, { ...tracker.create('updating', '0.83.0', 1, undefined, undefined, 'reapply_configuration'), startedAt: Date.now() - startedAgoMs });
  }

  async function remoteStatus() {
    const res = await request(app).get('/api/fleet/update-status').set('Authorization', adminAuth);
    return res.body.nodes.find((n: { nodeId: number }) => n.nodeId === proxyNodeId);
  }

  it('does not complete on a restart while the node still verifies its Docker endpoint', async () => {
    mockRemote(ONLINE({ startedAt: 2, endpointProviderPending: true }));
    trackRemote(30_000);
    expect((await remoteStatus()).updateStatus).toBe('updating');
  });

  it('neither early-fails nor times out while the node reports pending', async () => {
    mockRemote(ONLINE({ endpointProviderPending: true }));
    trackRemote(6 * 60_000);
    expect((await remoteStatus()).updateStatus).toBe('updating');
  });

  it('completes once the node clears pending after its restart', async () => {
    mockRemote(ONLINE({ startedAt: 2 }));
    trackRemote(30_000);
    expect((await remoteStatus()).updateStatus).toBe('completed');
  });

  it('completes a provider-only reapply from the node completion stamp while the process stays up', async () => {
    // The remote's process start time never changes: only the endpoint stamp does.
    mockRemote(ONLINE({ startedAt: 1, endpointProviderCompletedAt: Date.now() }));
    const tracker = FleetUpdateTrackerService.getInstance();
    tracker.set(proxyNodeId, {
      ...tracker.create('updating', '0.83.0', 1, undefined, undefined, 'reapply_configuration'),
      startedAt: Date.now() - 30_000,
      previousEndpointProviderCompletedAt: null,
    });
    expect((await remoteStatus()).updateStatus).toBe('completed');
  });

  it('does not complete a provider-only reapply before the stamp moves', async () => {
    mockRemote(ONLINE({ startedAt: 1, endpointProviderCompletedAt: 1_000 }));
    const tracker = FleetUpdateTrackerService.getInstance();
    tracker.set(proxyNodeId, {
      ...tracker.create('updating', '0.83.0', 1, undefined, undefined, 'reapply_configuration'),
      startedAt: Date.now() - 30_000,
      previousEndpointProviderCompletedAt: 1_000,
    });
    expect((await remoteStatus()).updateStatus).toBe('updating');
  });

  it.each([
    ['endpoint_provider_restored', 'restored its previous Docker endpoint container'],
    ['endpoint_provider_recovery_required', 'could not confirm that Sencho reaches Docker through the Docker endpoint'],
    ['update_failed', 'reported that the operation failed'],
  ])('fails with an operator message for %s', async (code, message) => {
    mockRemote(ONLINE({ startedAt: 2, updateError: code }));
    trackRemote(30_000);
    const row = await remoteStatus();
    expect(row.updateStatus).toBe('failed');
    expect(row.error).toContain(message);
  });

  it('still times out an unreachable node even if it last reported pending', async () => {
    mockRemote(ONLINE({ online: false, endpointProviderPending: false }));
    trackRemote(6 * 60_000);
    expect((await remoteStatus()).updateStatus).toBe('timeout');
  });
});

describe('GET /api/meta', () => {
  it('exposes the bounded failure code and the pending flag, never the text', async () => {
    const svc = SelfUpdateService.getInstance();
    svc.recordUpdateFailure('Replacing the Docker endpoint "socket-proxy" failed: /srv/private/path', 'endpoint_provider_recovery_required');
    vi.spyOn(ImageOperationService.getInstance(), 'isEndpointProviderPending').mockReturnValue(true);
    const res = await request(app).get('/api/meta');
    svc.clearLastError();
    expect(res.body.updateError).toBe('endpoint_provider_recovery_required');
    expect(res.body.endpointProviderPending).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('/srv/private/path');
    expect(res.body.capabilities).toContain('endpoint-provider-replace');
  });

  it('omits the pending flag when nothing is pending', async () => {
    const res = await request(app).get('/api/meta');
    expect(res.body).not.toHaveProperty('endpointProviderPending');
  });

  it('exposes the endpoint completion stamp so the hub can finish a provider-only reapply', async () => {
    const operations = ImageOperationService.getInstance() as unknown as { endpointProviderCompletedAt: number | null };
    operations.endpointProviderCompletedAt = 1_700_000_000_000;
    const res = await request(app).get('/api/meta');
    operations.endpointProviderCompletedAt = null;
    expect(res.body.endpointProviderCompletedAt).toBe(1_700_000_000_000);
  });

  it('omits the completion stamp when no replacement has finished', async () => {
    const res = await request(app).get('/api/meta');
    expect(res.body).not.toHaveProperty('endpointProviderCompletedAt');
  });
});
