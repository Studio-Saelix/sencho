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

type NoteImage = Pick<UpdatePreviewImage,
  'service' | 'current_tag' | 'next_tag' | 'has_update' | 'digest_update' | 'tag_update'
  | 'detection' | 'candidate_digest' | 'changelog_url'>;

export interface ServiceUpdateNote {
  service: string;
  /** The service's changelog link, checked again before it becomes an anchor. */
  changelogUrl: string | null;
  /**
   * The skip entries for everything pending on this service: the newer tag and
   * the rebuild's registry digest, each only when known. Empty when no
   * candidate is known, so no skip line can be offered.
   */
  skipEntries: string[];
}

/** One note per service with a pending update, in preview order. */
export function serviceUpdateNotes(images: readonly NoteImage[]): ServiceUpdateNote[] {
  const notes = new Map<string, ServiceUpdateNote>();
  for (const image of images) {
    if (!image.has_update) continue;
    const note = notes.get(image.service) ?? { service: image.service, changelogUrl: null, skipEntries: [] };
    if (!note.changelogUrl && image.changelog_url) note.changelogUrl = serviceUrlFromLabelValue(image.changelog_url) ?? null;
    const entries = [
      ...(image.tag_update && image.next_tag && image.next_tag !== image.current_tag ? [image.next_tag] : []),
      ...(image.digest_update && image.candidate_digest && DIGEST_PATTERN.test(image.candidate_digest) ? [image.candidate_digest] : []),
    ];
    for (const entry of entries) if (!note.skipEntries.includes(entry)) note.skipEntries.push(entry);
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
 * The services an update of this stack also pulls although their labels say
 * not to report them: checks off, or every pending update skipped. Only when
 * there is an update to apply; otherwise nothing is pulled.
 */
export function alsoPulledServices(preview: {
  images: readonly Pick<UpdatePreviewImage, 'service' | 'detection'>[];
  summary: { has_update: boolean };
} | null | undefined): AlsoPulledService[] {
  if (!preview?.summary.has_update) return [];
  const out = new Map<string, 'off' | 'ignored'>();
  for (const image of preview.images) {
    if (image.detection !== 'off' && image.detection !== 'ignored') continue;
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
