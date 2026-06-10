/**
 * Compose Doctor routes: GET returns the stored run (never-run before any run),
 * POST runs and persists. Both require stack:read and reject unauthenticated and
 * missing-stack requests. Docker render + snapshot are mocked.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import DockerController from '../services/DockerController';
import { ComposeService } from '../services/ComposeService';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;

const STACK = 'preflightroute';

function stub() {
  vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
    renderConfig: vi.fn().mockResolvedValue({
      rendered: JSON.stringify({ name: STACK, services: { web: { image: 'nginx:latest', ports: [{ target: 80, published: '8080', protocol: 'tcp' }] } }, networks: {}, volumes: {} }),
      stderr: '', code: 0, timedOut: false,
    }),
  } as unknown as ComposeService);
  vi.spyOn(DockerController, 'getInstance').mockReturnValue({
    getDependencySnapshot: vi.fn().mockResolvedValue({ containers: [], networks: [], volumes: [] }),
  } as unknown as DockerController);
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authHeader = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;
});

afterAll(() => cleanupTestDb(tmpDir));

describe('preflight routes', () => {
  let stackDir: string;
  beforeEach(() => {
    stackDir = path.join(process.env.COMPOSE_DIR as string, STACK);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx:latest\n    ports:\n      - "8080:80"\n');
    stub();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(stackDir, { recursive: true, force: true });
  });

  it('GET returns a never-run report before any run', async () => {
    const res = await request(app).get(`/api/stacks/${STACK}/preflight`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('never-run');
    expect(res.body.findings).toEqual([]);
  });

  it('POST runs preflight, persists, and GET then returns the stored run', async () => {
    const run = await request(app).post(`/api/stacks/${STACK}/preflight/run`).set('Authorization', authHeader);
    expect(run.status).toBe(200);
    expect(run.body.renderable).toBe(true);
    expect(run.body.findings.length).toBeGreaterThan(0);
    expect(run.body.findings.map((f: { ruleId: string }) => f.ruleId)).toContain('port-exposed-all-interfaces');

    const get = await request(app).get(`/api/stacks/${STACK}/preflight`).set('Authorization', authHeader);
    expect(get.body.status).toBe(run.body.status);
    expect(get.body.findings.length).toBe(run.body.findings.length);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get(`/api/stacks/${STACK}/preflight`);
    expect(res.status).toBe(401);
  });

  it('returns 404 for a stack that does not exist', async () => {
    const res = await request(app).post('/api/stacks/nope-not-here/preflight/run').set('Authorization', authHeader);
    expect(res.status).toBe(404);
  });
});
