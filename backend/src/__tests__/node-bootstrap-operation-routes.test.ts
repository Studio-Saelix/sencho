import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { createTestApiToken } from './helpers/apiTokenTestHelper';
import { NodeBootstrapOperationService } from '../services/nodeBootstrap/NodeBootstrapOperationService';
import { buildBootstrapPlan } from '../services/nodeBootstrap/planBuilder';
import { makeFacts } from './__helpers__/bootstrapFacts';

/**
 * The operation routes' guards and refusals. Execution itself is covered
 * against a scripted host in node-bootstrap-operations.test.ts; these tests
 * prove that nothing reaches it without an admin session, a valid body and a
 * plan the same operator reviewed.
 */

let tmpDir: string;
let app: import('express').Express;
let adminAuth: string;
let viewerAuth: string;
let machineAuth: string;
let apiTokenAuth: string;

const BODY = {
  host: 'server.example.com',
  port: 22,
  username: 'ubuntu',
  privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----',
  expectedFingerprint: 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCD',
  targetName: 'media-server',
  composeDir: '/opt/docker/sencho',
  agentDir: '/opt/sencho-agent',
  planDigest: 'a'.repeat(64),
};

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  const db = DatabaseService.getInstance();
  db.addUser({ username: 'operations-viewer', password_hash: 'x', role: 'viewer' });
  adminAuth = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;
  viewerAuth = `Bearer ${jwt.sign({ username: 'operations-viewer' }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;
  machineAuth = `Bearer ${jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;
  const admin = db.getUserByUsername(TEST_USERNAME);
  if (!admin) throw new Error('test admin missing');
  apiTokenAuth = `Bearer ${createTestApiToken({
    db: DatabaseService,
    scope: 'full-admin',
    userId: admin.id,
    name: 'bootstrap-operations-token',
    expiresAt: Date.now() + 60_000,
  })}`;
});

afterAll(() => cleanupTestDb(tmpDir));

const ID = '00000000-0000-4000-8000-0000000000aa';
const routes: Array<['get' | 'post', string]> = [
  ['get', '/api/nodes/bootstrap/operations'],
  ['post', '/api/nodes/bootstrap/operations'],
  ['get', `/api/nodes/bootstrap/operations/${ID}`],
  ['post', `/api/nodes/bootstrap/operations/${ID}/retry`],
  ['post', `/api/nodes/bootstrap/operations/${ID}/cancel`],
  ['post', `/api/nodes/bootstrap/operations/${ID}/release`],
];

describe('bootstrap operation routes: authorization', () => {
  it.each(routes)('%s %s requires a signed-in admin session', async (method, path) => {
    expect((await request(app)[method](path).send(BODY)).status).toBe(401);
    const viewer = await request(app)[method](path).set('Authorization', viewerAuth).send(BODY);
    expect(viewer.status).toBe(403);
    expect(viewer.body.code).toBe('ADMIN_REQUIRED');
    const machine = await request(app)[method](path).set('Authorization', machineAuth).send(BODY);
    expect(machine.status).toBe(403);
    const token = await request(app)[method](path).set('Authorization', apiTokenAuth).send(BODY);
    expect(token.status).toBe(403);
  });
});

describe('bootstrap operation routes: refusals', () => {
  it('refuses a plan that was never reviewed', async () => {
    const res = await request(app).post('/api/nodes/bootstrap/operations').set('Authorization', adminAuth).send(BODY);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PLAN_NOT_CURRENT');
  });

  it('refuses a key that cannot be read with the preflight\'s own answer, and leaves the approval for the corrected key', async () => {
    const facts = makeFacts();
    const plan = buildBootstrapPlan({ facts, targetName: 'media-server', hubUrl: 'https://sencho.example.com', caPem: null, now: Date.now() });
    const operations = NodeBootstrapOperationService.getInstance();
    operations.rememberPlan({
      inspection: {
        observedAt: Date.now(), target: facts.target, hostKey: facts.hostKey, paths: facts.paths, agent: facts.agent,
        dockerRoot: facts.dockerRoot, checks: [], blockers: 0, warnings: 0,
      },
      plan,
      blocked: false,
    }, TEST_USERNAME, null);
    const body = {
      host: plan.target.host, port: plan.target.port, username: plan.target.username, expectedFingerprint: plan.hostKeyFingerprint,
      targetName: plan.targetName, composeDir: plan.paths.composeDir.input, agentDir: plan.paths.agentDir.input, planDigest: plan.digest,
    };
    const before = (await request(app).get('/api/nodes/bootstrap/operations').set('Authorization', adminAuth)).body.operations.length;
    for (const privateKey of ['not a key', ' ']) {
      const res = await request(app).post('/api/nodes/bootstrap/operations').set('Authorization', adminAuth).send({ ...body, privateKey });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('SSH_KEY_INVALID');
    }
    // Neither refusal spent the approval or recorded a run: the plan is still current for the same digest.
    const retried = await request(app).post('/api/nodes/bootstrap/operations').set('Authorization', adminAuth).send({ ...body, privateKey: 'still not a key' });
    expect(retried.body.code).toBe('SSH_KEY_INVALID');
    const after = (await request(app).get('/api/nodes/bootstrap/operations').set('Authorization', adminAuth)).body.operations.length;
    expect(after).toBe(before);
  });

  it('refuses a malformed digest and a host key replacement at execution', async () => {
    const digest = await request(app).post('/api/nodes/bootstrap/operations').set('Authorization', adminAuth).send({ ...BODY, planDigest: 'abc' });
    expect(digest.status).toBe(400);
    expect(digest.body.field).toBe('planDigest');
    const replace = await request(app).post('/api/nodes/bootstrap/operations').set('Authorization', adminAuth).send({
      ...BODY, replacePinnedFingerprint: 'SHA256:new', reviewedPinnedFingerprint: 'SHA256:old',
    });
    expect(replace.status).toBe(400);
    expect(replace.body.field).toBe('replacePinnedFingerprint');
  });

  it('answers 404 for an unknown or malformed operation id', async () => {
    const unknown = await request(app).get(`/api/nodes/bootstrap/operations/${ID}`).set('Authorization', adminAuth);
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('OPERATION_NOT_FOUND');
    const malformed = await request(app).post('/api/nodes/bootstrap/operations/not-a-uuid/cancel').set('Authorization', adminAuth);
    expect(malformed.status).toBe(404);
    const release = await request(app).post(`/api/nodes/bootstrap/operations/${ID}/release`).set('Authorization', adminAuth);
    expect(release.status).toBe(404);
  });

  it('lists operations without plan bodies or secrets', async () => {
    const res = await request(app).get('/api/nodes/bootstrap/operations').set('Authorization', adminAuth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.operations)).toBe(true);
  });

  it('pages through every held operation, past twenty, without plan bodies', async () => {
    const db = DatabaseService.getInstance();
    const now = Date.now();
    const ids = Array.from({ length: 23 }, (_, index) => {
      const id = `00000000-0000-4000-8000-${String(2000 + index).padStart(12, '0')}`;
      db.insertNodeBootstrapOperation({
        id, target_key: `route-held-${index}.example.com:22`, host: `route-held-${index}.example.com`, port: 22, username: 'ubuntu', address: '192.168.1.90',
        target_name: `route-held-${index}`, host_key_fingerprint: `SHA256:route-held-${index}`, compose_dir: '/opt/docker/sencho', agent_dir: '/opt/sencho-agent',
        plan_json: '{"secret":"plan body"}', plan_digest: 'd', approved_by: 'admin', approved_at: now, attempt: 1, state: 'partial', stage: null, step: null,
        node_id: null, changes_made: 1, agent_started: 0, active: 1, cancel_requested: 0, error_code: null, error_message: null, enrollment_expires_at: null,
        created_at: now + index, updated_at: now + index, finished_at: now + index,
      });
      return id;
    });
    type Page = { operations: Array<{ id: string; active: boolean; actions: { release: boolean } }>; nextCursor: string | null };
    const first = await request(app).get('/api/nodes/bootstrap/operations').set('Authorization', adminAuth);
    expect(first.status).toBe(200);
    const firstPage = first.body as Page;
    expect(firstPage.operations.filter((entry) => entry.active)).toHaveLength(20);
    expect(typeof firstPage.nextCursor).toBe('string');
    const second = await request(app).get('/api/nodes/bootstrap/operations').query({ cursor: firstPage.nextCursor }).set('Authorization', adminAuth);
    expect(second.status).toBe(200);
    const secondPage = second.body as Page;
    expect(secondPage.nextCursor).toBeNull();
    const listed = [...firstPage.operations, ...secondPage.operations];
    for (const id of ids) expect(listed.find((entry) => entry.id === id)?.actions.release).toBe(true);
    expect(JSON.stringify([first.body, second.body])).not.toContain('plan body');
    // Any held run opens with its recovery controls.
    const opened = await request(app).get(`/api/nodes/bootstrap/operations/${ids[0]}`).set('Authorization', adminAuth);
    expect(opened.status).toBe(200);
    expect(opened.body.actions).toMatchObject({ release: true });
    for (const id of ids) db.transitionNodeBootstrapOperation(id, ['partial'], { active: 0 }, Date.now());
  });

  it('refuses a page cursor that is not one the list returned', async () => {
    for (const cursor of ['garbage', 'e30', 'x'.repeat(300), '']) {
      const res = await request(app).get('/api/nodes/bootstrap/operations').query({ cursor }).set('Authorization', adminAuth);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_CURSOR');
    }
  });

  it('refuses a repeated cursor parameter instead of picking one', async () => {
    const res = await request(app).get('/api/nodes/bootstrap/operations?cursor=a&cursor=b').set('Authorization', adminAuth);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CURSOR');
  });

  it('refuses a retry preflight for an operation that does not exist before any SSH work', async () => {
    const { planDigest: _digest, ...preflight } = BODY;
    const res = await request(app).post('/api/nodes/bootstrap/preflight').set('Authorization', adminAuth).send({ ...preflight, operationId: ID });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('OPERATION_NOT_FOUND');
  });

  it('is served by the hub even when a remote node is named', async () => {
    const res = await request(app).get('/api/nodes/bootstrap/operations').set('Authorization', adminAuth).set('x-node-id', '999');
    expect(res.status).toBe(200);
  });
});
