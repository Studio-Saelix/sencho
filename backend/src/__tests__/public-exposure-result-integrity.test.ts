/**
 * What the Cloudflare account does with answers Cloudflare marks successful.
 * A successful answer can carry the credential back (in a status, a date, an
 * account or zone name, a record type), can be unreadable where a permission
 * probe expects a list, or can arrive in pieces whose later page is refused.
 * Each of those must leave the stored facts, the journals and every outward
 * surface (responses, plaintext columns, audit rows, logs) as they were, and
 * must never read as a missing permission, a vanished zone or a record that
 * is gone. Journals whose description is damaged keep the record id, and a
 * zone's listing membership is its own identity, not the clock.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import {
  FAKE_ACCOUNT_ID,
  FAKE_TOKEN,
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
const OLD_NAME = `_sencho-check-0ld1d3nt1ty.example.com`;
const OTHER_ZONE_NAME = `_sencho-check-${CONTROL_ID}.example.net`;
const RECORD_ID = 'c'.repeat(32);
const CONTENT = 'sencho-scope-check:0011223344556677';

let fake: FakeCloudflare;
let service: InstanceType<typeof Service>;
let logged: string[];

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

const db = () => DatabaseService.getInstance().getDb();

function zoneA(view: PublicExposureAccountView) {
  const zone = connected(view).zones.find((z) => z.zoneRef === ZONE_A);
  if (!zone) throw new Error('zone A missing');
  return zone;
}

async function connectWithZoneA(): Promise<void> {
  await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor);
  await service.setZone(ZONE_A, true, [], actor);
}

function journal(zone = ZONE_A): string | null {
  return (db().prepare('SELECT scope_check_pending_json AS j FROM exposure_zones WHERE zone_ref = ?').get(zone) as { j: string | null }).j;
}

function setJournal(value: unknown, zone = ZONE_A): void {
  db().prepare('UPDATE exposure_zones SET scope_check_pending_json = ? WHERE zone_ref = ?').run(value === null ? null : typeof value === 'string' ? value : JSON.stringify(value), zone);
}

/** A journal old enough that its late-create window has passed. */
const AGED = Date.now() - 10 * 60_000;

// ---------------------------------------------------------------------------
// Answering requests from a script
// ---------------------------------------------------------------------------

interface Reply { status?: number; body: unknown }
interface Rule { match: (url: URL, method: string) => boolean; reply: (url: URL) => Reply | undefined }
let requested: string[];

const pathOf = (url: URL) => url.pathname.replace('/client/v4', '');
const on = (path: RegExp, method = 'GET', query?: (url: URL) => boolean) => (url: URL, m: string) => m === method && path.test(pathOf(url)) && (query ? query(url) : true);
const atCheckName = (name = CHECK_NAME) => on(/^\/zones\/[0-9a-f]+\/dns_records$/, 'GET', (url) => url.searchParams.get('name') === name);

const success = (result: unknown, info?: Record<string, number>): Reply => ({ body: { success: true, errors: [], messages: [], result, ...(info ? { result_info: info } : {}) } });
const refused = (status: number, code = 10000, message = 'refused'): Reply => ({ status, body: { success: false, errors: [{ code, message }], messages: [], result: null } });

function intercept(...rules: Rule[]): void {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    requested.push(`${method} ${pathOf(url)}${url.search}`);
    for (const rule of rules) {
      if (!rule.match(url, method)) continue;
      const reply = rule.reply(url);
      if (reply) {
        fake.requests.push(`${method} ${pathOf(url)}`);
        return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
      }
    }
    return answer(fake, url, init ?? {});
  }));
}

/** Answer each page of a request from the script, in order; a page past it is an empty one. */
function pages(match: Rule['match'], script: Reply[]): Rule {
  return { match, reply: (url) => script[Number(url.searchParams.get('page') ?? '1') - 1] ?? success([], { page: 1, per_page: 50, count: 0, total_pages: 1, total_count: 0 }) };
}

const once = (match: Rule['match'], reply: Reply): Rule => ({ match, reply: () => reply });

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
  db().exec('DELETE FROM exposure_zones; DELETE FROM exposure_accounts; DELETE FROM exposure_node_endpoints; DELETE FROM audit_log;');
  cloudflareApiClient.resetBudgetForTests();
  fake = makeFakeCloudflare();
  installFakeCloudflare(fake);
  requested = [];
  logged = [];
  vi.spyOn(FleetSyncService, 'getControlIdentity').mockReturnValue(CONTROL_ID);
  vi.spyOn(Math, 'random').mockReturnValue(0);
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  }
  service = new Service();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// B3: a successful answer that carries the credential
// ---------------------------------------------------------------------------

describe('a successful Cloudflare answer that carries the credential', () => {
  const ECHOES = [['as sent', FAKE_TOKEN], ['in lower case', FAKE_TOKEN.toLowerCase()]] as const;

  /** Every place the credential must never reach, read after an action. */
  function leaks(): string[] {
    DatabaseService.getInstance().flushAuditLogBuffer();
    const surfaces = {
      view: service.getView(),
      enabled: service.listEnabledZones(),
      accounts: db().prepare('SELECT adapter_id, config_json, scopes_json, last_check_json, created_by FROM exposure_accounts').all(),
      zones: db().prepare('SELECT * FROM exposure_zones').all(),
      audit: db().prepare('SELECT summary, path FROM audit_log').all(),
      logs: logged,
    };
    const haystack = JSON.stringify(surfaces).toLowerCase();
    return haystack.includes(FAKE_TOKEN.toLowerCase()) ? ['a surface holds the token'] : [];
  }

  const userVerify = (result: unknown) => once(on(/^\/user\/tokens\/verify$/), success(result));
  const accountVerify = (result: unknown) => once(on(/^\/accounts\/[0-9a-f]+\/tokens\/verify$/), success(result));

  type Action = 'connect' | 'replace' | 'recheck';
  const ACTIONS: Action[] = ['connect', 'replace', 'recheck'];

  describe.each(ECHOES)('echoed %s', (_how, echo) => {
    describe.each(ACTIONS)('on %s', (action) => {
      it.each([
        ['the status of the user verification', () => [userVerify({ id: 't', status: echo })]],
        ['the expiry of a disabled token on the user verification', () => [userVerify({ id: 't', status: 'disabled', expires_on: echo })]],
        ['the status of the account verification', () => { fake.verifyUser = 401; return [accountVerify({ id: 't', status: echo })]; }],
        ['the expiry of an expired token on the account verification', () => { fake.verifyUser = 401; return [accountVerify({ id: 't', status: 'expired', expires_on: `${echo}` })]; }],
        ['the expiry of an active token', () => [userVerify({ id: 't', status: 'active', expires_on: echo })]],
      ])('keeps it out of every surface when it is %s', async (_label, rules) => {
        if (action !== 'connect') await connectWithZoneA();
        // The account-endpoint rules flip the fake's user verification, so they are built after the setup above.
        intercept(...rules());
        let message = '';
        try {
          if (action === 'recheck') await service.recheck(actor);
          else await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor);
        } catch (error: unknown) {
          message = (error as Error).message;
        }
        expect(message.toLowerCase()).not.toContain(FAKE_TOKEN.toLowerCase());
        expect(leaks()).toEqual([]);
      });
    });

    it.each(ACTIONS)('refuses an account name that is the credential, on %s, and keeps what was stored', async (action) => {
      if (action !== 'connect') await connectWithZoneA();
      const before = action === 'connect' ? null : db().prepare('SELECT credential_enc, config_json, scopes_json, last_check_json FROM exposure_accounts').get();
      intercept(once(on(/^\/accounts$/), success([{ id: FAKE_ACCOUNT_ID, name: `Team ${echo}` }], { page: 1, per_page: 50, count: 1, total_pages: 1, total_count: 1 })));
      let message = '';
      try {
        if (action === 'recheck') await service.recheck(actor);
        else await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor);
      } catch (error: unknown) {
        message = (error as Error).message;
      }
      expect(message.toLowerCase()).not.toContain(FAKE_TOKEN.toLowerCase());
      expect(leaks()).toEqual([]);
      if (action === 'connect') {
        expect(service.getView()).toEqual({ connected: false });
      } else if (action === 'replace') {
        const after = db().prepare('SELECT credential_enc, config_json, scopes_json FROM exposure_accounts').get() as Record<string, unknown>;
        expect(after).toMatchObject({ credential_enc: (before as Record<string, unknown>).credential_enc, config_json: (before as Record<string, unknown>).config_json });
      } else {
        expect(connected(service.getView()).lastCheck.outcome).toBe('unexpected_response');
        expect(connected(service.getView()).accountName).toBe('Example Account');
      }
    });

    it.each(ACTIONS)('refuses a zone name that is the credential, on %s, and keeps every stored zone', async (action) => {
      if (action !== 'connect') await connectWithZoneA();
      const zonesBefore = JSON.stringify(db().prepare('SELECT * FROM exposure_zones ORDER BY zone_ref').all());
      intercept(once(on(/^\/zones$/), success([{ id: ZONE_A, name: 'example.com' }, { id: ZONE_B, name: `${echo}.example.net` }], { page: 1, per_page: 50, count: 2, total_pages: 1, total_count: 2 })));
      let message = '';
      try {
        if (action === 'recheck') await service.recheck(actor);
        else await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor);
      } catch (error: unknown) {
        message = (error as Error).message;
      }
      expect(message.toLowerCase()).not.toContain(FAKE_TOKEN.toLowerCase());
      expect(leaks()).toEqual([]);
      expect(JSON.stringify(db().prepare('SELECT * FROM exposure_zones ORDER BY zone_ref').all())).toBe(action === 'connect' ? '[]' : zonesBefore);
      expect(service.listEnabledZones().map((z) => z.zoneRef)).toEqual(action === 'connect' ? [] : [ZONE_A]);
    });

    it('keeps a record type that is the credential out of the conflict error, the audit row and the logs', async () => {
      await connectWithZoneA();
      fake.records.set(ZONE_A, [{ id: RECORD_ID, type: echo, name: CHECK_NAME, content: 'x' }]);
      const error = await refusal(service.dnsCheck(ZONE_A, actor));
      expect(error.code).toBe('SCOPE_CHECK_CONFLICT');
      expect(error.message).toContain('A unknown record');
      expect(error.message.toLowerCase()).not.toContain(FAKE_TOKEN.toLowerCase());
      expect(leaks()).toEqual([]);
    });
  });

  it('shows a real expiry date and an ordinary record type, so the containment drops nothing it should keep', async () => {
    intercept(userVerify({ id: 't', status: 'disabled', expires_on: '2026-01-01T00:00:00Z' }));
    expect((await refusal(service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor))).message).toContain('2026-01-01T00:00:00Z');
    intercept(userVerify({ id: 't', status: 'expired', expires_on: 'next tuesday' }));
    const error = await refusal(service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor));
    expect(error.code).toBe('TOKEN_INACTIVE');
    expect(error.message).not.toContain('next tuesday');
    vi.unstubAllGlobals();
    installFakeCloudflare(fake);
    await connectWithZoneA();
    fake.records.set(ZONE_A, [{ id: RECORD_ID, type: 'CNAME', name: CHECK_NAME, content: 'x' }]);
    expect((await refusal(service.dnsCheck(ZONE_A, actor))).message).toContain('A CNAME record');
  });
});

// ---------------------------------------------------------------------------
// S3: a successful answer Sencho cannot read
// ---------------------------------------------------------------------------

describe('a successful answer that does not hold what a probe reads', () => {
  const MISSING = Symbol('missing');
  const BAD_LISTS: Array<[string, unknown]> = [
    ['no result', MISSING], ['a null result', null], ['a number', 5], ['a string', 'ok'], ['an object', {}], ['a list of numbers', [1]], ['a list with a null', [null]], ['a list of strings', ['x']],
  ];
  const body = (result: unknown): Reply => ({ body: { success: true, errors: [], messages: [], ...(result === MISSING ? {} : { result }), result_info: { page: 1, per_page: 1, count: 0, total_pages: 1, total_count: 0 } } });
  const tunnelRead = on(/^\/accounts\/[0-9a-f]+\/cfd_tunnel$/);
  const dnsRead = (url: URL, m: string) => on(/^\/zones\/[0-9a-f]+\/dns_records$/)(url, m) && url.searchParams.get('name') === null;

  describe.each([['the Tunnel read', tunnelRead, false], ['the DNS read of an enabled zone', dnsRead, true]])('in %s', (_probe, match, needsEnabledZone) => {
    describe.each(BAD_LISTS)('answered with %s', (_label, result) => {
      if (!needsEnabledZone) {
        it('refuses a first connect and stores nothing', async () => {
          intercept(once(match, body(result)));
          expect((await refusal(service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor))).code).toBe('UNEXPECTED_RESPONSE');
          expect(service.getView()).toEqual({ connected: false });
        });
      }

      it('refuses a token replacement, keeping the token, the facts and the verification time', async () => {
        await connectWithZoneA();
        const before = db().prepare('SELECT credential_enc, config_json, scopes_json, verified_at FROM exposure_accounts').get();
        const zonesBefore = JSON.stringify(db().prepare('SELECT * FROM exposure_zones ORDER BY zone_ref').all());
        intercept(once(match, body(result)));
        expect((await refusal(service.connect(`${FAKE_TOKEN}-new`, FAKE_ACCOUNT_ID, actor))).code).toBe('UNEXPECTED_RESPONSE');
        expect(db().prepare('SELECT credential_enc, config_json, scopes_json, verified_at FROM exposure_accounts').get()).toEqual(before);
        expect(JSON.stringify(db().prepare('SELECT * FROM exposure_zones ORDER BY zone_ref').all())).toBe(zonesBefore);
      });

      it('records an unexpected answer on recheck, keeping the facts and the verification time', async () => {
        await connectWithZoneA();
        const before = connected(service.getView());
        intercept(once(match, body(result)));
        const view = connected(await service.recheck(actor));
        expect(view.lastCheck.outcome).toBe('unexpected_response');
        expect(view.scopes).toEqual(before.scopes);
        expect(view.verifiedAt).toBe(before.verifiedAt);
        expect(zoneA(view).dns).toBe(zoneA(before as PublicExposureAccountView).dns);
      });
    });

    it('still reads a list, empty or not, as a granted permission', async () => {
      await connectWithZoneA();
      intercept(once(match, body([])));
      expect(connected(await service.recheck(actor)).lastCheck.outcome).toBe('ok');
      intercept(once(match, body([{ id: 'x' }])));
      expect(connected(await service.recheck(actor)).lastCheck.outcome).toBe('ok');
    });
  });

  const STATUSES: Array<[string, unknown]> = [['an empty status', ''], ['an unknown status', 'pending'], ['a differently cased status', 'ACTIVE'], ['a null status', null], ['a numeric status', 1], ['no status', undefined]];
  const endpoints: Array<[string, (result: unknown) => Rule[]]> = [
    ['the user verification', (result) => [once(on(/^\/user\/tokens\/verify$/), success(result))]],
    ['the account verification', (result) => { fake.verifyUser = 401; return [once(on(/^\/accounts\/[0-9a-f]+\/tokens\/verify$/), success(result))]; }],
  ];
  describe.each(endpoints)('on %s', (_endpoint, rules) => {
    describe.each(STATUSES)('answered with %s', (_label, status) => {
      it('refuses connect, replace and recheck as an unexpected answer, never as an inactive token', async () => {
        intercept(...rules({ id: 't', status }));
        expect((await refusal(service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor))).code).toBe('UNEXPECTED_RESPONSE');
        vi.unstubAllGlobals();
        installFakeCloudflare(fake);
        fake.verifyUser = 'active';
        await connectWithZoneA();
        const before = db().prepare('SELECT credential_enc, scopes_json, verified_at FROM exposure_accounts').get();
        intercept(...rules({ id: 't', status }));
        expect((await refusal(service.connect(`${FAKE_TOKEN}-new`, FAKE_ACCOUNT_ID, actor))).code).toBe('UNEXPECTED_RESPONSE');
        const view = connected(await service.recheck(actor));
        expect(view.lastCheck.outcome).toBe('unexpected_response');
        expect(db().prepare('SELECT credential_enc, scopes_json, verified_at FROM exposure_accounts').get()).toEqual(before);
      });
    });

    it.each([['disabled'], ['expired']])('still reads %s as an inactive token', async (status) => {
      intercept(...rules({ id: 't', status }));
      expect((await refusal(service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor))).code).toBe('TOKEN_INACTIVE');
    });

    it('still accepts an active token whose other fields are of an unknown kind', async () => {
      intercept(...rules({ id: 't', status: 'active', expires_on: 5, not_before: {} }));
      expect(connected(await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor)).lastCheck.outcome).toBe('ok');
    });
  });
});

// ---------------------------------------------------------------------------
// B1: a refusal that arrives after the first page of a listing
// ---------------------------------------------------------------------------

describe('a listing refused after its first page', () => {
  const PAGE_ONE = (items: unknown[]) => success(items, { page: 1, per_page: 1, count: items.length, total_pages: 2, total_count: 2 });
  const CONTINUATIONS: Array<[string, Reply]> = [
    ['a 404', refused(404, 7000, 'not found')],
    ['a 403', refused(403, 10000, 'forbidden')],
    ['a 400 that names an unknown account', refused(400, 70503, "account with given Tag doesn't exist")],
  ];

  const OURS = { id: RECORD_ID, type: 'TXT', name: CHECK_NAME, content: `"${CONTENT}"` };
  const aJournal = (extra: object = {}) => ({ name: CHECK_NAME, content: CONTENT, recordId: null, createdAt: AGED, ...extra });

  describe.each(CONTINUATIONS)('by %s', (_label, second) => {
    const recordsRule = () => pages(atCheckName(), [PAGE_ONE([OURS]), second]);

    describe.each([['a readable journal', () => aJournal()], ['a journal column that cannot be read', () => '{']])('with %s', (_journal, make) => {
      it('keeps the journal through a recheck, and the zone and facts with it', async () => {
        await connectWithZoneA();
        setJournal(make());
        intercept(recordsRule());
        const view = connected(await service.recheck(actor));
        if (typeof make() === 'string') expect(journal()).toBe('{');
        else expect(JSON.parse(journal() as string)).toMatchObject({ name: CHECK_NAME, content: CONTENT, createdAt: AGED });
        expect(zoneA(view).cleanupPending).not.toBeNull();
        expect(view.zones.map((z) => z.zoneRef)).toContain(ZONE_A);
        expect(fake.requests.filter((r) => r.startsWith('DELETE'))).toEqual([]);
      });

      it('refuses disconnect instead of resolving with nothing left behind', async () => {
        await connectWithZoneA();
        setJournal(make());
        intercept(recordsRule());
        expect((await refusal(service.disconnect(actor))).code).toBe('CLEANUP_PENDING');
        expect(service.getView().connected).toBe(true);
        expect(journal()).not.toBeNull();
      });

      it('does not let the refusal abandon a record in a zone an older listing no longer showed', async () => {
        await connectWithZoneA();
        fake.zones = [{ id: ZONE_B, name: 'example.net' }];
        await service.recheck(actor);
        expect(zoneA(service.getView()).seenAtLastCheck).toBe(false);
        // The journal arrives after the listing that dropped the zone, so the continuation refusal is what decides it.
        setJournal(make());
        intercept(recordsRule());
        expect((await refusal(service.disconnect(actor))).code).toBe('CLEANUP_PENDING');
        expect(service.getView().connected).toBe(true);
        expect(journal()).not.toBeNull();
      });

      it('keeps the journal through a DNS check and sends no create', async () => {
        await connectWithZoneA();
        setJournal(make());
        intercept(recordsRule());
        expect((await service.dnsCheck(ZONE_A, actor)).complete).toBe(false);
        expect(journal()).not.toBeNull();
        expect(requested.filter((r) => r.startsWith('POST'))).toEqual([]);
      });
    });

    it('does not read the refusal as missing DNS permission in the DNS check preflight', async () => {
      await connectWithZoneA();
      intercept(recordsRule());
      const error = await refusal(service.dnsCheck(ZONE_A, actor));
      expect(error.code).toBe('UNEXPECTED_RESPONSE');
      expect(zoneA(service.getView()).dns).not.toBe('missing');
      expect(requested.filter((r) => r.startsWith('POST'))).toEqual([]);
    });

    it('reads a refused zone listing as an unreadable answer: no zone read facts change, no zone leaves', async () => {
      await connectWithZoneA();
      const before = connected(service.getView());
      intercept(pages(on(/^\/zones$/), [PAGE_ONE([{ id: ZONE_A, name: 'example.com' }]), second]));
      const view = connected(await service.recheck(actor));
      expect(view.lastCheck.outcome).toBe('unexpected_response');
      expect(view.scopes).toEqual(before.scopes);
      expect(view.zones.map((z) => z.zoneRef)).toEqual(before.zones.map((z) => z.zoneRef));
      expect(view.zonesVisible).toBe(before.zonesVisible);
    });

    it('refuses a first connect whose zone listing is refused on page two, and stores nothing', async () => {
      intercept(pages(on(/^\/zones$/), [PAGE_ONE([{ id: ZONE_A, name: 'example.com' }]), second]));
      expect((await refusal(service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor))).code).toBe('UNEXPECTED_RESPONSE');
      expect(service.getView()).toEqual({ connected: false });
    });

    it('reads a refused account listing as an unreadable answer, not as an account the token cannot see', async () => {
      intercept(pages(on(/^\/accounts$/), [PAGE_ONE([{ id: 'e5'.repeat(16), name: 'First' }]), second]));
      expect((await refusal(service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor))).code).toBe('UNEXPECTED_RESPONSE');
      expect(service.getView()).toEqual({ connected: false });
    });

    it('records a refused account listing on recheck as unexpected, keeping the scopes', async () => {
      await connectWithZoneA();
      const before = connected(service.getView());
      intercept(pages(on(/^\/accounts$/), [PAGE_ONE([{ id: 'e5'.repeat(16), name: 'First' }]), second]));
      const view = connected(await service.recheck(actor));
      expect(view.lastCheck.outcome).toBe('unexpected_response');
      expect(view.scopes).toEqual(before.scopes);
    });
  });

  describe('the controls', () => {
    it('settles a journal when the zone itself answers 404 on the first page', async () => {
      await connectWithZoneA();
      setJournal(aJournal());
      fake.dnsRead[ZONE_A] = 404;
      expect(zoneA(await service.recheck(actor)).cleanupPending).toBeNull();
      expect(journal()).toBeNull();
    });

    it('still reads a first-page 403 on the zone listing as a missing zone read, and on a record listing as missing DNS write', async () => {
      await connectWithZoneA();
      fake.zones = 403;
      expect(connected(await service.recheck(actor)).scopes.zoneRead).toBe('missing');
      fake.zones = [{ id: ZONE_A, name: 'example.com' }];
      fake.dnsRead[ZONE_A] = 403;
      expect((await service.dnsCheck(ZONE_A, actor)).complete).toBe(true);
      expect(zoneA(service.getView()).dns).toBe('missing');
    });

    it('treats a DELETE that answers 404 as the record being gone', async () => {
      await connectWithZoneA();
      setJournal(aJournal({ recordId: RECORD_ID }));
      expect(zoneA(await service.recheck(actor)).cleanupPending).toBeNull();
      expect(journal()).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// B2: a journal whose description is damaged
// ---------------------------------------------------------------------------

describe('a journal whose description is damaged', () => {
  const DAMAGED_NAMES: Array<[string, unknown]> = [
    ['no name', undefined], ['a null name', null], ['a numeric name', 42], ['a boolean name', true], ['a list name', ['x']], ['an object name', { a: 1 }],
    ['a blank name', ''], ['a malformed name', 'not a name'], ['the name of another zone', OTHER_ZONE_NAME],
  ];
  const DAMAGED_CONTENTS: Array<[string, unknown]> = [
    ['no content', undefined], ['null content', null], ['numeric content', 7], ['list content', ['x']], ['object content', { a: 1 }],
  ];
  const NAMES: Array<[string, unknown]> = [['an intact name', CHECK_NAME], ...DAMAGED_NAMES];
  const CONTENTS: Array<[string, unknown]> = [['intact content', CONTENT], ...DAMAGED_CONTENTS];

  const mk = (name: unknown, content: unknown, recordId: unknown): string => JSON.stringify({ name, content, recordId, createdAt: AGED });
  const hasRecord = (id: string) => (fake.records.get(ZONE_A) ?? []).some((r) => r.id === id);
  const seed = () => fake.records.set(ZONE_A, [{ id: RECORD_ID, type: 'TXT', name: CHECK_NAME, content: `"${CONTENT}"` }]);

  type Caller = 'recheck' | 'disconnect' | 'dnsCheck';
  const CALLERS: Caller[] = ['recheck', 'disconnect', 'dnsCheck'];
  async function run(caller: Caller): Promise<void> {
    if (caller === 'recheck') await service.recheck(actor);
    else if (caller === 'disconnect') await service.disconnect(actor).catch((error: unknown) => { if (!(error instanceof PublicExposureError)) throw error; });
    else await service.dnsCheck(ZONE_A, actor).catch((error: unknown) => { if (!(error instanceof PublicExposureError)) throw error; });
  }

  describe.each(CALLERS)('through %s', (caller) => {
    describe.each(NAMES)('with %s', (_n, name) => {
      describe.each(CONTENTS)('and %s', (_c, content) => {
        it('deletes the record by its stored id and clears the journal', async () => {
          await connectWithZoneA();
          seed();
          setJournal(mk(name, content, RECORD_ID));
          await run(caller);
          expect(hasRecord(RECORD_ID)).toBe(false);
          expect(fake.requests).toContain(`DELETE /zones/${ZONE_A}/dns_records/${RECORD_ID}`);
          if (caller === 'recheck') expect(journal()).toBeNull();
          if (caller === 'disconnect') expect(service.getView()).toEqual({ connected: false });
        });
      });
    });
  });

  describe.each(CALLERS)('with no usable id, through %s', (caller) => {
    describe.each([['no id', undefined], ['a malformed id', '../zones']])('and %s', (_i, recordId) => {
      it.each(DAMAGED_NAMES)('does not trust %s: it never settles the journal from a lookup there, and never deletes by content', async (_label, name) => {
        await connectWithZoneA();
        // The record is where this instance would have put it; the journal's own name points nowhere useful.
        seed();
        setJournal(mk(name, CONTENT, recordId));
        await run(caller);
        expect(journal()).not.toBeNull();
        expect(hasRecord(RECORD_ID)).toBe(true);
        expect(fake.requests.filter((r) => r.startsWith('DELETE'))).toEqual([]);
        const asked = requested.concat(fake.requests);
        expect(asked.some((r) => /name=(not|_sencho-check-0123456789abcdef\.example\.net)/.test(decodeURIComponent(r)))).toBe(false);
      });

      it('does not clear an aged journal on an empty lookup at a wrong name while the record exists at the right one', async () => {
        await connectWithZoneA();
        seed();
        setJournal(mk(OTHER_ZONE_NAME, CONTENT, recordId));
        for (let i = 0; i < 3; i += 1) await run(caller);
        expect(journal()).not.toBeNull();
        expect(hasRecord(RECORD_ID)).toBe(true);
      });

      it.each(DAMAGED_CONTENTS)('with %s, looks at the journal\'s own name when it is a check name in this zone, and keeps the journal while a record sits there', async (_label, content) => {
        await connectWithZoneA();
        fake.records.set(ZONE_A, [{ id: RECORD_ID, type: 'TXT', name: OLD_NAME, content: `"${CONTENT}"` }]);
        setJournal(mk(OLD_NAME, content, recordId));
        intercept();
        await run(caller);
        expect(journal()).not.toBeNull();
        expect(hasRecord(RECORD_ID)).toBe(true);
        if (caller !== 'dnsCheck') expect(requested.some((r) => decodeURIComponent(r).includes(`name=${OLD_NAME}`))).toBe(true);
      });
    });

    it('still deletes by exact match through a malformed id when name and content are intact', async () => {
      await connectWithZoneA();
      seed();
      setJournal(mk(CHECK_NAME, CONTENT, 'bad'));
      await run(caller);
      expect(hasRecord(RECORD_ID)).toBe(false);
    });

    it('still deletes through a historical check name that is a name in this zone', async () => {
      await connectWithZoneA();
      fake.records.set(ZONE_A, [{ id: RECORD_ID, type: 'TXT', name: OLD_NAME, content: `"${CONTENT}"` }]);
      setJournal(mk(OLD_NAME, CONTENT, null));
      await run(caller);
      expect(hasRecord(RECORD_ID)).toBe(false);
    });
  });

  it('keeps the stored id in the journal it rewrites after a refused delete, and deletes by it once the token may', async () => {
    await connectWithZoneA();
    seed();
    setJournal(mk(null, 7, RECORD_ID));
    fake.remove = 500;
    const view = connected(await service.recheck(actor));
    expect(zoneA(view).cleanupPending).toMatchObject({ recordName: CHECK_NAME });
    expect(JSON.parse(journal() as string)).toMatchObject({ recordId: RECORD_ID });
    fake.remove = 'ok';
    expect(zoneA(await service.recheck(actor)).cleanupPending).toBeNull();
    expect(hasRecord(RECORD_ID)).toBe(false);
  });

  it('keeps the stored id through a token replacement', async () => {
    await connectWithZoneA();
    seed();
    setJournal(mk(null, null, RECORD_ID));
    await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor);
    expect(JSON.parse(journal() as string)).toMatchObject({ recordId: RECORD_ID });
    expect(zoneA(service.getView()).cleanupPending).toMatchObject({ recordName: CHECK_NAME });
  });

  it('names the record in a refused disconnect and in the left-behind list even when the journal lost its name', async () => {
    await connectWithZoneA();
    seed();
    setJournal(mk(['x'], 7, RECORD_ID));
    fake.remove = 500;
    expect((await refusal(service.disconnect(actor))).message).toContain(CHECK_NAME);
    fake.remove = 403;
    fake.zones = [{ id: ZONE_B, name: 'example.net' }];
    await service.recheck(actor);
    expect(await service.disconnect(actor)).toEqual({ leftInCloudflare: [CHECK_NAME] });
  });

  it('keeps a trusted name when the rest of an unreadable journal is gone, and looks there', async () => {
    await connectWithZoneA();
    fake.records.set(ZONE_A, [{ id: RECORD_ID, type: 'TXT', name: OLD_NAME, content: '"x"' }]);
    setJournal(JSON.stringify({ name: OLD_NAME }));
    intercept();
    const view = connected(await service.recheck(actor));
    expect(zoneA(view).cleanupPending).toMatchObject({ recordName: OLD_NAME });
    expect(requested.some((r) => decodeURIComponent(r).includes(`name=${OLD_NAME}`))).toBe(true);
    expect(journal()).toBe(JSON.stringify({ name: OLD_NAME }));
  });
});

// ---------------------------------------------------------------------------
// R2: which zones the latest listing showed
// ---------------------------------------------------------------------------

describe('zone visibility does not depend on the clock', () => {
  const FIXED = 1_800_000_000_000;
  beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(FIXED); });

  const lastSeen = () => db().prepare('SELECT zone_ref, last_seen_at FROM exposure_zones ORDER BY zone_ref').all() as Array<{ zone_ref: string; last_seen_at: number }>;

  it('marks an omitted zone absent on a recheck made in the same millisecond, and keeps its settings', async () => {
    await connectWithZoneA();
    await service.setZone(ZONE_A, true, ['app.example.com'], actor);
    fake.zones = [{ id: ZONE_B, name: 'example.net' }];
    const view = connected(await service.recheck(actor));
    expect(zoneA(view)).toMatchObject({ seenAtLastCheck: false, enabled: true, allowedSuffixes: ['app.example.com'] });
    expect(view.zonesVisible).toBe(1);
    expect(service.listEnabledZones().map((z) => z.zoneRef)).toEqual([ZONE_A]);
  });

  it('marks an omitted zone absent on a token replacement made in the same millisecond', async () => {
    await connectWithZoneA();
    fake.zones = [{ id: ZONE_B, name: 'example.net' }];
    const view = connected(await service.connect(`${FAKE_TOKEN}-new`, FAKE_ACCOUNT_ID, actor));
    expect(zoneA(view)).toMatchObject({ seenAtLastCheck: false, enabled: true });
    expect(view.zonesVisible).toBe(1);
  });

  it('sees a zone again when a later listing in the same millisecond shows it, and gives every listing its own stamp', async () => {
    await connectWithZoneA();
    const stamps = [lastSeen().find((z) => z.zone_ref === ZONE_A)!.last_seen_at];
    fake.zones = [{ id: ZONE_B, name: 'example.net' }];
    await service.recheck(actor);
    fake.zones = [{ id: ZONE_A, name: 'example.com' }, { id: ZONE_B, name: 'example.net' }];
    const view = connected(await service.recheck(actor));
    stamps.push(lastSeen().find((z) => z.zone_ref === ZONE_A)!.last_seen_at);
    expect(zoneA(view).seenAtLastCheck).toBe(true);
    expect(view.zonesVisible).toBe(2);
    expect(new Set(stamps).size).toBe(2);
  });

  it('keeps counting listings forward when the clock steps back', async () => {
    await connectWithZoneA();
    const first = lastSeen()[0].last_seen_at;
    vi.spyOn(Date, 'now').mockReturnValue(FIXED - 60_000);
    fake.zones = [{ id: ZONE_B, name: 'example.net' }];
    const view = connected(await service.recheck(actor));
    expect(zoneA(view).seenAtLastCheck).toBe(false);
    expect(lastSeen().find((z) => z.zone_ref === ZONE_B)!.last_seen_at).toBeGreaterThan(first);
  });

  it('lets a disconnect leave the record of a zone the latest listing omitted, in the same millisecond', async () => {
    await connectWithZoneA();
    fake.remove = 500;
    await service.dnsCheck(ZONE_A, actor);
    fake.zones = [{ id: ZONE_B, name: 'example.net' }];
    await service.recheck(actor);
    expect(zoneA(service.getView())).toMatchObject({ seenAtLastCheck: false, cleanupPending: { recordName: CHECK_NAME } });
    fake.remove = 403;
    expect(await service.disconnect(actor)).toEqual({ leftInCloudflare: [CHECK_NAME] });
  });

  it('refuses a disconnect for a zone the latest listing still shows, in the same millisecond', async () => {
    await connectWithZoneA();
    fake.remove = 500;
    await service.dnsCheck(ZONE_A, actor);
    await service.recheck(actor);
    fake.remove = 403;
    expect((await refusal(service.disconnect(actor))).code).toBe('CLEANUP_PENDING');
  });
});
