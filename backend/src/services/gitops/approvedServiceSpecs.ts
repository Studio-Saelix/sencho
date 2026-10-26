/**
 * Service specs parsed from approved compose content.
 *
 * Both freeze paths resolve an artifact set from the compose text that was
 * approved rather than from a node's rendered model, because a reconcile tick
 * can run long after the deploy and the directory is no longer evidence of what
 * was approved. The authored text stands in for the rendered model only when it
 * contains nothing Compose would expand or merge, so this parse refuses every
 * construct that can change the rendered service set:
 *
 * - `include`, which merges services from other files the parse never sees.
 * - `profiles`, which the node's `docker compose config` does not activate, so
 *   the rendered model omits those services while a flat parse keeps them.
 * - `extends`, which can import `profiles` (and other fields) onto a service
 *   that shows no trace of them in its own body.
 * - `<<` merge keys, which the YAML parser does not resolve at all: it leaves a
 *   literal `<<` key, so the merged fields are invisible, `image` reads as null,
 *   and the failure is silent rather than loud.
 * - an interpolated image reference, because the deploy's rendered model has the
 *   substitution applied while this parse has the literal text, and asking a
 *   registry about the mangled reference fails as a retryable error that never
 *   stops.
 *
 * Refusing leaves the target `unresolved` and therefore `unverified`, which is
 * the honest state, and the projection already reports that as a limitation. The
 * cost is that a Blueprint using these constructs recovers its expectation only
 * through a redeploy.
 */
import { parse as parseYaml } from 'yaml';
import type { EffectiveServiceSpec } from '../effectiveServiceModel';

export function parseApprovedServiceSpecs(
  content: string,
): { specs: EffectiveServiceSpec[] } | { refusal: string } {
  let doc: { services?: unknown; include?: unknown } | null;
  try {
    doc = parseYaml(content) as { services?: unknown; include?: unknown } | null;
  } catch {
    return { refusal: 'the approved compose does not parse as YAML' };
  }
  if (doc?.include !== undefined && doc.include !== null) {
    return { refusal: 'the approved compose uses include, whose services the flat parse cannot see' };
  }
  const services = doc?.services;
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    return { refusal: 'the approved compose declares no services' };
  }

  const specs: EffectiveServiceSpec[] = [];
  for (const [name, raw] of Object.entries(services as Record<string, unknown>)) {
    const hazard = authoredServiceHazard(raw);
    if (hazard) return { refusal: `${hazard} (service ${name})` };
    specs.push(approvedServiceSpec(name, raw));
  }
  return { specs };
}

/**
 * The first construct on this service that makes the authored text an untrustworthy
 * stand-in for the rendered model, or null when the service is safe to use.
 *
 * `profiles` is checked here rather than in the caller so the refusal can name the
 * service, and `<<` is checked by key because the parser hands it back verbatim
 * instead of merging it.
 */
function authoredServiceHazard(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const svc = raw as Record<string, unknown>;
  if ('<<' in svc) {
    return 'the approved compose uses a merge key, which the YAML parse leaves unresolved';
  }
  if (typeof svc.image === 'string' && svc.image.includes('$')) {
    // Refused rather than resolved. The deploy's rendered model has the
    // substitution already applied; this parse has the literal text, and
    // `parseImageRef` does not reject it, so the registry would be asked about a
    // mangled reference. That fails as a retryable registry error, which means
    // the retry would never stop rather than never starting.
    return 'the approved compose interpolates an image reference, which the authored parse cannot resolve';
  }
  if (svc.profiles !== undefined && svc.profiles !== null) {
    return 'the approved compose gates a service on profiles, which the node does not activate when it renders';
  }
  if (svc.extends !== undefined && svc.extends !== null) {
    return 'the approved compose uses extends, which can import fields the service body does not show';
  }
  return null;
}

/**
 * Spec shape from *authored* YAML rather than from `docker compose config`
 * output, so the fields this needs are read with the same tolerance the
 * effective-model parser applies.
 *
 * Only `name`, `declaredImage` and `hasBuild` are consumed on this path; the
 * remaining fields are filled so the shape is complete rather than because the
 * resolver reads them.
 */
function approvedServiceSpec(name: string, raw: unknown): EffectiveServiceSpec {
  const svc = (raw ?? {}) as Record<string, unknown>;
  return {
    name,
    declaredImage: typeof svc.image === 'string' ? svc.image : null,
    hasBuild: svc.build !== undefined && svc.build !== null,
    expectedReplicas: 1,
    dependsOn: [],
    hasHealthcheck: false,
  };
}
