/**
 * Join Security package-fix findings to persisted image-update evidence.
 *
 * Trivy `fixed_version` proves a patched package exists. It does not prove an
 * applicable container image update exists. This module consumes the canonical
 * ImageUpdateService rows only (no registry I/O) and classifies each finding
 * image as: confirmed update available, authoritative waiting-for-upstream, or
 * uncertain remediation availability.
 *
 * Classification may join via normalizeImageRef, but imageRefs* arrays always
 * carry the raw finding image_ref so Images-tab targeting matches scan summaries.
 */
import { normalizeImageRef } from './DriftDetectionService';
import type { StackServiceStatus, StackUpdateDetail } from './DatabaseService';

export type ImageRemediationClass = 'update_available' | 'waiting_upstream' | 'uncertain';

export interface RemediationFindingInput {
  image_ref: string;
  /** Count of unsuppressed Crit/High findings with fixed_version on this image. */
  count: number;
}

export interface ImageRemediationFacts {
  fixableWithImageUpdate: number;
  fixableWaitingUpstream: number;
  fixableUpdateUnknown: number;
  /** True when checks are disabled and any fixable package findings exist. */
  updateChecksDisabled: boolean;
  /** Distinct raw finding image_refs in each class (never normalizeImageRef'd). */
  imageRefsUpdateAvailable: string[];
  imageRefsWaitingUpstream: string[];
  imageRefsUpdateUnknown: string[];
  /**
   * The stack services behind each confirmed update: one row per raw finding
   * image_ref and service whose fresh check found a newer image. This is what
   * lets a verb update a specific stack instead of sending the operator to look.
   */
  updateServiceTargets: UpdateServiceTarget[];
}

export interface UpdateServiceTarget {
  imageRef: string;
  stackName: string;
  serviceName: string;
}

export interface ClassifyImageRemediationInput {
  findings: RemediationFindingInput[];
  details: Record<string, StackUpdateDetail>;
  checksEnabled: boolean;
  freshnessWindowMs: number;
  now: number;
}

interface IndexedService {
  stackName: string;
  service: StackServiceStatus;
  /** The service ref the finding image matched, so a skip is attributed to it. */
  matchedRef: string;
  checkedAt: number;
}

function collectServiceRefs(service: StackServiceStatus): string[] {
  const refs: string[] = [];
  if (service.image) refs.push(service.image);
  for (const runtime of service.runtimeImages ?? []) {
    if (runtime) refs.push(runtime);
  }
  return refs;
}

/** Build normalizeImageRef → services index from persisted stack update detail. */
export function buildUpdateServiceIndex(
  details: Record<string, StackUpdateDetail>,
): Map<string, IndexedService[]> {
  const index = new Map<string, IndexedService[]>();
  for (const [stackName, detail] of Object.entries(details)) {
    for (const service of detail.services ?? []) {
      for (const ref of collectServiceRefs(service)) {
        const key = normalizeImageRef(ref);
        if (!key) continue;
        const entry: IndexedService = { stackName, service, matchedRef: ref, checkedAt: detail.checkedAt };
        const list = index.get(key);
        if (list) list.push(entry);
        else index.set(key, [entry]);
      }
    }
  }
  return index;
}

/**
 * True when the service's own check found a newer image for this ref: a
 * service-wide reported update, or a skip whose ref-level evidence names this
 * ref. A skip hides the update from reporting; it does not mean upstream has
 * nothing newer, so it is never read as waiting on upstream. The skip is
 * matched to the ref that carried it, never to every image the service runs.
 */
function newerImageExists(service: StackServiceStatus, ref: string): boolean {
  return service.hasUpdate || (service.ignoredRefs?.includes(ref) ?? false);
}

/** A skip row written before ref-level evidence existed cannot prove which ref it cleared. */
function hasUnattributedSkip(service: StackServiceStatus): boolean {
  return service.detection === 'ignored' && service.ignoredRefs === undefined;
}

function isStackFresh(checkedAt: number, now: number, freshnessWindowMs: number): boolean {
  if (!Number.isFinite(checkedAt) || checkedAt <= 0) return false;
  return now - checkedAt <= freshnessWindowMs;
}

function classifyMatches(
  matches: IndexedService[],
  freshnessWindowMs: number,
  now: number,
): ImageRemediationClass {
  if (matches.length === 0) return 'uncertain';

  let sawCheckable = false;
  let anyConfirmedUpdate = false;
  let anyUncertain = false;
  let anyAuthoritativeNegative = false;

  for (const { service, matchedRef, checkedAt } of matches) {
    if (service.checkStatus === 'not_checkable') continue;
    sawCheckable = true;
    if (service.checkStatus !== 'ok' || !isStackFresh(checkedAt, now, freshnessWindowMs)
      || hasUnattributedSkip(service)) {
      anyUncertain = true;
      continue;
    }
    if (newerImageExists(service, matchedRef)) anyConfirmedUpdate = true;
    else anyAuthoritativeNegative = true;
  }

  // Confirmed update on any stack wins over sibling partial/stale uncertainty.
  if (anyConfirmedUpdate) return 'update_available';
  if (anyUncertain || !sawCheckable) return 'uncertain';
  if (anyAuthoritativeNegative) return 'waiting_upstream';
  return 'uncertain';
}

function emptyRemediationFacts(
  overrides: Partial<ImageRemediationFacts> = {},
): ImageRemediationFacts {
  return {
    fixableWithImageUpdate: 0,
    fixableWaitingUpstream: 0,
    fixableUpdateUnknown: 0,
    updateChecksDisabled: false,
    imageRefsUpdateAvailable: [],
    imageRefsWaitingUpstream: [],
    imageRefsUpdateUnknown: [],
    updateServiceTargets: [],
    ...overrides,
  };
}

function pushUnique(list: string[], ref: string): void {
  if (!list.includes(ref)) list.push(ref);
}

/** Services whose own fresh check confirmed a newer image, for one finding image. */
function confirmedUpdateServices(
  imageRef: string,
  matches: IndexedService[],
  freshnessWindowMs: number,
  now: number,
): UpdateServiceTarget[] {
  return matches
    .filter(({ service, matchedRef, checkedAt }) => service.checkStatus === 'ok'
      && newerImageExists(service, matchedRef)
      && isStackFresh(checkedAt, now, freshnessWindowMs))
    .map(({ stackName, service }) => ({ imageRef, stackName, serviceName: service.service }));
}

/**
 * Classify package-fix Crit/High findings against persisted update evidence.
 * Counts are finding counts (not distinct images). imageRefs* are distinct
 * raw finding image_refs in each class.
 */
export function classifyImageRemediation(input: ClassifyImageRemediationInput): ImageRemediationFacts {
  const { findings, details, checksEnabled, freshnessWindowMs, now } = input;

  const totalFixable = findings.reduce((sum, f) => sum + f.count, 0);
  if (totalFixable === 0) return emptyRemediationFacts();
  if (!checksEnabled) {
    const imageRefsUpdateUnknown: string[] = [];
    for (const finding of findings) pushUnique(imageRefsUpdateUnknown, finding.image_ref);
    return emptyRemediationFacts({
      fixableUpdateUnknown: totalFixable,
      updateChecksDisabled: true,
      imageRefsUpdateUnknown,
    });
  }

  let fixableWithImageUpdate = 0;
  let fixableWaitingUpstream = 0;
  let fixableUpdateUnknown = 0;
  const imageRefsUpdateAvailable: string[] = [];
  const imageRefsWaitingUpstream: string[] = [];
  const imageRefsUpdateUnknown: string[] = [];
  const updateServiceTargets: UpdateServiceTarget[] = [];

  const index = buildUpdateServiceIndex(details);
  for (const finding of findings) {
    const key = normalizeImageRef(finding.image_ref);
    const matches = key ? (index.get(key) ?? []) : [];
    switch (classifyMatches(matches, freshnessWindowMs, now)) {
      case 'update_available':
        fixableWithImageUpdate += finding.count;
        pushUnique(imageRefsUpdateAvailable, finding.image_ref);
        for (const target of confirmedUpdateServices(finding.image_ref, matches, freshnessWindowMs, now)) {
          if (!updateServiceTargets.some((t) => t.imageRef === target.imageRef && t.stackName === target.stackName && t.serviceName === target.serviceName)) {
            updateServiceTargets.push(target);
          }
        }
        break;
      case 'waiting_upstream':
        fixableWaitingUpstream += finding.count;
        pushUnique(imageRefsWaitingUpstream, finding.image_ref);
        break;
      default:
        fixableUpdateUnknown += finding.count;
        pushUnique(imageRefsUpdateUnknown, finding.image_ref);
        break;
    }
  }

  return emptyRemediationFacts({
    fixableWithImageUpdate,
    fixableWaitingUpstream,
    fixableUpdateUnknown,
    imageRefsUpdateAvailable,
    imageRefsWaitingUpstream,
    imageRefsUpdateUnknown,
    updateServiceTargets,
  });
}
