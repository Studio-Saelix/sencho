/**
 * Integration tests for optimistic concurrency on PUT /api/stacks/:name and
 * PUT /api/stacks/:name/env.
 *
 * GET returns the file content with an `ETag` header carrying the mtimeMs.
 * The frontend echoes that as `If-Match` on save. When the file on disk has
 * mutated in the interim, the server returns 412 with the current content
 * and mtime so the caller can show a "file changed" recovery sheet.
 *
 * These tests use real fs ops against a temp COMPOSE_DIR rather than mocks
 * because the contract is specifically about mtime semantics.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let composeDir: string;
let app: import('express').Express;
let authCookie: string;

const STACK = 'web';

function seedStack(stackName: string, content: string): string {
  const stackDir = path.join(composeDir, stackName);
  fs.mkdirSync(stackDir, { recursive: true });
  const filePath = path.join(stackDir, 'compose.yaml');
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function seedEnv(stackName: string, content: string): string {
  const stackDir = path.join(composeDir, stackName);
  fs.mkdirSync(stackDir, { recursive: true });
  const envPath = path.join(stackDir, '.env');
  fs.writeFileSync(envPath, content, 'utf-8');
  return envPath;
}

function parseEtag(etag: string | undefined): number | null {
  if (!etag) return null;
  const m = etag.match(/(?:W\/)?"(\d+)"/);
  return m ? Number(m[1]) : null;
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  composeDir = process.env.COMPOSE_DIR as string;
  ({ app } = await import('../index'));
  authCookie = await loginAsTestAdmin(app);
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  const stackDir = path.join(composeDir, STACK);
  if (fs.existsSync(stackDir)) {
    fs.rmSync(stackDir, { recursive: true, force: true });
  }
});

describe('GET /api/stacks/:stackName emits ETag with mtime', () => {
  it('responds 200 with content body and a W/"<mtime>" ETag header', async () => {
    seedStack(STACK, 'services:\n  web:\n    image: nginx\n');

    const res = await request(app)
      .get(`/api/stacks/${STACK}`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.text).toContain('image: nginx');
    const etag = res.headers.etag;
    expect(etag).toMatch(/^W\/"\d+"$/);
    expect(parseEtag(etag)).toBeGreaterThan(0);
  });
});

describe('PUT /api/stacks/:stackName optimistic concurrency', () => {
  it('writes successfully when If-Match matches current mtime', async () => {
    seedStack(STACK, 'original');
    const getRes = await request(app).get(`/api/stacks/${STACK}`).set('Cookie', authCookie);
    const etag = getRes.headers.etag as string;

    const putRes = await request(app)
      .put(`/api/stacks/${STACK}`)
      .set('Cookie', authCookie)
      .set('If-Match', etag)
      .send({ content: 'updated' });

    expect(putRes.status).toBe(200);
    expect(putRes.headers.etag).toMatch(/^W\/"\d+"$/);
    expect(typeof putRes.body.mtimeMs).toBe('number');
    const filePath = path.join(composeDir, STACK, 'compose.yaml');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('updated');
  });

  it('returns 412 with stack_file_changed and the current content on If-Match mismatch', async () => {
    seedStack(STACK, 'original');
    const getRes = await request(app).get(`/api/stacks/${STACK}`).set('Cookie', authCookie);
    const etag = getRes.headers.etag as string;

    const filePath = path.join(composeDir, STACK, 'compose.yaml');
    fs.writeFileSync(filePath, 'changed-by-other-tab', 'utf-8');
    const future = Date.now() + 5_000;
    fs.utimesSync(filePath, future / 1000, future / 1000);

    const putRes = await request(app)
      .put(`/api/stacks/${STACK}`)
      .set('Cookie', authCookie)
      .set('If-Match', etag)
      .send({ content: 'my-overwrite' });

    expect(putRes.status).toBe(412);
    expect(putRes.body).toMatchObject({
      code: 'stack_file_changed',
      currentContent: 'changed-by-other-tab',
    });
    expect(typeof putRes.body.currentMtimeMs).toBe('number');
    expect(putRes.headers.etag).toMatch(/^W\/"\d+"$/);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('changed-by-other-tab');
  });

  it('writes through when If-Match is absent', async () => {
    seedStack(STACK, 'original');

    const putRes = await request(app)
      .put(`/api/stacks/${STACK}`)
      .set('Cookie', authCookie)
      .send({ content: 'forced' });

    expect(putRes.status).toBe(200);
    const filePath = path.join(composeDir, STACK, 'compose.yaml');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('forced');
  });

  it('writes through when the file does not exist yet (first save creates compose.yaml)', async () => {
    const stackDir = path.join(composeDir, STACK);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'docker-compose.yaml'), 'legacy', 'utf-8');

    const putRes = await request(app)
      .put(`/api/stacks/${STACK}`)
      .set('Cookie', authCookie)
      .set('If-Match', 'W/"1234"')
      .send({ content: 'fresh' });

    expect(putRes.status).toBe(200);
    expect(fs.readFileSync(path.join(stackDir, 'compose.yaml'), 'utf-8')).toBe('fresh');
  });

  it('ignores malformed If-Match headers and writes through', async () => {
    seedStack(STACK, 'original');

    const putRes = await request(app)
      .put(`/api/stacks/${STACK}`)
      .set('Cookie', authCookie)
      .set('If-Match', 'not-a-valid-etag')
      .send({ content: 'forced' });

    expect(putRes.status).toBe(200);
  });
});

describe('PUT /api/stacks/:stackName/env optimistic concurrency', () => {
  it('writes successfully when If-Match matches', async () => {
    seedStack(STACK, 'services: {}');
    const envPath = seedEnv(STACK, 'FOO=1');

    const getRes = await request(app)
      .get(`/api/stacks/${STACK}/env?file=${encodeURIComponent(envPath)}`)
      .set('Cookie', authCookie);
    const etag = getRes.headers.etag as string;
    expect(etag).toMatch(/^W\/"\d+"$/);

    const putRes = await request(app)
      .put(`/api/stacks/${STACK}/env?file=${encodeURIComponent(envPath)}`)
      .set('Cookie', authCookie)
      .set('If-Match', etag)
      .send({ content: 'FOO=2' });

    expect(putRes.status).toBe(200);
    expect(fs.readFileSync(envPath, 'utf-8')).toBe('FOO=2');
  });

  it('returns 412 on env-file mtime mismatch', async () => {
    seedStack(STACK, 'services: {}');
    const envPath = seedEnv(STACK, 'FOO=1');

    const getRes = await request(app)
      .get(`/api/stacks/${STACK}/env?file=${encodeURIComponent(envPath)}`)
      .set('Cookie', authCookie);
    const etag = getRes.headers.etag as string;

    fs.writeFileSync(envPath, 'FOO=bumped', 'utf-8');
    const future = Date.now() + 5_000;
    fs.utimesSync(envPath, future / 1000, future / 1000);

    const putRes = await request(app)
      .put(`/api/stacks/${STACK}/env?file=${encodeURIComponent(envPath)}`)
      .set('Cookie', authCookie)
      .set('If-Match', etag)
      .send({ content: 'FOO=my-overwrite' });

    expect(putRes.status).toBe(412);
    expect(putRes.body.code).toBe('stack_file_changed');
    expect(putRes.body.currentContent).toBe('FOO=bumped');
    expect(fs.readFileSync(envPath, 'utf-8')).toBe('FOO=bumped');
  });
});
