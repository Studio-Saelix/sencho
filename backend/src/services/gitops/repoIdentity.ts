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

export function repoUrlRejectionMessage(raw: string): string | null {
  const parsed = parseHttpsRepoUrl(raw);
  if (parsed.ok) return null;
  switch (parsed.reason) {
    case 'too_long':
      return 'repo_url is too long';
    case 'not_https':
      return 'Only HTTPS repository URLs are supported';
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
