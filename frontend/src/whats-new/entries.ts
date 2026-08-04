// frontend/src/whats-new/entries.ts
import rawEntries from './entries.json';
import { isWhatsNewEntry, type WhatsNewEntry } from './types';

function loadEntries(): WhatsNewEntry[] {
  return (rawEntries as unknown[]).filter((entry): entry is WhatsNewEntry => {
    const valid = isWhatsNewEntry(entry);
    if (!valid) console.error('[WhatsNew] dropping malformed entry:', entry);
    return valid;
  });
}

/** Oldest-first, matching authoring (append) order. */
export const whatsNewEntries: WhatsNewEntry[] = loadEntries();

export const latestWhatsNewEntryId: string | null =
  whatsNewEntries.length > 0 ? whatsNewEntries[whatsNewEntries.length - 1].id : null;
