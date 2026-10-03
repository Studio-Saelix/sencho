import type { ObservedArtifactIdentity, ServiceArtifactEvidence } from './json';
import { canonicalPlatformLabel } from './platformNames';

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
 *
 * Labels are compared with the docker-info spellings canonicalized away on
 * both sides: a stored set and the platform a leaf reports can each predate
 * the translation, so linux/x86_64 and linux/amd64 must find the same child.
 */
export function approvedPlatformDigest(
  expected: ServiceArtifactEvidence,
  observedPlatform: string | null,
): string | null {
  if (expected.platformVariants && expected.platformVariants.length > 0) {
    if (!observedPlatform) return null;
    const observed = canonicalPlatformLabel(observedPlatform);
    const hit = expected.platformVariants.find(
      (variant) => canonicalPlatformLabel(variant.platform) === observed,
    );
    return hit?.digest ?? null;
  }
  return expected.platformDigest;
}

/** Child digests the expectation recorded, whether as its own or as variants. */
function expectedChildDigests(expected: ServiceArtifactEvidence): Set<string> {
  const out = new Set<string>();
  addDigest(out, expected.platformDigest);
  for (const variant of expected.platformVariants ?? []) addDigest(out, variant.digest);
  return out;
}

/**
 * True when the observation names no child of the expectation but does carry
 * the frozen index digest and declares a platform the expectation has a child
 * for.
 *
 * The containerd image store exposes only the index digest locally: the image
 * Id, RepoDigests and descriptor all carry it, so the platform child digest is
 * never visible. The child is still determined by the index and the platform,
 * which is what this proves. It cannot stand in for a wrong child: the fallback
 * requires that every other digest the observation recorded is a child of the
 * expectation, and the caller has already refused a wrong one.
 */
function observedIndexProvesChild(
  expected: ServiceArtifactEvidence,
  observed: ServiceArtifactEvidence,
  candidates: ReadonlySet<string>,
  childDigests: ReadonlySet<string>,
): boolean {
  if (!observed.platform) return false;
  const indexDigest = expected.indexDigest?.toLowerCase();
  if (!indexDigest || !candidates.has(indexDigest)) return false;
  for (const digest of candidates) {
    if (digest !== indexDigest && !childDigests.has(digest)) return false;
  }
  const observedPlatform = canonicalPlatformLabel(observed.platform);
  if (expected.platformVariants && expected.platformVariants.length > 0) {
    return expected.platformVariants.some(
      (variant) => canonicalPlatformLabel(variant.platform) === observedPlatform,
    );
  }
  return expected.platform !== null
    && canonicalPlatformLabel(expected.platform) === observedPlatform;
}

/**
 * True when every expected registry service is present in the observation and
 * that observation proves the target runs the expectation's child for the
 * platform it reports.
 *
 * The usual proof is the child digest itself. When the observation names no
 * child of the expected set, the frozen index digest together with the platform
 * the running image declares proves the same child, which is the strongest
 * proof a containerd-store node can give. An observation that does name a child
 * of the expected set must name the approved one; the index never stands in for
 * a wrong child.
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
    const childDigests = expectedChildDigests(expected);
    if ([...candidates].some((digest) => childDigests.has(digest))) return false;
    if (observedIndexProvesChild(expected, observed, candidates, childDigests)) continue;
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
