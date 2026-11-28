/**
 * How a staged overwrite of a host directory is recorded on its intent. A leaf
 * module: the intent and fence stores read it, and neither may load the stack
 * roots or Docker to do so.
 */

/** The paths an overwrite of a host directory records, so reconciliation can prove the root again. */
export interface FsTargetPaths {
  senchoPath: string;
  hostPath: string;
  aliases: string[];
}

/** POSIX-normalized absolute path without a trailing slash, or null for anything else. */
function normalizeAbsolute(value: string): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0')) return null;
  const parts: string[] = [];
  for (const part of value.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

export function parseFsTargetPaths(raw: string | null): FsTargetPaths | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    const senchoPath = typeof record.senchoPath === 'string' ? normalizeAbsolute(record.senchoPath) : null;
    const hostPath = typeof record.hostPath === 'string' ? normalizeAbsolute(record.hostPath) : null;
    if (!senchoPath || !hostPath) return null;
    const aliases = Array.isArray(record.aliases)
      ? record.aliases.filter((alias): alias is string => typeof alias === 'string' && normalizeAbsolute(alias) !== null)
      : [];
    return { senchoPath, hostPath, aliases };
  } catch {
    // A row this build cannot read describes no directory; the overwrite that
    // owns it then cannot prove its target and settles unknown.
    return null;
  }
}

/**
 * The value an overwrite of a host directory stores in `target_volume`. A colon
 * cannot appear in a Docker volume name, so it never collides with one, and the
 * live-target unique index and `liveIntentForVolume` keep working unchanged.
 */
export function fsTargetKey(storageKey: string): string {
  return `fs:${storageKey}`;
}

export function isFsTargetKey(targetVolume: string | null): boolean {
  return typeof targetVolume === 'string' && targetVolume.startsWith('fs:');
}
