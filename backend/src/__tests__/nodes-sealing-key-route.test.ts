import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { installInProcessNodeTransport } from './helpers/inProcessNodeTransport';
import { createTestApiToken } from './helpers/apiTokenTestHelper';

const probe = vi.hoisted(() => ({ kind: 'supported' as 'supported' | 'unsupported' | 'unreachable' }));

vi.mock('../helpers/remoteCapabilities', async (importOriginal) => {
  const original = await importOriginal<typeof import('../helpers/remoteCapabilities')>();
  return {
    ...original,
    probeRemoteCapability: vi.fn(async () => (probe.kind === 'unreachable'
      ? { kind: 'unreachable', detail: 'transport_failure' }
      : { kind: probe.kind })),
  };
});

let tmpDir: string;
let app: import('express').Express;
let adminAuth: string;
let viewerAuth: string;
let db: import('../services/DatabaseService').DatabaseService;
let remoteNodeId: number;
let nodeAdminAuth: string;
let apiTokenAuth: string;
let localNodeId: number;
let ownFingerprint: string;

function signToken(username: string, role: string) {
  return jwt.sign(
    { username, role, email: `${username}@test.local` },
    TEST_JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '2h', issuer: 'sencho' },
  );
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  adminAuth = `Bearer ${signToken(TEST_USERNAME, 'admin')}`;
  viewerAuth = `Bearer ${signToken('viewer', 'viewer')}`;
  const dbModule = await import('../services/DatabaseService');
  db = dbModule.DatabaseService.getInstance();
  remoteNodeId = db.addNode({
    name: 'seal-route-remote',
    type: 'remote',
    compose_dir: '/app/compose',
    is_default: false,
    api_url: 'http://192.168.1.60:1852',
    api_token: 'token',
    mode: 'proxy',
  });
  const index = await import('../index');
  app = index.app;
  localNodeId = db.getDefaultNode()!.id;
  db.addUser({ username: 'seal-node-admin', password_hash: bcrypt.hashSync('password123', 1), role: 'node-admin' });
  const nodeAdmin = db.getUserByUsername('seal-node-admin')!;
  nodeAdminAuth = `Bearer ${jwt.sign({ username: 'seal-node-admin', role: 'node-admin', tv: nodeAdmin.token_version }, TEST_JWT_SECRET, { expiresIn: '1h' })}`;
  apiTokenAuth = `Bearer ${createTestApiToken({ db: dbModule.DatabaseService, scope: 'full-admin', userId: db.getUserByUsername(TEST_USERNAME)!.id })}`;
  const { announceSealingKey } = await import('../bootstrap/startup');
  const log = vi.spyOn(console, 'log');
  announceSealingKey();
  ownFingerprint = (await import('../helpers/registryEnvelopeSeal')).getOrCreateSealingKey().fingerprint;
  expect(log.mock.calls.some((call) => call[0] === `[Sealing] This node's sealing key fingerprint: ${ownFingerprint}`)).toBe(true);
  log.mockRestore();
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

describe('DELETE /api/nodes/:id/sealing-key', () => {
  it('rejects viewers with 401/403', async () => {
    const res = await request(app)
      .delete(`/api/nodes/${remoteNodeId}/sealing-key`)
      .set('Authorization', viewerAuth);
    expect([401, 403]).toContain(res.status);
  });

  it('clears the pin and returns 204 for node:manage', async () => {
    db.pinNodeSealingKey(remoteNodeId, 'pubkey-z', 'fp-z');
    const res = await request(app)
      .delete(`/api/nodes/${remoteNodeId}/sealing-key`)
      .set('Authorization', adminAuth);
    expect(res.status).toBe(204);
    expect(db.getNodeSealingKey(remoteNodeId)).toBeNull();
  });

  it('surfaces the fingerprint on GET /api/nodes/:id', async () => {
    db.pinNodeSealingKey(remoteNodeId, 'pubkey-y', 'fp-y');
    const res = await request(app)
      .get(`/api/nodes/${remoteNodeId}`)
      .set('Authorization', adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.sealingKeyFingerprint).toBe('fp-y');
    expect(res.body.api_token).toBeUndefined();
  });
});

describe('GET /api/nodes/:id/sealing-key', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    probe.kind = 'supported';
    db.clearNodeSealingKey(remoteNodeId);
    installInProcessNodeTransport({ app, bearer: () => jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' }) });
  });

  it('shows this instance its own fingerprint, created at startup', async () => {
    const res = await request(app).get(`/api/nodes/${localNodeId}/sealing-key`).set('Authorization', adminAuth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kind: 'local', fingerprint: ownFingerprint });
  });

  it('reports a plaintext remote node as waiting for confirmation, without pinning', async () => {
    const res = await request(app).get(`/api/nodes/${remoteNodeId}/sealing-key`).set('Authorization', adminAuth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kind: 'remote', readiness: 'pin_unconfirmed', pinned: null, presented: { fingerprint: ownFingerprint } });
    expect(db.getNodeSealingKey(remoteNodeId)).toBeNull();
  });

  it('reports an unsupported node', async () => {
    probe.kind = 'unsupported';
    const res = await request(app).get(`/api/nodes/${remoteNodeId}/sealing-key`).set('Authorization', adminAuth);
    expect(res.body.readiness).toBe('unsupported');
  });

  it('is node:manage and refuses viewers and API tokens', async () => {
    expect([401, 403]).toContain((await request(app).get(`/api/nodes/${remoteNodeId}/sealing-key`).set('Authorization', viewerAuth)).status);
    expect((await request(app).get(`/api/nodes/${remoteNodeId}/sealing-key`).set('Authorization', apiTokenAuth)).status).toBe(403);
    expect((await request(app).get(`/api/nodes/${remoteNodeId}/sealing-key`).set('Authorization', nodeAdminAuth)).status).toBe(200);
  });
});

describe('POST /api/nodes/:id/sealing-key/confirm', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    probe.kind = 'supported';
    db.clearNodeSealingKey(remoteNodeId);
    installInProcessNodeTransport({ app, bearer: () => jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' }) });
  });

  const confirm = (auth: string, fingerprint: string) => request(app)
    .post(`/api/nodes/${remoteNodeId}/sealing-key/confirm`)
    .set('Authorization', auth)
    .send({ fingerprint });

  it('lets an Admin confirm the fingerprint the node presents', async () => {
    const res = await confirm(adminAuth, ownFingerprint);
    expect(res.status).toBe(200);
    expect(res.body.readiness).toBe('ready');
    expect(res.body.pinned).toMatchObject({ fingerprint: ownFingerprint, confidential: true, confirmedBy: TEST_USERNAME });
    expect(db.getNodeSealingPin(remoteNodeId)).toMatchObject({ confidential: true, confirmedBy: TEST_USERNAME });
  });

  it('refuses a fingerprint the node does not present', async () => {
    const res = await confirm(adminAuth, 'wrong-fingerprint');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SEAL_KEY_MISMATCH');
    expect(db.getNodeSealingKey(remoteNodeId)).toBeNull();
  });

  it('refuses when the pin names another key', async () => {
    db.pinNodeSealingKey(remoteNodeId, 'other-pubkey', 'other-fingerprint');
    const res = await confirm(adminAuth, ownFingerprint);
    expect(res.status).toBe(409);
    expect(db.getNodeSealingPin(remoteNodeId)?.confidential).toBe(false);
  });

  it('refuses a node admin, a viewer and an API token', async () => {
    expect((await confirm(nodeAdminAuth, ownFingerprint)).status).toBe(403);
    expect([401, 403]).toContain((await confirm(viewerAuth, ownFingerprint)).status);
    expect((await confirm(apiTokenAuth, ownFingerprint)).status).toBe(403);
    expect(db.getNodeSealingKey(remoteNodeId)).toBeNull();
  });

  it('is cleared with the pin by the existing reset', async () => {
    await confirm(adminAuth, ownFingerprint);
    expect((await request(app).delete(`/api/nodes/${remoteNodeId}/sealing-key`).set('Authorization', adminAuth)).status).toBe(204);
    expect(db.getNodeSealingPin(remoteNodeId)).toBeNull();
  });
});

describe('node deletion', () => {
  it('removes the node\'s pin and its sealed secret delivery rows', async () => {
    const id = db.addNode({
      name: 'seal-route-doomed', type: 'remote', compose_dir: '/app/compose', is_default: false,
      api_url: 'http://192.168.1.61:1852', api_token: 'token', mode: 'proxy',
    });
    db.pinNodeSealingKey(id, 'pk', 'fp', true);
    db.upsertSealedSecretDelivery({
      nodeId: id, purpose: 'edge-tunnel-run-token', slot: '0b9f3c2e-1d4a-4b5c-8d6e-7f8091a2b3c4', generation: 1,
      state: 'delivered', operationId: 'op', requestedBy: 'admin', updatedAt: Date.now(),
    });
    db.deleteNode(id);
    expect(db.getNodeSealingPin(id)).toBeNull();
    expect(db.getSealedSecretDelivery(id, 'edge-tunnel-run-token')).toBeNull();
  });
});
