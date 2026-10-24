/**
 * Route tests for GET /api/stacks/:stackName/health-observation: this node
 * serves its own containers to the instance running a rollout against it, and
 * a read that cannot happen now is reported as unavailable rather than as a
 * failure of the request.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

const mockReadFacts = vi.fn();
const mockReadDeclared = vi.fn();

vi.mock('../services/health/stackHealthFacts', () => ({
  readStackHealthFacts: (...args: unknown[]) => mockReadFacts(...args),
  readStackDeclaredRestartIntent: (...args: unknown[]) => mockReadDeclared(...args),
}));

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;

const CONTAINER = {
  id: 'c1'.padEnd(64, '0'),
  name: 'obs-web-1',
  service: 'web',
  state: 'running',
  health: 'healthy',
  restartCount: 0,
  startedAt: '2026-06-10T00:00:00Z',
  imageId: 'sha256:abc',
  exitCode: 0,
  restartPolicy: 'unless-stopped',
};

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });
  authHeader = `Bearer ${token}`;
  const stackDir = path.join(process.env.COMPOSE_DIR as string, 'obsstack');
  fs.mkdirSync(stackDir, { recursive: true });
  fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx:1.27\n');
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  mockReadFacts.mockReset();
  mockReadDeclared.mockReset();
  mockReadFacts.mockResolvedValue({ kind: 'ok', containers: [CONTAINER] });
  mockReadDeclared.mockResolvedValue(new Map([['web', 'unless-stopped']]));
});

describe('GET /api/stacks/:stackName/health-observation', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/stacks/obsstack/health-observation');
    expect(res.status).toBe(401);
  });

  it('returns 404 for a stack this node does not have', async () => {
    const res = await request(app)
      .get('/api/stacks/not-here/health-observation')
      .set('Authorization', authHeader);
    expect(res.status).toBe(404);
    expect(mockReadFacts).not.toHaveBeenCalled();
  });

  it('serves the node\'s own containers, without rendering the stack', async () => {
    const res = await request(app)
      .get('/api/stacks/obsstack/health-observation')
      .set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ containers: [CONTAINER], declaredRestartByService: null });
    expect(mockReadFacts).toHaveBeenCalledWith({ nodeId: expect.any(Number), stackName: 'obsstack' });
    expect(mockReadDeclared, 'a render is opt-in, not part of every poll').not.toHaveBeenCalled();
  });

  it('adds the declared restart intent when the caller asks for it', async () => {
    const res = await request(app)
      .get('/api/stacks/obsstack/health-observation?declaredRestart=1')
      .set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.declaredRestartByService).toEqual({ web: 'unless-stopped' });
  });

  it('reports a node that cannot read its own containers as unavailable', async () => {
    mockReadFacts.mockResolvedValue({ kind: 'unavailable', cause: 'docker', detail: 'ECONNREFUSED' });

    const res = await request(app)
      .get('/api/stacks/obsstack/health-observation')
      .set('Authorization', authHeader);
    expect(res.status).toBe(503);
  });
});
