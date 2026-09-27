import type { ReactNode } from 'react';
import { formatShortDigest } from '@/lib/formatDigest';
import type {
  ArtifactExpectedIdentity,
  GitOpsTargetProjection,
  ObservedArtifactIdentity,
  ServiceArtifactEvidence,
} from '@/types/gitops';

type DigestState = 'matched' | 'drifted' | 'unverified' | 'not_compared';

interface DigestRow {
  serviceName: string;
  authoredRef: string | null;
  platform: string | null;
  state: DigestState;
  expected: string | null;
  observed: string | null;
  note: string | null;
}

const STATE_TONE: Record<DigestState, string> = {
  matched: 'text-success',
  drifted: 'text-warning',
  unverified: 'text-stat-subtitle',
  not_compared: 'text-stat-subtitle',
};

const STATE_LABEL: Record<DigestState, string> = {
  matched: 'matched',
  drifted: 'drifted',
  unverified: 'unverified',
  not_compared: 'not compared',
};

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/i;

/** Only these two qualifications are proof of a specific executable identity. */
function comparableQualification(qualification: ArtifactExpectedIdentity['qualification']): boolean {
  return qualification === 'exact' || qualification === 'qualified';
}

/** The observation kinds that carry a comparable identity rather than a caveat. */
function comparableObservation(kind: ObservedArtifactIdentity['kind']): boolean {
  return kind === 'exact' || kind === 'qualified';
}

/**
 * The digest a service is approved at, for the platform the node runs. A
 * multi-platform image records one frozen child per platform, and a node only
 * ever proves its own child, so a child for another platform is not a match.
 */
function approvedDigest(service: ServiceArtifactEvidence, observedPlatform: string | null): string | null {
  const variants = service.platformVariants;
  if (variants && variants.length > 0) {
    if (!observedPlatform) return null;
    return variants.find((variant) => variant.platform === observedPlatform)?.digest ?? null;
  }
  return service.platformDigest;
}

/**
 * Every usable digest the observation recorded for a service on this node, the
 * same candidate set the model compares: the platform child, the index digest,
 * and any local candidates. Anything that is not a content digest is ignored
 * rather than treated as evidence.
 */
function observedCandidates(service: ServiceArtifactEvidence): string[] {
  const candidates: (string | null)[] = [service.platformDigest, service.indexDigest, ...(service.localDigests ?? [])];
  const usable = candidates.filter(
    (digest): digest is string => digest !== null && SHA256_DIGEST.test(digest),
  );
  return [...new Set(usable)];
}

function digestCell(digest: string | null): ReactNode {
  if (!digest) return <span className="text-stat-icon">none</span>;
  return <span title={digest} className="break-all">{formatShortDigest(digest)}</span>;
}

function rowFor(
  expected: ServiceArtifactEvidence,
  expectedQualification: ArtifactExpectedIdentity['qualification'],
  observed: ServiceArtifactEvidence | undefined,
  observedKind: ObservedArtifactIdentity['kind'],
): DigestRow {
  // The approved child is chosen from the platform the node reported, never from
  // the platform the approval was frozen on: an observation with no platform
  // proves no child, and the model refuses to match it.
  const observedPlatform = observed?.platform ?? null;
  const base = {
    serviceName: expected.serviceName,
    authoredRef: expected.authoredRef,
    platform: observedPlatform ?? expected.platform ?? null,
  };
  if (expected.source !== 'registry') {
    // The model does not compare a service it cannot pin to a published
    // digest, so this must not read as agreement or as a divergence.
    return {
      ...base,
      state: 'not_compared',
      expected: null,
      observed: null,
      note: expected.source === 'build'
        ? 'built on this node, so there is no published digest to compare'
        : 'this registry is not one Sencho can compare, so no digest is compared',
    };
  }
  const approved = approvedDigest(expected, observedPlatform);
  if (!comparableQualification(expectedQualification)) {
    return { ...base, state: 'unverified', expected: null, observed: null, note: 'the approved identity is not qualified enough to compare' };
  }
  if (!approved) {
    return { ...base, state: 'unverified', expected: null, observed: null, note: 'no approved digest for this platform' };
  }
  if (!observed || !comparableObservation(observedKind)) {
    return { ...base, state: 'unverified', expected: approved, observed: null, note: 'this node reported nothing comparable for the service' };
  }
  const candidates = observedCandidates(observed);
  if (candidates.length === 0) {
    return { ...base, state: 'unverified', expected: approved, observed: null, note: 'no digest was recorded for this service' };
  }
  const match = candidates.find((digest) => digest.toLowerCase() === approved.toLowerCase());
  return {
    ...base,
    state: match ? 'matched' : 'drifted',
    expected: approved,
    observed: match ?? candidates[0],
    note: null,
  };
}

function rowsFor(target: GitOpsTargetProjection): DigestRow[] | null {
  const facet = target.artifact;
  const expectedIdentity = facet.status !== 'not_applicable' ? facet.expected : null;
  const expected = expectedIdentity?.services;
  const observedIdentity = target.observedArtifactIdentity;
  const observed = 'services' in observedIdentity ? observedIdentity.services : undefined;
  if (!expected?.length && !observed?.length) return null;
  if (!expected?.length) {
    return [{
      serviceName: 'all services',
      authoredRef: null,
      platform: null,
      state: 'unverified',
      expected: null,
      observed: null,
      note: 'the approved artifact set records no per-service digests',
    }];
  }
  if (!observed?.length) {
    return [{
      serviceName: 'all services',
      authoredRef: null,
      platform: null,
      state: 'unverified',
      expected: null,
      observed: null,
      note: 'this node recorded no per-service digests',
    }];
  }
  const qualification = expectedIdentity?.qualification ?? 'unavailable';
  const observedByName = new Map(observed.map((service) => [service.serviceName, service]));
  const names = new Set([...expected.map((service) => service.serviceName), ...observed.map((service) => service.serviceName)]);
  return [...names].sort().map((name) => {
    const expectedService = expected.find((service) => service.serviceName === name);
    if (expectedService) {
      return rowFor(expectedService, qualification, observedByName.get(name), observedIdentity.kind);
    }
    // Running something the approved set does not name is outside the
    // comparison the model makes, so it is not called a divergence here either.
    const running = observedByName.get(name);
    return {
      serviceName: name,
      authoredRef: running?.authoredRef ?? null,
      platform: running?.platform ?? null,
      state: 'not_compared' as const,
      expected: null,
      observed: running?.platformDigest ?? null,
      note: 'running service is not in the approved set, so Sencho does not compare it',
    };
  });
}

/**
 * Per-service digest comparison for one target, approved against running.
 *
 * Presentation only, and deliberately silent where evidence is missing: a target
 * whose approved set or whose observation carries no per-service digests says so
 * instead of rendering an empty comparison that reads as agreement, and a
 * service the model does not compare is labelled as not compared rather than as
 * matched or drifted. Shared by the stack Drift tab and the GitOps application
 * view so one target's digests never read two different ways.
 */
export function GitOpsDigestDetail({ target }: { target: GitOpsTargetProjection }) {
  const rows = rowsFor(target);
  if (!rows) return null;
  const drifted = rows.filter((row) => row.state === 'drifted').length;
  return (
    <div data-testid="gitops-digest-detail" className="mt-1.5 min-w-0 border-t border-muted pt-1.5">
      <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
        <span>digests</span>
        {drifted > 0 && <span className="normal-case tracking-normal text-warning">{drifted} drifted</span>}
      </div>
      <div className="mt-1 flex min-w-0 flex-col gap-1">
        {rows.map((row) => (
          <div key={row.serviceName} data-testid="gitops-digest-row" data-state={row.state} className="min-w-0 max-w-full font-mono text-[10px] leading-relaxed max-md:break-all">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="min-w-0 max-w-full break-all rounded-md bg-brand/15 px-1.5 py-0.5 text-brand max-md:break-all">{row.serviceName}</span>
              {row.authoredRef && <span className="min-w-0 break-all text-stat-subtitle">{row.authoredRef}</span>}
              {row.platform && <span className="text-stat-subtitle">{row.platform}</span>}
              <span className={STATE_TONE[row.state]}>{STATE_LABEL[row.state]}</span>
            </div>
            {(row.state === 'matched' || row.state === 'drifted') && (
              <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-foreground/85">
                <span className="text-stat-subtitle">approved</span>
                {digestCell(row.expected)}
                <span className="text-stat-subtitle">running</span>
                <span className="font-semibold text-foreground">{digestCell(row.observed)}</span>
              </div>
            )}
            {row.note && <div className="mt-0.5 text-stat-subtitle">{row.note}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
