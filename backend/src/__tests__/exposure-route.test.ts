/**
 * GET/PUT /api/stacks/:stackName/exposure: read and write the per-stack and
 * per-service exposure classification. PUT requires write access, validates the
 * intent value, and supports clearing a row (intent null) so a service inherits
 * the stack intent again.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { generateApiToken } from '../utils/apiTokenFormat';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;
let readOnlyToken: string;

const STACK = 'exproute';

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authHeader = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;

  const db = DatabaseService.getInstance();
  readOnlyToken = generateApiToken();
  db.addApiToken({
    token_hash: crypto.createHash('sha256').update(readOnlyToken).digest('hex'),
    name: 'exposure-readonly', scope: 'read-only',
    user_id: db.getUserByUsername(TEST_USERNAME)!.id, created_at: Date.now(), expires_at: null,
  });
});

afterAll(() => cleanupTestDb(tmpDir));

describe('exposure intent routes', () => {
  let stackDir: string;
  beforeEach(() => {
    stackDir = path.join(process.env.COMPOSE_DIR as string, STACK);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx:latest\n');
  });
  afterEach(() => {
    DatabaseService.getInstance().deleteStackExposureIntents(1, STACK);
    fs.rmSync(stackDir, { recursive: true, force: true });
  });

  const put = (body: object) => request(app).put(`/api/stacks/${STACK}/exposure`).set('Authorization', authHeader).send(body);
  const get = () => request(app).get(`/api/stacks/${STACK}/exposure`).set('Authorization', authHeader);

  it('starts with no intents', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.intents).toEqual([]);
  });

  it('sets a stack-level and a per-service intent and records the author', async () => {
    expect((await put({ intent: 'internal' })).status).toBe(200);
    const res = await put({ service: 'api', intent: 'public' });
    expect(res.status).toBe(200);
    expect(res.body.intents).toEqual([
      expect.objectContaining({ service: '', intent: 'internal' }),
      expect.objectContaining({ service: 'api', intent: 'public' }),
    ]);
    const stackRow = res.body.intents.find((i: { service: string }) => i.service === '');
    expect(stackRow.updatedBy).toBe(TEST_USERNAME);
    expect(typeof stackRow.updatedAt).toBe('number');
  });

  it('clears a service row (intent null) so it inherits the stack intent', async () => {
    await put({ intent: 'internal' });
    await put({ service: 'api', intent: 'public' });
    expect((await put({ service: 'api', intent: null })).status).toBe(200);
    const res = await get();
    expect(res.body.intents).toEqual([expect.objectContaining({ service: '', intent: 'internal' })]);
  });

  it('clears the stack row (intent null) so the stack is unclassified again', async () => {
    await put({ intent: 'internal' });
    await put({ intent: null });
    expect((await get()).body.intents).toEqual([]);
  });

  it('rejects an invalid intent value', async () => {
    expect((await put({ intent: 'bogus' })).status).toBe(400);
  });

  it('blocks a write from a read-only token', async () => {
    const res = await request(app).put(`/api/stacks/${STACK}/exposure`)
      .set('Authorization', `Bearer ${readOnlyToken}`).send({ intent: 'internal' });
    expect(res.status).toBe(403);
  });

  it('rejects an unauthenticated request', async () => {
    expect((await request(app).get(`/api/stacks/${STACK}/exposure`)).status).toBe(401);
  });

  it('returns 404 for a stack that does not exist', async () => {
    expect((await request(app).get('/api/stacks/nope-not-here/exposure').set('Authorization', authHeader)).status).toBe(404);
  });
});
