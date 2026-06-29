import path from 'path';

export interface BindPathMapping {
  source: string;
  destination: string;
}

function normalizePath(value: string): string {
  if (value === '/' || /^[A-Za-z]:[\\/]?$/.test(value)) return value;
  return value.replace(/[\\/]+$/, '');
}

function isAtOrBelow(candidate: string, base: string): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedBase = path.resolve(base);

  // After resolution, verify the candidate still starts with the base followed
  // by a separator (or is an exact match). This catches `..` segments that
  // would pass a naive string-prefix check but escape the intended directory.
  if (resolvedCandidate === resolvedBase) return true;
  // Filesystem root: any resolved absolute path is at or below it.
  if (resolvedBase === path.resolve('/')) return path.isAbsolute(resolvedCandidate);
  if (/^[A-Za-z]:[\\/]?$/.test(resolvedBase)) {
    return resolvedCandidate.toLowerCase().startsWith(resolvedBase.slice(0, 2).toLowerCase());
  }
  return resolvedCandidate.startsWith(resolvedBase + path.sep);
}

/** Resolve a container-visible path to the corresponding host bind path. */
export function resolveHostBindPath(
  containerPath: string,
  mounts: ReadonlyArray<BindPathMapping>,
): string | null {
  const target = normalizePath(containerPath);
  const match = mounts
    .filter((mount) => isAtOrBelow(target, normalizePath(mount.destination)))
    .sort((a, b) => normalizePath(b.destination).length - normalizePath(a.destination).length)[0];
  if (!match) return null;

  const destination = normalizePath(match.destination);
  const source = normalizePath(match.source);
  const suffix = target.slice(destination.length).replace(/^[\\/]+/, '');
  if (!suffix) return source;
  const separator = source.endsWith('/') || source.endsWith('\\') ? '' : '/';
  return `${source}${separator}${suffix}`;
}

export function pathsMatch(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}
