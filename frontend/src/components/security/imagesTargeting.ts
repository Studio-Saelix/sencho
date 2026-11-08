import type { ExposureIntent } from '@/types/networking';
import type { IntentEntry } from '@/hooks/useExposureIntent';
import type {
  ImageExposureContext,
  ImageExposureContextSummary,
  PostureDriverFinding,
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
  /**
   * Exact contributing findings when the reason carries drivers.
   * Scoped per image when opening the scan sheet.
   */
  drivers?: PostureDriverFinding[];
  /** Full contributing driver count before cap; omit when drivers omitted. */
  driverCount?: number;
  /** True when driverCount exceeds the attached drivers array length. */
  driversTruncated?: boolean;
  /** Monotonic token so re-navigating the same reason re-applies after Clear. */
  token: number;
}

/** Payload passed into navigate before SecurityView assigns a token. */
export type ImagesTargetingInput = Omit<ImagesTargetingState, 'token'>;

/**
 * What the targeting still says about exposure once an intent has been saved.
 * Everything on a target beyond its image is a snapshot taken on arrival, so it
 * is shed and the rows read the reloaded summaries instead. The images and
 * drivers stay, so the rest of a batch is still listed; an exposure reason also
 * loses its "conflicts" label, which is no longer true of the list as a whole.
 */
export function afterIntentSaved(state: ImagesTargetingState | null): ImagesTargetingState | null {
  if (state === null) return null;
  return {
    ...state,
    label: state.kind === 'public_exposure' ? 'Network exposed images' : state.label,
    targets: state.targets.map((target) => ({ imageRef: target.imageRef })),
  };
}

/** Intent fields shared by posture targets and standing exposure contexts. */
export type ExposureIntentSource =
  | ImageExposureContext
  | Pick<PostureTarget, 'exposureIntent' | 'intentStatus' | 'intentConflict' | 'imageRef'>;

/** Intents that mean the operator deliberately classified exposure. */
const INTENTIONAL = new Set(['public', 'lan', 'reverse-proxy', 'temporary']);

/** Intents a publicly exposed service contradicts. */
const CONFLICT = new Set(['internal', 'same-node']);

/** A confirmed save hands the owner the stack's intents so the affected rows can
 *  keep showing them until a reread replaces the summaries. */
export type IntentSavedHandler = (stackName: string, intents: IntentEntry[]) => void;

/** The intent a service ends up with after a save: its own row, else the stack row, else unset. */
function effectiveIntentFromSave(service: string, intents: readonly IntentEntry[]): ExposureIntent | null {
  const own = intents.find((entry) => entry.service === service);
  if (own !== undefined) return own.intent;
  return intents.find((entry) => entry.service === '')?.intent ?? null;
}

/** One context as the save response settles it, following the server's rules:
 *  an absent or `unknown` intent is unset, and `internal`/`same-node` conflict. */
function contextWithSavedIntent(context: ImageExposureContext, intent: ExposureIntent | null): ImageExposureContext {
  const base: Omit<ImageExposureContext, 'intentStatus' | 'exposureIntent' | 'intentConflict'> = {
    stackName: context.stackName,
    serviceName: context.serviceName,
    exposureReason: context.exposureReason,
    ...(context.tunnel ? { tunnel: context.tunnel } : {}),
  };
  if (intent === null || intent === 'unknown') {
    return { ...base, intentStatus: 'unset' };
  }
  return {
    ...base,
    exposureIntent: intent,
    intentStatus: 'set',
    ...(CONFLICT.has(intent) ? { intentConflict: true } : {}),
  };
}

/** Whether two renderings of one context state the same intent evidence. */
function sameIntentEvidence(before: ImageExposureContext, after: ImageExposureContext): boolean {
  return before.intentStatus === after.intentStatus
    && before.exposureIntent === after.exposureIntent
    && (before.intentConflict === true) === (after.intentConflict === true);
}

/** Server rank for exposure contexts: conflict, unset, unavailable, then set. */
function contextRank(context: ImageExposureContext): number {
  if (context.intentConflict) return 0;
  if (context.intentStatus === 'unset') return 1;
  if (context.intentStatus === 'unavailable') return 2;
  return 3;
}

/** Pre-cap aggregates over the contexts (the rule the server's summary uses). */
function summarizeContexts(contexts: readonly ImageExposureContext[]): ImageExposureContextSummary {
  const sawComplete = contexts.some((context) => context.intentStatus !== 'unavailable');
  return {
    hasConflict: contexts.some((context) => context.intentConflict === true),
    hasUnclassified: contexts.some((context) => context.intentStatus === 'unset'),
    hasUnavailable: contexts.some((context) => context.intentStatus === 'unavailable'),
    allKnownIntentional: sawComplete
      && contexts.every((context) => context.intentStatus === 'unavailable' || isIntentionalSet(context)),
  };
}

/**
 * Aggregate for the patched list. A capped list still hides contexts the old
 * summary describes; only a state the visible list proves gone is dropped, so a
 * conflict or unset that may remain in the hidden remainder stays reported.
 */
function summaryAfterSavedIntents(
  summary: ScanSummary,
  before: readonly ImageExposureContext[],
  after: readonly ImageExposureContext[],
): ImageExposureContextSummary {
  const recomputed = summarizeContexts(after);
  const old = summary.exposure_context_summary;
  const count = summary.exposure_context_count ?? before.length;
  const truncated = summary.exposure_contexts_truncated === true || count > after.length;
  if (!truncated || old === undefined) return recomputed;
  const maxVisibleRank = before.reduce((rank, context) => Math.max(rank, contextRank(context)), -1);
  return {
    hasConflict: recomputed.hasConflict || (maxVisibleRank === 0 && old.hasConflict),
    hasUnclassified: recomputed.hasUnclassified || (maxVisibleRank <= 1 && old.hasUnclassified),
    hasUnavailable: old.hasUnavailable,
    allKnownIntentional: old.allKnownIntentional && recomputed.allKnownIntentional,
  };
}

/**
 * Adopt a confirmed save's intents into the standing summaries, so the intent
 * evidence and the row's action reflect the save even when the reread of those
 * summaries fails. Contexts of the saved stack take the new effective intent
 * (service row, else stack row); every other stack and every image untouched by
 * the stack keeps its summary. Returns the input when nothing changed.
 */
export function applySavedIntents(
  summaries: Record<string, ScanSummary>,
  stackName: string,
  intents: readonly IntentEntry[],
): Record<string, ScanSummary> {
  let changed = false;
  const next: Record<string, ScanSummary> = { ...summaries };

  for (const [imageRef, summary] of Object.entries(summaries)) {
    const contexts = summary.exposure_contexts;
    if (summary.publicly_exposed !== true || !contexts || contexts.length === 0) continue;
    let touched = false;
    const patched = contexts.map((context) => {
      if (context.stackName !== stackName) return context;
      const after = contextWithSavedIntent(context, effectiveIntentFromSave(context.serviceName, intents));
      if (sameIntentEvidence(context, after)) return context;
      touched = true;
      return after;
    });
    if (!touched) continue;
    changed = true;
    next[imageRef] = {
      ...summary,
      exposure_contexts: patched,
      ...(summary.exposure_context_summary
        ? { exposure_context_summary: summaryAfterSavedIntents(summary, contexts, patched) }
        : {}),
    };
  }

  return changed ? next : summaries;
}

function uniqueImageRefs(targets: PostureTarget[]): string[] {
  return [...new Set(targets.map((t) => t.imageRef))];
}

/** Driver CVE/GHSA ids for one image (omit when none match so the sheet stays unfiltered). */
export function driverIdsForImage(
  drivers: PostureDriverFinding[] | undefined,
  imageRef: string,
): string[] | undefined {
  if (!drivers || drivers.length === 0) return undefined;
  const ids = [...new Set(
    drivers.filter((d) => d.imageRef === imageRef).map((d) => d.vulnerabilityId),
  )];
  return ids.length > 0 ? ids : undefined;
}

/** Build Images targeting from a posture reason/action target list. */
export function targetingFromTargets(
  kind: PostureReasonKind,
  label: string,
  targets: PostureTarget[] | undefined,
  drivers?: PostureDriverFinding[],
  driverMeta?: { driverCount?: number; driversTruncated?: boolean },
): ImagesTargetingInput | undefined {
  if (!targets || targets.length === 0) return undefined;
  return {
    kind,
    label,
    imageRefs: uniqueImageRefs(targets),
    targets,
    ...(drivers && drivers.length > 0 ? { drivers } : {}),
    ...(driverMeta?.driverCount !== undefined ? { driverCount: driverMeta.driverCount } : {}),
    ...(driverMeta?.driversTruncated !== undefined
      ? { driversTruncated: driverMeta.driversTruncated }
      : {}),
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
      ...(t.tunnel ? { tunnel: t.tunnel } : {}),
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
