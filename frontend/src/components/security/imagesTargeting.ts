import type { PostureReasonKind, PostureTarget } from '@/types/security';

/** Parent-owned Images drill-down from a posture reason/action. */
export interface ImagesTargetingState {
  kind: PostureReasonKind;
  label: string;
  /** Unique image refs used for list filtering. */
  imageRefs: string[];
  /** Full target rows (may repeat imageRef across stack/service). */
  targets: PostureTarget[];
  /** Monotonic token so re-navigating the same reason re-applies after Clear. */
  token: number;
}

/** Payload passed into navigate before SecurityView assigns a token. */
export type ImagesTargetingInput = Omit<ImagesTargetingState, 'token'>;

function uniqueImageRefs(targets: PostureTarget[]): string[] {
  return [...new Set(targets.map((t) => t.imageRef))];
}

/** Build Images targeting from a posture reason/action target list. */
export function targetingFromTargets(
  kind: PostureReasonKind,
  label: string,
  targets: PostureTarget[] | undefined,
): ImagesTargetingInput | undefined {
  if (!targets || targets.length === 0) return undefined;
  return {
    kind,
    label,
    imageRefs: uniqueImageRefs(targets),
    targets,
  };
}

function intentDisplayLabel(intent: NonNullable<PostureTarget['exposureIntent']>): string {
  switch (intent) {
    case 'lan': return 'LAN';
    case 'reverse-proxy': return 'reverse proxy';
    case 'same-node': return 'same-node';
    case 'internal': return 'internal';
    case 'public': return 'public';
    case 'temporary': return 'temporary';
    case 'unknown': return 'unknown';
  }
}

/** Rank for multi-context pick: conflict, then unset, then set (non-conflict), then unavailable. */
function evidenceRank(t: PostureTarget): number {
  if (t.intentConflict) return 0;
  if (t.intentStatus === 'unset') return 1;
  if (t.intentStatus === 'set') return 2;
  return 3;
}

function formatIntentEvidence(t: PostureTarget): string | null {
  if (t.intentStatus === 'unavailable') return null;
  if (t.intentConflict) {
    const label = t.exposureIntent ? intentDisplayLabel(t.exposureIntent) : 'internal';
    return `Intent mismatch: ${label}`;
  }
  if (t.intentStatus === 'unset') return 'Intent: not classified';
  if (t.intentStatus === 'set' && t.exposureIntent) {
    return `Intent: ${intentDisplayLabel(t.exposureIntent)}`;
  }
  return null;
}

/**
 * Compact per-row exposure intent line while targeting.
 * Prefers conflict, then unset, then set; appends +N when more contexts exist.
 * Returns null when there is nothing to show (legacy imageRef-only targets, or unavailable-only).
 */
export function primaryExposureIntentEvidence(
  targets: PostureTarget[] | undefined,
  imageRef: string,
): string | null {
  if (!targets || targets.length === 0) return null;
  const forImage = targets.filter((t) => t.imageRef === imageRef);
  if (forImage.length === 0) return null;

  const primaryLine = [...forImage]
    .sort((a, b) => evidenceRank(a) - evidenceRank(b))
    .map(formatIntentEvidence)
    .find((line): line is string => line !== null);
  if (!primaryLine) return null;

  const extras = forImage.length - 1;
  return extras > 0 ? `${primaryLine} (+${extras})` : primaryLine;
}
