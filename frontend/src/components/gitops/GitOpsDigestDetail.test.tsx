import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GitOpsDigestDetail } from './GitOpsDigestDetail';
import { target } from '@/__tests__/gitopsFixtures';
import type {
  ArtifactFacet,
  ArtifactQualification,
  ObservedArtifactIdentity,
  ServiceArtifactEvidence,
} from '@/types/gitops';

const APPROVED = `sha256:${'a'.repeat(64)}`;
const RUNNING = `sha256:${'b'.repeat(64)}`;
const OTHER = `sha256:${'c'.repeat(64)}`;

function service(overrides: Partial<ServiceArtifactEvidence> = {}): ServiceArtifactEvidence {
  return {
    serviceName: 'web',
    authoredRef: 'nginx:alpine',
    source: 'registry',
    platform: 'linux/amd64',
    indexDigest: `sha256:${'1'.repeat(64)}`,
    platformDigest: APPROVED,
    platformVariants: null,
    localDigests: null,
    buildContextFingerprint: null,
    producedImageId: null,
    failureClass: null,
    resolvedAt: 1,
    ...overrides,
  };
}

function artifactWith(
  services?: ServiceArtifactEvidence[],
  qualification: ArtifactQualification = 'exact',
): ArtifactFacet {
  return {
    status: qualification === 'exact' ? 'artifact_exact' : 'artifact_qualified',
    artifactSetId: 'art-1',
    generationId: 'gen-accepted',
    evidenceVersion: 1,
    qualification,
    freshnessAt: 1,
    expected: {
      artifactSetId: 'art-1',
      evidenceVersion: 1,
      qualification,
      identity: `sha256:${'e'.repeat(64)}`,
      ...(services ? { services } : {}),
    },
    latestEvidence: {
      artifactSetId: 'art-1',
      evidenceVersion: 1,
      qualification,
      identity: `sha256:${'e'.repeat(64)}`,
    },
  };
}

function observed(services: ServiceArtifactEvidence[], kind: ObservedArtifactIdentity['kind'] = 'exact'): ObservedArtifactIdentity {
  return { kind, identity: `sha256:${'f'.repeat(64)}`, observedAt: 5, services } as ObservedArtifactIdentity;
}

const short = (digest: string) => digest.slice('sha256:'.length, 'sha256:'.length + 12);

describe('GitOpsDigestDetail', () => {
  it('names both digests and marks the service matched when they agree', () => {
    render(
      <GitOpsDigestDetail
        target={target({
          artifact: artifactWith([service()]),
          observedArtifactIdentity: observed([service({ platformDigest: APPROVED, localDigests: [APPROVED] })]),
        })}
      />,
    );
    const row = screen.getByTestId('gitops-digest-row');
    expect(row).toHaveAttribute('data-state', 'matched');
    expect(row).toHaveTextContent('matched');
    expect(row).toHaveTextContent('approved');
    expect(row).toHaveTextContent('running');
    expect(row).toHaveTextContent(short(APPROVED));
    // Both digests are on the row as full values in their tooltips.
    expect(row.querySelectorAll(`[title="${APPROVED}"]`)).toHaveLength(2);
    expect(screen.queryByText('unverified')).toBeNull();
  });

  it('marks the service drifted and shows the running digest when it differs', () => {
    render(
      <GitOpsDigestDetail
        target={target({
          artifact: artifactWith([service()]),
          observedArtifactIdentity: observed([service({ platformDigest: RUNNING, localDigests: [RUNNING] })]),
        })}
      />,
    );
    const row = screen.getByTestId('gitops-digest-row');
    expect(row).toHaveAttribute('data-state', 'drifted');
    expect(row).toHaveTextContent(short(APPROVED));
    expect(row).toHaveTextContent(short(RUNNING));
    expect(screen.getByText(/1 drifted/)).toBeInTheDocument();
  });

  it('accepts the index digest as a match when the platform child is not what is running', () => {
    render(
      <GitOpsDigestDetail
        target={target({
          artifact: artifactWith([service()]),
          observedArtifactIdentity: observed([service({ platformDigest: null, indexDigest: APPROVED })]),
        })}
      />,
    );
    expect(screen.getByTestId('gitops-digest-row')).toHaveAttribute('data-state', 'matched');
  });

  it('ignores values that are not content digests rather than comparing them', () => {
    render(
      <GitOpsDigestDetail
        target={target({
          artifact: artifactWith([service()]),
          observedArtifactIdentity: observed([service({ platformDigest: 'not-a-digest', indexDigest: null, localDigests: ['also-not-a-digest'] })]),
        })}
      />,
    );
    const row = screen.getByTestId('gitops-digest-row');
    expect(row).toHaveAttribute('data-state', 'unverified');
    expect(row).toHaveTextContent('no digest was recorded for this service');
  });

  it('matches a locally observed candidate without a registry digest', () => {
    render(
      <GitOpsDigestDetail
        target={target({
          artifact: artifactWith([service()]),
          observedArtifactIdentity: observed([service({ platformDigest: null, indexDigest: null, localDigests: [RUNNING] })]),
        })}
      />,
    );
    expect(screen.getByTestId('gitops-digest-row')).toHaveAttribute('data-state', 'drifted');
  });

  it('compares digests without regard to case', () => {
    const upper = `sha256:${'A'.repeat(64)}`;
    render(
      <GitOpsDigestDetail
        target={target({
          artifact: artifactWith([service({ platformDigest: upper })]),
          observedArtifactIdentity: observed([service({ platformDigest: upper.toLowerCase(), localDigests: null })]),
        })}
      />,
    );
    expect(screen.getByTestId('gitops-digest-row')).toHaveAttribute('data-state', 'matched');
  });

  it('accepts qualified evidence on both sides', () => {
    render(
      <GitOpsDigestDetail
        target={target({
          artifact: artifactWith([service()], 'qualified'),
          observedArtifactIdentity: observed([service({ platformDigest: APPROVED, localDigests: [APPROVED] })], 'qualified'),
        })}
      />,
    );
    expect(screen.getByTestId('gitops-digest-row')).toHaveAttribute('data-state', 'matched');
  });

  it('refuses to match when the node reported no platform for a multi-platform image', () => {
    render(
      <GitOpsDigestDetail
        target={target({
          artifact: artifactWith([service({
            platformVariants: [{ platform: 'linux/amd64', digest: APPROVED }],
          })]),
          observedArtifactIdentity: observed([service({ platform: null, platformDigest: APPROVED, localDigests: [APPROVED] })]),
        })}
      />,
    );
    const row = screen.getByTestId('gitops-digest-row');
    expect(row).toHaveAttribute('data-state', 'unverified');
    expect(row).toHaveTextContent('no approved digest for this platform');
  });

  it('compares against the child for the platform the node runs, not another one', () => {
    render(
      <GitOpsDigestDetail
        target={target({
          artifact: artifactWith([service({
            platformVariants: [
              { platform: 'linux/amd64', digest: APPROVED },
              { platform: 'linux/arm64', digest: OTHER },
            ],
          })]),
          observedArtifactIdentity: observed([service({ platform: 'linux/arm64', platformDigest: OTHER, localDigests: [OTHER] })]),
        })}
      />,
    );
    const row = screen.getByTestId('gitops-digest-row');
    expect(row).toHaveAttribute('data-state', 'matched');
    expect(row).toHaveTextContent('linux/arm64');
  });

  it('says unverified rather than showing an empty comparison when nothing was observed', () => {
    render(
      <GitOpsDigestDetail
        target={target({ artifact: artifactWith([service()]), observedArtifactIdentity: { kind: 'unknown' } })}
      />,
    );
    const row = screen.getByTestId('gitops-digest-row');
    expect(row).toHaveAttribute('data-state', 'unverified');
    expect(row).toHaveTextContent('this node recorded no per-service digests');
    expect(row).not.toHaveTextContent('approved');
  });

  it('says unverified when the observation is not a comparable kind', () => {
    render(
      <GitOpsDigestDetail
        target={target({
          artifact: artifactWith([service()]),
          observedArtifactIdentity: observed([service({ platformDigest: APPROVED, localDigests: [APPROVED] })], 'stale'),
        })}
      />,
    );
    const row = screen.getByTestId('gitops-digest-row');
    expect(row).toHaveAttribute('data-state', 'unverified');
    expect(row).toHaveTextContent('this node reported nothing comparable for the service');
  });

  it('says unverified when the approved identity is not qualified enough to compare', () => {
    render(
      <GitOpsDigestDetail
        target={target({
          artifact: artifactWith([service()], 'stale'),
          observedArtifactIdentity: observed([service({ platformDigest: APPROVED, localDigests: [APPROVED] })]),
        })}
      />,
    );
    expect(screen.getByTestId('gitops-digest-row')).toHaveTextContent(
      'the approved identity is not qualified enough to compare',
    );
  });

  it('says the approved set records no per-service digests', () => {
    render(
      <GitOpsDigestDetail
        target={target({
          artifact: artifactWith(),
          observedArtifactIdentity: observed([service({ platformDigest: RUNNING, localDigests: [RUNNING] })]),
        })}
      />,
    );
    expect(screen.getByTestId('gitops-digest-row')).toHaveTextContent(
      'the approved artifact set records no per-service digests',
    );
  });

  it('renders nothing when neither side recorded per-service evidence', () => {
    const { container } = render(
      <GitOpsDigestDetail
        target={target({
          artifact: artifactWith(),
          observedArtifactIdentity: { kind: 'exact', identity: 'sha256:whatever', observedAt: 5 },
        })}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('does not call a running service outside the approved set a divergence', () => {
    render(
      <GitOpsDigestDetail
        target={target({
          artifact: artifactWith([service()]),
          observedArtifactIdentity: observed([
            service(),
            service({ serviceName: 'sidecar', authoredRef: 'redis:alpine', platformDigest: RUNNING, localDigests: [RUNNING] }),
          ]),
        })}
      />,
    );
    const rows = screen.getAllByTestId('gitops-digest-row');
    expect(rows).toHaveLength(2);
    const sidecar = rows.find((row) => row.textContent?.includes('sidecar'));
    expect(sidecar).toHaveAttribute('data-state', 'not_compared');
    expect(sidecar).toHaveTextContent('running service is not in the approved set');
  });

  it('does not claim a digest for a built image', () => {
    render(
      <GitOpsDigestDetail
        target={target({
          artifact: artifactWith([service({ source: 'build', platformDigest: null, indexDigest: null })]),
          observedArtifactIdentity: observed([service({ source: 'build', platformDigest: null, localDigests: null })]),
        })}
      />,
    );
    const row = screen.getByTestId('gitops-digest-row');
    expect(row).toHaveAttribute('data-state', 'not_compared');
    expect(row).toHaveTextContent('built on this node, so there is no published digest to compare');
    expect(row).not.toHaveTextContent('approved');
    expect(row).not.toHaveTextContent('running');
  });

  it('does not claim a digest for a registry it cannot compare', () => {
    render(
      <GitOpsDigestDetail
        target={target({
          artifact: artifactWith([service({ source: 'unsupported', platformDigest: null, indexDigest: null })]),
          observedArtifactIdentity: observed([service({ source: 'unsupported', platformDigest: null, localDigests: null })]),
        })}
      />,
    );
    const row = screen.getByTestId('gitops-digest-row');
    expect(row).toHaveAttribute('data-state', 'not_compared');
    expect(row).toHaveTextContent('this registry is not one Sencho can compare');
  });

  it('says unverified when the service was not seen in the observation at all', () => {
    render(
      <GitOpsDigestDetail
        target={target({
          artifact: artifactWith([service(), service({ serviceName: 'api', authoredRef: 'api:1' })]),
          observedArtifactIdentity: observed([service()]),
        })}
      />,
    );
    const api = screen.getAllByTestId('gitops-digest-row').find((row) => row.textContent?.includes('api'));
    expect(api).toHaveAttribute('data-state', 'unverified');
    expect(api).toHaveTextContent('this node reported nothing comparable for the service');
  });
});
