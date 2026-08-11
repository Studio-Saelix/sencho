import type {
  ImageExposureContext,
  ImageExposureContextSummary,
  PostureReasonKind,
  PostureTarget,
  ScanSummary,
} from '@/types/security';

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

/** Intent fields shared by posture targets and standing exposure contexts. */
export type ExposureIntentSource =
  | ImageExposureContext
  | Pick<PostureTarget, 'exposureIntent' | 'intentStatus' | 'intentConflict' | 'imageRef'>;

/** Intents that mean the operator deliberately classified exposure. */
const INTENTIONAL = new Set(['public', 'lan', 'reverse-proxy', 'temporary']);

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
function evidenceRank(t: ExposureIntentSource): number {
  if (t.intentConflict) return 0;
  if (t.intentStatus === 'unset') return 1;
  if (t.intentStatus === 'set') return 2;
  return 3;
}

function isIntentionalSet(c: ExposureIntentSource): boolean {
  return (
    c.intentStatus === 'set'
    && !c.intentConflict
    && !!c.exposureIntent
    && INTENTIONAL.has(c.exposureIntent)
  );
}

function formatIntentEvidence(t: ExposureIntentSource): string | null {
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
 * Prefer aggregate summary flags for the primary conclusion when present,
 * then fall back to the best ranked context line.
 */
function primaryLineFromContexts(
  contexts: ExposureIntentSource[],
  summary?: ImageExposureContextSummary,
): string | null {
  if (contexts.length === 0) return null;

  if (summary?.hasConflict) {
    const conflict = contexts.find((c) => c.intentConflict);
    const label = conflict?.exposureIntent
      ? intentDisplayLabel(conflict.exposureIntent)
      : 'internal';
    return `Intent mismatch: ${label}`;
  }
  if (summary?.hasUnclassified) {
    return 'Intent: not classified';
  }

  return [...contexts]
    .sort((a, b) => evidenceRank(a) - evidenceRank(b))
    .map(formatIntentEvidence)
    .find((line): line is string => line !== null) ?? null;
}

function withExtras(primaryLine: string, totalContexts: number): string {
  const extras = totalContexts - 1;
  return extras > 0 ? `${primaryLine} (+${extras})` : primaryLine;
}

/**
 * Compact per-row exposure intent line while targeting.
 * Accepts posture targets or standing ImageExposureContext rows.
 * Prefers conflict, then unset, then set; appends +N when more contexts exist.
 * Returns null when there is nothing to show (legacy imageRef-only targets, or unavailable-only).
 */
export function primaryExposureIntentEvidence(
  sources: ExposureIntentSource[] | undefined,
  imageRef?: string,
): string | null {
  if (!sources || sources.length === 0) return null;

  let list = sources;
  if (imageRef !== undefined) {
    const withRef = sources.filter((t): t is PostureTarget & ExposureIntentSource => 'imageRef' in t);
    list = withRef.length > 0
      ? withRef.filter((t) => t.imageRef === imageRef)
      : sources;
  }
  if (list.length === 0) return null;

  const primaryLine = primaryLineFromContexts(list);
  if (!primaryLine) return null;
  return withExtras(primaryLine, list.length);
}

/**
 * Standing Images evidence from a scan summary (no targeting required).
 * Mixed-version: publicly_exposed without contexts yields null (badge only).
 */
export function standingIntentEvidence(summary: ScanSummary): string | null {
  if (summary.publicly_exposed !== true) return null;
  const contexts = summary.exposure_contexts;
  if (!contexts || contexts.length === 0) return null;

  const primaryLine = primaryLineFromContexts(contexts, summary.exposure_context_summary);
  if (!primaryLine) return null;

  const total = summary.exposure_context_count ?? contexts.length;
  // When truncated, +N includes hidden contexts (count - displayed) plus other
  // displayed rows beyond the primary: total - 1.
  return withExtras(primaryLine, total);
}

export type IntentionalBannerKind = 'absolute' | 'partial' | 'none';

export interface IntentionalBannerResult {
  kind: IntentionalBannerKind;
  unavailableCount: number;
}

function intentionalKindFromContexts(
  contexts: ExposureIntentSource[] | undefined,
  opts: {
    truncated?: boolean;
    summary?: ImageExposureContextSummary;
  } = {},
): IntentionalBannerResult {
  const { truncated = false, summary } = opts;
  if (truncated || !contexts || contexts.length === 0) {
    return { kind: 'none', unavailableCount: 0 };
  }

  // Prefer pre-cap aggregates when present (standing summaries).
  if (summary) {
    if (summary.hasConflict || summary.hasUnclassified) {
      return { kind: 'none', unavailableCount: 0 };
    }
    if (summary.hasUnavailable) {
      const unavailableCount = contexts.filter((c) => c.intentStatus === 'unavailable').length;
      if (summary.allKnownIntentional && unavailableCount > 0) {
        return { kind: 'partial', unavailableCount };
      }
      return { kind: 'none', unavailableCount: 0 };
    }
    if (summary.allKnownIntentional && contexts.every(isIntentionalSet)) {
      return { kind: 'absolute', unavailableCount: 0 };
    }
    return { kind: 'none', unavailableCount: 0 };
  }

  let unavailableCount = 0;
  let sawAvailable = false;
  for (const c of contexts) {
    if (c.intentStatus === 'unavailable') {
      unavailableCount += 1;
      continue;
    }
    sawAvailable = true;
    if (!isIntentionalSet(c)) {
      return { kind: 'none', unavailableCount };
    }
  }

  if (unavailableCount > 0 && sawAvailable) {
    return { kind: 'partial', unavailableCount };
  }
  if (unavailableCount === 0 && contexts.every(isIntentionalSet)) {
    return { kind: 'absolute', unavailableCount: 0 };
  }
  return { kind: 'none', unavailableCount };
}

/**
 * Absolute / partial intentional classification for targeting targets or a standing summary.
 * When truncated is true (overview attach capped or standing contexts truncated), never claim absolute/partial.
 */
export function intentionalBannerKind(
  input: PostureTarget[] | ScanSummary | undefined,
  opts?: { truncated?: boolean },
): IntentionalBannerResult {
  if (!input) return { kind: 'none', unavailableCount: 0 };

  if (Array.isArray(input)) {
    return intentionalKindFromContexts(input, { truncated: opts?.truncated === true });
  }

  if (input.publicly_exposed !== true) {
    return { kind: 'none', unavailableCount: 0 };
  }
  return intentionalKindFromContexts(input.exposure_contexts, {
    truncated: opts?.truncated === true || input.exposure_contexts_truncated === true,
    summary: input.exposure_context_summary,
  });
}

/** Collect exposure contexts for networking navigation from a standing summary. */
export function standingExposureContexts(summary: ScanSummary): ImageExposureContext[] {
  if (summary.publicly_exposed !== true) return [];
  return summary.exposure_contexts ?? [];
}

/** Collect unique stack/service contexts from posture targets (banner networking nav). */
export function allTargetingExposureContexts(
  targets: PostureTarget[],
): ImageExposureContext[] {
  const seen = new Set<string>();
  const out: ImageExposureContext[] = [];
  for (const t of targets) {
    if (!t.stackName || !t.serviceName) continue;
    const key = `${t.stackName}\0${t.serviceName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      stackName: t.stackName,
      serviceName: t.serviceName,
      exposureReason: t.exposureReason ?? null,
      exposureIntent: t.exposureIntent,
      intentStatus: t.intentStatus ?? 'unavailable',
      intentConflict: t.intentConflict,
    });
  }
  return out;
}

/** Collect stack/service contexts from posture targets for an image (networking nav). */
export function targetingExposureContexts(
  targets: PostureTarget[] | undefined,
  imageRef: string,
): ImageExposureContext[] {
  if (!targets) return [];
  return allTargetingExposureContexts(
    targets.filter((t) => t.imageRef === imageRef),
  );
}
