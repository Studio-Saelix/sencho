/**
 * What the Cloudflare account does with answers Cloudflare marks successful.
 * A successful answer can carry the credential back (in a status, a date, an
 * account or zone name, a record type), can be unreadable where a permission
 * probe expects a list, or can arrive in pieces whose later page is refused.
 * Each of those must leave the stored facts, the journals and every outward
 * surface (responses, plaintext columns, audit rows, logs) as they were, and
 * must never read as a missing permission, a vanished zone or a record that
 * is gone. Journals whose description is damaged keep the record id, a
 * zone's listing membership is its own identity, not the clock, and the count
 * and page-size rules reach every consumer of a listing.
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
let Adapter: typeof import('../services/publicExposure/cloudflareAccountAdapter').CloudflareAccountAdapter;

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
/** The zone-wide lookup a journal without a trusted place makes: every record whose name starts with the check label. */
const CHECK_PREFIX = '_sencho-check-';
const atCheckPrefix = on(/^\/zones\/[0-9a-f]+\/dns_records$/, 'GET', (url) => url.searchParams.get('name.startswith') === CHECK_PREFIX);
/** Either lookup: the record's own name, or the zone-wide one. */
const atCheckRecords = (name = CHECK_NAME) => (url: URL, m: string) => atCheckName(name)(url, m) || atCheckPrefix(url, m);

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
  ({ CloudflareAccountAdapter: Adapter } = await import('../services/publicExposure/cloudflareAccountAdapter'));
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
// A successful answer that carries the credential
// ---------------------------------------------------------------------------

describe('a successful Cloudflare answer that carries the credential', () => {
  const ECHOES = [['as sent', FAKE_TOKEN], ['in lower case', FAKE_TOKEN.toLowerCase()]] as const;

  /** Every place the credential must never reach, read after an action. */
  function leaks(token = FAKE_TOKEN): string[] {
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
    return haystack.includes(token.toLowerCase()) ? ['a surface holds the token'] : [];
  }

  const userVerify = (result: unknown) => once(on(/^\/user\/tokens\/verify$/), success(result));
  const accountVerify = (result: unknown) => once(on(/^\/accounts\/[0-9a-f]+\/tokens\/verify$/), success(result));

  type Action = 'connect' | 'replace' | 'recheck';
  const ACTIONS: Action[] = ['connect', 'replace', 'recheck'];

  describe.each(ECHOES)('echoed %s', (_how, echo) => {
    describe.each(ACTIONS)('on %s', (action) => {
      it.each([
        ['the status of the user verification', () => [userVerify({ id: 't', status: echo })], 'UNEXPECTED_RESPONSE', 'unexpected_response'],
        ['the expiry of a disabled token on the user verification', () => [userVerify({ id: 't', status: 'disabled', expires_on: echo })], 'UNEXPECTED_RESPONSE', 'unexpected_response'],
        ['the status of the account verification', () => { fake.verifyUser = 401; return [accountVerify({ id: 't', status: echo })]; }, 'UNEXPECTED_RESPONSE', 'unexpected_response'],
        ['the expiry of an expired token on the account verification', () => { fake.verifyUser = 401; return [accountVerify({ id: 't', status: 'expired', expires_on: echo })]; }, 'UNEXPECTED_RESPONSE', 'unexpected_response'],
        // A control: an active token's expiry is not read at all, so an echo there must change nothing.
        ['the expiry of an active token', () => [userVerify({ id: 't', status: 'active', expires_on: echo })], null, 'ok'],
      ])('keeps it out of every surface when it is %s, and answers as the state it is', async (_label, rules, code, outcome) => {
        if (action !== 'connect') await connectWithZoneA();
        // The account-endpoint rules flip the fake's user verification, so they are built after the setup above.
        intercept(...rules());
        let message = '';
        let got: string;
        try {
          if (action === 'recheck') got = connected(await service.recheck(actor)).lastCheck.outcome;
          else got = connected(await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor)).lastCheck.outcome;
        } catch (error: unknown) {
          message = (error as Error).message;
          got = (error as InstanceType<typeof PublicExposureError>).code;
        }
        expect(got).toBe(action === 'recheck' || code === null ? outcome : code);
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

  // An expiry the date grammar accepts can still carry the credential: fractional seconds take any digits,
  // and a short enough token is itself a date. Date validation is a separate check from containment.
  describe('a well-formed expiry that carries the credential', () => {
    const NUMERIC = '4815162342'.repeat(4);
    const DATE_TOKEN = '2026-01-01T00:00:00Z';
    const VARIANTS: Array<[string, string, string]> = [
      ['fractional seconds that are the credential', NUMERIC, `2026-01-01T00:00:00.${NUMERIC}Z`],
      ['fractional seconds that are the credential, with an offset', NUMERIC, `2026-01-01T00:00:00.${NUMERIC}+00:00`],
      ['fractional seconds that hold the credential after other digits', NUMERIC, `2026-01-01T00:00:00.99${NUMERIC}Z`],
      ['a date that is the credential itself', DATE_TOKEN, DATE_TOKEN],
      ['a date that is the credential in another letter case', DATE_TOKEN.toLowerCase(), DATE_TOKEN],
      ['a lower-case date that is the credential', DATE_TOKEN, DATE_TOKEN.toLowerCase()],
    ];
    const ENDPOINTS: Array<[string, boolean]> = [['the user verification', false], ['the account verification', true]];

    describe.each(ENDPOINTS)('on %s', (_endpoint, accountEndpoint) => {
      describe.each(['disabled', 'expired'])('of a %s token', (status) => {
        describe.each(ACTIONS)('on %s', (action) => {
          it.each(VARIANTS)('refuses %s, and no surface holds it', async (_label, token, expiry) => {
            if (action !== 'connect') await service.connect(token, FAKE_ACCOUNT_ID, actor);
            // The account-endpoint rules flip the fake's user verification, so they are built after the setup above.
            if (accountEndpoint) fake.verifyUser = 401;
            intercept((accountEndpoint ? accountVerify : userVerify)({ id: 't', status, expires_on: expiry }));
            const before = action === 'connect' ? null : JSON.stringify(connected(service.getView()).lastCheck);
            let message = '';
            let got: string;
            try {
              if (action === 'recheck') got = connected(await service.recheck(actor)).lastCheck.outcome;
              else got = connected(await service.connect(token, FAKE_ACCOUNT_ID, actor)).lastCheck.outcome;
            } catch (error: unknown) {
              message = (error as Error).message;
              got = (error as InstanceType<typeof PublicExposureError>).code;
            }
            // The answer is unreadable, as any other echo of the credential is; it is not a token state to report.
            expect(got).toBe(action === 'recheck' ? 'unexpected_response' : 'UNEXPECTED_RESPONSE');
            expect(message.toLowerCase()).not.toContain(token.toLowerCase());
            // Immediate and later reads, the plaintext check column, the audit rows, the zone rows and the logs.
            expect(JSON.stringify(service.getView()).toLowerCase()).not.toContain(token.toLowerCase());
            expect(leaks(token)).toEqual([]);
            if (action === 'connect') expect(service.getView()).toEqual({ connected: false });
            else if (action === 'replace') expect(JSON.stringify(connected(service.getView()).lastCheck)).toBe(before);
          });
        });
      });
    });

    it('keeps a real expiry date that merely sits next to digits of its own', async () => {
      intercept(userVerify({ id: 't', status: 'expired', expires_on: '2026-01-01T00:00:00.123456Z' }));
      expect((await refusal(service.connect(NUMERIC, FAKE_ACCOUNT_ID, actor))).message).toContain('2026-01-01T00:00:00.123456Z');
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
// A successful answer Sencho cannot read
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
// A refusal that arrives after the first page of a listing
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
    const recordsRule = () => pages(atCheckRecords(), [PAGE_ONE([OURS]), second]);

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
// A journal whose description is damaged
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
          // The check record is gone and so is the journal: dropped with the account on a disconnect, cleared in place otherwise.
          if (caller === 'disconnect') expect(service.getView()).toEqual({ connected: false });
          else expect(journal()).toBeNull();
        });
      });
    });
  });

  /** The lookups a journal makes when it cannot say where its record is: every check record in the zone. */
  const zoneWideLookups = () => requested.map((r) => decodeURIComponent(r)).filter((r) => r.includes('/dns_records?') && r.includes(`name.startswith=${CHECK_PREFIX}`));
  const nameLookups = () => requested.map((r) => decodeURIComponent(r)).filter((r) => r.includes('/dns_records?') && (r.includes('&name=') || r.includes('?name=')));

  describe.each(CALLERS)('with no usable id, through %s', (caller) => {
    describe.each([['no id', undefined], ['a malformed id', '../zones']])('and %s', (_i, recordId) => {
      it.each(DAMAGED_NAMES)('does not trust %s: the column is unreadable, so it looks in the whole zone, settles nothing from an empty name, and never deletes by content', async (_label, name) => {
        await connectWithZoneA();
        // The record is where this instance would have put it; the journal's own name points nowhere useful.
        seed();
        setJournal(mk(name, CONTENT, recordId));
        intercept();
        for (let i = 0; i < 3; i += 1) await run(caller);
        expect(journal()).not.toBeNull();
        expect(hasRecord(RECORD_ID)).toBe(true);
        expect(fake.requests.filter((r) => r.startsWith('DELETE'))).toEqual([]);
        expect(requested.filter((r) => r.startsWith('POST'))).toEqual([]);
        expect(zoneWideLookups().length).toBeGreaterThan(0);
        // The damaged name is never the place that settles the journal.
        expect(nameLookups().every((r) => r.includes(`name=${CHECK_NAME}`))).toBe(true);
      });

      it('does not clear an aged journal when a valid-looking name of another identity points nowhere and the record sits at the current name', async () => {
        await connectWithZoneA();
        // The journal kept a check name in this zone, but not this instance's, and lost its content.
        seed();
        setJournal(mk(OLD_NAME, undefined, recordId));
        intercept();
        for (let i = 0; i < 3; i += 1) await run(caller);
        expect(journal()).not.toBeNull();
        expect(hasRecord(RECORD_ID)).toBe(true);
      });

      it('deletes the record at the current name by the journal\'s own content when the journal kept another identity\'s name', async () => {
        await connectWithZoneA();
        seed();
        setJournal(mk(OLD_NAME, CONTENT, recordId));
        intercept();
        await run(caller);
        expect(hasRecord(RECORD_ID)).toBe(false);
        expect(zoneWideLookups().length).toBeGreaterThan(0);
      });

      it.each(DAMAGED_CONTENTS)('with %s, looks in the whole zone, and keeps the journal while a record sits at the journal\'s own name', async (_label, content) => {
        await connectWithZoneA();
        fake.records.set(ZONE_A, [{ id: RECORD_ID, type: 'TXT', name: OLD_NAME, content: `"${CONTENT}"` }]);
        setJournal(mk(OLD_NAME, content, recordId));
        intercept();
        await run(caller);
        expect(journal()).not.toBeNull();
        expect(hasRecord(RECORD_ID)).toBe(true);
        expect(zoneWideLookups().length).toBeGreaterThan(0);
      });

      it('keeps a journal that lost its name, content and id while a record sits at a name an earlier identity used, however old the journal is', async () => {
        await connectWithZoneA();
        fake.records.set(ZONE_A, [{ id: RECORD_ID, type: 'TXT', name: OLD_NAME, content: `"${CONTENT}"` }]);
        // What an unreadable column is rewritten to: this instance's name, no content, no id.
        setJournal(mk(CHECK_NAME, undefined, recordId));
        intercept();
        for (let i = 0; i < 3; i += 1) await run(caller);
        expect(journal()).not.toBeNull();
        expect(hasRecord(RECORD_ID)).toBe(true);
        expect(zoneWideLookups().length).toBeGreaterThan(0);
        // The record is gone from Cloudflare: now the zone proves the absence, and the journal settles.
        fake.records.set(ZONE_A, []);
        if (caller === 'disconnect') {
          expect(await service.disconnect(actor)).toEqual({ leftInCloudflare: [] });
        } else {
          await run(caller);
          expect(journal()).toBeNull();
        }
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

  it.each(CALLERS)('settles an aged journal that kept a trusted name and lost its content once the zone holds no check record, through %s', async (caller) => {
    await connectWithZoneA();
    setJournal(mk(OLD_NAME, ['x'], undefined));
    if (caller === 'disconnect') {
      expect(await service.disconnect(actor)).toEqual({ leftInCloudflare: [] });
      return;
    }
    await run(caller);
    expect(journal()).toBeNull();
  });

  it.each([['no createdAt', undefined], ['a text createdAt', 'yesterday'], ['a negative createdAt', -5]])('still deletes by the stored id when the journal has %s', async (_label, createdAt) => {
    await connectWithZoneA();
    seed();
    setJournal(JSON.stringify({ name: CHECK_NAME, content: CONTENT, recordId: RECORD_ID, createdAt }));
    await service.recheck(actor);
    expect(hasRecord(RECORD_ID)).toBe(false);
    expect(journal()).toBeNull();
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

  describe.each(CALLERS)('with another hub\'s check record in the zone, through %s', (caller) => {
    const FOREIGN_ID = 'd'.repeat(32);
    const foreign = { id: FOREIGN_ID, type: 'TXT', name: `_sencho-check-0th3r1d.example.com`, content: '"sencho-scope-check:feedfacefeedface"' };

    it('deletes only the record that carries the journal\'s content, and leaves the other hub\'s record alone', async () => {
      await connectWithZoneA();
      fake.records.set(ZONE_A, [foreign, { id: RECORD_ID, type: 'TXT', name: OLD_NAME, content: `"${CONTENT}"` }]);
      setJournal(mk(OLD_NAME, CONTENT, undefined));
      intercept();
      await run(caller);
      expect(hasRecord(RECORD_ID)).toBe(false);
      expect(hasRecord(FOREIGN_ID)).toBe(true);
      expect(fake.requests.filter((r) => r.startsWith('DELETE'))).toContain(`DELETE /zones/${ZONE_A}/dns_records/${RECORD_ID}`);
      expect(fake.requests).not.toContain(`DELETE /zones/${ZONE_A}/dns_records/${FOREIGN_ID}`);
    });

    it('keeps the journal and deletes nothing when only the other hub\'s record sits there', async () => {
      await connectWithZoneA();
      fake.records.set(ZONE_A, [foreign]);
      setJournal(mk(OLD_NAME, CONTENT, undefined));
      intercept();
      await run(caller);
      expect(journal()).not.toBeNull();
      expect(hasRecord(FOREIGN_ID)).toBe(true);
      expect(fake.requests.filter((r) => r.startsWith('DELETE'))).toEqual([]);
    });

    it('finds a record whose check name is written in capitals', async () => {
      await connectWithZoneA();
      fake.records.set(ZONE_A, [{ id: RECORD_ID, type: 'TXT', name: OLD_NAME.toUpperCase(), content: `"${CONTENT}"` }]);
      setJournal(mk(OLD_NAME, CONTENT, undefined));
      intercept();
      await run(caller);
      expect(hasRecord(RECORD_ID)).toBe(false);
    });

    it('counts a record with no readable name as one that may be a check record, and keeps the journal', async () => {
      await connectWithZoneA();
      fake.records.set(ZONE_A, [{ id: RECORD_ID, type: 'TXT', name: OLD_NAME, content: '"x"' }]);
      setJournal(mk(OLD_NAME, undefined, undefined));
      intercept(once(atCheckPrefix, success([{ id: RECORD_ID, type: 'TXT', content: '"x"' }], { page: 1, per_page: 100, count: 1, total_pages: 1, total_count: 1 })));
      await run(caller);
      expect(journal()).not.toBeNull();
      expect(hasRecord(RECORD_ID)).toBe(true);
    });

    it('reads a zone-wide listing with an unreadable element as an unexpected answer and keeps the journal', async () => {
      await connectWithZoneA();
      setJournal('{');
      intercept(once(atCheckPrefix, success([null], { page: 1, per_page: 100, count: 1, total_pages: 1, total_count: 1 })));
      await run(caller);
      expect(journal()).toBe('{');
      expect(requested.filter((r) => r.startsWith('POST'))).toEqual([]);
    });
  });

  // A zone-wide listing can carry a record whose name is text that does not read as a DNS name. Such an entry is
  // unreadable evidence, not an absent record: it keeps the journal in every caller, in every journal form that looks in
  // the whole zone, and it survives a restart and the late-create window.
  describe('a zone-wide listing with a record whose name is text that does not read as a DNS name', () => {
    // The first six never start with the check label, so a filter that dropped every other string name lost them;
    // the rest start with it or are not text, and are kept by any filter: controls for the readable-name rule.
    const MALFORMED_NAMES: Array<[string, unknown]> = [
      ['an empty name', ''], ['a blank name', '   '], ['text with spaces', 'not a dns name'],
      ['a check name with a leading space', ` ${OLD_NAME}`],
      ['a label longer than 63 characters', `${'a'.repeat(64)}.example.com`],
      ['many short labels past 254 characters in all', `${'a.'.repeat(130)}example.com`],
      ['a check name with a trailing newline', `${OLD_NAME}\n`],
      ['a name with a control character', `_sencho-check-0ld\u0000.example.com`], ['an empty label', `_sencho-check-0ld..example.com`],
      ['a null name', null], ['a numeric name', 42], ['an object name', { a: 1 }], ['a list name', ['x']],
    ];
    const INFO = { page: 1, per_page: 100, count: 1, total_pages: 1, total_count: 1 };
    const seedAtOld = (content = '"x"') => fake.records.set(ZONE_A, [{ id: RECORD_ID, type: 'TXT', name: OLD_NAME, content }]);
    const deletes = () => fake.requests.filter((r) => r.startsWith('DELETE'));

    /** Each readable form of a journal that has to look in the whole zone and carries no content that proves a record is ours. An unreadable column is the restart test below. */
    const FORMS: Array<[string, () => string]> = [
      ['a historical name with no content', () => mk(OLD_NAME, undefined, undefined)],
      ['a historical name with content no record carries', () => mk(OLD_NAME, 'sencho-scope-check:ffffffffffffffff', undefined)],
      ['the current name with no content', () => mk(CHECK_NAME, undefined, undefined)],
    ];

    describe.each(CALLERS)('through %s', (caller) => {
      describe.each(FORMS)('with a journal that has %s', (_form, makeJournal) => {
        it.each(MALFORMED_NAMES)('keeps the journal, the record and the account when the record has %s', async (_label, name) => {
          await connectWithZoneA();
          seedAtOld();
          setJournal(makeJournal());
          intercept(pages(atCheckPrefix, [success([{ id: RECORD_ID, type: 'TXT', name, content: '"x"' }], INFO)]));
          for (let i = 0; i < 3; i += 1) await run(caller);
          expect(journal()).not.toBeNull();
          expect(hasRecord(RECORD_ID)).toBe(true);
          expect(deletes()).toEqual([]);
          // No new check record is created over cleanup that did not finish, and Disconnect did not drop the account.
          expect(requested.filter((r) => r.startsWith('POST'))).toEqual([]);
          expect(service.getView().connected).toBe(true);
          if (caller === 'disconnect') expect((await refusal(service.disconnect(actor))).code).toBe('CLEANUP_PENDING');
        });
      });

      it.each(MALFORMED_NAMES)('deletes the record by the journal\'s own content when it has %s and carries that content', async (_label, name) => {
        await connectWithZoneA();
        seedAtOld(`"${CONTENT}"`);
        setJournal(mk(OLD_NAME, CONTENT, undefined));
        intercept(pages(atCheckPrefix, [success([{ id: RECORD_ID, type: 'TXT', name, content: `"${CONTENT}"` }], INFO)]));
        await run(caller);
        expect(hasRecord(RECORD_ID)).toBe(false);
        // A DNS check goes on to create and delete its own record once the journal is settled.
        expect(deletes()).toContain(`DELETE /zones/${ZONE_A}/dns_records/${RECORD_ID}`);
        if (caller === 'disconnect') expect(service.getView()).toEqual({ connected: false });
        else expect(journal()).toBeNull();
      });

      it.each(['www.example.com', 'WWW.Example.COM.', '*.example.com', '_dmarc.example.com', `${'a'.repeat(63)}.example.com`, `${'a.'.repeat(120)}example.com`])('still drops the readable name %s that is not a check name, so a provider that ignored the filter does not hold the journal', async (name) => {
        await connectWithZoneA();
        fake.records.set(ZONE_A, [{ id: RECORD_ID, type: 'A', name, content: '192.0.2.1' }]);
        setJournal(mk(OLD_NAME, undefined, undefined));
        intercept(pages(atCheckPrefix, [success([{ id: RECORD_ID, type: 'A', name, content: '192.0.2.1' }], INFO)]));
        if (caller === 'disconnect') expect(await service.disconnect(actor)).toEqual({ leftInCloudflare: [] });
        else { await run(caller); expect(journal()).toBeNull(); }
        expect(hasRecord(RECORD_ID)).toBe(true);
      });

      it.each(MALFORMED_NAMES)('keeps an unreadable column across a restart and past the late-create window when the record has %s, and settles once the record is gone', async (_label, name) => {
        await connectWithZoneA();
        seedAtOld();
        setJournal('{');
        let clock = Date.now();
        const restarted = () => new Service(new Adapter(cloudflareApiClient, () => clock));
        const runOn = async (svc: InstanceType<typeof Service>) => {
          if (caller === 'recheck') await svc.recheck(actor);
          else if (caller === 'disconnect') await svc.disconnect(actor).catch((error: unknown) => { if (!(error instanceof PublicExposureError)) throw error; });
          else await svc.dnsCheck(ZONE_A, actor).catch((error: unknown) => { if (!(error instanceof PublicExposureError)) throw error; });
        };
        intercept(pages(atCheckPrefix, [success([{ id: RECORD_ID, type: 'TXT', name, content: '"x"' }], INFO)]));
        await runOn(restarted());
        for (let i = 0; i < 3; i += 1) {
          clock += 4 * 60_000;
          await runOn(restarted());
        }
        expect(journal()).toBe('{');
        expect(hasRecord(RECORD_ID)).toBe(true);
        expect(deletes()).toEqual([]);
        expect(requested.filter((r) => r.startsWith('POST'))).toEqual([]);
        expect(service.getView().connected).toBe(true);

        // The record is gone: the zone proves it, the window starts, and the column settles once it has passed.
        fake.records.set(ZONE_A, []);
        intercept();
        await runOn(restarted());
        clock += 4 * 60_000;
        await runOn(restarted());
        if (caller === 'disconnect') expect(service.getView().connected).toBe(false);
        else expect(journal()).toBeNull();
      });
    });

    it('keeps the journal of one zone while the other zone settles, when only the first has such a record', async () => {
      await connectWithZoneA();
      await service.setZone(ZONE_B, true, [], actor);
      const OLD_B = '_sencho-check-0ld1d3nt1ty.example.net';
      fake.records.set(ZONE_A, [{ id: RECORD_ID, type: 'TXT', name: OLD_NAME, content: '"x"' }]);
      setJournal(mk(OLD_NAME, undefined, undefined), ZONE_A);
      setJournal(mk(OLD_B, undefined, undefined), ZONE_B);
      intercept(pages(on(/^\/zones\/[0-9a-f]+\/dns_records$/, 'GET', (url) => url.pathname.includes(ZONE_A) && url.searchParams.get('name.startswith') === CHECK_PREFIX), [success([{ id: RECORD_ID, type: 'TXT', name: '', content: '"x"' }], INFO)]));
      await service.recheck(actor);
      expect(journal(ZONE_A)).not.toBeNull();
      expect(journal(ZONE_B)).toBeNull();
      expect(hasRecord(RECORD_ID)).toBe(true);
    });
  });

  it('keeps a trusted name when the rest of the journal is gone, looks in the whole zone, and keeps the journal while another record sits there', async () => {
    await connectWithZoneA();
    fake.records.set(ZONE_A, [{ id: RECORD_ID, type: 'TXT', name: OLD_NAME, content: '"x"' }]);
    setJournal(JSON.stringify({ name: OLD_NAME }));
    intercept();
    const view = connected(await service.recheck(actor));
    expect(zoneA(view).cleanupPending).toMatchObject({ recordName: OLD_NAME });
    expect(zoneWideLookups().length).toBeGreaterThan(0);
    expect(JSON.parse(journal() as string)).toMatchObject({ name: OLD_NAME, cause: 'unmatched' });
    expect(hasRecord(RECORD_ID)).toBe(true);
  });

  it('keeps an unreadable column while a record sits at a name an earlier identity used, and refuses disconnect instead of reporting a clean exit', async () => {
    await connectWithZoneA();
    fake.records.set(ZONE_A, [{ id: RECORD_ID, type: 'TXT', name: OLD_NAME, content: `"${CONTENT}"` }]);
    setJournal('{');
    for (let i = 0; i < 3; i += 1) await service.recheck(actor);
    expect(journal()).toBe('{');
    expect((await refusal(service.disconnect(actor))).code).toBe('CLEANUP_PENDING');
    expect(service.getView().connected).toBe(true);
    expect(hasRecord(RECORD_ID)).toBe(true);
  });

  it('does not let a provider that ignores the name filter make the zone\'s other records look like check records', async () => {
    await connectWithZoneA();
    fake.records.set(ZONE_A, [{ id: RECORD_ID, type: 'A', name: 'www.example.com', content: '192.0.2.1' }]);
    setJournal(mk(OLD_NAME, undefined, undefined));
    intercept(once(atCheckPrefix, success([{ id: RECORD_ID, type: 'A', name: 'www.example.com', content: '192.0.2.1' }], { page: 1, per_page: 100, count: 1, total_pages: 1, total_count: 1 })));
    await service.recheck(actor);
    expect(journal()).toBeNull();
    expect(hasRecord(RECORD_ID)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Count and page-size rules, through the consumers of a listing
// ---------------------------------------------------------------------------

describe('count and page-size rules reach every consumer of a listing', () => {
  const info = (extra: Record<string, number>) => ({ page: 1, per_page: 50, ...extra });
  const OURS = { id: RECORD_ID, type: 'TXT', name: CHECK_NAME, content: `"${CONTENT}"` };

  it('reads a full count-only account page, with no total_pages, from its total_count', async () => {
    const accounts = Array.from({ length: 50 }, (_, i) => ({ id: `${(i + 16).toString(16).padStart(2, '0')}`.repeat(16), name: `Account ${i}` }));
    accounts[49] = { id: FAKE_ACCOUNT_ID, name: 'Example Account' };
    intercept(once(on(/^\/accounts$/), success(accounts, info({ count: 50, total_count: 50 }))));
    expect(connected(await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor)).accountName).toBe('Example Account');
  });

  it('reads the zones of one account when Cloudflare counts every zone the token sees', async () => {
    intercept(once(on(/^\/zones$/), success([{ id: ZONE_A, name: 'example.com' }, { id: ZONE_B, name: 'example.net' }], info({ count: 2, total_pages: 1, total_count: 40 }))));
    expect(connected(await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor)).zonesVisible).toBe(2);
  });

  it('settles a journal from the records at its name when Cloudflare counts every record in the zone', async () => {
    await connectWithZoneA();
    setJournal({ name: CHECK_NAME, content: CONTENT, recordId: null, createdAt: AGED });
    fake.records.set(ZONE_A, [OURS]);
    intercept(once(atCheckName(), success([OURS], info({ count: 1, total_pages: 1, total_count: 40 }))));
    expect(zoneA(await service.recheck(actor)).cleanupPending).toBeNull();
    expect(fake.requests).toContain(`DELETE /zones/${ZONE_A}/dns_records/${RECORD_ID}`);
  });

  it.each([
    ['declares a page size of zero', { page: 1, per_page: 0, count: 1, total_pages: 1, total_count: 1 }],
    ['declares a page size above the one asked for', { page: 1, per_page: 500, count: 1, total_pages: 1, total_count: 1 }],
  ])('refuses a zone listing that %s, on connect and recheck, and a record lookup that does, keeping its journal', async (_label, declared) => {
    const zones = once(on(/^\/zones$/), success([{ id: ZONE_A, name: 'example.com' }], declared));
    intercept(zones);
    expect((await refusal(service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor))).code).toBe('UNEXPECTED_RESPONSE');
    vi.unstubAllGlobals();
    installFakeCloudflare(fake);
    await connectWithZoneA();
    intercept(zones);
    expect(connected(await service.recheck(actor)).lastCheck.outcome).toBe('unexpected_response');
    setJournal({ name: CHECK_NAME, content: CONTENT, recordId: null, createdAt: AGED });
    fake.records.set(ZONE_A, []);
    intercept(once(atCheckName(), success([], declared)));
    await service.recheck(actor);
    expect(journal()).not.toBeNull();
  });

  it('refuses a record lookup whose page two declares a smaller page size than page one held, keeping its journal', async () => {
    await connectWithZoneA();
    const hundred = Array.from({ length: 100 }, (_, i) => ({ id: (i + 1).toString(16).padStart(32, 'a'), type: 'TXT', name: CHECK_NAME, content: '"other"' }));
    setJournal({ name: CHECK_NAME, content: CONTENT, recordId: null, createdAt: AGED });
    intercept(pages(atCheckName(), [
      success(hundred, { page: 1, count: 100, total_pages: 2, total_count: 101 }),
      success([{ ...OURS }], { page: 2, per_page: 50, count: 1, total_pages: 2, total_count: 101 }),
    ]));
    await service.recheck(actor);
    expect(journal()).not.toBeNull();
    expect(fake.requests.filter((r) => r.startsWith('DELETE'))).toEqual([]);
  });

  it('audits a recheck whose zone listing was refused on page two as an unexpected answer, never as ok', async () => {
    await connectWithZoneA();
    DatabaseService.getInstance().flushAuditLogBuffer();
    db().exec('DELETE FROM audit_log');
    intercept(pages(on(/^\/zones$/), [success([{ id: ZONE_A, name: 'example.com' }], { page: 1, per_page: 1, count: 1, total_pages: 2, total_count: 2 }), refused(403)]));
    await service.recheck(actor);
    DatabaseService.getInstance().flushAuditLogBuffer();
    const row = db().prepare(`SELECT summary FROM audit_log WHERE summary LIKE 'public_exposure.account.rechecked%'`).get() as { summary: string };
    expect(row.summary).toContain('result=unexpected_response');
  });
});

// ---------------------------------------------------------------------------
// Which zones the latest listing showed
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

// ---------------------------------------------------------------------------
// A short or empty page that declares more pages after it
// ---------------------------------------------------------------------------

describe('a filtered listing whose first pages are short or empty but declare more pages', () => {
  const OURS = { id: RECORD_ID, type: 'TXT', name: CHECK_NAME, content: `"${CONTENT}"` };
  const FOREIGN = { id: 'd'.repeat(32), type: 'TXT', name: CHECK_NAME, content: '"somebody-else"' };
  const hasRecord = (id: string) => (fake.records.get(ZONE_A) ?? []).some((r) => r.id === id);
  const info = (page: number, extra: Record<string, number> = {}) => ({ page, per_page: 100, total_pages: 2, ...extra });
  /** What a recovery lookup reads: the first page shows nothing of ours (empty, or only a record that is not ours), the record is on page two. */
  const LOOKUPS: Array<[string, () => Reply[]]> = [
    ['an empty first page, no total_count', () => [success([], info(1)), success([OURS], info(2))]],
    ['an empty first page, with a total_count', () => [success([], info(1, { total_count: 101 })), success([OURS], info(2, { total_count: 101 }))]],
    ['a short first page of other records, no total_count', () => [success([FOREIGN], info(1)), success([OURS], info(2))]],
    ['a short first page of other records, with a total_count', () => [success([FOREIGN], info(1, { total_count: 101 })), success([OURS], info(2, { total_count: 101 }))]],
    ['two empty pages before the record, three declared', () => [success([], info(1, { total_pages: 3 })), success([], info(2, { total_pages: 3 })), success([OURS], info(3, { total_pages: 3 }))]],
  ];

  type Caller = 'recheck' | 'disconnect' | 'dnsCheck';
  const CALLERS: Caller[] = ['recheck', 'disconnect', 'dnsCheck'];
  async function run(caller: Caller): Promise<void> {
    if (caller === 'recheck') await service.recheck(actor);
    else if (caller === 'disconnect') await service.disconnect(actor).catch((error: unknown) => { if (!(error instanceof PublicExposureError)) throw error; });
    else await service.dnsCheck(ZONE_A, actor).catch((error: unknown) => { if (!(error instanceof PublicExposureError)) throw error; });
  }

  describe.each(CALLERS)('recovery through %s', (caller) => {
    describe.each(LOOKUPS)('with %s', (_label, script) => {
      it.each([
        ['a journal that names its record', { name: CHECK_NAME, content: CONTENT, recordId: null, createdAt: AGED }, atCheckName],
        ['an unreadable column, which looks in the whole zone', '{', () => atCheckPrefix],
      ])('reads on to the declared page for %s: a readable journal deletes the record it finds there, an unreadable column keeps the journal', async (_what, stored, match) => {
        await connectWithZoneA();
        fake.records.set(ZONE_A, [OURS]);
        setJournal(stored);
        // An unreadable column never deletes by content: the record on page two is only ever reported.
        const unreadable = typeof stored === 'string';
        intercept(pages(match(), script()));
        await run(caller);
        if (unreadable) {
          expect(journal()).toBe('{');
          expect(fake.requests.filter((r) => r.startsWith('DELETE'))).toEqual([]);
        } else {
          expect(fake.requests).toContain(`DELETE /zones/${ZONE_A}/dns_records/${RECORD_ID}`);
          expect(hasRecord(RECORD_ID)).toBe(false);
        }
        if (unreadable) expect(hasRecord(RECORD_ID)).toBe(true);
        expect(requested.filter((r) => r.includes('page=2') && r.includes('/dns_records?')).length).toBeGreaterThan(0);
      });
    });
  });

  it('keeps the journal and the record when the page it declared is refused, instead of settling on the empty first page', async () => {
    await connectWithZoneA();
    fake.records.set(ZONE_A, [OURS]);
    setJournal({ name: CHECK_NAME, content: CONTENT, recordId: null, createdAt: AGED });
    intercept(pages(atCheckName(), [success([], info(1)), refused(500)]));
    await service.recheck(actor);
    expect(journal()).not.toBeNull();
    expect(hasRecord(RECORD_ID)).toBe(true);
  });

  it('tells a disconnect about the record on page two instead of reporting a clean exit', async () => {
    await connectWithZoneA();
    fake.records.set(ZONE_A, [OURS]);
    fake.remove = 500;
    setJournal({ name: CHECK_NAME, content: CONTENT, recordId: null, createdAt: AGED });
    intercept(pages(atCheckName(), [success([], info(1)), success([OURS], info(2))]));
    expect((await refusal(service.disconnect(actor))).code).toBe('CLEANUP_PENDING');
    expect(service.getView().connected).toBe(true);
    expect(journal()).not.toBeNull();
    expect(hasRecord(RECORD_ID)).toBe(true);
  });

  it('refuses the DNS check preflight over a record that sits on page two, and creates nothing', async () => {
    await connectWithZoneA();
    intercept(pages(atCheckName(), [success([], info(1)), success([{ id: RECORD_ID, type: 'A', name: CHECK_NAME, content: '192.0.2.1' }], info(2))]));
    expect((await refusal(service.dnsCheck(ZONE_A, actor))).code).toBe('SCOPE_CHECK_CONFLICT');
    expect(requested.filter((r) => r.startsWith('POST'))).toEqual([]);
  });

  describe('zone listings', () => {
    const ZONES_PAGES = [success([], info(1, { per_page: 50 })), success([{ id: ZONE_A, name: 'example.com' }, { id: ZONE_B, name: 'example.net' }], info(2, { per_page: 50 }))];

    it('connects with the zones on page two, not with none', async () => {
      intercept(pages(on(/^\/zones$/), ZONES_PAGES));
      expect(connected(await service.connect(FAKE_TOKEN, FAKE_ACCOUNT_ID, actor)).zonesVisible).toBe(2);
    });

    it('keeps zone B on a recheck whose first page is empty, because page two shows it', async () => {
      await connectWithZoneA();
      intercept(pages(on(/^\/zones$/), ZONES_PAGES));
      const view = connected(await service.recheck(actor));
      expect(view.zones.map((z) => z.zoneRef).sort()).toEqual([ZONE_A, ZONE_B].sort());
      expect(view.zonesVisible).toBe(2);
      expect(zoneA(view)).toMatchObject({ seenAtLastCheck: true, enabled: true });
    });

    it('keeps the facts of a replacement when the declared second page is refused, and stores nothing new', async () => {
      await connectWithZoneA();
      const before = connected(service.getView());
      intercept(pages(on(/^\/zones$/), [success([], info(1, { per_page: 50 })), refused(500)]));
      expect((await refusal(service.connect(`${FAKE_TOKEN}-new`, FAKE_ACCOUNT_ID, actor))).code).toBe('CLOUDFLARE_UNREACHABLE');
      expect(connected(service.getView()).zones.map((z) => z.zoneRef)).toEqual(before.zones.map((z) => z.zoneRef));
    });
  });
});
