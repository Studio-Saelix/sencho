import https from 'https';
import type { TransportFailure } from './errors';
import { credentialScopeHost } from './caBundle';
import { sanitizeForLog } from '../../utils/safeLog';

/**
 * Destination-aware redirect policy for HTTPS Git operations.
 *
 * Git is always run with `http.followRedirects=false`, so it never contacts a
 * redirect target on its own. When git refuses a redirect, this module walks
 * the chain itself with an UNAUTHENTICATED request and validates every hop
 * before anything follows it. Only a chain that satisfies the policy end to
 * end produces a URL git is then re-run against.
 *
 * The ordering is the point: a destination outside the configured
 * repository's origin is rejected while it has still never been contacted, so
 * a hostile server cannot use a redirect either to move a credential or to
 * turn a repository fetch into a probe of a host it chose. Parsing git's own
 * output cannot achieve this, because git prints the destination only on the
 * path where it has already followed the redirect (`warning: redirecting to
 * <url>` in git-remote-http) and prints nothing at all when following is
 * disabled.
 *
 * The rule every hop must satisfy is deliberately one rule: the destination
 * stays on the configured repository's origin (scheme, host, and port), and
 * only the path may move. That is what a repository relocating to a canonical
 * path looks like, it is what git's own `update_url_from_redirect` superset
 * check enforces on the path component, and it makes a redirect to an
 * internal address structurally impossible rather than something a separate
 * address-range blocklist has to anticipate. Such a blocklist would also be
 * actively wrong here: a self-hosted Git server on loopback or a private LAN
 * range is a supported deployment, not an attack.
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

/** Parse a Location value (absolute or relative) against its base. Null on failure, so callers fail closed. */
export function resolveLocation(baseUrl: string, location: string): string | null {
    try {
        return new URL(location, baseUrl).toString();
    } catch {
        return null;
    }
}

/**
 * The origin a redirect is allowed to stay on, in the same `host[:port]`
 * spelling the credential helper compares against, so the transport's
 * redirect rule and its credential rule cannot drift apart.
 */
export function redirectScopeOf(url: string): string | null {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') return null;
        return credentialScopeHost(parsed.hostname, parsed.port ? Number(parsed.port) : undefined);
    } catch {
        return null;
    }
}

/**
 * True when git's stderr describes a refused redirect rather than an ordinary
 * failure. Matched against git's current wording, which
 * `git-redirect-preflight.test.ts` pins to the literal strings git emits, so a
 * git upgrade that rephrases them fails a test rather than quietly making
 * relocated repositories unreachable. A miss is safe but not silent: no retry
 * is authorised and git's own error is reported unchanged.
 */
export function looksLikeRedirectFailure(stderr: string): boolean {
    return /returned error: 30\d/i.test(stderr) || /\bredirect/i.test(stderr);
}

/**
 * The single gate every URL passes before it is requested. Returns the URL
 * only when it sits on `expectedScope`, and throws otherwise, so no caller can
 * reach the network with a destination that has not been checked. The seed URL
 * goes through it too: that check is trivially true, but routing every request
 * through one place is what makes the guarantee inspectable rather than a
 * property of the loop's shape, for a reader as much as for static analysis.
 */
export function approvedUrl(
    url: string,
    expectedScope: string,
    reportHost: string,
    hasToken: boolean,
): string {
    if (redirectScopeOf(url) !== expectedScope) {
        throw redirectScope(reportHost, hasToken);
    }
    return url;
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
            // The body is irrelevant; discard it so the socket can close.
            res.resume();
            resolve({ status: res.statusCode ?? 0, location });
        });
        req.on('timeout', () => req.destroy(new Error('redirect preflight timed out')));
        req.on('error', reject);
    });
}

/**
 * Strip the ref-advertise suffix off a probe URL to recover the repository
 * URL git should be pointed at. A destination that no longer ends in the
 * endpoint we asked for is not a relocation of this repository and is
 * refused, mirroring git's own superset rule on the path component.
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
 * redirect at all (so the caller keeps git's original failure).
 *
 * Throws a `redirect-scope` TransportFailure as soon as a hop leaves the
 * configured origin, before that hop is ever requested.
 */
export async function resolveRedirectedRepoUrl(opts: {
    repoUrl: string;
    hasToken: boolean;
    reportHost: string;
    caPem?: string;
}): Promise<string | null> {
    const expectedScope = redirectScopeOf(opts.repoUrl);
    if (!expectedScope) throw redirectScope(opts.reportHost, opts.hasToken);

    const base = opts.repoUrl.replace(/\/$/, '');
    let current = approvedUrl(
        `${base}${REF_ADVERTISE_SUFFIX}?${REF_ADVERTISE_QUERY}`,
        expectedScope, opts.reportHost, opts.hasToken,
    );
    let hops = 0;

    while (hops < MAX_REDIRECT_HOPS) {
        let res: ProbeResponse;
        try {
            res = await probe(current, opts.caPem);
        } catch (e) {
            // The probe could not complete (TLS, DNS, reset). We cannot prove
            // the chain is safe, so we do not authorise a retry; the caller
            // reports git's original error instead. Say why, or a private CA
            // that fails to validate is indistinguishable from a server that
            // simply does not redirect.
            console.warn(`[GitSource:redirect] could not probe ${sanitizeForLog(opts.reportHost)} for a redirect target, keeping the original git error: ${sanitizeForLog(e instanceof Error ? e.message : String(e))}`);
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
        current = approvedUrl(next, expectedScope, opts.reportHost, opts.hasToken);
        hops += 1;
    }
    throw redirectScope(opts.reportHost, opts.hasToken);
}
