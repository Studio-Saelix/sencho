/**
 * Per-service notes for a pending image update, shared by every surface that
 * presents one (the Updates view card, table detail and phone card, and the
 * stack's Anatomy update banner): the service's changelog link, the skip label
 * that would silence exactly what is pending, and the services a whole-stack
 * update also pulls although their labels skip or do not check them.
 */
import { SENCHO_UPDATE_IGNORE_LABEL } from './senchoLabels';
import { serviceUrlFromLabelValue } from './serviceUrlLabel';
import type { UpdatePreviewImage } from '@/types/imageUpdates';

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
/** Mirrors MAX_UPDATE_IGNORE_ENTRIES in the backend label parser. */
export const MAX_SKIP_LABEL_ENTRIES = 8;

type NoteImage = Pick<UpdatePreviewImage,
  'service' | 'current_tag' | 'next_tag' | 'has_update' | 'digest_update' | 'tag_update'
  | 'detection' | 'candidate_digest' | 'changelog_url' | 'ignore_entries'>;

export interface ServiceUpdateNote {
  service: string;
  /** The service's changelog link, checked again before it becomes an anchor. */
  changelogUrl: string | null;
  /**
   * The skip entries for everything pending on this service: entries already
   * saved in the label, then the newer tag and the rebuild's registry digest.
   * Empty when no candidate is known or the label is full.
   */
  skipEntries: string[];
  /** The saved entries plus the new ones exceed the label's eight-entry limit. */
  skipLimitReached: boolean;
}

function entryKey(entry: string): string {
  return DIGEST_PATTERN.test(entry) ? entry.toLowerCase() : entry;
}

/** One note per service with a pending update, in preview order. */
export function serviceUpdateNotes(images: readonly NoteImage[]): ServiceUpdateNote[] {
  const notes = new Map<string, ServiceUpdateNote>();
  for (const image of images) {
    if (!image.has_update) continue;
    const note = notes.get(image.service)
      ?? { service: image.service, changelogUrl: null, skipEntries: [], skipLimitReached: false };
    if (!note.changelogUrl && image.changelog_url) note.changelogUrl = serviceUrlFromLabelValue(image.changelog_url) ?? null;
    // Once one image of this service overflows the label, a later image must
    // not repopulate a partial line while the full-label note stays visible.
    if (note.skipLimitReached) {
      notes.set(image.service, note);
      continue;
    }
    const entries = [
      ...(image.ignore_entries ?? []),
      ...(image.tag_update && image.next_tag && image.next_tag !== image.current_tag ? [image.next_tag] : []),
      ...(image.digest_update && image.candidate_digest && DIGEST_PATTERN.test(image.candidate_digest) ? [image.candidate_digest] : []),
    ];
    const merged = [...note.skipEntries];
    for (const entry of entries) {
      if (!merged.some(existing => entryKey(existing) === entryKey(entry))) merged.push(entry);
    }
    if (merged.length > MAX_SKIP_LABEL_ENTRIES) {
      // The parser rejects the whole nine-entry value, so the existing skips
      // would stop applying; offer no line and say the label is full instead.
      note.skipEntries = [];
      note.skipLimitReached = true;
    } else {
      note.skipEntries = merged;
    }
    notes.set(image.service, note);
  }
  return [...notes.values()];
}

/** The Compose label line that skips the given entries, as the Copy skip label verb copies it. */
export function skipLabelLine(entries: readonly string[]): string {
  return `${SENCHO_UPDATE_IGNORE_LABEL}: "${entries.join(',')}"`;
}

export interface AlsoPulledService {
  service: string;
  reason: 'off' | 'ignored';
}

/**
 * The services an update or rebuild of this stack also pulls although their
 * labels say not to report them: checks off, or every pending update skipped.
 * Only when there is an update or rebuild to apply; otherwise nothing is
 * pulled. A build-backed service is built instead, so it is never named.
 */
export function alsoPulledServices(preview: {
  images: readonly Pick<UpdatePreviewImage, 'service' | 'detection'>[];
  summary: { has_update: boolean; rebuild_available?: boolean };
  build_services?: readonly string[];
} | null | undefined): AlsoPulledService[] {
  if (!preview) return [];
  // A rebuild-only apply still pulls every registry image in the stack.
  if (!preview.summary.has_update && !preview.summary.rebuild_available) return [];
  const buildServices = new Set(preview.build_services ?? []);
  const out = new Map<string, 'off' | 'ignored'>();
  for (const image of preview.images) {
    if (image.detection !== 'off' && image.detection !== 'ignored') continue;
    // A build-backed service is built first, and the registry pull skips it,
    // so a build-aware update never fetches its image.
    if (buildServices.has(image.service)) continue;
    if (!out.has(image.service)) out.set(image.service, image.detection);
  }
  return [...out].map(([service, reason]) => ({ service, reason }));
}

const ALSO_PULLED_REASON: Record<AlsoPulledService['reason'], string> = {
  off: 'not checked',
  ignored: 'update skipped',
};

/** "Applying also pulls: web (update skipped), db (not checked)", or null when none. */
export function alsoPulledLine(services: readonly AlsoPulledService[]): string | null {
  if (services.length === 0) return null;
  return `Applying also pulls: ${services.map(entry => `${entry.service} (${ALSO_PULLED_REASON[entry.reason]})`).join(', ')}`;
}
