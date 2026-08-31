/**
 * Classification of native-git failures into the public GitSourceErrorCode
 * contract.
 *
 * Deliberately class-free: this module returns plain {code, message} data and
 * never imports GitSourceService, so the dependency graph stays one-way
 * (service -> git/*) and the classifier is unit-testable in isolation. The
 * service wraps the returned pair in its own GitSourceError.
 *
 * Two behaviors are contractual and pinned by tests; do not change them:
 *   1. Authentication failure WITH a supplied token reports AUTH_FAILED,
 *      which the HTTP layer maps to 400, never 401, because the frontend's
 *      global logout trips on any API-level 401.
 *   2. A 401/403-shaped refusal WITHOUT a token reports REPO_NOT_FOUND with
 *      a private-repo hint, mirroring GitHub's masking of private repos.
 */

export type TransportFacingCode =
    | 'REPO_NOT_FOUND'
    | 'AUTH_FAILED'
    | 'SSH_HOST_KEY_FAILED'
    | 'REF_NOT_FOUND'
    | 'UNSUPPORTED_REF'
    | 'NETWORK_TIMEOUT'
    | 'GIT_ERROR';

/** Structured failure raised by the native transport; classified below. */
export type TransportFailureReason =
    | 'invalid-url'
    | 'unsafe-target'
    | 'target-unresolved'
    | 'ssh-auth-required'
    | 'invalid-ref'
    | 'git-missing'
    | 'git-old'
    | 'ref-not-found'
    | 'unsupported-ref'
    | 'tip-changed'
    | 'size'
    | 'timeout'
    | 'exit';

interface TransportFailureBase {
    /** Branded discriminant so isTransportFailure cannot false-positive on foreign errors. */
    readonly transportFailure: true;
    host: string;
    hasToken: boolean;
}

/**
 * Discriminated on `reason`: each variant carries exactly the payload its
 * classifier branch needs (e.g. `size` must always know `maxBytes`, so the
 * operator-facing breach message can never render "0 B").
 */
export type TransportFailure = TransportFailureBase & (
    | { reason: 'invalid-url' }
    | { reason: 'unsafe-target' }
    | { reason: 'target-unresolved' }
    | { reason: 'ssh-auth-required' }
    | { reason: 'invalid-ref' }
    | { reason: 'git-missing'; stderr?: string }
    | { reason: 'git-old'; stderr?: string }
    | { reason: 'ref-not-found' }
    | { reason: 'unsupported-ref' }
    | { reason: 'tip-changed' }
    | { reason: 'size'; maxBytes: number }
    | { reason: 'timeout' }
    | { reason: 'exit'; stderr?: string; exitCode?: number; /** Full child argv, attached for debug diagnostics only. */ argv?: string[] }
);

/**
 * Defensive redaction mirroring GitSourceService.scrubCredentials. Kept local
 * instead of imported to preserve the one-way dependency direction; git never
 * receives credentials via URL, so this only guards against operators pasting
 * user:pass@ URLs that servers echo back in error text.
 */
function redactCredentials(text: string): string {
    return text
        .replace(/https?:\/\/[^/\s:@]+:[^/\s@]+@/gi, 'https://***:***@')
        .replace(/(authorization[:=]\s*)[^\s,;]+/gi, '$1***')
        .replace(/(token[:=]\s*)[^\s,;]+/gi, '$1***')
        .replace(/(password[:=]\s*)[^\s,;]+/gi, '$1***');
}

function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
}

function hostQualifier(host: string): string {
    return host && host !== 'unknown' ? ` ${host}` : ' the repository host';
}

/** Shared hint for refusals where a private repo and a missing one are indistinguishable. */
const PRIVATE_REPO_HINT = 'Repository not found, or it is private. Add a Personal Access Token if the repo is private.';

/** Last few stderr lines, scrubbed, for the generic GIT_ERROR fallback. */
function stderrTail(stderr: string | undefined): string {
    if (!stderr) return '';
    const lines = redactCredentials(stderr).trim().split(/\r?\n/).filter(Boolean);
    return lines.slice(-3).join(' ').slice(0, 400);
}

export function classifyGitFailure(
    failure: TransportFailure,
): { code: TransportFacingCode; message: string } {
    const dest = hostQualifier(failure.host);

    // Structured outcomes decided by the transport itself, before any
    // stderr guessing.
    switch (failure.reason) {
        case 'invalid-url':
            return { code: 'GIT_ERROR', message: 'Unsupported repository URL. Use https:// or SSH (git@host:org/repo.git or ssh://) without embedded credentials.' };
        case 'unsafe-target':
            return { code: 'GIT_ERROR', message: 'Repository host is not allowed.' };
        case 'target-unresolved':
            return { code: 'NETWORK_TIMEOUT', message: `Could not resolve${dest}. Check the repository URL and your network or DNS.` };
        case 'ssh-auth-required':
            return { code: 'GIT_ERROR', message: 'SSH repository URLs require a deploy key.' };
        case 'invalid-ref':
            return { code: 'GIT_ERROR', message: 'Unsupported ref name. Use a branch name, a tag name, or a full commit SHA as the remote reports it.' };
        case 'git-missing':
            return { code: 'GIT_ERROR', message: failure.stderr || 'The git command was not found on PATH.' };
        case 'git-old':
            return { code: 'GIT_ERROR', message: failure.stderr || 'The installed git client is too old.' };
        case 'ref-not-found':
            return { code: 'REF_NOT_FOUND', message: 'The configured branch, tag, or commit was not found in the repository.' };
        case 'unsupported-ref':
            return { code: 'UNSUPPORTED_REF', message: 'The configured commit is not reachable on this repository host. Use a branch or tag, or a commit the host advertises.' };
        case 'tip-changed':
            return { code: 'GIT_ERROR', message: 'Repository tip changed during fetch; retry the pull.' };
        case 'size':
            return {
                code: 'GIT_ERROR',
                message: `Repository exceeds the maximum clone size of ${formatBytes(failure.maxBytes)}.`,
            };
        case 'timeout':
            return { code: 'NETWORK_TIMEOUT', message: `Timed out reaching${dest}.` };
        default:
            break;
    }

    const raw = redactCredentials((failure.stderr ?? '').toLowerCase());

    // Auth-shaped refusals. Native git phrases these two ways: with a token
    // it gets "Authentication failed for '<url>'"; without one it cannot even
    // answer and reports the disabled terminal prompt.
    if (/could not read username|could not read password/.test(raw)) {
        // Prompting was suppressed, so the host refused the credentials it
        // was given (possibly none): mask like GitHub hides private repos.
        return {
            code: 'REPO_NOT_FOUND',
            message: PRIVATE_REPO_HINT,
        };
    }
    if (/host key verification failed|remotely changed the ssh host key|no matching host key found|offending key for ip|host key mismatch/.test(raw)) {
        return {
            code: 'SSH_HOST_KEY_FAILED',
            message: 'SSH host key verification failed. The server key changed or is not trusted. Review the fingerprint and update host trust if you intend to accept the new key.',
        };
    }
    if (/permission denied \(publickey|publickey denied|no supported authentication methods/.test(raw)) {
        return failure.hasToken
            ? { code: 'AUTH_FAILED', message: 'Repository authentication failed. Check your deploy key or token.' }
            : {
                code: 'REPO_NOT_FOUND',
                message: PRIVATE_REPO_HINT,
            };
    }
    if (/authentication failed|\b40[13]\b/.test(raw)) {
        return failure.hasToken
            ? { code: 'AUTH_FAILED', message: 'Repository authentication failed. Check your token.' }
            : {
                code: 'REPO_NOT_FOUND',
                message: PRIVATE_REPO_HINT,
            };
    }
    if (/remote branch .+ not found in upstream|branch not found/.test(raw)) {
        return { code: 'REF_NOT_FOUND', message: 'The configured branch, tag, or commit was not found in the repository.' };
    }
    // A host that refuses to serve an unadvertised object (SHA fetch without
    // allowAnySHA1InWant/allowReachableSHA1InWant) still exits non-zero, but
    // the failure is about server capability, not the SHA existing. Hosts word
    // the refusal differently (GitHub vs GitLab/Gitea), so match stable phrases
    // rather than one vendor's full sentence.
    if (/unadvertised object|not our ref/.test(raw)) {
        return { code: 'UNSUPPORTED_REF', message: 'The configured commit is not reachable on this repository host. Use a branch or tag, or a commit the host advertises.' };
    }
    if (/repository[\s\S]*\bnot found\b|not found in upstream/.test(raw)) {
        return {
            code: 'REPO_NOT_FOUND',
            message: failure.hasToken
                ? 'Repository not found. Verify the URL and that your token has read access to this repo.'
                : PRIVATE_REPO_HINT,
        };
    }

    // TLS failures before generic network wording, so certificate problems do
    // not read as connectivity problems.
    if (/ssl certificate problem|server certificate verification failed|certificate subject name|unable to get local issuer certificate|self[- ]signed certificate/.test(raw)) {
        return { code: 'GIT_ERROR', message: `TLS certificate error reaching${dest}. The host certificate could not be verified.` };
    }

    // Network family.
    if (/could not resolve host|name or service not known|temporary failure in name resolution/.test(raw)) {
        return { code: 'NETWORK_TIMEOUT', message: `Could not resolve${dest}. Check the repository URL and your network or DNS.` };
    }
    if (/connection refused|could not connect to server/.test(raw)) {
        return { code: 'NETWORK_TIMEOUT', message: `Connection refused by${dest}.` };
    }
    if (/connection timed out|operation timed out|connection was reset|remote end hung up|connection reset by peer/.test(raw)) {
        return { code: 'NETWORK_TIMEOUT', message: `Connection to${dest} failed. Retry; if it persists, check the host or your network.` };
    }

    const tail = stderrTail(failure.stderr);
    return { code: 'GIT_ERROR', message: tail ? `Git fetch failed: ${tail}` : 'Git fetch failed.' };
}

/**
 * Structural type guard. The branded `transportFailure` discriminant makes
 * false positives impossible: arbitrary errors that happen to carry
 * reason/host fields are not mistaken for transport failures at the service
 * boundary.
 */
export function isTransportFailure(e: unknown): e is TransportFailure {
    return typeof e === 'object' && e !== null && (e as { transportFailure?: unknown }).transportFailure === true;
}
