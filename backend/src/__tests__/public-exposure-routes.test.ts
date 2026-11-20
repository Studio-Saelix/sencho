/**
 * Routes under /api/public-exposure: who may call them, input validation,
 * how Cloudflare refusals surface (never as a local 401), honest audit rows,
 * the disconnect response, and the hub tables' migration.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import {
  FAKE_ACCOUNT_ID,
  FAKE_TOKEN,
  ZONE_A,
  installFakeCloudflare,
  makeFakeCloudflare,
  type FakeCloudflare,
} from './helpers/fakeCloudflare';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let fake: FakeCloudflare;

const ADMIN_ROUTES: Array<[method: 'get' | 'put' | 'post' | 'delete', path: string, body?: object]> = [
  ['get', '/api/public-exposure/account'],
  ['put', '/api/public-exposure/account', { token: FAKE_TOKEN, accountId: FAKE_ACCOUNT_ID }],
  ['post', '/api/public-exposure/account/verify'],
  ['post', '/api/public-exposure/account/dns-check', { zoneRef: ZONE_A }],
  ['delete', '/api/public-exposure/account'],
  ['put', `/api/public-exposure/zones/${ZONE_A}`, { enabled: true, allowedSuffixes: [] }],
];

function sign(username: string, role: string, tv?: number): string {
  return jwt.sign({ username, role, ...(tv !== undefined ? { tv } : {}) }, TEST_JWT_SECRET, { expiresIn: '1m' });
}

function adminToken(): string {
  const user = DatabaseService.getInstance().getUserByUsername(TEST_USERNAME)!;
  return sign(TEST_USERNAME, 'admin', user.token_version);
}

function roleToken(role: 'viewer' | 'deployer' | 'auditor' | 'node-admin'): string {
  const db = DatabaseService.getInstance();
  const username = `pe-${role}`;
  if (!db.getUserByUsername(username)) db.addUser({ username, password_hash: 'x', role });
  return sign(username, role, db.getUserByUsername(username)!.token_version);
}

function call(method: 'get' | 'put' | 'post' | 'delete', path: string, token: string, body?: object) {
  const req = request(app)[method](path).set('Authorization', `Bearer ${token}`);
  return body ? req.send(body) : req;
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(async () => {
  DatabaseService.getInstance().getDb().exec('DELETE FROM exposure_zones; DELETE FROM exposure_accounts; DELETE FROM exposure_node_endpoints;');
  const { cloudflareApiClient } = await import('../services/publicExposure/cloudflareApiClient');
  cloudflareApiClient.resetBudgetForTests();
  fake = makeFakeCloudflare();
  installFakeCloudflare(fake);
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const { FleetSyncService } = await import('../services/FleetSyncService');
  vi.spyOn(FleetSyncService, 'getControlIdentity').mockReturnValue('0123456789abcdef');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('who may call the routes', () => {
  it.each(['viewer', 'deployer', 'auditor', 'node-admin'] as const)('refuses every Admin route for a %s', async (role) => {
    for (const [method, path, body] of ADMIN_ROUTES) {
      const res = await call(method, path, roleToken(role), body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.code).toBe('ADMIN_REQUIRED');
    }
  });

  it('refuses a full-admin API token and node_proxy and pilot_tunnel credentials with SESSION_REQUIRED', async () => {
    const created = await call('post', '/api/api-tokens', adminToken(), { name: `pe-${Date.now()}`, scope: 'full-admin' });
    const apiToken = created.body.token as string;
    const machine = jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });
    const tunnel = jwt.sign({ scope: 'pilot_tunnel' }, TEST_JWT_SECRET, { expiresIn: '1m' });
    for (const credential of [apiToken, machine, tunnel]) {
      for (const [method, path, body] of ADMIN_ROUTES) {
        const res = await call(method, path, credential, body);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(res.body.code).toBe('SESSION_REQUIRED');
      }
    }
  });

  it('lets a viewer read enabled zones and refuses a deployer', async () => {
    expect((await call('get', '/api/public-exposure/zones', roleToken('viewer'))).status).toBe(200);
    const denied = await call('get', '/api/public-exposure/zones', roleToken('deployer'));
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('PERMISSION_DENIED');
  });
});

describe('connect and zones through the routes', () => {
  it('connects with a trimmed token and returns the view without it', async () => {
    const res = await call('put', '/api/public-exposure/account', adminToken(), { token: `  ${FAKE_TOKEN}\n`, accountId: FAKE_ACCOUNT_ID.toUpperCase() });
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.accountId).toBe(FAKE_ACCOUNT_ID);
    expect(JSON.stringify(res.body)).not.toContain(FAKE_TOKEN);
  });

  it.each([
    [{ token: 'short', accountId: FAKE_ACCOUNT_ID }],
    [{ token: `${FAKE_TOKEN} inner space`, accountId: FAKE_ACCOUNT_ID }],
    [{ token: 'x'.repeat(257), accountId: FAKE_ACCOUNT_ID }],
    [{ token: FAKE_TOKEN, accountId: 'not-an-id' }],
    [{ accountId: FAKE_ACCOUNT_ID }],
  ])('refuses invalid connect input %#', async (body) => {
    const res = await call('put', '/api/public-exposure/account', adminToken(), body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(fake.requests).toEqual([]);
  });

  it('refuses an invalid zone id and a suffix outside its zone, and lowercases suffixes', async () => {
    await call('put', '/api/public-exposure/account', adminToken(), { token: FAKE_TOKEN, accountId: FAKE_ACCOUNT_ID });
    expect((await call('put', '/api/public-exposure/zones/nope', adminToken(), { enabled: true, allowedSuffixes: [] })).status).toBe(400);
    expect((await call('post', '/api/public-exposure/account/dns-check', adminToken(), { zoneRef: 'nope' })).status).toBe(400);
    const outside = await call('put', `/api/public-exposure/zones/${ZONE_A}`, adminToken(), { enabled: true, allowedSuffixes: ['apps.example.org'] });
    expect(outside.status).toBe(400);
    const wildcard = await call('put', `/api/public-exposure/zones/${ZONE_A}`, adminToken(), { enabled: true, allowedSuffixes: ['*.example.com'] });
    expect(wildcard.status).toBe(400);
    const okRes = await call('put', `/api/public-exposure/zones/${ZONE_A}`, adminToken(), { enabled: true, allowedSuffixes: ['APPS.example.com'] });
    expect(okRes.status).toBe(200);
    const zones = await call('get', '/api/public-exposure/zones', adminToken());
    expect(zones.body).toEqual([{ zoneRef: ZONE_A, name: 'example.com', allowedSuffixes: ['apps.example.com'], dns: 'unconfirmed' }]);
  });

  it('never surfaces a Cloudflare 401 as a local 401', async () => {
    fake.verifyUser = 401;
    fake.verifyAccount = 401;
    const res = await call('put', '/api/public-exposure/account', adminToken(), { token: FAKE_TOKEN, accountId: FAKE_ACCOUNT_ID });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TOKEN_INVALID');
  });

  it('returns 404 NOT_CONNECTED for a recheck with no account', async () => {
    const res = await call('post', '/api/public-exposure/account/verify', adminToken());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_CONNECTED');
  });
});

describe('route audit rows', () => {
  beforeEach(() => {
    const db = DatabaseService.getInstance();
    db.flushAuditLogBuffer();
    db.getDb().exec('DELETE FROM audit_log');
  });

  function summaries(): string[] {
    const db = DatabaseService.getInstance();
    db.flushAuditLogBuffer();
    // Route rows only; the service writes its own `public_exposure.*` rows on the same path.
    return (db.getDb().prepare(`SELECT summary FROM audit_log WHERE path LIKE '/api/public-exposure%' AND summary NOT LIKE 'public_exposure.%' ORDER BY id`).all() as Array<{ summary: string }>)
      .map((r) => r.summary);
  }

  it('words a refused connect as a refusal, not as a connection', async () => {
    fake.verifyUser = 401;
    fake.verifyAccount = 401;
    await call('put', '/api/public-exposure/account', adminToken(), { token: FAKE_TOKEN, accountId: FAKE_ACCOUNT_ID });
    const rows = summaries();
    expect(rows).toContain('Cloudflare account connection refused (422)');
    expect(rows.some((r) => r === 'Connected Cloudflare account')).toBe(false);
  });

  it('words each successful account and zone action', async () => {
    await call('put', '/api/public-exposure/account', adminToken(), { token: FAKE_TOKEN, accountId: FAKE_ACCOUNT_ID });
    await call('put', `/api/public-exposure/zones/${ZONE_A}`, adminToken(), { enabled: true, allowedSuffixes: [] });
    await call('post', '/api/public-exposure/account/verify', adminToken());
    await call('post', '/api/public-exposure/account/dns-check', adminToken(), { zoneRef: ZONE_A });
    await call('delete', '/api/public-exposure/account', adminToken());
    expect(summaries()).toEqual([
      'Connected Cloudflare account',
      `Updated public exposure zone: ${ZONE_A}`,
      'Rechecked Cloudflare account',
      'Checked Cloudflare DNS write',
      'Disconnected Cloudflare account',
    ]);
  });

  it('answers 202 and words an unfinished DNS check as such', async () => {
    await call('put', '/api/public-exposure/account', adminToken(), { token: FAKE_TOKEN, accountId: FAKE_ACCOUNT_ID });
    await call('put', `/api/public-exposure/zones/${ZONE_A}`, adminToken(), { enabled: true, allowedSuffixes: [] });
    fake.remove = 500;
    const res = await call('post', '/api/public-exposure/account/dns-check', adminToken(), { zoneRef: ZONE_A });
    expect(res.status).toBe(202);
    expect(res.body.zones.find((z: { zoneRef: string }) => z.zoneRef === ZONE_A).cleanupPending).not.toBeNull();
    expect(summaries()).toContain('Cloudflare DNS write check did not finish (202)');
  });

  it('words refused zone, DNS check, recheck and disconnect requests as refusals', async () => {
    await call('put', `/api/public-exposure/zones/${ZONE_A}`, adminToken(), { enabled: true, allowedSuffixes: [] });
    await call('post', '/api/public-exposure/account/dns-check', adminToken(), { zoneRef: ZONE_A });
    await call('post', '/api/public-exposure/account/verify', adminToken());
    await call('delete', '/api/public-exposure/account', adminToken());
    expect(summaries()).toEqual([
      'Public exposure zone update refused (404)',
      'Cloudflare DNS write check refused (404)',
      'Cloudflare account recheck refused (404)',
      'Cloudflare account disconnect refused (404)',
    ]);
  });
});

describe('disconnect response', () => {
  const NAME = '_sencho-check-0123456789abcdef.example.com';

  it('lists no leftover records after a clean disconnect', async () => {
    await call('put', '/api/public-exposure/account', adminToken(), { token: FAKE_TOKEN, accountId: FAKE_ACCOUNT_ID });
    const res = await call('delete', '/api/public-exposure/account', adminToken());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: false, leftInCloudflare: [] });
  });

  it('names the check record it left in Cloudflare when the zone is out of reach', async () => {
    await call('put', '/api/public-exposure/account', adminToken(), { token: FAKE_TOKEN, accountId: FAKE_ACCOUNT_ID });
    await call('put', `/api/public-exposure/zones/${ZONE_A}`, adminToken(), { enabled: true, allowedSuffixes: [] });
    fake.remove = 500;
    await call('post', '/api/public-exposure/account/dns-check', adminToken(), { zoneRef: ZONE_A });
    fake.zones = [{ id: 'd4'.repeat(16), name: 'example.net' }];
    await call('post', '/api/public-exposure/account/verify', adminToken());
    fake.remove = 403;
    const res = await call('delete', '/api/public-exposure/account', adminToken());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: false, leftInCloudflare: [NAME] });
  });
});

describe('migration', () => {
  it('runs twice cleanly and creates the three tables with their columns', async () => {
    const db = DatabaseService.getInstance();
    const migrate = (db as unknown as { migratePublicExposure: () => void }).migratePublicExposure.bind(db);
    migrate();
    migrate();
    const columns = (table: string) => (db.getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns('exposure_accounts')).toEqual(expect.arrayContaining(['adapter_id', 'credential_enc', 'config_json', 'scopes_json', 'last_check_json', 'verified_at']));
    expect(columns('exposure_zones')).toEqual(expect.arrayContaining(['zone_ref', 'enabled', 'allowed_suffixes_json', 'dns_scope', 'dns_checked_at', 'scope_check_pending_json', 'last_seen_at']));
    expect(columns('exposure_node_endpoints')).toEqual(expect.arrayContaining(['node_id', 'account_id', 'provider_ref', 'state', 'credential_generation']));
  });
});
