import type { ObservedArtifactIdentity, ServiceArtifactEvidence } from './json';

const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/i;

function addDigest(into: Set<string>, digest: string | null | undefined): void {
  if (digest && SHA256_DIGEST_RE.test(digest)) into.add(digest.toLowerCase());
}

/** Every usable digest recorded on an observation (candidates, not a single slot). */
export function observedCandidateDigests(service: ServiceArtifactEvidence): Set<string> {
  const out = new Set<string>();
  addDigest(out, service.platformDigest);
  addDigest(out, service.indexDigest);
  for (const digest of service.localDigests ?? []) addDigest(out, digest);
  return out;
}

/**
 * The approved child digest for this target's platform.
 * When freeze recorded platformVariants, a missing or unknown platform is
 * not a match: do not fall back to another architecture's child.
 */
export function approvedPlatformDigest(
  expected: ServiceArtifactEvidence,
  observedPlatform: string | null,
): string | null {
  if (expected.platformVariants && expected.platformVariants.length > 0) {
    if (!observedPlatform) return null;
    const hit = expected.platformVariants.find((variant) => variant.platform === observedPlatform);
    return hit?.digest ?? null;
  }
  return expected.platformDigest;
}

/**
 * True when every expected registry service is present in the observation and
 * at least one observed candidate equals that target's approved platform child.
 * The frozen index digest is not sufficient on its own.
 */
export function observationMatchesExpected(
  expectedServices: readonly ServiceArtifactEvidence[],
  observedServices: readonly ServiceArtifactEvidence[],
): boolean {
  if (expectedServices.length === 0 || observedServices.length === 0) return false;
  const observedByName = new Map(observedServices.map((service) => [service.serviceName, service]));
  for (const expected of expectedServices) {
    if (expected.source !== 'registry') continue;
    const observed = observedByName.get(expected.serviceName);
    if (!observed) return false;
    const candidates = observedCandidateDigests(observed);
    if (candidates.size === 0) return false;
    const approved = approvedPlatformDigest(expected, observed.platform);
    if (approved && candidates.has(approved.toLowerCase())) continue;
    return false;
  }
  return true;
}

export function comparableObservationMatches(
  expectedServices: readonly ServiceArtifactEvidence[] | undefined,
  observed: ObservedArtifactIdentity,
): boolean {
  if (observed.kind !== 'exact' && observed.kind !== 'qualified') return false;
  if (!expectedServices?.length || !observed.services?.length) return false;
  return observationMatchesExpected(expectedServices, observed.services);
}
