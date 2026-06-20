/**
 * GET /api/stacks/:stackName/storage: returns the per-stack storage inventory +
 * portability verdict. Requires stack:read, rejects unauthenticated and
 * missing-stack requests, degrades to an unknown verdict when the model is
 * unrenderable, and never leaks raw docker stderr. Docker render is mocked.
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
let stackDir: string;

const STACK = 'storageroute';

function stubRender(result: { rendered: string | null; stderr?: string }) {
  vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
    renderConfig: vi.fn().mockResolvedValue({ rendered: result.rendered, stderr: result.stderr ?? '', code: 0, timedOut: false }),
  } as unknown as ComposeService);
}

/** A rendered model with a named volume and an external bind (so the verdict is node-bound). */
function renderedModel(): string {
  return JSON.stringify({
    name: STACK,
    services: {
      app: {
        image: 'nginx:1.27',
        volumes: [
          { type: 'volume', source: 'data', target: '/data' },
          { type: 'bind', source: '/mnt/media', target: '/media' },
        ],
      },
    },
    networks: {},
    volumes: { data: { name: `${STACK}_data` } },
  });
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authHeader = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;
});

afterAll(() => cleanupTestDb(tmpDir));

describe('storage route', () => {
  beforeEach(() => {
    stackDir = path.join(process.env.COMPOSE_DIR as string, STACK);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  app:\n    image: nginx:1.27\n');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(stackDir, { recursive: true, force: true });
  });

  it('returns the inventory, mounts, and a portability verdict', async () => {
    stubRender({ rendered: renderedModel() });
    const res = await request(app).get(`/api/stacks/${STACK}/storage`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.renderable).toBe(true);
    expect(res.body.stateful).toBe(true);
    expect(res.body.mounts.map((mnt: { type: string }) => mnt.type).sort()).toEqual(['bind', 'named']);
    expect(res.body.mounts.every((mnt: { service: string }) => mnt.service === 'app')).toBe(true);
    expect(res.body.portability.status).toBe('node-bound');
  });

  it('degrades to an unknown verdict when the model cannot be rendered', async () => {
    stubRender({ rendered: null, stderr: 'required variable "FOO" is missing' });
    const res = await request(app).get(`/api/stacks/${STACK}/storage`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.renderable).toBe(false);
    expect(res.body.portability.status).toBe('unknown');
  });

  it('never leaks raw docker stderr into the response', async () => {
    const secret = 'super-secret-env-value-9f3a';
    stubRender({ rendered: null, stderr: `boom DB_PASSWORD=${secret}` });
    const res = await request(app).get(`/api/stacks/${STACK}/storage`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(secret);
  });

  it('degrades to unknown when docker compose cannot be started (spawn failure)', async () => {
    vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
      renderConfig: vi.fn().mockRejectedValue(new Error('spawn docker ENOENT')),
    } as unknown as ComposeService);
    const res = await request(app).get(`/api/stacks/${STACK}/storage`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.renderable).toBe(false);
    expect(res.body.portability.status).toBe('unknown');
    expect(res.body.mounts).toEqual([]);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get(`/api/stacks/${STACK}/storage`);
    expect(res.status).toBe(401);
  });

  it('returns 404 for a stack that does not exist', async () => {
    stubRender({ rendered: renderedModel() });
    const res = await request(app).get('/api/stacks/nope-not-here/storage').set('Authorization', authHeader);
    expect(res.status).toBe(404);
  });
});
