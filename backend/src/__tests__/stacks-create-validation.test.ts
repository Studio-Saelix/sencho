/**
 * Validation tests for POST /api/stacks (create).
 *
 * The create endpoint reads the new stack name from the body field `stackName`.
 * When that field is missing or not a string it must reject with a 400 whose
 * message names the field, so an operator or a script automating against the
 * stacks API can see they sent the wrong field rather than a badly typed value.
 * These cases short-circuit before any FileSystemService call, but the route
 * gates on the `stack:create` permission first, so the test logs in as the
 * seeded admin to reach the validation branch.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let authCookie: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authCookie = await loginAsTestAdmin(app);
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

describe('POST /api/stacks required-field validation', () => {
  it('rejects a missing stackName with a 400 that names the field', async () => {
    const res = await request(app).post('/api/stacks').set('Cookie', authCookie).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Field 'stackName' is required/);
  });

  it('rejects a non-string stackName with the same field-named 400', async () => {
    const res = await request(app)
      .post('/api/stacks')
      .set('Cookie', authCookie)
      .send({ stackName: 123 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Field 'stackName' is required/);
  });
});
