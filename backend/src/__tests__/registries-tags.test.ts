import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

vi.mock('../services/registry-api', async () => {
  const actual = await vi.importActual<typeof import('../services/registry-api')>('../services/registry-api');
  return {
    ...actual,
    listRegistryTagsResult: vi.fn(),
  };
});

import { listRegistryTagsResult } from '../services/registry-api';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;
let RegistryService: typeof import('../services/RegistryService').RegistryService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ RegistryService } = await import('../services/RegistryService'));
  const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '10m' });
  authHeader = `Bearer ${token}`;
});

afterAll(() => cleanupTestDb(tmpDir));

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(listRegistryTagsResult).mockReset();
});

describe('GET /api/registries/:id/tags', () => {
  it('returns tags for an exact registry id', async () => {
    const id = RegistryService.getInstance().create({
      name: 'Hub',
      url: 'https://index.docker.io/v1/',
      type: 'dockerhub',
      username: 'user',
      secret: 'token',
    });
    vi.mocked(listRegistryTagsResult).mockResolvedValue({ ok: true, tags: ['latest', '1.0'] });

    const res = await request(app)
      .get(`/api/registries/${id}/tags`)
      .query({ repository: 'library/nginx' })
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.tags).toEqual(['latest', '1.0']);
    expect(res.body.registryId).toBe(id);
    expect(listRegistryTagsResult).toHaveBeenCalled();
  });

  it('maps upstream unauthorized to 424 with REGISTRY_UNAUTHORIZED (never 401)', async () => {
    const id = RegistryService.getInstance().create({
      name: 'Hub2',
      url: 'https://index.docker.io/v1/',
      type: 'dockerhub',
      username: 'user',
      secret: 'bad',
    });
    vi.mocked(listRegistryTagsResult).mockResolvedValue({
      ok: false,
      code: 'REGISTRY_UNAUTHORIZED',
      message: 'Registry rejected credentials',
    });

    const res = await request(app)
      .get(`/api/registries/${id}/tags`)
      .query({ repository: 'library/nginx' })
      .set('Authorization', authHeader);

    expect(res.status).toBe(424);
    expect(res.body.code).toBe('REGISTRY_UNAUTHORIZED');
    expect(res.status).not.toBe(401);
  });

  it('rejects host-looking repository values', async () => {
    const id = RegistryService.getInstance().create({
      name: 'GHCR',
      url: 'ghcr.io',
      type: 'ghcr',
      username: 'user',
      secret: 'token',
    });

    const res = await request(app)
      .get(`/api/registries/${id}/tags`)
      .query({ repository: 'ghcr.io/org/app' })
      .set('Authorization', authHeader);

    expect(res.status).toBe(400);
    expect(listRegistryTagsResult).not.toHaveBeenCalled();
  });

  it('maps REGISTRY_UPSTREAM from the client to HTTP 502', async () => {
    const id = RegistryService.getInstance().create({
      name: 'Down',
      url: 'https://registry.example.invalid/',
      type: 'custom',
      username: 'user',
      secret: 'token',
    });
    vi.mocked(listRegistryTagsResult).mockResolvedValue({
      ok: false,
      code: 'REGISTRY_UPSTREAM',
      message: 'Registry unreachable',
    });

    const res = await request(app)
      .get(`/api/registries/${id}/tags`)
      .query({ repository: 'org/app' })
      .set('Authorization', authHeader);

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('REGISTRY_UPSTREAM');
  });

  it('returns 404 for unknown registry id', async () => {
    const res = await request(app)
      .get('/api/registries/999999/tags')
      .query({ repository: 'org/app' })
      .set('Authorization', authHeader);

    expect(res.status).toBe(404);
  });
});
