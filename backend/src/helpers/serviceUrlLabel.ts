import { parseLabelEntries, parseSenchoUrl, parseSenchoUrlLabel, SENCHO_URL_LABEL } from './senchoLabels';

/**
 * The application link label. Its value, like the named links' (`senchoLabels.ts`
 * extracts those too), may leave the rendered model once validated. Every other
 * label stays key-only, because label values can carry secrets.
 */
export const SERVICE_URL_LABEL = SENCHO_URL_LABEL;

/** A literal http(s) URL with no userinfo, or null when the value is not one. */
export function serviceUrlFromLabelValue(raw: string): string | null {
  const parsed = parseSenchoUrl(raw);
  return parsed.ok ? parsed.value : null;
}

/** The validated URL from a rendered label map or `key=value` list, else null. Reads labels the way the resolver does. */
export function serviceUrlFromLabels(labels: unknown): string | null {
  const raw = parseLabelEntries(labels).get(SERVICE_URL_LABEL);
  if (raw === undefined) return null;
  const parsed = parseSenchoUrlLabel(raw);
  return parsed.ok ? parsed.value : null;
}
