import { parseSenchoUrl, SENCHO_URL_LABEL } from './senchoLabels';

/**
 * The application link label, the first allowlisted Compose label whose value
 * may leave the rendered model (the named links share its validation). Every
 * other label stays key-only, because label values can carry secrets.
 */
export const SERVICE_URL_LABEL = SENCHO_URL_LABEL;

/** A literal http(s) URL with no userinfo, or null when the value is not one. */
export function serviceUrlFromLabelValue(raw: string): string | null {
  const parsed = parseSenchoUrl(raw);
  return parsed.ok ? parsed.value : null;
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
