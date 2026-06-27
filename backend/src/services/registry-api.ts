import https from 'https';
import http from 'http';
import { sanitizeForLog } from '../utils/safeLog';

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
            registry = firstPart;
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

export async function getAuthToken(
    registry: string,
    repo: string,
    credentials?: RegistryCredentials | null,
): Promise<string | null> {
    try {
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

        const parsed = JSON.parse(tokenRes.body);
        return parsed.token ?? parsed.access_token ?? null;
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

/** docker.io has three hostnames that all address the same registry. */
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

/**
 * Resolve the remote manifest digest for an image, returning either the digest or the
 * reason the lookup failed. Same HEAD-first/GET-fallback transport as before (HEAD
 * returns docker-content-digest without transferring the body, so it does not draw down
 * Docker Hub's anonymous pull-rate budget the way a GET can); only the failure handling
 * is richer. A 401/403/404/429/5xx HEAD reports its specific reason without a GET retry,
 * since the bearer token is fetched up-front, so a 401 here is a real auth failure rather
 * than a token-scope challenge to retry.
 */
export async function getRemoteDigestResult(
    registry: string,
    repo: string,
    tag: string,
    credentials?: RegistryCredentials | null,
): Promise<RemoteDigestResult> {
    const ref = `${registry}/${repo}:${tag}`;
    try {
        const token = await getAuthToken(registry, repo, credentials);
        const headers: Record<string, string> = { Accept: MANIFEST_ACCEPT };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const url = `https://${registry}/v2/${repo}/manifests/${tag}`;

        const head = await httpRequest(url, 'HEAD', headers);
        if (head.statusCode === 200) {
            const digest = head.headers['docker-content-digest'];
            if (typeof digest === 'string') return { ok: true, digest };
            // 200 without the digest header: fall through to GET to read it from there.
        } else if (head.statusCode !== 405 && head.statusCode !== 501) {
            return { ok: false, reason: manifestFailureReason(head.statusCode, ref, head.headers) };
        }

        const res = await httpRequest(url, 'GET', headers);
        if (res.statusCode === 200) {
            const digest = res.headers['docker-content-digest'];
            if (typeof digest === 'string') return { ok: true, digest };
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

export async function listRegistryTags(
    registry: string,
    repo: string,
    credentials?: RegistryCredentials | null,
): Promise<string[]> {
    try {
        const token = await getAuthToken(registry, repo, credentials);
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const res = await httpGet(`https://${registry}/v2/${repo}/tags/list`, headers);
        if (res.statusCode !== 200) return [];

        const parsed = JSON.parse(res.body) as { tags?: string[] };
        return Array.isArray(parsed.tags) ? parsed.tags : [];
    } catch {
        return [];
    }
}
