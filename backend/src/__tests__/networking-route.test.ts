/**
 * GET /api/stacks/:stackName/networking: returns facts, requires stack:read,
 * 404s a missing stack, surfaces a structural (never raw) error on render
 * failure, and never leaks an env value or a label value into the response.
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

const STACK = 'netroute';
const ENV_SECRET = 'env-secret-44ad-value';
const LABEL_SECRET = 'label-secret-90fe-value';

function stubRender(rendered: string | null, stderr = '') {
  vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
    renderConfig: vi.fn().mockResolvedValue({ rendered, stderr, code: rendered === null ? 1 : 0, timedOut: false }),
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

describe('networking route', () => {
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

  it('returns networking facts for a renderable stack', async () => {
    stubRender(JSON.stringify({
      name: STACK,
      services: { web: { image: 'nginx:latest', ports: [{ target: 80, published: '8080', protocol: 'tcp' }], networks: { backend: null } } },
      networks: { backend: { name: `${STACK}_backend` } },
      volumes: {},
    }));
    const res = await request(app).get(`/api/stacks/${STACK}/networking`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.renderable).toBe(true);
    expect(res.body.runtime).toBe('available');
    expect(res.body.services[0].networks).toEqual([{ key: 'backend', aliases: [] }]);
  });

  it('surfaces a structural error and never raw stderr on render failure', async () => {
    stubRender(null, `error: the "${ENV_SECRET}" variable is not set\nservices.web.image: ${ENV_SECRET}`);
    const res = await request(app).get(`/api/stacks/${STACK}/networking`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.renderable).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(ENV_SECRET);
  });

  it('never leaks env or label values into the facts', async () => {
    stubRender(JSON.stringify({
      name: STACK,
      services: { web: { image: 'nginx:latest', environment: { TOKEN: ENV_SECRET }, labels: { 'x.secret': LABEL_SECRET } } },
      networks: {},
      volumes: {},
    }));
    const res = await request(app).get(`/api/stacks/${STACK}/networking`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(ENV_SECRET);
    expect(body).not.toContain(LABEL_SECRET);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get(`/api/stacks/${STACK}/networking`);
    expect(res.status).toBe(401);
  });

  it('returns 404 for a stack that does not exist', async () => {
    stubRender(JSON.stringify({ name: 'x', services: {}, networks: {}, volumes: {} }));
    const res = await request(app).get('/api/stacks/nope-not-here/networking').set('Authorization', authHeader);
    expect(res.status).toBe(404);
  });
});
