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

function writeEnabled(enabled: boolean) {
  try {
    localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0');
  } catch {
    // Quota exhaustion is non-fatal for this preference.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function writeLastSeenId(id: string) {
  try {
    localStorage.setItem(LAST_SEEN_KEY, id);
  } catch {
    // Quota exhaustion is non-fatal for this preference.
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
  // A fresh install has no watermark at all (distinct from an empty string):
  // stamp it to the current newest entry immediately, synchronously, so the
  // very first render never reports an unseen entry for pre-install history.
  // Strict Mode may invoke this initializer twice; the write is idempotent.
  const [lastSeenId, setLastSeenIdState] = useState<string | null>(() => {
    const stored = readLastSeenId();
    if (stored === null && latestWhatsNewEntryId !== null) {
      writeLastSeenId(latestWhatsNewEntryId);
      return latestWhatsNewEntryId;
    }
    return stored;
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
    writeEnabled(next);
    setEnabledState(next);
  }, []);

  const markSeen = useCallback(() => {
    if (latestWhatsNewEntryId === null) return;
    writeLastSeenId(latestWhatsNewEntryId);
    setLastSeenIdState(latestWhatsNewEntryId);
  }, []);

  const hasUnseen = latestWhatsNewEntryId !== null && lastSeenId !== latestWhatsNewEntryId;

  return { enabled, setEnabled, hasUnseen, markSeen };
}
