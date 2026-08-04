// frontend/src/whats-new/types.ts
export interface WhatsNewEntry {
  id: string;
  title: string;
  blurb: string;
  docUrl?: string;
  screenshot?: string;
}

export const WHATS_NEW_CAP = 20;

export function isWhatsNewEntry(value: unknown): value is WhatsNewEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' && v.id.length > 0 &&
    typeof v.title === 'string' && v.title.length > 0 &&
    typeof v.blurb === 'string' && v.blurb.length > 0 &&
    (v.docUrl === undefined || typeof v.docUrl === 'string') &&
    (v.screenshot === undefined || typeof v.screenshot === 'string')
  );
}
