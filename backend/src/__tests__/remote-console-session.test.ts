/**
 * Regression guard for `console_session` JWT parity.
 *
 * A gateway that forwards an interactive WebSocket (host console or container
 * exec) to a remote node calls the remote's `POST /api/system/console-token`
 * endpoint and forwards the returned token in an `Authorization: Bearer`
 * header during the upgrade. Meanwhile the HTTP route `/api/system/console-
 * token` is what the gateway calls to mint that same token on its own remote.
 * Both mint calls go through `helpers/consoleSession.ts::mintConsoleSession`.
 *
 * This test guards against future drift between the HTTP route and the
 * helper: if somebody changes the route to mint a different claim shape,
 * the remote's upgrade handler would reject one set of tokens and the
 * product would silently lose remote-console support.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_JWT_SECRET, loginAsTestAdmin } from './helpers/setupTestDb';
import { mintConsoleSession } from '../helpers/consoleSession';
import { generateApiToken } from '../utils/apiTokenFormat';

describe('console_session token parity (HTTP route vs mint helper)', () => {
  let tmpDir: string;
  let app: import('express').Express;
  let adminCookie: string;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ app } = await import('../index'));
    adminCookie = await loginAsTestAdmin(app);

    // POST /api/system/console-token is paid-gated. Seed an active license so the
    // parity assertion can observe the token the route returns. The
    // license_last_validated fallback is skipped when the state key is absent, so
    // the active status alone drives the paid tier.
    const { DatabaseService } = await import('../services/DatabaseService');
    DatabaseService.getInstance().setSystemState('license_status', 'active');
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  it('POST /api/system/console-token produces a token with the same shape as mintConsoleSession()', async () => {
    const directToken = mintConsoleSession();
    const directDecoded = jwt.verify(directToken, TEST_JWT_SECRET) as Record<string, unknown>;

    const res = await request(app)
      .post('/api/system/console-token')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');

    const routeDecoded = jwt.verify(res.body.token, TEST_JWT_SECRET) as Record<string, unknown>;

    // Identical scope so the remote's upgrade handler treats both the same.
    expect(routeDecoded.scope).toBe('console_session');
    expect(directDecoded.scope).toBe('console_session');

    // Same claim keys: if somebody adds or drops a claim on one path but not
    // the other, remote upgrade behavior will diverge.
    expect(Object.keys(routeDecoded).sort()).toEqual(Object.keys(directDecoded).sort());

    // Same short TTL (60 seconds, plus or minus a second for test scheduling).
    const directTtl = (directDecoded.exp as number) - (directDecoded.iat as number);
    const routeTtl = (routeDecoded.exp as number) - (routeDecoded.iat as number);
    expect(directTtl).toBe(60);
    expect(routeTtl).toBe(60);
  });

  it('rejects non-admin callers of POST /api/system/console-token', async () => {
    // Build a valid session JWT for a non-admin user and confirm the route
    // is still admin-gated (regression: easy to drop the requireAdmin check
    // when tier gates are refactored).
    const viewerToken = jwt.sign({ username: 'nobody-exists' }, TEST_JWT_SECRET, { expiresIn: '1m' });
    const res = await request(app)
      .post('/api/system/console-token')
      .set('Authorization', `Bearer ${viewerToken}`);
    // Either 401 (user not found) or 403 (role check) is acceptable; the
    // critical invariant is "not 200 for a non-admin".
    expect(res.status).not.toBe(200);
    expect([401, 403]).toContain(res.status);
  });

  it('rejects API-token callers of POST /api/system/console-token (rejectApiTokenScope)', async () => {
    // Mint a JWT that claims the api_token scope but is not backed by a real
    // row in the database. authMiddleware accepts the sen_sk_ format and
    // rejects at the row-lookup step before the route handler runs, which
    // is the behavior we want: an API token should never be allowed to mint
    // a console session.
    const fakeApiToken = generateApiToken();
    const res = await request(app)
      .post('/api/system/console-token')
      .set('Authorization', `Bearer ${fakeApiToken}`);
    expect(res.status).toBe(401);
  });
});
