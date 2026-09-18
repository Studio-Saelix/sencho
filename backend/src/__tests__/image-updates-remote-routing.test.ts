import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'http';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { isHubOnlyPath } from '../helpers/proxyExemptPaths';

let tmpDir: string;
let app: import('express').Express;
let server: http.Server;
let capableNode: number;
let legacyNode: number;
let viewerId: number;
let admin: string;
let viewer: string;
let db: import('../services/DatabaseService').DatabaseService;
let scanner: import('../services/ImageUpdateService').ImageUpdateService;
let remoteScanner: import('../services/RemoteImageUpdateService').RemoteImageUpdateService;
const hops: { method: string; path: string; body: string }[] = [];
let inspectSupported = true;
const targetStatus = {
  enabled: true, checking: false, lastCheckedAt: 1234, nextCheckAt: 5678,
  mode: 'cron', cronExpression: '0 3 * * *', intervalMinutes: 60,
  sidebarIndicators: true, manualCooldownRemainingMs: 1000,
};

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  db = (await import('../services/DatabaseService')).DatabaseService.getInstance();
  scanner = (await import('../services/ImageUpdateService')).ImageUpdateService.getInstance();
  remoteScanner = (await import('../services/RemoteImageUpdateService')).RemoteImageUpdateService.getInstance();
  server = http.createServer((req, res) => {
    const path = req.url ?? '';
    res.setHeader('content-type', 'application/json');
    if (path.endsWith('/api/meta')) {
      const capabilities = ['cross-node-rbac', 'scoped-stack-auth-evidence'];
      if (path.startsWith('/capable/') && inspectSupported) capabilities.push('remote-image-inspect-v1');
      res.end(JSON.stringify({ version: '1.0.0', capabilities }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('error', error => { console.error('Test remote request failed:', error); res.destroy(); });
    req.on('end', () => {
      hops.push({ method: req.method ?? '', path, body: Buffer.concat(chunks).toString() });
      res.end(JSON.stringify(path.endsWith('/status') ? targetStatus
        : path.endsWith('/api/stacks/web/update')
          ? { success: true, healthGateId: 'target-health', recheckWarning: 'Target-local warning' }
          : { target: true }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('net').AddressInfo).port;
  const addNode = (name: string) => db.addNode({
    name, type: 'remote', mode: 'proxy', compose_dir: '/unused', is_default: false,
    api_url: `http://127.0.0.1:${port}/${name}`, api_token: 'fixture-token',
  });
  capableNode = addNode('capable');
  legacyNode = addNode('legacy');
  db.updateNodeStatus(capableNode, 'online');
  db.updateNodeStatus(legacyNode, 'online');
  db.upsertStackUpdateStatus(capableNode, 'confirmed', true, 1000, 'ok', null);
  db.upsertStackUpdateStatus(capableNode, 'uncertain', true, 1000, 'partial', 'Registry unavailable');
  db.upsertStackUpdateStatus(legacyNode, 'not-a-target-row', true, 1000, 'ok', null);
  viewerId = db.addUser({ username: 'routing-viewer', role: 'viewer', password_hash: await bcrypt.hash('test-password', 1) });
  admin = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '10m' })}`;
  viewer = `Bearer ${jwt.sign({ username: 'routing-viewer', role: 'viewer', tv: db.getUser(viewerId)!.token_version }, TEST_JWT_SECRET, { expiresIn: '10m' })}`;
});

afterEach(async () => {
  hops.length = 0;
  inspectSupported = true;
  vi.restoreAllMocks();
  scanner.resetStackRecheckCooldowns();
  db.clearStackUpdateStatus(capableNode, 'preview-clear');
  db.updateGlobalSetting('image_update_checks_enabled', '1');
  (await import('../helpers/fleetUpdateCache')).invalidateFleetUpdateCache();
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  cleanupTestDb(tmpDir);
});

function remoteGet(path: string, nodeId = capableNode, auth = admin) {
  return request(app).get(`/api/image-updates${path}`).set('Authorization', auth).set('x-node-id', String(nodeId));
}
function remotePost(path: string, nodeId = capableNode, auth = admin) {
  return request(app).post(`/api/image-updates${path}`).set('Authorization', auth).set('x-node-id', String(nodeId));
}

describe('hub-owned remote image update routing', () => {
  it('awaits hub verification before returning a remote manual update response', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const verify = vi.spyOn(remoteScanner, 'recheckRemoteStack').mockImplementation(async () => {
      await held;
      return { outcome: 'cleared', warning: null };
    });
    let settled = false;
    const response = request(app).post('/api/stacks/web/update')
      .set('Authorization', admin).set('x-node-id', String(capableNode)).send({})
      .then(result => { settled = true; return result; });
    try {
      await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(1));
      expect(settled).toBe(false);
    } finally {
      release();
      await response;
    }
    const result = await response;
    expect(result.status).toBe(200);
    expect(result.body.verification).toMatchObject({ status: 'verified', source: 'hub_authority' });
    expect(result.body.healthGateId).toBe('target-health');
    expect(result.body.recheckWarning).toBeUndefined();
    expect(hops.filter(hop => hop.path.endsWith('/api/stacks/web/update'))).toHaveLength(1);
  });

  it('preserves mutation success and health metadata when hub verification fails', async () => {
    vi.spyOn(remoteScanner, 'recheckRemoteStack').mockRejectedValue(new Error('Registry unavailable'));
    const result = await request(app).post('/api/stacks/web/update')
      .set('Authorization', admin).set('x-node-id', String(capableNode)).send({});
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ success: true, healthGateId: 'target-health',
      verification: { status: 'verification_failed', source: 'hub_authority' } });
    expect(result.body.recheckWarning).toContain('could not fully verify');
    expect(hops.filter(hop => hop.path.endsWith('/api/stacks/web/update'))).toHaveLength(1);
  });

  it('preserves mixed-version manual update warnings without hub verification', async () => {
    const verify = vi.spyOn(remoteScanner, 'recheckRemoteStack');
    const result = await request(app).post('/api/stacks/web/update')
      .set('Authorization', admin).set('x-node-id', String(legacyNode)).send({});
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ success: true, healthGateId: 'target-health', recheckWarning: 'Target-local warning' });
    expect(verify).not.toHaveBeenCalled();
  });

  it('reconciles a capable remote preview against hub rows without forwarding the preview', async () => {
    const { buildSummary } = await import('../services/UpdatePreviewService');
    const preview = buildSummary('preview-clear', [{
      service: 'app', image: 'nginx:latest', current_tag: 'latest', next_tag: null,
      has_update: false, digest_update: false, tag_update: false, semver_bump: 'none',
      check_status: 'ok', check_error: null, digest_error: null,
    }]);
    const check = vi.spyOn(remoteScanner, 'getPreview').mockResolvedValue(preview);
    db.upsertStackUpdateStatus(capableNode, 'preview-clear', true, 1000, 'ok', null);
    const result = await request(app).post('/api/stacks/preview-clear/update-preview')
      .set('Authorization', admin).set('x-node-id', String(capableNode)).send({});
    expect(result.status).toBe(200);
    expect(result.body.reconciled).toBe(true);
    expect(check).toHaveBeenCalledWith(capableNode, 'preview-clear', expect.any(AbortSignal));
    expect(db.getConfirmedStackUpdateStatus(capableNode)['preview-clear']).not.toBe(true);
    expect(hops).toEqual([]);
  });

  it('uses confirmed-only and rich hub maps for capable remotes, including global viewer reads', async () => {
    const summary = await remoteGet('', capableNode, viewer);
    expect(summary.status).toBe(200);
    expect(summary.body).toEqual({ confirmed: true, uncertain: false });
    const detail = await remoteGet('/detail');
    expect(detail.status).toBe(200);
    expect(detail.body.uncertain).toMatchObject({ hasUpdate: true, checkStatus: 'partial' });
    expect(hops).toEqual([]);
  });

  it('does not consult hub overlay rows for a mixed-version target', async () => {
    expect((await remoteGet('', legacyNode)).body).toEqual({ target: true });
    expect(hops.map(hop => hop.path)).toContain('/legacy/api/image-updates');
  });

  it.each(['/status', '/detail-extra'])('leaves %s target-local', async path => {
    expect((await remoteGet(path)).status).toBe(200);
    expect(hops[0].path).toBe(`/capable/api/image-updates${path}`);
  });

  it('preserves mixed-version POST bytes and parses only selected hub refreshes', async () => {
    const body = '{  "marker": "unchanged" }';
    expect((await remotePost('/refresh', legacyNode).set('Content-Type', 'application/json').send(body)).status).toBe(200);
    expect(hops[0].body).toBe(body);
    const check = vi.spyOn(remoteScanner, 'checkRemoteNode').mockResolvedValue(true);
    expect((await remotePost('/refresh').set('Content-Type', 'application/json').send('{ invalid')).status).toBe(400);
    expect(check).not.toHaveBeenCalled();
    expect((await remotePost('/refresh').send({})).status).toBe(200);
    expect(check).toHaveBeenCalledWith(capableNode, true);
    expect(hops).toHaveLength(1);
  });

  it('preserves PUT settings bytes without hub parsing', async () => {
    const body = '{ "enabled": false }';
    expect((await request(app).put('/api/image-updates/enabled').set('Authorization', admin)
      .set('x-node-id', String(capableNode)).set('Content-Type', 'application/json').send(body)).status).toBe(200);
    expect(hops[0].body).toBe(body);
  });

  it('keeps refresh authorization before remote scanner work', async () => {
    const check = vi.spyOn(remoteScanner, 'checkRemoteNode').mockResolvedValue(true);
    const recheck = vi.spyOn(remoteScanner, 'recheckRemoteStack').mockResolvedValue({ outcome: 'cleared', warning: null });
    expect((await remotePost('/refresh', capableNode, viewer).send({})).status).toBe(403);
    expect((await remotePost('/refresh/denied', capableNode, viewer).send({})).status).toBe(403);
    expect(check).not.toHaveBeenCalled();
    expect(recheck).not.toHaveBeenCalled();
    expect(hops).toEqual([]);
  });

  it('shares per-stack cooldown for a scoped remote grant', async () => {
    db.addRoleAssignment({ user_id: viewerId, role: 'deployer', resource_type: 'stack', resource_id: 'allowed', node_id: capableNode });
    const recheck = vi.spyOn(remoteScanner, 'recheckRemoteStack').mockResolvedValue({ outcome: 'cleared', warning: null });
    expect((await remotePost('/refresh/allowed', capableNode, viewer).send({})).status).toBe(200);
    expect(recheck).toHaveBeenCalledWith(capableNode, 'allowed', expect.any(AbortSignal));
    expect((await remotePost('/refresh/allowed', capableNode, viewer).send({})).status).toBe(429);
    expect(recheck).toHaveBeenCalledTimes(1);
  });

  it('returns remote disabled, busy, and failed outcomes truthfully', async () => {
    const check = vi.spyOn(remoteScanner, 'checkRemoteNode').mockResolvedValue(false);
    expect((await remotePost('/refresh').send({})).status).toBe(429);
    db.updateGlobalSetting('image_update_checks_enabled', '0');
    expect((await remotePost('/refresh').send({})).status).toBe(409);
    db.updateGlobalSetting('image_update_checks_enabled', '1');
    check.mockRejectedValueOnce(new Error('scan failed'));
    expect((await remotePost('/refresh').send({})).status).toBe(500);
  });

  it('keeps recheck-target proxied and node-management gated', async () => {
    const check = vi.spyOn(remoteScanner, 'checkRemoteNode').mockResolvedValue(true);
    expect((await remotePost('/recheck-target', capableNode, viewer).send({})).status).toBe(403);
    expect((await remotePost('/recheck-target').send({ marker: true })).status).toBe(200);
    expect(hops[0].path).toBe('/capable/api/image-updates/recheck-target');
    expect(check).not.toHaveBeenCalled();
    const local = vi.spyOn(scanner, 'triggerManualRefresh').mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect((await request(app).post('/api/image-updates/recheck-target').set('Authorization', admin).send({})).status).toBe(200);
    expect((await request(app).post('/api/image-updates/recheck-target').set('Authorization', admin).send({})).status).toBe(429);
    expect(local).toHaveBeenCalledTimes(2);
  });

  it('projects hub status and retains observations while disabled', async () => {
    db.updateGlobalSetting('image_update_checks_enabled', '0');
    const res = await request(app).get(`/api/image-updates/overlay-status?targetNodeId=${capableNode}`).set('Authorization', viewer);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: false, scannerOwner: 'hub', capability: 'remote-image-inspect-v1', intervalUnit: 'minutes' });
    expect((await remoteGet('')).body.confirmed).toBe(true);
  });

  it('normalizes target timestamps, schedule and cooldown without using hub state', async () => {
    const res = await request(app).get(`/api/image-updates/overlay-status?targetNodeId=${legacyNode}`).set('Authorization', admin);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ scannerOwner: 'target', capability: null, lastCheckedAt: 1234, nextRunAt: 5678, mode: 'cron' });
    expect(res.body.cooldownEndsAt).toBeGreaterThan(Date.now());
  });

  it.each(['', '?targetNodeId=local', '?targetNodeId=1', '?targetNodeId=2garbage', '?targetNodeId=2&targetNodeId=3'])('rejects invalid selector %s', async query => {
    expect((await request(app).get(`/api/image-updates/overlay-status${query}`).set('Authorization', admin)).status).toBe(400);
  });

  it('returns 404 for unknown selectors and rejects reserved remote node routing', async () => {
    expect((await request(app).get('/api/image-updates/overlay-status?targetNodeId=999999').set('Authorization', admin)).status).toBe(404);
    expect((await remoteGet(`/overlay-status?targetNodeId=${capableNode}`)).status).toBe(403);
    expect((await request(app).get(`/api/image-updates/overlay-status?targetNodeId=${capableNode}&nodeId=${capableNode}`).set('Authorization', admin)).status).toBe(403);
  });

  it('aggregates overlay booleans and omits legacy rich rows', async () => {
    const summary = await request(app).get('/api/image-updates/fleet').set('Authorization', viewer);
    expect(summary.status).toBe(200);
    expect(summary.body[capableNode]).toEqual({ confirmed: true, uncertain: false });
    expect(summary.body[legacyNode]).toEqual({ target: true });
    const detail = await request(app).get('/api/image-updates/fleet/detail').set('Authorization', viewer);
    expect(detail.status).toBe(200);
    expect(detail.body[capableNode].uncertain.checkStatus).toBe('partial');
    expect(detail.body[legacyNode]).toBeUndefined();
  });

  it('branches fleet refresh by capability without broadening the global permission', async () => {
    const check = vi.spyOn(remoteScanner, 'checkRemoteNode').mockResolvedValue(true);
    vi.spyOn(scanner, 'triggerManualRefresh').mockReturnValue(true);
    expect((await request(app).post('/api/image-updates/fleet/refresh').set('Authorization', viewer).send({})).status).toBe(403);
    const res = await request(app).post('/api/image-updates/fleet/refresh').set('Authorization', admin).send({});
    expect(res.status).toBe(200);
    expect(res.body.triggered).toEqual(expect.arrayContaining([capableNode, legacyNode]));
    expect(check).toHaveBeenCalledWith(capableNode, true);
    expect(check).toHaveBeenCalledTimes(1);
    expect(hops.some(hop => hop.path === '/legacy/api/image-updates/refresh')).toBe(true);
  });

  it.each(['/api/image-updates/overlay-status', '/api/image-updates/fleet/detail', '/api/auto-update/execute-checked'])('keeps hub-only boundary exact for %s', path => {
    expect(isHubOnlyPath(path)).toBe(true);
    expect(isHubOnlyPath(`${path}/`)).toBe(true);
    expect(isHubOnlyPath(`${path}-extra`)).toBe(false);
  });
});
