/**
 * Live validation for public exposure hostname suffixes, matching the
 * server's rules: a lowercase FQDN of 1 to 63 character labels of letters,
 * digits and hyphens (no leading or trailing hyphen), at most 253
 * characters, at least two labels, no wildcard, and equal to or under the
 * zone. The server validates again on save.
 */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function suffixProblem(raw: string, zoneName: string): string | null {
  const suffix = raw.trim().toLowerCase().replace(/\.$/, '');
  const zone = zoneName.toLowerCase();
  if (suffix.includes('*')) return 'A wildcard is not allowed.';
  if (suffix.length > 253) return 'The name is longer than 253 characters.';
  const labels = suffix.split('.');
  if (labels.length < 2) return 'The name needs at least two labels.';
  const bad = labels.find((label) => !LABEL.test(label));
  if (bad !== undefined) return `"${bad}" is not a valid DNS label.`;
  if (suffix !== zone && !suffix.endsWith(`.${zone}`)) return `Not in the zone ${zone}.`;
  return null;
}
