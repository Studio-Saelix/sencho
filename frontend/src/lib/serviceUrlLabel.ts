/** Same allowlist the backend applies before a service URL can be opened or saved. */
export const SERVICE_URL_LABEL = 'io.sencho.url';

const MAX_SERVICE_URL_LENGTH = 2048;
// eslint-disable-next-line no-control-regex
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f-\u009f]/;

export function serviceUrlFromLabelValue(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > MAX_SERVICE_URL_LENGTH) return null;
  if (CONTROL_OR_SPACE.test(value)) return null;
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
