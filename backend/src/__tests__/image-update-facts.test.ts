import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_JWT_SECRET, TEST_USERNAME } from './helpers/setupTestDb';
import { createHash } from 'crypto';
import { generateApiToken } from '../utils/apiTokenFormat';
import { COOKIE_NAME } from '../helpers/constants';
import type { ImageUpdateStackFacts } from '../services/imageUpdateFacts';

let tmpDir: string;
let app: import('express').Express;
let nodeId: number;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  const { NodeRegistry } = await import('../services/NodeRegistry');
  nodeId = NodeRegistry.getInstance().getDefaultNodeId();
});

afterEach(() => vi.restoreAllMocks());
afterAll(() => cleanupTestDb(tmpDir));

const requestNonce = 'a'.repeat(32);
const envelope = { contractVersion: 1, requestNonce };
const stackFacts: ImageUpdateStackFacts = {
  name: 'web', observationRevision: 1, observationToken: 'signed-observation',
  model: { renderable: true }, services: [], images: [],
};

async function mockFacts() {
  const { FileSystemService } = await import('../services/FileSystemService');
  const { ImageUpdateFactsService } = await import('../services/ImageUpdateFactsService');
  const filesystem = FileSystemService.getInstance(nodeId);
  vi.spyOn(FileSystemService, 'getInstance').mockReturnValue(filesystem);
  const roster = vi.spyOn(filesystem, 'getStacksStrict').mockResolvedValue(['web', 'database']);
  const collect = vi.spyOn(ImageUpdateFactsService.getInstance(), 'collect').mockResolvedValue(stackFacts);
  return { roster, collect };
}

function factsRequest(body: object, scope = 'node_proxy') {
  const token = jwt.sign({ scope }, TEST_JWT_SECRET, { expiresIn: '1m' });
  return request(app).post('/api/image-updates/inspect-facts')
    .set('Authorization', `Bearer ${token}`).send(body);
}

describe('image update facts roster', () => {
  it.each(['cookie', 'bearer'])('rejects an authenticated admin %s session before reading facts', async transport => {
    const { collect, roster } = await mockFacts();
    const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1h' });
    const pending = request(app).post('/api/image-updates/inspect-facts')
      .send({ ...envelope, stack: 'web' });
    const response = await (transport === 'cookie'
      ? pending.set('Cookie', `${COOKIE_NAME}=${token}`)
      : pending.set('Authorization', `Bearer ${token}`));
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ ...envelope, error: 'Machine authentication required' });
    expect(collect).not.toHaveBeenCalled();
    expect(roster).not.toHaveBeenCalled();
  });

  it('rejects a valid full-admin API token before reading facts', async () => {
    const { collect, roster } = await mockFacts();
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    const rawToken = generateApiToken();
    db.addApiToken({
      token_hash: createHash('sha256').update(rawToken).digest('hex'),
      name: 'facts-boundary', scope: 'full-admin',
      user_id: db.getUserByUsername(TEST_USERNAME)!.id,
      created_at: Date.now(), expires_at: null,
    });
    const response = await request(app).post('/api/image-updates/inspect-facts')
      .set('Authorization', `Bearer ${rawToken}`).send({ ...envelope, stack: 'web' });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ ...envelope, error: 'Machine authentication required' });
    expect(collect).not.toHaveBeenCalled();
    expect(roster).not.toHaveBeenCalled();
  });

  it.each(['node_proxy', 'pilot_tunnel'])('accepts named facts with %s machine authentication', async scope => {
    const { collect } = await mockFacts();
    const response = await factsRequest({ ...envelope, stack: 'web' }, scope);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ...envelope, stacks: [stackFacts] });
    expect(collect).toHaveBeenCalledExactlyOnceWith(nodeId, 'web', requestNonce);
  });

  it('returns all stack facts without changing their observation metadata', async () => {
    const { collect } = await mockFacts();
    collect.mockImplementation(async (_node, stack) => ({ ...stackFacts, name: stack }));
    const response = await factsRequest({ ...envelope, allStacks: true });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ...envelope, stacks: [stackFacts, { ...stackFacts, name: 'database' }] });
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...envelope, stack: '../escape' },
    { ...envelope, stack: '/absolute' },
    { ...envelope, roster: true, stack: 'web' },
    { ...envelope, allStacks: true, extra: true },
    { ...envelope, contractVersion: 2, roster: true },
    { ...envelope, requestNonce: '', roster: true },
  ])('rejects invalid envelopes before collecting facts: %j', async body => {
    const { collect, roster } = await mockFacts();
    const response = await factsRequest(body);
    expect(response.status).toBe(400);
    expect(collect).not.toHaveBeenCalled();
    expect(roster).not.toHaveBeenCalled();
  });

  it('rejects nonexistent stacks without rendering or probing', async () => {
    const { collect } = await mockFacts();
    const response = await factsRequest({ ...envelope, stack: 'missing' });
    expect(response.status).toBe(404);
    expect(response.body.requestNonce).toBe(requestNonce);
    expect(collect).not.toHaveBeenCalled();
  });

  it('rejects more than 500 stacks before collecting facts', async () => {
    const { collect, roster } = await mockFacts();
    roster.mockResolvedValue(Array.from({ length: 501 }, (_, i) => `stack-${i}`));
    const response = await factsRequest({ ...envelope, allStacks: true });
    expect(response.status).toBe(413);
    expect(response.body.requestNonce).toBe(requestNonce);
    expect(collect).not.toHaveBeenCalled();
  });

  it('stops collection as soon as the all-stacks response exceeds its byte cap', async () => {
    const { collect } = await mockFacts();
    collect.mockResolvedValue({ ...stackFacts, observationToken: 'x'.repeat(1024 * 1024) });
    const response = await factsRequest({ ...envelope, allStacks: true });
    expect(response.status).toBe(413);
    expect(response.body.requestNonce).toBe(requestNonce);
    expect(collect).toHaveBeenCalledTimes(1);
  });

  it('returns only stack names with the contract version and echoed nonce for a machine token', async () => {
    const { FileSystemService } = await import('../services/FileSystemService');
    const filesystem = FileSystemService.getInstance(nodeId);
    vi.spyOn(FileSystemService, 'getInstance').mockReturnValue(filesystem);
    const listStacks = vi.spyOn(filesystem, 'getStacksStrict')
      .mockResolvedValue(['web', 'database']);
    const token = jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });
    const requestNonce = 'a'.repeat(32);

    const response = await request(app)
      .post('/api/image-updates/inspect-facts')
      .set('Authorization', `Bearer ${token}`)
      .send({ contractVersion: 1, requestNonce, roster: true });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ contractVersion: 1, requestNonce, stacks: ['web', 'database'] });
    expect(listStacks).toHaveBeenCalledTimes(1);
  });
});
