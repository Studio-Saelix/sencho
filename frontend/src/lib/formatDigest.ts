/**
 * Shorten a Docker content digest or image ID for display.
 * Accepts `sha256:…` or bare hex; returns up to 12 hex characters.
 */
export function formatShortDigest(id: string | null | undefined): string {
  if (!id) return '';
  const colon = id.indexOf(':');
  const hex = colon >= 0 ? id.slice(colon + 1) : id;
  return hex.slice(0, 12);
}
