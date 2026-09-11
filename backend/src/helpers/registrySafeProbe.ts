import https from 'https';
import {
  assertSafeHttpsUrl,
  safeHttpsAgent,
  UnsafeOutboundTargetError,
} from '../utils/outboundTarget';
import { getErrorMessage } from '../utils/errors';
import { canonicalRefHost } from './registryPullReference';

/**
 * Thrown when a registry probe hop violates the safe-transport boundary: a
 * blocked or unresolved host, a non-HTTPS hop, an HTTPS-to-HTTP downgrade, or
 * an unauthorized cross-origin token delegation. The parent probe is recorded
 * as inconclusive and the offending hop is never connected.
 */
export class UnsafeRegistryHopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeRegistryHopError';
  }
}

const MAX_REDIRECTS = 3;
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Single-response body cap so a hostile or misbehaving registry cannot stream
 * unbounded data into a probe.
 */
export const PROBE_BODY_LIMIT_BYTES = 1024 * 1024;

const MANIFEST_ACCEPT = [
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
].join(', ');

/**
 * Cross-origin token-service delegation allowlist, keyed on the origin triple.
 * A token realm may receive a credential-bearing request only when it is
 * same-origin with the registry or names one of these provider origins (for
 * example https://auth.docker.io for Docker Hub). A path such as `ghcr.io/token`
 * is a path, not an origin, and never authorizes delegation.
 */
const AUTH_DELEGATION_ALLOWLIST = new Set([
  'https://auth.docker.io',
  'https://ghcr.io',
]);

const HUB_API_HOST = 'registry-1.docker.io';

/** Map a canonical pull-reference host to the registry API host. */
export function probeRegistryApiHost(host: string): string {
  return host === 'index.docker.io' ? HUB_API_HOST : host;
}

/**
 * Whether a token-realm origin may receive a credential-bearing delegation
 * request for a registry. Same-origin is always allowed; a cross-origin realm
 * must be named in the delegation allowlist (Docker Hub, GitHub Container
 * Registry). A lookalike or nested path never matches, because the comparison
 * is on the origin triple only.
 */
export function isAuthorizedTokenDelegation(realmOrigin: string, registryOrigin: string): boolean {
  return realmOrigin === registryOrigin || AUTH_DELEGATION_ALLOWLIST.has(realmOrigin);
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function stripAuthorization(headers: Record<string, string>): Record<string, string> {
  const { Authorization: _drop, authorization: _dropLower, ...rest } = headers;
  return rest;
}

/**
 * HTTPS-plus-safe-outbound check for a probe hop. Any safe-outbound violation
 * (blocked or unresolved host) propagates; a plaintext (or otherwise rejected)
 * URL becomes an {@link UnsafeRegistryHopError}.
 */
async function assertSafeHttpsHop(raw: string): Promise<void> {
  try {
    await assertSafeHttpsUrl(raw);
  } catch (error) {
    if (error instanceof UnsafeOutboundTargetError) throw error;
    throw new UnsafeRegistryHopError('Registry probes require HTTPS');
  }
}

/**
 * Pre-connect safety check for a registry host. Resolves the host through the
 * safe-outbound boundary (blocked-address and resolution checks) and throws
 * {@link UnsafeRegistryHopError} when the host must not be contacted. Callers
 * use this to classify a ref as inconclusive without ever connecting.
 */
export async function assertSafeRegistryHost(host: string): Promise<void> {
  try {
    await assertSafeHttpsUrl(`https://${probeRegistryApiHost(host)}/`);
  } catch (cause) {
    // Preserve the underlying reason (blocked address, resolution failure) so a
    // DNS outage never reads as a policy refusal in logs.
    const message = cause instanceof UnsafeOutboundTargetError
      ? `Registry host is not allowed for outbound probing: ${getErrorMessage(cause, 'unknown')}`
      : 'Registry host is not allowed for outbound probing';
    throw new UnsafeRegistryHopError(message);
  }
}

function httpsGet(
  rawUrl: string,
  headers: Record<string, string>,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(rawUrl, { method: 'GET', headers, agent: safeHttpsAgent }, (res) => {
      let body = '';
      let bodyBytes = 0;
      res.on('data', (chunk: Buffer) => {
        bodyBytes += chunk.length;
        if (bodyBytes > PROBE_BODY_LIMIT_BYTES) {
          const err = new Error('Registry probe response exceeded the body limit');
          req.destroy(err);
          reject(err);
          return;
        }
        body += chunk.toString();
      });
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (abortSignal) {
      abortSignal.addEventListener(
        'abort',
        () => {
          if (!req.destroyed) {
            req.destroy(new Error('Registry probe aborted'));
          }
        },
        { once: true },
      );
    }
    req.setTimeout(timeoutMs, () => {
      const err = new Error('Registry probe timed out');
      req.destroy(err);
      reject(err);
    });
    req.end();
  });
}

/**
 * Redirect-aware, credential-safe registry GET. Enforces the safe-transport
 * boundary on every hop:
 *   - HTTPS is required; an HTTPS-to-HTTP downgrade is rejected before any
 *     header is sent.
 *   - Every URL (initial and each redirect) passes the safe-outbound address
 *     check before connecting, in addition to the connection-time check in the
 *     shared safe https agent.
 *   - A cross-origin redirect strips Authorization before it is followed.
 *   - Redirect chains are capped.
 * Throws {@link UnsafeRegistryHopError} for any boundary violation.
 */
export async function safeRegistryGet(
  rawUrl: string,
  headers: Record<string, string> = {},
  timeoutMs = PROBE_TIMEOUT_MS,
  abortSignal?: AbortSignal,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  let url = rawUrl;
  let origin = new URL(rawUrl).origin;
  await assertSafeHttpsHop(url);

  for (let redirects = 0; ; redirects++) {
    const res = await httpsGet(url, headers, timeoutMs, abortSignal);
    const location = firstHeader(res.headers.location);
    const isRedirect = location != null
      && (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303
        || res.statusCode === 307 || res.statusCode === 308);
    if (!isRedirect) {
      return { status: res.statusCode, headers: res.headers, body: res.body };
    }
    if (redirects >= MAX_REDIRECTS) {
      throw new Error('Registry probe exceeded redirect limit');
    }
    const next = new URL(location, url);
    if (next.protocol !== 'https:') {
      throw new UnsafeRegistryHopError('HTTPS-to-HTTP registry redirect rejected');
    }
    await assertSafeHttpsHop(next.toString());
    if (next.origin !== origin) {
      headers = stripAuthorization(headers);
      origin = next.origin;
    }
    url = next.toString();
  }
}

function parseTokenRealm(wwwAuth: string | undefined): string | null {
  if (!wwwAuth) return null;
  const match = wwwAuth.match(/(?:^|,)\s*Bearer\s+realm="([^"]+)"/i);
  return match ? match[1] : null;
}

function parseTokenService(wwwAuth: string | undefined): string | null {
  if (!wwwAuth) return null;
  const match = wwwAuth.match(/service="([^"]+)"/i);
  return match ? match[1] : null;
}

/**
 * Anonymous token exchange against a WWW-Authenticate token realm. The realm is
 * validated at construction time against the safe-outbound, HTTPS, and
 * cross-origin delegation rules; a realm that fails is rejected before any
 * request is sent (thrown as {@link UnsafeRegistryHopError}). Returns null only
 * when the realm definitively declines an anonymous token (a 401/403 answer,
 * or a 200 body carrying no token); any transport failure throws so the
 * caller classifies inconclusive rather than mistaking an outage for a
 * challenge.
 */
async function fetchAnonymousToken(
  realmUrl: string,
  scope: string,
  service: string | null,
  registryOrigin: string,
  abortSignal?: AbortSignal,
): Promise<string | null> {
  const params = new URLSearchParams();
  if (service) params.set('service', service);
  params.set('scope', scope);
  const tokenUrl = `${realmUrl}${realmUrl.includes('?') ? '&' : '?'}${params.toString()}`;

  await assertSafeHttpsHop(tokenUrl);
  const parsed = new URL(tokenUrl);
  if (!isAuthorizedTokenDelegation(parsed.origin, registryOrigin)) {
    throw new UnsafeRegistryHopError('Cross-origin token delegation not allowed');
  }

  const res = await safeRegistryGet(tokenUrl, { Accept: 'application/json' }, PROBE_TIMEOUT_MS, abortSignal);
  if (res.status !== 200) {
    // 401/403 from the realm is a definitive decline, not an outage; anything
    // else (404, 429, 5xx) is an infrastructure failure we cannot interpret.
    if (res.status === 401 || res.status === 403) return null;
    throw new Error(`Token endpoint returned status ${res.status}`);
  }
  try {
    const body = JSON.parse(res.body) as { token?: unknown; access_token?: unknown };
    const token = body.token ?? body.access_token;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    throw new Error('Token endpoint returned an unparseable body');
  }
}

export type RegistryProbeClassification = 'public' | 'challenged' | 'inconclusive';

export interface ManifestProbeInput {
  /** Canonical pull-reference host (Docker Hub aliases folded to index.docker.io). */
  host: string;
  repo: string;
  /** Tag, or the full `algorithm:hex` digest for a digest-pinned ref. */
  tagOrDigest: string;
}

/**
 * Anonymously probe a single manifest for readability, using the safe
 * transport. Never attaches hub credentials. Classification:
 *   - 200 (or 200 after an anonymous token exchange) -> public
 *   - 401 (no realm, a declined anonymous token, or still 401/403 after
 *     a token), or a bare 403 -> challenged
 *   - 404, 429, 5xx, unsafe realm/host, timeout, or transport error -> inconclusive
 */
export async function probeManifestAnonymous(
  input: ManifestProbeInput,
  abortSignal?: AbortSignal,
): Promise<{ classification: RegistryProbeClassification; status?: number }> {
  const apiHost = probeRegistryApiHost(input.host);
  const url = `https://${apiHost}/v2/${input.repo}/manifests/${input.tagOrDigest}`;
  const headers: Record<string, string> = { Accept: MANIFEST_ACCEPT };
  if (abortSignal?.aborted) {
    throw new Error('Registry probe aborted');
  }
  try {
    let res = await safeRegistryGet(url, headers, PROBE_TIMEOUT_MS, abortSignal);
    if (res.status === 200) {
      return { classification: 'public', status: 200 };
    }
    if (res.status === 401) {
      const realm = parseTokenRealm(firstHeader(res.headers['www-authenticate']));
      if (!realm) {
        return { classification: 'challenged', status: 401 };
      }
      let token: string | null = null;
      try {
        token = await fetchAnonymousToken(
          realm,
          `repository:${input.repo}:pull`,
          parseTokenService(firstHeader(res.headers['www-authenticate'])),
          `https://${apiHost}`,
          abortSignal,
        );
      } catch (error) {
        // Unsafe realm or a transport failure: we cannot determine publicness.
        console.warn(
          `[registrySafeProbe] anonymous token exchange failed for ${apiHost}/${input.repo}:`,
          getErrorMessage(error, 'unknown'),
        );
        return { classification: 'inconclusive' };
      }
      if (token) {
        res = await safeRegistryGet(url, { ...headers, Authorization: `Bearer ${token}` }, PROBE_TIMEOUT_MS, abortSignal);
      }
      if (res.status === 200) {
        return { classification: 'public', status: 200 };
      }
      // With the token resolved, only 401/403 proves the manifest is
      // credential-gated; anything else (404, 429, 5xx) passes through without
      // a refusal or a delivery.
      if (res.status === 401 || res.status === 403) {
        return { classification: 'challenged', status: res.status };
      }
      return { classification: 'inconclusive', status: res.status };
    }
    if (res.status === 403) {
      return { classification: 'challenged', status: 403 };
    }
    // 404, 429, 5xx, and anything else: pass through, no refuse, no deliver.
    return { classification: 'inconclusive', status: res.status };
  } catch (error) {
    if (abortSignal?.aborted) {
      // Let the caller's abort mapping answer 499 instead of swallowing the
      // cancellation as an inconclusive probe.
      throw error;
    }
    // Caller logs REGISTRY_DELIVERY_UNSAFE_REGISTRY_TARGET for unsafe hosts.
    console.warn(
      `[registrySafeProbe] manifest probe failed for ${apiHost}/${input.repo}:`,
      getErrorMessage(error, 'unknown'),
    );
    return { classification: 'inconclusive' };
  }
}

/** Split a canonical pull reference into the parts a manifest probe needs. */
export function splitPullRefForProbe(value: string): ManifestProbeInput {
  const host = canonicalRefHost(value);
  if (host === null) {
    throw new Error(`Pull reference has no registry host: ${value}`);
  }
  const rest = value.slice(value.indexOf('/') + 1);
  const at = rest.indexOf('@');
  if (at !== -1) {
    return { host, repo: rest.slice(0, at), tagOrDigest: rest.slice(at + 1) };
  }
  const colon = rest.lastIndexOf(':');
  return { host, repo: rest.slice(0, colon), tagOrDigest: rest.slice(colon + 1) };
}
