/**
 * Shared Security exposure-context builder: cached StackExposure descriptors
 * plus Networking getExposureContext. Used by overview posture targets and
 * standing /image-summaries enrichment.
 *
 * Unavailable context is distinct from unset intent. Absolute all-intentional
 * claims require every context to be complete; unavailable never becomes certainty.
 */
import { getExposureContext } from './network/exposureContext';
import type { ExposureIntent } from './network/types';
import type { ExposureReason, StackExposure } from './preflight/exposure';
import { isCertainTunnelPath, type ServiceTunnelExposure } from './network/tunnelDetection';
import type { PostureTarget } from './securityPosture';

/** Max contexts returned per image on /image-summaries (display list only). */
export const IMAGE_EXPOSURE_CONTEXT_CAP = 20;

/** Intents that mean the operator deliberately classified exposure. */
const INTENTIONAL: ReadonlySet<ExposureIntent> = new Set([
  'public', 'lan', 'reverse-proxy', 'temporary',
]);

const CONFLICT: ReadonlySet<ExposureIntent> = new Set(['internal', 'same-node']);

/** Per stack/service exposure + intent (image identity lives on the parent). */
export interface ImageExposureContext {
  stackName: string;
  serviceName: string;
  exposureReason: ExposureReason | null;
  tunnel?: ServiceTunnelExposure;
  exposureIntent?: ExposureIntent;
  intentStatus: 'set' | 'unset' | 'unavailable';
  intentConflict?: boolean;
}

export interface ImageExposureContextSummary {
  hasConflict: boolean;
  hasUnclassified: boolean;
  hasUnavailable: boolean;
  /** Every complete (set) context is intentional and there is no unset among available. */
  allKnownIntentional: boolean;
}

export interface PackagedImageExposureContexts {
  exposure_contexts: ImageExposureContext[];
  exposure_context_count: number;
  exposure_contexts_truncated: boolean;
  exposure_context_summary: ImageExposureContextSummary;
}

export interface BuildImageExposureContextsInput {
  nodeId: number;
  exposures: StackExposure[];
  /** When set, only services whose image is in the set are emitted. */
  qualifyingImageRefs?: Set<string>;
  getContext?: typeof getExposureContext;
}

/** Row with imageRef for grouping into per-image packages / posture targets. */
export interface ImageExposureContextRow extends ImageExposureContext {
  imageRef: string;
}

function effectiveIntent(
  service: string,
  stackIntent: ExposureIntent | null,
  serviceIntents: Record<string, ExposureIntent>,
): ExposureIntent | null {
  return serviceIntents[service] ?? stackIntent ?? null;
}

/**
 * Settle unverified tunnel exposure against the operator's intent. A service
 * exposed only by a tunnel whose routing Sencho cannot see (a Cloudflare
 * namespace, a shared network, or the host network) and classified internal or
 * same-node is taken at the operator's word and not counted as exposed; Compose
 * Doctor still asks them to confirm the routing. A certain reach (a shared
 * network namespace behind a Tailscale or WireGuard connector) stays exposed
 * and conflicts with that intent. Security reads cached descriptors
 * through `readSettledExposures`, so the exposed-image map and the exposure
 * targets agree.
 */
export function settleTunnelExposure(
  nodeId: number,
  exposures: StackExposure[],
  getContext: typeof getExposureContext = getExposureContext,
): StackExposure[] {
  return exposures.map((exp) => {
    const unverified = exp.services.filter((svc) =>
      svc.reason === 'tunnel' && svc.tunnel !== undefined && !isCertainTunnelPath(svc.tunnel));
    if (unverified.length === 0) return exp;
    const ctx = getContext(nodeId, exp.stack);
    if (!ctx.available) return exp;
    const settled = new Set(unverified
      .filter((svc) => {
        const intent = effectiveIntent(svc.service, ctx.stackIntent, ctx.serviceIntents);
        return intent !== null && CONFLICT.has(intent);
      })
      .map((svc) => svc.service));
    if (settled.size === 0) return exp;
    return {
      ...exp,
      services: exp.services.map((svc) => (settled.has(svc.service) ? { ...svc, publiclyExposed: false } : svc)),
    };
  });
}

/** Parse cached `stack_exposures` rows (skipping, with a warning, any that is
 *  not JSON or has no services list) and settle their tunnel exposure. The one
 *  way Security reads cached descriptors. */
export function readSettledExposures(
  nodeId: number,
  rows: ReadonlyArray<{ descriptor: string }>,
  getContext: typeof getExposureContext = getExposureContext,
): StackExposure[] {
  const parsed = rows.map((r) => {
    try {
      const value: unknown = JSON.parse(r.descriptor);
      return value && typeof value === 'object' && Array.isArray((value as { services?: unknown }).services) ? value as StackExposure : null;
    } catch {
      return null;
    }
  }).filter((e): e is StackExposure => e !== null);
  if (parsed.length < rows.length) {
    console.warn(`[Security] Skipped ${rows.length - parsed.length} unreadable cached exposure descriptor(s) on node ${nodeId}; those stacks show exposure as unknown until their next deploy or update.`);
  }
  return settleTunnelExposure(nodeId, parsed, getContext);
}

function rowKey(imageRef: string, stackName: string, serviceName: string): string {
  return `${imageRef}\0${stackName}\0${serviceName}`;
}

function isIntentionalSet(c: Pick<ImageExposureContext, 'intentStatus' | 'exposureIntent' | 'intentConflict'>): boolean {
  return (
    c.intentStatus === 'set'
    && !c.intentConflict
    && !!c.exposureIntent
    && INTENTIONAL.has(c.exposureIntent)
  );
}

/** Sort: conflict, unset, unavailable, then intentional/set. */
export function sortExposureContexts<T extends ImageExposureContext>(contexts: T[]): T[] {
  return [...contexts].sort((a, b) => exposureContextRank(a) - exposureContextRank(b));
}

export function exposureContextRank(c: ImageExposureContext): number {
  if (c.intentConflict) return 0;
  if (c.intentStatus === 'unset') return 1;
  if (c.intentStatus === 'unavailable') return 2;
  return 3;
}

export function summarizeExposureContexts(
  contexts: ImageExposureContext[],
): ImageExposureContextSummary {
  let hasConflict = false;
  let hasUnclassified = false;
  let hasUnavailable = false;
  let sawComplete = false;
  let allKnownIntentional = true;

  for (const c of contexts) {
    if (c.intentConflict) hasConflict = true;
    if (c.intentStatus === 'unset') hasUnclassified = true;
    if (c.intentStatus === 'unavailable') {
      hasUnavailable = true;
      continue;
    }
    sawComplete = true;
    if (!isIntentionalSet(c)) allKnownIntentional = false;
  }

  if (!sawComplete) allKnownIntentional = false;

  return { hasConflict, hasUnclassified, hasUnavailable, allKnownIntentional };
}

/**
 * Absolute intentional: every context is set, non-conflicting, intentional.
 * Unavailable or unset anywhere yields false. Empty yields false.
 */
export function allContextsAbsolutelyIntentional(
  contexts: ImageExposureContext[] | undefined,
  truncated = false,
): boolean {
  if (truncated || !contexts || contexts.length === 0) return false;
  return contexts.every(isIntentionalSet);
}

/**
 * Partial intentional: at least one unavailable, no conflict/unset among
 * available contexts, and every available set context is intentional.
 */
export function partialIntentionalWithUnavailable(
  contexts: ImageExposureContext[] | undefined,
  truncated = false,
): { partial: boolean; unavailableCount: number } {
  if (truncated || !contexts || contexts.length === 0) {
    return { partial: false, unavailableCount: 0 };
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
      return { partial: false, unavailableCount };
    }
  }
  return {
    partial: unavailableCount > 0 && sawAvailable,
    unavailableCount,
  };
}

export function packageImageExposureContexts(
  contexts: ImageExposureContext[],
  cap = IMAGE_EXPOSURE_CONTEXT_CAP,
): PackagedImageExposureContexts {
  const summary = summarizeExposureContexts(contexts);
  const sorted = sortExposureContexts(contexts);
  const truncated = sorted.length > cap;
  return {
    exposure_contexts: sorted.slice(0, cap),
    exposure_context_count: contexts.length,
    exposure_contexts_truncated: truncated,
    exposure_context_summary: summary,
  };
}

/**
 * Emit one context row per exposed service (optionally filtered by image set).
 * Batches getExposureContext once per distinct stack.
 */
export function buildImageExposureContextRows(
  input: BuildImageExposureContextsInput,
): ImageExposureContextRow[] {
  const { nodeId, exposures, qualifyingImageRefs } = input;
  const getContext = input.getContext ?? getExposureContext;

  if (qualifyingImageRefs && qualifyingImageRefs.size === 0) return [];

  const contextByStack = new Map<string, ReturnType<typeof getExposureContext>>();
  const seen = new Set<string>();
  const rows: ImageExposureContextRow[] = [];

  for (const exp of exposures) {
    for (const svc of exp.services) {
      if (!svc.image || !svc.publiclyExposed) continue;
      if (qualifyingImageRefs && !qualifyingImageRefs.has(svc.image)) continue;

      let ctx = contextByStack.get(exp.stack);
      if (ctx === undefined) {
        ctx = getContext(nodeId, exp.stack);
        contextByStack.set(exp.stack, ctx);
      }

      const row: ImageExposureContextRow = {
        imageRef: svc.image,
        stackName: exp.stack,
        serviceName: svc.service,
        exposureReason: svc.reason,
        intentStatus: 'unavailable',
      };
      // Name the tunnel only when it is why the service counts as exposed.
      if (svc.reason === 'tunnel' && svc.tunnel) row.tunnel = svc.tunnel;

      if (ctx.available) {
        const intent = effectiveIntent(svc.service, ctx.stackIntent, ctx.serviceIntents);
        if (intent === null || intent === 'unknown') {
          row.intentStatus = 'unset';
        } else {
          row.intentStatus = 'set';
          row.exposureIntent = intent;
          if (CONFLICT.has(intent)) row.intentConflict = true;
        }
      }

      const key = rowKey(row.imageRef, row.stackName, row.serviceName);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
  }

  return rows;
}

/** Group rows by imageRef and package each for /image-summaries. */
export function packageExposureContextsByImage(
  rows: ImageExposureContextRow[],
  cap = IMAGE_EXPOSURE_CONTEXT_CAP,
): Map<string, PackagedImageExposureContexts> {
  const byImage = new Map<string, ImageExposureContext[]>();
  for (const row of rows) {
    const { imageRef, ...ctx } = row;
    const list = byImage.get(imageRef) ?? [];
    list.push(ctx);
    byImage.set(imageRef, list);
  }
  const out = new Map<string, PackagedImageExposureContexts>();
  for (const [imageRef, contexts] of byImage) {
    out.set(imageRef, packageImageExposureContexts(contexts, cap));
  }
  return out;
}

export function toPostureTarget(row: ImageExposureContextRow): PostureTarget {
  const target: PostureTarget = {
    imageRef: row.imageRef,
    stackName: row.stackName,
    serviceName: row.serviceName,
    exposureReason: row.exposureReason,
    intentStatus: row.intentStatus,
  };
  if (row.tunnel) target.tunnel = row.tunnel;
  if (row.exposureIntent) target.exposureIntent = row.exposureIntent;
  if (row.intentConflict) target.intentConflict = true;
  return target;
}

/**
 * Emit PostureTarget rows for qualifying images (overview).
 * Batches getExposureContext once per distinct stack.
 */
export function buildSecurityExposureTargets(
  input: BuildImageExposureContextsInput & { qualifyingImageRefs: Set<string> },
): PostureTarget[] {
  return buildImageExposureContextRows(input).map(toPostureTarget);
}

function contextsFromTargets(targets: PostureTarget[] | undefined): ImageExposureContext[] {
  if (!targets) return [];
  const out: ImageExposureContext[] = [];
  for (const t of targets) {
    if (!t.stackName || !t.serviceName || !t.intentStatus) continue;
    out.push({
      stackName: t.stackName,
      serviceName: t.serviceName,
      exposureReason: t.exposureReason ?? null,
      ...(t.tunnel ? { tunnel: t.tunnel } : {}),
      exposureIntent: t.exposureIntent,
      intentStatus: t.intentStatus,
      intentConflict: t.intentConflict,
    });
  }
  return out;
}

/** Absolute intentional for posture targets (unavailable yields false). */
export function allTargetsIntentionallyClassified(
  targets: PostureTarget[] | undefined,
  truncated = false,
): boolean {
  return allContextsAbsolutelyIntentional(contextsFromTargets(targets), truncated);
}

export function anyTargetIntentConflict(targets: PostureTarget[] | undefined): boolean {
  return targets?.some((t) => t.intentConflict) ?? false;
}

export function anyTargetIntentUnset(targets: PostureTarget[] | undefined): boolean {
  return targets?.some((t) => t.intentStatus === 'unset') ?? false;
}

export function anyTargetIntentUnavailable(targets: PostureTarget[] | undefined): boolean {
  return targets?.some((t) => t.intentStatus === 'unavailable') ?? false;
}

export function partialTargetsIntentionalWithUnavailable(
  targets: PostureTarget[] | undefined,
  truncated = false,
): { partial: boolean; unavailableCount: number } {
  return partialIntentionalWithUnavailable(contextsFromTargets(targets), truncated);
}
