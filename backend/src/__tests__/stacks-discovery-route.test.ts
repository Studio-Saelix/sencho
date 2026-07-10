/**
 * Route tests for GET /api/stacks/discovery: auth, contract, and route shadowing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let authCookie: string;
let viewerCookie: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
  authCookie = await loginAsTestAdmin(app);

  const bcrypt = (await import('bcrypt')).default;
  const viewerHash = await bcrypt.hash('viewerpass', 1);
  DatabaseService.getInstance().addUser({ username: 'disc-viewer', password_hash: viewerHash, role: 'viewer' });
  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({ username: 'disc-viewer', password: 'viewerpass' });
  const cookies = loginRes.headers['set-cookie'] as string | string[];
  viewerCookie = Array.isArray(cookies) ? cookies[0] : cookies;

  const composeDir = process.env.COMPOSE_DIR!;
  fs.mkdirSync(path.join(composeDir, 'stack-a'), { recursive: true });
  fs.writeFileSync(path.join(composeDir, 'stack-a', 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');
  fs.writeFileSync(path.join(composeDir, 'docker-compose.yml'), 'services:\n  loose:\n    image: nginx\n');
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

describe('GET /api/stacks/discovery', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/stacks/discovery');
    expect(res.status).toBe(401);
  });

  it('allows stack:read for a viewer', async () => {
    const res = await request(app).get('/api/stacks/discovery').set('Cookie', viewerCookie);
    expect(res.status).toBe(200);
    expect(typeof res.body.composeDir).toBe('string');
    expect(res.body.readable).toBe(true);
    expect(res.body.discovery).toBeDefined();
  });

  it('returns the stable discovery contract for a readable compose dir', async () => {
    const res = await request(app).get('/api/stacks/discovery').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      readable: true,
      discovery: {
        composeDir: expect.any(String),
        stackCount: expect.any(Number),
        adoptCandidateCount: expect.any(Number),
        adoptCandidatesTruncated: expect.any(Boolean),
      },
    });
    expect(res.body.composeDir).toBe(res.body.discovery.composeDir);
  });

  it('does not shadow GET /:stackName (discovery is not treated as a stack name)', async () => {
    const res = await request(app).get('/api/stacks/discovery').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body).toHaveProperty('readable');
    expect(res.text).not.toMatch(/^services:/);
  });
});

describe('POST /api/stacks/import/move viewer denial', () => {
  it('rejects move without stack:create', async () => {
    const res = await request(app)
      .post('/api/stacks/import/move')
      .set('Cookie', viewerCookie)
      .send({ location: 'docker-compose.yml', name: 'moved' });
    expect(res.status).toBe(403);
  });
});
