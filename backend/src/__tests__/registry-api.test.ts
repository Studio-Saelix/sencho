/**
 * Unit tests for the registry HTTP client: digest-name matching (the local
 * RepoDigest vs image-ref comparison), getAuthToken's token-scope construction,
 * getRemoteDigest's HEAD-first lookup with GET fallback, and getRemoteDigestResult's
 * status-to-reason mapping.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';

// ── Configurable https mock ───────────────────────────────────────────────
// getRemoteDigest first fetches an auth token, then probes the manifest. The
// mock routes by URL + method so each test controls the manifest response while
// the token request always succeeds.

interface FakeResp {
  statusCode: number;
  headers: Record<string, string>;
  body?: string;
  /** When set, emitted as separate data events (for UTF-8 chunk-boundary tests). */
  bodyChunks?: Buffer[];
}

const calls: { url: string; method: string }[] = [];
let route: (url: string, method: string) => FakeResp;

function fakeRequest(url: string, options: { method?: string }, cb: (res: EventEmitter & { statusCode: number; headers: Record<string, string>; destroy: () => void }) => void) {
  const method = options?.method ?? 'GET';
  calls.push({ url, method });
  const resp = route(url, method);
  // `destroy` is a no-op stub: httpGetCapped calls it when a response exceeds
  // the streaming size cap, which the fake response otherwise lacks (a real
  // http.IncomingMessage is a Readable stream and always has it).
  const res = Object.assign(new EventEmitter(), { statusCode: resp.statusCode, headers: resp.headers, destroy: () => {} });
  const req = Object.assign(new EventEmitter(), {
    setTimeout: () => {},
    destroy: () => {},
    end: () => {
      cb(res);
      queueMicrotask(() => {
        if (resp.bodyChunks) {
          for (const chunk of resp.bodyChunks) res.emit('data', chunk);
        } else if (resp.body) {
          res.emit('data', Buffer.from(resp.body));
        }
        res.emit('end');
      });
    },
  });
  return req;
}

vi.mock('https', () => ({ default: { request: (...args: unknown[]) => fakeRequest(...(args as Parameters<typeof fakeRequest>)) } }));
vi.mock('http', () => ({ default: { request: (...args: unknown[]) => fakeRequest(...(args as Parameters<typeof fakeRequest>)) } }));

import {
  repoDigestMatchesRef,
  getRemoteDigest,
  getRemoteDigestResult,
  getAuthToken,
  listRegistryTags,
  listRegistryTagsResult,
  parseImageRef,
  selectLocalRepoDigest,
  selectLocalRepoDigests,
  compareLocalToRemoteTag,
  compareLocalToRemoteTagDetailed,
  MANIFEST_CLASSIFICATION_CACHE_TTL_MS,
  MANIFEST_INDEX_DESCRIPTOR_CAP,
  MANIFEST_INDEX_MAX_DEPTH,
} from '../services/registry-api';
import { CacheService } from '../services/CacheService';

beforeEach(() => {
  CacheService.getInstance().flush();
});

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

describe('parseImageRef', () => {
  // docker.io / index.docker.io / registry-1.docker.io are the same registry, but only
  // the literal 'registry-1.docker.io' is recognized elsewhere (getAuthToken, the
  // library/ auto-prefix in parseImageRef). An unnormalized 'docker.io' or 'index.docker.io'
  // leaks through into request URLs and hits the marketing domain instead of the registry API.
  // Each alias is listed with and without an explicit library/ namespace to pin both paths.
  it.each([
    'docker.io/library/traefik:latest',
    'docker.io/traefik:latest',
    'index.docker.io/library/traefik:latest',
    'index.docker.io/traefik:latest',
  ])('normalizes %s to the registry API host and the library/ namespace', (ref) => {
    expect(parseImageRef(ref)).toEqual({
      registry: 'registry-1.docker.io',
      repo: 'library/traefik',
      tag: 'latest',
    });
  });

  it('leaves a bare official image name unchanged (regression guard)', () => {
    expect(parseImageRef('traefik:latest')).toEqual({
      registry: 'registry-1.docker.io',
      repo: 'library/traefik',
      tag: 'latest',
    });
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

  it('succeeds from the digest header even when the manifest body is malformed (no index expansion on this path)', async () => {
    route = (url, method) => tokenOk(url) ?? (
      method === 'HEAD'
        ? { statusCode: 405, headers: {} }
        : { statusCode: 200, headers: { 'docker-content-digest': REMOTE }, body: 'not-json-at-all{{{' }
    );
    expect(await get()).toEqual({ ok: true, digest: REMOTE });
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
    route = (url, method): FakeResp => {
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

describe('listRegistryTags (compatibility wrapper)', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('lists tags for a public Docker Hub repository with no credentials configured', async () => {
    route = (url) => tokenOk(url) ?? (
      url.includes('/tags/list')
        ? { statusCode: 200, headers: {}, body: JSON.stringify({ tags: ['8.7.0', '8.8.0'] }) }
        : { statusCode: 500, headers: {} }
    );
    await expect(listRegistryTags('registry-1.docker.io', 'library/redis', null)).resolves.toEqual(['8.7.0', '8.8.0']);
  });

  it('still returns empty for a registry that actually requires credentials the caller does not have', async () => {
    const CHALLENGE = 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:user/image:pull"';
    route = (url): FakeResp => {
      if (url === 'https://ghcr.io/v2/') return { statusCode: 401, headers: { 'www-authenticate': CHALLENGE } };
      if (url.startsWith('https://ghcr.io/token')) return { statusCode: 401, headers: {} };
      return { statusCode: 500, headers: {} };
    };
    await expect(listRegistryTags('ghcr.io', 'private/app', undefined)).resolves.toEqual([]);
  });
});

// ─── selectLocalRepoDigest ───────────────────────────────────────────────

describe('selectLocalRepoDigest', () => {
  const parsed = (ref: string) => {
    const p = parseImageRef(ref);
    if (!p) throw new Error(`unparseable ${ref}`);
    return p;
  };
  const DIGEST_A = `sha256:${'a'.repeat(64)}`;
  const DIGEST_B = `sha256:${'b'.repeat(64)}`;

  it('picks the entry matching the parsed ref among multiple valid digests', () => {
    const repoDigests = [`redis@${DIGEST_B}`, `nginx@${DIGEST_A}`];
    expect(selectLocalRepoDigest(repoDigests, parsed('nginx:latest'))).toBe(DIGEST_A);
  });

  it('returns null when the sole valid entry belongs to an unrelated repository, rather than guessing', () => {
    const repoDigests = [`ghcr.io/other/image@${DIGEST_A}`];
    expect(selectLocalRepoDigest(repoDigests, parsed('nginx:latest'))).toBeNull();
  });

  it('returns null when multiple valid entries exist and none matches the ref', () => {
    const repoDigests = [`redis@${DIGEST_A}`, `postgres@${DIGEST_B}`];
    expect(selectLocalRepoDigest(repoDigests, parsed('nginx:latest'))).toBeNull();
  });

  it('returns null for a truncated (non-64-hex) digest even as the sole entry', () => {
    expect(selectLocalRepoDigest(['nginx@sha256:abc123'], parsed('nginx:latest'))).toBeNull();
  });

  it('returns null for an entry with no @ separator', () => {
    expect(selectLocalRepoDigest(['nginx:latest'], parsed('nginx:latest'))).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(selectLocalRepoDigest([], parsed('nginx:latest'))).toBeNull();
  });

  it('ignores a malformed entry when picking among multiple, still finds the ref match', () => {
    const repoDigests = ['nginx@sha256:tooshort', `nginx@${DIGEST_A}`];
    expect(selectLocalRepoDigest(repoDigests, parsed('nginx:latest'))).toBe(DIGEST_A);
  });

  it('is case-insensitive for hex digit casing', () => {
    const upper = `sha256:${'A'.repeat(64)}`;
    expect(selectLocalRepoDigest([`nginx@${upper}`], parsed('nginx:latest'))).toBe(upper);
  });
});

// ─── selectLocalRepoDigests ──────────────────────────────────────────────

describe('selectLocalRepoDigests', () => {
  const parsed = (ref: string) => {
    const p = parseImageRef(ref);
    if (!p) throw new Error(`unparseable ${ref}`);
    return p;
  };
  const DIGEST_A = `sha256:${'a'.repeat(64)}`;
  const DIGEST_B = `sha256:${'b'.repeat(64)}`;
  const DIGEST_C = `sha256:${'c'.repeat(64)}`;

  it('returns every matching entry in first-seen order', () => {
    const repoDigests = [`redis@${DIGEST_A}`, `nginx@${DIGEST_B}`, `redis@${DIGEST_C}`];
    expect(selectLocalRepoDigests(repoDigests, parsed('redis:8.8.0'))).toEqual([DIGEST_A, DIGEST_C]);
  });

  it('deduplicates matching digests while preserving first-seen order', () => {
    const repoDigests = [`redis@${DIGEST_A}`, `redis@${DIGEST_B}`, `redis@${DIGEST_A}`];
    expect(selectLocalRepoDigests(repoDigests, parsed('redis:latest'))).toEqual([DIGEST_A, DIGEST_B]);
  });

  it('deduplicates case-insensitively on hex digits', () => {
    const upper = `sha256:${'A'.repeat(64)}`;
    const lower = `sha256:${'a'.repeat(64)}`;
    expect(selectLocalRepoDigests([`nginx@${upper}`, `nginx@${lower}`], parsed('nginx:latest'))).toEqual([upper]);
  });

  it('filters malformed entries and keeps valid matches', () => {
    const repoDigests = ['redis@sha256:tooshort', `redis@${DIGEST_A}`, 'redis:latest', `redis@${DIGEST_B}`];
    expect(selectLocalRepoDigests(repoDigests, parsed('redis:latest'))).toEqual([DIGEST_A, DIGEST_B]);
  });

  it('returns empty when the sole valid entry belongs to an unrelated repository, rather than guessing', () => {
    // A legitimate retag can leave a lone RepoDigest from a different repo, but
    // comparing it against this ref's registry state risks a false update
    // against a registry that has nothing to do with the declared image.
    expect(selectLocalRepoDigests([`ghcr.io/other/image@${DIGEST_A}`], parsed('nginx:latest'))).toEqual([]);
  });

  it('returns empty when multiple valid entries exist and none matches the ref', () => {
    expect(selectLocalRepoDigests([`redis@${DIGEST_A}`, `postgres@${DIGEST_B}`], parsed('nginx:latest'))).toEqual([]);
  });

  it('returns empty for an empty list', () => {
    expect(selectLocalRepoDigests([], parsed('nginx:latest'))).toEqual([]);
  });

  it('returns every matching RepoDigest for the image ref', () => {
    const digests = selectLocalRepoDigests([
      `nginx@${DIGEST_A}`,
      `nginx@${DIGEST_B}`,
      `redis@sha256:${'c'.repeat(64)}`,
    ], parsed('nginx:latest'));
    expect(digests).toEqual([DIGEST_A, DIGEST_B]);
  });
});

// ─── compareLocalToRemoteTag ─────────────────────────────────────────────
//
// Reproduces and fixes the false-positive multi-arch update: a local
// RepoDigest can be a platform child manifest while the registry's tag
// resolves to the parent index digest. These tests drive the HEAD/GET
// transport and the index-expansion classification directly.

describe('compareLocalToRemoteTag', () => {
  const REGISTRY = 'registry-1.docker.io';
  const REPO = 'someorg/someapp';
  const TAG = 'latest';
  const MANIFEST_URL_TAG = `https://${REGISTRY}/v2/${REPO}/manifests/${TAG}`;
  const manifestDigestUrl = (digest: string, repo: string = REPO) => `https://${REGISTRY}/v2/${repo}/manifests/${digest}`;

  const CHILD_AMD64 = `sha256:${'c'.repeat(64)}`;
  const CHILD_ARM64 = `sha256:${'b'.repeat(64)}`;
  const SINGLE_DIGEST = `sha256:${'d'.repeat(64)}`;

  const AMD64 = { os: 'linux', architecture: 'amd64' };
  const ARM64 = { os: 'linux', architecture: 'arm64' };

  const INDEX_CONTENT_TYPE = 'application/vnd.oci.image.index.v1+json';

  interface DescriptorSpec {
    digest: string;
    os: string;
    architecture: string;
    variant?: string;
    annotations?: Record<string, string>;
  }

  function indexBody(entries: DescriptorSpec[]): string {
    return JSON.stringify({
      schemaVersion: 2,
      mediaType: INDEX_CONTENT_TYPE,
      manifests: entries.map((e) => ({
        digest: e.digest,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        platform: { os: e.os, architecture: e.architecture, ...(e.variant ? { variant: e.variant } : {}) },
        ...(e.annotations ? { annotations: e.annotations } : {}),
      })),
    });
  }

  function contentDigest(body: string): string {
    return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
  }

  /** HEAD the tag for `primary`, then serve digest-pinned GET bodies (or custom FakeResp). */
  function routePrimaryDigest(
    primary: string,
    digests: Record<string, string | FakeResp>,
  ): (url: string, method: string) => FakeResp {
    return (url, method) => {
      const token = tokenOk(url);
      if (token) return token;
      if (url === MANIFEST_URL_TAG && method === 'HEAD') {
        return { statusCode: 200, headers: { 'docker-content-digest': primary, 'content-type': INDEX_CONTENT_TYPE } };
      }
      if (method === 'GET') {
        for (const [digest, payload] of Object.entries(digests)) {
          if (url !== manifestDigestUrl(digest)) continue;
          return typeof payload === 'string'
            ? { statusCode: 200, headers: { 'docker-content-digest': digest }, body: payload }
            : payload;
        }
      }
      return { statusCode: 500, headers: {} };
    };
  }

  const STANDARD_INDEX_BODY = indexBody([
    { digest: CHILD_AMD64, os: 'linux', architecture: 'amd64' },
    { digest: CHILD_ARM64, os: 'linux', architecture: 'arm64' },
  ]);
  // Content-addressed: digest-pinned GETs verify sha256(body) === requested digest.
  const INDEX_DIGEST = contentDigest(STANDARD_INDEX_BODY);

  beforeEach(() => {
    calls.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns match with no expansion GET when the local digest equals the primary digest from HEAD', async () => {
    route = (url, method) => tokenOk(url) ?? (
      method === 'HEAD'
        ? { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST, 'content-type': INDEX_CONTENT_TYPE } }
        : { statusCode: 500, headers: {} }
    );
    const result = await compareLocalToRemoteTag([INDEX_DIGEST], REGISTRY, REPO, TAG, AMD64);
    expect(result).toEqual({ kind: 'match' });
    expect(calls.filter((c) => c.url.includes('/manifests/'))).toHaveLength(1);
  });

  it('expands the index with a single digest-pinned GET and matches a runnable child descriptor', async () => {
    route = (url, method) => {
      const token = tokenOk(url);
      if (token) return token;
      if (url === MANIFEST_URL_TAG && method === 'HEAD') {
        return { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST, 'content-type': INDEX_CONTENT_TYPE } };
      }
      if (url === manifestDigestUrl(INDEX_DIGEST) && method === 'GET') {
        return { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST }, body: STANDARD_INDEX_BODY };
      }
      return { statusCode: 500, headers: {} };
    };
    const result = await compareLocalToRemoteTag([CHILD_AMD64], REGISTRY, REPO, TAG, AMD64);
    expect(result).toEqual({ kind: 'match' });
    expect(calls.filter((c) => c.url.includes('/manifests/'))).toEqual([
      { url: MANIFEST_URL_TAG, method: 'HEAD' },
      { url: manifestDigestUrl(INDEX_DIGEST), method: 'GET' },
    ]);
  });

  // #1684: Docker can list a stale index digest ahead of the current one.
  const STALE_INDEX = `sha256:${'f'.repeat(64)}`;

  it('matches when a later candidate equals the primary even if the first candidate is a stale index', async () => {
    route = (url, method) => tokenOk(url) ?? (
      method === 'HEAD'
        ? { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST, 'content-type': INDEX_CONTENT_TYPE } }
        : { statusCode: 500, headers: {} }
    );
    const result = await compareLocalToRemoteTag([STALE_INDEX, INDEX_DIGEST], REGISTRY, REPO, TAG, AMD64);
    expect(result).toEqual({ kind: 'match' });
    expect(calls.filter((c) => c.url.includes('/manifests/'))).toHaveLength(1);
  });

  it('matches when the current primary is first among multiple candidates', async () => {
    route = (url, method) => tokenOk(url) ?? (
      method === 'HEAD'
        ? { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST, 'content-type': INDEX_CONTENT_TYPE } }
        : { statusCode: 500, headers: {} }
    );
    const result = await compareLocalToRemoteTag([INDEX_DIGEST, STALE_INDEX], REGISTRY, REPO, TAG, AMD64);
    expect(result).toEqual({ kind: 'match' });
  });

  it('expands the index once when a later candidate matches a platform child', async () => {
    route = (url, method) => {
      const token = tokenOk(url);
      if (token) return token;
      if (url === MANIFEST_URL_TAG && method === 'HEAD') {
        return { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST, 'content-type': INDEX_CONTENT_TYPE } };
      }
      if (url === manifestDigestUrl(INDEX_DIGEST) && method === 'GET') {
        return { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST }, body: STANDARD_INDEX_BODY };
      }
      return { statusCode: 500, headers: {} };
    };
    const result = await compareLocalToRemoteTag([STALE_INDEX, CHILD_AMD64], REGISTRY, REPO, TAG, AMD64);
    expect(result).toEqual({ kind: 'match' });
    expect(calls.filter((c) => c.url.includes('/manifests/'))).toEqual([
      { url: MANIFEST_URL_TAG, method: 'HEAD' },
      { url: manifestDigestUrl(INDEX_DIGEST), method: 'GET' },
    ]);
  });

  it('reports update when every candidate is stale after a complete index classification', async () => {
    route = (url, method) => {
      const token = tokenOk(url);
      if (token) return token;
      if (url === MANIFEST_URL_TAG && method === 'HEAD') {
        return { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST, 'content-type': INDEX_CONTENT_TYPE } };
      }
      if (url === manifestDigestUrl(INDEX_DIGEST) && method === 'GET') {
        return { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST }, body: STANDARD_INDEX_BODY };
      }
      return { statusCode: 500, headers: {} };
    };
    const result = await compareLocalToRemoteTag([STALE_INDEX], REGISTRY, REPO, TAG, AMD64);
    expect(result).toEqual({ kind: 'update' });
  });

  it('errors (not update) when the remote index has no descriptor at all for the local platform', async () => {
    // STANDARD_INDEX_BODY only carries linux/amd64 and linux/arm64 children.
    // A windows/amd64 node cannot pull anything from this index; that is not
    // the same fact as "a newer build is available".
    route = (url, method) => {
      const token = tokenOk(url);
      if (token) return token;
      if (url === MANIFEST_URL_TAG && method === 'HEAD') {
        return { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST, 'content-type': INDEX_CONTENT_TYPE } };
      }
      if (url === manifestDigestUrl(INDEX_DIGEST) && method === 'GET') {
        return { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST }, body: STANDARD_INDEX_BODY };
      }
      return { statusCode: 500, headers: {} };
    };
    const result = await compareLocalToRemoteTag([STALE_INDEX], REGISTRY, REPO, TAG, { os: 'windows', architecture: 'amd64' });
    expect(result).toEqual({ kind: 'error', reason: expect.stringContaining('no windows/amd64 variant') });
  });

  it('errors (not update) for an empty index with no manifests, rather than a speculative update', async () => {
    const emptyIndexBody = indexBody([]);
    const emptyIndexDigest = contentDigest(emptyIndexBody);
    route = (url, method) => {
      const token = tokenOk(url);
      if (token) return token;
      if (url === MANIFEST_URL_TAG && method === 'HEAD') {
        return { statusCode: 200, headers: { 'docker-content-digest': emptyIndexDigest, 'content-type': INDEX_CONTENT_TYPE } };
      }
      if (url === manifestDigestUrl(emptyIndexDigest) && method === 'GET') {
        return { statusCode: 200, headers: { 'docker-content-digest': emptyIndexDigest }, body: emptyIndexBody };
      }
      return { statusCode: 500, headers: {} };
    };
    const result = await compareLocalToRemoteTag([STALE_INDEX], REGISTRY, REPO, TAG, AMD64);
    expect(result.kind).toBe('error');
  });

  it('errors (not update) for an index whose only entries are filtered out (attestation-only), not just a literally empty one', async () => {
    // Exercises the filtering path (parseIndexBody's attestation-manifest and
    // unknown/unknown continues), distinct from manifests:[] never entering
    // the per-entry loop at all.
    const filteredIndexBody = indexBody([
      {
        digest: CHILD_AMD64, os: 'unknown', architecture: 'unknown',
        annotations: { 'vnd.docker.reference.type': 'attestation-manifest', 'vnd.docker.reference.digest': CHILD_ARM64 },
      },
    ]);
    const filteredIndexDigest = contentDigest(filteredIndexBody);
    route = (url, method) => {
      const token = tokenOk(url);
      if (token) return token;
      if (url === MANIFEST_URL_TAG && method === 'HEAD') {
        return { statusCode: 200, headers: { 'docker-content-digest': filteredIndexDigest, 'content-type': INDEX_CONTENT_TYPE } };
      }
      if (url === manifestDigestUrl(filteredIndexDigest) && method === 'GET') {
        return { statusCode: 200, headers: { 'docker-content-digest': filteredIndexDigest }, body: filteredIndexBody };
      }
      return { statusCode: 500, headers: {} };
    };
    const result = await compareLocalToRemoteTag([STALE_INDEX], REGISTRY, REPO, TAG, AMD64);
    expect(result).toEqual({ kind: 'error', reason: expect.stringContaining('no linux/amd64 variant') });
  });

  it('matches (not errors) a platform-less runnable descriptor even though no platform-labeled descriptor exists', async () => {
    // OCI allows a runnable descriptor to omit platform; parseIndexBody routes
    // it to exactDigests. The index has real, pullable content, so this must
    // not be confused with the "nothing to pull" case.
    const platformlessDigest = `sha256:${'7'.repeat(64)}`;
    const noPlatformBody = JSON.stringify({
      schemaVersion: 2,
      mediaType: INDEX_CONTENT_TYPE,
      manifests: [{ digest: platformlessDigest, mediaType: 'application/vnd.oci.image.manifest.v1+json' }],
    });
    const noPlatformDigest = contentDigest(noPlatformBody);
    route = (url, method) => {
      const token = tokenOk(url);
      if (token) return token;
      if (url === MANIFEST_URL_TAG && method === 'HEAD') {
        return { statusCode: 200, headers: { 'docker-content-digest': noPlatformDigest, 'content-type': INDEX_CONTENT_TYPE } };
      }
      if (url === manifestDigestUrl(noPlatformDigest) && method === 'GET') {
        return { statusCode: 200, headers: { 'docker-content-digest': noPlatformDigest }, body: noPlatformBody };
      }
      return { statusCode: 500, headers: {} };
    };
    const result = await compareLocalToRemoteTag([platformlessDigest], REGISTRY, REPO, TAG, AMD64);
    expect(result).toEqual({ kind: 'match' });
  });

  it('errors (not update) for a mixed index: a platform-less leaf cannot be attributed when another descriptor is explicitly labeled for a different platform', async () => {
    // Regression: an index with one arm64-labeled descriptor and one
    // unlabeled leaf must not let the unlabeled leaf stand in as amd64
    // content just because SOME descriptor in the index is unlabeled.
    const unrelatedLeaf = `sha256:${'6'.repeat(64)}`;
    const mixedIndexBody = JSON.stringify({
      schemaVersion: 2,
      mediaType: INDEX_CONTENT_TYPE,
      manifests: [
        { digest: CHILD_ARM64, mediaType: 'application/vnd.oci.image.manifest.v1+json', platform: { os: 'linux', architecture: 'arm64' } },
        { digest: unrelatedLeaf, mediaType: 'application/vnd.oci.image.manifest.v1+json' },
      ],
    });
    const mixedIndexDigest = contentDigest(mixedIndexBody);
    route = (url, method) => {
      const token = tokenOk(url);
      if (token) return token;
      if (url === MANIFEST_URL_TAG && method === 'HEAD') {
        return { statusCode: 200, headers: { 'docker-content-digest': mixedIndexDigest, 'content-type': INDEX_CONTENT_TYPE } };
      }
      if (url === manifestDigestUrl(mixedIndexDigest) && method === 'GET') {
        return { statusCode: 200, headers: { 'docker-content-digest': mixedIndexDigest }, body: mixedIndexBody };
      }
      return { statusCode: 500, headers: {} };
    };
    // A local candidate that matches neither the arm64 descriptor nor the
    // unlabeled leaf: with no confirmed amd64 variant, this must fail closed.
    const result = await compareLocalToRemoteTag([STALE_INDEX], REGISTRY, REPO, TAG, AMD64);
    expect(result).toEqual({ kind: 'error', reason: expect.stringContaining('no confirmed linux/amd64 variant') });
  });

  it('errors (not update) when a nested index also has no descriptor for the local platform after full expansion', async () => {
    const nestedIndexBody = indexBody([{ digest: CHILD_ARM64, os: 'linux', architecture: 'arm64' }]);
    const nestedIndexDigest = contentDigest(nestedIndexBody);
    const outerIndexBody = JSON.stringify({
      schemaVersion: 2,
      mediaType: INDEX_CONTENT_TYPE,
      manifests: [{ digest: nestedIndexDigest, mediaType: INDEX_CONTENT_TYPE }],
    });
    const outerIndexDigest = contentDigest(outerIndexBody);
    route = (url, method) => {
      const token = tokenOk(url);
      if (token) return token;
      if (url === MANIFEST_URL_TAG && method === 'HEAD') {
        return { statusCode: 200, headers: { 'docker-content-digest': outerIndexDigest, 'content-type': INDEX_CONTENT_TYPE } };
      }
      if (url === manifestDigestUrl(outerIndexDigest) && method === 'GET') {
        return { statusCode: 200, headers: { 'docker-content-digest': outerIndexDigest }, body: outerIndexBody };
      }
      if (url === manifestDigestUrl(nestedIndexDigest) && method === 'GET') {
        return { statusCode: 200, headers: { 'docker-content-digest': nestedIndexDigest }, body: nestedIndexBody };
      }
      return { statusCode: 500, headers: {} };
    };
    // The outer index only nests an arm64-only child index; an amd64 node has
    // no descriptor anywhere in the fully-expanded tree.
    const result = await compareLocalToRemoteTag([STALE_INDEX], REGISTRY, REPO, TAG, AMD64);
    expect(result).toEqual({ kind: 'error', reason: expect.stringContaining('no linux/amd64 variant') });
  });

  it('never re-fetches the mutable tag: the expansion GET targets the primary digest from HEAD, not a second tag lookup', async () => {
    const DIVERGED_DIGEST = `sha256:${'e'.repeat(64)}`;
    let tagCallCount = 0;
    route = (url, method) => {
      const token = tokenOk(url);
      if (token) return token;
      if (url === MANIFEST_URL_TAG) {
        tagCallCount++;
        if (method === 'HEAD') {
          return { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST, 'content-type': INDEX_CONTENT_TYPE } };
        }
        // A hypothetical second tag lookup racing to a different digest; the
        // resolver must never issue this call once a primary digest is set.
        return { statusCode: 200, headers: { 'docker-content-digest': DIVERGED_DIGEST } };
      }
      if (url === manifestDigestUrl(INDEX_DIGEST) && method === 'GET') {
        return { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST }, body: STANDARD_INDEX_BODY };
      }
      return { statusCode: 500, headers: {} };
    };
    const result = await compareLocalToRemoteTag([CHILD_AMD64], REGISTRY, REPO, TAG, AMD64);
    expect(result).toEqual({ kind: 'match' });
    expect(tagCallCount).toBe(1);
  });

  it('reports update without a body fetch when the mismatched primary has a known single-manifest media type', async () => {
    route = (url, method) => tokenOk(url) ?? (
      method === 'HEAD'
        ? { statusCode: 200, headers: { 'docker-content-digest': SINGLE_DIGEST, 'content-type': 'application/vnd.docker.distribution.manifest.v2+json' } }
        : { statusCode: 500, headers: {} }
    );
    const result = await compareLocalToRemoteTag([CHILD_AMD64], REGISTRY, REPO, TAG, AMD64);
    expect(result).toEqual({ kind: 'update' });
    expect(calls.filter((c) => c.url.includes('/manifests/'))).toHaveLength(1);
  });

  it('classifies from the HEAD-fallback GET body without a second expansion request (HEAD 405)', async () => {
    route = (url, method) => {
      const token = tokenOk(url);
      if (token) return token;
      if (url === MANIFEST_URL_TAG) {
        if (method === 'HEAD') return { statusCode: 405, headers: {} };
        return { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST }, body: STANDARD_INDEX_BODY };
      }
      return { statusCode: 500, headers: {} };
    };
    const result = await compareLocalToRemoteTag([CHILD_ARM64], REGISTRY, REPO, TAG, ARM64);
    expect(result).toEqual({ kind: 'match' });
    expect(calls.filter((c) => c.url.includes('/manifests/'))).toEqual([
      { url: MANIFEST_URL_TAG, method: 'HEAD' },
      { url: MANIFEST_URL_TAG, method: 'GET' },
    ]);
  });

  it('returns an error with no tag retry when the digest-pinned GET 404s on a cold cache', async () => {
    route = (url, method) => {
      const token = tokenOk(url);
      if (token) return token;
      if (url === MANIFEST_URL_TAG && method === 'HEAD') {
        return { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST, 'content-type': INDEX_CONTENT_TYPE } };
      }
      if (url === manifestDigestUrl(INDEX_DIGEST) && method === 'GET') {
        return { statusCode: 404, headers: {} };
      }
      return { statusCode: 500, headers: {} };
    };
    const result = await compareLocalToRemoteTag([CHILD_AMD64], REGISTRY, REPO, TAG, AMD64);
    expect(result.kind).toBe('error');
    expect(calls.filter((c) => c.url === MANIFEST_URL_TAG)).toHaveLength(1);
  });

  it('does not cache a rejected classification as success: a repeat comparison retries the fetch', async () => {
    let digestGetCount = 0;
    route = (url, method) => {
      const token = tokenOk(url);
      if (token) return token;
      if (url === MANIFEST_URL_TAG && method === 'HEAD') {
        return { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST, 'content-type': INDEX_CONTENT_TYPE } };
      }
      if (url === manifestDigestUrl(INDEX_DIGEST) && method === 'GET') {
        digestGetCount++;
        return { statusCode: 500, headers: {} };
      }
      return { statusCode: 500, headers: {} };
    };
    const first = await compareLocalToRemoteTag([CHILD_AMD64], REGISTRY, REPO, TAG, AMD64);
    expect(first.kind).toBe('error');
    const second = await compareLocalToRemoteTag([CHILD_AMD64], REGISTRY, REPO, TAG, AMD64);
    expect(second.kind).toBe('error');
    expect(digestGetCount).toBe(2);
  });

  it('falls back to the stale cached classification when the digest GET fails after the cache entry expires', async () => {
    vi.useFakeTimers();
    let digestGetCount = 0;
    route = (url, method) => {
      const token = tokenOk(url);
      if (token) return token;
      if (url === MANIFEST_URL_TAG && method === 'HEAD') {
        return { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST, 'content-type': INDEX_CONTENT_TYPE } };
      }
      if (url === manifestDigestUrl(INDEX_DIGEST) && method === 'GET') {
        digestGetCount++;
        if (digestGetCount === 1) {
          return { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST }, body: STANDARD_INDEX_BODY };
        }
        return { statusCode: 500, headers: {} };
      }
      return { statusCode: 500, headers: {} };
    };

    const first = await compareLocalToRemoteTag([CHILD_AMD64], REGISTRY, REPO, TAG, AMD64);
    expect(first).toEqual({ kind: 'match' });

    await vi.advanceTimersByTimeAsync(MANIFEST_CLASSIFICATION_CACHE_TTL_MS + 1000);

    const second = await compareLocalToRemoteTag([CHILD_AMD64], REGISTRY, REPO, TAG, AMD64);
    expect(second).toEqual({ kind: 'match' });
    expect(digestGetCount).toBe(2);
  });

  it('reuses the cached classification for a second comparison of the same primary digest (no second GET)', async () => {
    let digestGetCount = 0;
    route = (url, method) => {
      const token = tokenOk(url);
      if (token) return token;
      if (url === MANIFEST_URL_TAG && method === 'HEAD') {
        return { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST, 'content-type': INDEX_CONTENT_TYPE } };
      }
      if (url === manifestDigestUrl(INDEX_DIGEST) && method === 'GET') {
        digestGetCount++;
        return { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST }, body: STANDARD_INDEX_BODY };
      }
      return { statusCode: 500, headers: {} };
    };
    await compareLocalToRemoteTag([CHILD_AMD64], REGISTRY, REPO, TAG, AMD64);
    await compareLocalToRemoteTag([CHILD_ARM64], REGISTRY, REPO, TAG, ARM64);
    expect(digestGetCount).toBe(1);
  });

  it('deduplicates concurrent comparisons for the same primary digest into one classification fetch', async () => {
    let digestGetCount = 0;
    route = (url, method) => {
      const token = tokenOk(url);
      if (token) return token;
      if (url === MANIFEST_URL_TAG && method === 'HEAD') {
        return { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST, 'content-type': INDEX_CONTENT_TYPE } };
      }
      if (url === manifestDigestUrl(INDEX_DIGEST) && method === 'GET') {
        digestGetCount++;
        return { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST }, body: STANDARD_INDEX_BODY };
      }
      return { statusCode: 500, headers: {} };
    };
    const [a, b] = await Promise.all([
      compareLocalToRemoteTag([CHILD_AMD64], REGISTRY, REPO, TAG, AMD64),
      compareLocalToRemoteTag([CHILD_ARM64], REGISTRY, REPO, TAG, ARM64),
    ]);
    expect(a).toEqual({ kind: 'match' });
    expect(b).toEqual({ kind: 'match' });
    expect(digestGetCount).toBe(1);
  });

  it('misses the cache when the primary digest changes (new manifest, new immutable key)', async () => {
    // Carries a genuinely different arm64 child (not CHILD_ARM64) so the second
    // lookup is a real same-platform mismatch, not an absent-platform index.
    const NEW_CHILD_ARM64 = `sha256:${'9'.repeat(64)}`;
    const INDEX_BODY_2 = indexBody([
      { digest: CHILD_AMD64, os: 'linux', architecture: 'amd64' },
      { digest: NEW_CHILD_ARM64, os: 'linux', architecture: 'arm64' },
    ]);
    const INDEX_DIGEST_2 = contentDigest(INDEX_BODY_2);
    let headDigest = INDEX_DIGEST;
    let digestGetCount = 0;
    route = (url, method) => {
      const token = tokenOk(url);
      if (token) return token;
      if (url === MANIFEST_URL_TAG && method === 'HEAD') {
        return { statusCode: 200, headers: { 'docker-content-digest': headDigest, 'content-type': INDEX_CONTENT_TYPE } };
      }
      if (url === manifestDigestUrl(INDEX_DIGEST) && method === 'GET') {
        digestGetCount++;
        return { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST }, body: STANDARD_INDEX_BODY };
      }
      if (url === manifestDigestUrl(INDEX_DIGEST_2) && method === 'GET') {
        digestGetCount++;
        return { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST_2 }, body: INDEX_BODY_2 };
      }
      return { statusCode: 500, headers: {} };
    };
    const first = await compareLocalToRemoteTag([CHILD_ARM64], REGISTRY, REPO, TAG, ARM64);
    expect(first).toEqual({ kind: 'match' });

    headDigest = INDEX_DIGEST_2;
    const second = await compareLocalToRemoteTag([CHILD_ARM64], REGISTRY, REPO, TAG, ARM64);
    expect(second).toEqual({ kind: 'update' });
    expect(digestGetCount).toBe(2);
  });

  it('isolates the classification cache by registry and repository, not just the digest', async () => {
    let digestGetCount = 0;
    const routeFor = (repo: string) => (url: string, method: string): FakeResp => {
      const token = tokenOk(url);
      if (token) return token;
      const tagUrl = `https://${REGISTRY}/v2/${repo}/manifests/${TAG}`;
      if (url === tagUrl && method === 'HEAD') {
        return { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST, 'content-type': INDEX_CONTENT_TYPE } };
      }
      if (url === manifestDigestUrl(INDEX_DIGEST, repo) && method === 'GET') {
        digestGetCount++;
        return { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST }, body: STANDARD_INDEX_BODY };
      }
      return { statusCode: 500, headers: {} };
    };

    route = routeFor(REPO);
    await compareLocalToRemoteTag([CHILD_AMD64], REGISTRY, REPO, TAG, AMD64);
    expect(digestGetCount).toBe(1);

    route = routeFor('otherorg/otherapp');
    await compareLocalToRemoteTag([CHILD_AMD64], REGISTRY, 'otherorg/otherapp', TAG, AMD64);
    expect(digestGetCount).toBe(2);
  });

  it('matches a local digest against any runnable descriptor sharing os+architecture across variants', async () => {
    const VARIANT_V6 = `sha256:${'1'.repeat(64)}`;
    const VARIANT_V7 = `sha256:${'2'.repeat(64)}`;
    const body = indexBody([
      { digest: VARIANT_V6, os: 'linux', architecture: 'arm', variant: 'v6' },
      { digest: VARIANT_V7, os: 'linux', architecture: 'arm', variant: 'v7' },
    ]);
    const primary = contentDigest(body);
    route = (url, method) => {
      const token = tokenOk(url);
      if (token) return token;
      if (url === MANIFEST_URL_TAG && method === 'HEAD') {
        return { statusCode: 200, headers: { 'docker-content-digest': primary, 'content-type': INDEX_CONTENT_TYPE } };
      }
      if (url === manifestDigestUrl(primary) && method === 'GET') {
        return { statusCode: 200, headers: { 'docker-content-digest': primary }, body };
      }
      return { statusCode: 500, headers: {} };
    };
    const result = await compareLocalToRemoteTag([VARIANT_V7], REGISTRY, REPO, TAG, { os: 'linux', architecture: 'arm' });
    expect(result).toEqual({ kind: 'match' });
  });

  it('ignores unknown/unknown placeholder descriptors and attestation-manifest annotations', async () => {
    const ATTESTATION_UNKNOWN = `sha256:${'3'.repeat(64)}`;
    const ATTESTATION_ANNOTATED = `sha256:${'4'.repeat(64)}`;
    const body = JSON.stringify({
      schemaVersion: 2,
      mediaType: INDEX_CONTENT_TYPE,
      manifests: [
        { digest: CHILD_AMD64, mediaType: 'application/vnd.oci.image.manifest.v1+json', platform: { os: 'linux', architecture: 'amd64' } },
        { digest: ATTESTATION_UNKNOWN, mediaType: 'application/vnd.oci.image.manifest.v1+json', platform: { os: 'unknown', architecture: 'unknown' } },
        {
          digest: ATTESTATION_ANNOTATED,
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          platform: { os: 'linux', architecture: 'amd64' },
          annotations: { 'vnd.docker.reference.type': 'attestation-manifest' },
        },
      ],
    });
    const primary = contentDigest(body);
    route = (url, method) => {
      const token = tokenOk(url);
      if (token) return token;
      if (url === MANIFEST_URL_TAG && method === 'HEAD') {
        return { statusCode: 200, headers: { 'docker-content-digest': primary, 'content-type': INDEX_CONTENT_TYPE } };
      }
      if (url === manifestDigestUrl(primary) && method === 'GET') {
        return { statusCode: 200, headers: { 'docker-content-digest': primary }, body };
      }
      return { statusCode: 500, headers: {} };
    };

    // A local digest equal to the filtered-out annotated-attestation entry must
    // never match, since that descriptor is dropped before the membership check.
    const filtered = await compareLocalToRemoteTag([ATTESTATION_ANNOTATED], REGISTRY, REPO, TAG, AMD64);
    expect(filtered).toEqual({ kind: 'update' });

    // The real platform descriptor still matches normally (cache hit reuses the
    // same parsed classification from the previous call).
    const realMatch = await compareLocalToRemoteTag([CHILD_AMD64], REGISTRY, REPO, TAG, AMD64);
    expect(realMatch).toEqual({ kind: 'match' });
  });

  it('errors when the raw manifests array exceeds the 256-descriptor cap', async () => {
    const manifests = Array.from({ length: MANIFEST_INDEX_DESCRIPTOR_CAP + 1 }, (_, i) => ({
      digest: `sha256:${i.toString(16).padStart(64, '0')}`,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      platform: { os: 'linux', architecture: 'amd64' },
    }));
    const body = JSON.stringify({ schemaVersion: 2, manifests });
    const primary = contentDigest(body);
    route = (url, method) => {
      const token = tokenOk(url);
      if (token) return token;
      if (url === MANIFEST_URL_TAG && method === 'HEAD') {
        return { statusCode: 200, headers: { 'docker-content-digest': primary, 'content-type': INDEX_CONTENT_TYPE } };
      }
      if (url === manifestDigestUrl(primary) && method === 'GET') {
        return { statusCode: 200, headers: { 'docker-content-digest': primary }, body };
      }
      return { statusCode: 500, headers: {} };
    };
    const result = await compareLocalToRemoteTag([CHILD_AMD64], REGISTRY, REPO, TAG, AMD64);
    expect(result.kind).toBe('error');
  });

  it('errors when the digest-pinned manifest body is not valid JSON', async () => {
    const badBody = 'not json{{';
    const primary = contentDigest(badBody);
    route = (url, method) => {
      const token = tokenOk(url);
      if (token) return token;
      if (url === MANIFEST_URL_TAG && method === 'HEAD') {
        return { statusCode: 200, headers: { 'docker-content-digest': primary, 'content-type': INDEX_CONTENT_TYPE } };
      }
      if (url === manifestDigestUrl(primary) && method === 'GET') {
        return { statusCode: 200, headers: { 'docker-content-digest': primary }, body: badBody };
      }
      return { statusCode: 500, headers: {} };
    };
    const result = await compareLocalToRemoteTag([CHILD_AMD64], REGISTRY, REPO, TAG, AMD64);
    expect(result.kind).toBe('error');
  });

  it('errors when the digest-pinned GET returns a docker-content-digest that disagrees with the requested digest', async () => {
    const WRONG_DIGEST = `sha256:${'5'.repeat(64)}`;
    route = (url, method) => {
      const token = tokenOk(url);
      if (token) return token;
      if (url === MANIFEST_URL_TAG && method === 'HEAD') {
        return { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST, 'content-type': INDEX_CONTENT_TYPE } };
      }
      if (url === manifestDigestUrl(INDEX_DIGEST) && method === 'GET') {
        return { statusCode: 200, headers: { 'docker-content-digest': WRONG_DIGEST }, body: STANDARD_INDEX_BODY };
      }
      return { statusCode: 500, headers: {} };
    };
    const result = await compareLocalToRemoteTag([CHILD_AMD64], REGISTRY, REPO, TAG, AMD64);
    expect(result).toEqual({ kind: 'error', reason: expect.stringContaining('mismatched digest') });
  });

  it('errors when the digest-pinned GET omits docker-content-digest and the body hash does not match', async () => {
    // Body looks like a matching index for the local digest, but its sha256 is not INDEX_DIGEST.
    const fakeMatchBody = indexBody([{ digest: CHILD_AMD64, os: 'linux', architecture: 'amd64' }]);
    expect(contentDigest(fakeMatchBody)).not.toBe(INDEX_DIGEST);
    route = (url, method) => {
      const token = tokenOk(url);
      if (token) return token;
      if (url === MANIFEST_URL_TAG && method === 'HEAD') {
        return { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST, 'content-type': INDEX_CONTENT_TYPE } };
      }
      if (url === manifestDigestUrl(INDEX_DIGEST) && method === 'GET') {
        return { statusCode: 200, headers: {}, body: fakeMatchBody };
      }
      return { statusCode: 500, headers: {} };
    };
    const result = await compareLocalToRemoteTag([CHILD_AMD64], REGISTRY, REPO, TAG, AMD64);
    expect(result).toEqual({ kind: 'error', reason: expect.stringContaining('does not match the requested digest') });
  });

  it('errors without a speculative match when the local platform os/architecture is unknown', async () => {
    route = (url, method) => {
      const token = tokenOk(url);
      if (token) return token;
      if (url === MANIFEST_URL_TAG && method === 'HEAD') {
        return { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST, 'content-type': INDEX_CONTENT_TYPE } };
      }
      if (url === manifestDigestUrl(INDEX_DIGEST) && method === 'GET') {
        return { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST }, body: STANDARD_INDEX_BODY };
      }
      return { statusCode: 500, headers: {} };
    };
    const result = await compareLocalToRemoteTag([CHILD_AMD64], REGISTRY, REPO, TAG, { os: '', architecture: '' });
    expect(result.kind).toBe('error');
  });

  it('rejects a truncated local digest as an error, never as a speculative update', async () => {
    route = () => ({ statusCode: 500, headers: {} }); // must never be reached
    const result = await compareLocalToRemoteTag(['sha256:tooshort'], REGISTRY, REPO, TAG, AMD64);
    expect(result).toEqual({ kind: 'error', reason: 'Local digest is malformed or truncated' });
    expect(calls).toHaveLength(0);
  });

  it('rejects an empty candidate list as an error without contacting the registry', async () => {
    route = () => ({ statusCode: 500, headers: {} });
    const result = await compareLocalToRemoteTag([], REGISTRY, REPO, TAG, AMD64);
    expect(result).toEqual({ kind: 'error', reason: 'Local digest is malformed or truncated' });
    expect(calls).toHaveLength(0);
  });

  it('rejects an all-malformed candidate list as an error without contacting the registry', async () => {
    route = () => ({ statusCode: 500, headers: {} });
    const result = await compareLocalToRemoteTag(['sha256:short', 'not-a-digest'], REGISTRY, REPO, TAG, AMD64);
    expect(result).toEqual({ kind: 'error', reason: 'Local digest is malformed or truncated' });
    expect(calls).toHaveLength(0);
  });

  it('errors on unknown platform for a multi-candidate index mismatch (fail closed)', async () => {
    route = (url, method) => {
      const token = tokenOk(url);
      if (token) return token;
      if (url === MANIFEST_URL_TAG && method === 'HEAD') {
        return { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST, 'content-type': INDEX_CONTENT_TYPE } };
      }
      if (url === manifestDigestUrl(INDEX_DIGEST) && method === 'GET') {
        return { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST }, body: STANDARD_INDEX_BODY };
      }
      return { statusCode: 500, headers: {} };
    };
    const result = await compareLocalToRemoteTag(
      [STALE_INDEX, `sha256:${'e'.repeat(64)}`],
      REGISTRY,
      REPO,
      TAG,
      { os: '', architecture: '' },
    );
    expect(result.kind).toBe('error');
  });

  it('degrades to an uncached comparison (not an error) when the classification cache is at capacity', async () => {
    const cache = CacheService.getInstance();
    for (let i = 0; i < 1000; i++) cache.set(`filler:${i}`, { kind: 'single' as const }, 3_600_000);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    let digestGetCount = 0;
    route = (url, method) => {
      const token = tokenOk(url);
      if (token) return token;
      if (url === MANIFEST_URL_TAG && method === 'HEAD') {
        return { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST, 'content-type': INDEX_CONTENT_TYPE } };
      }
      if (url === manifestDigestUrl(INDEX_DIGEST) && method === 'GET') {
        digestGetCount++;
        return { statusCode: 200, headers: { 'docker-content-digest': INDEX_DIGEST }, body: STANDARD_INDEX_BODY };
      }
      return { statusCode: 500, headers: {} };
    };

    const first = await compareLocalToRemoteTag([CHILD_AMD64], REGISTRY, REPO, TAG, AMD64);
    const second = await compareLocalToRemoteTag([CHILD_AMD64], REGISTRY, REPO, TAG, AMD64);

    expect(first).toEqual({ kind: 'match' });
    expect(second).toEqual({ kind: 'match' });
    expect(digestGetCount).toBe(2);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('preserves UTF-8 integrity when a multibyte code point is split across data events', async () => {
    // 🚢 is F0 9F 9A A2; split after two bytes so naïve per-chunk toString corrupts it.
    const ship = '🚢';
    const body = JSON.stringify({
      schemaVersion: 2,
      mediaType: INDEX_CONTENT_TYPE,
      annotations: { 'org.opencontainers.image.description': `QA-${ship}-manifest` },
      manifests: [
        {
          digest: CHILD_AMD64,
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          platform: { os: 'linux', architecture: 'amd64' },
        },
      ],
    });
    const primary = contentDigest(body);
    const raw = Buffer.from(body, 'utf8');
    const shipOffset = raw.indexOf(Buffer.from(ship, 'utf8'));
    expect(shipOffset).toBeGreaterThan(0);
    const splitAt = shipOffset + 2;

    route = routePrimaryDigest(primary, {
      [primary]: {
        statusCode: 200,
        headers: { 'docker-content-digest': primary },
        bodyChunks: [raw.subarray(0, splitAt), raw.subarray(splitAt)],
      },
    });

    const result = await compareLocalToRemoteTag([CHILD_AMD64], REGISTRY, REPO, TAG, AMD64);
    expect(result).toEqual({ kind: 'match' });
  });

  it('matches a leaf under a nested index via digest-pinned recursion', async () => {
    const nestedBody = indexBody([
      { digest: CHILD_AMD64, os: 'linux', architecture: 'amd64' },
      { digest: CHILD_ARM64, os: 'linux', architecture: 'arm64' },
    ]);
    const nestedDigest = contentDigest(nestedBody);
    const outerBody = JSON.stringify({
      schemaVersion: 2,
      mediaType: INDEX_CONTENT_TYPE,
      manifests: [
        {
          digest: nestedDigest,
          mediaType: INDEX_CONTENT_TYPE,
          platform: { os: 'linux', architecture: 'amd64' },
        },
      ],
    });
    const outerDigest = contentDigest(outerBody);

    route = routePrimaryDigest(outerDigest, {
      [outerDigest]: outerBody,
      [nestedDigest]: nestedBody,
    });

    const result = await compareLocalToRemoteTag([CHILD_AMD64], REGISTRY, REPO, TAG, AMD64);
    expect(result).toEqual({ kind: 'match' });
    expect(calls.filter((c) => c.method === 'GET' && c.url.includes('/manifests/'))).toHaveLength(2);
  });

  it('returns error (not update) when a nested index digest is unavailable', async () => {
    const nestedDigest = `sha256:${'a'.repeat(64)}`;
    const outerBody = JSON.stringify({
      schemaVersion: 2,
      mediaType: INDEX_CONTENT_TYPE,
      manifests: [
        { digest: nestedDigest, mediaType: INDEX_CONTENT_TYPE },
        {
          digest: CHILD_ARM64,
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          platform: { os: 'linux', architecture: 'arm64' },
        },
      ],
    });
    const outerDigest = contentDigest(outerBody);

    route = routePrimaryDigest(outerDigest, {
      [outerDigest]: outerBody,
      [nestedDigest]: { statusCode: 404, headers: {} },
    });

    const result = await compareLocalToRemoteTag([CHILD_AMD64], REGISTRY, REPO, TAG, AMD64);
    expect(result.kind).toBe('error');
  });

  it('matches a runnable descriptor that omits optional platform metadata by exact digest', async () => {
    const body = JSON.stringify({
      schemaVersion: 2,
      mediaType: INDEX_CONTENT_TYPE,
      manifests: [
        { digest: CHILD_AMD64, mediaType: 'application/vnd.oci.image.manifest.v1+json' },
        {
          digest: CHILD_ARM64,
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          platform: { os: 'linux', architecture: 'arm64' },
        },
      ],
    });
    const primary = contentDigest(body);
    route = routePrimaryDigest(primary, { [primary]: body });

    const result = await compareLocalToRemoteTag([CHILD_AMD64], REGISTRY, REPO, TAG, AMD64);
    expect(result).toEqual({ kind: 'match' });
  });

  it('returns error (not update) when index nesting exceeds the depth limit', async () => {
    // Build a chain primary -> d1 -> d2 -> ... of length MANIFEST_INDEX_MAX_DEPTH + 1.
    const bodies: { digest: string; body: string }[] = [];
    const leafBody = indexBody([{ digest: CHILD_AMD64, os: 'linux', architecture: 'amd64' }]);
    let leafDigest = contentDigest(leafBody);
    bodies.push({ digest: leafDigest, body: leafBody });

    for (let depth = 0; depth < MANIFEST_INDEX_MAX_DEPTH; depth++) {
      const parentBody = JSON.stringify({
        schemaVersion: 2,
        mediaType: INDEX_CONTENT_TYPE,
        manifests: [{ digest: leafDigest, mediaType: INDEX_CONTENT_TYPE }],
      });
      const parentDigest = contentDigest(parentBody);
      bodies.push({ digest: parentDigest, body: parentBody });
      leafDigest = parentDigest;
    }
    const outerDigest = leafDigest;
    const digests: Record<string, string> = {};
    for (const { digest, body } of bodies) digests[digest] = body;

    route = routePrimaryDigest(outerDigest, digests);

    const result = await compareLocalToRemoteTag([CHILD_AMD64], REGISTRY, REPO, TAG, AMD64);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toMatch(/depth/i);
    }
  });

  it('returns error (not update) for a descriptor with an unrecognized media type', async () => {
    const body = JSON.stringify({
      schemaVersion: 2,
      mediaType: INDEX_CONTENT_TYPE,
      manifests: [
        {
          digest: CHILD_AMD64,
          mediaType: 'application/vnd.example.weird-manifest+json',
          platform: { os: 'linux', architecture: 'amd64' },
        },
      ],
    });
    const primary = contentDigest(body);
    route = routePrimaryDigest(primary, { [primary]: body });

    const result = await compareLocalToRemoteTag([CHILD_AMD64], REGISTRY, REPO, TAG, AMD64);
    expect(result.kind).toBe('error');
  });

  it('still expands a nested index descriptor even when its platform is unknown/unknown', async () => {
    const nestedBody = indexBody([{ digest: CHILD_AMD64, os: 'linux', architecture: 'amd64' }]);
    const nestedDigest = contentDigest(nestedBody);
    const outerBody = JSON.stringify({
      schemaVersion: 2,
      mediaType: INDEX_CONTENT_TYPE,
      manifests: [
        {
          digest: nestedDigest,
          mediaType: INDEX_CONTENT_TYPE,
          platform: { os: 'unknown', architecture: 'unknown' },
        },
      ],
    });
    const outerDigest = contentDigest(outerBody);
    route = routePrimaryDigest(outerDigest, {
      [outerDigest]: outerBody,
      [nestedDigest]: nestedBody,
    });

    const result = await compareLocalToRemoteTag([CHILD_AMD64], REGISTRY, REPO, TAG, AMD64);
    expect(result).toEqual({ kind: 'match' });
  });

  it('returns error (not update) for a nested descriptor with a non-digest string', async () => {
    const outerBody = JSON.stringify({
      schemaVersion: 2,
      mediaType: INDEX_CONTENT_TYPE,
      manifests: [
        { digest: '../other/manifests/evil', mediaType: INDEX_CONTENT_TYPE },
        {
          digest: CHILD_ARM64,
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          platform: { os: 'linux', architecture: 'arm64' },
        },
      ],
    });
    const outerDigest = contentDigest(outerBody);
    route = routePrimaryDigest(outerDigest, { [outerDigest]: outerBody });

    const result = await compareLocalToRemoteTag([CHILD_AMD64], REGISTRY, REPO, TAG, AMD64);
    expect(result.kind).toBe('error');
    expect(calls.some((c) => c.url.includes('../') || c.url.includes('/evil'))).toBe(false);
  });

  it('returns error (not update) when a descriptor is missing its digest', async () => {
    const body = JSON.stringify({
      schemaVersion: 2,
      mediaType: INDEX_CONTENT_TYPE,
      manifests: [
        { mediaType: 'application/vnd.oci.image.manifest.v1+json', platform: { os: 'linux', architecture: 'amd64' } },
      ],
    });
    const primary = contentDigest(body);
    route = routePrimaryDigest(primary, { [primary]: body });

    const result = await compareLocalToRemoteTag([CHILD_AMD64], REGISTRY, REPO, TAG, AMD64);
    expect(result.kind).toBe('error');
  });

  it('returns error (not update) when Content-Type is an index but the body has no manifests array', async () => {
    const body = JSON.stringify({
      schemaVersion: 2,
      mediaType: INDEX_CONTENT_TYPE,
      config: { digest: CHILD_AMD64, mediaType: 'application/vnd.oci.image.config.v1+json', size: 1 },
      layers: [],
    });
    const primary = contentDigest(body);
    route = routePrimaryDigest(primary, { [primary]: body });

    const result = await compareLocalToRemoteTag([CHILD_AMD64], REGISTRY, REPO, TAG, AMD64);
    expect(result.kind).toBe('error');
  });

  // ─── compareLocalToRemoteTagDetailed ───────────────────────
  //
  // Same comparison engine as compareLocalToRemoteTag, sharing the fixtures
  // and route helpers above, but asserting the extra primaryDigest field and
  // that compareLocalToRemoteTag itself no longer leaks it.

  describe('compareLocalToRemoteTagDetailed', () => {
    /** HEAD the tag for INDEX_DIGEST, then serve its index body on the pinned GET. */
    const routeExpandableIndex = routePrimaryDigest(INDEX_DIGEST, { [INDEX_DIGEST]: STANDARD_INDEX_BODY });
    /** HEAD the tag for INDEX_DIGEST; every digest-pinned GET fails. */
    const routeHeadOnly = routePrimaryDigest(INDEX_DIGEST, {});

    it('performs exactly one manifest probe and returns the primary digest alongside kind: match', async () => {
      route = routeHeadOnly;
      const result = await compareLocalToRemoteTagDetailed([INDEX_DIGEST], REGISTRY, REPO, TAG, AMD64);
      expect(result).toEqual({ kind: 'match', primaryDigest: INDEX_DIGEST });
      expect(calls.filter((c) => c.url.includes('/manifests/'))).toHaveLength(1);
    });

    it('returns the primary digest alongside kind: update when every local candidate is stale', async () => {
      route = routeExpandableIndex;
      const result = await compareLocalToRemoteTagDetailed([STALE_INDEX], REGISTRY, REPO, TAG, AMD64);
      expect(result).toEqual({ kind: 'update', primaryDigest: INDEX_DIGEST });
    });

    it('returns the primary digest alongside kind: error from a classification failure', async () => {
      // Digest-pinned GET fails: classification cannot complete.
      route = routeHeadOnly;
      const result = await compareLocalToRemoteTagDetailed([STALE_INDEX], REGISTRY, REPO, TAG, AMD64);
      expect(result.kind).toBe('error');
      expect(result.primaryDigest).toBe(INDEX_DIGEST);
      expect(result.reason).toBeTruthy();
    });

    it('omits the primary digest on an early error before any probe (malformed local digest)', async () => {
      const result = await compareLocalToRemoteTagDetailed(['not-a-digest'], REGISTRY, REPO, TAG, AMD64);
      expect(result).toEqual({ kind: 'error', reason: expect.any(String) });
      expect(result.primaryDigest).toBeUndefined();
    });

    it('compareLocalToRemoteTag wraps the detailed result and drops primaryDigest on match', async () => {
      route = routeHeadOnly;
      const result = await compareLocalToRemoteTag([INDEX_DIGEST], REGISTRY, REPO, TAG, AMD64);
      expect(Object.keys(result)).toEqual(['kind']);
      expect(result).toEqual({ kind: 'match' });
    });

    it('compareLocalToRemoteTag wraps the detailed result and drops primaryDigest on update', async () => {
      route = routeExpandableIndex;
      const result = await compareLocalToRemoteTag([STALE_INDEX], REGISTRY, REPO, TAG, AMD64);
      expect(Object.keys(result)).toEqual(['kind']);
      expect(result).toEqual({ kind: 'update' });
    });

    it('compareLocalToRemoteTag wraps the detailed result and keeps only kind + reason on error', async () => {
      route = (url) => tokenOk(url) ?? { statusCode: 500, headers: {} };
      const result = await compareLocalToRemoteTag([CHILD_AMD64], REGISTRY, REPO, TAG, AMD64);
      expect(result.kind).toBe('error');
      expect(Object.keys(result).sort()).toEqual(['kind', 'reason']);
    });
  });
});
