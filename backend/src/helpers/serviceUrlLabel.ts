/**
 * The one allowlisted Compose label whose value may leave the rendered model.
 * Every other label stays key-only, because label values can carry secrets.
 */
export const SERVICE_URL_LABEL = 'sencho.service.url';

const MAX_SERVICE_URL_LENGTH = 2048;

/** A literal http(s) URL with no userinfo, or null when the value is not one. */
export function serviceUrlFromLabelValue(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > MAX_SERVICE_URL_LENGTH) return null;
  if (value.includes(' ') || value.includes('\n') || value.includes('\r')) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (!parsed.hostname) return null;
  return value;
}

/** The validated URL from a rendered label map or `key=value` list, else null. */
export function serviceUrlFromLabels(labels: unknown): string | null {
  if (Array.isArray(labels)) {
    for (const entry of labels) {
      if (typeof entry !== 'string') continue;
      const eq = entry.indexOf('=');
      if (eq <= 0) continue;
      if (entry.slice(0, eq) !== SERVICE_URL_LABEL) continue;
      return serviceUrlFromLabelValue(entry.slice(eq + 1));
    }
    return null;
  }
  if (labels && typeof labels === 'object') {
    const raw = (labels as Record<string, unknown>)[SERVICE_URL_LABEL];
    if (typeof raw !== 'string') return null;
    return serviceUrlFromLabelValue(raw);
  }
  return null;
}
