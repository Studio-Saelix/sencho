/**
 * The shared Cloudflare API client: envelope parsing, complete pagination,
 * bounded retries that honour Retry-After, permanent 4xx, ambiguous POSTs,
 * deadlines, refused redirects and the request budget. Every guard here was
 * confirmed to fail with the guard reverted.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CloudflareApiClient,
  CloudflareApiError,
  parseRetryAfter,
} from '../services/publicExposure/cloudflareApiClient';

const TOKEN = 'cf-sentinel-token-0123456789abcdef';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function ok(result: unknown, resultInfo?: Record<string, number>): Response {
  return json({ success: true, errors: [], messages: [], result, ...(resultInfo ? { result_info: resultInfo } : {}) });
}

function fail(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return json({ success: false, errors: [{ code, message }], messages: [], result: null }, status, headers);
}

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function clientWith(handlers: Handler[], extra: { now?: () => number; random?: () => number } = {}) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    const handler = handlers[Math.min(calls.length - 1, handlers.length - 1)];
    return handler(url, init ?? {});
  });
  const client = new CloudflareApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch, random: () => 0, ...extra });
  return { client, calls, fetchImpl };
}

async function caught(promise: Promise<unknown>): Promise<CloudflareApiError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof CloudflareApiError) return error;
    throw error;
  }
  throw new Error('expected a CloudflareApiError');
}

function hangUntilAborted(_url: URL, init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CloudflareApiClient envelope and transport', () => {
  it('sends the token only as a bearer header, refuses redirects, and returns the result', async () => {
    const { client, calls } = clientWith([() => ok({ id: 'x', status: 'active' })]);
    const res = await client.request<{ status: string }>(TOKEN, { method: 'GET', path: '/user/tokens/verify' });
    expect(res.result.status).toBe('active');
    expect(calls[0].url.toString()).toBe('https://api.cloudflare.com/client/v4/user/tokens/verify');
    expect(calls[0].init.redirect).toBe('error');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].url.toString()).not.toContain(TOKEN);
  });

  it('raises success:false with the Cloudflare error codes', async () => {
    const { client } = clientWith([() => json({ success: false, errors: [{ code: 7003, message: 'Could not route' }], messages: [], result: null }, 200)]);
    const error = await caught(client.request(TOKEN, { method: 'GET', path: '/zones' }));
    expect(error.kind).toBe('bad_request');
    expect(error.cfCodes).toEqual([7003]);
    expect(error.message).toContain('Could not route');
  });

  it.each([
    [400, 'bad_request'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
  ] as const)('maps %s to %s and never retries it', async (status, kind) => {
    const { client, calls } = clientWith([() => fail(status, 1000, 'refused')]);
    const error = await caught(client.request(TOKEN, { method: 'GET', path: '/zones' }));
    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
    expect(calls).toHaveLength(1);
  });

  it('treats a non-JSON body as an invalid response', async () => {
    const { client } = clientWith([() => new Response('<html>oops</html>', { status: 200 })]);
    expect((await caught(client.request(TOKEN, { method: 'GET', path: '/zones' }))).kind).toBe('invalid_response');
  });

  it('treats a JSON body without success as an invalid response', async () => {
    const { client } = clientWith([() => json({ result: [] })]);
    expect((await caught(client.request(TOKEN, { method: 'GET', path: '/zones' }))).kind).toBe('invalid_response');
  });

  it('refuses a redirect answer instead of following it', async () => {
    const { client, calls } = clientWith([() => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })]);
    expect((await caught(client.request(TOKEN, { method: 'GET', path: '/zones' }))).kind).toBe('invalid_response');
    expect(calls).toHaveLength(1);
  });

  it('maps a redirect refused by fetch itself to an invalid response', async () => {
    const { client } = clientWith([() => { throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') }); }]);
    expect((await caught(client.request(TOKEN, { method: 'GET', path: '/zones' }))).kind).toBe('invalid_response');
  });

  it('keeps the token out of every error message, even when Cloudflare echoes it', async () => {
    const { client } = clientWith([() => fail(400, 6003, `Invalid token ${TOKEN} sent`)]);
    const error = await caught(client.request(TOKEN, { method: 'GET', path: '/zones' }));
    expect(error.message).not.toContain(TOKEN);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(String(error.cause ?? '')).not.toContain(TOKEN);
  });
});

describe('CloudflareApiClient envelope fields it cannot read', () => {
  const success = (extra: Record<string, unknown>) => json({ success: true, result: [], ...extra });

  it.each([
    ['a null error element', { errors: [null] }],
    ['an errors field that is an object', { errors: {} }],
    ['an errors field that is text', { errors: 'bad' }],
    ['an error element that is a number', { errors: [5] }],
    ['a messages field that is an object', { messages: {} }],
    ['a null message', { messages: [null] }],
    ['a message that is a number', { messages: [5] }],
    ['a result_info that is text', { result_info: 'x' }],
    ['a result_info that is a list', { result_info: [] }],
    ['a total_pages that is text', { result_info: { total_pages: '3' } }],
    ['a negative total_pages', { result_info: { total_pages: -1 } }],
    ['a fractional page', { result_info: { page: 1.5 } }],
    ['a null count', { result_info: { count: null } }],
  ])('reads a success with %s as an invalid response, never a raw exception', async (_label, extra) => {
    for (const method of ['GET', 'POST', 'DELETE'] as const) {
      const { client, calls } = clientWith([() => success(extra)]);
      const error = await caught(client.request(TOKEN, { method, path: '/zones/x/dns_records' }));
      expect(error.kind).toBe('invalid_response');
      // Cloudflare may have acted on the call, so it is never repeated blindly: a POST is sent once.
      if (method === 'POST') expect(calls).toHaveLength(1);
      expect(error.preSend).toBe(false);
    }
  });

  it.each([
    ['no errors, messages or result_info', {}],
    ['an empty result_info', { result_info: {} }],
    ['a null result_info', { result_info: null }],
    ['message objects and strings', { messages: [{ message: 'note', code: 1 }, 'plain'] }],
    ['an error list on a success', { errors: [] }],
  ])('still reads a success with %s', async (_label, extra) => {
    const { client } = clientWith([() => success(extra)]);
    const res = await client.request(TOKEN, { method: 'GET', path: '/zones' });
    expect(res.result).toEqual([]);
  });

  it.each([
    [500, 'server'],
    [429, 'rate_limited'],
    [404, 'not_found'],
    [400, 'bad_request'],
  ] as const)('keeps the kind of a %s whose errors field is unreadable', async (status, kind) => {
    const { client } = clientWith([() => json({ success: false, errors: [null, 5, { code: 1000, message: 'refused' }], messages: {}, result: null }, status)]);
    const error = await caught(client.request(TOKEN, { method: 'GET', path: '/zones' }));
    expect(error.kind).toBe(kind);
    expect(error.cfCodes).toEqual([1000]);
  });

  it('keeps the kind of a success:false answer whose errors field is not a list', async () => {
    const { client } = clientWith([() => json({ success: false, errors: [null], result: null })]);
    expect((await caught(client.request(TOKEN, { method: 'GET', path: '/zones' }))).kind).toBe('bad_request');
  });
});

describe('CloudflareApiClient retries', () => {
  it('retries a 5xx on GET and on DELETE', async () => {
    for (const method of ['GET', 'DELETE'] as const) {
      const { client, calls } = clientWith([() => fail(502, 0, 'bad gateway'), () => ok({ id: 'r' })]);
      await client.request(TOKEN, { method, path: '/zones/z/dns_records/r' });
      expect(calls).toHaveLength(2);
    }
  });

  it('stops after three attempts', async () => {
    const { client, calls } = clientWith([() => fail(503, 0, 'down')]);
    expect((await caught(client.request(TOKEN, { method: 'GET', path: '/zones' }))).kind).toBe('server');
    expect(calls).toHaveLength(3);
  });

  it('does not repeat a POST after a 5xx, because the record may exist', async () => {
    const { client, calls } = clientWith([() => fail(500, 0, 'oops'), () => ok({ id: 'r' })]);
    expect((await caught(client.request(TOKEN, { method: 'POST', path: '/zones/z/dns_records', body: {} }))).kind).toBe('server');
    expect(calls).toHaveLength(1);
  });

  it('repeats a POST only on 429 or a connection error raised before sending', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    const { client, calls } = clientWith([
      () => fail(429, 10000, 'rate limited', { 'retry-after': '0' }),
      () => { throw refused; },
      () => ok({ id: 'r' }),
    ]);
    await client.request(TOKEN, { method: 'POST', path: '/zones/z/dns_records', body: {} });
    expect(calls).toHaveLength(3);
  });

  it('does not repeat a POST after a dropped connection that may have reached Cloudflare', async () => {
    const reset = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
    const { client, calls } = clientWith([() => { throw reset; }, () => ok({ id: 'r' })]);
    const error = await caught(client.request(TOKEN, { method: 'POST', path: '/zones/z/dns_records', body: {} }));
    expect(error.kind).toBe('network');
    expect(calls).toHaveLength(1);
  });

  it('honours Retry-After in seconds', async () => {
    vi.useFakeTimers();
    const { client, calls } = clientWith([() => fail(429, 10000, 'slow down', { 'retry-after': '3' }), () => ok([])]);
    const pending = client.request(TOKEN, { method: 'GET', path: '/zones' });
    await vi.advanceTimersByTimeAsync(2_900);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    await pending;
    expect(calls).toHaveLength(2);
  });

  it('honours Retry-After as an HTTP date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-19T12:00:00Z'));
    const { client, calls } = clientWith([
      () => fail(429, 10000, 'slow down', { 'retry-after': new Date('2026-11-19T12:00:05Z').toUTCString() }),
      () => ok([]),
    ]);
    const pending = client.request(TOKEN, { method: 'GET', path: '/zones' });
    await vi.advanceTimersByTimeAsync(4_900);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    await pending;
    expect(calls).toHaveLength(2);
  });

  it('fails fast with retryAfterSeconds when Retry-After is past the cap', async () => {
    const { client, calls } = clientWith([() => fail(429, 10000, 'slow down', { 'retry-after': '120' })]);
    const error = await caught(client.request(TOKEN, { method: 'GET', path: '/zones' }));
    expect(error.kind).toBe('rate_limited');
    expect(error.retryAfterSeconds).toBe(120);
    expect(calls).toHaveLength(1);
  });

  it('does not wait past the caller operation deadline', async () => {
    const now = 1_000_000;
    const { client, calls } = clientWith([() => fail(429, 10000, 'slow down', { 'retry-after': '5' })], { now: () => now });
    const error = await caught(client.request(TOKEN, { method: 'GET', path: '/zones', deadlineAt: now + 2_000 }));
    expect(error.kind).toBe('rate_limited');
    expect(calls).toHaveLength(1);
  });

  it('parses Retry-After forms', () => {
    expect(parseRetryAfter('7', 0)).toBe(7);
    expect(parseRetryAfter(null, 0)).toBeNull();
    expect(parseRetryAfter('soon', 0)).toBeNull();
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 0)).toBe(10);
  });
});

describe('CloudflareApiClient deadlines', () => {
  it('times out a hung attempt after 10 s and retries a GET', async () => {
    vi.useFakeTimers();
    const { client, calls } = clientWith([hangUntilAborted, () => ok([])]);
    const pending = client.request(TOKEN, { method: 'GET', path: '/zones' });
    await vi.advanceTimersByTimeAsync(10_001);
    await pending;
    expect(calls).toHaveLength(2);
  });

  it('does not repeat a POST that timed out', async () => {
    vi.useFakeTimers();
    const { client, calls } = clientWith([hangUntilAborted]);
    const pending = caught(client.request(TOKEN, { method: 'POST', path: '/zones/z/dns_records', body: {} }));
    await vi.advanceTimersByTimeAsync(10_001);
    expect((await pending).kind).toBe('timeout');
    expect(calls).toHaveLength(1);
  });

  it('times out a body that stalls after the headers', async () => {
    vi.useFakeTimers();
    const stalled = () => new Response(new ReadableStream({ start() { /* never enqueues or closes */ } }), { status: 200 });
    const { client, calls } = clientWith([stalled]);
    const pending = caught(client.request(TOKEN, { method: 'POST', path: '/zones/z/dns_records', body: {} }));
    await vi.advanceTimersByTimeAsync(10_001);
    expect((await pending).kind).toBe('timeout');
    expect(calls).toHaveLength(1);
  });

  it('marks a POST cancelled during the wait before a retry as never sent', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { client, calls } = clientWith([() => fail(429, 10000, 'slow down', { 'retry-after': '5' })]);
    const pending = caught(client.request(TOKEN, { method: 'POST', path: '/zones/z/dns_records', body: {}, signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    const error = await pending;
    expect(error.preSend).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('marks a call stopped before sending as never sent', async () => {
    const controller = new AbortController();
    controller.abort();
    const { client, calls } = clientWith([() => ok({})]);
    const error = await caught(client.request(TOKEN, { method: 'POST', path: '/zones/z/dns_records', body: {}, signal: controller.signal }));
    expect(error.preSend).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('stops at the caller abort and never retries it', async () => {
    const controller = new AbortController();
    const { client, calls } = clientWith([(url, init) => {
      setTimeout(() => controller.abort(), 0);
      return hangUntilAborted(url, init);
    }]);
    const error = await caught(client.request(TOKEN, { method: 'GET', path: '/zones', signal: controller.signal }));
    expect(error.kind).toBe('timeout');
    expect(calls).toHaveLength(1);
  });

  it('reports a network error after retries', async () => {
    const { client, calls } = clientWith([() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }]);
    const error = await caught(client.request(TOKEN, { method: 'GET', path: '/zones' }));
    expect(error.kind).toBe('network');
    expect(error.message).toContain('ENOTFOUND');
    expect(calls).toHaveLength(3);
  });
});

describe('CloudflareApiClient pagination', () => {
  it('follows total_pages and returns every item', async () => {
    const { client, calls } = clientWith([
      (url) => ok([{ id: `p${url.searchParams.get('page')}` }], { page: Number(url.searchParams.get('page')), total_pages: 3 }),
    ]);
    const items = await client.paginate<{ id: string }>(TOKEN, '/zones', { 'account.id': 'a' }, 1);
    expect(items.map((i) => i.id)).toEqual(['p1', 'p2', 'p3']);
    expect(calls).toHaveLength(3);
    expect(calls[2].url.searchParams.get('account.id')).toBe('a');
  });

  it('never returns a partial list when a later page fails', async () => {
    const { client } = clientWith([
      () => ok([{ id: 1 }], { page: 1, total_pages: 2 }),
      () => fail(403, 9109, 'forbidden'),
    ]);
    expect((await caught(client.paginate(TOKEN, '/zones', {}, 1))).kind).toBe('forbidden');
  });

  it('stops after 100 pages', async () => {
    const { client, calls } = clientWith([() => ok([{ id: 1 }], { total_pages: 1000 })]);
    expect((await caught(client.paginate(TOKEN, '/zones', {}, 1))).kind).toBe('invalid_response');
    expect(calls).toHaveLength(100);
  });

  it('refuses a full page that carries no paging details', async () => {
    const { client } = clientWith([() => ok([{ id: 1 }, { id: 2 }])]);
    expect((await caught(client.paginate(TOKEN, '/zones', {}, 2))).kind).toBe('invalid_response');
  });

  it('accepts a short page without paging details as complete', async () => {
    const { client } = clientWith([() => ok([{ id: 1 }])]);
    expect(await client.paginate(TOKEN, '/zones', {}, 50)).toHaveLength(1);
  });
});

describe('CloudflareApiClient contradictory paging', () => {
  const zone = (id: string) => ({ id });
  const list = (info: Record<string, number>, items: Array<{ id: string }> = [zone('a')]) => clientWith([() => ok(items, info)]);

  it.each([
    ['zero total_pages beside a total_count the page does not hold', { page: 1, per_page: 50, count: 1, total_pages: 0, total_count: 2 }],
    ['a total_count the listing never reaches', { page: 1, per_page: 50, count: 1, total_pages: 1, total_count: 2 }],
    ['zero total_pages beside a listed item', { page: 1, per_page: 50, count: 1, total_pages: 0 }],
    ['a total_pages that does not follow from total_count', { page: 1, per_page: 50, count: 1, total_pages: 3, total_count: 1 }],
    ['a count that is not the page length', { page: 1, per_page: 50, count: 7, total_pages: 1 }],
    ['a page number that is not the one asked for', { page: 2, per_page: 50, count: 1, total_pages: 1 }],
    ['a total_count with no total_pages that the short page does not reach', { page: 1, per_page: 50, count: 1, total_count: 5 }],
  ])('refuses a listing with %s', async (_label, info) => {
    const { client } = list(info);
    expect((await caught(client.paginate(TOKEN, '/zones', {}, 50))).kind).toBe('invalid_response');
  });

  it('refuses a listing whose later pages run short of the total', async () => {
    const { client } = clientWith([
      (url) => ok(url.searchParams.get('page') === '1' ? [zone('a'), zone('b')] : [zone('c')], { page: Number(url.searchParams.get('page')), per_page: 2, total_pages: 2, total_count: 5 }),
    ]);
    expect((await caught(client.paginate(TOKEN, '/zones', {}, 2))).kind).toBe('invalid_response');
  });

  it('refuses an empty page in the middle of a listing', async () => {
    const { client } = clientWith([
      (url) => ok(url.searchParams.get('page') === '1' ? [zone('a')] : [], { page: Number(url.searchParams.get('page')), per_page: 1, total_pages: 3 }),
    ]);
    expect((await caught(client.paginate(TOKEN, '/zones', {}, 1))).kind).toBe('invalid_response');
  });

  it('refuses a short page when Cloudflare says it paged smaller than asked', async () => {
    const { client } = list({ page: 1, per_page: 1, count: 1 });
    expect((await caught(client.paginate(TOKEN, '/zones', {}, 50))).kind).toBe('invalid_response');
  });

  it.each([
    ['zero pages', { page: 1, per_page: 50, count: 0, total_pages: 0, total_count: 0 }],
    ['one empty page', { page: 1, per_page: 50, count: 0, total_pages: 1, total_count: 0 }],
    ['no total_count', { page: 1, per_page: 50, count: 0, total_pages: 0 }],
  ])('accepts an empty listing reported as %s', async (_label, info) => {
    const { client } = list(info, []);
    expect(await client.paginate(TOKEN, '/zones', {}, 50)).toEqual([]);
  });

  it('accepts a listing whose counts all agree across pages', async () => {
    const { client } = clientWith([
      (url) => ok(url.searchParams.get('page') === '1' ? [zone('a'), zone('b')] : [zone('c')], {
        page: Number(url.searchParams.get('page')), per_page: 2, count: url.searchParams.get('page') === '1' ? 2 : 1, total_pages: 2, total_count: 3,
      }),
    ]);
    expect((await client.paginate<{ id: string }>(TOKEN, '/zones', {}, 2)).map((z) => z.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('CloudflareApiClient request budget', () => {
  it('fails fast once 300 requests ran in five minutes, then recovers', async () => {
    let now = 0;
    const { client, calls } = clientWith([() => ok({})], { now: () => now });
    for (let i = 0; i < 300; i += 1) await client.request(TOKEN, { method: 'GET', path: '/x' });
    const error = await caught(client.request(TOKEN, { method: 'GET', path: '/x' }));
    expect(error.kind).toBe('budget_exhausted');
    expect(error.retryAfterSeconds).toBeGreaterThan(0);
    expect(calls).toHaveLength(300);
    now = 5 * 60_000 + 1;
    await client.request(TOKEN, { method: 'GET', path: '/x' });
    expect(calls).toHaveLength(301);
  });
});

describe('CloudflareApiClient caller deadline', () => {
  it.each(['GET', 'POST', 'DELETE'] as const)('sends no %s once the deadline has passed, and marks it as not sent', async (method) => {
    const now = 1_000_000;
    const { client, fetchImpl } = clientWith([() => ok({})], { now: () => now });
    const error = await caught(client.request(TOKEN, { method, path: '/zones/z/dns_records', body: method === 'POST' ? { type: 'TXT' } : undefined, deadlineAt: now }));
    expect(error.kind).toBe('timeout');
    expect(error.preSend).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends no listing page once the deadline has passed', async () => {
    const now = 1_000_000;
    const { client, fetchImpl } = clientWith([() => ok([], { total_pages: 1 })], { now: () => now });
    const error = await caught(client.paginate(TOKEN, '/zones', {}, 50, { deadlineAt: now - 1 }));
    expect(error.kind).toBe('timeout');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // `random` runs inside the retry decision after the remaining time was read and before the wait, so a jump there
  // is a clock that passes the deadline while an approved wait is running.
  it('sends no further attempt when the clock passes the deadline during an approved retry wait', async () => {
    let now = 1_000_000;
    const { client, calls } = clientWith([() => fail(500, 1000, 'Internal error'), () => ok({})], {
      now: () => now,
      random: () => { now += 5_000; return 0; },
    });
    const error = await caught(client.request(TOKEN, { method: 'GET', path: '/zones', deadlineAt: 1_000_000 + 2_000 }));
    expect(error.kind).toBe('timeout');
    expect(calls).toHaveLength(1);
  });

  it('sends no second POST when the clock passes the deadline during a rate-limit wait', async () => {
    let now = 1_000_000;
    const { client, calls } = clientWith([() => fail(429, 10000, 'slow down'), () => ok({ id: 'x' })], {
      now: () => now,
      random: () => { now += 5_000; return 0; },
    });
    const error = await caught(client.request(TOKEN, { method: 'POST', path: '/zones/z/dns_records', body: {}, deadlineAt: 1_000_000 + 2_000 }));
    expect(error.kind).toBe('timeout');
    expect(error.preSend).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('still sends while the deadline is ahead', async () => {
    const now = 1_000_000;
    const { client, calls } = clientWith([() => ok({ id: 'x' })], { now: () => now });
    await client.request(TOKEN, { method: 'POST', path: '/zones/z/dns_records', body: {}, deadlineAt: now + 1 });
    expect(calls).toHaveLength(1);
  });
});
