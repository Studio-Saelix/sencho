/**
 * A role assigned on the node itself covers every volume on that node, also
 * when the recovery request is relayed by the hub. The owning node sees the hop
 * as user 0 and cannot read the hub's assignments, so the hub resolves the node
 * grant and forwards the role that carries it, over a direct proxy and over a
 * Pilot node alike, for every mutating recovery call and for no one else.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import bcrypt from 'bcrypt';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { PROXY_ROLE_HEADER } from '../services/license-headers';

vi.mock('../services/recovery/remoteSupport', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/recovery/remoteSupport')>();
  return {
    ...original,
    preflightRecoveryRequest: async () => ({ ok: true, status: { state: 'available' } }),
  };
});

let tmpDir: string;
let app: import('express').Express;
let server: http.Server;
let hops: Array<{ method: string; url: string; role: string | undefined }> = [];
let proxyNodeId: number;
let pilotNodeId: number;
let otherNodeId: number;
const bearers = new Map<string, string>();
const userIds = new Map<string, number>();

async function makeUser(name: string, role: 'viewer' | 'deployer' | 'auditor'): Promise<void> {
  const { DatabaseService } = await import('../services/DatabaseService');
  const db = DatabaseService.getInstance();
  const id = db.addUser({ username: name, password_hash: await bcrypt.hash('password123', 1), role });
  const row = db.getUserByUsername(name)!;
  userIds.set(name, id);
  bearers.set(name, `Bearer ${jwt.sign({ username: name, role, tv: row.token_version }, TEST_JWT_SECRET, { expiresIn: '5m' })}`);
}

async function grant(user: string, role: 'node-admin' | 'deployer' | 'viewer' | 'admin', nodeId: number): Promise<void> {
  const { DatabaseService } = await import('../services/DatabaseService');
  DatabaseService.getInstance().addRoleAssignment({
    user_id: userIds.get(user)!, role, resource_type: 'node', resource_id: String(nodeId),
  });
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  const { DatabaseService } = await import('../services/DatabaseService');
  const { LicenseService } = await import('../services/LicenseService');
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
  const db = DatabaseService.getInstance();

  server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/meta')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '0.99.0', capabilities: ['cross-node-rbac'] }));
      return;
    }
    hops.push({ method: req.method ?? '', url: req.url ?? '', role: req.headers[PROXY_ROLE_HEADER] as string | undefined });
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('net').AddressInfo).port;

  proxyNodeId = db.addNode({
    name: 'relay-grant-proxy', type: 'remote', mode: 'proxy', compose_dir: '/tmp', is_default: false,
    api_url: `http://127.0.0.1:${port}`, api_token: 't',
  });
  pilotNodeId = db.addNode({
    name: 'relay-grant-pilot', type: 'remote', mode: 'pilot_agent', compose_dir: '/tmp', is_default: false, api_url: '', api_token: '',
  });
  otherNodeId = db.addNode({
    name: 'relay-grant-other', type: 'remote', mode: 'proxy', compose_dir: '/tmp', is_default: false,
    api_url: `http://127.0.0.1:${port}`, api_token: 't',
  });
  const { NodeRegistry } = await import('../services/NodeRegistry');
  const registry = NodeRegistry.getInstance();
  const original = registry.getProxyTarget.bind(registry);
  vi.spyOn(registry, 'getProxyTarget').mockImplementation((nid: number) => (
    nid === pilotNodeId ? { apiUrl: `http://127.0.0.1:${port}`, apiToken: '', trustedLoopback: true } : original(nid)
  ));

  await makeUser('relay-viewer', 'viewer');
  await makeUser('relay-deployer', 'deployer');
  await makeUser('relay-auditor', 'auditor');
});

afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  cleanupTestDb(tmpDir);
});

beforeEach(async () => {
  hops = [];
  const { DatabaseService } = await import('../services/DatabaseService');
  for (const id of userIds.values()) DatabaseService.getInstance().deleteRoleAssignmentsByUser(id);
});

const MUTATIONS: Array<[string, string]> = [
  ['capture', '/api/recovery/storage/points'],
  ['verify', '/api/recovery/points/p1/verify'],
  ['restore', '/api/recovery/points/p1/restore'],
  ['cancel', '/api/recovery/operations/o1/cancel'],
  ['lock release', '/api/recovery/locks/release'],
  ['provisioning', '/api/recovery/repository'],
];

describe('a node grant on a relayed recovery call', () => {
  for (const [label, nodeKey] of [['direct proxy', 'proxy'], ['Pilot', 'pilot']] as const) {
    const nodeId = () => (nodeKey === 'proxy' ? proxyNodeId : pilotNodeId);

    for (const [call, path] of MUTATIONS) {
      it(`over ${label}: forwards a ${call} from a viewer with a node-admin grant on that node as node-admin`, async () => {
        await grant('relay-viewer', 'node-admin', nodeId());
        const res = await request(app).post(path).set('Authorization', bearers.get('relay-viewer')!)
          .set('x-node-id', String(nodeId())).send({});
        expect(res.status).toBe(202);
        expect(hops.find((h) => h.url.startsWith(path))?.role).toBe('node-admin');
      });
    }

    it(`over ${label}: forwards a Node Admin grant held by a deployer and an auditor the same way`, async () => {
      for (const user of ['relay-deployer', 'relay-auditor']) {
        await grant(user, 'node-admin', nodeId());
        hops = [];
        const res = await request(app).post('/api/recovery/storage/points').set('Authorization', bearers.get(user)!)
          .set('x-node-id', String(nodeId())).send({});
        expect(res.status).toBe(202);
        expect(hops.find((h) => h.url.startsWith('/api/recovery/storage/points'))?.role).toBe('node-admin');
      }
    });

    it(`over ${label}: forwards the user's own role when the grant carries no edit access`, async () => {
      await grant('relay-viewer', 'deployer', nodeId());
      const res = await request(app).post('/api/recovery/storage/points').set('Authorization', bearers.get('relay-viewer')!)
        .set('x-node-id', String(nodeId())).send({});
      expect(res.status).toBe(202);
      expect(hops.find((h) => h.url.startsWith('/api/recovery/storage/points'))?.role).toBe('viewer');
    });

    it(`over ${label}: forwards the user's own role without a grant`, async () => {
      const res = await request(app).post('/api/recovery/storage/points').set('Authorization', bearers.get('relay-viewer')!)
        .set('x-node-id', String(nodeId())).send({});
      expect(res.status).toBe(202);
      expect(hops.find((h) => h.url.startsWith('/api/recovery/storage/points'))?.role).toBe('viewer');
    });

    it(`over ${label}: reads are never elevated`, async () => {
      await grant('relay-viewer', 'node-admin', nodeId());
      const res = await request(app).get('/api/recovery/storage').set('Authorization', bearers.get('relay-viewer')!)
        .set('x-node-id', String(nodeId()));
      expect(res.status).toBe(202);
      expect(hops.find((h) => h.url.startsWith('/api/recovery/storage'))?.role).toBe('viewer');
    });
  }

  it('forwards a node-scoped Admin grant as node-admin, never as admin', async () => {
    await grant('relay-viewer', 'admin', proxyNodeId);
    const res = await request(app).post('/api/recovery/repository').set('Authorization', bearers.get('relay-viewer')!)
      .set('x-node-id', String(proxyNodeId)).send({});
    expect(res.status).toBe(202);
    expect(hops.find((h) => h.url.startsWith('/api/recovery/repository'))?.role).toBe('node-admin');
  });

  it('forwards a hub admin and a global node-admin as themselves on the repository call', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    for (const role of ['admin', 'node-admin'] as const) {
      const name = `relay-global-${role}`;
      db.addUser({ username: name, password_hash: await bcrypt.hash('password123', 1), role });
      const row = db.getUserByUsername(name)!;
      const bearer = `Bearer ${jwt.sign({ username: name, role, tv: row.token_version }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;
      hops = [];
      const res = await request(app).post('/api/recovery/repository').set('Authorization', bearer)
        .set('x-node-id', String(proxyNodeId)).send({});
      expect(res.status, role).toBe(202);
      expect(hops.find((h) => h.url.startsWith('/api/recovery/repository'))?.role, role).toBe(role);
    }
  });

  it('does not carry a grant on another node to this one', async () => {
    await grant('relay-viewer', 'node-admin', otherNodeId);
    const res = await request(app).post('/api/recovery/storage/points').set('Authorization', bearers.get('relay-viewer')!)
      .set('x-node-id', String(proxyNodeId)).send({});
    expect(res.status).toBe(202);
    expect(hops.find((h) => h.url.startsWith('/api/recovery/storage/points'))?.role).toBe('viewer');
  });

  it('does not let a client choose the forwarded role', async () => {
    const res = await request(app).post('/api/recovery/storage/points').set('Authorization', bearers.get('relay-viewer')!)
      .set('x-node-id', String(proxyNodeId)).set(PROXY_ROLE_HEADER, 'node-admin').send({});
    expect(res.status).toBe(202);
    expect(hops.find((h) => h.url.startsWith('/api/recovery/storage/points'))?.role).toBe('viewer');
  });
});
