import { parseSshUrl, type ParsedSshRepoUrl } from '../git/sshTrust';

// Upper bound so a caller cannot flood the service with a huge payload.
// Generous compared to anything a real Git provider emits.
export const MAX_REPO_URL_LENGTH = 2048;

export type RepoIdentity = { host: string; pathname: string };

export type ParseHttpsRepoUrlResult =
  | { ok: true; url: URL }
  | { ok: false; reason: 'not_https' | 'userinfo' | 'query' | 'fragment' | 'too_long' | 'invalid' };

export function parseHttpsRepoUrl(raw: string): ParseHttpsRepoUrlResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_REPO_URL_LENGTH) {
    return { ok: false, reason: trimmed.length > MAX_REPO_URL_LENGTH ? 'too_long' : 'invalid' };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'not_https' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'userinfo' };
  }
  if (url.search !== '') {
    return { ok: false, reason: 'query' };
  }
  if (url.hash !== '') {
    return { ok: false, reason: 'fragment' };
  }
  return { ok: true, url };
}

export function serializeRepoIdentity(url: URL): RepoIdentity {
  return { host: url.host, pathname: url.pathname };
}

export type ParseLegacyRepoUrlResult =
  | { ok: true; url: URL }
  | { ok: false; reason: 'not_https' | 'too_long' | 'invalid' };

/**
 * Parse an operational repository URL that predates strict ingress.
 *
 * Legacy operational rows retain the original URL (with userinfo, query,
 * and fragment) because fetch still needs them. Migration derives the
 * storable identity by stripping those components instead of refusing the
 * stack. Everything strict ingress refuses for want of a recoverable
 * identity (non-HTTPS, unparseable, oversized) is refused here too.
 */
export function parseLegacyRepoUrl(raw: string): ParseLegacyRepoUrlResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_REPO_URL_LENGTH) {
    return { ok: false, reason: trimmed.length > MAX_REPO_URL_LENGTH ? 'too_long' : 'invalid' };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'not_https' };
  }
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return { ok: true, url };
}

/**
 * Rebuild a storable repository URL from an identity.
 *
 * The secret-free guarantee comes from `parseHttpsRepoUrl` having already
 * rejected userinfo, query strings, and fragments at every ingress. This
 * function only reassembles what that check let through.
 */
export function secretFreeRepoUrl(identity: RepoIdentity): string {
  return `https://${identity.host}${identity.pathname}`;
}

export type ParseStorableRepoUrlResult =
  | { ok: true; kind: 'https'; url: URL }
  | { ok: true; kind: 'ssh'; ssh: ParsedSshRepoUrl }
  | { ok: false; reason: 'too_long' | 'invalid' | 'not_supported' | 'userinfo' | 'query' | 'fragment' };

export function parseStorableRepoUrl(raw: string): ParseStorableRepoUrlResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_REPO_URL_LENGTH) {
    return { ok: false, reason: trimmed.length > MAX_REPO_URL_LENGTH ? 'too_long' : 'invalid' };
  }
  const https = parseHttpsRepoUrl(trimmed);
  if (https.ok) return { ok: true, kind: 'https', url: https.url };
  const ssh = parseSshUrl(trimmed);
  if (ssh) return { ok: true, kind: 'ssh', ssh };
  if (!https.ok && https.reason !== 'not_https') {
    return { ok: false, reason: https.reason };
  }
  return { ok: false, reason: 'not_supported' };
}

export function serializeRepoIdentityFromStorable(parsed: ParseStorableRepoUrlResult & { ok: true }): RepoIdentity {
  if (parsed.kind === 'https') {
    return serializeRepoIdentity(parsed.url);
  }
  const host = parsed.ssh.port === 22 ? parsed.ssh.host : `${parsed.ssh.host}:${parsed.ssh.port}`;
  return { host, pathname: parsed.ssh.pathname };
}

export function secretFreeRepoUrlFromStorable(parsed: ParseStorableRepoUrlResult & { ok: true }): string {
  if (parsed.kind === 'https') {
    return secretFreeRepoUrl(serializeRepoIdentity(parsed.url));
  }
  const ssh = parsed.ssh;
  const portSuffix = ssh.port === 22 ? '' : `:${ssh.port}`;
  return `ssh://git@${ssh.host}${portSuffix}${ssh.pathname}`;
}

/**
 * The canonical key for "is this the same repository?".
 *
 * `RepoIdentity` already unifies the transport: an HTTPS URL, an scp-style
 * SSH URL, and an `ssh://` URL for one repository all serialize to the same
 * host and pathname. What it does not unify is the spelling of that
 * pathname, because each is a legitimate configured form:
 *
 *   - the `.git` suffix, which every Git host accepts and none requires;
 *   - trailing slashes;
 *   - host casing, which an scp-style URL preserves and an `https://` URL
 *     lowercases;
 *   - the port, which an SSH URL carries and an HTTPS URL on the default port
 *     omits.
 *
 * The rules below are exactly what collapses those variants, and each stops
 * short of guessing: a `.git` suffix is stripped once, from the last path
 * segment only, so `/org.git/repo` and `repo.git.git` stay distinct
 * repositories; the port is dropped rather than compared, because a forge
 * serving HTTPS on 443 and SSH on 2222 is one repository reached two ways;
 * the path is never case-folded here, because only the host knows whether case
 * is meaningful (a self-hosted forge that treats paths case-sensitively can
 * hold two repositories differing only in case) and this key stops short of
 * guessing; and `..` is refused rather than resolved, since a caller asking
 * about a traversal has a bug, not a repository.
 *
 * Folding the path in the exclusivity guard would add refusals: on a host
 * where the two spellings are two repositories, the second claim would be
 * rejected. The one deliberate exception is the provider webhook delivery
 * check, which folds path case locally: an endpoint binds exactly one source
 * and the check reads a signed delivery rather than looking a repository up
 * (see `providerWebhooks/normalize.ts`).
 *
 * `null` means the URL names no repository the guard can reason about. A
 * caller that is deciding exclusivity must read that as a refusal, never as
 * "no match".
 */
export function canonicalRepoKey(identity: RepoIdentity): string | null {
  const host = identity.host.trim().toLowerCase();
  if (host === '' || host.includes('/')) return null;
  // The port is deliberately not part of the key. `RepoIdentity` folds an SSH
  // port into `host`, and a self-hosted forge commonly serves HTTPS on 443
  // and SSH on 2222, so keeping it would hand the HTTPS and SSH spellings of
  // one repository two different keys, which is the bypass this key exists to
  // close. Dropping it merges a pair that was genuinely different (two
  // repositories on two ports of one host), which costs a refusal rather than
  // a duplicate claim.
  //
  // The host of a bracketed IPv6 literal ends at the closing bracket; any other
  // host carries at most one colon, the port separator, so cutting at the first
  // one drops the port.
  const bracket = host.indexOf(']');
  const hostname = bracket >= 0 ? host.slice(0, bracket + 1) : host.split(':')[0];
  if (hostname === '' || hostname === '[]') return null;
  const segments = identity.pathname.split('/');
  if (segments.some((segment) => segment === '..')) return null;
  while (segments.length > 1 && segments[segments.length - 1] === '') segments.pop();
  const last = segments[segments.length - 1];
  if (last !== undefined && last.endsWith('.git') && last !== '.git') {
    segments[segments.length - 1] = last.slice(0, -'.git'.length);
  }
  const pathname = segments.join('/');
  if (pathname === '' || pathname === '/') return null;
  return `${hostname}${pathname}`;
}

/** `canonicalRepoKey` for a configured URL, or null when it names no repository. */
export function canonicalRepoKeyFromUrl(raw: string): string | null {
  const parsed = parseStorableRepoUrl(raw);
  if (!parsed.ok) return null;
  return canonicalRepoKey(serializeRepoIdentityFromStorable(parsed));
}

export function repoUrlRejectionMessage(raw: string): string | null {
  const parsed = parseStorableRepoUrl(raw);
  if (parsed.ok) {
    // What gets persisted is the secret-free derived form, not the URL that was
    // submitted, and a Blueprint-mode row is compared on that stored form later.
    // So the stored form has to name the same repository the submission did, or
    // ingress accepts a source the claim guard then refuses for a URL the
    // operator never sees. The two disagree in both directions: an scp-style
    // URL carries `?` and `#` verbatim, so it keys fine as given while the
    // `ssh://` form actually stored cannot be parsed at all, and a host holding
    // a slash (`git@foo/bar:org/repo`) reparses as host `foo` with the rest of
    // the host absorbed into the path.
    const stored = parseStorableRepoUrl(secretFreeRepoUrlFromStorable(parsed));
    const submittedKey = canonicalRepoKey(serializeRepoIdentityFromStorable(parsed));
    const storedKey = stored.ok
      ? canonicalRepoKey(serializeRepoIdentityFromStorable(stored))
      : null;
    return submittedKey === null || storedKey === null || submittedKey !== storedKey
      ? 'Repository URL must identify one repository'
      : null;
  }
  switch (parsed.reason) {
    case 'too_long':
      return 'repo_url is too long';
    case 'not_supported':
      return 'Use an https:// URL or an SSH URL (git@host:org/repo.git or ssh://)';
    case 'userinfo':
      return 'Repository URL must not include userinfo';
    case 'query':
      return 'Repository URL must not include a query string';
    case 'fragment':
      return 'Repository URL must not include a fragment';
    default:
      return 'Repository URL is invalid';
  }
}
