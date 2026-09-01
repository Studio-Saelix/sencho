import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  cleanupTestDb,
  setupTestDb,
  TEST_PASSWORD,
  TEST_USERNAME,
} from './helpers/setupTestDb';

let authRouter: typeof import('../routes/auth').authRouter;
let tmpDir: string;
let app: import('express').Express;

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.resetModules();
  tmpDir = await setupTestDb();
  ({ authRouter } = await import('../routes/auth'));

  app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/auth', authRouter);
});

afterAll(() => {
  cleanupTestDb(tmpDir);
  vi.unstubAllEnvs();
});

describe('production login rate limiter', () => {
  it('blocks repeated attempts from one source', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failure = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', '198.51.100.10')
        .send({ username: TEST_USERNAME, password: 'wrong-password' });
      expect(failure.status).toBe(401);
    }

    const blocked = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', '198.51.100.10')
      .send({ username: TEST_USERNAME, password: 'wrong-password' });

    expect(blocked.status).toBe(429);
  });

  it('allows valid credentials after failures from other sources', async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const failure = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', `203.0.113.${attempt + 1}`)
        .send({ username: TEST_USERNAME, password: 'wrong-password' });
      expect(failure.status).toBe(401);
    }

    const validLogin = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', '203.0.113.250')
      .send({ username: TEST_USERNAME, password: TEST_PASSWORD });

    expect(validLogin.status).toBe(200);
  });
});
