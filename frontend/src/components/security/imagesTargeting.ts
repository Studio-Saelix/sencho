import type { ExposureIntent } from '@/types/networking';
import type { IntentEntry } from '@/hooks/useExposureIntent';
import { isRoutingUnverified } from '@/lib/tunnelExposure';
import type {
  ImageExposureContext,
  ImageExposureContextHidden,
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

/** A context carrying the image it belongs to when a targeting snapshot knows it. */
export type ImageExposureContextRef = ImageExposureContext & { imageRef: string };

/** The image and context a confirmed save came from. A save can name a service
 *  that the response cap hides from the summary, and only this context says
 *  whether that service is exposed through a tunnel. */
export interface SavedIntentTarget {
  imageRef: string;
  context: ImageExposureContext;
}

/** A confirmed save hands the owner the stack's intents so the affected rows can
 *  keep showing them until a reread replaces the summaries. A context the server
 *  settles away on that save stops counting as exposed instead. */
export type IntentSavedHandler = (
  stackName: string,
  intents: IntentEntry[],
  saved?: SavedIntentTarget,
) => void;

/** The intent a service ends up with after a save: its own row, else the stack row, else unset. */
function effectiveIntentFromSave(service: string, intents: readonly IntentEntry[]): ExposureIntent | null {
  const own = intents.find((entry) => entry.service === service);
  if (own !== undefined) return own.intent;
  return intents.find((entry) => entry.service === '')?.intent ?? null;
}

/** Whether the save's effective intent removes this context from exposed-service
 *  accounting, as the server's tunnel settlement does: an unverified tunnel
 *  reach taken at the operator's word for `internal` or `same-node`. */
function settledAwayByIntent(context: ImageExposureContext, intent: ExposureIntent | null): boolean {
  return intent !== null && CONFLICT.has(intent)
    && context.exposureReason === 'tunnel'
    && context.tunnel !== undefined
    && isRoutingUnverified(context.tunnel);
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
 * Which warnings the contexts beyond the display cap may hold, captured once
 * from the server's slice. The server sorts before it slices, so every hidden
 * context ranks at or after the last visible one: a state ranked earlier than
 * that cannot be hidden, while one ranked at or after it may be. Later saves
 * change the visible ranks, so the answer cannot be re-derived from them.
 */
function hiddenRemainderEvidence(
  summary: ScanSummary,
  before: readonly ImageExposureContext[],
): ImageExposureContextHidden | undefined {
  const old = summary.exposure_context_summary;
  const count = summary.exposure_context_count ?? before.length;
  if (old === undefined || (summary.exposure_contexts_truncated !== true && count <= before.length)) {
    return undefined;
  }
  const lastVisibleRank = before.reduce((rank, context) => Math.max(rank, contextRank(context)), -1);
  return {
    conflict: old.hasConflict && lastVisibleRank === 0,
    unclassified: old.hasUnclassified && lastVisibleRank <= 1,
    unavailable: old.hasUnavailable && lastVisibleRank <= 2,
  };
}

/**
 * Aggregate for the patched list. A state is dropped only when the recomputed
 * visible list no longer holds it and the captured remainder says it cannot be
 * hidden, so a conflict or unset that may remain beyond the cap stays reported.
 */
function summaryAfterSavedIntents(
  summary: ScanSummary,
  after: readonly ImageExposureContext[],
  hidden: ImageExposureContextHidden | undefined,
): ImageExposureContextSummary {
  const recomputed = summarizeContexts(after);
  const old = summary.exposure_context_summary;
  if (!hidden || old === undefined) return recomputed;
  return {
    hasConflict: recomputed.hasConflict || hidden.conflict,
    hasUnclassified: recomputed.hasUnclassified || hidden.unclassified,
    hasUnavailable: recomputed.hasUnavailable || hidden.unavailable,
    allKnownIntentional: old.allKnownIntentional && recomputed.allKnownIntentional
      && !hidden.conflict && !hidden.unclassified,
  };
}

/** The contexts after one save: the saved stack's rows take the effective intent,
 *  an unverified tunnel reach settled by a conflicting intent drops out, and
 *  every other row stays. Reports whether anything changed. */
function patchContextsAfterSave(
  contexts: readonly ImageExposureContext[],
  stackName: string,
  intents: readonly IntentEntry[],
): { patched: ImageExposureContext[]; changed: boolean } {
  let changed = false;
  const patched: ImageExposureContext[] = [];
  for (const context of contexts) {
    if (context.stackName !== stackName) {
      patched.push(context);
      continue;
    }
    const intent = effectiveIntentFromSave(context.serviceName, intents);
    if (settledAwayByIntent(context, intent)) {
      changed = true;
      continue;
    }
    const after = contextWithSavedIntent(context, intent);
    if (sameIntentEvidence(context, after)) {
      patched.push(context);
      continue;
    }
    changed = true;
    patched.push(after);
  }
  return { patched, changed };
}

/** What a save of a service outside the display slice proves about the hidden
 *  remainder: that service's own state after the save, and whether it stopped
 *  counting as exposed. The visible patch cannot see that row, but the save's
 *  own context and effective intent can settle it, classify it, resolve its
 *  state, or show that it is still unclassified. */
interface HiddenSaveState {
  conflict: boolean;
  unclassified: boolean;
  /** The conflicting intent the save proved, for the row's label. */
  conflictIntent?: ExposureIntent;
  /** 1 when the saved context no longer counts as exposed, else 0. */
  removed: number;
}

function hiddenSaveState(
  summary: ScanSummary,
  stackName: string,
  intents: readonly IntentEntry[],
  saved: SavedIntentTarget,
): HiddenSaveState | undefined {
  const { context } = saved;
  if (context.stackName !== stackName) return undefined;
  const visible = summary.exposure_contexts?.some(
    (row) => row.stackName === stackName && row.serviceName === context.serviceName,
  );
  if (visible) return undefined;
  const intent = effectiveIntentFromSave(context.serviceName, intents);
  if (settledAwayByIntent(context, intent)) {
    return { conflict: false, unclassified: false, removed: 1 };
  }
  if (intent === null || intent === 'unknown') {
    return { conflict: false, unclassified: true, removed: 0 };
  }
  if (CONFLICT.has(intent)) {
    return { conflict: true, unclassified: false, conflictIntent: intent, removed: 0 };
  }
  return { conflict: false, unclassified: false, removed: 0 };
}

/** The hidden remainder after a save named one of its contexts. With a known
 *  total of one hidden context, the save settles that whole remainder; with
 *  more, states it does not prove may still sit in another hidden context. */
function hiddenAfterSave(
  hidden: ImageExposureContextHidden,
  state: HiddenSaveState,
  single: boolean,
): ImageExposureContextHidden {
  if (single) {
    return {
      conflict: state.conflict,
      unclassified: state.unclassified,
      unavailable: false,
      ...(state.conflictIntent ? { conflictIntent: state.conflictIntent } : {}),
    };
  }
  const conflictIntent = state.conflictIntent ?? hidden.conflictIntent;
  return {
    conflict: hidden.conflict || state.conflict,
    unclassified: hidden.unclassified || state.unclassified,
    unavailable: hidden.unavailable,
    ...(conflictIntent ? { conflictIntent } : {}),
  };
}

/** One image's summary after the save, or null when the save changes nothing in it. */
function summaryAfterSave(
  summary: ScanSummary,
  imageRef: string,
  stackName: string,
  intents: readonly IntentEntry[],
  saved?: SavedIntentTarget,
): ScanSummary | null {
  const contexts = summary.exposure_contexts;
  if (summary.publicly_exposed !== true || contexts === undefined) return null;
  const declaredCount = summary.exposure_context_count;
  const truncated = summary.exposure_contexts_truncated === true
    || (declaredCount ?? contexts.length) > contexts.length;
  // A projected summary may have settled every displayed context, leaving its
  // captured hidden remainder as the only evidence there is.
  const hidden = summary.exposure_context_summary
    ? summary.exposure_context_hidden
      ?? (contexts.length > 0 ? hiddenRemainderEvidence(summary, contexts) : undefined)
    : undefined;
  const { patched, changed } = patchContextsAfterSave(contexts, stackName, intents);
  // A total at or below the attached length cannot describe a hidden remainder;
  // there the truncation flag is the only signal, so the remainder is unknown.
  const hiddenCount = declaredCount !== undefined && declaredCount > contexts.length
    ? declaredCount - contexts.length
    : undefined;
  const hiddenSave = saved?.imageRef === imageRef && truncated
    ? hiddenSaveState(summary, stackName, intents, saved)
    : undefined;
  if (!changed && hiddenSave === undefined) return null;

  const removed = contexts.length - patched.length + (hiddenSave?.removed ?? 0);
  const remainingHidden = hiddenCount !== undefined
    ? Math.max(0, hiddenCount - (hiddenSave?.removed ?? 0))
    : undefined;
  if (patched.length === 0 && (remainingHidden === 0 || !truncated)) {
    // Every exposed service of this image settled away: the server would no
    // longer report the image as exposed at all.
    return {
      ...summary,
      publicly_exposed: false,
      exposure_contexts: [],
      exposure_context_count: 0,
      exposure_contexts_truncated: false,
      exposure_context_hidden: undefined,
      ...(summary.exposure_context_summary
        ? {
          exposure_context_summary: {
            hasConflict: false,
            hasUnclassified: false,
            hasUnavailable: false,
            allKnownIntentional: false,
          },
        }
        : {}),
    };
  }

  const nextHidden = hidden === undefined
    ? undefined
    : hiddenSave === undefined
      ? hidden
      : hiddenAfterSave(hidden, hiddenSave, hiddenCount === 1);
  // A settled last hidden context leaves no remainder to warn about.
  const keepHidden = nextHidden !== undefined && remainingHidden !== 0;
  return {
    ...summary,
    exposure_contexts: patched,
    ...(declaredCount !== undefined
      ? { exposure_context_count: Math.max(0, declaredCount - removed) }
      : {}),
    ...(summary.exposure_context_summary
      ? { exposure_context_summary: summaryAfterSavedIntents(summary, patched, keepHidden ? nextHidden : undefined) }
      : {}),
    ...(keepHidden
      ? { exposure_contexts_truncated: true, exposure_context_hidden: nextHidden }
      : remainingHidden === 0
        ? { exposure_contexts_truncated: false, exposure_context_hidden: undefined }
        : truncated ? { exposure_contexts_truncated: true } : {}),
  };
}

/**
 * Adopt a confirmed save's intents into the standing summaries, so the intent
 * evidence and the row's action reflect the save even when the reread of those
 * summaries fails. Attached contexts of the saved stack take the new effective
 * intent (service row, else stack row); an unverified tunnel reach settled by
 * `internal` or `same-node` stops counting as exposed, as on the server. A saved
 * service that the cap hides settles or classifies its own hidden context, and
 * resolves the captured remainder once it was the last one. Every other stack
 * and every image untouched by the stack keeps its summary. Returns the input
 * when nothing changed.
 */
export function applySavedIntents(
  summaries: Record<string, ScanSummary>,
  stackName: string,
  intents: readonly IntentEntry[],
  saved?: SavedIntentTarget,
): Record<string, ScanSummary> {
  let changed = false;
  const next: Record<string, ScanSummary> = { ...summaries };
  for (const [imageRef, summary] of Object.entries(summaries)) {
    const patched = summaryAfterSave(summary, imageRef, stackName, intents, saved);
    if (patched === null) continue;
    changed = true;
    next[imageRef] = patched;
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

/** The label a conflict line shows. A conflict named by a visible context uses
 *  its intent; one known only from the aggregate, or from a hidden save, has no
 *  visible context and falls back to `internal` unless a hidden save recorded
 *  its intent. */
function conflictEvidenceLine(intent: ExposureIntent | undefined): string {
  return `Intent mismatch: ${intent ? intentDisplayLabel(intent) : 'internal'}`;
}

function formatIntentEvidence(t: ExposureIntentSource): string | null {
  if (t.intentStatus === 'unavailable') return null;
  if (t.intentConflict) return conflictEvidenceLine(t.exposureIntent);
  if (t.intentStatus === 'unset') return 'Intent: not classified';
  if (t.intentStatus === 'set' && t.exposureIntent) {
    return `Intent: ${intentDisplayLabel(t.exposureIntent)}`;
  }
  return null;
}

/**
 * Prefer aggregate summary flags for the primary conclusion when present,
 * then fall back to the best ranked context line. A conflict known only from a
 * hidden save carries its intent in `hiddenConflictIntent`.
 */
function primaryLineFromContexts(
  contexts: ExposureIntentSource[],
  summary?: ImageExposureContextSummary,
  hiddenConflictIntent?: ExposureIntent,
): string | null {
  if (contexts.length === 0) return null;

  if (summary?.hasConflict) {
    return conflictEvidenceLine(
      contexts.find((c) => c.intentConflict)?.exposureIntent ?? hiddenConflictIntent,
    );
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
 * Mixed-version publicly_exposed without contexts and without
 * `exposure_context_summary` yields null (badge only); a projected summary
 * whose displayed contexts all settled still reports a warning the capped
 * remainder may hold.
 */
export function standingIntentEvidence(summary: ScanSummary): string | null {
  if (summary.publicly_exposed !== true) return null;
  const contexts = summary.exposure_contexts ?? [];
  const flags = summary.exposure_context_summary;
  const total = summary.exposure_context_count ?? contexts.length;
  const hiddenConflictIntent = summary.exposure_context_hidden?.conflictIntent;

  if (contexts.length === 0) {
    // A save can settle every displayed context while the capped remainder may
    // still hold a warning; report that remainder instead of dropping it. The
    // count can be unknown when truncation is flagged without a total.
    if (!flags) return null;
    if (flags.hasConflict) return withExtras(conflictEvidenceLine(hiddenConflictIntent), total);
    if (flags.hasUnclassified) return withExtras('Intent: not classified', total);
    return null;
  }

  const primaryLine = primaryLineFromContexts(contexts, flags, hiddenConflictIntent);
  if (!primaryLine) return null;

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
): ImageExposureContextRef[] {
  const seen = new Set<string>();
  const out: ImageExposureContextRef[] = [];
  for (const t of targets) {
    if (!t.stackName || !t.serviceName) continue;
    const key = `${t.stackName}\0${t.serviceName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      imageRef: t.imageRef,
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
): ImageExposureContextRef[] {
  if (!targets) return [];
  return allTargetingExposureContexts(
    targets.filter((t) => t.imageRef === imageRef),
  );
}
