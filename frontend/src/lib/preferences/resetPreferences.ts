/**
 * Complete-domain reset (the "reset all" actions). Optimistic-local defaults
 * are applied immediately under the hydration guard (so no queued server write
 * is spawned by the apply itself), then the tombstone DELETE is queued through
 * the bus: pre-reset queued PUTs are cancelled, post-reset edits are staged
 * behind the DELETE conditionally on the tombstone's revision.
 */
import { type PreferenceDomain } from './preferenceEvents';
import { queueReset, setHydratingDomains } from './syncBus';
import {
  defaultAppearanceDocument,
  hydrateAppearanceDocument,
  hydrateNavigationDefaults,
  writePreferenceCacheFromDocuments,
} from './preferencesDocuments';

export function resetPreferenceDomain(domain: PreferenceDomain): void {
  setHydratingDomains(new Set([domain]));
  try {
    if (domain === 'appearance') {
      hydrateAppearanceDocument(defaultAppearanceDocument());
    } else {
      hydrateNavigationDefaults();
    }
  } finally {
    setHydratingDomains(new Set());
  }
  // Re-assert the cache to the new (default) local state so a reload paints
  // the reset values even if the DELETE has not settled yet.
  writePreferenceCacheFromDocuments();
  queueReset(domain);
  // The tombstone stands once the DELETE settles: a pending edit based on an
  // older revision is discarded by reconciliation (remote-reset precedence),
  // and only edits the user makes after adopting the tombstone are staged
  // behind the reset as their own PUTs. No trailing notify here: one would
  // un-tombstone by immediately PUTting the defaults, weakening the reset
  // for clients that were offline when it happened.
}
