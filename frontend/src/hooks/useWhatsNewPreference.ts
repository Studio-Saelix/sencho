import { useCallback, useEffect, useState } from 'react';
import { latestWhatsNewEntryId } from '@/whats-new/entries';

const ENABLED_KEY = 'sencho.whatsNew.enabled';
const LAST_SEEN_KEY = 'sencho.whatsNew.lastSeenId';
const CHANGE_EVENT = 'sencho:whats-new-changed';

function readEnabled(): boolean {
  try {
    const raw = localStorage.getItem(ENABLED_KEY);
    return raw === null ? true : raw === '1';
  } catch {
    return true;
  }
}

function readLastSeenId(): string | null {
  try {
    return localStorage.getItem(LAST_SEEN_KEY);
  } catch {
    return null;
  }
}

function writeSetting(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Quota exhaustion is non-fatal for this preference; in-memory state still
    // reflects the user's choice for this session.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export interface UseWhatsNewPreferenceResult {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
  hasUnseen: boolean;
  markSeen: () => void;
}

export function useWhatsNewPreference(): UseWhatsNewPreferenceResult {
  const [enabled, setEnabledState] = useState(readEnabled);
  // The watermark is stamped unconditionally the first time this hook ever
  // runs, even when entries.json is currently empty (using '' as the seed).
  // This is deliberate: if we only stamped when latestWhatsNewEntryId was
  // non-null, an install that first loads while entries are empty would
  // never get a watermark written, so `stored === null` would still be true
  // once a later release adds its first real entry, indistinguishable from
  // a genuinely fresh install, silently swallowing the very first "unseen"
  // signal. Stamping '' up front means any later real id no longer equals
  // the stored watermark, so hasUnseen correctly flips to true for existing
  // installs while a truly fresh install (no key at all) still catches up
  // silently. Strict Mode may invoke this initializer twice; the write is
  // idempotent.
  const [lastSeenId, setLastSeenIdState] = useState<string | null>(() => {
    const stored = readLastSeenId();
    if (stored !== null) return stored;
    const seed = latestWhatsNewEntryId ?? '';
    writeSetting(LAST_SEEN_KEY, seed);
    return seed;
  });

  useEffect(() => {
    const handler = () => {
      setEnabledState(readEnabled());
      setLastSeenIdState(readLastSeenId());
    };
    window.addEventListener(CHANGE_EVENT, handler);
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener(CHANGE_EVENT, handler);
      window.removeEventListener('storage', handler);
    };
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    writeSetting(ENABLED_KEY, next ? '1' : '0');
    setEnabledState(next);
  }, []);

  const markSeen = useCallback(() => {
    if (latestWhatsNewEntryId === null) return;
    writeSetting(LAST_SEEN_KEY, latestWhatsNewEntryId);
    setLastSeenIdState(latestWhatsNewEntryId);
  }, []);

  const hasUnseen = latestWhatsNewEntryId !== null && lastSeenId !== latestWhatsNewEntryId;

  return { enabled, setEnabled, hasUnseen, markSeen };
}
