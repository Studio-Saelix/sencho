/**
 * Hub-side authorization for create-from-git on remote nodes.
 *
 * Hop-1 discovery runs a full git fetch on the target with the caller's
 * credentials before the target's own permission check, so the hub must
 * verify stack:create (and stack:deploy when the request deploys) before any
 * discover call leaves it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import bcrypt from 'bcrypt';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_JWT_SECRET, TEST_USERNAME } from './helpers/setupTestDb';
import { REMOTE_REGISTRY_EXACT_REF_PROOF_V1_CAPABILITY } from '../services/CapabilityRegistry';

let tmpDir: string;
let app: import('express').Express;
let viewerBearer: string;
let adminBearer: string;
let remoteNodeId: number;
let remoteServer: http.Server;
const remoteHops: string[] = [];

function remoteStub(): http.Server {
  return http.createServer((req, res) => {
    if (req.url?.startsWith('/api/meta')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        version: '0.98.0',
        capabilities: ['cross-node-rbac', REMOTE_REGISTRY_EXACT_REF_PROOF_V1_CAPABILITY],
      }));
      return;
    }
    remoteHops.push(req.url ?? '');
    if (req.url?.includes('/api/registry-delivery/discover')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'The configured branch, tag, or commit was not found in the repository.',
        code: 'REF_NOT_FOUND',
      }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as import('net').AddressInfo).port;
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  const { DatabaseService } = await import('../services/DatabaseService');

  const db = DatabaseService.getInstance();
  const hash = await bcrypt.hash('password123', 1);
  db.addUser({ username: 'from-git-viewer', password_hash: hash, role: 'viewer' });
  const viewer = db.getUserByUsername('from-git-viewer')!;
  viewerBearer = jwt.sign(
    { username: 'from-git-viewer', role: 'viewer', tv: viewer.token_version },
    TEST_JWT_SECRET,
    { expiresIn: '5m' },
  );
  const admin = db.getUserByUsername(TEST_USERNAME)!;
  adminBearer = jwt.sign(
    { username: TEST_USERNAME, role: 'admin', tv: admin.token_version },
    TEST_JWT_SECRET,
    { expiresIn: '5m' },
  );

  remoteServer = remoteStub();
  const port = await listen(remoteServer);
  remoteNodeId = db.addNode({
    name: 'from-git-remote',
    type: 'remote',
    mode: 'proxy',
    compose_dir: '/tmp',
    is_default: false,
    api_url: `http://127.0.0.1:${port}`,
    api_token: 'from-git-token',
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => remoteServer.close(() => resolve()));
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

const fromGitBody = {
  stack_name: 'from-git-authz',
  repo_url: 'git@github.com:acme/demo.git',
  branch: 'main',
  compose_paths: ['compose.yaml'],
  auth_type: 'deploy_key',
  deploy_key: 'PRIVATE KEY MATERIAL',
  ssh_known_hosts_entry: 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestOnly',
  ca_bundle: 'PEM CERTIFICATE MATERIAL',
};

describe('remote create-from-git authorization', () => {
  it('refuses a viewer before any discovery fetch leaves the hub', async () => {
    remoteHops.length = 0;
    const res = await request(app)
      .post('/api/stacks/from-git')
      .set('Authorization', `Bearer ${viewerBearer}`)
      .set('x-node-id', String(remoteNodeId))
      .send(fromGitBody);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
    expect(remoteHops.some((url) => url.includes('/api/registry-delivery/discover'))).toBe(false);
    expect(remoteHops.some((url) => url.includes('/stacks/from-git'))).toBe(false);
  });

  it('refuses a viewer on the trailing-slash form too', async () => {
    remoteHops.length = 0;
    const res = await request(app)
      .post('/api/stacks/from-git/')
      .set('Authorization', `Bearer ${viewerBearer}`)
      .set('x-node-id', String(remoteNodeId))
      .send(fromGitBody);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
    expect(remoteHops.some((url) => url.includes('/api/registry-delivery/discover'))).toBe(false);
    expect(remoteHops.some((url) => url.includes('/stacks/from-git'))).toBe(false);
  });

  it('refuses a viewer before parsing a non-object body', async () => {
    remoteHops.length = 0;
    const res = await request(app)
      .post('/api/stacks/from-git')
      .set('Authorization', `Bearer ${viewerBearer}`)
      .set('x-node-id', String(remoteNodeId))
      .set('Content-Type', 'application/json')
      .send('"hello"');

    expect(res.status).toBe(403);
    expect(remoteHops.some((url) => url.includes('/api/registry-delivery/discover'))).toBe(false);
  });

  it('lets an authorized caller reach discovery', async () => {
    remoteHops.length = 0;
    const res = await request(app)
      .post('/api/stacks/from-git')
      .set('Authorization', `Bearer ${adminBearer}`)
      .set('x-node-id', String(remoteNodeId))
      .send(fromGitBody);

    // The stub answers discover with a classified 404, which the hub relays.
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('REF_NOT_FOUND');
    expect(remoteHops.some((url) => url.includes('/api/registry-delivery/discover'))).toBe(true);
  });
});
