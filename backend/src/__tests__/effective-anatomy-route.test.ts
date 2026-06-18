/**
 * GET /api/stacks/:stackName/effective-anatomy: returns the merged effective
 * facts, requires stack:read, 404s a missing stack, surfaces a structural (never
 * raw) error on render failure, and never leaks an env or label value.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { ComposeService } from '../services/ComposeService';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;

const STACK = 'effanat';
const ENV_SECRET = 'env-secret-71bd-value';
const LABEL_SECRET = 'label-secret-22ce-value';

function stubRender(rendered: string | null, stderr = '') {
  vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
    renderConfig: vi.fn().mockResolvedValue({ rendered, stderr, code: rendered === null ? 1 : 0, timedOut: false }),
  } as unknown as ComposeService);
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authHeader = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;
});

afterAll(() => cleanupTestDb(tmpDir));

describe('effective-anatomy route', () => {
  let stackDir: string;
  beforeEach(() => {
    stackDir = path.join(process.env.COMPOSE_DIR as string, STACK);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx:latest\n');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(stackDir, { recursive: true, force: true });
  });

  it('returns merged effective facts for a renderable stack', async () => {
    stubRender(JSON.stringify({
      name: STACK,
      services: {
        web: {
          image: 'nginx:latest',
          restart: 'always',
          ports: [{ target: 80, published: '8080', protocol: 'tcp' }],
          volumes: [{ type: 'volume', source: 'data', target: '/data' }],
          networks: { backend: null },
        },
      },
      networks: { backend: {}, default: {} },
      volumes: { data: {} },
    }));
    const res = await request(app).get(`/api/stacks/${STACK}/effective-anatomy`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.renderable).toBe(true);
    expect(res.body.services).toEqual(['web']);
    expect(res.body.ports.web).toEqual([{ host: '8080', container: '80', proto: 'tcp', published: true }]);
    expect(res.body.volumes.web).toEqual([{ host: 'data', container: '/data' }]);
    expect(res.body.restart).toBe('always');
    expect(res.body.networks).toEqual(['backend', 'default']);
  });

  it('surfaces a structural error and never raw stderr on render failure', async () => {
    stubRender(null, `error: the "${ENV_SECRET}" variable is not set`);
    const res = await request(app).get(`/api/stacks/${STACK}/effective-anatomy`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.renderable).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(ENV_SECRET);
  });

  it('falls back to a structural error when the render is not valid JSON', async () => {
    stubRender('this is not json {');
    const res = await request(app).get(`/api/stacks/${STACK}/effective-anatomy`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.renderable).toBe(false);
    expect(res.body.services).toEqual([]);
  });

  it('never leaks env or label values into the facts', async () => {
    stubRender(JSON.stringify({
      name: STACK,
      services: { web: { image: 'nginx:latest', environment: { TOKEN: ENV_SECRET }, labels: { 'x.secret': LABEL_SECRET } } },
      networks: {},
      volumes: {},
    }));
    const res = await request(app).get(`/api/stacks/${STACK}/effective-anatomy`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(ENV_SECRET);
    expect(body).not.toContain(LABEL_SECRET);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get(`/api/stacks/${STACK}/effective-anatomy`);
    expect(res.status).toBe(401);
  });

  it('returns 404 for a stack that does not exist', async () => {
    stubRender(JSON.stringify({ name: 'x', services: {}, networks: {}, volumes: {} }));
    const res = await request(app).get('/api/stacks/nope-not-here/effective-anatomy').set('Authorization', authHeader);
    expect(res.status).toBe(404);
  });
});
