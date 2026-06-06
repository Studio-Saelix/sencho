/**
 * Route tests for POST /api/stacks/import/move: the guided-import write path.
 *
 * The service-level filesystem behavior is covered in import-move.test.ts; this
 * suite exercises the route's own logic against the real app: the stack:create
 * permission gate, body validation, the candidate re-match (404 for a location the
 * scan does not surface, including one that is already a stack), the
 * error-code-to-status mapping, and the success shape. Fixtures are written
 * into the per-file COMPOSE_DIR that setupTestDb wires the default node to.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let composeDir: string;
let app: import('express').Express;
let adminCookie: string;
let viewerCookie: string;

const COMPOSE = 'services:\n  app:\n    image: nginx:1.27\n';

beforeAll(async () => {
  tmpDir = await setupTestDb();
  composeDir = process.env.COMPOSE_DIR as string;
  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);

  // A viewer has no stack:create permission, so the route must 403 before it
  // touches the filesystem.
  const bcrypt = (await import('bcrypt')).default;
  const { DatabaseService } = await import('../services/DatabaseService');
  DatabaseService.getInstance().addUser({
    username: 'viewer1',
    password_hash: await bcrypt.hash('viewerpass', 1),
    role: 'viewer',
  });
  const login = await request(app)
    .post('/api/auth/login')
    .send({ username: 'viewer1', password: 'viewerpass' });
  const cookies = login.headers['set-cookie'] as string | string[];
  viewerCookie = Array.isArray(cookies) ? cookies[0] : cookies;
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

describe('POST /api/stacks/import/move', () => {
  it('returns 403 for a user without stack:create', async () => {
    const res = await request(app)
      .post('/api/stacks/import/move')
      .set('Cookie', viewerCookie)
      .send({ location: 'compose.yaml', name: 'webapp' });
    expect(res.status).toBe(403);
  });

  it('rejects a missing location with a 400', async () => {
    const res = await request(app)
      .post('/api/stacks/import/move')
      .set('Cookie', adminCookie)
      .send({ name: 'webapp' });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid stack name with a 400', async () => {
    const res = await request(app)
      .post('/api/stacks/import/move')
      .set('Cookie', adminCookie)
      .send({ location: 'compose.yaml', name: 'has space' });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the location matches no scanned candidate', async () => {
    const res = await request(app)
      .post('/api/stacks/import/move')
      .set('Cookie', adminCookie)
      .send({ location: 'ghost/compose.yaml', name: 'ghost' });
    expect(res.status).toBe(404);
  });

  it('returns 404 when the location is a stack already in the sidebar', async () => {
    // A top-level subdir with a compose file is already a stack, so the scan does
    // not surface it as a candidate; the location matches nothing and 404s.
    fs.mkdirSync(path.join(composeDir, 'already'), { recursive: true });
    fs.writeFileSync(path.join(composeDir, 'already', 'compose.yaml'), COMPOSE);
    try {
      const res = await request(app)
        .post('/api/stacks/import/move')
        .set('Cookie', adminCookie)
        .send({ location: 'already/compose.yaml', name: 'already2' });
      expect(res.status).toBe(404);
    } finally {
      fs.rmSync(path.join(composeDir, 'already'), { recursive: true, force: true });
    }
  });

  it('returns 409 when the destination stack already exists', async () => {
    fs.writeFileSync(path.join(composeDir, 'compose.yaml'), COMPOSE);
    fs.mkdirSync(path.join(composeDir, 'taken'), { recursive: true });
    fs.writeFileSync(path.join(composeDir, 'taken', 'compose.yaml'), COMPOSE);
    try {
      const res = await request(app)
        .post('/api/stacks/import/move')
        .set('Cookie', adminCookie)
        .send({ location: 'compose.yaml', name: 'taken' });
      expect(res.status).toBe(409);
      // The loose file is left in place by the failed move.
      expect(fs.existsSync(path.join(composeDir, 'compose.yaml'))).toBe(true);
    } finally {
      fs.rmSync(path.join(composeDir, 'compose.yaml'), { force: true });
      fs.rmSync(path.join(composeDir, 'taken'), { recursive: true, force: true });
    }
  });

  it('moves a loose-root file, trims the name, and returns the created stack name', async () => {
    fs.writeFileSync(path.join(composeDir, 'docker-compose.yml'), COMPOSE);
    try {
      const res = await request(app)
        .post('/api/stacks/import/move')
        .set('Cookie', adminCookie)
        .send({ location: 'docker-compose.yml', name: '  spaced  ' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ name: 'spaced' });
      expect(fs.existsSync(path.join(composeDir, 'spaced', 'docker-compose.yml'))).toBe(true);
      expect(fs.existsSync(path.join(composeDir, 'docker-compose.yml'))).toBe(false);
    } finally {
      fs.rmSync(path.join(composeDir, 'spaced'), { recursive: true, force: true });
      fs.rmSync(path.join(composeDir, 'docker-compose.yml'), { force: true });
    }
  });
});
