/** Same allowlist the backend applies before a service URL can be opened or saved. */
export const SERVICE_URL_LABEL = 'io.sencho.url';

const MAX_SERVICE_URL_LENGTH = 2048;
// Spaces, C0/C1 controls, and invisible or direction-changing format characters,
// the same set as the backend validator (backend/src/helpers/senchoLabels.ts).
// eslint-disable-next-line no-control-regex
const UNSAFE_URL_CHARACTER = /[\u0000-\u0020\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/;
// An empty userinfo such as `https://:@host` is normalized away by URL, so the raw value is checked too.
const USERINFO = /^https?:\/\/[^/?#]*@/i;

export function serviceUrlFromLabelValue(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > MAX_SERVICE_URL_LENGTH) return null;
  if (UNSAFE_URL_CHARACTER.test(value)) return null;
  if (!/^https?:\/\//i.test(value)) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '' || USERINFO.test(value)) return null;
  if (!parsed.hostname) return null;
  return value;
}
