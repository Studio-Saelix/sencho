/**
 * Route-level tests for the stack file explorer endpoints:
 *   GET    /:stackName/files
 *   GET    /:stackName/files/content
 *   GET    /:stackName/files/download
 *   POST   /:stackName/files/upload
 *   PUT    /:stackName/files/content
 *   DELETE /:stackName/files
 *   POST   /:stackName/files/folder
 *   PATCH  /:stackName/files/rename
 *   PUT    /:stackName/files/permissions
 *
 * The full file explorer is available on every tier; writes still require the
 * `stack:edit` permission (admin role). Tests cover: auth gating, RBAC gating,
 * Community-tier success, input validation, upload size limit, and happy-path
 * 204/200 responses.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { promises as fs } from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

// On Windows, fs.unlink on a directory returns EPERM instead of EISDIR so the
// NOT_EMPTY code path in deleteStackPath is never reached. Skip that test case
// on Windows; it is covered on Linux (CI).
const isWindows = process.platform === 'win32';

let tmpDir: string;
let app: import('express').Express;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let adminCookie: string;
let viewerCookie: string;
let stacksDir: string;
const STACK = 'teststack';

beforeAll(async () => {
  tmpDir = await setupTestDb();
  stacksDir = process.env.COMPOSE_DIR!;

  // Create stack directory so file operations have something to work with
  await fs.mkdir(path.join(stacksDir, STACK), { recursive: true });
  await fs.writeFile(path.join(stacksDir, STACK, 'compose.yaml'), 'services: {}\n');
  await fs.writeFile(path.join(stacksDir, STACK, '.env'), 'KEY=val\n');

  ({ LicenseService } = await import('../services/LicenseService'));
  ({ DatabaseService } = await import('../services/DatabaseService'));

  // Default: paid tier so most tests pass the tier gate
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
  vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue('skipper');
  vi.spyOn(LicenseService.getInstance(), 'getSeatLimits').mockReturnValue({ maxAdmins: null, maxViewers: null });

  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);

  const viewerHash = await bcrypt.hash('viewerpass', 1);
  DatabaseService.getInstance().addUser({ username: 'files-viewer', password_hash: viewerHash, role: 'viewer' });
  const viewerRes = await request(app).post('/api/auth/login').send({ username: 'files-viewer', password: 'viewerpass' });
  const viewerCookies = viewerRes.headers['set-cookie'] as string | string[];
  viewerCookie = Array.isArray(viewerCookies) ? viewerCookies[0] : viewerCookies;
});

afterAll(async () => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  // Restore all spies then re-establish the paid-tier default so per-test
  // overrides via mockReturnValueOnce don't accumulate across tests.
  vi.restoreAllMocks();
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
  vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue('skipper');
  vi.spyOn(LicenseService.getInstance(), 'getSeatLimits').mockReturnValue({ maxAdmins: null, maxViewers: null });
});

// ── GET /:stackName/files ─────────────────────────────────────────────────────

describe('GET /api/stacks/:stackName/files', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get(`/api/stacks/${STACK}/files`);
    expect(res.status).toBe(401);
  });

  it('returns 200 with entries array for authenticated admin', async () => {
    const res = await request(app)
      .get(`/api/stacks/${STACK}/files`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('includes compose.yaml and .env in the listing', async () => {
    const res = await request(app)
      .get(`/api/stacks/${STACK}/files`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    const names = res.body.map((e: { name: string }) => e.name);
    expect(names).toContain('compose.yaml');
    expect(names).toContain('.env');
  });

  it('emits diagnostic logs only when developer_mode is enabled', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    DatabaseService.getInstance().updateGlobalSetting('developer_mode', '0');
    await request(app)
      .get(`/api/stacks/${STACK}/files`)
      .set('Cookie', adminCookie);
    expect(debugSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('[Files:diag]'),
      expect.anything(),
    );

    DatabaseService.getInstance().updateGlobalSetting('developer_mode', '1');
    await request(app)
      .get(`/api/stacks/${STACK}/files`)
      .set('Cookie', adminCookie);
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Files:diag]'),
      expect.anything(),
    );

    DatabaseService.getInstance().updateGlobalSetting('developer_mode', '0');
  });

  it('returns 400 for an invalid stack name containing path traversal', async () => {
    const res = await request(app)
      .get('/api/stacks/../evil/files')
      .set('Cookie', adminCookie);
    // Express may normalise the URL before it reaches the handler;
    // the important thing is we never get 200
    expect([400, 404]).toContain(res.status);
  });

  it('returns 400 for a stack name with special characters', async () => {
    const res = await request(app)
      .get('/api/stacks/my%20stack/files')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(400);
  });
});

// ── GET /:stackName/files/content ─────────────────────────────────────────────

describe('GET /api/stacks/:stackName/files/content', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app)
      .get(`/api/stacks/${STACK}/files/content`)
      .query({ path: 'compose.yaml' });
    expect(res.status).toBe(401);
  });

  it('returns 400 INVALID_PATH when path query parameter is missing', async () => {
    const res = await request(app)
      .get(`/api/stacks/${STACK}/files/content`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PATH');
  });

  it('returns 200 with file content for an existing text file', async () => {
    const res = await request(app)
      .get(`/api/stacks/${STACK}/files/content`)
      .query({ path: 'compose.yaml' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.binary).toBe(false);
    expect(res.body.oversized).toBe(false);
    expect(typeof res.body.content).toBe('string');
  });

  it('returns 404 for a non-existent file', async () => {
    const res = await request(app)
      .get(`/api/stacks/${STACK}/files/content`)
      .query({ path: 'nonexistent.txt' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(404);
  });

  it('returns oversized:true for a file larger than the 2 MB read limit', async () => {
    const bigPath = path.join(stacksDir, STACK, 'oversized.txt');
    await fs.writeFile(bigPath, 'x'.repeat(3 * 1024 * 1024));

    const res = await request(app)
      .get(`/api/stacks/${STACK}/files/content`)
      .query({ path: 'oversized.txt' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.oversized).toBe(true);
    expect(res.body.binary).toBe(false);
    expect(res.body.content).toBeUndefined();

    await fs.unlink(bigPath);
  }, 15000);
});

// ── GET /:stackName/files/download ────────────────────────────────────────────

describe('GET /api/stacks/:stackName/files/download', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app)
      .get(`/api/stacks/${STACK}/files/download`)
      .query({ path: 'compose.yaml' });
    expect(res.status).toBe(401);
  });

  it('streams the file for a Community-tier admin', async () => {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValueOnce('community');
    const res = await request(app)
      .get(`/api/stacks/${STACK}/files/download`)
      .query({ path: 'compose.yaml' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
  });

  it('returns 400 INVALID_PATH when path query parameter is missing', async () => {
    const res = await request(app)
      .get(`/api/stacks/${STACK}/files/download`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PATH');
  });

  it('streams the file for a paid tier user', async () => {
    const res = await request(app)
      .get(`/api/stacks/${STACK}/files/download`)
      .query({ path: 'compose.yaml' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.text).toContain('services');
  });
});

// ── POST /:stackName/files/upload ─────────────────────────────────────────────

describe('POST /api/stacks/:stackName/files/upload', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/upload`)
      .attach('file', Buffer.from('data'), 'test.txt');
    expect(res.status).toBe(401);
  });

  it('uploads successfully for a Community-tier admin', async () => {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValueOnce('community');
    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/upload`)
      .set('Cookie', adminCookie)
      .attach('file', Buffer.from('community-upload'), 'community-upload.txt');
    expect(res.status).toBe(204);

    const content = await fs.readFile(path.join(stacksDir, STACK, 'community-upload.txt'), 'utf-8');
    expect(content).toBe('community-upload');
  });

  it('returns 400 when no file is attached', async () => {
    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/upload`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(400);
  });

  it('rejects upload filenames with path separators', async () => {
    const boundary = '----sencho-test-boundary';
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="../evil.txt"',
      'Content-Type: text/plain',
      '',
      'data',
      `--${boundary}--`,
      '',
    ].join('\r\n');

    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/upload`)
      .set('Cookie', adminCookie)
      .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid filename');
  });

  it('returns 413 TOO_LARGE when file exceeds 25 MB', async () => {
    // 26 MB buffer
    const bigFile = Buffer.alloc(26 * 1024 * 1024, 0x61);
    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/upload`)
      .set('Cookie', adminCookie)
      .attach('file', bigFile, 'toobig.txt');
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('TOO_LARGE');
  }, 20000);

  it('returns 204 for a valid file upload (paid tier)', async () => {
    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/upload`)
      .set('Cookie', adminCookie)
      .attach('file', Buffer.from('uploaded content'), 'uploaded.txt');
    expect(res.status).toBe(204);

    // Verify the file was written
    const content = await fs.readFile(path.join(stacksDir, STACK, 'uploaded.txt'), 'utf-8');
    expect(content).toBe('uploaded content');
  });

  it('returns 204 and writes into a subdirectory when ?path= is provided', async () => {
    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/upload`)
      .query({ path: 'subdir' })
      .set('Cookie', adminCookie)
      .attach('file', Buffer.from('subdir content'), 'sub.txt');
    expect(res.status).toBe(204);

    const content = await fs.readFile(path.join(stacksDir, STACK, 'subdir', 'sub.txt'), 'utf-8');
    expect(content).toBe('subdir content');
  });
});

// ── PUT /:stackName/files/content ─────────────────────────────────────────────

describe('PUT /api/stacks/:stackName/files/content', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app)
      .put(`/api/stacks/${STACK}/files/content`)
      .query({ path: 'new.txt' })
      .send({ content: 'hello' });
    expect(res.status).toBe(401);
  });

  it('writes the file for a Community-tier admin', async () => {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValueOnce('community');
    const res = await request(app)
      .put(`/api/stacks/${STACK}/files/content`)
      .query({ path: 'community-write.txt' })
      .set('Cookie', adminCookie)
      .send({ content: 'community-write' });
    expect(res.status).toBe(204);

    const content = await fs.readFile(path.join(stacksDir, STACK, 'community-write.txt'), 'utf-8');
    expect(content).toBe('community-write');
  });

  it('returns 400 when content is not a string', async () => {
    const res = await request(app)
      .put(`/api/stacks/${STACK}/files/content`)
      .query({ path: 'new.txt' })
      .set('Cookie', adminCookie)
      .send({ content: 42 });
    expect(res.status).toBe(400);
  });

  it('returns 400 INVALID_PATH when path query parameter is missing', async () => {
    const res = await request(app)
      .put(`/api/stacks/${STACK}/files/content`)
      .set('Cookie', adminCookie)
      .send({ content: 'hello' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PATH');
  });

  it('returns 204 and writes the file for a paid tier admin', async () => {
    const res = await request(app)
      .put(`/api/stacks/${STACK}/files/content`)
      .query({ path: 'written.txt' })
      .set('Cookie', adminCookie)
      .send({ content: 'written via PUT' });
    expect(res.status).toBe(204);

    const content = await fs.readFile(path.join(stacksDir, STACK, 'written.txt'), 'utf-8');
    expect(content).toBe('written via PUT');
  });
});

// ── PATCH /:stackName/files/rename ───────────────────────────────────────────

describe('PATCH /api/stacks/:stackName/files/rename', () => {
  it('returns 409 ALREADY_EXISTS when destination exists', async () => {
    await fs.writeFile(path.join(stacksDir, STACK, 'rename-source.txt'), 'source');
    await fs.writeFile(path.join(stacksDir, STACK, 'rename-target.txt'), 'target');

    const res = await request(app)
      .patch(`/api/stacks/${STACK}/files/rename`)
      .set('Cookie', adminCookie)
      .send({ from: 'rename-source.txt', to: 'rename-target.txt' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_EXISTS');
  });

  it('renames successfully for a Community-tier admin', async () => {
    await fs.writeFile(path.join(stacksDir, STACK, 'community-rename-from.txt'), 'src');
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValueOnce('community');
    const res = await request(app)
      .patch(`/api/stacks/${STACK}/files/rename`)
      .set('Cookie', adminCookie)
      .send({ from: 'community-rename-from.txt', to: 'community-rename-to.txt' });
    expect(res.status).toBe(204);

    await expect(fs.access(path.join(stacksDir, STACK, 'community-rename-from.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    const moved = await fs.readFile(path.join(stacksDir, STACK, 'community-rename-to.txt'), 'utf-8');
    expect(moved).toBe('src');
  });
});

// ── PUT /:stackName/files/permissions ────────────────────────────────────────

describe('PUT /api/stacks/:stackName/files/permissions', () => {
  it('returns 400 INVALID_PATH for invalid chmod modes', async () => {
    const res = await request(app)
      .put(`/api/stacks/${STACK}/files/permissions`)
      .query({ path: 'compose.yaml' })
      .set('Cookie', adminCookie)
      .send({ mode: 0o1000 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PATH');
  });

  it('sets permissions successfully for a Community-tier admin', async () => {
    await fs.writeFile(path.join(stacksDir, STACK, 'community-perms.txt'), 'data');
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValueOnce('community');
    const res = await request(app)
      .put(`/api/stacks/${STACK}/files/permissions`)
      .query({ path: 'community-perms.txt' })
      .set('Cookie', adminCookie)
      .send({ mode: 0o600 });
    expect(res.status).toBe(204);
  });
});

// ── DELETE /:stackName/files ──────────────────────────────────────────────────

describe('DELETE /api/stacks/:stackName/files', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app)
      .delete(`/api/stacks/${STACK}/files`)
      .query({ path: 'compose.yaml' });
    expect(res.status).toBe(401);
  });

  it('deletes successfully for a Community-tier admin', async () => {
    await fs.writeFile(path.join(stacksDir, STACK, 'community-delete.txt'), 'bye');
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValueOnce('community');
    const res = await request(app)
      .delete(`/api/stacks/${STACK}/files`)
      .query({ path: 'community-delete.txt' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(204);

    await expect(fs.access(path.join(stacksDir, STACK, 'community-delete.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns 400 when path is missing', async () => {
    const res = await request(app)
      .delete(`/api/stacks/${STACK}/files`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(400);
  });

  it('returns 204 on successful file deletion', async () => {
    // Create a disposable file first
    await fs.writeFile(path.join(stacksDir, STACK, 'todelete.txt'), 'bye');

    const res = await request(app)
      .delete(`/api/stacks/${STACK}/files`)
      .query({ path: 'todelete.txt' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(204);

    await expect(fs.access(path.join(stacksDir, STACK, 'todelete.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(isWindows)('returns 409 NOT_EMPTY when deleting a non-empty directory without recursive flag (Linux/macOS only)', async () => {
    const dirPath = path.join(stacksDir, STACK, 'nonemptydir');
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(path.join(dirPath, 'child.txt'), '');

    const res = await request(app)
      .delete(`/api/stacks/${STACK}/files`)
      .query({ path: 'nonemptydir' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_EMPTY');
  });

  it.skipIf(isWindows)('returns 204 and removes a non-empty directory when recursive=1 (Linux/macOS only)', async () => {
    const dirPath = path.join(stacksDir, STACK, 'recursivedir');
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(path.join(dirPath, 'child.txt'), 'data');

    const res = await request(app)
      .delete(`/api/stacks/${STACK}/files`)
      .query({ path: 'recursivedir', recursive: '1' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(204);

    await expect(fs.access(dirPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

// ── POST /:stackName/files/folder ─────────────────────────────────────────────

describe('POST /api/stacks/:stackName/files/folder', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/folder`)
      .query({ path: 'newdir' });
    expect(res.status).toBe(401);
  });

  it('creates the folder for a Community-tier admin', async () => {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValueOnce('community');
    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/folder`)
      .query({ path: 'community-folder' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(204);

    const stat = await fs.stat(path.join(stacksDir, STACK, 'community-folder'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('returns 400 when path is missing', async () => {
    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/folder`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(400);
  });

  it('returns 204 and creates the directory for a paid tier admin', async () => {
    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/folder`)
      .query({ path: 'mynewdir' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(204);

    const stat = await fs.stat(path.join(stacksDir, STACK, 'mynewdir'));
    expect(stat.isDirectory()).toBe(true);
  });
});

// ── permission gating ─────────────────────────────────────────────────────────

describe('permission gating', () => {
  it('viewer receives 403 from PUT /files/content', async () => {
    const res = await request(app)
      .put(`/api/stacks/${STACK}/files/content`)
      .query({ path: 'new.txt' })
      .set('Cookie', viewerCookie)
      .send({ content: 'hello' });
    expect(res.status).toBe(403);
  });

  it('viewer receives 403 from POST /files/upload', async () => {
    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/upload`)
      .set('Cookie', viewerCookie)
      .attach('file', Buffer.from('data'), 'test.txt');
    expect(res.status).toBe(403);
  });

  it('viewer receives 403 from DELETE /files', async () => {
    const res = await request(app)
      .delete(`/api/stacks/${STACK}/files`)
      .query({ path: 'compose.yaml' })
      .set('Cookie', viewerCookie);
    expect(res.status).toBe(403);
  });

  it('viewer receives 403 from POST /files/folder', async () => {
    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/folder`)
      .query({ path: 'somedir' })
      .set('Cookie', viewerCookie);
    expect(res.status).toBe(403);
  });

  it('viewer receives 403 from PATCH /files/rename', async () => {
    const res = await request(app)
      .patch(`/api/stacks/${STACK}/files/rename`)
      .set('Cookie', viewerCookie)
      .send({ from: 'compose.yaml', to: 'compose-renamed.yaml' });
    expect(res.status).toBe(403);
  });

  it('viewer receives 403 from PUT /files/permissions', async () => {
    const res = await request(app)
      .put(`/api/stacks/${STACK}/files/permissions`)
      .query({ path: 'compose.yaml' })
      .set('Cookie', viewerCookie)
      .send({ mode: 0o644 });
    expect(res.status).toBe(403);
  });
});

// ── protected stack files (compose.yaml, .env) ────────────────────────────────

describe('protected stack files', () => {
  it('DELETE /files refuses compose.yaml with 409 PROTECTED_FILE', async () => {
    const res = await request(app)
      .delete(`/api/stacks/${STACK}/files`)
      .query({ path: 'compose.yaml' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PROTECTED_FILE');
  });

  it('DELETE /files refuses .env with 409 PROTECTED_FILE', async () => {
    const res = await request(app)
      .delete(`/api/stacks/${STACK}/files`)
      .query({ path: '.env' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PROTECTED_FILE');
  });

  it('PATCH /files/rename refuses compose.yaml as source with 409 PROTECTED_FILE', async () => {
    const res = await request(app)
      .patch(`/api/stacks/${STACK}/files/rename`)
      .set('Cookie', adminCookie)
      .send({ from: 'compose.yaml', to: 'renamed-compose.yaml' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PROTECTED_FILE');
  });

  it('PATCH /files/rename refuses compose.yaml as destination with 409 PROTECTED_FILE', async () => {
    await fs.writeFile(path.join(stacksDir, STACK, 'pretend.yaml'), 'services: {}\n');
    const res = await request(app)
      .patch(`/api/stacks/${STACK}/files/rename`)
      .set('Cookie', adminCookie)
      .send({ from: 'pretend.yaml', to: 'compose.yaml' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PROTECTED_FILE');
    await fs.unlink(path.join(stacksDir, STACK, 'pretend.yaml'));
  });

  it('PUT /files/permissions refuses .env with 409 PROTECTED_FILE', async () => {
    const res = await request(app)
      .put(`/api/stacks/${STACK}/files/permissions`)
      .query({ path: '.env' })
      .set('Cookie', adminCookie)
      .send({ mode: 0o644 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PROTECTED_FILE');
  });

  it('DELETE /files still succeeds on a non-protected file', async () => {
    const target = path.join(stacksDir, STACK, 'disposable.txt');
    await fs.writeFile(target, 'temporary');
    const res = await request(app)
      .delete(`/api/stacks/${STACK}/files`)
      .query({ path: 'disposable.txt' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(204);
  });

  it('PUT /files/content still succeeds on compose.yaml (compose editor path)', async () => {
    const res = await request(app)
      .put(`/api/stacks/${STACK}/files/content`)
      .query({ path: 'compose.yaml' })
      .set('Cookie', adminCookie)
      .send({ content: 'services:\n  echo:\n    image: busybox\n' });
    expect(res.status).toBe(204);
  });

  it('POST /files/upload still succeeds when overwriting compose.yaml (legitimate replace)', async () => {
    const replacement = 'services:\n  uploaded:\n    image: busybox\n';
    const res = await request(app)
      .post(`/api/stacks/${STACK}/files/upload`)
      .set('Cookie', adminCookie)
      .attach('file', Buffer.from(replacement), 'compose.yaml');
    expect(res.status).toBe(204);
    const written = await fs.readFile(path.join(stacksDir, STACK, 'compose.yaml'), 'utf-8');
    expect(written).toContain('uploaded');
  });

  it('DELETE /files succeeds on a subdirectory file named compose.yaml (not the active compose file)', async () => {
    const subdir = path.join(stacksDir, STACK, 'backups');
    await fs.mkdir(subdir, { recursive: true });
    await fs.writeFile(path.join(subdir, 'compose.yaml'), 'services: {}\n');
    const res = await request(app)
      .delete(`/api/stacks/${STACK}/files`)
      .query({ path: 'backups/compose.yaml' })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(204);
    await fs.rm(subdir, { recursive: true, force: true });
  });

  it('DELETE /files refuses compose.yaml even with a trailing slash', async () => {
    const res = await request(app)
      .delete(`/api/stacks/${STACK}/files`)
      .query({ path: 'compose.yaml/' })
      .set('Cookie', adminCookie);
    // Either the validator rejects the trailing slash (400) or the protected-file
    // guard catches the normalized basename (409). Both are acceptable; what is NOT
    // acceptable is a 204 success that silently deletes the protected file.
    expect([400, 409]).toContain(res.status);
    if (res.status === 409) expect(res.body.code).toBe('PROTECTED_FILE');
  });
});
