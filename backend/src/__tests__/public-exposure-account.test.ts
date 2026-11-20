/**
 * The public exposure account service and its Cloudflare adapter, against a
 * fake Cloudflare API: every named check state, the account change rule, the
 * DNS write check and its journal, zone reconciliation, the lock, the
 * operation deadline, and the audit rows.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import {
  FAKE_ACCOUNT_ID,
  FAKE_TOKEN,
  OTHER_ACCOUNT_ID,
  ZONE_A,
  ZONE_B,
  answer,
  installFakeCloudflare,
  makeFakeCloudflare,
  type FakeCloudflare,
} from './helpers/fakeCloudflare';
import type { PublicExposureAccountView } from '../services/publicExposure/types';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let Service: typeof import('../services/publicExposure/PublicExposureAccountService').PublicExposureAccountService;
let PublicExposureError: typeof import('../services/publicExposure/types').PublicExposureError;
let cloudflareApiClient: typeof import('../services/publicExposure/cloudflareApiClient').cloudflareApiClient;
let FleetSyncService: typeof import('../services/FleetSyncService').FleetSyncService;

const actor = { username: 'admin', ip: '127.0.0.1', method: 'PUT', path: '/api/public-exposure/account' };
const CONTROL_ID = '0123456789abcdef';
const CHECK_NAME = `_sencho-check-${CONTROL_ID}.example.com`;

let fake: FakeCloudflare;
let service: InstanceType<typeof Service>;

function connected(view: PublicExposureAccountView) {
  if (!view.connected) throw new Error('expected a connected view');
  return view;
}

async function refusal(promise: Promise<unknown>): Promise<InstanceType<typeof PublicExposureError>> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof PublicExposureError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

function db() {
  return DatabaseService.getInstance().getDb();
}

async function connectWithZoneA(): Promise<void> {
  await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor);
  await service.setZone(ZONE_A, true, [], actor);
}

/** A check record left in zone A, then a recheck whose complete listing no longer shows zone A. */
async function leftoverInGoneZone(): Promise<void> {
  await connectWithZoneA();
  fake.remove = 500;
  await service.dnsCheck(ZONE_A, actor);
  fake.zones = [{ id: ZONE_B, name: 'example.net' }];
  await service.recheck(actor);
  expect(zoneA(service.getView())).toMatchObject({ seenAtLastCheck: false, cleanupPending: { recordName: CHECK_NAME } });
}

function zoneA(view: PublicExposureAccountView) {
  const zone = connected(view).zones.find((z) => z.zoneRef === ZONE_A);
  if (!zone) throw new Error('zone A missing');
  return zone;
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ PublicExposureAccountService: Service } = await import('../services/publicExposure/PublicExposureAccountService'));
  ({ PublicExposureError } = await import('../services/publicExposure/types'));
  ({ cloudflareApiClient } = await import('../services/publicExposure/cloudflareApiClient'));
  ({ FleetSyncService } = await import('../services/FleetSyncService'));
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  db().exec('DELETE FROM exposure_zones; DELETE FROM exposure_accounts; DELETE FROM exposure_node_endpoints;');
  cloudflareApiClient.resetBudgetForTests();
  fake = makeFakeCloudflare();
  installFakeCloudflare(fake);
  vi.spyOn(FleetSyncService, 'getControlIdentity').mockReturnValue(CONTROL_ID);
  vi.spyOn(Math, 'random').mockReturnValue(0);
  service = new Service();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('connect outcomes', () => {
  it('connects, stores only ciphertext, and lists the zones', async () => {
    const view = connected(await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor));
    expect(view.accountName).toBe('Example Account');
    expect(view.scopes).toEqual({ zoneRead: 'confirmed', tunnel: 'unconfirmed' });
    expect(view.lastCheck.outcome).toBe('ok');
    expect(view.zonesVisible).toBe(2);
    expect(view.zones.map((z) => z.name)).toEqual(['example.com', 'example.net']);
    expect(view.zones.every((z) => !z.enabled && z.dns === 'unconfirmed')).toBe(true);
    const row = db().prepare('SELECT * FROM exposure_accounts').get() as Record<string, unknown>;
    expect(String(row.credential_enc).startsWith('enc:')).toBe(true);
    expect(JSON.stringify(row)).not.toContain(FAKE_TOKEN);
  });

  it('accepts an account-owned token that verifies only at its account', async () => {
    fake.verifyUser = 401;
    fake.verifyAccount = 'active';
    const view = connected(await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor));
    expect(view.lastCheck.outcome).toBe('ok');
    expect(fake.requests).toContain(`GET /accounts/${FAKE_ACCOUNT_ID}/tokens/verify`);
  });

  it.each([
    [401, 'TOKEN_INVALID'],
    [400, 'TOKEN_INVALID'],
  ] as const)('refuses a token Cloudflare answers %s to as %s and stores nothing', async (status, code) => {
    fake.verifyUser = status;
    fake.verifyAccount = status;
    const error = await refusal(service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor));
    expect(error.code).toBe(code);
    expect(error.status).toBe(422);
    expect(error.message).toBe('Cloudflare rejects this token. Check that it was copied whole.');
    expect(service.getView()).toEqual({ connected: false });
  });

  it('refuses an inactive token with its expiry', async () => {
    fake.verifyUser = 'disabled';
    const error = await refusal(service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor));
    expect(error.code).toBe('TOKEN_INACTIVE');
    expect(error.message).toContain('2026-01-01');
  });

  it('refuses a token Cloudflare refuses from this address, without fanning out', async () => {
    fake.verifyUser = 'location';
    const error = await refusal(service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor));
    expect(error.code).toBe('TOKEN_LOCATION_REFUSED');
    expect(fake.requests).toEqual(['GET /user/tokens/verify']);
  });

  it('reports a mistyped account id as not accessible, not as missing permissions', async () => {
    const error = await refusal(service.connect(FAKE_TOKEN, OTHER_ACCOUNT_ID, actor));
    expect(error.code).toBe('ACCOUNT_NOT_ACCESSIBLE');
  });

  it('reports an account the token cannot list or probe as not accessible', async () => {
    fake.accounts = 403;
    fake.zones = 403;
    fake.tunnel = 403;
    expect((await refusal(service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor))).code).toBe('ACCOUNT_NOT_ACCESSIBLE');
  });

  it('connects with no account name when only the account listing is refused', async () => {
    fake.accounts = 403;
    const view = connected(await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor));
    expect(view.accountName).toBeNull();
    expect(view.scopes.zoneRead).toBe('confirmed');
  });

  it('stores nothing when Cloudflare is unreachable at connect', async () => {
    fake.verifyUser = 'down';
    const error = await refusal(service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor));
    expect(error.code).toBe('CLOUDFLARE_UNREACHABLE');
    expect(error.status).toBe(502);
    expect(service.getView()).toEqual({ connected: false });
  });

  it('reports a Cloudflare rate limit with its wait', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, errors: [], messages: [], result: null }), { status: 429, headers: { 'retry-after': '90' } })));
    const error = await refusal(service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor));
    expect(error.code).toBe('CLOUDFLARE_RATE_LIMITED');
    expect(error.status).toBe(503);
    expect(error.retryAfterSeconds).toBe(90);
  });

  it("reports Sencho's own request budget as rate limited", async () => {
    for (let i = 0; i < 300; i += 1) await cloudflareApiClient.request(FAKE_TOKEN, { method: 'GET', path: '/user/tokens/verify' });
    const error = await refusal(service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor));
    expect(error.code).toBe('CLOUDFLARE_RATE_LIMITED');
    expect(error.message).toContain("Sencho's own Cloudflare request limit");
  });

  it('reports a response it cannot read as unexpected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>maintenance</html>', { status: 200 })));
    expect((await refusal(service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor))).code).toBe('UNEXPECTED_RESPONSE');
  });
});

describe('scopes', () => {
  it('names a token with no Cloudflare Tunnel permission', async () => {
    fake.tunnel = 403;
    expect(connected(await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor)).scopes.tunnel).toBe('missing');
  });

  it('names a token that cannot list zones, and keeps zone rows', async () => {
    await connectWithZoneA();
    fake.zones = 403;
    const view = connected(await service.recheck(actor));
    expect(view.scopes.zoneRead).toBe('missing');
    expect(view.zones).toHaveLength(2);
  });

  it('reports zero visible zones', async () => {
    fake.zones = [];
    const view = connected(await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor));
    expect(view.zonesVisible).toBe(0);
    expect(view.scopes.zoneRead).toBe('confirmed');
  });

  it('names a zone where DNS read is refused, per zone', async () => {
    await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor);
    await service.setZone(ZONE_A, true, [], actor);
    await service.setZone(ZONE_B, true, [], actor);
    fake.dnsRead[ZONE_A] = 403;
    const view = connected(await service.recheck(actor));
    expect(view.zones.find((z) => z.zoneRef === ZONE_A)?.dns).toBe('missing');
    expect(view.zones.find((z) => z.zoneRef === ZONE_B)?.dns).toBe('readable');
  });

  it('reports an unreadable stored credential', async () => {
    await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor);
    db().prepare(`UPDATE exposure_accounts SET credential_enc = 'enc:00:00:00'`).run();
    expect(connected(service.getView()).lastCheck.outcome).toBe('credential_unreadable');
    expect(connected(await service.recheck(actor)).lastCheck.outcome).toBe('credential_unreadable');
  });
});

describe('recheck', () => {
  it('keeps the last facts and marks them stale when Cloudflare is unreachable', async () => {
    await connectWithZoneA();
    const before = connected(service.getView());
    fake.verifyUser = 'down';
    const view = connected(await service.recheck(actor));
    expect(view.lastCheck.outcome).toBe('cloudflare_unreachable');
    expect(view.verifiedAt).toBe(before.verifiedAt);
    expect(view.scopes).toEqual(before.scopes);
    expect(view.zones).toEqual(before.zones);
  });
});

describe('account change rule', () => {
  it('replaces the token of the same account, keeps zones, and resets write proofs', async () => {
    await connectWithZoneA();
    await service.dnsCheck(ZONE_A, actor);
    expect(zoneA(service.getView()).dns).toBe('confirmed');
    const before = db().prepare('SELECT credential_enc FROM exposure_accounts').get() as { credential_enc: string };

    const view = await service.connect(`${FAKE_TOKEN}-new`, FAKE_ACCOUNT_ID, actor);
    expect(zoneA(view).enabled).toBe(true);
    expect(zoneA(view).dns).toBe('readable');
    const after = db().prepare('SELECT credential_enc FROM exposure_accounts').get() as { credential_enc: string };
    expect(after.credential_enc).not.toBe(before.credential_enc);
  });

  it('refuses a token for a different account until disconnect', async () => {
    await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor);
    fake.accounts = [{ id: OTHER_ACCOUNT_ID, name: 'Other' }];
    fake.requests = [];
    const error = await refusal(service.connect(FAKE_TOKEN, OTHER_ACCOUNT_ID, actor));
    expect(error.code).toBe('ACCOUNT_CHANGE_NEEDS_DISCONNECT');
    expect(fake.requests).not.toContain('GET /accounts');
  });

  it('refuses disconnect while a node endpoint exists', async () => {
    await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor);
    db().prepare(`INSERT INTO exposure_node_endpoints (node_id, account_id, provider_ref, name, state, created_by, created_at)
      VALUES (1, 1, 'tunnel-1', 'sencho-x-1', 'active', 'admin', 0)`).run();
    expect((await refusal(service.disconnect(actor))).code).toBe('ENDPOINTS_EXIST');
    expect(service.getView().connected).toBe(true);
  });

  it('disconnects and deletes the account and zone rows', async () => {
    await connectWithZoneA();
    await service.disconnect(actor);
    expect(service.getView()).toEqual({ connected: false });
    expect((db().prepare('SELECT COUNT(*) AS n FROM exposure_zones').get() as { n: number }).n).toBe(0);
    expect(fake.requests.filter((r) => r.startsWith('DELETE'))).toEqual([]);
  });
});

describe('DNS write check', () => {
  it('creates and deletes a TXT record at a name only this hub uses, then confirms', async () => {
    await connectWithZoneA();
    const { view } = await service.dnsCheck(ZONE_A, actor);
    expect(zoneA(view).dns).toBe('confirmed');
    expect(zoneA(view).dnsCheckedAt).not.toBeNull();
    expect(zoneA(view).cleanupPending).toBeNull();
    expect(fake.records.get(ZONE_A)).toEqual([]);
    expect(fake.requests).toContain(`POST /zones/${ZONE_A}/dns_records`);
  });

  it('refuses a zone that is not enabled', async () => {
    await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor);
    expect((await refusal(service.dnsCheck(ZONE_A, actor))).code).toBe('ZONE_NOT_ENABLED');
  });

  it('refuses and writes nothing when a foreign record sits at the name', async () => {
    await connectWithZoneA();
    fake.records.set(ZONE_A, [{ id: 'f'.repeat(32), type: 'CNAME', name: CHECK_NAME, content: 'elsewhere.example.org' }]);
    const error = await refusal(service.dnsCheck(ZONE_A, actor));
    expect(error.code).toBe('SCOPE_CHECK_CONFLICT');
    expect(error.message).toContain(CHECK_NAME);
    expect(fake.requests).not.toContain(`POST /zones/${ZONE_A}/dns_records`);
    expect(fake.records.get(ZONE_A)).toHaveLength(1);
  });

  it('names missing DNS Edit when the create is refused', async () => {
    await connectWithZoneA();
    fake.create = 403;
    const { view } = await service.dnsCheck(ZONE_A, actor);
    expect(zoneA(view).dns).toBe('missing');
    expect(zoneA(view).cleanupPending).toBeNull();
  });

  it('keeps DNS unchanged and reports another 4xx on create as unexpected', async () => {
    await connectWithZoneA();
    fake.create = 400;
    const error = await refusal(service.dnsCheck(ZONE_A, actor));
    expect(error.code).toBe('UNEXPECTED_RESPONSE');
    expect(error.message).toContain('Cloudflare code');
    expect(zoneA(service.getView()).dns).toBe('unconfirmed');
    expect(zoneA(service.getView()).cleanupPending).toBeNull();
  });

  it('keeps the journal after an ambiguous create, and the next check removes the record by exact match', async () => {
    await connectWithZoneA();
    fake.create = 500;
    const { view } = await service.dnsCheck(ZONE_A, actor);
    expect(zoneA(view).cleanupPending).toMatchObject({ recordName: CHECK_NAME });
    expect(fake.records.get(ZONE_A)).toHaveLength(1);

    fake.create = 'ok';
    const after = await service.recheck(actor);
    expect(zoneA(after).cleanupPending).toBeNull();
    expect(fake.records.get(ZONE_A)).toEqual([]);
  });

  it('keeps the journal after a dropped connection on create', async () => {
    await connectWithZoneA();
    fake.create = 'reset';
    expect(zoneA((await service.dnsCheck(ZONE_A, actor)).view).cleanupPending).toMatchObject({ recordName: CHECK_NAME });
  });

  it('clears the journal when the interrupted create never landed', async () => {
    await connectWithZoneA();
    db().prepare('UPDATE exposure_zones SET scope_check_pending_json = ? WHERE zone_ref = ?')
      .run(JSON.stringify({ name: CHECK_NAME, content: 'sencho-scope-check:00', recordId: null }), ZONE_A);
    const { view } = await service.dnsCheck(ZONE_A, actor);
    expect(zoneA(view).dns).toBe('confirmed');
    expect(zoneA(view).cleanupPending).toBeNull();
  });

  it('keeps the journal when the delete fails, and the next check deletes by record id', async () => {
    await connectWithZoneA();
    fake.remove = 500;
    expect(zoneA((await service.dnsCheck(ZONE_A, actor)).view).cleanupPending).toMatchObject({ recordName: CHECK_NAME });
    const pending = db().prepare('SELECT scope_check_pending_json AS p FROM exposure_zones WHERE zone_ref = ?').get(ZONE_A) as { p: string };
    expect(JSON.parse(pending.p).recordId).toMatch(/^[0-9a-f]{32}$/);
    fake.remove = 'ok';
    const { view } = await service.dnsCheck(ZONE_A, actor);
    expect(zoneA(view).dns).toBe('confirmed');
    expect(fake.records.get(ZONE_A)).toEqual([]);
  });

  it('counts a 404 on delete as done', async () => {
    await connectWithZoneA();
    db().prepare('UPDATE exposure_zones SET scope_check_pending_json = ? WHERE zone_ref = ?')
      .run(JSON.stringify({ name: CHECK_NAME, content: 'x', recordId: '9'.repeat(32) }), ZONE_A);
    await service.recheck(actor);
    expect(zoneA(service.getView()).cleanupPending).toBeNull();
  });

  it('refuses disconnect while a check record cannot be cleaned up', async () => {
    await connectWithZoneA();
    fake.remove = 500;
    await service.dnsCheck(ZONE_A, actor);
    const error = await refusal(service.disconnect(actor));
    expect(error.code).toBe('CLEANUP_PENDING');
    expect(error.message).toContain(CHECK_NAME);
    fake.remove = 'ok';
    await service.disconnect(actor);
    expect(fake.records.get(ZONE_A)).toEqual([]);
  });
});

describe('zones', () => {
  it('validates suffixes against the zone and lowercases them', async () => {
    await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor);
    const view = await service.setZone(ZONE_A, true, ['Apps.Example.com', 'apps.example.com'], actor);
    expect(zoneA(view).allowedSuffixes).toEqual(['apps.example.com']);
    expect((await refusal(service.setZone(ZONE_A, true, ['apps.example.net'], actor))).code).toBe('INVALID_INPUT');
    expect((await refusal(service.setZone(ZONE_A, true, ['*.example.com'], actor))).code).toBe('INVALID_INPUT');
    expect((await refusal(service.setZone('e'.repeat(32), true, [], actor))).code).toBe('ZONE_NOT_FOUND');
  });

  it('lists enabled zones only', async () => {
    await connectWithZoneA();
    expect(service.listEnabledZones()).toEqual([{ zoneRef: ZONE_A, name: 'example.com', allowedSuffixes: [], dns: 'unconfirmed' }]);
  });

  it('keeps an enabled zone that vanished, drops a disabled one, and never overwrites enablement', async () => {
    await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor);
    await service.setZone(ZONE_A, true, ['apps.example.com'], actor);
    fake.zones = [{ id: ZONE_A, name: 'example.com' }];
    let view = connected(await service.recheck(actor));
    expect(view.zones.map((z) => z.zoneRef)).toEqual([ZONE_A]);
    expect(zoneA(view).allowedSuffixes).toEqual(['apps.example.com']);

    fake.zones = [];
    view = connected(await service.recheck(actor));
    expect(zoneA(view).enabled).toBe(true);
    expect(zoneA(view).seenAtLastCheck).toBe(false);
    expect(view.zonesVisible).toBe(0);
  });

  it('changes no zone row on an incomplete listing', async () => {
    await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor);
    fake.zones = Array.from({ length: 60 }, (_, i) => ({ id: i.toString(16).padStart(32, '0'), name: `z${i}.example` }));
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/zones') && url.searchParams.get('page') === '2') {
        return new Response('broken', { status: 200 });
      }
      return answer(fake, url, init ?? {});
    }));
    const view = connected(await service.recheck(actor));
    expect(view.lastCheck.outcome).toBe('unexpected_response');
    expect(view.zones.map((z) => z.name)).toEqual(['example.com', 'example.net']);
  });
});

describe('lock and deadline', () => {
  it('refuses every write while another runs', async () => {
    await connectWithZoneA();
    let release: () => void = () => undefined;
    fake.gate = new Promise((resolve) => { release = resolve; });
    const running = service.recheck(actor);
    expect((await refusal(service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor))).code).toBe('ACCOUNT_BUSY');
    expect((await refusal(service.recheck(actor))).code).toBe('ACCOUNT_BUSY');
    expect((await refusal(service.dnsCheck(ZONE_A, actor))).code).toBe('ACCOUNT_BUSY');
    expect((await refusal(service.setZone(ZONE_A, false, [], actor))).code).toBe('ACCOUNT_BUSY');
    expect((await refusal(service.disconnect(actor))).code).toBe('ACCOUNT_BUSY');
    fake.gate = null;
    release();
    await running;
    await service.setZone(ZONE_A, false, [], actor);
  });

  it('bounds a whole operation at 45 s', async () => {
    await connectWithZoneA();
    fake.requests = [];
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(answer(fake, new URL(String(input)), init ?? {})), 9_000);
      init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); });
    })));
    // Each call answers after 9 s: verify, accounts, zones and tunnel finish at
    // 36 s, and the DNS read of the enabled zone runs into the 45 s deadline.
    const pending = service.recheck(actor);
    await vi.advanceTimersByTimeAsync(46_000);
    const view = connected(await pending);
    expect(view.lastCheck.outcome).toBe('cloudflare_unreachable');
    expect(fake.requests).toHaveLength(4);
  });
});

describe('audit rows', () => {
  it('writes a row per action with no token material', async () => {
    await connectWithZoneA();
    await service.dnsCheck(ZONE_A, actor);
    await service.recheck(actor);
    await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor);
    await service.setZone(ZONE_A, false, [], actor);
    await service.disconnect(actor);
    DatabaseService.getInstance().flushAuditLogBuffer();
    const rows = db().prepare(`SELECT summary, path FROM audit_log WHERE summary LIKE 'public_exposure.%'`).all() as Array<{ summary: string; path: string }>;
    const actions = rows.map((r) => r.summary.split(':')[0]);
    for (const action of [
      'public_exposure.account.connected', 'public_exposure.zone.enabled', 'public_exposure.account.dns_checked',
      'public_exposure.account.rechecked', 'public_exposure.account.replaced', 'public_exposure.zone.disabled',
      'public_exposure.account.removed',
    ]) expect(actions).toContain(action);
    expect(JSON.stringify(rows)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(rows)).not.toContain(FAKE_TOKEN.slice(0, 8));
  });
});

describe('account classification', () => {
  it('reports a mistyped id as not accessible when the account listing is refused', async () => {
    fake.accounts = 403;
    const error = await refusal(service.connect(FAKE_TOKEN, OTHER_ACCOUNT_ID, actor));
    expect(error.code).toBe('ACCOUNT_NOT_ACCESSIBLE');
    expect(service.getView()).toEqual({ connected: false });
  });

  it('reports a mistyped id with an account-owned token as not accessible, not as an invalid token', async () => {
    fake.verifyUser = 401;
    fake.verifyAccount = 'active';
    expect((await refusal(service.connect(FAKE_TOKEN, OTHER_ACCOUNT_ID, actor))).code).toBe('ACCOUNT_NOT_ACCESSIBLE');
  });

  it('recognises a location refusal by its message, whatever its code', async () => {
    const body = { code: 1000, message: 'Cannot use the access token from location: 203.0.113.9' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, errors: [body], messages: [], result: null }), { status: 403 })));
    expect((await refusal(service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor))).code).toBe('TOKEN_LOCATION_REFUSED');
  });

  it('reads a plain 9109 refusal as a missing permission, not a location refusal', async () => {
    // Cloudflare answers a missing permission with the code its location refusal uses.
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/cfd_tunnel')) {
        return new Response(JSON.stringify({ success: false, errors: [{ code: 9109, message: 'Unauthorized to access requested resource' }], messages: [], result: null }), { status: 403 });
      }
      return answer(fake, url, init ?? {});
    }));
    expect(connected(await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor)).scopes.tunnel).toBe('missing');
  });

  it('does not read a zone listing 400 with another code as an inaccessible account', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/zones')) {
        return new Response(JSON.stringify({ success: false, errors: [{ code: 1001, message: 'Invalid request' }], messages: [], result: null }), { status: 400 });
      }
      return answer(fake, url, init ?? {});
    }));
    expect((await refusal(service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor))).code).toBe('UNEXPECTED_RESPONSE');
  });

  it.each([
    [7003, 'Could not route to /accounts/x/tokens/verify, perhaps your object identifier is invalid?'],
    [70503, "account with given Tag doesn't exist"],
  ])('reports an account-owned token whose account verify answers 400 code %i as not accessible', async (code, message) => {
    fake.verifyUser = 401;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/accounts/') && url.pathname.endsWith('/tokens/verify')) {
        return new Response(JSON.stringify({ success: false, errors: [{ code, message }], messages: [], result: null }), { status: 400 });
      }
      return answer(fake, url, init ?? {});
    }));
    expect((await refusal(service.connect(FAKE_TOKEN, OTHER_ACCOUNT_ID, actor))).code).toBe('ACCOUNT_NOT_ACCESSIBLE');
  });

  it('connects a token without account read, whose account listing comes back empty', async () => {
    fake.accounts = [];
    const view = connected(await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor));
    expect(view.accountName).toBeNull();
    expect(view.scopes).toMatchObject({ zoneRead: 'confirmed', tunnel: 'unconfirmed' });
  });

  it('still reports a mistyped id as not accessible when the account listing comes back empty', async () => {
    fake.accounts = [];
    expect((await refusal(service.connect(FAKE_TOKEN, OTHER_ACCOUNT_ID, actor))).code).toBe('ACCOUNT_NOT_ACCESSIBLE');
  });

  it('does not treat an unrelated message that mentions a location as a location refusal', async () => {
    fake.tunnel = 403;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/cfd_tunnel')) {
        return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error at this location' }], messages: [], result: null }), { status: 403 });
      }
      return answer(fake, url, init ?? {});
    }));
    expect(connected(await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor)).scopes.tunnel).toBe('missing');
  });

  it('does not probe DNS in an enabled zone that left the listing, and reports it as not visible', async () => {
    await connectWithZoneA();
    fake.zones = [{ id: ZONE_B, name: 'example.net' }];
    fake.requests = [];
    const view = await service.recheck(actor);
    expect(zoneA(view).seenAtLastCheck).toBe(false);
    expect(zoneA(view).dns).toBe('unconfirmed');
    expect(fake.requests).not.toContain(`GET /zones/${ZONE_A}/dns_records`);
  });
});

describe('recheck after a good check', () => {
  it.each([
    ['token_invalid', () => { fake.verifyUser = 401; fake.verifyAccount = 401; }],
    ['token_location_refused', () => { fake.verifyUser = 'location'; }],
    ['token_inactive', () => { fake.verifyUser = 'disabled'; }],
  ] as const)('records %s and keeps the last facts', async (outcome, breakIt) => {
    await connectWithZoneA();
    const before = connected(service.getView());
    breakIt();
    const view = connected(await service.recheck(actor));
    expect(view.lastCheck.outcome).toBe(outcome);
    expect(view.verifiedAt).toBe(before.verifiedAt);
    expect(view.scopes).toEqual(before.scopes);
    expect(view.zones).toEqual(before.zones);
  });

  it('records which side rate-limited a recheck', async () => {
    await connectWithZoneA();
    cloudflareApiClient.resetBudgetForTests();
    for (let i = 0; i < 300; i += 1) await cloudflareApiClient.request(FAKE_TOKEN, { method: 'GET', path: '/user/tokens/verify' });
    const view = connected(await service.recheck(actor));
    expect(view.lastCheck).toMatchObject({ outcome: 'rate_limited', limitedBy: 'sencho' });
  });

  it('reads an unknown stored outcome as unexpected, never as ok', async () => {
    await connectWithZoneA();
    db().prepare(`UPDATE exposure_accounts SET last_check_json = '{"outcome":"future_state","at":1}'`).run();
    expect(connected(service.getView()).lastCheck.outcome).toBe('unexpected_response');
  });
});

describe('replace refused', () => {
  it('keeps the stored ciphertext and the zones when the new token is rejected', async () => {
    await connectWithZoneA();
    const before = db().prepare('SELECT credential_enc FROM exposure_accounts').get() as { credential_enc: string };
    fake.verifyUser = 401;
    fake.verifyAccount = 401;
    expect((await refusal(service.connect(`${FAKE_TOKEN}-bad`, FAKE_ACCOUNT_ID, actor))).code).toBe('TOKEN_INVALID');
    const after = db().prepare('SELECT credential_enc FROM exposure_accounts').get() as { credential_enc: string };
    expect(after.credential_enc).toBe(before.credential_enc);
    expect(zoneA(service.getView()).enabled).toBe(true);
  });
});

describe('writes re-checked inside the transaction', () => {
  it('refuses disconnect when an endpoint appears during the check record cleanup', async () => {
    await connectWithZoneA();
    fake.remove = 500;
    await service.dnsCheck(ZONE_A, actor);
    fake.remove = 'ok';
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'DELETE') {
        db().prepare(`INSERT INTO exposure_node_endpoints (node_id, account_id, provider_ref, name, state, created_by, created_at)
          VALUES (1, 1, 'tunnel-late', 'sencho-x-1', 'provisioning', 'admin', 0)`).run();
      }
      return answer(fake, new URL(String(input)), init ?? {});
    }));
    expect((await refusal(service.disconnect(actor))).code).toBe('ENDPOINTS_EXIST');
    expect(service.getView().connected).toBe(true);
  });

  it('refuses a connect when another account is stored while the probes run', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/cfd_tunnel') && (db().prepare('SELECT COUNT(*) AS n FROM exposure_accounts').get() as { n: number }).n === 0) {
        db().prepare(`INSERT INTO exposure_accounts (adapter_id, credential_enc, config_json, scopes_json, last_check_json, created_by, created_at, updated_at)
          VALUES ('cloudflare-tunnel', 'enc:x', ?, '{}', '{}', 'other', 0, 0)`).run(JSON.stringify({ accountId: OTHER_ACCOUNT_ID }));
      }
      return answer(fake, url, init ?? {});
    }));
    expect((await refusal(service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor))).code).toBe('ACCOUNT_CHANGE_NEEDS_DISCONNECT');
    expect(connected(service.getView()).accountId).toBe(OTHER_ACCOUNT_ID);
  });
});

describe('DNS check journal edges', () => {
  it('writes nothing new while a leftover record cannot be cleaned up', async () => {
    await connectWithZoneA();
    fake.remove = 500;
    await service.dnsCheck(ZONE_A, actor);
    fake.requests = [];
    const { view } = await service.dnsCheck(ZONE_A, actor);
    expect(zoneA(view).cleanupPending).toMatchObject({ recordName: CHECK_NAME });
    expect(fake.requests.filter((r) => r.startsWith('POST'))).toEqual([]);
  });

  it('clears the journal and reports the limit when the create is rate limited', async () => {
    await connectWithZoneA();
    fake.create = 403;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ success: false, errors: [], messages: [], result: null }), { status: 429, headers: { 'retry-after': '60' } });
      return answer(fake, new URL(String(input)), init ?? {});
    }));
    const error = await refusal(service.dnsCheck(ZONE_A, actor));
    expect(error.code).toBe('CLOUDFLARE_RATE_LIMITED');
    expect(zoneA(service.getView()).cleanupPending).toBeNull();
  });

  it('names missing DNS read when the record listing is refused', async () => {
    await connectWithZoneA();
    fake.dnsRead[ZONE_A] = 403;
    expect(zoneA((await service.dnsCheck(ZONE_A, actor)).view).dns).toBe('missing');
  });

  it('reports a location refusal on the create as such, not as missing DNS Edit', async () => {
    await connectWithZoneA();
    fake.create = 'location';
    expect((await refusal(service.dnsCheck(ZONE_A, actor))).code).toBe('TOKEN_LOCATION_REFUSED');
    expect(zoneA(service.getView()).dns).toBe('unconfirmed');
    expect(zoneA(service.getView()).cleanupPending).toBeNull();
  });

  it('keeps a create that is unnamed in its answer pending, then removes it by exact match', async () => {
    await connectWithZoneA();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const res = answer(fake, new URL(String(input)), init ?? {});
      if (init?.method === 'POST') return new Response(JSON.stringify({ success: true, errors: [], messages: [], result: {} }));
      return res;
    }));
    expect(zoneA((await service.dnsCheck(ZONE_A, actor)).view).cleanupPending).toMatchObject({ recordName: CHECK_NAME });
    installFakeCloudflare(fake);
    await service.recheck(actor);
    expect(fake.records.get(ZONE_A)).toEqual([]);
  });

  it('does not declare a fresh create lost before it could land', async () => {
    await connectWithZoneA();
    db().prepare('UPDATE exposure_zones SET scope_check_pending_json = ? WHERE zone_ref = ?')
      .run(JSON.stringify({ name: CHECK_NAME, content: 'sencho-scope-check:00', recordId: null, createdAt: Date.now() }), ZONE_A);
    await service.recheck(actor);
    expect(zoneA(service.getView()).cleanupPending).toMatchObject({ recordName: CHECK_NAME });
  });

  it('lets disconnect through when the zone holding the leftover record is gone from Cloudflare', async () => {
    await connectWithZoneA();
    db().prepare('UPDATE exposure_zones SET scope_check_pending_json = ? WHERE zone_ref = ?')
      .run(JSON.stringify({ name: CHECK_NAME, content: 'x', recordId: null, createdAt: 0 }), ZONE_A);
    fake.dnsRead[ZONE_A] = 404;
    await service.disconnect(actor);
    expect(service.getView()).toEqual({ connected: false });
  });

  it('names the cause when disconnect cannot clean up', async () => {
    await connectWithZoneA();
    fake.remove = 500;
    await service.dnsCheck(ZONE_A, actor);
    fake.remove = 'down';
    expect((await refusal(service.disconnect(actor))).message).toContain('Could not reach api.cloudflare.com');
    fake.remove = 403;
    expect((await refusal(service.disconnect(actor))).message).toContain('Cloudflare refused the delete');
  });

  it('keeps the record pending when the deadline cuts the check after the create', async () => {
    await connectWithZoneA();
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const delay = init?.method === 'DELETE' ? 60_000 : 0;
      const timer = setTimeout(() => resolve(answer(fake, new URL(String(input)), init ?? {})), delay);
      init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); });
    })));
    const pending = service.dnsCheck(ZONE_A, actor);
    await vi.advanceTimersByTimeAsync(46_000);
    const { view } = await pending;
    expect(zoneA(view).cleanupPending).toMatchObject({ recordName: CHECK_NAME });
    const journal = db().prepare('SELECT scope_check_pending_json AS p FROM exposure_zones WHERE zone_ref = ?').get(ZONE_A) as { p: string };
    expect(JSON.parse(journal.p).recordId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('reports a missing control identity with its own code', async () => {
    await connectWithZoneA();
    vi.spyOn(FleetSyncService, 'getControlIdentity').mockReturnValue('');
    expect((await refusal(service.dnsCheck(ZONE_A, actor))).code).toBe('CONTROL_IDENTITY_MISSING');
    expect(zoneA(service.getView()).checkRecordName).toBeNull();
  });
});

describe('service audit rows say what happened', () => {
  function rows(): Array<{ summary: string; status_code: number }> {
    DatabaseService.getInstance().flushAuditLogBuffer();
    return db().prepare(`SELECT summary, status_code FROM audit_log WHERE summary LIKE 'public_exposure.%' ORDER BY id`).all() as Array<{ summary: string; status_code: number }>;
  }

  beforeEach(() => {
    DatabaseService.getInstance().flushAuditLogBuffer();
    db().exec('DELETE FROM audit_log');
  });

  it('records connect versus replace, recheck results and refused DNS checks with their status', async () => {
    await connectWithZoneA();
    await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor);
    fake.verifyUser = 'down';
    await service.recheck(actor);
    fake.verifyUser = 'active';
    fake.records.set(ZONE_A, [{ id: 'f'.repeat(32), type: 'CNAME', name: CHECK_NAME, content: 'x' }]);
    await refusal(service.dnsCheck(ZONE_A, actor));
    const all = rows();
    expect(all[0].summary).toMatch(/^public_exposure\.account\.connected: account=/);
    expect(all.some((r) => r.summary.startsWith('public_exposure.account.replaced:'))).toBe(true);
    expect(all.find((r) => r.summary.startsWith('public_exposure.account.rechecked:'))?.summary).toContain('result=cloudflare_unreachable');
    const conflict = all.find((r) => r.summary.startsWith('public_exposure.account.dns_checked:'));
    expect(conflict).toMatchObject({ status_code: 409 });
    expect(conflict?.summary).toContain('result=conflict');
  });
});

describe('round two edges', () => {
  it('audits a failed DNS check with its status', async () => {
    await connectWithZoneA();
    DatabaseService.getInstance().flushAuditLogBuffer();
    db().exec('DELETE FROM audit_log');
    fake.create = 'location';
    await refusal(service.dnsCheck(ZONE_A, actor));
    DatabaseService.getInstance().flushAuditLogBuffer();
    const row = db().prepare(`SELECT summary, status_code FROM audit_log WHERE summary LIKE 'public_exposure.account.dns_checked%'`).get() as { summary: string; status_code: number };
    expect(row.status_code).toBe(422);
    expect(row.summary).toContain('result=token_location_refused');
  });

  it('clears the journal when the create was refused before it was sent', async () => {
    await connectWithZoneA();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
      return answer(fake, new URL(String(input)), init ?? {});
    }));
    expect((await refusal(service.dnsCheck(ZONE_A, actor))).code).toBe('CLOUDFLARE_UNREACHABLE');
    expect(zoneA(service.getView()).cleanupPending).toBeNull();
  });

  it('records a Cloudflare-side rate limit on recheck', async () => {
    await connectWithZoneA();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, errors: [], messages: [], result: null }), { status: 429, headers: { 'retry-after': '120' } })));
    const view = connected(await service.recheck(actor));
    expect(view.lastCheck).toMatchObject({ outcome: 'rate_limited', limitedBy: 'cloudflare', retryAfterSeconds: 120 });
  });

  it('clears the journal on recheck when the zone holding the record is gone', async () => {
    await connectWithZoneA();
    db().prepare('UPDATE exposure_zones SET scope_check_pending_json = ? WHERE zone_ref = ?')
      .run(JSON.stringify({ name: CHECK_NAME, content: 'x', recordId: null, createdAt: 0 }), ZONE_A);
    fake.dnsRead[ZONE_A] = 404;
    expect(zoneA(await service.recheck(actor)).cleanupPending).toBeNull();
  });

  it('reports a token revoked after it verified as rejected during the DNS check', async () => {
    await connectWithZoneA();
    fake.dnsRead[ZONE_A] = 401;
    expect((await refusal(service.dnsCheck(ZONE_A, actor))).code).toBe('TOKEN_INVALID');
  });

  it('reads a 403 at the account verify as a rejected token, not a wrong account id', async () => {
    fake.verifyUser = 401;
    fake.verifyAccount = 403;
    expect((await refusal(service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor))).code).toBe('TOKEN_INVALID');
  });

  it('lets disconnect through when the zone left the account and its record cannot be deleted', async () => {
    await leftoverInGoneZone();
    fake.remove = 403;
    const warn = vi.spyOn(console, 'warn');
    DatabaseService.getInstance().flushAuditLogBuffer();
    db().exec('DELETE FROM audit_log');
    // The caller is told which record stays in Cloudflare.
    expect(await service.disconnect(actor)).toEqual({ leftInCloudflare: [CHECK_NAME] });
    expect(service.getView()).toEqual({ connected: false });
    expect(warn.mock.calls.some((call) => String(call[0]).includes(CHECK_NAME))).toBe(true);
    DatabaseService.getInstance().flushAuditLogBuffer();
    const row = db().prepare(`SELECT summary FROM audit_log WHERE summary LIKE 'public_exposure.account.removed%'`).get() as { summary: string };
    expect(row.summary).toContain(`left_in_cloudflare=${CHECK_NAME}`);
  });

  it.each([
    ['unreachable', 'down' as const, 'Could not reach api.cloudflare.com'],
    ['a rejected token', 401 as const, 'Cloudflare refused the delete'],
    ['a refused location', 'location' as const, 'Cloudflare refused the delete'],
  ])('keeps refusing disconnect for a zone that left the account when the delete is %s', async (_label, remove, message) => {
    await leftoverInGoneZone();
    fake.remove = remove;
    const error = await refusal(service.disconnect(actor));
    expect(error.code).toBe('CLEANUP_PENDING');
    expect(error.message).toContain(message);
    expect(zoneA(service.getView()).cleanupPending).toMatchObject({ recordName: CHECK_NAME });
  });

  it('keeps refusing disconnect for a zone that left the account when Cloudflare rate limits the delete', async () => {
    await leftoverInGoneZone();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(JSON.stringify({ success: false, errors: [], messages: [], result: null }), { status: 429, headers: { 'retry-after': '120' } });
      return answer(fake, new URL(String(input)), init ?? {});
    }));
    const error = await refusal(service.disconnect(actor));
    expect(error.code).toBe('CLEANUP_PENDING');
    expect(error.message).toContain('Cloudflare is limiting requests');
    expect(zoneA(service.getView()).cleanupPending).toMatchObject({ recordName: CHECK_NAME });
  });

  it('keeps refusing disconnect for a zone that left the account while a timed-out create may still land', async () => {
    await leftoverInGoneZone();
    db().prepare('UPDATE exposure_zones SET scope_check_pending_json = ? WHERE zone_ref = ?')
      .run(JSON.stringify({ name: CHECK_NAME, content: 'sencho-scope-check:late', recordId: null, createdAt: Date.now() }), ZONE_A);
    const error = await refusal(service.disconnect(actor));
    expect(error.code).toBe('CLEANUP_PENDING');
    expect(error.message).toContain('may still be landing');
    expect(zoneA(service.getView()).cleanupPending).toMatchObject({ recordName: CHECK_NAME });
  });

  it('keeps refusing disconnect for a zone that left the account when its record answer cannot be read', async () => {
    await leftoverInGoneZone();
    fake.records.set(ZONE_A, [{ id: 'not-a-cloudflare-id', type: 'TXT', name: CHECK_NAME, content: '"sencho-scope-check:odd"' }]);
    db().prepare('UPDATE exposure_zones SET scope_check_pending_json = ? WHERE zone_ref = ?')
      .run(JSON.stringify({ name: CHECK_NAME, content: 'sencho-scope-check:odd', recordId: null, createdAt: 0 }), ZONE_A);
    const error = await refusal(service.disconnect(actor));
    expect(error.code).toBe('CLEANUP_PENDING');
    expect(zoneA(service.getView()).cleanupPending).toMatchObject({ recordName: CHECK_NAME });
  });

  it('keeps the leftover record journal when an endpoint appears during a disconnect that would abandon it', async () => {
    await leftoverInGoneZone();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        db().prepare(`INSERT INTO exposure_node_endpoints (node_id, account_id, provider_ref, name, state, created_by, created_at)
          VALUES (1, 1, 'tunnel-late', 'sencho-x-1', 'provisioning', 'admin', 0)`).run();
      }
      fake.remove = 403;
      return answer(fake, new URL(String(input)), init ?? {});
    }));
    expect((await refusal(service.disconnect(actor))).code).toBe('ENDPOINTS_EXIST');
    expect(zoneA(service.getView()).cleanupPending).toMatchObject({ recordName: CHECK_NAME });
  });

  it('names every record it leaves when several zones left the account', async () => {
    await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor);
    await service.setZone(ZONE_A, true, [], actor);
    await service.setZone(ZONE_B, true, [], actor);
    fake.remove = 500;
    await service.dnsCheck(ZONE_A, actor);
    await service.dnsCheck(ZONE_B, actor);
    fake.zones = [];
    await service.recheck(actor);
    fake.remove = 403;
    DatabaseService.getInstance().flushAuditLogBuffer();
    db().exec('DELETE FROM audit_log');
    await service.disconnect(actor);
    DatabaseService.getInstance().flushAuditLogBuffer();
    const row = db().prepare(`SELECT summary FROM audit_log WHERE summary LIKE 'public_exposure.account.removed%'`).get() as { summary: string };
    expect(row.summary).toContain(CHECK_NAME);
    expect(row.summary).toContain(`_sencho-check-${CONTROL_ID}.example.net`);
  });

  it('keeps refusing disconnect on a 403 when the zones were never listed', async () => {
    await connectWithZoneA();
    fake.remove = 500;
    await service.dnsCheck(ZONE_A, actor);
    db().prepare("UPDATE exposure_accounts SET config_json = json_set(config_json, '$.zonesListedAt', NULL)").run();
    fake.remove = 403;
    expect((await refusal(service.disconnect(actor))).code).toBe('CLEANUP_PENDING');
  });

  it('labels a refused delete right after the create as refused, not as a zone out of reach', async () => {
    await connectWithZoneA();
    DatabaseService.getInstance().flushAuditLogBuffer();
    db().exec('DELETE FROM audit_log');
    fake.remove = 403;
    await service.dnsCheck(ZONE_A, actor);
    DatabaseService.getInstance().flushAuditLogBuffer();
    const row = db().prepare(`SELECT summary FROM audit_log WHERE summary LIKE 'public_exposure.account.dns_checked%'`).get() as { summary: string };
    expect(row.summary).toContain('cause=refused');
  });

  it('audits a DNS check that left a record with status 202', async () => {
    await connectWithZoneA();
    DatabaseService.getInstance().flushAuditLogBuffer();
    db().exec('DELETE FROM audit_log');
    fake.remove = 500;
    await service.dnsCheck(ZONE_A, actor);
    DatabaseService.getInstance().flushAuditLogBuffer();
    const row = db().prepare(`SELECT summary, status_code FROM audit_log WHERE summary LIKE 'public_exposure.account.dns_checked%'`).get() as { summary: string; status_code: number };
    expect(row.status_code).toBe(202);
    expect(row.summary).toContain('result=cleanup_pending');
  });

  it('keeps refusing disconnect while a still-listed zone cannot be cleaned up', async () => {
    await connectWithZoneA();
    fake.remove = 500;
    await service.dnsCheck(ZONE_A, actor);
    fake.remove = 403;
    expect((await refusal(service.disconnect(actor))).code).toBe('CLEANUP_PENDING');
  });

  it('marks a DNS check that left a record as not complete', async () => {
    await connectWithZoneA();
    fake.remove = 500;
    const result = await service.dnsCheck(ZONE_A, actor);
    expect(result.complete).toBe(false);
  });
});


/** Answer these paths with a fixed success body and everything else from the fake. */
function overrideAnswers(answers: Array<{ path: RegExp; method?: string; query?: (url: URL) => boolean; result: unknown }>): void {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/client/v4', '');
    const hit = answers.find((a) => a.path.test(path) && (a.method ?? 'GET') === (init?.method ?? 'GET') && (a.query?.(url) ?? true));
    if (hit) return new Response(JSON.stringify({ success: true, errors: [], messages: [], result: hit.result, result_info: { page: 1, total_pages: 1 } }));
    return answer(fake, url, init ?? {});
  }));
}

function journal(zoneRef: string): string | null {
  return (db().prepare('SELECT scope_check_pending_json AS p FROM exposure_zones WHERE zone_ref = ?').get(zoneRef) as { p: string | null }).p;
}

function setJournal(value: string | null): void {
  db().prepare('UPDATE exposure_zones SET scope_check_pending_json = ? WHERE zone_ref = ?').run(value, ZONE_A);
}

const OLD_JOURNAL = { name: CHECK_NAME, content: 'sencho-scope-check:00', recordId: null, createdAt: 0 };

describe('an answer Cloudflare marks successful but Sencho cannot read', () => {
  const GOOD_ZONE = { id: ZONE_A, name: 'example.com' };
  it.each([
    ['an object with no fields', [{}]],
    ['a zone with a bad id', [{ id: 'not-hex', name: 'example.net' }]],
    ['one good zone beside one bad zone', [GOOD_ZONE, { id: ZONE_B }]],
    ['a null element', [GOOD_ZONE, null]],
  ])('keeps the stored zones and records an unexpected answer when the zone page is %s', async (_label, page) => {
    await connectWithZoneA();
    const before = connected(service.getView());
    expect(before.zones.map((z) => z.zoneRef)).toEqual([ZONE_A, ZONE_B]);
    (fake as { zones: unknown }).zones = page;
    const view = connected(await service.recheck(actor));
    expect(view.lastCheck.outcome).toBe('unexpected_response');
    // The disabled zone B is not in the bad page, and a partial page must not delete it or hide zone A.
    expect(view.zones.map((z) => z.zoneRef)).toEqual([ZONE_A, ZONE_B]);
    expect(view.zonesVisible).toBe(before.zonesVisible);
    expect(view.zones.every((z) => z.seenAtLastCheck)).toBe(true);
  });

  it('refuses a connect from an unreadable zone page and stores nothing', async () => {
    (fake as { zones: unknown }).zones = [GOOD_ZONE, null];
    expect((await refusal(service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor))).code).toBe('UNEXPECTED_RESPONSE');
    expect(service.getView()).toEqual({ connected: false });
  });

  it.each([
    ['a null element', [null]],
    ['an element with no id', [{ name: 'Example Account' }]],
  ])('reads an account list with %s as unexpected, not as a missing account', async (_label, accounts) => {
    (fake as { accounts: unknown }).accounts = accounts;
    expect((await refusal(service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor))).code).toBe('UNEXPECTED_RESPONSE');
  });

  it.each([
    ['no result', undefined],
    ['a null result', null],
    ['an empty result', {}],
    ['a status that is not text', { status: 1 }],
  ])('reads a token verify with %s as unexpected, not as an inactive token', async (_label, result) => {
    overrideAnswers([{ path: /^\/user\/tokens\/verify$/, result }]);
    const error = await refusal(service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor));
    expect(error.code).toBe('UNEXPECTED_RESPONSE');
    expect(error.message).not.toContain('not active');
    expect(service.getView()).toEqual({ connected: false });
  });

  it('reads an account-level verify without a status as unexpected too', async () => {
    fake.verifyUser = 401;
    overrideAnswers([{ path: /^\/accounts\/[0-9a-f]+\/tokens\/verify$/, result: {} }]);
    expect((await refusal(service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor))).code).toBe('UNEXPECTED_RESPONSE');
  });

  it('keeps a recheck from calling the token inactive on a verify without a status', async () => {
    await connectWithZoneA();
    overrideAnswers([{ path: /^\/user\/tokens\/verify$/, result: {} }]);
    expect(connected(await service.recheck(actor)).lastCheck.outcome).toBe('unexpected_response');
  });

  describe('a record listing with an unreadable element', () => {
    const atCheckName = (url: URL) => url.searchParams.get('name') === CHECK_NAME;
    const bad = { path: /^\/zones\/[0-9a-f]+\/dns_records$/, query: atCheckName, result: [null] };

    it('keeps the journal and names an unreadable answer when cleanup reads it', async () => {
      await connectWithZoneA();
      setJournal(JSON.stringify(OLD_JOURNAL));
      overrideAnswers([bad]);
      const view = connected(await service.recheck(actor));
      expect(zoneA(view).cleanupPending?.note).toContain('could not read');
      expect(journal(ZONE_A)).not.toBeNull();
    });

    it('refuses the DNS check as unexpected instead of a server error', async () => {
      await connectWithZoneA();
      overrideAnswers([bad]);
      expect((await refusal(service.dnsCheck(ZONE_A, actor))).code).toBe('UNEXPECTED_RESPONSE');
      expect(zoneA(service.getView()).dns).not.toBe('confirmed');
    });

    it('refuses disconnect while the record cannot be read', async () => {
      await connectWithZoneA();
      setJournal(JSON.stringify(OLD_JOURNAL));
      overrideAnswers([bad]);
      expect((await refusal(service.disconnect(actor))).code).toBe('CLEANUP_PENDING');
      expect(service.getView().connected).toBe(true);
    });
  });
});

describe('a check record older than the late-create window', () => {
  const stranger = (content: string, type = 'TXT') => ({ id: 'a'.repeat(32), type, name: CHECK_NAME, content });

  it('stays journaled when other records sit at the name and none is ours, and deletes nothing', async () => {
    await connectWithZoneA();
    setJournal(JSON.stringify(OLD_JOURNAL));
    fake.records.set(ZONE_A, [stranger('"someone else"'), { ...stranger('"x"', 'CNAME'), id: 'b'.repeat(32) }]);
    fake.requests = [];
    const view = await service.recheck(actor);
    expect(zoneA(view).cleanupPending).toMatchObject({ recordName: CHECK_NAME });
    expect(zoneA(view).cleanupPending?.note).toContain('Other records sit at that name');
    expect(journal(ZONE_A)).not.toBeNull();
    expect(fake.requests.filter((r) => r.startsWith('DELETE'))).toEqual([]);
    expect(fake.records.get(ZONE_A)).toHaveLength(2);
  });

  it('refuses disconnect for those records, in the recheck path and the disconnect path alike', async () => {
    await connectWithZoneA();
    setJournal(JSON.stringify(OLD_JOURNAL));
    fake.records.set(ZONE_A, [stranger('"someone else"')]);
    const error = await refusal(service.disconnect(actor));
    expect(error.code).toBe('CLEANUP_PENDING');
    expect(error.message).toContain('Other records sit at that name');
    expect(service.getView().connected).toBe(true);
  });

  it('does not run a new DNS check over them', async () => {
    await connectWithZoneA();
    setJournal(JSON.stringify(OLD_JOURNAL));
    fake.records.set(ZONE_A, [stranger('"someone else"')]);
    fake.requests = [];
    const { view, complete } = await service.dnsCheck(ZONE_A, actor);
    expect(complete).toBe(false);
    expect(zoneA(view).cleanupPending).toMatchObject({ recordName: CHECK_NAME });
    expect(fake.requests.filter((r) => r.startsWith('POST'))).toEqual([]);
  });

  it('deletes our record when it is among the others, and clears the journal only for an empty name', async () => {
    await connectWithZoneA();
    setJournal(JSON.stringify(OLD_JOURNAL));
    fake.records.set(ZONE_A, [stranger('"someone else"'), { ...stranger('"sencho-scope-check:00"'), id: 'c'.repeat(32) }]);
    await service.recheck(actor);
    expect(journal(ZONE_A)).toBeNull();
    expect(fake.records.get(ZONE_A)).toEqual([stranger('"someone else"')]);
    setJournal(JSON.stringify(OLD_JOURNAL));
    await service.recheck(actor);
    expect(journal(ZONE_A)).not.toBeNull();
    fake.records.set(ZONE_A, []);
    await service.recheck(actor);
    expect(journal(ZONE_A)).toBeNull();
  });
});

describe('disconnect names the check records it leaves behind', () => {
  it('returns no names after a clean disconnect', async () => {
    await connectWithZoneA();
    expect(await service.disconnect(actor)).toEqual({ leftInCloudflare: [] });
  });

  it('returns the abandoned record name when the zone is out of reach', async () => {
    await leftoverInGoneZone();
    fake.remove = 403;
    expect(await service.disconnect(actor)).toEqual({ leftInCloudflare: [CHECK_NAME] });
  });
});

describe('a recheck that cannot delete a leftover record says why', () => {
  it.each([
    ['a refused delete', { remove: 403 as const }, 'Cloudflare refused the delete'],
    ['an unreachable Cloudflare', { remove: 'down' as const }, 'Could not reach api.cloudflare.com'],
    ['a record that is too recent', { recent: true }, 'still be landing'],
  ])('puts the cause on the pending zone after %s', async (_label, setup, sentence) => {
    await connectWithZoneA();
    if ('recent' in setup) {
      setJournal(JSON.stringify({ ...OLD_JOURNAL, createdAt: Date.now() }));
    } else {
      fake.remove = 500;
      await service.dnsCheck(ZONE_A, actor);
      fake.remove = setup.remove;
    }
    const view = connected(await service.recheck(actor));
    expect(zoneA(view).cleanupPending?.note).toContain(sentence);
    // What a later read of the account shows is the same sentence, since it is kept with the journal.
    expect(zoneA(service.getView()).cleanupPending?.note).toContain(sentence);
    expect(journal(ZONE_A)).not.toBeNull();
  });

  it('uses the sentence disconnect refuses with', async () => {
    await connectWithZoneA();
    fake.remove = 500;
    await service.dnsCheck(ZONE_A, actor);
    fake.remove = 403;
    const note = zoneA(await service.recheck(actor)).cleanupPending?.note;
    expect((await refusal(service.disconnect(actor))).message).toContain(note);
  });

  it('shows no sentence for a check that never failed to clean up, and drops it once the record is gone', async () => {
    await connectWithZoneA();
    fake.remove = 500;
    expect(zoneA((await service.dnsCheck(ZONE_A, actor)).view).cleanupPending?.note).toContain('Could not reach');
    fake.remove = 'ok';
    expect(zoneA(await service.recheck(actor)).cleanupPending).toBeNull();
  });

  it('tells a DNS check that left its record pending the cause too', async () => {
    await connectWithZoneA();
    fake.remove = 403;
    const { view, complete } = await service.dnsCheck(ZONE_A, actor);
    expect(complete).toBe(false);
    expect(zoneA(view).cleanupPending?.note).toContain('Cloudflare refused the delete');
  });

  it('keeps no stale cause after an ambiguous create replaces the journal', async () => {
    await connectWithZoneA();
    setJournal(JSON.stringify({ ...OLD_JOURNAL, recordId: '9'.repeat(32), cause: 'refused' }));
    fake.records.set(ZONE_A, []);
    fake.create = 500;
    // The leftover is cleaned (its delete answers 404), then the new create is ambiguous.
    const { view } = await service.dnsCheck(ZONE_A, actor);
    expect(zoneA(view).cleanupPending?.note ?? null).toBeNull();
  });
});

describe('a journal column that cannot be read', () => {
  it.each([['{'], ['{}'], ['null'], ['""'], ['[]'], ['{"name":"x"}']])('still counts as a pending record: %s', async (column) => {
    await connectWithZoneA();
    setJournal(column);
    expect(zoneA(service.getView()).cleanupPending).toMatchObject({ recordName: CHECK_NAME });
    expect(zoneA(service.getView()).cleanupPending?.note).toContain('cannot read what it kept');
  });

  it('blocks disconnect while records sit at the check name, and recheck does not report the zone clear', async () => {
    await connectWithZoneA();
    setJournal('{');
    fake.records.set(ZONE_A, [{ id: 'a'.repeat(32), type: 'TXT', name: CHECK_NAME, content: '"sencho-scope-check:00"' }]);
    const error = await refusal(service.disconnect(actor));
    expect(error.code).toBe('CLEANUP_PENDING');
    expect(error.message).toContain(CHECK_NAME);
    expect(zoneA(await service.recheck(actor)).cleanupPending).toMatchObject({ recordName: CHECK_NAME });
    expect(journal(ZONE_A)).toBe('{');
    expect(fake.records.get(ZONE_A)).toHaveLength(1);
  });

  it('blocks disconnect while Cloudflare cannot be asked', async () => {
    await connectWithZoneA();
    setJournal('{}');
    fake.dnsRead[ZONE_A] = 'down';
    expect((await refusal(service.disconnect(actor))).code).toBe('CLEANUP_PENDING');
    expect(service.getView().connected).toBe(true);
  });

  it('blocks disconnect when this instance has no identity to rebuild the record name from', async () => {
    await connectWithZoneA();
    setJournal('{');
    vi.spyOn(FleetSyncService, 'getControlIdentity').mockReturnValue('');
    const error = await refusal(service.disconnect(actor));
    expect(error.code).toBe('CLEANUP_PENDING');
    expect(error.message).toContain('Sencho cannot read what it kept');
  });

  it('does not start a DNS check over it', async () => {
    await connectWithZoneA();
    setJournal('{');
    fake.records.set(ZONE_A, [{ id: 'a'.repeat(32), type: 'TXT', name: CHECK_NAME, content: '"x"' }]);
    fake.requests = [];
    const { complete } = await service.dnsCheck(ZONE_A, actor);
    expect(complete).toBe(false);
    expect(fake.requests.filter((r) => r.startsWith('POST'))).toEqual([]);
  });

  it('keeps a zone that left the listing instead of dropping its row', async () => {
    await connectWithZoneA();
    await service.setZone(ZONE_A, false, [], actor);
    setJournal('{');
    fake.records.set(ZONE_A, [{ id: 'a'.repeat(32), type: 'TXT', name: CHECK_NAME, content: '"x"' }]);
    fake.zones = [{ id: ZONE_B, name: 'example.net' }];
    await service.recheck(actor);
    expect(connected(service.getView()).zones.map((z) => z.zoneRef)).toContain(ZONE_A);
    setJournal(null);
    await service.recheck(actor);
    expect(connected(service.getView()).zones.map((z) => z.zoneRef)).not.toContain(ZONE_A);
  });

  it('settles once Cloudflare lists nothing at the name, and logs without the column text', async () => {
    await connectWithZoneA();
    setJournal('{"secret-looking":"cfsentinel_xyz');
    const warn = vi.spyOn(console, 'warn');
    const view = await service.recheck(actor);
    expect(zoneA(view).cleanupPending).toBeNull();
    expect(journal(ZONE_A)).toBeNull();
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('cannot be read');
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).not.toContain('cfsentinel_xyz');
    expect(await service.disconnect(actor)).toEqual({ leftInCloudflare: [] });
  });
});
