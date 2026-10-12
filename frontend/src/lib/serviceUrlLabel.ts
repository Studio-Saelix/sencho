/** Same allowlist the backend applies before a service URL can be opened or saved. */
export const SERVICE_URL_LABEL = 'sencho.service.url';

const MAX_SERVICE_URL_LENGTH = 2048;

export function serviceUrlFromLabelValue(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > MAX_SERVICE_URL_LENGTH) return null;
  if (value.includes(' ') || value.includes('\n') || value.includes('\r')) return null;
  if (!/^https?:\/\//i.test(value)) return null;
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
