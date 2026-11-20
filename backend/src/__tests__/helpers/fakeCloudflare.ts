/**
 * A fake Cloudflare API for public exposure tests, installed as the global
 * fetch. Each field shapes one answer; tests flip them to reach a state.
 * Ids are made up; no real account, zone or token appears here.
 */
import { vi } from 'vitest';

export const FAKE_ACCOUNT_ID = 'a1'.repeat(16);
export const OTHER_ACCOUNT_ID = 'b2'.repeat(16);
export const ZONE_A = 'c3'.repeat(16);
export const ZONE_B = 'd4'.repeat(16);
export const FAKE_TOKEN = 'cfsentinel_TOKEN_9f8e7d6c5b4a3210zz';

export type Refusal = 400 | 401 | 403 | 404 | 500 | 'location' | 'down' | 'reset';

export interface FakeRecord { id: string; type: string; name: string; content: string }

export interface FakeCloudflare {
  verifyUser: 'active' | 'disabled' | Refusal;
  verifyAccount: 'active' | Refusal;
  accounts: Array<{ id: string; name: string }> | Refusal;
  zones: Array<{ id: string; name: string }> | Refusal;
  tunnel: 'ok' | Refusal;
  dnsRead: Record<string, 'ok' | Refusal>;
  records: Map<string, FakeRecord[]>;
  create: 'ok' | 'ok-no-delete' | Refusal;
  remove: 'ok' | Refusal;
  /** Every request, method and path only. */
  requests: string[];
  /** When set, every request waits for it before answering. */
  gate: Promise<void> | null;
  nextId: number;
}

export function makeFakeCloudflare(): FakeCloudflare {
  return {
    verifyUser: 'active',
    verifyAccount: 401,
    accounts: [{ id: FAKE_ACCOUNT_ID, name: 'Example Account' }],
    zones: [{ id: ZONE_A, name: 'example.com' }, { id: ZONE_B, name: 'example.net' }],
    tunnel: 'ok',
    dnsRead: {},
    records: new Map(),
    create: 'ok',
    remove: 'ok',
    requests: [],
    gate: null,
    nextId: 1,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function ok(result: unknown, resultInfo?: Record<string, number>): Response {
  return json({ success: true, errors: [], messages: [], result, ...(resultInfo ? { result_info: resultInfo } : {}) });
}

function refusal(kind: Refusal): Response {
  if (kind === 'down') throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) });
  if (kind === 'reset') throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
  if (kind === 'location') return json({ success: false, errors: [{ code: 9109, message: 'Cannot use the access token from location: 203.0.113.9' }], messages: [], result: null }, 403);
  const messages: Record<number, string> = { 400: 'Invalid request headers', 401: 'Invalid API Token', 403: 'Authentication error', 404: 'Not found', 500: 'Internal error' };
  return json({ success: false, errors: [{ code: kind === 403 ? 10000 : 1000, message: messages[kind] }], messages: [], result: null }, kind);
}

function paged<T>(items: T[], url: URL): Response {
  const perPage = Number(url.searchParams.get('per_page') ?? '50');
  const page = Number(url.searchParams.get('page') ?? '1');
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  return ok(items.slice((page - 1) * perPage, page * perPage), { page, per_page: perPage, total_pages: totalPages, count: items.length });
}

export function answer(fake: FakeCloudflare, url: URL, init: RequestInit): Response {
  const path = url.pathname.replace('/client/v4', '');
  const method = init.method ?? 'GET';
  fake.requests.push(`${method} ${path}`);
  let m: RegExpMatchArray | null;

  if (path === '/user/tokens/verify') {
    if (fake.verifyUser === 'active' || fake.verifyUser === 'disabled') return ok({ id: 'tok', status: fake.verifyUser, expires_on: '2026-01-01T00:00:00Z' });
    return refusal(fake.verifyUser);
  }
  if ((m = path.match(/^\/accounts\/([0-9a-f]+)\/tokens\/verify$/))) {
    if (fake.verifyAccount === 'active' && m[1] !== FAKE_ACCOUNT_ID) return refusal(404);
    return fake.verifyAccount === 'active' ? ok({ id: 'tok', status: 'active' }) : refusal(fake.verifyAccount);
  }
  if (path === '/accounts') return Array.isArray(fake.accounts) ? paged(fake.accounts, url) : refusal(fake.accounts);
  if (path === '/zones') {
    if (!Array.isArray(fake.zones)) return refusal(fake.zones);
    // Cloudflare filters by account: an account id it does not know answers 400 with code 70503.
    const accountFilter = url.searchParams.get('account.id');
    const known = accountFilter === FAKE_ACCOUNT_ID || (Array.isArray(fake.accounts) && fake.accounts.some((a) => a.id === accountFilter));
    if (accountFilter && !known) return json({ success: false, errors: [{ code: 70503, message: "account with given Tag doesn't exist" }], messages: [], result: null }, 400);
    return paged(fake.zones, url);
  }
  if ((m = path.match(/^\/accounts\/([0-9a-f]+)\/cfd_tunnel$/))) {
    if (m[1] !== FAKE_ACCOUNT_ID && (!Array.isArray(fake.accounts) || !fake.accounts.some((a) => a.id === m![1]))) return refusal(403);
    return fake.tunnel === 'ok' ? ok([], { page: 1, total_pages: 1 }) : refusal(fake.tunnel);
  }
  if ((m = path.match(/^\/zones\/([0-9a-f]+)\/dns_records$/))) {
    const zone = m[1];
    const records = fake.records.get(zone) ?? [];
    if (method === 'GET') {
      const read = fake.dnsRead[zone] ?? 'ok';
      if (read !== 'ok') return refusal(read);
      const name = url.searchParams.get('name');
      return paged(name ? records.filter((r) => r.name === name) : records, url);
    }
    if (method === 'POST') {
      if (fake.create !== 'ok' && fake.create !== 'ok-no-delete') {
        if (fake.create === 500 || fake.create === 'reset') {
          // The record landed even though the answer was lost.
          const body = JSON.parse(String(init.body)) as { type: string; name: string; content: string };
          const id = (fake.nextId++).toString(16).padStart(32, 'e');
          fake.records.set(zone, [...records, { id, type: body.type, name: body.name, content: `"${body.content}"` }]);
        }
        return refusal(fake.create);
      }
      const body = JSON.parse(String(init.body)) as { type: string; name: string; content: string };
      const id = (fake.nextId++).toString(16).padStart(32, 'f');
      fake.records.set(zone, [...records, { id, type: body.type, name: body.name, content: `"${body.content}"` }]);
      return ok({ id, ...body });
    }
  }
  if ((m = path.match(/^\/zones\/([0-9a-f]+)\/dns_records\/([0-9a-f]+)$/)) && method === 'DELETE') {
    if (fake.remove !== 'ok') return refusal(fake.remove);
    const records = fake.records.get(m[1]) ?? [];
    if (!records.some((r) => r.id === m![2])) return refusal(404);
    fake.records.set(m[1], records.filter((r) => r.id !== m![2]));
    return ok({ id: m[2] });
  }
  return refusal(404);
}

/** Install the fake as the global fetch. */
export function installFakeCloudflare(fake: FakeCloudflare): void {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (fake.gate) await fake.gate;
    return answer(fake, new URL(String(input)), init ?? {});
  }));
}
