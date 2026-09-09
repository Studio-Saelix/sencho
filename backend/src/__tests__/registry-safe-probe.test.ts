import { EventEmitter } from 'events';
import type { ClientRequest, IncomingMessage } from 'http';
import https from 'https';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertSafeRegistryHost,
  isAuthorizedTokenDelegation,
  probeManifestAnonymous,
  PROBE_BODY_LIMIT_BYTES,
  probeRegistryApiHost,
  safeRegistryGet,
  splitPullRefForProbe,
  UnsafeRegistryHopError,
} from '../helpers/registrySafeProbe';

interface ScriptedResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

interface SeenCall {
  url: string;
  headers: Record<string, string>;
}

function scriptHttps(script: ScriptedResponse[]): SeenCall[] {
  const seen: SeenCall[] = [];
  let i = 0;
  vi.spyOn(https, 'request').mockImplementation(((
    rawUrl: string | URL,
    options: https.RequestOptions,
    callback: (res: IncomingMessage) => void,
  ): ClientRequest => {
    const url = String(rawUrl);
    seen.push({ url, headers: (options.headers ?? {}) as Record<string, string> });
    const entry = script[i++] ?? { status: 200, headers: {}, body: '{}' };
    const res = new EventEmitter() as unknown as IncomingMessage;
    res.statusCode = entry.status;
    res.headers = entry.headers ?? {};
    process.nextTick(() => res.emit('data', Buffer.from(entry.body ?? '')));
    process.nextTick(() => res.emit('end'));
    const req = new EventEmitter() as unknown as ClientRequest;
    req.setTimeout = () => req;
    req.destroy = ((err?: Error) => { req.emit('error', err ?? new Error('destroyed')); return req; }) as ClientRequest['destroy'];
    req.end = () => {
      callback(res);
      return req;
    };
    return req;
  }) as typeof https.request);
  return seen;
}

/**
 * The real host-safety boundary blocks loopback unless the e2e loopback
 * override is set (and NODE_ENV is 'test', which vitest provides). Enable it so
 * positive flows run through the real safe-transport checks on 127.0.0.1 while
 * the https spy replaces the TLS network boundary. Genuinely-blocked targets
 * (169.254.169.254) are never loopback, so they fail closed regardless.
 */
beforeEach(() => {
  vi.stubEnv('SENCHO_E2E_ALLOW_LOOPBACK_OUTBOUND', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('splitPullRefForProbe', () => {
  it('splits a tag-pinned ref', () => {
    expect(splitPullRefForProbe('ghcr.io/acme/app:1.0.0')).toEqual({
      host: 'ghcr.io',
      repo: 'acme/app',
      tagOrDigest: '1.0.0',
    });
  });

  it('preserves a digest-pinned ref verbatim', () => {
    const digest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(splitPullRefForProbe(`ghcr.io/acme/app@${digest}`)).toEqual({
      host: 'ghcr.io',
      repo: 'acme/app',
      tagOrDigest: digest,
    });
  });
});

describe('probeRegistryApiHost', () => {
  it('folds Docker Hub aliases to the registry API host', () => {
    expect(probeRegistryApiHost('index.docker.io')).toBe('registry-1.docker.io');
    expect(probeRegistryApiHost('ghcr.io')).toBe('ghcr.io');
  });
});

describe('isAuthorizedTokenDelegation', () => {
  it('allows a same-origin realm', () => {
    expect(isAuthorizedTokenDelegation('https://registry-1.docker.io', 'https://registry-1.docker.io')).toBe(true);
  });

  it('allows the allowlisted providers for a cross-origin registry', () => {
    expect(isAuthorizedTokenDelegation('https://auth.docker.io', 'https://registry-1.docker.io')).toBe(true);
    expect(isAuthorizedTokenDelegation('https://ghcr.io', 'https://pkg.example.internal')).toBe(true);
  });

  it('rejects an arbitrary cross-origin realm', () => {
    expect(isAuthorizedTokenDelegation('https://evil.example', 'https://registry-1.docker.io')).toBe(false);
  });

  it('rejects a lookalike that merely shares an allowlisted hostname prefix', () => {
    expect(isAuthorizedTokenDelegation('https://auth.docker.io.evil.com', 'https://registry-1.docker.io')).toBe(false);
    expect(isAuthorizedTokenDelegation('https://evil.com/auth.docker.io', 'https://registry-1.docker.io')).toBe(false);
  });
});

describe('assertSafeRegistryHost', () => {
  it('accepts loopback under the e2e override', async () => {
    await expect(assertSafeRegistryHost('127.0.0.1')).resolves.toBeUndefined();
  });

  it('rejects a blocked host before any request', async () => {
    await expect(assertSafeRegistryHost('169.254.169.254')).rejects.toBeInstanceOf(UnsafeRegistryHopError);
  });
});

describe('safeRegistryGet redirect safety', () => {
  it('rejects an HTTPS-to-HTTP downgrade and never replays Authorization', async () => {
    const seen = scriptHttps([
      { status: 302, headers: { location: 'http://127.0.0.1/downgraded' } },
    ]);
    await expect(
      safeRegistryGet('https://127.0.0.1/v2/acme/app/manifests/1.0.0', { Authorization: 'Bearer secret' }),
    ).rejects.toThrow('HTTPS-to-HTTP registry redirect rejected');
    expect(seen).toHaveLength(1);
  });

  it('keeps Authorization on a same-origin redirect', async () => {
    const seen = scriptHttps([
      { status: 302, headers: { location: 'https://127.0.0.1/v2/acme/app/manifests/2.0.0' } },
      { status: 200, headers: {}, body: '{}' },
    ]);
    const out = await safeRegistryGet('https://127.0.0.1/v2/acme/app/manifests/1.0.0', { Authorization: 'Bearer secret' });
    expect(out.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[0].headers.Authorization).toBe('Bearer secret');
    expect(seen[1].headers.Authorization).toBe('Bearer secret');
  });

  it('strips Authorization on a cross-origin redirect', async () => {
    const seen = scriptHttps([
      { status: 302, headers: { location: 'https://[::1]/v2/acme/app/manifests/1.0.0' } },
      { status: 200, headers: {}, body: '{}' },
    ]);
    const out = await safeRegistryGet('https://127.0.0.1/v2/acme/app/manifests/1.0.0', { Authorization: 'Bearer secret' });
    expect(out.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[1].url.startsWith('https://[::1]')).toBe(true);
    expect(seen[1].headers.Authorization).toBeUndefined();
  });

  it('caps a redirect chain', async () => {
    const seen = scriptHttps([
      { status: 302, headers: { location: 'https://127.0.0.1/a' } },
      { status: 302, headers: { location: 'https://127.0.0.1/b' } },
      { status: 302, headers: { location: 'https://127.0.0.1/c' } },
      { status: 302, headers: { location: 'https://127.0.0.1/d' } },
    ]);
    await expect(
      safeRegistryGet('https://127.0.0.1/v2/acme/app/manifests/1.0.0'),
    ).rejects.toThrow('exceeded redirect limit');
    expect(seen).toHaveLength(4);
  });
});

describe('probeManifestAnonymous classification', () => {
  it('classifies a directly-readable manifest as public', async () => {
    scriptHttps([{ status: 200, headers: {}, body: '{}' }]);
    const out = await probeManifestAnonymous({ host: '127.0.0.1', repo: 'acme/app', tagOrDigest: '1.0.0' });
    expect(out).toEqual({ classification: 'public', status: 200 });
  });

  it('requests the digest manifest verbatim for a digest-pinned ref', async () => {
    const digest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const seen = scriptHttps([{ status: 200, headers: {}, body: '{}' }]);
    const out = await probeManifestAnonymous({ host: '127.0.0.1', repo: 'acme/app', tagOrDigest: digest });
    expect(out).toEqual({ classification: 'public', status: 200 });
    expect(seen[0].url).toBe('https://127.0.0.1/v2/acme/app/manifests/' + digest);
  });

  it('exchanges an anonymous token against a same-origin realm and classifies a 200 as public', async () => {
    const seen = scriptHttps([
      { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://127.0.0.1/token",service="registry"' }, body: '{}' },
      { status: 200, headers: {}, body: '{"token":"abc123"}' },
      { status: 200, headers: {}, body: '{}' },
    ]);
    const out = await probeManifestAnonymous({ host: '127.0.0.1', repo: 'acme/app', tagOrDigest: '1.0.0' });
    expect(out).toEqual({ classification: 'public', status: 200 });
    expect(seen).toHaveLength(3);
    expect(seen[1].url).toContain('/token');
    expect(seen[2].headers.Authorization).toBe('Bearer abc123');
  });

  it('marks a hostile cross-origin realm inconclusive and never contacts the realm host', async () => {
    const seen = scriptHttps([
      { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://169.254.169.254/token",service="registry"' }, body: '{}' },
    ]);
    const out = await probeManifestAnonymous({ host: '127.0.0.1', repo: 'acme/app', tagOrDigest: '1.0.0' });
    expect(out).toEqual({ classification: 'inconclusive' });
    expect(seen).toHaveLength(1);
  });

  it('never connects to a blocked manifest host', async () => {
    const seen = scriptHttps([]);
    const out = await probeManifestAnonymous({ host: '169.254.169.254', repo: 'acme/app', tagOrDigest: '1.0.0' });
    expect(out).toEqual({ classification: 'inconclusive' });
    expect(seen).toHaveLength(0);
  });

  it('rejects an HTTP token realm before any header is sent and never connects', async () => {
    const seen = scriptHttps([
      { status: 401, headers: { 'www-authenticate': 'Bearer realm="http://auth.example/token",service="registry"' }, body: '{}' },
    ]);
    const out = await probeManifestAnonymous({ host: '127.0.0.1', repo: 'acme/app', tagOrDigest: '1.0.0' });
    expect(out).toEqual({ classification: 'inconclusive' });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).not.toContain('/token');
  });

  it('classifies a 404 manifest as inconclusive passthrough', async () => {
    scriptHttps([{ status: 404, headers: {}, body: '{}' }]);
    const out = await probeManifestAnonymous({ host: '127.0.0.1', repo: 'acme/app', tagOrDigest: '1.0.0' });
    expect(out).toEqual({ classification: 'inconclusive', status: 404 });
  });

  it('classifies a post-token 404 as inconclusive, not challenged', async () => {
    const seen = scriptHttps([
      { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://127.0.0.1/token",service="registry"' }, body: '{}' },
      { status: 200, headers: {}, body: '{"token":"abc123"}' },
      { status: 404, headers: {}, body: '{}' },
    ]);
    const out = await probeManifestAnonymous({ host: '127.0.0.1', repo: 'acme/app', tagOrDigest: '1.0.0' });
    expect(out).toEqual({ classification: 'inconclusive', status: 404 });
    expect(seen).toHaveLength(3);
  });

  it('classifies a post-token 429 rate limit as inconclusive', async () => {
    scriptHttps([
      { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://127.0.0.1/token",service="registry"' }, body: '{}' },
      { status: 200, headers: {}, body: '{"token":"abc123"}' },
      { status: 429, headers: {}, body: '{}' },
    ]);
    const out = await probeManifestAnonymous({ host: '127.0.0.1', repo: 'acme/app', tagOrDigest: '1.0.0' });
    expect(out).toEqual({ classification: 'inconclusive', status: 429 });
  });

  it('classifies a post-token 403 as challenged', async () => {
    scriptHttps([
      { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://127.0.0.1/token",service="registry"' }, body: '{}' },
      { status: 200, headers: {}, body: '{"token":"abc123"}' },
      { status: 403, headers: {}, body: '{}' },
    ]);
    const out = await probeManifestAnonymous({ host: '127.0.0.1', repo: 'acme/app', tagOrDigest: '1.0.0' });
    expect(out).toEqual({ classification: 'challenged', status: 403 });
  });

  it('classifies an oversized response body as inconclusive', async () => {
    scriptHttps([
      { status: 200, headers: {}, body: 'x'.repeat(PROBE_BODY_LIMIT_BYTES + 1) },
    ]);
    const out = await probeManifestAnonymous({ host: '127.0.0.1', repo: 'acme/app', tagOrDigest: '1.0.0' });
    expect(out).toEqual({ classification: 'inconclusive' });
  });

  it('classifies a token endpoint 500 as inconclusive, not challenged', async () => {
    const seen = scriptHttps([
      { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://127.0.0.1/token",service="registry"' }, body: '{}' },
      { status: 500, headers: {}, body: '{}' },
    ]);
    const out = await probeManifestAnonymous({ host: '127.0.0.1', repo: 'acme/app', tagOrDigest: '1.0.0' });
    expect(out).toEqual({ classification: 'inconclusive' });
    expect(seen).toHaveLength(2);
  });

  it('classifies a token endpoint 429 rate limit as inconclusive, not challenged', async () => {
    const seen = scriptHttps([
      { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://127.0.0.1/token",service="registry"' }, body: '{}' },
      { status: 429, headers: {}, body: '{}' },
    ]);
    const out = await probeManifestAnonymous({ host: '127.0.0.1', repo: 'acme/app', tagOrDigest: '1.0.0' });
    expect(out).toEqual({ classification: 'inconclusive' });
    expect(seen).toHaveLength(2);
  });

  it('classifies an unparseable token endpoint 200 body as inconclusive, not challenged', async () => {
    const seen = scriptHttps([
      { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://127.0.0.1/token",service="registry"' }, body: '{}' },
      { status: 200, headers: {}, body: 'not-json' },
    ]);
    const out = await probeManifestAnonymous({ host: '127.0.0.1', repo: 'acme/app', tagOrDigest: '1.0.0' });
    expect(out).toEqual({ classification: 'inconclusive' });
    expect(seen).toHaveLength(2);
  });

  it('classifies a token realm 401 decline as challenged and never refetches the manifest', async () => {
    // A realm that refuses an anonymous token means the manifest is not
    // anonymously readable, which is exactly what 'challenged' asserts.
    const seen = scriptHttps([
      { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://127.0.0.1/token",service="registry"' }, body: '{}' },
      { status: 401, headers: {}, body: '{}' },
    ]);
    const out = await probeManifestAnonymous({ host: '127.0.0.1', repo: 'acme/app', tagOrDigest: '1.0.0' });
    expect(out).toEqual({ classification: 'challenged', status: 401 });
    expect(seen).toHaveLength(2);
  });

  it('throws instead of classifying when the caller aborts mid-probe', async () => {
    scriptHttps([
      { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://127.0.0.1/token",service="registry"' }, body: '{}' },
    ]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      probeManifestAnonymous({ host: '127.0.0.1', repo: 'acme/app', tagOrDigest: '1.0.0' }, controller.signal),
    ).rejects.toThrow();
  });
});