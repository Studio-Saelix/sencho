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
