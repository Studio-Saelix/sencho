import https from 'https';
import type { TransportFailure } from './errors';
import { credentialScopeHost } from './caBundle';

/**
 * Destination-aware redirect policy for HTTPS Git operations.
 *
 * Git is always run with `http.followRedirects=false`, so it never contacts a
 * redirect target on its own. When git refuses a redirect, this module walks
 * the chain itself with an UNAUTHENTICATED request and validates every hop
 * before anything follows it. Only a chain that satisfies the policy end to
 * end produces a URL git is then re-run against.
 *
 * The ordering is the point: a cross-host, downgraded, or internal-range
 * destination is rejected while it has still never been contacted, and no
 * credential can reach it even if the operator's server is hostile. Parsing
 * git's own output cannot achieve this, because git prints the destination
 * only on the path where it has already followed the redirect
 * (`warning: redirecting to <url>` in git-remote-http), and prints nothing at
 * all when following is disabled.
 */

/** Hop ceiling for one chain, bounding both loops and probe cost. */
export const MAX_REDIRECT_HOPS = 5;

/** The smart-HTTP endpoint whose redirect defines where the repository moved. */
const REF_ADVERTISE_SUFFIX = '/info/refs';
const REF_ADVERTISE_QUERY = 'service=git-upload-pack';
const PROBE_TIMEOUT_MS = 10_000;

function redirectScope(host: string, hasToken: boolean): TransportFailure {
    return { transportFailure: true as const, reason: 'redirect-scope', host, hasToken };
}

/**
 * Well-known ranges a redirect must never reach. A public suffix list is
 * impractical to ship, so this blocks the destinations that actually matter:
 * loopback and the RFC 1918 / link-local ranges that let a redirect turn a
 * repository fetch into a probe of internal services (cloud metadata
 * endpoints included) that the operator's own browser could not reach.
 */
export function isForbiddenRedirectHost(host: string): boolean {
    const lower = host.toLowerCase().replace(/^\[|\]$/g, '');
    if (lower === 'localhost' || lower === 'localhost.localdomain') return true;
    if (lower.startsWith('127.') || lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;
    if (lower === '0.0.0.0') return true;
    if (lower.startsWith('10.')) return true;
    if (lower.startsWith('172.')) {
        const second = Number(lower.split('.')[1]);
        if (Number.isFinite(second) && second >= 16 && second <= 31) return true;
    }
    if (lower.startsWith('192.168.')) return true;
    if (lower.startsWith('169.254.')) return true;
    if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
    return false;
}

/** Parse a Location value (absolute or relative) against its base. Null on failure, so callers fail closed. */
export function resolveLocation(baseUrl: string, location: string): string | null {
    try {
        return new URL(location, baseUrl).toString();
    } catch {
        return null;
    }
}

/**
 * Validate one hop's destination, throwing a classified failure when it
 * violates the policy: no protocol downgrade, no forbidden range, and, once a
 * credential scope is in play, no host outside that scope.
 */
export function validateRedirectHop(
    fromUrl: string,
    toUrl: string,
    allowedHost: string | null,
    hasToken: boolean,
    reportHost: string,
): void {
    let from: URL;
    let to: URL;
    try {
        from = new URL(fromUrl);
        to = new URL(toUrl);
    } catch {
        throw redirectScope(reportHost, hasToken);
    }
    if (to.protocol !== 'https:') throw redirectScope(reportHost, hasToken);
    if (isForbiddenRedirectHost(to.hostname)) throw redirectScope(reportHost, hasToken);
    if (allowedHost) {
        const toScope = credentialScopeHost(to.hostname, to.port ? Number(to.port) : undefined);
        if (toScope !== allowedHost) throw redirectScope(reportHost, hasToken);
    } else if (to.host.toLowerCase() !== from.host.toLowerCase()) {
        // Without a credential scope the rule is still same-host: an
        // unauthenticated source that silently relocates to another origin is
        // exactly the case the operator asked us to surface rather than follow.
        throw redirectScope(reportHost, hasToken);
    }
}

/** True when git's stderr describes a refused redirect rather than an ordinary failure. */
export function looksLikeRedirectFailure(stderr: string): boolean {
    return /returned error: 30\d/i.test(stderr) || /\bredirect/i.test(stderr);
}

interface ProbeResponse {
    status: number;
    location: string | null;
}

/** One unauthenticated GET, following nothing. Rejects only on transport errors. */
function probe(url: string, ca: string | undefined): Promise<ProbeResponse> {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { ca, timeout: PROBE_TIMEOUT_MS }, (res) => {
            const location = typeof res.headers.location === 'string' ? res.headers.location : null;
            // The body is irrelevant; discard it so the socket can be reused or closed.
            res.resume();
            resolve({ status: res.statusCode ?? 0, location });
        });
        req.on('timeout', () => req.destroy(new Error('redirect preflight timed out')));
        req.on('error', reject);
    });
}

/**
 * Strip the ref-advertise suffix off a probe URL to recover the repository
 * URL git should be pointed at. Mirrors git's own `update_url_from_redirect`
 * superset rule: a redirect may only rewrite the prefix, so a destination
 * that no longer ends in the endpoint we asked for is not a relocation of
 * this repository and is refused.
 */
function repoUrlFromProbeUrl(probeUrl: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(probeUrl);
    } catch {
        return null;
    }
    if (!parsed.pathname.endsWith(REF_ADVERTISE_SUFFIX)) return null;
    parsed.pathname = parsed.pathname.slice(0, -REF_ADVERTISE_SUFFIX.length);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
}

/**
 * Walk the redirect chain for `repoUrl` without credentials and return the
 * repository URL it ultimately resolves to, or null when the source does not
 * redirect at all (so the caller keeps its original failure).
 *
 * Throws a `redirect-scope` TransportFailure as soon as a hop violates the
 * policy, before that hop is ever requested.
 */
export async function resolveRedirectedRepoUrl(opts: {
    repoUrl: string;
    allowedHost: string | null;
    hasToken: boolean;
    reportHost: string;
    caPem?: string;
}): Promise<string | null> {
    const base = opts.repoUrl.replace(/\/$/, '');
    let current = `${base}${REF_ADVERTISE_SUFFIX}?${REF_ADVERTISE_QUERY}`;
    let hops = 0;

    while (hops < MAX_REDIRECT_HOPS) {
        let res: ProbeResponse;
        try {
            res = await probe(current, opts.caPem);
        } catch {
            // The probe could not complete (TLS, DNS, reset). We cannot prove
            // the chain is safe, so we do not authorise a retry; the caller
            // reports git's original error instead.
            return null;
        }
        if (res.status < 300 || res.status >= 400 || !res.location) {
            if (hops === 0) return null;
            const resolved = repoUrlFromProbeUrl(current);
            if (!resolved) throw redirectScope(opts.reportHost, opts.hasToken);
            return resolved;
        }
        const next = resolveLocation(current, res.location);
        if (!next) throw redirectScope(opts.reportHost, opts.hasToken);
        validateRedirectHop(current, next, opts.allowedHost, opts.hasToken, opts.reportHost);
        current = next;
        hops += 1;
    }
    throw redirectScope(opts.reportHost, opts.hasToken);
}
