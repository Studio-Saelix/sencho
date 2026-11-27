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
  options: { buildServices?: readonly string[] } = {},
): Promise<AutoUpdateDigestGateState> {
  const state = createAutoUpdateDigestGateState();
  const buildServices = new Set(options.buildServices ?? []);
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
      // A build-backed service is built, not pulled, so a whole-stack update
      // does not fetch its registry image and the run result must not say so.
      if (!buildServices.has(owner) && (!alsoPulls.has(owner) || reason === 'ignored')) {
        alsoPulls.set(owner, reason);
      }
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

export interface LocalTriggerRoster {
  images: AutoUpdateTriggerImage[];
  directives: DetectionDirectives;
  buildServices: string[];
}

/**
 * The images a local whole-stack update would pull, derived from the same
 * effective model the operation uses. A declared service with no container yet
 * is still pulled by Compose, so it belongs in the pre-flight roster; a
 * build-backed service is built instead, so its registry image is not.
 */
export async function localTriggerRoster(
  nodeId: number,
  stackName: string,
  containers: readonly { Image?: string; Service?: string; Labels?: Record<string, string> }[],
): Promise<LocalTriggerRoster> {
  const facts = await readEffectiveStackFacts(nodeId, stackName);
  const directives = directivesFromResolution(facts.model.renderable ? facts.labels : null);
  const owners = new Map<string, Set<string>>();
  for (const image of triggerImagesFromContainers(containers)) {
    owners.set(image.ref, new Set(image.owners));
  }
  const buildServices: string[] = [];
  if (facts.model.renderable) {
    const built = new Set(facts.model.services.filter(service => service.hasBuild).map(service => service.name));
    const declared = new Set(facts.model.services.map(service => service.name));
    for (const service of facts.model.services) {
      if (service.hasBuild) buildServices.push(service.name);
      if (!service.declaredImage || service.hasBuild) continue;
      const set = owners.get(service.declaredImage) ?? new Set<string>();
      set.add(service.name);
      owners.set(service.declaredImage, set);
    }
    // The declared roster comes from the effective model. A running image of a
    // model service is also verified, but an orphan container or a build-backed
    // service is not pulled, so it is not a trigger.
    for (const [ref, services] of owners) {
      // An ownerless image still counts: the container list could not name its
      // Compose service, and a pre-flight that drops it would miss a pull.
      if (services.size === 0) continue;
      const keep = [...services].filter(name => declared.has(name) && !built.has(name));
      if (keep.length === 0) owners.delete(ref);
      else owners.set(ref, new Set(keep));
    }
  }
  return {
    images: [...owners].map(([ref, services]) => ({ ref, owners: [...services].sort() })),
    directives,
    buildServices,
  };
}

/**
 * Re-evaluate an unattended trigger at the mutation boundary. The caller ran
 * the gate before waiting for the stack lock; labels, declared services, or
 * containers can change while it waits. Any reason string means Compose must
 * not run.
 */
export async function revalidateLocalAutoUpdateTrigger(
  nodeId: number,
  stackName: string,
  readContainers: () => Promise<Array<{ Image?: string; Service?: string; Labels?: Record<string, string> }> | null | undefined>,
  check: (ref: string) => Promise<ImageCheckResult | null>,
): Promise<string | null> {
  const containers = await readContainers();
  if (!containers || containers.length === 0) {
    return `Stack "${stackName}": no containers found; skipped.`;
  }
  const roster = await localTriggerRoster(nodeId, stackName, containers);
  if (roster.images.length === 0) {
    return `Stack "${stackName}": no pullable images; skipped.`;
  }
  const gate = await evaluateAutoUpdateTrigger(roster.images, roster.directives, check, {
    buildServices: roster.buildServices,
  });
  if (!gate.hasDigestUpdate) return messageWhenNoDigestUpdate(stackName, gate, roster.images.length);
  return messageWhenDigestApplyBlockedByCheckErrors(stackName, gate);
}

/**
 * The images of a local stack's containers, each with the Compose services that
 * run it. `getContainersByStack` reports the Compose service as `Service` (from
 * `docker compose ps`, or derived from the project label on the engine
 * fallback) and does not carry `Labels`; a raw Dockerode container carries the
 * label. A container with neither adds its image with no owner, which always
 * counts for the trigger.
 */
export function triggerImagesFromContainers(
  containers: readonly { Image?: string; Service?: string; Labels?: Record<string, string> }[],
): AutoUpdateTriggerImage[] {
  const owners = new Map<string, Set<string>>();
  for (const container of containers) {
    const ref = container.Image;
    if (!ref || ref.startsWith('sha256:')) continue;
    const set = owners.get(ref) ?? new Set<string>();
    const service = container.Labels?.[COMPOSE_SERVICE_LABEL] || container.Service;
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
  // A confirmed higher tag does not verify the current tag's content. A
  // whole-stack update pulls that content as collateral, so its failed digest
  // comparison still blocks the run.
  if (result.detection?.digestError) state.checkErrors.push(result.detection.digestError);
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
    const error = result.error ?? 'Update check incomplete';
    // The digest error was already recorded above for this same image.
    if (error !== result.detection?.digestError) state.checkErrors.push(error);
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

/**
 * The sentence naming what the detection labels kept from starting a run.
 * A tag-only advisory is never called "actionable": Compose cannot apply it
 * without a Compose edit. When one tag is reported, the update a label
 * suppressed is another pending update, not "the only" one.
 */
function suppressionSentence(
  suppressed: readonly { service: string; reason: TriggerSuppression }[],
  subject: 'only available update' | 'another pending update',
): string | null {
  if (suppressed.length === 0) return null;
  const phrase = subject === 'only available update' ? 'the only available update' : subject;
  const ignored = suppressed.filter(entry => entry.reason === 'ignored').map(entry => entry.service);
  if (ignored.length > 0) {
    return `${phrase} is skipped by ${SENCHO_UPDATE_IGNORE_LABEL} (${ignored.join(', ')}); no update applied`;
  }
  const names = suppressed.map(entry => entry.service);
  const noun = names.length === 1 ? 'a service' : 'services';
  return `${phrase} belongs to ${noun} with update checks off (${names.join(', ')}); no update applied`;
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
  // A skipped update is never reported as "up to date".
  const suppressed = state.suppressed ?? [];
  if (state.hasTagOnlyUpdate) {
    const blocked = suppressionSentence(suppressed, 'another pending update');
    const tail = blocked ? ` ${blocked.charAt(0).toUpperCase()}${blocked.slice(1)}.` : '';
    return `Stack "${stackName}": newer tag available but Compose pin unchanged; skipped auto-update${errNote}.${tail}`;
  }
  const blocked = suppressionSentence(suppressed, 'only available update');
  if (blocked) {
    return `Stack "${stackName}": ${blocked}${errNote}.`;
  }
  if (state.checkErrors.length > 0 && state.checkErrors.length === imageRefCount) {
    return `Stack "${stackName}": WARNING - all image checks failed (${state.checkErrors.join('; ')}). Unable to determine update status.`;
  }
  if (state.checkErrors.length > 0) {
    return `Stack "${stackName}": all reachable images up to date (${state.checkErrors.length} check(s) failed).`;
  }
  return `Stack "${stackName}": all images up to date.`;
}
