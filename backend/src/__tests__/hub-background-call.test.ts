/**
 * The node's sealed secret routes answer only the hub's own background call:
 * a node_proxy or pilot_tunnel bearer that carries no forwarded role header.
 * The hub refuses to forward a user request to the prefix at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

import { cleanupTestDb, setupTestDb, TEST_JWT_SECRET, TEST_USERNAME } from './helpers/setupTestDb';
import { createTestApiToken } from './helpers/apiTokenTestHelper';
import { PROXY_ROLE_HEADER } from '../services/license-headers';
import { isHubOnlyPath } from '../helpers/proxyExemptPaths';
import { classifyRegistryDeliveryOp } from '../helpers/registryOpClassifier';

const SLOT = '0b9f3c2e-1d4a-4b5c-8d6e-7f8091a2b3c4';

let tmpDir: string;
let app: import('express').Express;
let directNodeId: number;
let pilotNodeId: number;
let apiToken: string;

const sign = (payload: Record<string, unknown>) => jwt.sign(payload, TEST_JWT_SECRET, { expiresIn: '1m' });

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  const { DatabaseService } = await import('../services/DatabaseService');
  const db = DatabaseService.getInstance();
  directNodeId = db.addNode({
    name: 'bg-direct', type: 'remote', mode: 'proxy', compose_dir: '/tmp', is_default: false,
    api_url: 'http://127.0.0.1:1', api_token: 'bg-direct-token',
  });
  pilotNodeId = db.addNode({ name: 'bg-pilot', type: 'remote', mode: 'pilot_agent', compose_dir: '/tmp', is_default: false });
  const admin = db.getUserByUsername(TEST_USERNAME);
  apiToken = createTestApiToken({ db: DatabaseService, scope: 'full-admin', userId: admin!.id });
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

const ROUTES: Array<[string, string, Record<string, unknown> | undefined]> = [
  ['GET', '/api/sealed-secrets/key', undefined],
  ['GET', '/api/sealed-secrets', undefined],
  ['GET', `/api/sealed-secrets/edge-tunnel-run-token/${SLOT}`, undefined],
  ['POST', '/api/sealed-secrets/edge-tunnel-run-token', { slot: SLOT, generation: 1 }],
  ['DELETE', `/api/sealed-secrets/edge-tunnel-run-token/${SLOT}`, { generation: 1 }],
];

function send(method: string, path: string, body: Record<string, unknown> | undefined) {
  const agent = request(app);
  const req = method === 'POST' ? agent.post(path) : method === 'DELETE' ? agent.delete(path) : agent.get(path);
  return body ? req.send(body) : req;
}

describe('node sealed secret routes', () => {
  it.each(ROUTES)('%s %s refuses a signed-in session', async (method, path, body) => {
    const res = await send(method, path, body).set('Authorization', `Bearer ${sign({ username: TEST_USERNAME })}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('HUB_BACKGROUND_REQUIRED');
  });

  it.each(ROUTES)('%s %s refuses an API token', async (method, path, body) => {
    const res = await send(method, path, body).set('Authorization', `Bearer ${apiToken}`);
    expect(res.status).toBe(403);
  });

  it.each(ROUTES)('%s %s refuses a machine bearer that carries a forwarded role', async (method, path, body) => {
    for (const scope of ['node_proxy', 'pilot_tunnel']) {
      const res = await send(method, path, body)
        .set('Authorization', `Bearer ${sign({ scope })}`)
        .set(PROXY_ROLE_HEADER, 'admin');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('HUB_BACKGROUND_REQUIRED');
    }
  });

  it.each(ROUTES)('%s %s refuses a partial (MFA pending) session', async (method, path, body) => {
    const res = await send(method, path, body).set('Authorization', `Bearer ${sign({ username: TEST_USERNAME, scope: 'mfa_pending', user_id: 1 })}`);
    expect(res.status).toBe(403);
  });

  it('accepts the hub background call on both machine scopes', async () => {
    for (const scope of ['node_proxy', 'pilot_tunnel']) {
      const res = await request(app).get('/api/sealed-secrets/key').set('Authorization', `Bearer ${sign({ scope })}`);
      expect(res.status).toBe(200);
      expect(typeof res.body.fingerprint).toBe('string');
      expect(typeof res.body.deliverySourceId).toBe('string');
      const list = await request(app).get('/api/sealed-secrets').set('Authorization', `Bearer ${sign({ scope })}`);
      expect(list.status).toBe(200);
      expect(Array.isArray(list.body.items)).toBe(true);
    }
  });

  it('answers an unknown purpose and a bad slot with 400, never 404', async () => {
    const bearer = `Bearer ${sign({ scope: 'node_proxy' })}`;
    const purpose = await request(app).get(`/api/sealed-secrets/unknown/${SLOT}`).set('Authorization', bearer);
    expect(purpose.status).toBe(400);
    expect(purpose.body.code).toBe('SEALED_SECRET_PURPOSE_UNKNOWN');
    const slot = await request(app).get('/api/sealed-secrets/edge-tunnel-run-token/not-a-uuid').set('Authorization', bearer);
    expect(slot.status).toBe(400);
    expect(slot.body.code).toBe('SEALED_SECRET_SLOT_INVALID');
  });

  it('answers a sealed body that does not open with 422 and records the refusal', async () => {
    const res = await request(app)
      .post('/api/sealed-secrets/edge-tunnel-run-token')
      .set('Authorization', `Bearer ${sign({ scope: 'node_proxy' })}`)
      .send({
        slot: SLOT, generation: 1, operationId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', actor: 'admin',
        sealed: { v: 1, epk: 'AAAA', n: 'AAAA', ct: 'AAAA' },
      });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SEALED_SECRET_OPEN_FAILED');
  });
});

describe('the hub never forwards a user request to the sealed secret prefix', () => {
  it('classifies the prefix as hub-only', () => {
    expect(isHubOnlyPath('/api/sealed-secrets')).toBe(true);
    expect(isHubOnlyPath('/api/sealed-secrets/key')).toBe(true);
    expect(isHubOnlyPath(`/api/sealed-secrets/edge-tunnel-run-token/${SLOT}`)).toBe(true);
  });

  it.each([
    ['direct proxy', () => directNodeId],
    ['Pilot', () => pilotNodeId],
  ])('refuses %s forwarding with HUB_ONLY_ENDPOINT', async (_name, nodeId) => {
    for (const [method, path, body] of ROUTES) {
      const res = await send(method, path, body)
        .set('Authorization', `Bearer ${sign({ username: TEST_USERNAME })}`)
        .set('x-node-id', String(nodeId()));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('HUB_ONLY_ENDPOINT');
    }
  });

  it('is never eligible for registry credential delivery', () => {
    for (const [method, path] of ROUTES) {
      expect(classifyRegistryDeliveryOp(method, path.replace(/^\/api/, '')).eligible).toBe(false);
      expect(classifyRegistryDeliveryOp(method, path).eligible).toBe(false);
    }
  });
});
