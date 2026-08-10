/**
 * Build Security posture exposure targets from cached StackExposure descriptors
 * plus the shared Networking exposure-intent context.
 *
 * Preserves stack/service identity that buildExposedImageMap collapses away.
 * Intent comes only from getExposureContext (never reinvented here).
 * Unavailable context is distinct from unset intent.
 */
import { getExposureContext } from './network/exposureContext';
import type { ExposureIntent } from './network/types';
import type { StackExposure } from './preflight/exposure';
import type { PostureTarget } from './securityPosture';

/** Intents that mean the operator deliberately classified exposure. */
const INTENTIONAL: ReadonlySet<ExposureIntent> = new Set([
  'public', 'lan', 'reverse-proxy', 'temporary',
]);

const CONFLICT: ReadonlySet<ExposureIntent> = new Set(['internal', 'same-node']);

export interface BuildSecurityExposureTargetsInput {
  nodeId: number;
  exposures: StackExposure[];
  /** Image refs that qualify for the blocker or review reason. */
  qualifyingImageRefs: Set<string>;
  /** Injected for tests; defaults to shared getExposureContext. */
  getContext?: typeof getExposureContext;
}

function effectiveIntent(
  service: string,
  stackIntent: ExposureIntent | null,
  serviceIntents: Record<string, ExposureIntent>,
): ExposureIntent | null {
  return serviceIntents[service] ?? stackIntent ?? null;
}

function targetKey(t: PostureTarget): string {
  return `${t.imageRef}\0${t.stackName ?? ''}\0${t.serviceName ?? ''}`;
}

/**
 * Emit one PostureTarget per exposed service whose image is in the qualifying set.
 * Batches getExposureContext once per distinct stack. Caller caps via POSTURE_TARGET_CAP.
 */
export function buildSecurityExposureTargets(
  input: BuildSecurityExposureTargetsInput,
): PostureTarget[] {
  const { nodeId, exposures, qualifyingImageRefs } = input;
  const getContext = input.getContext ?? getExposureContext;

  if (qualifyingImageRefs.size === 0) return [];

  const contextByStack = new Map<string, ReturnType<typeof getExposureContext>>();
  const seen = new Set<string>();
  const targets: PostureTarget[] = [];

  for (const exp of exposures) {
    for (const svc of exp.services) {
      if (!svc.image || !svc.publiclyExposed) continue;
      if (!qualifyingImageRefs.has(svc.image)) continue;

      let ctx = contextByStack.get(exp.stack);
      if (ctx === undefined) {
        ctx = getContext(nodeId, exp.stack);
        contextByStack.set(exp.stack, ctx);
      }

      const target: PostureTarget = {
        imageRef: svc.image,
        stackName: exp.stack,
        serviceName: svc.service,
        exposureReason: svc.reason,
      };

      if (!ctx.available) {
        target.intentStatus = 'unavailable';
      } else {
        const intent = effectiveIntent(svc.service, ctx.stackIntent, ctx.serviceIntents);
        if (intent === null || intent === 'unknown') {
          target.intentStatus = 'unset';
        } else {
          target.intentStatus = 'set';
          target.exposureIntent = intent;
          if (CONFLICT.has(intent)) target.intentConflict = true;
        }
      }

      const key = targetKey(target);
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(target);
    }
  }

  return targets;
}

/** True when every non-unavailable target is set, non-conflicting, and intentional
 *  (public / lan / reverse-proxy / temporary). False when empty, all unavailable,
 *  or any unset/conflict/non-intentional target is present. */
export function allTargetsIntentionallyClassified(targets: PostureTarget[] | undefined): boolean {
  if (!targets || targets.length === 0) return false;
  let sawAvailable = false;
  for (const t of targets) {
    if (t.intentStatus === 'unavailable') continue;
    sawAvailable = true;
    if (
      t.intentStatus === 'unset'
      || t.intentConflict
      || !t.exposureIntent
      || !INTENTIONAL.has(t.exposureIntent)
    ) {
      return false;
    }
  }
  return sawAvailable;
}

export function anyTargetIntentConflict(targets: PostureTarget[] | undefined): boolean {
  return targets?.some((t) => t.intentConflict) ?? false;
}

export function anyTargetIntentUnset(targets: PostureTarget[] | undefined): boolean {
  return targets?.some((t) => t.intentStatus === 'unset') ?? false;
}
