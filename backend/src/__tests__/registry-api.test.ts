/**
 * Unit tests for the registry HTTP client: digest-name matching (the local
 * RepoDigest vs image-ref comparison) and getRemoteDigest's HEAD-first lookup
 * with GET fallback.
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

import { repoDigestMatchesRef, getRemoteDigest, parseImageRef } from '../services/registry-api';

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
