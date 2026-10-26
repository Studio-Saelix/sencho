import { describe, expect, it } from 'vitest';
import {
  digestPinsMatchServiceNames,
  digestPinsOverlayYaml,
  isDigestPinValue,
  isDigestPinsMap,
  toDigestImageRef,
} from '../services/gitops/digestPins';
import {
  approvedPlatformDigest,
  observationMatchesExpected,
} from '../services/gitops/artifactIdentity';
import {
  decodeArtifactEvidenceJson,
  encodeArtifactEvidenceJson,
  type ServiceArtifactEvidence,
} from '../services/gitops/json';

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const DIGEST_C = `sha256:${'c'.repeat(64)}`;
const INDEX = `sha256:${'1'.repeat(64)}`;

function registryService(partial: Partial<ServiceArtifactEvidence> & Pick<ServiceArtifactEvidence, 'platformDigest'>): ServiceArtifactEvidence {
  return {
    serviceName: 'web',
    authoredRef: 'nginx:latest',
    source: 'registry',
    platform: 'linux/amd64',
    indexDigest: INDEX,
    buildContextFingerprint: null,
    producedImageId: null,
    failureClass: null,
    resolvedAt: 1,
    ...partial,
  };
}

describe('digestPins', () => {
  it('strips tags and digests when building a pin ref', () => {
    expect(toDigestImageRef('nginx:1.27', DIGEST_A)).toBe(`nginx@${DIGEST_A}`);
    expect(toDigestImageRef('ghcr.io/org/app:v1', DIGEST_B)).toBe(`ghcr.io/org/app@${DIGEST_B}`);
    expect(toDigestImageRef(`nginx@${DIGEST_A}`, DIGEST_C)).toBe(`nginx@${DIGEST_C}`);
    expect(toDigestImageRef('nginx', 'not-a-digest')).toBeNull();
    expect(toDigestImageRef('nginx', 'sha256:abc')).toBeNull();
  });

  it('validates digest pin shape', () => {
    expect(isDigestPinValue(`nginx@${DIGEST_A}`)).toBe(true);
    expect(isDigestPinValue('nginx@sha256:')).toBe(false);
    expect(isDigestPinValue('nginx@sha256:not-hex')).toBe(false);
    expect(isDigestPinsMap({ web: `nginx@${DIGEST_A}` })).toBe(true);
    expect(isDigestPinsMap({ web: 'nginx@sha256:short' })).toBe(false);
    expect(isDigestPinsMap({})).toBe(false);
  });

  it('renders a compose overlay that pins images without touching authored files', () => {
    const yaml = digestPinsOverlayYaml({
      web: `nginx@${DIGEST_A}`,
      api: `ghcr.io/org/api@${DIGEST_B}`,
    });
    expect(yaml).toContain('services:');
    expect(yaml).toContain('"api":');
    expect(yaml).toContain(`image: "ghcr.io/org/api@${DIGEST_B}"`);
    expect(yaml).toContain('"web":');
    expect(yaml).toContain(`image: "nginx@${DIGEST_A}"`);
  });

  it('matches pin keys against the rendered multi-file service set', () => {
    const pins = {
      web: `nginx@${DIGEST_A}`,
      worker: `busybox@${DIGEST_B}`,
    };
    // Git-managed multi-file / override merge: only the rendered names matter.
    expect(digestPinsMatchServiceNames(pins, ['web', 'worker'])).toBe(true);
    expect(digestPinsMatchServiceNames(pins, ['web'])).toBe(false);
    expect(digestPinsMatchServiceNames(pins, [])).toBe(false);
    expect(digestPinsMatchServiceNames(
      { ghost: `nginx@${DIGEST_A}` },
      ['web', 'worker'],
    )).toBe(false);
  });
});

describe('artifact identity membership', () => {
  it('matches mixed platforms against each target\'s approved child digest', () => {
    const expected = registryService({
      platformDigest: DIGEST_A,
      platformVariants: [
        { platform: 'linux/amd64', digest: DIGEST_A },
        { platform: 'linux/arm64', digest: DIGEST_B },
      ],
    });
    const amd64 = registryService({
      platform: 'linux/amd64',
      platformDigest: DIGEST_A,
      localDigests: [DIGEST_A],
      platformVariants: null,
    });
    const arm64 = registryService({
      platform: 'linux/arm64',
      platformDigest: DIGEST_B,
      localDigests: [DIGEST_B],
      platformVariants: null,
    });
    expect(observationMatchesExpected([expected], [amd64])).toBe(true);
    expect(observationMatchesExpected([expected], [arm64])).toBe(true);
    expect(approvedPlatformDigest(expected, 'linux/arm64')).toBe(DIGEST_B);
  });

  it('matches when RepoDigests lists an index digest ahead of the platform child', () => {
    const expected = registryService({
      platformDigest: DIGEST_A,
      platformVariants: [{ platform: 'linux/amd64', digest: DIGEST_A }],
    });
    const observed = registryService({
      platformDigest: INDEX,
      indexDigest: null,
      localDigests: [INDEX, DIGEST_A],
      platformVariants: null,
    });
    expect(observationMatchesExpected([expected], [observed])).toBe(true);
  });

  it('does not match a different platform child even when the index digest is present', () => {
    const expected = registryService({
      platformDigest: DIGEST_A,
      platformVariants: [
        { platform: 'linux/amd64', digest: DIGEST_A },
        { platform: 'linux/arm64', digest: DIGEST_B },
      ],
    });
    const observed = registryService({
      platform: 'linux/amd64',
      platformDigest: DIGEST_B,
      indexDigest: INDEX,
      localDigests: [INDEX, DIGEST_B],
      platformVariants: null,
    });
    expect(observationMatchesExpected([expected], [observed])).toBe(false);
  });

  it('matches a stored set that recorded the pre-normalization docker-info spelling', () => {
    const legacyRaw = encodeArtifactEvidenceJson({
      kind: 'qualified',
      identity: INDEX,
      services: [registryService({
        platform: 'linux/x86_64',
        platformDigest: DIGEST_A,
        platformVariants: [{ platform: 'linux/x86_64', digest: DIGEST_A }],
      })],
    });
    const expected = decodeArtifactEvidenceJson(legacyRaw).services![0];
    const observed = registryService({
      platform: 'linux/amd64',
      platformDigest: DIGEST_A,
      localDigests: [DIGEST_A],
      platformVariants: null,
    });
    expect(approvedPlatformDigest(expected, 'linux/amd64')).toBe(DIGEST_A);
    expect(observationMatchesExpected([expected], [observed])).toBe(true);
  });

  it('matches an index-only observation when the local store exposes no platform child', () => {
    // The containerd image store reports the index digest as the image Id and
    // in RepoDigests, so the platform child digest is not visible locally.
    const expected = registryService({
      platformDigest: DIGEST_A,
      indexDigest: INDEX,
      platformVariants: [
        { platform: 'linux/amd64', digest: DIGEST_A },
        { platform: 'linux/arm64', digest: DIGEST_B },
      ],
    });
    const observed = registryService({
      platform: 'linux/amd64',
      platformDigest: INDEX,
      indexDigest: null,
      localDigests: [INDEX],
      platformVariants: null,
    });
    expect(observationMatchesExpected([expected], [observed])).toBe(true);
  });

  it('does not match an index-only observation that runs a different index', () => {
    const expected = registryService({
      platformDigest: DIGEST_A,
      indexDigest: INDEX,
      platformVariants: [{ platform: 'linux/amd64', digest: DIGEST_A }],
    });
    const observed = registryService({
      platform: 'linux/amd64',
      platformDigest: DIGEST_C,
      indexDigest: null,
      localDigests: [DIGEST_C],
      platformVariants: null,
    });
    expect(observationMatchesExpected([expected], [observed])).toBe(false);
  });

  it('does not match an index-only observation for a platform the set does not name', () => {
    const expected = registryService({
      platformDigest: DIGEST_B,
      indexDigest: INDEX,
      platformVariants: [{ platform: 'linux/arm64', digest: DIGEST_B }],
    });
    const observed = registryService({
      platform: 'linux/amd64',
      platformDigest: INDEX,
      indexDigest: null,
      localDigests: [INDEX],
      platformVariants: null,
    });
    expect(observationMatchesExpected([expected], [observed])).toBe(false);
  });

  it('does not match when the observation records a different local digest beside the index', () => {
    const expected = registryService({
      platformDigest: DIGEST_A,
      indexDigest: INDEX,
      platformVariants: [{ platform: 'linux/amd64', digest: DIGEST_A }],
    });
    const observed = registryService({
      platform: 'linux/amd64',
      platformDigest: DIGEST_C,
      indexDigest: INDEX,
      localDigests: [DIGEST_C],
      platformVariants: null,
    });
    expect(observationMatchesExpected([expected], [observed])).toBe(false);
  });

  it('does not match an index-only observation with no observed platform', () => {
    const expected = registryService({
      platformDigest: DIGEST_A,
      indexDigest: INDEX,
      platformVariants: [{ platform: 'linux/amd64', digest: DIGEST_A }],
    });
    const observed = registryService({
      platform: null,
      platformDigest: INDEX,
      indexDigest: null,
      localDigests: [INDEX],
      platformVariants: null,
    });
    expect(observationMatchesExpected([expected], [observed])).toBe(false);
  });

  it('matches a digest-pinned observation by the pinned digest', () => {
    const expected = registryService({
      platformDigest: DIGEST_A,
      indexDigest: DIGEST_A,
      platformVariants: null,
    });
    const observed = registryService({
      platform: 'linux/amd64',
      platformDigest: DIGEST_A,
      indexDigest: null,
      localDigests: [DIGEST_A],
      platformVariants: null,
    });
    expect(observationMatchesExpected([expected], [observed])).toBe(true);
  });
});
