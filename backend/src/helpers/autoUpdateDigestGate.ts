import type { ImageCheckResult } from '../services/ImageUpdateService';
import { readEffectiveStackFacts } from '../services/effectiveServiceModel';
import {
  applyIgnoreToCheck,
  directiveFor,
  directivesFromResolution,
  triggerResultForRef,
  type DetectionDirectives,
  type TriggerSuppression,
} from '../services/updateDetectionDirectives';
import { SENCHO_UPDATE_IGNORE_LABEL } from './senchoLabels';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';

/** Accumulator for auto-update image checks (digest vs tag-only vs error). */
export interface AutoUpdateDigestGateState {
  hasDigestUpdate: boolean;
  hasTagOnlyUpdate: boolean;
  updatedImages: string[];
  checkErrors: string[];
  /** Services whose pending update the detection labels kept from starting the run. */
  suppressed: { service: string; reason: TriggerSuppression }[];
  /**
   * Services a whole-stack update pulls although their labels say not to report
   * them: checks off, or a pending update skipped. Named in the run result.
   */
  alsoPulls: { service: string; reason: TriggerSuppression }[];
}

export function createAutoUpdateDigestGateState(): AutoUpdateDigestGateState {
  return {
    hasDigestUpdate: false,
    hasTagOnlyUpdate: false,
    updatedImages: [],
    checkErrors: [],
    suppressed: [],
    alsoPulls: [],
  };
}

/** One image an unattended update would pull, with the Compose services that run it. */
export interface AutoUpdateTriggerImage {
  ref: string;
  owners: string[];
}

/**
 * The one trigger evaluation for unattended updates (scheduled, automatic, and
 * the hub-prepared remote run). Every image is checked as before, so an image
 * whose check fails still blocks a whole-stack update; the detection labels
 * only decide whether an image's update can be the reason to start one.
 * `check` returns null for an image whose result is missing.
 */
export async function evaluateAutoUpdateTrigger(
  images: readonly AutoUpdateTriggerImage[],
  directives: DetectionDirectives,
  check: (ref: string) => Promise<ImageCheckResult | null>,
): Promise<AutoUpdateDigestGateState> {
  const state = createAutoUpdateDigestGateState();
  const alsoPulls = new Map<string, TriggerSuppression>();
  for (const image of images) {
    let raw: ImageCheckResult | null;
    try {
      raw = await check(image.ref);
    } catch (error) {
      state.checkErrors.push(getErrorMessage(error, String(error)));
      console.warn('[AutoUpdate] Failed to check image %s:', sanitizeForLog(image.ref), sanitizeForLog(getErrorMessage(error, 'unknown')));
      continue;
    }
    if (!raw) {
      state.checkErrors.push('Update check incomplete');
      continue;
    }
    const { result, suppressed } = triggerResultForRef(image.ref, image.owners, raw, directives);
    recordAutoUpdateImageCheck(state, image.ref, result);
    for (const owner of image.owners) {
      const directive = directiveFor(directives, owner);
      const reason: TriggerSuppression | null = !directive.check ? 'off'
        : applyIgnoreToCheck(image.ref, raw, directive.ignore).ignored ? 'ignored' : null;
      if (!reason) continue;
      if (!alsoPulls.has(owner) || reason === 'ignored') alsoPulls.set(owner, reason);
      if (suppressed && !state.suppressed.some(entry => entry.service === owner)) {
        state.suppressed.push({ service: owner, reason });
      }
    }
  }
  state.alsoPulls = [...alsoPulls].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([service, reason]) => ({ service, reason }));
  return state;
}

const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';

/**
 * The detection directives of a local stack, from one render. A model that
 * does not render applies no label, so every update still counts.
 */
export async function localDetectionDirectives(nodeId: number, stackName: string): Promise<DetectionDirectives> {
  const facts = await readEffectiveStackFacts(nodeId, stackName);
  return directivesFromResolution(facts.model.renderable ? facts.labels : null);
}

/**
 * The images of a local stack's containers, each with the Compose services that
 * run it. A container without a service label adds its image with no owner,
 * which always counts for the trigger.
 */
export function triggerImagesFromContainers(
  containers: readonly { Image?: string; Labels?: Record<string, string> }[],
): AutoUpdateTriggerImage[] {
  const owners = new Map<string, Set<string>>();
  for (const container of containers) {
    const ref = container.Image;
    if (!ref || ref.startsWith('sha256:')) continue;
    const set = owners.get(ref) ?? new Set<string>();
    const service = container.Labels?.[COMPOSE_SERVICE_LABEL];
    if (service) set.add(service);
    owners.set(ref, set);
  }
  return [...owners].map(([ref, services]) => ({ ref, owners: [...services].sort() }));
}

const SUPPRESSION_NOTE: Record<TriggerSuppression, string> = {
  off: 'update checks off',
  ignored: 'update skipped',
};

/**
 * The run-result sentence naming the services a started whole-stack update
 * also pulled though their labels skip or do not check them. Empty when none.
 */
export function alsoPullsNote(state: Pick<AutoUpdateDigestGateState, 'alsoPulls'>): string {
  if (state.alsoPulls.length === 0) return '';
  return ` Also pulled: ${state.alsoPulls.map(entry => `${entry.service} (${SUPPRESSION_NOTE[entry.reason]})`).join(', ')}.`;
}

/**
 * Record one image check into the digest gate. Only digest drift is Compose-
 * actionable for auto-update; tag bumps stay advisory.
 */
export function recordAutoUpdateImageCheck(
  state: AutoUpdateDigestGateState,
  imageRef: string,
  result: ImageCheckResult,
): void {
  if (result.digestUpdate) {
    state.hasDigestUpdate = true;
    state.updatedImages.push(imageRef);
    return;
  }
  if (result.tagUpdate) {
    state.hasTagOnlyUpdate = true;
    return;
  }
  if (result.error || result.checkStatus === 'failed' || result.checkStatus === 'partial') {
    state.checkErrors.push(result.error ?? 'Update check incomplete');
  }
}

/**
 * Operator message when a sibling image check failed and a full-stack Compose
 * update must not run (it would pull/recreate the unverified image as
 * collateral). Null when digest apply may proceed.
 */
export function messageWhenDigestApplyBlockedByCheckErrors(
  stackName: string,
  state: Pick<AutoUpdateDigestGateState, 'hasDigestUpdate' | 'checkErrors'>,
): string | null {
  if (!state.hasDigestUpdate || state.checkErrors.length === 0) return null;
  return `Stack "${stackName}": WARNING - digest update available but ${state.checkErrors.length} image check(s) failed; skipped auto-update (${state.checkErrors.join('; ')}).`;
}

/** Operator message when no digest-actionable update was found. */
export function messageWhenNoDigestUpdate(
  stackName: string,
  state: Pick<AutoUpdateDigestGateState, 'hasTagOnlyUpdate' | 'checkErrors'> & Partial<Pick<AutoUpdateDigestGateState, 'suppressed'>>,
  imageRefCount: number,
): string {
  const errNote = state.checkErrors.length > 0
    ? ` (${state.checkErrors.length} check(s) failed)`
    : '';
  if (state.hasTagOnlyUpdate) {
    return `Stack "${stackName}": newer tag available but Compose pin unchanged; skipped auto-update${errNote}.`;
  }
  // A skipped update is never reported as "up to date".
  const suppressed = state.suppressed ?? [];
  if (suppressed.length > 0) {
    const ignored = suppressed.filter(entry => entry.reason === 'ignored').map(entry => entry.service);
    if (ignored.length > 0) {
      return `Stack "${stackName}": the only available update is skipped by ${SENCHO_UPDATE_IGNORE_LABEL} (${ignored.join(', ')}); no update applied${errNote}.`;
    }
    const off = suppressed.map(entry => entry.service);
    return `Stack "${stackName}": the only available update belongs to a service with update checks off (${off.join(', ')}); no update applied${errNote}.`;
  }
  if (state.checkErrors.length > 0 && state.checkErrors.length === imageRefCount) {
    return `Stack "${stackName}": WARNING - all image checks failed (${state.checkErrors.join('; ')}). Unable to determine update status.`;
  }
  if (state.checkErrors.length > 0) {
    return `Stack "${stackName}": all reachable images up to date (${state.checkErrors.length} check(s) failed).`;
  }
  return `Stack "${stackName}": all images up to date.`;
}
