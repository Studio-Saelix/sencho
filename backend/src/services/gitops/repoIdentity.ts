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
 *     lowercases.
 *
 * The three rules below are exactly what collapses those variants, and each
 * stops short of guessing: a `.git` suffix is stripped once, from the last
 * path segment only, so `/org.git/repo` and `repo.git.git` stay distinct
 * repositories; the path is never case-folded because Git hosts treat it
 * case-sensitively; and `..` is refused rather than resolved, since a caller
 * asking about a traversal has a bug, not a repository.
 *
 * `null` means the URL names no repository the guard can reason about. A
 * caller that is deciding exclusivity must read that as a refusal, never as
 * "no match".
 */
export function canonicalRepoKey(identity: RepoIdentity): string | null {
  const host = identity.host.trim().toLowerCase();
  if (host === '' || host.includes('/')) return null;
  const segments = identity.pathname.split('/');
  if (segments.some((segment) => segment === '..')) return null;
  while (segments.length > 1 && segments[segments.length - 1] === '') segments.pop();
  const last = segments[segments.length - 1];
  if (last !== undefined && last.endsWith('.git') && last !== '.git') {
    segments[segments.length - 1] = last.slice(0, -'.git'.length);
  }
  const pathname = segments.join('/');
  if (pathname === '' || pathname === '/') return null;
  return `${host}${pathname}`;
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
    // A URL that parses but names no repository (a bare host, a host with an
    // empty path) cannot be compared against any other repository, so it could
    // never be claimed by a Blueprint-mode application. Refusing it here is
    // what keeps an unclaimable URL out of the store, rather than discovering
    // it later at conversion time with nothing the operator can act on.
    return canonicalRepoKeyFromUrl(raw) === null
      ? 'Repository URL must include a repository path'
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
