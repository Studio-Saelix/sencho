import https from 'https';
import http from 'http';
import crypto from 'crypto';
import { sanitizeForLog } from '../utils/safeLog';
import { getErrorMessage } from '../utils/errors';
import { CacheService } from './CacheService';

export interface ParsedRef {
    registry: string;
    repo: string;
    tag: string;
}

export interface HttpResult {
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
}

export interface RegistryCredentials {
    username: string;
    password: string;
}

export function parseImageRef(imageRef: string): ParsedRef | null {
    if (imageRef.startsWith('sha256:')) return null;

    const atIdx = imageRef.indexOf('@');
    if (atIdx !== -1) imageRef = imageRef.slice(0, atIdx);

    let registry = 'registry-1.docker.io';
    let rest = imageRef;

    const slashIdx = imageRef.indexOf('/');
    if (slashIdx !== -1) {
        const firstPart = imageRef.slice(0, slashIdx);
        if (firstPart.includes('.') || firstPart.includes(':') || firstPart === 'localhost') {
            // docker.io / index.docker.io are Docker Hub aliases; normalize them to the
            // actual registry API host so requests never hit the marketing domain (which
            // redirects instead of serving /v2/) and the library/ auto-prefix below still applies.
            registry = (firstPart === 'docker.io' || firstPart === 'index.docker.io')
                ? 'registry-1.docker.io'
                : firstPart;
            rest = imageRef.slice(slashIdx + 1);
        }
    }

    let tag = 'latest';
    const colonIdx = rest.lastIndexOf(':');
    if (colonIdx > 0) {
        tag = rest.slice(colonIdx + 1);
        rest = rest.slice(0, colonIdx);
    }

    if (registry === 'registry-1.docker.io' && !rest.includes('/')) {
        rest = `library/${rest}`;
    }

    return { registry, repo: rest, tag };
}

export function httpRequest(
    url: string,
    method: 'GET' | 'HEAD',
    headers: Record<string, string> = {},
    timeoutMs = 10000,
): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https:') ? https : http;
        let settled = false;
        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            fn();
        };
        const req = lib.request(url, { method, headers }, (res) => {
            let body = '';
            res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
            res.on('end', () => finish(() => resolve({
                statusCode: res.statusCode ?? 0,
                headers: res.headers as Record<string, string | string[] | undefined>,
                body,
            })));
            res.on('error', (err) => finish(() => reject(err)));
        });
        req.on('error', (err) => finish(() => reject(err)));
        req.setTimeout(timeoutMs, () => {
            const err = new Error('Request timed out');
            req.destroy(err);
            finish(() => reject(err));
        });
        req.end();
    });
}

export function httpGet(
    url: string,
    headers: Record<string, string> = {},
    timeoutMs = 10000,
): Promise<HttpResult> {
    return httpRequest(url, 'GET', headers, timeoutMs);
}

export interface CappedHttpResult {
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
    /** Raw response bytes. Empty when truncated. Decoded only after integrity checks. */
    bodyBytes: Buffer;
    /** True when the response exceeded the cap and was aborted mid-stream. */
    truncated: boolean;
}

/**
 * GET with a hard cap on the accumulated response body, aborting the stream
 * as soon as more than `capBytes` has arrived rather than accumulating an
 * unbounded body and checking its size afterward. Used for manifest bodies
 * fetched for index-expansion classification, where a hostile or
 * misbehaving registry could otherwise return an arbitrarily large payload.
 *
 * Chunks are kept as Buffers and concatenated once. Decoding per chunk would
 * corrupt multibyte UTF-8 sequences that straddle TCP boundaries and break
 * content-addressed digest verification.
 */
export function httpGetCapped(
    url: string,
    headers: Record<string, string>,
    capBytes: number,
    timeoutMs = 10000,
): Promise<CappedHttpResult> {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https:') ? https : http;
        let settled = false;
        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            fn();
        };
        const req = lib.request(url, { method: 'GET', headers }, (res) => {
            const chunks: Buffer[] = [];
            let received = 0;
            const cappedResult = (bodyBytes: Buffer, truncated: boolean): CappedHttpResult => ({
                statusCode: res.statusCode ?? 0,
                headers: res.headers as Record<string, string | string[] | undefined>,
                bodyBytes,
                truncated,
            });
            res.on('data', (chunk: Buffer) => {
                if (settled) return;
                received += chunk.length;
                if (received > capBytes) {
                    finish(() => resolve(cappedResult(Buffer.alloc(0), true)));
                    res.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => finish(() => resolve(cappedResult(Buffer.concat(chunks, received), false))));
            res.on('error', (err) => finish(() => reject(err)));
        });
        req.on('error', (err) => finish(() => reject(err)));
        req.setTimeout(timeoutMs, () => {
            const err = new Error('Request timed out');
            req.destroy(err);
            finish(() => reject(err));
        });
        req.end();
    });
}

export async function getAuthToken(
    registry: string,
    repo: string,
    credentials?: RegistryCredentials | null,
): Promise<string | null> {
    // Transport errors propagate (callers map to REGISTRY_UPSTREAM). null = auth/token failure only.
    const basicHeaders: Record<string, string> = {};
    if (credentials) {
        basicHeaders['Authorization'] = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
    }

    let tokenUrl: string;
    if (registry === 'registry-1.docker.io') {
        tokenUrl = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`;
    } else {
        const ping = await httpGet(`https://${registry}/v2/`, basicHeaders);
        const wwwAuth = ping.headers['www-authenticate'] as string | undefined;
        if (!wwwAuth) return null;

        const realmMatch = wwwAuth.match(/realm="([^"]+)"/);
        const serviceMatch = wwwAuth.match(/service="([^"]+)"/);
        if (!realmMatch) return null;

        const params = new URLSearchParams();
        if (serviceMatch) params.set('service', serviceMatch[1]);
        // The /v2/ ping carries no repository context, so any scope it echoes is a
        // placeholder (ghcr.io returns repository:user/image:pull). Always request
        // the scope for the repository we actually want; reusing the echoed scope
        // makes ghcr.io mint a token for the wrong repo and then reject the pull.
        params.set('scope', `repository:${repo}:pull`);
        tokenUrl = `${realmMatch[1]}?${params.toString()}`;
    }

    const tokenRes = await httpGet(tokenUrl, basicHeaders);
    if (tokenRes.statusCode !== 200) return null;

    try {
        const parsed = JSON.parse(tokenRes.body) as { token?: unknown; access_token?: unknown };
        const token = parsed.token ?? parsed.access_token;
        return typeof token === 'string' ? token : null;
    } catch {
        return null;
    }
}

const MANIFEST_ACCEPT = [
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.docker.distribution.manifest.v2+json',
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.oci.image.manifest.v1+json',
].join(', ');

/**
 * docker.io has three hostnames that all address the same registry. Folds two
 * already-parsed ParsedRef.registry values down to a shared form for equality/cache-key
 * comparisons; not the canonical form parseImageRef assigns (which normalizes to
 * 'registry-1.docker.io').
 */
function canonicalRegistry(host: string): string {
    if (host === 'docker.io' || host === 'index.docker.io' || host === 'registry-1.docker.io') {
        return 'docker.io';
    }
    return host;
}

/**
 * True when a local RepoDigest entry ("name@sha256:...") refers to the same
 * registry + repository as the parsed image ref. Parses the name side through
 * the same normalization as the image ref (Docker Hub's implicit `library/`
 * namespace and default registry), replacing a fragile substring check that
 * missed `library/*` official images: their RepoDigests read `nginx@sha256:...`,
 * never `library/nginx@...`, so `name.includes('library/nginx')` was false.
 */
export function repoDigestMatchesRef(repoDigest: string, parsed: ParsedRef): boolean {
    const at = repoDigest.indexOf('@');
    if (at === -1) return false;
    const parsedName = parseImageRef(repoDigest.slice(0, at));
    if (!parsedName) return false;
    return canonicalRegistry(parsedName.registry) === canonicalRegistry(parsed.registry)
        && parsedName.repo === parsed.repo;
}

const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/i;

/**
 * All usable local RepoDigests for a parsed image ref, shared by the scanner
 * and update preview. Returns every valid digest whose repository matches the
 * ref (deduped, first-seen order), else []. A truncated or malformed digest is
 * never selected, and a valid digest belonging to an unrelated repository
 * (e.g. left over from a retag) is never selected either, so either surfaces
 * as "could not resolve" rather than a guessed match or update. Callers must
 * compare every candidate: Docker can list a stale index digest ahead of the
 * current one on the same image.
 */
export function selectLocalRepoDigests(repoDigests: readonly string[], parsed: ParsedRef): string[] {
    const valid = repoDigests
        .map((entry) => {
            const at = entry.indexOf('@');
            return at === -1 ? null : { entry, digest: entry.slice(at + 1) };
        })
        .filter((e): e is { entry: string; digest: string } => e !== null && SHA256_DIGEST_RE.test(e.digest));

    const matched: string[] = [];
    const seen = new Set<string>();
    for (const e of valid) {
        if (!repoDigestMatchesRef(e.entry, parsed)) continue;
        const key = e.digest.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        matched.push(e.digest);
    }
    // No digest matches the configured repository: comparing an unrelated
    // repository's digest (e.g. a retag) risks a false update against a
    // registry state that has nothing to do with the image actually
    // declared. Report unresolved instead of guessing.
    return matched;
}

/**
 * Scalar view of {@link selectLocalRepoDigests}: the first candidate, or null.
 * Prefer the plural form when comparing against a remote tag.
 */
export function selectLocalRepoDigest(repoDigests: readonly string[], parsed: ParsedRef): string | null {
    return selectLocalRepoDigests(repoDigests, parsed)[0] ?? null;
}

/** Outcome of a remote-digest lookup: the digest, or a human-readable reason it failed. */
export type RemoteDigestResult =
    | { ok: true; digest: string }
    | { ok: false; reason: string };

/**
 * Map a non-success manifest status to a specific reason so a caller can tell an auth
 * failure from a rate limit, a missing image, or a server error, rather than collapsing
 * them all into "unreachable". `ref` is the resolved "<registry>/<repo>:<tag>" for the
 * image after Docker Hub normalization, not necessarily the literal string the user wrote.
 */
function manifestFailureReason(statusCode: number, ref: string, headers: HttpResult['headers']): string {
    if (statusCode === 401 || statusCode === 403) return `Authentication failed for ${ref}`;
    if (statusCode === 429) {
        const retry = headers['retry-after'];
        const retryStr = Array.isArray(retry) ? retry[0] : retry;
        return retryStr
            ? `Rate limited by registry for ${ref} (retry after ${retryStr})`
            : `Rate limited by registry for ${ref}`;
    }
    if (statusCode === 404) return `Image not found: ${ref}`;
    if (statusCode >= 500) return `Registry error (${statusCode}) for ${ref}`;
    return `Registry returned status ${statusCode} for ${ref}`;
}

function firstHeaderValue(v: string | string[] | undefined): string | undefined {
    return Array.isArray(v) ? v[0] : v;
}

const MANIFEST_EXPANSION_BODY_CAP_BYTES = 1024 * 1024; // 1 MiB streaming abort

interface ManifestProbeSuccess {
    digest: string;
    contentType: string | undefined;
    /** Raw body from the GET fallback on HEAD 405/501/missing-digest, or null when a HEAD 200 with a digest header was all that was needed. */
    body: Buffer | null;
    /**
     * Accept + optional Bearer token used for this probe. Reused for a same-repo
     * digest-pinned expansion GET so it does not re-authenticate. Never returned
     * from an exported function.
     */
    authHeaders: Record<string, string>;
}

type ManifestProbeOutcome =
    | { ok: true; result: ManifestProbeSuccess }
    | { ok: false; reason: string };

/**
 * Shared HEAD-first / GET-fallback manifest lookup for a tag or digest reference.
 * Owns auth, the HEAD request, the GET-on-405/501-or-missing-digest fallback (bounded
 * to {@link MANIFEST_EXPANSION_BODY_CAP_BYTES}), and digest/content-type extraction.
 * Never parses or classifies a manifest body; that is the comparison resolver's job.
 * Both the public no-expansion digest lookup ({@link getRemoteDigestResult}) and the
 * comparison resolver ({@link compareLocalToRemoteTag}) call this so neither duplicates
 * the transport or auth-fallback logic. A 401/403/404/429/5xx HEAD reports its specific
 * reason without a GET retry, since the bearer token is fetched up-front, so a 401 here
 * is a real auth failure rather than a token-scope challenge to retry.
 */
async function probeManifestForRef(
    registry: string,
    repo: string,
    tagOrDigest: string,
    credentials: RegistryCredentials | null | undefined,
    ref: string,
): Promise<ManifestProbeOutcome> {
    try {
        // Auth transport failures used to collapse to null inside getAuthToken.
        // Tag listing now needs those errors to propagate (REGISTRY_UPSTREAM), so
        // digest lookup keeps anonymous fallback here when the token endpoint is down.
        let token: string | null = null;
        try {
            token = await getAuthToken(registry, repo, credentials);
        } catch (authErr) {
            const cause = authErr instanceof Error
                ? ((authErr as NodeJS.ErrnoException).code ?? authErr.message)
                : String(authErr);
            console.error(
                `[registry-api] Auth for ${sanitizeForLog(ref)} failed; trying anonymous:`,
                sanitizeForLog(cause),
            );
        }
        // Reject tag/repo components with characters that could alter the
        // URL structure. Docker tags are restricted to [a-zA-Z0-9._-] per the
        // OCI distribution spec; / ? # \ and null bytes are never valid. Repo
        // path segments are [a-z0-9]+ separator . _ -; a .. segment is never
        // valid and would enable path traversal. The image ref originates from
        // an admin-controlled compose file, so this guard is defense-in-depth:
        // the admin already has code execution on the host.
        if (/[/?#\\]/.test(tagOrDigest) || tagOrDigest.includes('\0')) {
            return { ok: false, reason: `Invalid tag "${sanitizeForLog(tagOrDigest)}" for ${ref}` };
        }
        if (/\.\./.test(repo)) {
            return { ok: false, reason: `Invalid repository path "${sanitizeForLog(repo)}" for ${ref}` };
        }

        const authHeaders: Record<string, string> = { Accept: MANIFEST_ACCEPT };
        if (token) authHeaders['Authorization'] = `Bearer ${token}`;
        const url = `https://${registry}/v2/${repo}/manifests/${tagOrDigest}`;

        const head = await httpRequest(url, 'HEAD', authHeaders);
        if (head.statusCode === 200) {
            const digest = head.headers['docker-content-digest'];
            if (typeof digest === 'string') {
                return {
                    ok: true,
                    result: { digest, contentType: firstHeaderValue(head.headers['content-type']), body: null, authHeaders },
                };
            }
            // 200 without the digest header: fall through to GET to read it from there.
        } else if (head.statusCode !== 405 && head.statusCode !== 501) {
            return { ok: false, reason: manifestFailureReason(head.statusCode, ref, head.headers) };
        }

        const res = await httpGetCapped(url, authHeaders, MANIFEST_EXPANSION_BODY_CAP_BYTES);
        if (res.statusCode === 200) {
            const digest = res.headers['docker-content-digest'];
            if (typeof digest === 'string') {
                return {
                    ok: true,
                    result: {
                        digest,
                        contentType: firstHeaderValue(res.headers['content-type']),
                        // A truncated body cannot be classified; treat it as absent so a
                        // caller that needs it (the comparison resolver) re-fetches by
                        // digest and hits the same oversize condition explicitly.
                        body: res.truncated ? null : res.bodyBytes,
                        authHeaders,
                    },
                };
            }
            // 200 on both HEAD and GET but no digest header: a spec-violating registry.
            return { ok: false, reason: `Registry returned no digest for ${ref}` };
        }
        return { ok: false, reason: manifestFailureReason(res.statusCode, ref, res.headers) };
    } catch (e) {
        // Bind and log the cause: a bare catch here would flatten DNS, TLS, connection-
        // refused, and timeout failures into one opaque string with nothing in the logs,
        // the silent-failure mode this function exists to remove. Prefer the errno code
        // (ENOTFOUND/ECONNREFUSED/ETIMEDOUT/...) over a verbose message so the reason
        // stays short in the sidebar tooltip; fall back to the message otherwise.
        const cause = e instanceof Error ? ((e as NodeJS.ErrnoException).code ?? e.message) : String(e);
        // ref and cause derive from the compose-authored image string and upstream error
        // text, so neutralize control characters before they reach the log line.
        console.error(`[registry-api] Remote digest lookup for ${sanitizeForLog(ref)} failed:`, sanitizeForLog(cause));
        return { ok: false, reason: `Registry unreachable for ${ref} (${cause})` };
    }
}

/**
 * Resolve the remote manifest digest for an image, returning either the digest or the
 * reason the lookup failed. Delegates to {@link probeManifestForRef}: success is
 * determined solely by a valid docker-content-digest header, even if the body (when one
 * was fetched) turns out to be malformed. No index expansion happens on this path; it is
 * shared with {@link isSenchoVersionPublished} in version-check.ts.
 */
export async function getRemoteDigestResult(
    registry: string,
    repo: string,
    tag: string,
    credentials?: RegistryCredentials | null,
): Promise<RemoteDigestResult> {
    const ref = `${registry}/${repo}:${tag}`;
    const probe = await probeManifestForRef(registry, repo, tag, credentials, ref);
    return probe.ok ? { ok: true, digest: probe.result.digest } : { ok: false, reason: probe.reason };
}

/**
 * Digest-or-null view of {@link getRemoteDigestResult} for callers that only need the
 * digest and treat any failure as "unknown" (e.g. the update-preview tag/digest diff).
 */
export async function getRemoteDigest(
    registry: string,
    repo: string,
    tag: string,
    credentials?: RegistryCredentials | null,
): Promise<string | null> {
    const result = await getRemoteDigestResult(registry, repo, tag, credentials);
    return result.ok ? result.digest : null;
}

// ─── Multi-arch comparison resolver ─────────────────────────────────────────
//
// Fixes the false-positive multi-arch update: a local RepoDigest can be a
// platform child manifest (e.g. the linux/amd64 manifest) while the registry's
// tag resolves to the parent index/manifest-list digest. A naive
// `localDigest !== remoteDigest` then reports an update even though the
// platform content is current. compareLocalToRemoteTag expands the index
// (once per immutable digest, cached 24h) and checks membership instead.

interface ManifestPlatformDescriptor {
    digest: string;
    os: string;
    architecture: string;
    variant?: string;
}

type ManifestClassification =
    | { kind: 'single' }
    | {
        kind: 'index';
        descriptors: ManifestPlatformDescriptor[];
        /** Leaf digests with no platform metadata; matched by exact digest membership only. */
        exactDigests: string[];
    };

/** Result of comparing a local image digest to the registry's current manifest for a tag. */
export type DigestComparisonResult =
    | { kind: 'match' }
    | { kind: 'update' }
    | { kind: 'error'; reason: string };

export const MANIFEST_CLASSIFICATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const MANIFEST_INDEX_DESCRIPTOR_CAP = 256;
/** Max nested index documents in a chain (primary + nested). Exceeding this fails closed. */
export const MANIFEST_INDEX_MAX_DEPTH = 3;

const MANIFEST_CLASSIFICATION_CACHE_NAMESPACE = 'img-upd-idx';

/** Media types that are never an index/manifest-list: a mismatch against one of these is a definite update, no body fetch needed. */
const SINGLE_MANIFEST_MEDIA_TYPES = new Set([
    'application/vnd.docker.distribution.manifest.v2+json',
    'application/vnd.docker.distribution.manifest.v1+json',
    'application/vnd.oci.image.manifest.v1+json',
]);

const INDEX_MANIFEST_MEDIA_TYPES = new Set([
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
]);

/**
 * Cache key for a validated manifest classification. Namespaced for
 * CacheService stats, keyed by the immutable primary digest (so a changed
 * manifest is a cache miss, never stale data), and hashes the repository
 * component so a capacity-cap warning log never leaks a raw compose image
 * string.
 */
function manifestClassificationCacheKey(registry: string, repo: string, primaryDigest: string): string {
    const repoHash = crypto.createHash('sha256').update(repo).digest('hex');
    return `${MANIFEST_CLASSIFICATION_CACHE_NAMESPACE}:${canonicalRegistry(registry)}/${repoHash}@${primaryDigest}`;
}

/** One parsed index document before nested digests are expanded. */
interface IndexParseSlice {
    kind: 'slice';
    descriptors: ManifestPlatformDescriptor[];
    exactDigests: string[];
    nestedDigests: string[];
}

function indexSliceSize(slice: IndexParseSlice): number {
    return slice.descriptors.length + slice.exactDigests.length + slice.nestedDigests.length;
}

/**
 * Parse one index/manifest-list body into platform descriptors, exact-digest
 * leaf candidates (no platform), and nested index digests to fetch. Throws on
 * malformed JSON, an oversize descriptor array, or a non-attestation descriptor
 * whose media type is neither a known leaf nor a known index (fail closed so
 * compare never treats incomplete classification as a definite update).
 */
function parseIndexBody(body: string): { kind: 'single' } | IndexParseSlice {
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        throw new Error('Manifest body is not valid JSON');
    }
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Manifest body is not a JSON object');
    }
    const rawManifests = (parsed as { manifests?: unknown }).manifests;
    if (!Array.isArray(rawManifests)) {
        // No manifests array: a single-platform manifest (image config + layers), not an index.
        return { kind: 'single' };
    }
    if (rawManifests.length > MANIFEST_INDEX_DESCRIPTOR_CAP) {
        throw new Error(`Manifest index has ${rawManifests.length} descriptors, exceeding the ${MANIFEST_INDEX_DESCRIPTOR_CAP} cap`);
    }

    const descriptors: ManifestPlatformDescriptor[] = [];
    const exactDigests: string[] = [];
    const nestedDigests: string[] = [];

    for (const entry of rawManifests) {
        if (!entry || typeof entry !== 'object') {
            throw new Error('Manifest index has a malformed descriptor entry');
        }
        const e = entry as Record<string, unknown>;
        const digest = typeof e.digest === 'string' && e.digest.length > 0 ? e.digest : null;
        if (!digest) {
            throw new Error('Manifest index descriptor is missing a digest');
        }
        if (!SHA256_DIGEST_RE.test(digest)) {
            throw new Error('Manifest index descriptor has a malformed digest');
        }

        const annotations = e.annotations as Record<string, unknown> | undefined;
        if (annotations?.['vnd.docker.reference.type'] === 'attestation-manifest') continue;

        const mediaType = typeof e.mediaType === 'string' ? e.mediaType : '';
        if (!mediaType) {
            throw new Error('Manifest index descriptor is missing a media type');
        }
        // Nested indexes must be queued before unknown/unknown filtering: OCI allows
        // platform on index descriptors, and skipping them would yield a false update.
        if (INDEX_MANIFEST_MEDIA_TYPES.has(mediaType)) {
            nestedDigests.push(digest);
            continue;
        }
        if (!SINGLE_MANIFEST_MEDIA_TYPES.has(mediaType)) {
            throw new Error(`Manifest index has an unrecognized descriptor media type (${mediaType})`);
        }

        const platform = e.platform as Record<string, unknown> | undefined;
        const os = platform && typeof platform.os === 'string' ? platform.os : null;
        const architecture = platform && typeof platform.architecture === 'string' ? platform.architecture : null;
        if (os === 'unknown' && architecture === 'unknown') continue;

        if (os && architecture) {
            const variant = platform && typeof platform.variant === 'string' ? platform.variant : undefined;
            descriptors.push(variant ? { digest, os, architecture, variant } : { digest, os, architecture });
        } else {
            // OCI allows platform to be omitted on a runnable descriptor. Keep the
            // digest for exact membership; do not invent a platform match.
            exactDigests.push(digest);
        }
    }

    return { kind: 'slice', descriptors, exactDigests, nestedDigests };
}

/** Content-addressable digest of raw response bytes (`sha256:` + hex). */
function contentDigestOfBytes(buf: Buffer): string {
    return `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;
}

/**
 * Fetch a manifest by its immutable digest (never a mutable tag) for
 * index-expansion classification, reusing the auth headers from the tag
 * probe rather than re-authenticating. Throws on any transport failure, a
 * mismatched docker-content-digest header, a body whose sha256 does not
 * equal the requested digest, or a truncated (oversize) body, so a bad
 * fetch can never resolve as a cacheable classification.
 * Returns verified raw bytes; callers decode to UTF-8 only after this check.
 */
async function fetchManifestBytesByDigest(
    registry: string,
    repo: string,
    digest: string,
    authHeaders: Record<string, string>,
    ref: string,
): Promise<Buffer> {
    if (!SHA256_DIGEST_RE.test(digest)) {
        throw new Error(`Manifest digest is malformed for ${ref}`);
    }
    const url = `https://${registry}/v2/${repo}/manifests/${digest}`;
    const res = await httpGetCapped(url, authHeaders, MANIFEST_EXPANSION_BODY_CAP_BYTES);
    if (res.statusCode !== 200) {
        throw new Error(manifestFailureReason(res.statusCode, ref, res.headers));
    }
    if (res.truncated) {
        throw new Error(`Manifest at digest for ${ref} exceeded ${MANIFEST_EXPANSION_BODY_CAP_BYTES} bytes`);
    }
    const returned = res.headers['docker-content-digest'];
    if (typeof returned === 'string' && returned !== digest) {
        throw new Error(`Registry returned a mismatched digest for ${ref}`);
    }
    // Always verify the raw body. Trusting only the response header would
    // skip integrity when the header is absent and would accept a
    // header/body pair that a cache or proxy fabricated.
    if (contentDigestOfBytes(res.bodyBytes) !== digest) {
        throw new Error(`Registry response body does not match the requested digest for ${ref}`);
    }
    return res.bodyBytes;
}

/**
 * Flatten an index (and nested indexes) into platform + exact-digest membership
 * lists. Digest-pinned only; never re-GETs a mutable tag. Depth, visited-digest,
 * and per-index descriptor caps fail closed as thrown errors.
 */
async function resolveIndexClassification(
    primaryBody: string,
    primaryDigest: string,
    registry: string,
    repo: string,
    authHeaders: Record<string, string>,
    ref: string,
    contentType: string | undefined,
): Promise<ManifestClassification> {
    const first = parseIndexBody(primaryBody);
    if (first.kind === 'single') {
        // Index Content-Type with a non-index body is incomplete classification.
        // Fail closed rather than treating the mismatch as a definite update.
        if (contentType && INDEX_MANIFEST_MEDIA_TYPES.has(contentType)) {
            throw new Error(`Manifest Content-Type is an image index but the body has no manifests array for ${ref}`);
        }
        return first;
    }

    const descriptors: ManifestPlatformDescriptor[] = [...first.descriptors];
    const exactDigests = new Set<string>(first.exactDigests);
    const visited = new Set<string>([primaryDigest]);
    const queue: { digest: string; depth: number }[] = first.nestedDigests.map((digest) => ({ digest, depth: 1 }));
    let totalDescriptors = indexSliceSize(first);

    while (queue.length > 0) {
        const item = queue.shift();
        if (!item) break;
        const { digest, depth } = item;
        if (visited.has(digest)) continue;
        if (depth >= MANIFEST_INDEX_MAX_DEPTH) {
            throw new Error(`Manifest index nesting exceeds the depth limit of ${MANIFEST_INDEX_MAX_DEPTH} for ${ref}`);
        }
        visited.add(digest);

        const nestedBytes = await fetchManifestBytesByDigest(registry, repo, digest, authHeaders, ref);
        const nested = parseIndexBody(nestedBytes.toString('utf8'));
        if (nested.kind === 'single') {
            // A digest advertised as an index media type resolved to a non-index body.
            throw new Error(`Nested manifest at ${digest} is not an image index`);
        }
        totalDescriptors += indexSliceSize(nested);
        if (totalDescriptors > MANIFEST_INDEX_DESCRIPTOR_CAP) {
            throw new Error(`Manifest index expansion exceeds the ${MANIFEST_INDEX_DESCRIPTOR_CAP} descriptor cap`);
        }
        descriptors.push(...nested.descriptors);
        for (const d of nested.exactDigests) exactDigests.add(d);
        for (const nestedDigest of nested.nestedDigests) {
            if (!visited.has(nestedDigest)) {
                queue.push({ digest: nestedDigest, depth: depth + 1 });
            }
        }
    }

    return { kind: 'index', descriptors, exactDigests: [...exactDigests] };
}

/**
 * Classify the manifest at `primaryDigest`, using CacheService (24h TTL,
 * stale-on-error for a same-key expired entry) so repeated periodic scans do
 * not re-fetch the same immutable manifest body. A known single-manifest
 * Content-Type short-circuits to `{ kind: 'single' }` without a body fetch.
 * A cache-cap refusal (CacheService.set logs and refuses, but still returns
 * the computed value) degrades to an uncached comparison, not an error.
 */
async function classifyManifest(
    registry: string,
    repo: string,
    primaryDigest: string,
    contentType: string | undefined,
    probeBody: Buffer | null,
    authHeaders: Record<string, string>,
    ref: string,
): Promise<ManifestClassification> {
    const cacheKey = manifestClassificationCacheKey(registry, repo, primaryDigest);
    const cache = CacheService.getInstance();

    if (contentType && SINGLE_MANIFEST_MEDIA_TYPES.has(contentType)) {
        const classification: ManifestClassification = { kind: 'single' };
        cache.set(cacheKey, classification, MANIFEST_CLASSIFICATION_CACHE_TTL_MS);
        return classification;
    }

    return cache.getOrFetch(cacheKey, MANIFEST_CLASSIFICATION_CACHE_TTL_MS, async () => {
        // If the fallback GET already returned a body, classify that only when
        // its content digest matches the primary digest from the probe. Never
        // re-fetch the floating tag.
        let bodyBytes: Buffer;
        if (probeBody !== null) {
            if (contentDigestOfBytes(probeBody) !== primaryDigest) {
                throw new Error(`Registry response body does not match the requested digest for ${ref}`);
            }
            bodyBytes = probeBody;
        } else {
            bodyBytes = await fetchManifestBytesByDigest(registry, repo, primaryDigest, authHeaders, ref);
        }
        return resolveIndexClassification(
            bodyBytes.toString('utf8'),
            primaryDigest,
            registry,
            repo,
            authHeaders,
            ref,
            contentType,
        );
    });
}

/**
 * Compare local image digests to the registry's current manifest for a tag,
 * returning the probe's primary digest alongside the verdict so a caller that
 * needs both (e.g. a self-build detector reporting the new digest) does not
 * have to re-probe the mutable tag. Any candidate that equals the remote
 * primary or is a member of that primary's index counts as current (Docker
 * often lists a stale index digest ahead of the current one). `platform` is
 * the local image's Os/Architecture (from `docker image inspect`), required
 * to safely match against an index's platform descriptors; without it, an
 * index mismatch is an error rather than a speculative match. Never retries
 * against the mutable tag once a primary digest is established:
 * classification always targets that digest.
 *
 * `update` is returned only after a successful, complete remote classification
 * with no candidate matching the primary, an exact member, or a same-platform
 * runnable descriptor that the index actually offers. When the index has no
 * descriptor labeled for the local platform, a platform-less leaf (which OCI
 * permits) is trusted as this platform's content only when it is the ONLY
 * kind of descriptor present (nothing else in the index claims a different
 * platform); an index that mixes platform-less leaves with descriptors
 * labeled for other platforms cannot attribute the unlabeled ones and errors
 * instead. Empty/all-malformed candidates, unknown platform when platform
 * matching is required, an index with no runnable content for the local
 * platform at all (including an empty or fully-filtered index), and
 * classification failures also return `error`. `primaryDigest` is present
 * once a valid primary digest has been read from the registry, including on
 * `error` results from a later classification failure; it is absent only
 * when the local candidate digests are malformed, the probe itself failed,
 * or the registry's primary digest fails validation.
 */
export async function compareLocalToRemoteTagDetailed(
    localDigests: readonly string[],
    registry: string,
    repo: string,
    tag: string,
    platform: { os: string; architecture: string },
    credentials?: RegistryCredentials | null,
): Promise<{ kind: 'match' | 'update' | 'error'; primaryDigest?: string; reason?: string }> {
    const candidates = localDigests.filter((d) => SHA256_DIGEST_RE.test(d));
    if (candidates.length === 0) {
        return { kind: 'error', reason: 'Local digest is malformed or truncated' };
    }
    const candidateSet = new Set(candidates.map((d) => d.toLowerCase()));

    const ref = `${registry}/${repo}:${tag}`;
    const probe = await probeManifestForRef(registry, repo, tag, credentials, ref);
    if (!probe.ok) return { kind: 'error', reason: probe.reason };

    const { digest: primaryDigest, contentType, body, authHeaders } = probe.result;
    if (!SHA256_DIGEST_RE.test(primaryDigest)) {
        return { kind: 'error', reason: `Registry returned a malformed digest for ${ref}` };
    }
    if (candidateSet.has(primaryDigest.toLowerCase())) return { kind: 'match', primaryDigest };

    let classification: ManifestClassification;
    try {
        classification = await classifyManifest(registry, repo, primaryDigest, contentType, body, authHeaders, ref);
    } catch (e) {
        return { kind: 'error', primaryDigest, reason: getErrorMessage(e, `Failed to classify remote manifest for ${ref}`) };
    }

    if (classification.kind === 'single') return { kind: 'update', primaryDigest };

    if (classification.exactDigests.some((d) => candidateSet.has(d.toLowerCase()))) return { kind: 'match', primaryDigest };

    if (!platform.os || !platform.architecture) {
        return { kind: 'error', primaryDigest, reason: `Local image platform is unknown; cannot verify multi-arch membership for ${ref}` };
    }

    const platformDescriptors = classification.descriptors.filter(
        (d) => d.os === platform.os && d.architecture === platform.architecture,
    );
    if (platformDescriptors.length === 0) {
        // No descriptor is labeled for this platform. exactDigests leaves omit
        // platform entirely (OCI allows this), so they cannot be attributed to
        // any specific platform; their mere presence does not prove content
        // for THIS one, especially when other descriptors in the same index
        // are explicitly labeled for a different platform. Only when every
        // descriptor in the index is unlabeled (classification.descriptors is
        // empty) does a leaf's presence plausibly represent this platform's
        // content, since nothing else claims a different one; that is the one
        // case where reporting `update` instead of failing closed is safe.
        if (classification.exactDigests.length === 0) {
            return { kind: 'error', primaryDigest, reason: `Remote image index has no ${platform.os}/${platform.architecture} variant for ${ref}` };
        }
        if (classification.descriptors.length > 0) {
            return { kind: 'error', primaryDigest, reason: `Remote image index has no confirmed ${platform.os}/${platform.architecture} variant for ${ref}` };
        }
        return { kind: 'update', primaryDigest };
    }

    const isMember = platformDescriptors.some((d) => candidateSet.has(d.digest.toLowerCase()));
    return isMember ? { kind: 'match', primaryDigest } : { kind: 'update', primaryDigest };
}

/**
 * Verdict-only view of {@link compareLocalToRemoteTagDetailed} for callers
 * that never need the primary digest.
 */
export async function compareLocalToRemoteTag(
    localDigests: readonly string[],
    registry: string,
    repo: string,
    tag: string,
    platform: { os: string; architecture: string },
    credentials?: RegistryCredentials | null,
): Promise<DigestComparisonResult> {
    const result = await compareLocalToRemoteTagDetailed(localDigests, registry, repo, tag, platform, credentials);
    return result.kind === 'error' ? { kind: 'error', reason: result.reason ?? 'Unknown error' } : { kind: result.kind };
}

export type TagListCode =
    | 'REGISTRY_UNAUTHORIZED'
    | 'REGISTRY_FORBIDDEN'
    | 'REGISTRY_NOT_FOUND'
    | 'REGISTRY_RATE_LIMITED'
    | 'REGISTRY_UNSUPPORTED'
    | 'REGISTRY_UPSTREAM'
    | 'REGISTRY_INVALID_RESPONSE';

export type TagListResult =
    | { ok: true; tags: string[]; nextCursor?: string }
    | { ok: false; code: TagListCode; message: string };

const TAG_LIST_BODY_CAP = 2 * 1024 * 1024; // 2 MiB

function tagListFailure(statusCode: number): TagListResult {
    if (statusCode === 401) {
        return { ok: false, code: 'REGISTRY_UNAUTHORIZED', message: 'Registry rejected credentials' };
    }
    if (statusCode === 403) {
        return { ok: false, code: 'REGISTRY_FORBIDDEN', message: 'Registry denied access to this repository' };
    }
    if (statusCode === 404) {
        return { ok: false, code: 'REGISTRY_NOT_FOUND', message: 'Repository not found on registry' };
    }
    if (statusCode === 429) {
        return { ok: false, code: 'REGISTRY_RATE_LIMITED', message: 'Registry rate limit exceeded' };
    }
    if (statusCode >= 500) {
        return { ok: false, code: 'REGISTRY_UPSTREAM', message: `Registry error (${statusCode})` };
    }
    return { ok: false, code: 'REGISTRY_UPSTREAM', message: `Registry returned status ${statusCode}` };
}

function parseNextCursor(linkHeader: string | string[] | undefined): string | undefined {
    const raw = Array.isArray(linkHeader) ? linkHeader.join(',') : linkHeader;
    if (!raw) return undefined;
    // Rel=next Link: </v2/repo/tags/list?n=50&last=foo>; rel="next"
    const match = raw.match(/<[^>]*[?&]last=([^&>]+)[^>]*>\s*;\s*rel="?next"?/i);
    if (!match) return undefined;
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return match[1];
    }
}

/**
 * Typed tag list for the Resources registry browser and update-preview authority.
 * Never collapses auth failures into an empty array (that would hide credential
 * problems and falsely look like a successful empty listing). `credentials` is
 * optional: `getAuthToken` already resolves an anonymous pull token for public
 * repositories on registries whose `WWW-Authenticate` challenge grants one
 * without credentials (Docker Hub unconditionally; others via the standard
 * token-service challenge), so a public repository still returns a real tag
 * list with none configured.
 */
export async function listRegistryTagsResult(
    registry: string,
    repo: string,
    credentials?: RegistryCredentials | null,
    opts: { limit?: number; cursor?: string } = {},
): Promise<TagListResult> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    try {
        const token = await getAuthToken(registry, repo, credentials);
        if (!token) {
            return {
                ok: false,
                code: 'REGISTRY_UNAUTHORIZED',
                message: credentials ? 'Registry rejected credentials' : 'Registry did not issue an anonymous token for this repository',
            };
        }
        const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${token}` };
        const params = new URLSearchParams({ n: String(limit) });
        if (opts.cursor) params.set('last', opts.cursor);
        const url = `https://${registry}/v2/${repo}/tags/list?${params.toString()}`;
        const res = await httpGet(url, headers);
        if (res.statusCode !== 200) return tagListFailure(res.statusCode);
        if (res.body.length > TAG_LIST_BODY_CAP) {
            return { ok: false, code: 'REGISTRY_INVALID_RESPONSE', message: 'Registry tag list response too large' };
        }
        let parsed: { tags?: unknown };
        try {
            parsed = JSON.parse(res.body) as { tags?: unknown };
        } catch {
            return { ok: false, code: 'REGISTRY_INVALID_RESPONSE', message: 'Registry returned invalid JSON' };
        }
        if (!Array.isArray(parsed.tags) || !parsed.tags.every((t) => typeof t === 'string')) {
            return { ok: false, code: 'REGISTRY_INVALID_RESPONSE', message: 'Registry tag list was malformed' };
        }
        const nextCursor = parseNextCursor(res.headers['link']);
        return nextCursor
            ? { ok: true, tags: parsed.tags as string[], nextCursor }
            : { ok: true, tags: parsed.tags as string[] };
    } catch (e) {
        const cause = e instanceof Error ? ((e as NodeJS.ErrnoException).code ?? e.message) : String(e);
        console.error('[registry-api] Tag list failed:', sanitizeForLog(cause));
        return { ok: false, code: 'REGISTRY_UPSTREAM', message: 'Registry unreachable' };
    }
}

/** Compatibility wrapper for callers that only need tags: empty list on any failure. */
export async function listRegistryTags(
    registry: string,
    repo: string,
    credentials?: RegistryCredentials | null,
): Promise<string[]> {
    const result = await listRegistryTagsResult(registry, repo, credentials);
    return result.ok ? result.tags : [];
}
