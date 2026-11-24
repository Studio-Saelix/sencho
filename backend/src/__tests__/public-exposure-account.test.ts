/**
 * The public exposure account service and its Cloudflare adapter, against a
 * fake Cloudflare API: every named check state, the account change rule, the
 * DNS write check and its journal, zone reconciliation, the lock, the
 * operation deadline, the audit rows, Cloudflare answers that are successful
 * but unreadable, check records the journal cannot name or does not match, the
 * records a disconnect leaves behind, the cause shown for a leftover record,
 * journals whose timing cannot be read and the late-create window that follows,
 * stored record ids that are not Cloudflare ids, and listings whose paging
 * details contradict each other, on one page or between pages.
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
  landLateCreates,
  makeFakeCloudflare,
  type FakeCloudflare,
} from './helpers/fakeCloudflare';
import type { PublicExposureAccountView } from '../services/publicExposure/types';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let Service: typeof import('../services/publicExposure/PublicExposureAccountService').PublicExposureAccountService;
let PublicExposureError: typeof import('../services/publicExposure/types').PublicExposureError;
let cloudflareApiClient: typeof import('../services/publicExposure/cloudflareApiClient').cloudflareApiClient;
let Adapter: typeof import('../services/publicExposure/cloudflareAccountAdapter').CloudflareAccountAdapter;
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
  ({ CloudflareAccountAdapter: Adapter } = await import('../services/publicExposure/cloudflareAccountAdapter'));
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
      .run(JSON.stringify({ name: CHECK_NAME, content: 'sencho-scope-check:00', recordId: null, createdAt: Date.now() - 10 * 60_000 }), ZONE_A);
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
      .run(JSON.stringify({ name: CHECK_NAME, content: 'x', recordId: null, createdAt: Date.now() - 10 * 60_000 }), ZONE_A);
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
      .run(JSON.stringify({ name: CHECK_NAME, content: 'x', recordId: null, createdAt: Date.now() - 10 * 60_000 }), ZONE_A);
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
    expect(error.message).toContain('still landing');
    expect(zoneA(service.getView()).cleanupPending).toMatchObject({ recordName: CHECK_NAME });
  });

  it('keeps refusing disconnect for a zone that left the account when its record answer cannot be read', async () => {
    await leftoverInGoneZone();
    fake.records.set(ZONE_A, [{ id: 'not-a-cloudflare-id', type: 'TXT', name: CHECK_NAME, content: '"sencho-scope-check:odd"' }]);
    db().prepare('UPDATE exposure_zones SET scope_check_pending_json = ? WHERE zone_ref = ?')
      .run(JSON.stringify({ name: CHECK_NAME, content: 'sencho-scope-check:odd', recordId: null, createdAt: Date.now() - 10 * 60_000 }), ZONE_A);
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

/** Old enough that its create has had every chance to land. */
const LONG_AGO = Date.now() - 24 * 60 * 60_000;
const OLD_JOURNAL = { name: CHECK_NAME, content: 'sencho-scope-check:00', recordId: null, createdAt: LONG_AGO };

/** Move a journal that cleanup re-stamped back in time, as the late-create window passing would. */
function ageJournal(): void {
  setJournal(JSON.stringify({ ...JSON.parse(journal(ZONE_A) as string), createdAt: LONG_AGO }));
}

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
    expect(zoneA(view).cleanupPending?.note).toContain('Other records already sit at that name');
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
    expect(error.message).toContain('Other records already sit at that name');
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
    ['a record that is too recent', { recent: true }, 'still landing'],
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
    // The first empty listing only starts the late-create window.
    expect(zoneA(await service.recheck(actor)).cleanupPending?.note).toContain('still landing');
    ageJournal();
    const view = await service.recheck(actor);
    expect(zoneA(view).cleanupPending).toBeNull();
    expect(journal(ZONE_A)).toBeNull();
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('cannot be read');
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).not.toContain('cfsentinel_xyz');
    expect(await service.disconnect(actor)).toEqual({ leftInCloudflare: [] });
  });
});

describe('journal edges after the audit round', () => {
  it('drops a stale cleanup cause when the token is replaced', async () => {
    await connectWithZoneA();
    fake.remove = 500;
    await service.dnsCheck(ZONE_A, actor);
    fake.remove = 403;
    expect(zoneA(await service.recheck(actor)).cleanupPending?.note).toContain('Cloudflare refused the delete');
    await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor);
    expect(zoneA(service.getView()).cleanupPending).toMatchObject({ recordName: CHECK_NAME, note: null });
    const kept = JSON.parse(journal(ZONE_A) as string) as { recordId: string; cause?: string };
    expect(kept.recordId).toMatch(/^[0-9a-f]{32}$/);
    expect(kept.cause).toBeUndefined();
  });

  it('leaves an unreadable column alone when the token is replaced', async () => {
    await connectWithZoneA();
    setJournal('{');
    await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor);
    expect(journal(ZONE_A)).toBe('{');
  });

  it('counts a zone that is gone from Cloudflare as settled for an unreadable journal', async () => {
    await connectWithZoneA();
    setJournal('{');
    fake.dnsRead[ZONE_A] = 404;
    expect(zoneA(await service.recheck(actor)).cleanupPending).toBeNull();
    expect(journal(ZONE_A)).toBeNull();
  });

  it('lets disconnect through for an unreadable journal in a zone that left the account, and names the record it would have used', async () => {
    await connectWithZoneA();
    setJournal('{');
    fake.dnsRead[ZONE_A] = 403;
    fake.zones = [{ id: ZONE_B, name: 'example.net' }];
    await service.recheck(actor);
    expect(zoneA(service.getView())).toMatchObject({ seenAtLastCheck: false, cleanupPending: { recordName: CHECK_NAME } });
    expect(await service.disconnect(actor)).toEqual({ leftInCloudflare: [CHECK_NAME] });
  });

  it('runs a fresh DNS check once an unreadable journal has been settled', async () => {
    await connectWithZoneA();
    setJournal('{');
    expect((await service.dnsCheck(ZONE_A, actor)).complete).toBe(false);
    ageJournal();
    const { view, complete } = await service.dnsCheck(ZONE_A, actor);
    expect(complete).toBe(true);
    expect(zoneA(view).dns).toBe('confirmed');
    expect(zoneA(view).cleanupPending).toBeNull();
  });

  it('reads an unreadable record list in the zone, where an unreadable column looks, as an unexpected answer', async () => {
    await connectWithZoneA();
    setJournal('{');
    overrideAnswers([{ path: /^\/zones\/[0-9a-f]+\/dns_records$/, query: (url) => url.searchParams.get('name.startswith') === '_sencho-check-', result: [null] }]);
    expect(zoneA(await service.recheck(actor)).cleanupPending?.note).toContain('cannot read what it kept');
    expect(journal(ZONE_A)).toBe('{');
    expect((await refusal(service.disconnect(actor))).message).toContain('could not be deleted');
  });

  it.each([
    ['a null element', [null]],
    ['an element with no id', [{ name: 'Example Account' }]],
  ])('reads an account list with %s on a recheck as unexpected, never as a missing account', async (_label, accounts) => {
    await connectWithZoneA();
    (fake as { accounts: unknown }).accounts = accounts;
    const view = connected(await service.recheck(actor));
    expect(view.lastCheck.outcome).toBe('unexpected_response');
    expect(view.scopes.zoneRead).toBe('confirmed');
  });
});

/** Answer matching requests with this exact body (any shape) and everything else from the fake. */
function overrideRaw(matches: (url: URL, method: string) => boolean, body: unknown, status = 200): void {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (matches(url, init?.method ?? 'GET')) {
      fake.requests.push(`${init?.method ?? 'GET'} ${url.pathname.replace('/client/v4', '')}`);
      return new Response(JSON.stringify(body), { status });
    }
    return answer(fake, url, init ?? {});
  }));
}

const onPath = (path: RegExp, method = 'GET') => (url: URL, m: string) => m === method && path.test(url.pathname.replace('/client/v4', ''));

describe('a Cloudflare answer with unreadable envelope fields reaches every consumer as an unreadable answer', () => {
  const BAD_FIELDS: Array<[string, Record<string, unknown>]> = [
    ['an error list holding null', { errors: [null] }],
    ['a messages field that is an object', { messages: {} }],
    ['a result_info that is text', { result_info: 'x' }],
  ];
  // Each request a check sends: the unreadable fields sit in its otherwise successful answer.
  const REQUESTS: Array<[string, RegExp, unknown]> = [
    ['the user token verify', /^\/user\/tokens\/verify$/, { id: 't', status: 'active' }],
    ['the account listing', /^\/accounts$/, [{ id: FAKE_ACCOUNT_ID, name: 'Example Account' }]],
    ['the zone listing', /^\/zones$/, [{ id: ZONE_A, name: 'example.com' }, { id: ZONE_B, name: 'example.net' }]],
    ['the Tunnel probe', /^\/accounts\/[0-9a-f]+\/cfd_tunnel$/, []],
    ['the DNS probe', /^\/zones\/[0-9a-f]+\/dns_records$/, []],
  ];

  describe.each(REQUESTS)('in %s', (_name, path, result) => {
    it.each(BAD_FIELDS)('records an unexpected answer on recheck and keeps every zone, with %s', async (_label, fields) => {
      await connectWithZoneA();
      const before = connected(service.getView());
      overrideRaw(onPath(path), { success: true, result, ...fields });
      const view = connected(await service.recheck(actor));
      expect(view.lastCheck.outcome).toBe('unexpected_response');
      expect(view.zones.map((z) => z.zoneRef)).toEqual(before.zones.map((z) => z.zoneRef));
      expect(view.zones.map((z) => z.enabled)).toEqual(before.zones.map((z) => z.enabled));
      expect(view.scopes).toEqual(before.scopes);
    });
  });

  // No zone is enabled before the first connect, so a first connect sends no DNS probe.
  describe.each(REQUESTS.filter(([name]) => name !== 'the DNS probe'))('on a first connect, in %s', (_name, path, result) => {
    it.each(BAD_FIELDS)('refuses as unexpected and stores nothing, with %s', async (_label, fields) => {
      overrideRaw(onPath(path), { success: true, result, ...fields });
      expect((await refusal(service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor))).code).toBe('UNEXPECTED_RESPONSE');
      expect(service.getView()).toEqual({ connected: false });
    });
  });

  it('refuses a token replacement as unexpected from an unreadable DNS probe, and keeps the stored token and zones', async () => {
    await connectWithZoneA();
    const stored = db().prepare('SELECT credential_enc FROM exposure_accounts').get() as { credential_enc: string };
    overrideRaw(onPath(/^\/zones\/[0-9a-f]+\/dns_records$/), { success: true, result: [], errors: [null] });
    expect((await refusal(service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor))).code).toBe('UNEXPECTED_RESPONSE');
    expect((db().prepare('SELECT credential_enc FROM exposure_accounts').get() as { credential_enc: string }).credential_enc).toBe(stored.credential_enc);
    expect(connected(service.getView()).zones.map((z) => z.zoneRef)).toEqual([ZONE_A, ZONE_B]);
  });

  it('reads the account-owned token verify the same way', async () => {
    fake.verifyUser = 401;
    fake.verifyAccount = 'active';
    overrideRaw(onPath(/^\/accounts\/[0-9a-f]+\/tokens\/verify$/), { success: true, result: { status: 'active' }, errors: [null] });
    expect((await refusal(service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor))).code).toBe('UNEXPECTED_RESPONSE');
  });

  it('keeps a journal when the answer to a sent create is unreadable, because the record may exist', async () => {
    await connectWithZoneA();
    overrideRaw(onPath(/^\/zones\/[0-9a-f]+\/dns_records$/, 'POST'), { success: true, result: { id: 'f'.repeat(32) }, messages: {} });
    const { complete } = await service.dnsCheck(ZONE_A, actor);
    expect(complete).toBe(false);
    expect(JSON.parse(journal(ZONE_A) as string)).toMatchObject({ name: CHECK_NAME, recordId: null });
    expect(zoneA(service.getView()).cleanupPending).toMatchObject({ recordName: CHECK_NAME });
  });

  it('keeps the record id in the journal when the answer to a sent delete is unreadable', async () => {
    await connectWithZoneA();
    overrideRaw(onPath(/^\/zones\/[0-9a-f]+\/dns_records\/[0-9a-f]+$/, 'DELETE'), { success: true, result: {}, errors: [null] });
    const { complete } = await service.dnsCheck(ZONE_A, actor);
    expect(complete).toBe(false);
    expect(JSON.parse(journal(ZONE_A) as string).recordId).toMatch(/^[0-9a-f]{32}$/);
    expect(zoneA(service.getView()).cleanupPending?.note).toContain('could not read');
  });
});

describe('a listing whose paging details contradict each other is never a complete listing', () => {
  const CONTRADICTION = { page: 1, per_page: 50, count: 1, total_pages: 0, total_count: 2 };

  it('keeps zone B, and every zone seen, when the zone listing holds one zone but reports two', async () => {
    await connectWithZoneA();
    const before = connected(service.getView());
    overrideRaw(onPath(/^\/zones$/), { success: true, result: [{ id: ZONE_A, name: 'example.com' }], result_info: CONTRADICTION });
    const view = connected(await service.recheck(actor));
    expect(view.lastCheck.outcome).toBe('unexpected_response');
    expect(view.zones.map((z) => z.zoneRef)).toEqual([ZONE_A, ZONE_B]);
    expect(view.zonesVisible).toBe(before.zonesVisible);
  });

  it('refuses a connect on it and stores nothing', async () => {
    overrideRaw(onPath(/^\/zones$/), { success: true, result: [{ id: ZONE_A, name: 'example.com' }], result_info: CONTRADICTION });
    expect((await refusal(service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor))).code).toBe('UNEXPECTED_RESPONSE');
    expect(service.getView()).toEqual({ connected: false });
  });

  it('reads an account listing the same way, not as an account that is missing', async () => {
    overrideRaw(onPath(/^\/accounts$/), { success: true, result: [], result_info: { page: 1, per_page: 50, count: 0, total_pages: 1, total_count: 1 } });
    expect((await refusal(service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor))).code).toBe('UNEXPECTED_RESPONSE');
  });

  describe('a record listing at the check name, or in the zone for a column that cannot be read', () => {
    const atName = (url: URL, m: string) => m === 'GET' && /^\/zones\/[0-9a-f]+\/dns_records$/.test(url.pathname.replace('/client/v4', '')) && (url.searchParams.get('name') === CHECK_NAME || url.searchParams.get('name.startswith') === '_sencho-check-');
    // A page that holds nothing while its own paging block counts three records: a listing that contradicts itself, whichever page is asked for.
    const hidesTheRecord = { success: true, result: [], result_info: { page: 1, per_page: 100, count: 3, total_pages: 1, total_count: 3 } };

    it('keeps a stored journal through recheck and refuses disconnect, even for an old one', async () => {
      await connectWithZoneA();
      setJournal(JSON.stringify(OLD_JOURNAL));
      overrideRaw(atName, hidesTheRecord);
      expect(zoneA(await service.recheck(actor)).cleanupPending?.note).toContain('could not read');
      expect(journal(ZONE_A)).not.toBeNull();
      expect((await refusal(service.disconnect(actor))).code).toBe('CLEANUP_PENDING');
      expect(journal(ZONE_A)).not.toBeNull();
    });

    it('keeps an unreadable column as it was', async () => {
      await connectWithZoneA();
      setJournal('{');
      overrideRaw(atName, hidesTheRecord);
      expect(zoneA(await service.recheck(actor)).cleanupPending?.note).toContain('cannot read what it kept');
      expect(journal(ZONE_A)).toBe('{');
    });

    it('does not start a DNS check on it', async () => {
      await connectWithZoneA();
      overrideRaw(atName, hidesTheRecord);
      fake.requests = [];
      await expect(service.dnsCheck(ZONE_A, actor)).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
      expect(fake.requests.filter((r) => r.startsWith('POST'))).toEqual([]);
    });
  });
});

describe('a listing that contradicts what it declared, on one page or between pages, is never a complete listing', () => {
  interface Page { items: unknown[]; info: Record<string, number> | null }
  /** Answer a listing from a script, one scripted page per request; a page past the script is empty with no paging block. */
  function overridePaged(matches: (url: URL, method: string) => boolean, pages: Page[]): void {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (matches(url, init?.method ?? 'GET')) {
        const page = pages[Number(url.searchParams.get('page')) - 1];
        fake.requests.push(`${init?.method ?? 'GET'} ${url.pathname.replace('/client/v4', '')}`);
        return new Response(JSON.stringify({ success: true, errors: [], messages: [], result: page?.items ?? [], ...(page?.info ? { result_info: page.info } : {}) }));
      }
      return answer(fake, url, init ?? {});
    }));
  }

  /** The listing the provider is really serving is `items`; each script contradicts itself or an earlier page. Item three is the one a truncated listing omits. */
  const SCRIPTS: Array<[string, (items: unknown[]) => Page[]]> = [
    ['a total that shrinks on page two while its total_count disappears', (i) => [
      { items: [i[0]], info: { page: 1, per_page: 1, total_pages: 3, total_count: 3 } },
      { items: [i[1]], info: { page: 2, per_page: 1, total_pages: 2 } },
    ]],
    ['a coherent shrink on page two, where total_pages and total_count fall together', (i) => [
      { items: [i[0]], info: { page: 1, per_page: 1, total_pages: 3, total_count: 3 } },
      { items: [i[1]], info: { page: 2, per_page: 1, total_pages: 2, total_count: 2 } },
    ]],
    ['a page size that changes on page two', (i) => [
      { items: [i[0], i[1]], info: { page: 1, per_page: 2, total_pages: 2, total_count: 3 } },
      { items: [i[2]], info: { page: 2, per_page: 3, total_pages: 2, total_count: 3 } },
    ]],
    ['a page two that repeats page one, with counts that add up', (i) => [
      { items: [i[0], i[1]], info: { page: 1, per_page: 2, total_pages: 2, total_count: 4 } },
      { items: [i[0], i[1]], info: { page: 2, per_page: 2, total_pages: 2, total_count: 4 } },
    ]],
    ['more results than the page size it declared', (i) => [
      { items: i, info: { page: 1, per_page: 1, total_pages: 1 } },
    ]],
  ];

  /**
   * Contradictions only a listing without search parameters can show: its totals are exact, so a listing
   * that ends short of its total_count, or ends on an empty page after declaring several, is incomplete.
   * A filtered listing's total_count is only a cap and its declared pages are all read, so the same pages
   * are a search that matched fewer records than the zone holds.
   */
  const UNFILTERED_SCRIPTS: Array<[string, (items: unknown[]) => Page[]]> = [
    ['paging details that vanish on page two', (i) => [
      { items: [i[0]], info: { page: 1, per_page: 1, total_pages: 3, total_count: 3 } },
      { items: [i[1]], info: null },
    ]],
    ['an empty last page of a listing that declares two pages, with no total_count', (i): Page[] => [
      { items: [i[0], i[1]], info: { page: 1, per_page: 2, total_pages: 2 } },
      { items: [], info: { page: 2, per_page: 2, total_pages: 2, count: 0 } },
    ]],
  ];

  const account = (id: string, name: string) => ({ id, name });
  const ACCOUNTS = [account('e5'.repeat(16), 'First'), account('f6'.repeat(16), 'Second'), account(FAKE_ACCOUNT_ID, 'Example Account')];
  // Zone B is last, so a truncated listing drops a zone Sencho holds disabled.
  const ZONES = [{ id: ZONE_A, name: 'example.com' }, { id: 'e5'.repeat(16), name: 'example.org' }, { id: ZONE_B, name: 'example.net' }];
  const FOREIGN = (n: number) => ({ id: `${n}`.repeat(32), type: 'TXT', name: CHECK_NAME, content: `"somebody-else-${n}"` });
  const OURS = { id: 'f'.repeat(32), type: 'TXT', name: CHECK_NAME, content: `"${OLD_JOURNAL.content}"` };
  const RECORDS = [FOREIGN(1), FOREIGN(2), OURS];

  const accountsList = onPath(/^\/accounts$/);
  const zonesList = onPath(/^\/zones$/);
  const recordsAtCheckName = (url: URL, m: string) => onPath(/^\/zones\/[0-9a-f]+\/dns_records$/)(url, m) && (url.searchParams.get('name') === CHECK_NAME || url.searchParams.get('name.startswith') === '_sencho-check-');

  function expectZonesKept(view: PublicExposureAccountView, before: ReturnType<typeof connected>): void {
    const kept = connected(view);
    expect(kept.zones.map((z) => [z.zoneRef, z.enabled])).toEqual(before.zones.map((z) => [z.zoneRef, z.enabled]));
    expect(kept.zonesVisible).toBe(before.zonesVisible);
    expect(kept.scopes).toEqual(before.scopes);
  }

  describe.each([
    ['the account listing', accountsList, ACCOUNTS, [...SCRIPTS, ...UNFILTERED_SCRIPTS]],
    ['the zone listing', zonesList, ZONES, SCRIPTS],
  ])('in %s', (_name, matches, items, scripts) => {
    describe.each(scripts)('with %s', (_label, script) => {
      it('refuses a first connect as an unexpected answer and stores nothing', async () => {
        overridePaged(matches, script(items));
        expect((await refusal(service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor))).code).toBe('UNEXPECTED_RESPONSE');
        expect(service.getView()).toEqual({ connected: false });
      });

      it('refuses a token replacement as unexpected, keeping the stored token and every zone', async () => {
        await connectWithZoneA();
        const before = connected(service.getView());
        const stored = db().prepare('SELECT credential_enc FROM exposure_accounts').get() as { credential_enc: string };
        overridePaged(matches, script(items));
        expect((await refusal(service.connect(`${FAKE_TOKEN}-new`, FAKE_ACCOUNT_ID, actor))).code).toBe('UNEXPECTED_RESPONSE');
        expect((db().prepare('SELECT credential_enc FROM exposure_accounts').get() as { credential_enc: string }).credential_enc).toBe(stored.credential_enc);
        expectZonesKept(service.getView(), before);
      });

      it('records an unexpected answer on recheck and keeps every zone', async () => {
        await connectWithZoneA();
        const before = connected(service.getView());
        overridePaged(matches, script(items));
        const view = await service.recheck(actor);
        expect(connected(view).lastCheck.outcome).toBe('unexpected_response');
        expectZonesKept(view, before);
      });
    });
  });

  describe.each(SCRIPTS)('a record listing at the check name, with %s', (_label, script) => {
    const cleanupNote = () => zoneA(service.getView()).cleanupPending?.note ?? '';

    it('keeps the journal through recheck and says the answer could not be read, not that other records sit there', async () => {
      await connectWithZoneA();
      setJournal(JSON.stringify(OLD_JOURNAL));
      overridePaged(recordsAtCheckName, script(RECORDS));
      await service.recheck(actor);
      expect(JSON.parse(journal(ZONE_A) as string)).toMatchObject(OLD_JOURNAL);
      expect(cleanupNote()).toContain('could not read');
      expect(cleanupNote()).not.toContain('Other records already sit');
    });

    it('keeps the journal through disconnect and refuses it', async () => {
      await connectWithZoneA();
      setJournal(JSON.stringify(OLD_JOURNAL));
      overridePaged(recordsAtCheckName, script(RECORDS));
      const refused = await refusal(service.disconnect(actor));
      expect(refused.code).toBe('CLEANUP_PENDING');
      expect(refused.message).toContain('could not read');
      expect(refused.message).not.toContain('Other records already sit');
      expect(JSON.parse(journal(ZONE_A) as string)).toMatchObject(OLD_JOURNAL);
      expect(service.getView().connected).toBe(true);
    });

    it('keeps the journal through a DNS check, names the cause and sends no create', async () => {
      await connectWithZoneA();
      setJournal(JSON.stringify(OLD_JOURNAL));
      overridePaged(recordsAtCheckName, script(RECORDS));
      fake.requests = [];
      expect((await service.dnsCheck(ZONE_A, actor)).complete).toBe(false);
      expect(JSON.parse(journal(ZONE_A) as string)).toMatchObject(OLD_JOURNAL);
      expect(cleanupNote()).toContain('could not read');
      expect(fake.requests.filter((r) => r.startsWith('POST') || r.startsWith('DELETE'))).toEqual([]);
    });

    it('keeps a journal column that cannot be read through recheck, disconnect and a DNS check', async () => {
      await connectWithZoneA();
      setJournal('{');
      overridePaged(recordsAtCheckName, script(RECORDS));
      await service.recheck(actor);
      expect(journal(ZONE_A)).toBe('{');
      expect((await refusal(service.disconnect(actor))).code).toBe('CLEANUP_PENDING');
      expect(journal(ZONE_A)).toBe('{');
      fake.requests = [];
      expect((await service.dnsCheck(ZONE_A, actor)).complete).toBe(false);
      expect(journal(ZONE_A)).toBe('{');
      expect(fake.requests.filter((r) => r.startsWith('POST') || r.startsWith('DELETE'))).toEqual([]);
    });

    it('sends no create from the preflight listing of a DNS check with no journal', async () => {
      await connectWithZoneA();
      overridePaged(recordsAtCheckName, script(RECORDS));
      fake.requests = [];
      await expect(service.dnsCheck(ZONE_A, actor)).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
      expect(fake.requests.filter((r) => r.startsWith('POST'))).toEqual([]);
    });
  });

  const HONEST = (items: unknown[]): Page[] => [
    { items: [items[0]], info: { page: 1, per_page: 1, total_pages: 3, total_count: 3 } },
    { items: [items[1]], info: null },
    { items: [items[2]], info: { page: 3, total_pages: 3 } },
  ];

  it('still finds its account on page three of an honest listing whose later pages drop details', async () => {
    overridePaged(accountsList, HONEST(ACCOUNTS));
    expect(connected(await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor)).accountName).toBe('Example Account');
  });

  it('still cleans up a check record it finds on page three of an honest listing', async () => {
    await connectWithZoneA();
    setJournal(JSON.stringify(OLD_JOURNAL));
    overridePaged(recordsAtCheckName, HONEST(RECORDS));
    fake.requests = [];
    await service.recheck(actor);
    expect(fake.requests).toContain(`DELETE /zones/${ZONE_A}/dns_records/${OURS.id}`);
    expect(journal(ZONE_A)).toBeNull();
  });

  it('still reads an honest listing whose later pages drop details the first page gave', async () => {
    await connectWithZoneA();
    overridePaged(zonesList, [
      { items: [ZONES[0]], info: { page: 1, per_page: 1, total_pages: 3, total_count: 3 } },
      { items: [ZONES[1]], info: null },
      { items: [ZONES[2]], info: { page: 3, total_pages: 3 } },
    ]);
    const view = connected(await service.recheck(actor));
    expect(view.lastCheck.outcome).toBe('ok');
    expect(view.zonesVisible).toBe(3);
  });
});

describe('a journal whose timing cannot be read is not settled by one empty listing', () => {
  type Caller = 'recheck' | 'disconnect' | 'dnsCheck';
  const CALLERS: Caller[] = ['recheck', 'disconnect', 'dnsCheck'];
  // [label, how the journal is damaged, whether the record's content survives to match a late record]
  const VARIANTS: Array<[string, (p: Record<string, unknown>) => string, boolean]> = [
    ['an unreadable column', () => '{', false],
    ['an empty object', () => '{}', false],
    ['a journal with no createdAt', ({ createdAt: _t, ...rest }) => JSON.stringify(rest), true],
    ['a null createdAt', (p) => JSON.stringify({ ...p, createdAt: null }), true],
    ['a createdAt that is text', (p) => JSON.stringify({ ...p, createdAt: 'yesterday' }), true],
    ['a createdAt of zero', (p) => JSON.stringify({ ...p, createdAt: 0 }), true],
    ['a negative createdAt', (p) => JSON.stringify({ ...p, createdAt: -1 }), true],
    ['a createdAt too large to be a number', (p) => JSON.stringify({ ...p, createdAt: 1 }).replace('"createdAt":1', '"createdAt":1e999'), true],
    ['a createdAt a year ahead', (p) => JSON.stringify({ ...p, createdAt: Date.now() + 365 * 24 * 60 * 60_000 }), true],
  ];

  async function run(caller: Caller): Promise<{ refused: string | null; complete?: boolean }> {
    if (caller === 'recheck') {
      await service.recheck(actor);
      return { refused: null };
    }
    if (caller === 'dnsCheck') return { refused: null, complete: (await service.dnsCheck(ZONE_A, actor)).complete };
    try {
      await service.disconnect(actor);
      return { refused: null };
    } catch (error: unknown) {
      if (error instanceof PublicExposureError) return { refused: error.message };
      throw error;
    }
  }

  /** A DNS check whose create was sent and whose answer was lost; the record has not landed yet. */
  async function sentCreateStillInFlight(): Promise<Record<string, unknown>> {
    await connectWithZoneA();
    fake.create = 'reset-late';
    expect((await service.dnsCheck(ZONE_A, actor)).complete).toBe(false);
    fake.create = 'ok';
    expect(fake.lateCreates).toHaveLength(1);
    return JSON.parse(journal(ZONE_A) as string) as Record<string, unknown>;
  }

  describe.each(VARIANTS)('with %s', (_label, damage, contentSurvives) => {
    it.each(CALLERS)('%s keeps the recovery information until the create can no longer land', async (caller) => {
      const pending = await sentCreateStillInFlight();
      setJournal(damage(pending));

      // One empty listing: nothing is settled, nothing is sent that could create a second record.
      fake.requests = [];
      const first = await run(caller);
      expect(journal(ZONE_A)).not.toBeNull();
      expect(zoneA(service.getView()).cleanupPending).toMatchObject({ recordName: CHECK_NAME });
      expect(fake.requests.filter((r) => r.startsWith('POST'))).toEqual([]);
      if (caller === 'disconnect') expect(first.refused).toContain('still landing');
      if (caller === 'dnsCheck') expect(first.complete).toBe(false);
      expect(service.getView().connected).toBe(true);

      // The original create lands. The record is found again, never forgotten.
      landLateCreates(fake);
      const second = await run(caller);
      if (contentSurvives) {
        expect(fake.records.get(ZONE_A) ?? []).toEqual([]);
        // Found by its content and deleted, and nothing is left to recover.
        if (caller !== 'disconnect') expect(journal(ZONE_A)).toBeNull();
        if (caller === 'dnsCheck') expect(second.complete).toBe(true);
        if (caller === 'disconnect') {
          expect(second.refused).toBeNull();
          expect(service.getView().connected).toBe(false);
        }
      } else {
        // Its content is gone, so it cannot be proven ours: it stays, and so does the handle on it.
        expect(fake.records.get(ZONE_A)).toHaveLength(1);
        expect(journal(ZONE_A)).not.toBeNull();
        // The stamp is only seconds old, so the honest cause is the window, not the stranger.
        if (caller === 'disconnect') expect(second.refused).toContain('still landing');
        // Once the window has passed too, the record is still never deleted, and the cause is the honest one.
        ageJournal();
        const third = await run(caller);
        expect(fake.records.get(ZONE_A)).toHaveLength(1);
        expect(journal(ZONE_A)).not.toBeNull();
        if (caller === 'disconnect') expect(third.refused).toContain('Other records already sit at that name');
        if (caller === 'dnsCheck') expect(third.complete).toBe(false);
        expect(service.getView().connected).toBe(true);
      }
    });
  });

  it('settles an unreadable column once the window has passed with nothing at the name, across a restart', async () => {
    await connectWithZoneA();
    setJournal('{');
    let clock = Date.now();
    const restarted = () => new Service(new Adapter(cloudflareApiClient, () => clock));

    expect(zoneA(await restarted().recheck(actor)).cleanupPending?.note).toContain('still landing');
    const stamped = JSON.parse(journal(ZONE_A) as string) as { createdAt: number; content: string };
    expect(stamped.createdAt).toBe(clock);
    expect(stamped.content).toBe('');

    // A new process a minute later still sees the window running, and does not move its start.
    clock += 60_000;
    expect(zoneA(await restarted().recheck(actor)).cleanupPending).not.toBeNull();
    expect(JSON.parse(journal(ZONE_A) as string).createdAt).toBe(stamped.createdAt);

    clock += 2 * 60_000;
    expect(zoneA(await restarted().recheck(actor)).cleanupPending).toBeNull();
    expect(journal(ZONE_A)).toBeNull();
    expect(await restarted().disconnect(actor)).toEqual({ leftInCloudflare: [] });
  });

  it('settles a journal with no timestamp the same way', async () => {
    await connectWithZoneA();
    setJournal(JSON.stringify({ name: CHECK_NAME, content: 'sencho-scope-check:00', recordId: null }));
    let clock = Date.now();
    const at = () => new Service(new Adapter(cloudflareApiClient, () => clock));
    expect((await at().dnsCheck(ZONE_A, actor)).complete).toBe(false);
    clock += 3 * 60_000;
    const { complete } = await at().dnsCheck(ZONE_A, actor);
    expect(complete).toBe(true);
    expect(journal(ZONE_A)).toBeNull();
  });

  it('keeps a journal with a known old timestamp settling at once, as before', async () => {
    await connectWithZoneA();
    setJournal(JSON.stringify(OLD_JOURNAL));
    expect(zoneA(await service.recheck(actor)).cleanupPending).toBeNull();
    expect(journal(ZONE_A)).toBeNull();
  });
});

describe('a stored record id that is not a Cloudflare id is not used as a delete handle', () => {
  const BAD_IDS = ['bad', '../zones', '..', '%2e%2e', '', 'A'.repeat(32), '9'.repeat(31), `${'9'.repeat(32)}0`, 'nested/id'];

  async function withStoredId(recordId: unknown): Promise<string> {
    await connectWithZoneA();
    const realId = 'c'.repeat(32);
    fake.records.set(ZONE_A, [{ id: realId, type: 'TXT', name: CHECK_NAME, content: '"sencho-scope-check:00"' }]);
    setJournal(JSON.stringify({ ...OLD_JOURNAL, recordId }));
    fake.requests = [];
    return realId;
  }

  function deleted(id: string): boolean {
    return fake.requests.includes(`DELETE /zones/${ZONE_A}/dns_records/${id}`);
  }

  describe.each(BAD_IDS)('with the stored id %s', (bad) => {
    it('recheck finds the record by name and content and deletes it', async () => {
      const realId = await withStoredId(bad);
      await service.recheck(actor);
      expect(deleted(realId)).toBe(true);
      // The one delete that is sent is for the real id: no request carries the stored text as a path, however it normalises.
      expect(fake.requests.filter((r) => r.startsWith('DELETE'))).toEqual([`DELETE /zones/${ZONE_A}/dns_records/${realId}`]);
      expect(fake.records.get(ZONE_A)).toEqual([]);
      expect(journal(ZONE_A)).toBeNull();
    });

    it('disconnect deletes the same record before it lets the account go', async () => {
      const realId = await withStoredId(bad);
      expect(await service.disconnect(actor)).toEqual({ leftInCloudflare: [] });
      expect(deleted(realId)).toBe(true);
      expect(fake.records.get(ZONE_A)).toEqual([]);
    });

    it('a DNS check removes the leftover first, then runs its own check', async () => {
      const realId = await withStoredId(bad);
      const { complete } = await service.dnsCheck(ZONE_A, actor);
      expect(deleted(realId)).toBe(true);
      expect(complete).toBe(true);
      expect(journal(ZONE_A)).toBeNull();
    });
  });

  it('keeps the journal when the record is not there yet and the journal is recent, whatever the stored id', async () => {
    await connectWithZoneA();
    setJournal(JSON.stringify({ ...OLD_JOURNAL, recordId: 'bad', createdAt: Date.now() }));
    await service.recheck(actor);
    expect(journal(ZONE_A)).not.toBeNull();
    expect(fake.requests.some((r) => r.startsWith('DELETE'))).toBe(false);
  });

  it('deletes by a stored valid id even when the record at the name does not match the journal content', async () => {
    await connectWithZoneA();
    fake.records.set(ZONE_A, [{ id: 'd'.repeat(32), type: 'TXT', name: CHECK_NAME, content: '"unrelated"' }]);
    setJournal(JSON.stringify({ ...OLD_JOURNAL, recordId: 'd'.repeat(32) }));
    fake.requests = [];
    await service.recheck(actor);
    expect(deleted('d'.repeat(32))).toBe(true);
    expect(journal(ZONE_A)).toBeNull();
  });

  it('reads a non-text stored id as none', async () => {
    const realId = await withStoredId(42);
    await service.recheck(actor);
    expect(deleted(realId)).toBe(true);
  });

  it('is enforced by the adapter itself, not only by the store', async () => {
    const realId = 'c'.repeat(32);
    fake.records.set(ZONE_A, [{ id: realId, type: 'TXT', name: CHECK_NAME, content: '"sencho-scope-check:00"' }]);
    let current: import('../services/publicExposure/types').PendingScopeCheck | null = { ...OLD_JOURNAL, recordId: '../zones' };
    const result = await new Adapter(cloudflareApiClient).resumeCleanup(FAKE_TOKEN, ZONE_A, { current: () => current, write: (p) => { current = p; } }, {});
    expect(result).toEqual({ cleaned: true });
    expect(fake.requests.filter((r) => r.startsWith('DELETE'))).toEqual([`DELETE /zones/${ZONE_A}/dns_records/${realId}`]);
  });

  it('is dropped by the store when the journal is read', async () => {
    await connectWithZoneA();
    setJournal(JSON.stringify({ ...OLD_JOURNAL, recordId: 'bad' }));
    const { publicExposureStore } = await import('../services/publicExposure/publicExposureStore');
    const { CLOUDFLARE_ADAPTER_ID } = await import('../services/publicExposure/types');
    const account = publicExposureStore.getAccount(CLOUDFLARE_ADAPTER_ID);
    const zone = publicExposureStore.getZone(account!.id, ZONE_A);
    expect(zone?.pending).toMatchObject({ name: CHECK_NAME, recordId: null });
  });
});

describe('the late-create window and its edges', () => {
  const WINDOW = 2 * 60_000;
  const at = (clock: () => number) => new Service(new Adapter(cloudflareApiClient, clock));

  it('keeps a readable journal until the window has fully passed, and not a millisecond longer', async () => {
    await connectWithZoneA();
    const now = Date.now();
    setJournal(JSON.stringify({ ...OLD_JOURNAL, createdAt: now - (WINDOW - 1) }));
    expect(zoneA(await at(() => now).recheck(actor)).cleanupPending?.note).toContain('still landing');
    expect(journal(ZONE_A)).not.toBeNull();
    setJournal(JSON.stringify({ ...OLD_JOURNAL, createdAt: now - WINDOW }));
    expect(zoneA(await at(() => now).recheck(actor)).cleanupPending).toBeNull();
    expect(journal(ZONE_A)).toBeNull();
  });

  it('treats a stamp a minute ahead as a known time (clock skew), and one beyond the window as unknown', async () => {
    await connectWithZoneA();
    const now = Date.now();
    setJournal(JSON.stringify({ ...OLD_JOURNAL, createdAt: now + 60_000 }));
    await at(() => now).recheck(actor);
    expect(JSON.parse(journal(ZONE_A) as string).createdAt).toBe(now + 60_000);
    setJournal(JSON.stringify({ ...OLD_JOURNAL, createdAt: now + WINDOW + 1 }));
    await at(() => now).recheck(actor);
    expect(JSON.parse(journal(ZONE_A) as string).createdAt).toBe(now);
  });

  it('never deletes a stranger\'s empty TXT record under a journal that kept no content', async () => {
    await connectWithZoneA();
    setJournal('{');
    await service.recheck(actor); // stamps the column
    fake.records.set(ZONE_A, [{ id: 'a'.repeat(32), type: 'TXT', name: CHECK_NAME, content: '""' }]);
    ageJournal();
    fake.requests = [];
    const view = await service.recheck(actor);
    expect(fake.requests.filter((r) => r.startsWith('DELETE'))).toEqual([]);
    expect(fake.records.get(ZONE_A)).toHaveLength(1);
    expect(journal(ZONE_A)).not.toBeNull();
    expect(zoneA(view).cleanupPending?.note).toContain('Other records already sit');
  });

  it('leaves a journal with no timestamp untouched while a stranger\'s record sits at the name', async () => {
    await connectWithZoneA();
    const column = JSON.stringify({ name: CHECK_NAME, content: 'sencho-scope-check:00', recordId: null });
    setJournal(column);
    fake.records.set(ZONE_A, [{ id: 'a'.repeat(32), type: 'TXT', name: CHECK_NAME, content: '"someone else"' }]);
    const view = await service.recheck(actor);
    expect(zoneA(view).cleanupPending?.note).toContain('Other records already sit');
    expect(JSON.parse(journal(ZONE_A) as string)).toEqual({ ...JSON.parse(column), recordId: null, createdAt: 0, cause: 'unmatched' });
  });

  describe.each([
    ['an unreadable column', () => '{'],
    ['a readable journal without a timestamp', () => JSON.stringify({ name: CHECK_NAME, content: 'x', recordId: null })],
    ['a recent readable journal', () => JSON.stringify({ name: CHECK_NAME, content: 'x', recordId: null, createdAt: Date.now() })],
  ])('when the zone is gone from Cloudflare, with %s', (_label, column) => {
    it.each(['recheck', 'disconnect', 'dnsCheck'] as const)('%s settles it at once', async (caller) => {
      await connectWithZoneA();
      setJournal(column());
      fake.dnsRead[ZONE_A] = 404;
      if (caller === 'disconnect') {
        expect(await service.disconnect(actor)).toEqual({ leftInCloudflare: [] });
        expect(service.getView()).toEqual({ connected: false });
        return;
      }
      // A zone that is gone took its record with it: the journal is cleared now, with no window to wait out.
      if (caller === 'recheck') await service.recheck(actor);
      else await service.dnsCheck(ZONE_A, actor).catch(() => undefined);
      expect(journal(ZONE_A)).toBeNull();
    });
  });

  it('settles a readable journal across restarts through disconnect, without moving the stamp mid-window', async () => {
    await connectWithZoneA();
    setJournal(JSON.stringify({ name: CHECK_NAME, content: 'sencho-scope-check:00', recordId: null }));
    let clock = Date.now();
    const start = clock;
    expect((await refusal(at(() => clock).disconnect(actor))).message).toContain('still landing');
    clock += 60_000;
    expect((await refusal(at(() => clock).disconnect(actor))).message).toContain('still landing');
    expect(JSON.parse(journal(ZONE_A) as string).createdAt).toBe(start);
    clock += 2 * 60_000;
    expect(await at(() => clock).disconnect(actor)).toEqual({ leftInCloudflare: [] });
  });
});

describe('listings and answers the validation must still accept', () => {
  it('reads a recheck whose listings report a smaller page size than asked, as long as they add up', async () => {
    await connectWithZoneA();
    const zones = Array.from({ length: 45 }, (_v, i) => ({ id: i.toString(16).padStart(32, 'a'), name: `z${i}.example.org` }));
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/zones') && (init?.method ?? 'GET') === 'GET') {
        const page = Number(url.searchParams.get('page'));
        return new Response(JSON.stringify({ success: true, result: zones.slice((page - 1) * 20, page * 20), result_info: { page, per_page: 20, total_pages: 3, total_count: 45, count: Math.min(20, 45 - (page - 1) * 20) } }));
      }
      return answer(fake, url, init ?? {});
    }));
    const view = connected(await service.recheck(actor));
    expect(view.lastCheck.outcome).toBe('ok');
    expect(view.zonesVisible).toBe(45);
  });
});
