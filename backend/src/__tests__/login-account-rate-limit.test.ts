import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let loginAccountRateLimiter: typeof import('../middleware/rateLimiters').loginAccountRateLimiter;

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.resetModules();
  ({ loginAccountRateLimiter } = await import('../middleware/rateLimiters'));
});

afterAll(() => vi.unstubAllEnvs());

describe('login account rate limiter', () => {
  it('bounds attempts for one account even when X-Forwarded-For rotates', async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.post('/login', loginAccountRateLimiter, (_req, res) => {
      res.status(401).json({ error: 'Invalid credentials' });
    });

    let lastStatus = 0;
    for (let attempt = 0; attempt < 21; attempt += 1) {
      const res = await request(app)
        .post('/login')
        .set('X-Forwarded-For', `203.0.113.${attempt + 1}`)
        .send({
          username: attempt % 2 === 0 ? ' Target-Account ' : 'target-account',
          password: 'wrong-password',
        });
      lastStatus = res.status;
    }

    expect(lastStatus).toBe(429);
  });

  it('does not count successful logins against the account limit', async () => {
    const app = express();
    app.use(express.json());
    app.post('/login', loginAccountRateLimiter, (req, res) => {
      if (req.body.password === 'correct-password') {
        return res.status(200).json({ success: true });
      }
      return res.status(401).json({ error: 'Invalid credentials' });
    });

    for (let attempt = 0; attempt < 25; attempt += 1) {
      const success = await request(app)
        .post('/login')
        .send({ username: 'successful-account', password: 'correct-password' });
      expect(success.status).toBe(200);
    }

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const failure = await request(app)
        .post('/login')
        .send({ username: 'successful-account', password: 'wrong-password' });
      expect(failure.status).toBe(401);
    }

    const blocked = await request(app)
      .post('/login')
      .send({ username: 'successful-account', password: 'wrong-password' });
    expect(blocked.status).toBe(429);
  });
});
