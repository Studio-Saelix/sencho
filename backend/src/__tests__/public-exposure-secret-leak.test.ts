/**
 * The Cloudflare token never leaves the hub's encrypted column: not in a
 * response, an audit row, a log line (including the central error handler on
 * a malformed body), or the diagnostics report. Drives every success and
 * failure path with a sentinel token and searches each surface for it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import {
  FAKE_ACCOUNT_ID,
  FAKE_TOKEN,
  OTHER_ACCOUNT_ID,
  ZONE_A,
  installFakeCloudflare,
  makeFakeCloudflare,
  type Refusal,
} from './helpers/fakeCloudflare';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

function adminToken(): string {
  const user = DatabaseService.getInstance().getUserByUsername(TEST_USERNAME)!;
  return jwt.sign({ username: TEST_USERNAME, role: 'admin', tv: user.token_version }, TEST_JWT_SECRET, { expiresIn: '1m' });
}

describe('Cloudflare token containment', () => {
  it('keeps the token out of responses, audit rows, logs and diagnostics on every path', async () => {
    const fake = makeFakeCloudflare();
    installFakeCloudflare(fake);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { FleetSyncService } = await import('../services/FleetSyncService');
    vi.spyOn(FleetSyncService, 'getControlIdentity').mockReturnValue('0123456789abcdef');
    const logged: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a, Object.getOwnPropertyNames(a ?? {})))).join(' '));
      });
    }
    const bodies: string[] = [];
    const auth = `Bearer ${adminToken()}`;
    const send = async (method: 'get' | 'put' | 'post' | 'delete', path: string, body?: object) => {
      const req = request(app)[method](path).set('Authorization', auth);
      const res = await (body ? req.send(body) : req);
      bodies.push(res.text);
      return res;
    };
    const connect = () => send('put', '/api/public-exposure/account', { token: FAKE_TOKEN, accountId: FAKE_ACCOUNT_ID });

    // Every refusal at connect.
    const verifyRefusals: Refusal[] = [401, 400, 'location', 'down', 500];
    for (const refusal of verifyRefusals) {
      fake.verifyUser = refusal;
      fake.verifyAccount = refusal === 'location' ? 401 : refusal;
      expect((await connect()).status).toBeGreaterThanOrEqual(400);
    }
    fake.verifyUser = 'disabled';
    await connect();
    fake.verifyUser = 'active';
    await send('put', '/api/public-exposure/account', { token: FAKE_TOKEN, accountId: OTHER_ACCOUNT_ID });

    // Success, replace, every check, zone writes, the DNS check paths.
    expect((await connect()).status).toBe(200);
    await connect();
    await send('get', '/api/public-exposure/account');
    await send('put', `/api/public-exposure/zones/${ZONE_A}`, { enabled: true, allowedSuffixes: [] });
    await send('post', '/api/public-exposure/account/dns-check', { zoneRef: ZONE_A });
    fake.create = 500;
    await send('post', '/api/public-exposure/account/dns-check', { zoneRef: ZONE_A });
    fake.create = 'ok';
    fake.remove = 500;
    await send('post', '/api/public-exposure/account/dns-check', { zoneRef: ZONE_A });
    await send('delete', '/api/public-exposure/account');
    fake.remove = 'ok';
    fake.tunnel = 403;
    fake.zones = 403;
    await send('post', '/api/public-exposure/account/verify');
    fake.verifyUser = 'down';
    await send('post', '/api/public-exposure/account/verify');
    fake.verifyUser = 'active';
    await send('get', '/api/public-exposure/zones');

    // A malformed body goes through the central error handler.
    const malformed = await request(app)
      .put('/api/public-exposure/account')
      .set('Authorization', auth)
      .set('Content-Type', 'application/json')
      .send(`{"token":"${FAKE_TOKEN}","accountId":`);
    expect(malformed.status).toBe(400);
    bodies.push(malformed.text);
    // A body whose parse message quotes the start of the token.
    const unquoted = await request(app)
      .put('/api/public-exposure/account')
      .set('Authorization', auth)
      .set('Content-Type', 'application/json')
      .send(`{"token": ${FAKE_TOKEN}, "accountId": "x"}`);
    expect(unquoted.status).toBe(400);

    // An unexpected throw inside the route.
    const { PublicExposureAccountService } = await import('../services/publicExposure/PublicExposureAccountService');
    const spy = vi.spyOn(PublicExposureAccountService.prototype, 'connect').mockRejectedValueOnce(new Error('database is locked'));
    expect((await connect()).status).toBe(500);
    spy.mockRestore();

    const db = DatabaseService.getInstance();
    db.flushAuditLogBuffer();
    const audit = db.getDb().prepare('SELECT summary, path FROM audit_log').all();
    const { collectDiagnostics } = await import('../services/DiagnosticsService');
    const diagnostics = await collectDiagnostics();
    const raw = db.getDb().prepare('SELECT * FROM exposure_accounts').all() as Array<{ credential_enc: string }>;

    expect(bodies.join('\n')).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(audit)).not.toContain(FAKE_TOKEN);
    expect(logged.join('\n')).not.toContain(FAKE_TOKEN);
    expect(logged.join('\n')).not.toContain(FAKE_TOKEN.slice(0, 8));
    expect(JSON.stringify(diagnostics)).not.toContain(FAKE_TOKEN);
    expect(raw).toHaveLength(1);
    expect(raw[0].credential_enc.startsWith('enc:')).toBe(true);
    expect(JSON.stringify(raw)).not.toContain(FAKE_TOKEN);
    // The surfaces were exercised: the logs saw the parse error and the forced throw.
    expect(logged.some((line) => line.includes('[Error]'))).toBe(true);
    expect(logged.some((line) => line.includes('database is locked'))).toBe(true);
  });
});
