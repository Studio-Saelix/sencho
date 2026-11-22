/**
 * The Cloudflare token never leaves the hub's encrypted column: not in a
 * response (including the 400 for a body that fails to parse, whose parser
 * message quotes the start of the body), an audit row, a log line, or the
 * diagnostics report. Drives every success and failure path with a sentinel
 * token and searches each surface for it; responses and logs are also searched
 * for its first 8 characters, which is all a parse message quotes.
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
  answer,
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
    bodies.push(unquoted.text);
    // The handler is shared: a login body that fails to parse is answered the same way.
    const login = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send(`{"username": "admin", "password": ${FAKE_TOKEN}}`);
    expect(login.status).toBe(400);
    bodies.push(login.text);

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
    expect(bodies.join('\n')).not.toContain(FAKE_TOKEN.slice(0, 8));
    expect(JSON.parse(unquoted.text)).toEqual({ error: 'The request body could not be parsed.' });
    expect(JSON.parse(login.text)).toEqual({ error: 'The request body could not be parsed.' });
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

  it('keeps a token that a successful Cloudflare answer echoes out of the response, a later account read, the zone list and the audit rows', async () => {
    const fake = makeFakeCloudflare();
    const echoes: Array<[string, (path: string) => unknown | undefined]> = [
      ['a verification status', (path) => (path === '/user/tokens/verify' ? { id: 't', status: FAKE_TOKEN } : undefined)],
      ['a disabled token expiry', (path) => (path === '/user/tokens/verify' ? { id: 't', status: 'disabled', expires_on: FAKE_TOKEN } : undefined)],
      ['an account name', (path) => (path === '/accounts' ? [{ id: FAKE_ACCOUNT_ID, name: FAKE_TOKEN.toLowerCase() }] : undefined)],
      ['a zone name', (path) => (path === '/zones' ? [{ id: ZONE_A, name: `${FAKE_TOKEN}.example.com` }] : undefined)],
    ];
    const logged: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    }
    const auth = `Bearer ${adminToken()}`;
    const bodies: string[] = [];
    for (const [, replace] of echoes) {
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const result = replace(url.pathname.replace('/client/v4', ''));
        if (result !== undefined) {
          return new Response(JSON.stringify({ success: true, errors: [], messages: [], result, result_info: { page: 1, per_page: 50, count: Array.isArray(result) ? result.length : 0, total_pages: 1, total_count: Array.isArray(result) ? result.length : 0 } }), { status: 200 });
        }
        return answer(fake, url, init ?? {});
      }));
      for (const [method, path, body] of [
        ['put', '/api/public-exposure/account', { token: FAKE_TOKEN, accountId: FAKE_ACCOUNT_ID }],
        ['get', '/api/public-exposure/account', undefined],
        ['get', '/api/public-exposure/zones', undefined],
        ['post', '/api/public-exposure/account/verify', undefined],
      ] as const) {
        const req = request(app)[method](path).set('Authorization', auth);
        const res = await (body ? req.send(body) : req);
        bodies.push(`${res.status} ${res.text}`);
      }
    }
    const db = DatabaseService.getInstance();
    db.flushAuditLogBuffer();
    const stored = db.getDb().prepare('SELECT adapter_id, config_json, scopes_json, last_check_json FROM exposure_accounts').all();
    const zones = db.getDb().prepare('SELECT * FROM exposure_zones').all();
    const audit = db.getDb().prepare('SELECT summary, path FROM audit_log').all();
    const haystack = JSON.stringify({ bodies, stored, zones, audit, logged }).toLowerCase();
    expect(haystack).not.toContain(FAKE_TOKEN.toLowerCase());
    // The surfaces were exercised: every echo was refused, so each connect answered an error status.
    expect(bodies.filter((b) => b.startsWith('502') || b.startsWith('422')).length).toBeGreaterThanOrEqual(echoes.length);
  });
  it('keeps a credential that a well-formed expiry carries out of the response, a later account read and every stored surface, on both verification endpoints', async () => {
    const NUMERIC = '4815162342'.repeat(4);
    const DATE_TOKEN = '2026-01-01T00:00:00Z';
    const fake = makeFakeCloudflare();
    const logged: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    }
    const auth = `Bearer ${adminToken()}`;
    const db = DatabaseService.getInstance();
    const cases: Array<[string, string, string, boolean]> = [
      ['fractional seconds', NUMERIC, `2026-01-01T00:00:00.${NUMERIC}Z`, false],
      ['fractional seconds on the account endpoint', NUMERIC, `2026-01-01T00:00:00.${NUMERIC}Z`, true],
      ['a date that is the credential', DATE_TOKEN, DATE_TOKEN, false],
      ['a date that is the credential on the account endpoint', DATE_TOKEN, DATE_TOKEN, true],
    ];
    for (const [, token, expiry, viaAccount] of cases) {
      for (const status of ['disabled', 'expired']) {
        for (const connectedFirst of [false, true]) {
          db.getDb().exec('DELETE FROM exposure_zones; DELETE FROM exposure_accounts;');
          const bodies: string[] = [];
          installFakeCloudflare(fake);
          if (connectedFirst) {
            const first = await request(app).put('/api/public-exposure/account').set('Authorization', auth).send({ token, accountId: FAKE_ACCOUNT_ID });
            expect(first.status).toBe(200);
          }
          vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(String(input));
            const path = url.pathname.replace('/client/v4', '');
            const verifies = viaAccount ? /^\/accounts\/[0-9a-f]+\/tokens\/verify$/.test(path) : path === '/user/tokens/verify';
            if (viaAccount && path === '/user/tokens/verify') {
              return new Response(JSON.stringify({ success: false, errors: [{ code: 1000, message: 'Invalid API Token' }], messages: [], result: null }), { status: 401 });
            }
            if (verifies) return new Response(JSON.stringify({ success: true, errors: [], messages: [], result: { id: 't', status, expires_on: expiry } }), { status: 200 });
            return answer(fake, url, init ?? {});
          }));
          for (const [method, path, body] of [
            ['put', '/api/public-exposure/account', { token, accountId: FAKE_ACCOUNT_ID }],
            ['post', '/api/public-exposure/account/verify', undefined],
            ['get', '/api/public-exposure/account', undefined],
            ['get', '/api/public-exposure/zones', undefined],
          ] as const) {
            const req = request(app)[method](path).set('Authorization', auth);
            const res = await (body ? req.send(body) : req);
            bodies.push(`${res.status} ${res.text}`);
          }
          db.flushAuditLogBuffer();
          const stored = db.getDb().prepare('SELECT adapter_id, config_json, scopes_json, last_check_json FROM exposure_accounts').all();
          const zones = db.getDb().prepare('SELECT * FROM exposure_zones').all();
          const audit = db.getDb().prepare('SELECT summary, path FROM audit_log').all();
          const haystack = JSON.stringify({ bodies, stored, zones, audit, logged }).toLowerCase();
          expect(haystack).not.toContain(token.toLowerCase());
          // The connect was refused as an unreadable answer, not reported as the token state it echoed.
          expect(bodies[0].startsWith('502') || bodies[0].startsWith('422')).toBe(true);
        }
      }
    }
  });
});
