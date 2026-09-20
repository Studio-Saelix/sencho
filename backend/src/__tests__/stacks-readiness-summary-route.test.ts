/**
 * Route tests for GET /api/stacks/readiness-summary: auth, the aggregate
 * contract, and route shadowing by the /:stackName catch-all.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
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
  DatabaseService.getInstance().addUser({ username: 'readiness-viewer', password_hash: viewerHash, role: 'viewer' });
  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({ username: 'readiness-viewer', password: 'viewerpass' });
  const cookies = loginRes.headers['set-cookie'] as string | string[];
  viewerCookie = Array.isArray(cookies) ? cookies[0] : cookies;

  // COMPOSE_DIR is created empty by setupTestDb and no stack is written here,
  // so every assertion below runs against a node with nothing to evaluate.
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

describe('GET /api/stacks/readiness-summary', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/stacks/readiness-summary');
    expect(res.status).toBe(401);
  });

  it('allows stack:read for a viewer', async () => {
    const res = await request(app).get('/api/stacks/readiness-summary').set('Cookie', viewerCookie);
    expect(res.status).toBe(200);
  });

  it('answers with the aggregate shape rather than a stack lookup', async () => {
    const res = await request(app).get('/api/stacks/readiness-summary').set('Cookie', authCookie);

    // If this were registered after /:stackName it would resolve as a stack
    // literally named "readiness-summary", fail to resolve a compose file for
    // it, and answer with an `error` body and no `stacks` array. The 200 plus an
    // empty array here is the guard for that registration order.
    expect(res.status).toBe(200);
    expect(res.body.stacks).toEqual([]);
    // The field set is pinned so a renamed or added field is caught here and
    // not by a consumer reading undefined.
    expect(Object.keys(res.body).sort()).toEqual(['generatedAt', 'stacks', 'stale', 'truncated']);
    expect(res.body.truncated).toBe(false);
    // These verdicts are younger than the freshness window. `stale: true` is
    // the signal that says an earlier failed pass is being served instead, and
    // it is never reachable on the success path.
    expect(res.body.stale).toBe(false);
    expect(typeof res.body.generatedAt).toBe('number');
    expect(res.body.generatedAt).toBeLessThanOrEqual(Date.now());
  });

  it('serves a second call within the TTL from the same pass', async () => {
    const { CacheService } = await import('../services/CacheService');
    const { FileSystemService } = await import('../services/FileSystemService');
    // Flushed so the pass below is this test's own first pass rather than one
    // another test primed.
    CacheService.getInstance().flush();
    const listStacks = vi.spyOn(FileSystemService.prototype, 'getStacksStrict').mockResolvedValue([]);
    try {
      const first = await request(app).get('/api/stacks/readiness-summary').set('Cookie', authCookie);
      const second = await request(app).get('/api/stacks/readiness-summary').set('Cookie', authCookie);

      // A hub fan-out across a fleet must not re-run the Docker-heavy pass per
      // call. One listing across the two requests is what proves the second
      // reused the first: equal stamps would hold for a re-run inside the same
      // millisecond too, and `generatedAt` tracks the pass rather than the
      // request, so it is asserted alongside the count rather than instead.
      expect(second.status).toBe(200);
      expect(listStacks).toHaveBeenCalledTimes(1);
      expect(second.body.generatedAt).toBe(first.body.generatedAt);
    } finally {
      listStacks.mockRestore();
    }
  });

  it('answers 500 rather than an empty node when the stack listing fails', async () => {
    const { CacheService } = await import('../services/CacheService');
    const { FileSystemService } = await import('../services/FileSystemService');
    // Flushed so this exercises the failure instead of the pass cached above.
    CacheService.getInstance().flush();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const listStacks = vi.spyOn(FileSystemService.prototype, 'getStacksStrict')
      .mockRejectedValue(new Error('EACCES: permission denied'));
    try {
      const res = await request(app).get('/api/stacks/readiness-summary').set('Cookie', authCookie);

      // A 200 carrying an empty `stacks` array would read as a node with
      // nothing to check, which is the misread the strict listing prevents.
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to build stack readiness summary' });
      expect(logged).toHaveBeenCalledWith('Failed to build stack readiness summary:', expect.any(Error));
    } finally {
      listStacks.mockRestore();
      logged.mockRestore();
    }
  });
});
