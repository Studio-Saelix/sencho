/**
 * Unit tests for the registry HTTP client: digest-name matching (the local
 * RepoDigest vs image-ref comparison), getAuthToken's token-scope construction,
 * getRemoteDigest's HEAD-first lookup with GET fallback, and getRemoteDigestResult's
 * status-to-reason mapping.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Configurable https mock ───────────────────────────────────────────────
// getRemoteDigest first fetches an auth token, then probes the manifest. The
// mock routes by URL + method so each test controls the manifest response while
// the token request always succeeds.

interface FakeResp { statusCode: number; headers: Record<string, string>; body?: string; }

const calls: { url: string; method: string }[] = [];
let route: (url: string, method: string) => FakeResp;

function fakeRequest(url: string, options: { method?: string }, cb: (res: EventEmitter & { statusCode: number; headers: Record<string, string> }) => void) {
  const method = options?.method ?? 'GET';
  calls.push({ url, method });
  const resp = route(url, method);
  const res = Object.assign(new EventEmitter(), { statusCode: resp.statusCode, headers: resp.headers });
  const req = Object.assign(new EventEmitter(), {
    setTimeout: () => {},
    destroy: () => {},
    end: () => {
      cb(res);
      queueMicrotask(() => {
        if (resp.body) res.emit('data', Buffer.from(resp.body));
        res.emit('end');
      });
    },
  });
  return req;
}

vi.mock('https', () => ({ default: { request: (...args: unknown[]) => fakeRequest(...(args as Parameters<typeof fakeRequest>)) } }));
vi.mock('http', () => ({ default: { request: (...args: unknown[]) => fakeRequest(...(args as Parameters<typeof fakeRequest>)) } }));

import { repoDigestMatchesRef, getRemoteDigest, getRemoteDigestResult, getAuthToken, listRegistryTagsResult, parseImageRef } from '../services/registry-api';

const TOKEN_BODY = JSON.stringify({ token: 'test-token' });
const REMOTE = 'sha256:remote000000000000000000000000000000000000000000000000000000';

function tokenOk(url: string): FakeResp | null {
  if (url.includes('auth.docker.io/token')) return { statusCode: 200, headers: {}, body: TOKEN_BODY };
  return null;
}

describe('repoDigestMatchesRef', () => {
  const parsed = (ref: string) => {
    const p = parseImageRef(ref);
    if (!p) throw new Error(`unparseable ${ref}`);
    return p;
  };

  it('matches an official library image whose RepoDigest omits the library/ prefix', () => {
    // The exact false-negative the old substring check missed.
    expect(repoDigestMatchesRef('nginx@sha256:abc', parsed('nginx:latest'))).toBe(true);
  });

  it('matches a namespaced Docker Hub image', () => {
    expect(repoDigestMatchesRef('linuxserver/sonarr@sha256:abc', parsed('linuxserver/sonarr:latest'))).toBe(true);
  });

  it('treats docker.io / index.docker.io / registry-1.docker.io as the same registry', () => {
    expect(repoDigestMatchesRef('docker.io/library/nginx@sha256:abc', parsed('nginx:latest'))).toBe(true);
  });

  it('matches a private-registry image by registry + repo', () => {
    expect(repoDigestMatchesRef('ghcr.io/acme/api@sha256:abc', parsed('ghcr.io/acme/api:v1'))).toBe(true);
  });

  it('does not match a different repository', () => {
    expect(repoDigestMatchesRef('redis@sha256:abc', parsed('nginx:latest'))).toBe(false);
  });

  it('returns false for an entry without a digest', () => {
    expect(repoDigestMatchesRef('nginx:latest', parsed('nginx:latest'))).toBe(false);
  });
});

describe('getRemoteDigest HEAD-first lookup', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('returns the digest from a HEAD 200 without issuing a GET', async () => {
    route = (url, method) => tokenOk(url) ?? (
      method === 'HEAD'
        ? { statusCode: 200, headers: { 'docker-content-digest': REMOTE } }
        : { statusCode: 500, headers: {} }
    );
    const digest = await getRemoteDigest('registry-1.docker.io', 'library/nginx', 'latest');
    expect(digest).toBe(REMOTE);
    const manifestCalls = calls.filter(c => c.url.includes('/manifests/'));
    expect(manifestCalls).toHaveLength(1);
    expect(manifestCalls[0].method).toBe('HEAD');
  });

  it('falls back to GET when the registry rejects HEAD with 405', async () => {
    route = (url, method) => tokenOk(url) ?? (
      method === 'HEAD'
        ? { statusCode: 405, headers: {} }
        : { statusCode: 200, headers: { 'docker-content-digest': REMOTE } }
    );
    const digest = await getRemoteDigest('registry-1.docker.io', 'library/nginx', 'latest');
    expect(digest).toBe(REMOTE);
    expect(calls.filter(c => c.url.includes('/manifests/')).map(c => c.method)).toEqual(['HEAD', 'GET']);
  });

  it('falls back to GET when HEAD 200 omits the digest header', async () => {
    route = (url, method) => tokenOk(url) ?? (
      method === 'HEAD'
        ? { statusCode: 200, headers: {} }
        : { statusCode: 200, headers: { 'docker-content-digest': REMOTE } }
    );
    const digest = await getRemoteDigest('registry-1.docker.io', 'library/nginx', 'latest');
    expect(digest).toBe(REMOTE);
    expect(calls.filter(c => c.url.includes('/manifests/')).map(c => c.method)).toEqual(['HEAD', 'GET']);
  });

  it('returns null on a hard HEAD failure (429) without a GET retry', async () => {
    route = (url, method) => tokenOk(url) ?? (
      method === 'HEAD'
        ? { statusCode: 429, headers: {} }
        : { statusCode: 200, headers: { 'docker-content-digest': REMOTE } }
    );
    const digest = await getRemoteDigest('registry-1.docker.io', 'library/nginx', 'latest');
    expect(digest).toBeNull();
    expect(calls.filter(c => c.url.includes('/manifests/')).map(c => c.method)).toEqual(['HEAD']);
  });
});

describe('getAuthToken builds the token request for the target repository', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  // ghcr.io (and lscr.io, which delegates auth to it) echo a placeholder scope in the
  // context-less /v2/ ping. The token must be requested for the repo we actually want;
  // reusing the echoed scope made ghcr.io mint a token for the wrong repo and reject it.
  const GHCR_CHALLENGE = 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:user/image:pull"';

  it('ignores the placeholder scope echoed by the /v2/ ping and uses the target repo', async () => {
    route = (url, method): FakeResp => {
      if (url === 'https://ghcr.io/v2/') return { statusCode: 401, headers: { 'www-authenticate': GHCR_CHALLENGE } };
      if (url.startsWith('https://ghcr.io/token')) return { statusCode: 200, headers: {}, body: TOKEN_BODY };
      return method === 'HEAD' ? { statusCode: 200, headers: { 'docker-content-digest': REMOTE } } : { statusCode: 500, headers: {} };
    };
    const token = await getAuthToken('ghcr.io', 'linuxserver/radarr', null);
    expect(token).toBe('test-token');
    const tokenCall = calls.find(c => c.url.startsWith('https://ghcr.io/token'));
    expect(tokenCall).toBeTruthy();
    const decoded = decodeURIComponent(tokenCall?.url ?? '');
    expect(decoded).toContain('scope=repository:linuxserver/radarr:pull');
    expect(decoded).not.toContain('user/image');
  });

  it('returns null when the token endpoint rejects the request (403)', async () => {
    route = (url): FakeResp => {
      if (url === 'https://ghcr.io/v2/') return { statusCode: 401, headers: { 'www-authenticate': GHCR_CHALLENGE } };
      if (url.startsWith('https://ghcr.io/token')) return { statusCode: 403, headers: {} };
      return { statusCode: 200, headers: { 'docker-content-digest': REMOTE } };
    };
    expect(await getAuthToken('ghcr.io', 'linuxserver/radarr', null)).toBeNull();
  });
});

describe('getRemoteDigestResult failure reasons', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  const REF = 'registry-1.docker.io/library/nginx:latest';
  const get = () => getRemoteDigestResult('registry-1.docker.io', 'library/nginx', 'latest');
  // Token always succeeds; the HEAD response under test drives the outcome.
  const headResp = (resp: FakeResp) => (url: string, method: string): FakeResp =>
    tokenOk(url) ?? (method === 'HEAD' ? resp : { statusCode: 200, headers: { 'docker-content-digest': REMOTE } });

  it('returns the digest on a HEAD 200', async () => {
    route = headResp({ statusCode: 200, headers: { 'docker-content-digest': REMOTE } });
    expect(await get()).toEqual({ ok: true, digest: REMOTE });
  });

  it('maps 401 to an authentication failure', async () => {
    route = headResp({ statusCode: 401, headers: {} });
    expect(await get()).toEqual({ ok: false, reason: `Authentication failed for ${REF}` });
  });

  it('maps 429 to a rate-limit reason including retry-after', async () => {
    route = headResp({ statusCode: 429, headers: { 'retry-after': '3600' } });
    expect(await get()).toEqual({ ok: false, reason: `Rate limited by registry for ${REF} (retry after 3600)` });
  });

  it('maps 429 without retry-after to a plain rate-limit reason', async () => {
    route = headResp({ statusCode: 429, headers: {} });
    expect(await get()).toEqual({ ok: false, reason: `Rate limited by registry for ${REF}` });
  });

  it('maps 403 to an authentication failure', async () => {
    route = headResp({ statusCode: 403, headers: {} });
    expect(await get()).toEqual({ ok: false, reason: `Authentication failed for ${REF}` });
  });

  it('maps an unexpected status to a generic reason with the status code', async () => {
    route = headResp({ statusCode: 400, headers: {} });
    expect(await get()).toEqual({ ok: false, reason: `Registry returned status 400 for ${REF}` });
  });

  it('maps 404 to image not found', async () => {
    route = headResp({ statusCode: 404, headers: {} });
    expect(await get()).toEqual({ ok: false, reason: `Image not found: ${REF}` });
  });

  it('maps 5xx to a registry error with the status', async () => {
    route = headResp({ statusCode: 503, headers: {} });
    expect(await get()).toEqual({ ok: false, reason: `Registry error (503) for ${REF}` });
  });

  it('derives the reason from the GET fallback when HEAD is 405', async () => {
    route = (url, method) => tokenOk(url) ?? (method === 'HEAD' ? { statusCode: 405, headers: {} } : { statusCode: 401, headers: {} });
    expect(await get()).toEqual({ ok: false, reason: `Authentication failed for ${REF}` });
  });

  it('fails when both HEAD and GET are 200 but omit the digest header', async () => {
    route = (url, method) => tokenOk(url) ?? (method === 'HEAD' ? { statusCode: 200, headers: {} } : { statusCode: 200, headers: {} });
    expect(await get()).toEqual({ ok: false, reason: `Registry returned no digest for ${REF}` });
  });

  it('reports unreachable when the request throws, including the error cause', async () => {
    route = () => { throw new Error('ENOTFOUND'); };
    expect(await get()).toEqual({ ok: false, reason: `Registry unreachable for ${REF} (ENOTFOUND)` });
  });

  it('falls back to anonymous manifest lookup when auth transport fails', async () => {
    route = (url, method) => {
      if (url.includes('auth.docker.io/token')) {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      }
      if (method === 'HEAD') return { statusCode: 200, headers: { 'docker-content-digest': REMOTE } };
      return { statusCode: 500, headers: {} };
    };
    expect(await get()).toEqual({ ok: true, digest: REMOTE });
  });
});

describe('listRegistryTagsResult', () => {
  const creds = { username: 'u', password: 'p' };
  const GHCR_CHALLENGE = 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:user/image:pull"';

  beforeEach(() => {
    calls.length = 0;
  });

  function authThenTags(tagResp: FakeResp): (url: string, method: string) => FakeResp {
    return (url) => {
      if (url === 'https://ghcr.io/v2/') return { statusCode: 401, headers: { 'www-authenticate': GHCR_CHALLENGE } };
      if (url.startsWith('https://ghcr.io/token')) return { statusCode: 200, headers: {}, body: TOKEN_BODY };
      if (url.includes('/tags/list')) return tagResp;
      return { statusCode: 500, headers: {} };
    };
  }

  async function expectFailure(code: string, message?: string): Promise<void> {
    const result = await listRegistryTagsResult('ghcr.io', 'acme/app', creds);
    expect(result).toMatchObject(message ? { ok: false, code, message } : { ok: false, code });
  }

  it('returns tags on a successful list', async () => {
    route = authThenTags({ statusCode: 200, headers: {}, body: JSON.stringify({ tags: ['latest', '1.0'] }) });
    await expect(listRegistryTagsResult('ghcr.io', 'acme/app', creds)).resolves.toEqual({
      ok: true,
      tags: ['latest', '1.0'],
    });
  });

  it('maps transport failure during auth ping to REGISTRY_UPSTREAM (not UNAUTHORIZED)', async () => {
    route = () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); };
    await expectFailure('REGISTRY_UPSTREAM', 'Registry unreachable');
  });

  it('maps a rejected token to REGISTRY_UNAUTHORIZED', async () => {
    route = (url): FakeResp => {
      if (url === 'https://ghcr.io/v2/') return { statusCode: 401, headers: { 'www-authenticate': GHCR_CHALLENGE } };
      if (url.startsWith('https://ghcr.io/token')) return { statusCode: 401, headers: {} };
      return { statusCode: 200, headers: {}, body: '{}' };
    };
    await expectFailure('REGISTRY_UNAUTHORIZED', 'Registry rejected credentials');
  });

  it('maps 403 on tags/list to REGISTRY_FORBIDDEN', async () => {
    route = authThenTags({ statusCode: 403, headers: {} });
    await expectFailure('REGISTRY_FORBIDDEN');
  });

  it('maps 429 on tags/list to REGISTRY_RATE_LIMITED', async () => {
    route = authThenTags({ statusCode: 429, headers: {} });
    await expectFailure('REGISTRY_RATE_LIMITED');
  });

  it('maps invalid JSON to REGISTRY_INVALID_RESPONSE', async () => {
    route = authThenTags({ statusCode: 200, headers: {}, body: 'not-json' });
    await expectFailure('REGISTRY_INVALID_RESPONSE', 'Registry returned invalid JSON');
  });

  it('maps a non-array tags field to REGISTRY_INVALID_RESPONSE', async () => {
    route = authThenTags({ statusCode: 200, headers: {}, body: JSON.stringify({ tags: 'latest' }) });
    await expectFailure('REGISTRY_INVALID_RESPONSE', 'Registry tag list was malformed');
  });

  it('maps an oversized body to REGISTRY_INVALID_RESPONSE', async () => {
    const huge = '{"tags":["' + 'x'.repeat(2 * 1024 * 1024) + '"]}';
    route = authThenTags({ statusCode: 200, headers: {}, body: huge });
    await expectFailure('REGISTRY_INVALID_RESPONSE', 'Registry tag list response too large');
  });
});
