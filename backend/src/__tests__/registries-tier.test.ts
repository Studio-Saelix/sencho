/**
 * Tier split for private registry credentials:
 *   Docker Hub / GHCR / custom  -> Community (admin only)
 *   AWS ECR                     -> Admiral (paid)
 *
 * Self-hosters routinely pull from GHCR and private Docker Hub, so local
 * credential management is free; only ECR (short-lived token refresh) is paid.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let adminCookie: string;
let viewerCookie: string;
let LicenseService: typeof import('../services/LicenseService').LicenseService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ LicenseService } = await import('../services/LicenseService'));
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);

  const { DatabaseService } = await import('../services/DatabaseService');
  const viewerHash = await bcrypt.hash('regviewer1', 1);
  DatabaseService.getInstance().addUser({ username: 'registry-viewer', password_hash: viewerHash, role: 'viewer' });
  const viewerRes = await request(app).post('/api/auth/login').send({ username: 'registry-viewer', password: 'regviewer1' });
  const cookies = viewerRes.headers['set-cookie'] as string | string[];
  viewerCookie = Array.isArray(cookies) ? cookies[0] : cookies;
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

const dockerhub = { name: 'dh', url: 'https://index.docker.io/v1/', type: 'dockerhub', username: 'u', secret: 's' };
const ghcr = { name: 'gh', url: 'ghcr.io', type: 'ghcr', username: 'u', secret: 's' };
const ecr = { name: 'ec', url: '123456789.dkr.ecr.us-east-1.amazonaws.com', type: 'ecr', username: 'AKIA', secret: 's', aws_region: 'us-east-1' };

function asCommunity(): { restore: () => void } {
  const spy = vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
  return { restore: () => spy.mockReturnValue('paid') };
}

describe('Registry credentials tier split', () => {
  it('lets a Community admin create Docker Hub and GHCR credentials', async () => {
    const { restore } = asCommunity();
    try {
      const dh = await request(app).post('/api/registries').set('Cookie', adminCookie).send(dockerhub);
      expect(dh.status).toBe(201);
      const gh = await request(app).post('/api/registries').set('Cookie', adminCookie).send(ghcr);
      expect(gh.status).toBe(201);
    } finally {
      restore();
    }
  });

  it('lets a Community admin list registries', async () => {
    const { restore } = asCommunity();
    try {
      const res = await request(app).get('/api/registries').set('Cookie', adminCookie);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    } finally {
      restore();
    }
  });

  it('rejects an ECR create for a Community admin with 403 PAID_REQUIRED', async () => {
    const { restore } = asCommunity();
    try {
      const res = await request(app).post('/api/registries').set('Cookie', adminCookie).send(ecr);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PAID_REQUIRED');
    } finally {
      restore();
    }
  });

  it('rejects an ECR stateless test for a Community admin with 403 PAID_REQUIRED', async () => {
    const { restore } = asCommunity();
    try {
      const res = await request(app).post('/api/registries/test').set('Cookie', adminCookie).send(ecr);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PAID_REQUIRED');
    } finally {
      restore();
    }
  });

  it('lets a Community admin create a custom registry', async () => {
    const { restore } = asCommunity();
    try {
      const res = await request(app).post('/api/registries').set('Cookie', adminCookie)
        .send({ name: 'self', url: 'registry.example.com', type: 'custom', username: 'u', secret: 's' });
      expect(res.status).toBe(201);
    } finally {
      restore();
    }
  });

  it('lets a paid admin create an ECR registry', async () => {
    const res = await request(app).post('/api/registries').set('Cookie', adminCookie).send(ecr);
    expect(res.status).toBe(201);
  });

  it('rejects a Community admin switching an existing registry to ECR via PUT', async () => {
    // Created as a paid admin so the row exists.
    const created = await request(app).post('/api/registries').set('Cookie', adminCookie)
      .send({ name: 'switchme', url: 'ghcr.io', type: 'ghcr', username: 'u', secret: 's' });
    expect(created.status).toBe(201);
    const id = created.body.id;

    const { restore } = asCommunity();
    try {
      const res = await request(app).put(`/api/registries/${id}`).set('Cookie', adminCookie)
        .send({ type: 'ecr', aws_region: 'us-east-1' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PAID_REQUIRED');
    } finally {
      restore();
    }
  });

  it('rejects a Community admin editing an existing ECR registry via PUT (effectiveType falls back to stored type)', async () => {
    const created = await request(app).post('/api/registries').set('Cookie', adminCookie).send(ecr);
    expect(created.status).toBe(201);
    const id = created.body.id;

    const { restore } = asCommunity();
    try {
      const res = await request(app).put(`/api/registries/${id}`).set('Cookie', adminCookie)
        .send({ name: 'renamed' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PAID_REQUIRED');
    } finally {
      restore();
    }
  });

  it('rejects a Community admin testing a stored ECR registry via POST /:id/test', async () => {
    const created = await request(app).post('/api/registries').set('Cookie', adminCookie).send(ecr);
    expect(created.status).toBe(201);
    const id = created.body.id;

    const { restore } = asCommunity();
    try {
      const res = await request(app).post(`/api/registries/${id}/test`).set('Cookie', adminCookie);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PAID_REQUIRED');
    } finally {
      restore();
    }
  });

  it('denies a non-admin (viewer) registry creation regardless of tier', async () => {
    const res = await request(app).post('/api/registries').set('Cookie', viewerCookie).send(dockerhub);
    expect(res.status).toBe(403);
  });
});
