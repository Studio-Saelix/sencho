/**
 * Client-side mirror of the backend path policy. It exists to give immediate,
 * field-specific feedback; the server remains authoritative for every verdict.
 */

export const MAX_PATH_LENGTH = 200;
export const PATH_CHARACTER_SET = 'A-Z a-z 0-9 . _ - /';

const RESERVED_PREFIXES = [
  '/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/proc', '/root', '/run',
  '/sbin', '/sys', '/usr', '/var/run', '/var/lib/docker', '/var/lib/containerd', '/app',
  '/tmp', '/var/tmp', '/snap', '/nix',
];
const EXACT_ROOTS = ['/home', '/opt', '/srv', '/mnt', '/media'];
const ALLOWED = /^[A-Za-z0-9._/-]+$/;

export type BootstrapPathKind = 'compose' | 'agent';

export function pathLabel(kind: BootstrapPathKind): string {
  return kind === 'compose' ? 'Compose stacks directory' : 'Pilot Agent installation directory';
}

export function validateBootstrapPath(value: string, kind: BootstrapPathKind): string | null {
  const label = pathLabel(kind);
  if (!value.startsWith('/')) return `${label} must be an absolute path starting with /.`;
  if (value.length > MAX_PATH_LENGTH) return `${label} must be at most ${MAX_PATH_LENGTH} characters.`;
  if (!ALLOWED.test(value)) return `${label} may contain only ${PATH_CHARACTER_SET}.`;
  if (value.endsWith('/')) return `${label} must not end with a slash.`;
  if (value.includes('//')) return `${label} must not contain an empty path segment.`;
  if (value === '/') return `${label} must not be the filesystem root.`;
  const segments = value.split('/').slice(1);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return `${label} must not contain . or .. path segments.`;
  }
  if (segments.length < 2) return `${label} must name a directory at least two segments deep.`;
  if (EXACT_ROOTS.includes(value)) return `${label} must be more specific than ${value}.`;
  for (const prefix of RESERVED_PREFIXES) {
    if (value === prefix || value.startsWith(`${prefix}/`)) {
      return `${label} must not be under ${prefix}. Choose a path under /opt, /srv or /home.`;
    }
  }
  return null;
}

export function pathSeparationError(composeDir: string, agentDir: string): { field: 'composeDir' | 'agentDir'; message: string } | null {
  if (composeDir === agentDir) {
    return { field: 'agentDir', message: 'The two directories must be different paths.' };
  }
  if (agentDir.startsWith(`${composeDir}/`)) {
    return { field: 'agentDir', message: 'The Agent directory must not be inside the Compose directory.' };
  }
  if (composeDir.startsWith(`${agentDir}/`)) {
    return { field: 'composeDir', message: 'The Compose directory must not be inside the Agent directory.' };
  }
  return null;
}
