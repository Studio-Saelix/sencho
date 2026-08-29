/** scp-style `user@host:org/repo.git` (any SSH username, not only `git`). */
const SCP_URL_PATTERN = /^([^@\s/]+)@([^:\s]+):(.+)$/;

function isValidScpStyleSshUrl(trimmed: string): boolean {
  const match = SCP_URL_PATTERN.exec(trimmed);
  if (!match) return false;
  const user = match[1];
  const hostPart = match[2];
  const repoPath = match[3].trim();
  if (!user || !hostPart || !repoPath || repoPath.includes('..')) return false;
  const colon = hostPart.lastIndexOf(':');
  if (colon > 0 && colon < hostPart.length - 1) {
    const portText = hostPart.slice(colon + 1);
    const parsedPort = Number.parseInt(portText, 10);
    if (!Number.isFinite(parsedPort) || parsedPort < 1 || parsedPort > 65535) return false;
  }
  return true;
}

function isValidSshProtocolUrl(trimmed: string): boolean {
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return false;
  }
  if (url.protocol !== 'ssh:') return false;
  if (!url.hostname || url.username === '' || url.password !== '') return false;
  if (url.search !== '' || url.hash !== '') return false;
  const port = url.port ? Number.parseInt(url.port, 10) : 22;
  if (!Number.isFinite(port) || port < 1 || port > 65535) return false;
  const pathname = url.pathname;
  if (pathname === '/' || pathname.includes('..')) return false;
  return true;
}

/** Matches backend Git transport URL acceptance for HTTPS and SSH. */
export function isSupportedGitRepoUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (/^https:\/\//i.test(trimmed)) return true;
  if (/^ssh:\/\//i.test(trimmed)) return isValidSshProtocolUrl(trimmed);
  return isValidScpStyleSshUrl(trimmed);
}

export const UNSUPPORTED_GIT_REPO_URL_MESSAGE =
  'Use an https:// URL or an SSH URL (user@host:org/repo.git or ssh://).';
