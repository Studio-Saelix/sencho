import { useCallback, useEffect, useState } from 'react';
import { useBuildInfo } from '@/hooks/useBuildInfo';
import { isNewerStableVersion, stableReleaseVersion } from '@/lib/releaseHighlights';

const ENABLED_KEY = 'sencho.whatsNew.enabled';
const LAST_SEEN_KEY = 'sencho.whatsNew.lastSeenVersion';
// Watermark of the retired hand-written feed; removed when the new one is stamped.
const LEGACY_LAST_SEEN_KEY = 'sencho.whatsNew.lastSeenId';
const CHANGE_EVENT = 'sencho:whats-new-changed';

function readEnabled(): boolean {
  try {
    const raw = localStorage.getItem(ENABLED_KEY);
    return raw === null ? true : raw === '1';
  } catch {
    return true;
  }
}

function readLastSeenVersion(): string | null {
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
  /** The stable release this instance runs, or null for dev/preview builds, prerelease versions, and while build info loads. */
  version: string | null;
  hasUnseen: boolean;
  markSeen: () => void;
}

export function useWhatsNewPreference(): UseWhatsNewPreferenceResult {
  const { buildInfo } = useBuildInfo();
  const version = stableReleaseVersion(buildInfo);
  const [enabled, setEnabledState] = useState(readEnabled);
  const [lastSeenVersion, setLastSeenVersionState] = useState<string | null>(readLastSeenVersion);

  useEffect(() => {
    const handler = () => {
      setEnabledState(readEnabled());
      setLastSeenVersionState(readLastSeenVersion());
    };
    window.addEventListener(CHANGE_EVENT, handler);
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener(CHANGE_EVENT, handler);
      window.removeEventListener('storage', handler);
    };
  }, []);

  // A browser that has never recorded a version is a fresh install, or an
  // existing one meeting this watermark for the first time. Stamp it silently
  // with the running version so only a later upgrade lights the dot.
  useEffect(() => {
    if (version !== null && readLastSeenVersion() === null) {
      writeSetting(LAST_SEEN_KEY, version);
      try {
        localStorage.removeItem(LEGACY_LAST_SEEN_KEY);
      } catch {
        // Nothing to clean up when storage is unavailable.
      }
    }
  }, [version]);

  const setEnabled = useCallback((next: boolean) => {
    writeSetting(ENABLED_KEY, next ? '1' : '0');
    setEnabledState(next);
  }, []);

  // The watermark only moves forward, so running an older release (a rollback)
  // does not lower it and make the next upgrade look unseen twice.
  const markSeen = useCallback(() => {
    if (version === null) return;
    const stored = readLastSeenVersion();
    if (stored !== null && !isNewerStableVersion(version, stored)) return;
    writeSetting(LAST_SEEN_KEY, version);
    setLastSeenVersionState(version);
  }, [version]);

  // Only an upgrade lights the dot; running an older release than the one last seen does not.
  const hasUnseen = version !== null && lastSeenVersion !== null && isNewerStableVersion(version, lastSeenVersion);

  return { enabled, setEnabled, version, hasUnseen, markSeen };
}
