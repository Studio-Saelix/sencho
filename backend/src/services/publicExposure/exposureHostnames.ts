/**
 * Hostname rules for public exposure. A public hostname is a lowercase FQDN:
 * each DNS label is 1 to 63 characters of `[a-z0-9-]` with no leading or
 * trailing hyphen, the whole name is at most 253 characters, it has at least
 * two labels, and it is never a wildcard. Later slices validate hostname
 * labels with the same rules.
 */

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_HOSTNAME_LENGTH = 253;
export const MAX_ALLOWED_SUFFIXES = 20;

/** Lowercases and trims; drops one trailing root dot. Does not validate. */
export function normalizeHostname(value: string): string {
  const lowered = value.trim().toLowerCase();
  return lowered.endsWith('.') ? lowered.slice(0, -1) : lowered;
}

/** Why a hostname is not a valid public FQDN, or null when it is. */
export function hostnameProblem(hostname: string): string | null {
  if (hostname.includes('*')) return 'A wildcard is not allowed.';
  if (hostname.length === 0) return 'The name is empty.';
  if (hostname.length > MAX_HOSTNAME_LENGTH) return `The name is longer than ${MAX_HOSTNAME_LENGTH} characters.`;
  const labels = hostname.split('.');
  if (labels.length < 2) return 'The name needs at least two labels, like example.com.';
  for (const label of labels) {
    if (!LABEL.test(label)) {
      return `"${label}" is not a valid DNS label: use 1 to 63 letters, digits or hyphens, not starting or ending with a hyphen.`;
    }
  }
  return null;
}

/** True when `hostname` equals `zone` or sits under it. Both must already be normalized. */
export function isAtOrUnderZone(hostname: string, zone: string): boolean {
  return hostname === zone || hostname.endsWith(`.${zone}`);
}

export type SuffixValidation =
  | { ok: true; suffixes: string[] }
  | { ok: false; message: string };

/**
 * Normalize, deduplicate and validate the hostname suffixes that narrow an
 * enabled zone. Each suffix must be a valid FQDN equal to or under the zone.
 */
export function validateAllowedSuffixes(input: readonly string[], zoneName: string): SuffixValidation {
  const zone = normalizeHostname(zoneName);
  const suffixes: string[] = [];
  for (const raw of input) {
    const suffix = normalizeHostname(raw);
    const problem = hostnameProblem(suffix);
    if (problem) return { ok: false, message: `Suffix "${raw.trim()}": ${problem}` };
    if (!isAtOrUnderZone(suffix, zone)) {
      return { ok: false, message: `Suffix "${suffix}" is not in the zone ${zone}.` };
    }
    if (!suffixes.includes(suffix)) suffixes.push(suffix);
  }
  if (suffixes.length > MAX_ALLOWED_SUFFIXES) {
    return { ok: false, message: `A zone takes at most ${MAX_ALLOWED_SUFFIXES} suffixes.` };
  }
  return { ok: true, suffixes };
}
