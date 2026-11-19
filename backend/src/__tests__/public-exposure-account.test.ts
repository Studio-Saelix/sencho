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
    expect(error.message).toContain("Sencho's own request limit");
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
    const view = await service.dnsCheck(ZONE_A, actor);
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
    const view = await service.dnsCheck(ZONE_A, actor);
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
    const view = await service.dnsCheck(ZONE_A, actor);
    expect(zoneA(view).cleanupPending).toEqual({ recordName: CHECK_NAME });
    expect(fake.records.get(ZONE_A)).toHaveLength(1);

    fake.create = 'ok';
    const after = await service.recheck(actor);
    expect(zoneA(after).cleanupPending).toBeNull();
    expect(fake.records.get(ZONE_A)).toEqual([]);
  });

  it('keeps the journal after a dropped connection on create', async () => {
    await connectWithZoneA();
    fake.create = 'reset';
    expect(zoneA(await service.dnsCheck(ZONE_A, actor)).cleanupPending).toEqual({ recordName: CHECK_NAME });
  });

  it('clears the journal when the interrupted create never landed', async () => {
    await connectWithZoneA();
    db().prepare('UPDATE exposure_zones SET scope_check_pending_json = ? WHERE zone_ref = ?')
      .run(JSON.stringify({ name: CHECK_NAME, content: 'sencho-scope-check:00', recordId: null }), ZONE_A);
    const view = await service.dnsCheck(ZONE_A, actor);
    expect(zoneA(view).dns).toBe('confirmed');
    expect(zoneA(view).cleanupPending).toBeNull();
  });

  it('keeps the journal when the delete fails, and the next check deletes by record id', async () => {
    await connectWithZoneA();
    fake.remove = 500;
    expect(zoneA(await service.dnsCheck(ZONE_A, actor)).cleanupPending).toEqual({ recordName: CHECK_NAME });
    const pending = db().prepare('SELECT scope_check_pending_json AS p FROM exposure_zones WHERE zone_ref = ?').get(ZONE_A) as { p: string };
    expect(JSON.parse(pending.p).recordId).toMatch(/^[0-9a-f]{32}$/);
    fake.remove = 'ok';
    const view = await service.dnsCheck(ZONE_A, actor);
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

