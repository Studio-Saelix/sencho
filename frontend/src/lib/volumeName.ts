// Helpers for rendering Docker volume names readably in the Resources Hub.
//
// A standard Docker anonymous volume name is exactly 64 lowercase hex characters
// (the same shape as a SHA-256 digest). Named volumes are arbitrary strings.
//
// Note: a user who deliberately names a volume with 64 lowercase hex characters
// is also treated as anonymous for display only. Nothing is lost: the full name
// stays available via the title tooltip (and the copy button in the volume
// browser sheet), and it is always passed verbatim to the API.

const ANON_VOLUME_RE = /^[0-9a-f]{64}$/;

/** True when the name looks like an anonymous Docker volume (64 lowercase hex chars). */
export function isAnonymousVolumeName(name: string): boolean {
  return ANON_VOLUME_RE.test(name);
}

/**
 * A short, readable label for a volume name. Anonymous names are truncated to a
 * 12-character prefix with an ellipsis (e.g. `079dfda49f2c…`); named volumes are
 * returned verbatim so friendly names keep displaying in full.
 */
export function shortVolumeLabel(name: string): string {
  return isAnonymousVolumeName(name) ? `${name.slice(0, 12)}…` : name;
}
