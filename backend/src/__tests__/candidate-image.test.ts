/**
 * Candidate image resolution: what image an update will actually install.
 *
 * The resolver is pure apart from its injected registry, credentials and platform
 * readers, so these cover the decisions that matter without a daemon, a registry
 * or a scan: a digest pin needs no registry call, a multi-arch index resolves to
 * this node's child, and every failure lands in the shared artifact-failure
 * vocabulary rather than a new one.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  effectiveServicePlatform,
  isLatestImageTag,
  pullPolicyPullsOnUp,
  pullPolicyRefreshAfterMs,
  pullPolicyRefreshDue,
  resolveCandidateImage,
  type CandidateDeps,
} from '../services/candidateImage';

const PLATFORM = { os: 'linux', architecture: 'amd64' };
const INDEX = `sha256:${'a'.repeat(64)}`;
const AMD64 = `sha256:${'b'.repeat(64)}`;
const ARM64 = `sha256:${'c'.repeat(64)}`;

function deps(overrides: Partial<CandidateDeps> = {}): CandidateDeps {
  return {
    readPlatform: async () => PLATFORM,
    getAuth: async () => null,
    resolveDigest: async () => ({
      ok: true,
      indexDigest: INDEX,
      platformDigest: AMD64,
      platformLabel: 'linux/amd64',
      qualification: 'qualified',
      platformVariants: [
        { platform: 'linux/amd64', digest: AMD64 },
        { platform: 'linux/arm64', digest: ARM64 },
      ],
    }),
    ...overrides,
  };
}

describe('resolveCandidateImage', () => {
  it('treats a digest-pinned reference as the candidate itself, with no registry call', async () => {
    const resolveDigest = vi.fn().mockResolvedValue({ ok: false, reason: 'must not be called' });
    const result = await resolveCandidateImage(
      1,
      `registry.example.com/app@${AMD64}`,
      PLATFORM,
      deps({ resolveDigest }),
    );
    expect(result).toEqual({ kind: 'installed', ref: `registry.example.com/app@${AMD64}`, why: 'digest_pinned' });
    expect(resolveDigest).not.toHaveBeenCalled();
  });

  it('scans the platform child of a multi-arch index, not the index itself', async () => {
    const result = await resolveCandidateImage(1, 'registry.example.com/app:latest', PLATFORM, deps());
    expect(result).toMatchObject({
      kind: 'candidate',
      indexDigest: INDEX,
      platformDigest: AMD64,
      platform: 'linux/amd64',
      qualification: 'qualified',
      // Repository form: a tag would resolve to the index, and an index is not a
      // scannable image.
      scanRef: `registry.example.com/app@${AMD64}`,
    });
  });

  it('names the requested variant in the candidate platform label', async () => {
    const result = await resolveCandidateImage(
      1,
      'registry.example.com/app:1',
      { os: 'linux', architecture: 'arm', variant: 'v7' },
      deps({
        resolveDigest: async () => ({
          ok: true,
          indexDigest: INDEX,
          platformDigest: AMD64,
          platformLabel: 'linux/arm',
          qualification: 'qualified',
        }),
      }),
    );
    expect(result).toMatchObject({ kind: 'candidate', platform: 'linux/arm/v7' });
  });

  it('passes the node platform and the registry credentials to the resolver', async () => {
    const resolveDigest = vi.fn().mockResolvedValue({
      ok: true,
      indexDigest: INDEX,
      platformDigest: AMD64,
      platformLabel: 'linux/amd64',
      qualification: 'exact',
    });
    const getAuth = vi.fn().mockResolvedValue({ username: 'u', password: 'p' });
    await resolveCandidateImage(1, 'registry.example.com/app:1.2.3', PLATFORM, deps({ resolveDigest, getAuth }));
    expect(getAuth).toHaveBeenCalledWith('registry.example.com');
    expect(resolveDigest).toHaveBeenCalledWith(
      'registry.example.com', 'app', '1.2.3', PLATFORM, { username: 'u', password: 'p' },
    );
  });

  it('reports an unknown platform as indeterminate rather than guessing a child', async () => {
    const result = await resolveCandidateImage(1, 'app:latest', null, deps());
    expect(result).toMatchObject({
      kind: 'unresolved',
      state: 'unknown',
      failureClass: 'platform_ambiguity',
    });
  });

  it('maps a rejected credential to the unavailable state and the credential failure class', async () => {
    const result = await resolveCandidateImage(
      1,
      'registry.example.com/app:1',
      PLATFORM,
      deps({
        getAuth: async () => { throw new Error('registry credentials could not be decrypted'); },
      }),
    );
    expect(result).toMatchObject({ kind: 'unresolved', state: 'unavailable', failureClass: 'credential_failure' });
    expect((result as { reason: string }).reason).toContain('credentials');
  });

  it('maps a registry authorization failure to unavailable, and keeps the reason', async () => {
    const result = await resolveCandidateImage(
      1,
      'registry.example.com/private/app:1',
      PLATFORM,
      deps({ resolveDigest: async () => ({ ok: false, reason: 'Registry rejected credentials (401)' }) }),
    );
    expect(result).toMatchObject({ kind: 'unresolved', state: 'unavailable', failureClass: 'credential_failure' });
    expect((result as { reason: string }).reason).toContain('Registry rejected credentials');
  });

  it('maps an ambiguous index to the indeterminate state', async () => {
    const result = await resolveCandidateImage(
      1,
      'app:latest',
      PLATFORM,
      deps({ resolveDigest: async () => ({ ok: false, reason: 'Remote image index has ambiguous platform-less descriptors for app:latest' }) }),
    );
    expect(result).toMatchObject({ kind: 'unresolved', state: 'unknown', failureClass: 'platform_ambiguity' });
  });

  it('reports an image id with no repository form as unsupported', async () => {
    const resolveDigest = vi.fn();
    const result = await resolveCandidateImage(1, INDEX, PLATFORM, deps({ resolveDigest }));
    expect(result).toMatchObject({ kind: 'unresolved', state: 'unsupported', failureClass: 'unsupported_registry' });
    expect(resolveDigest).not.toHaveBeenCalled();
  });
});

describe('effectiveServicePlatform', () => {
  it('uses the service override instead of the node platform', () => {
    expect(effectiveServicePlatform('linux/amd64', { os: 'linux', architecture: 'arm64' }))
      .toEqual({ ok: true, platform: { os: 'linux', architecture: 'amd64' } });
  });

  it('canonicalizes a docker-info architecture and accepts a bare architecture', () => {
    expect(effectiveServicePlatform('linux/x86_64', PLATFORM))
      .toEqual({ ok: true, platform: { os: 'linux', architecture: 'amd64' } });
    expect(effectiveServicePlatform('arm64', PLATFORM))
      .toEqual({ ok: true, platform: { os: 'linux', architecture: 'arm64' } });
    // A lone OS name means that OS at the node's architecture, as Compose reads it.
    expect(effectiveServicePlatform('linux', PLATFORM))
      .toEqual({ ok: true, platform: { os: 'linux', architecture: 'amd64' } });
    expect(effectiveServicePlatform('linux/arm64/v8', PLATFORM))
      .toEqual({ ok: true, platform: { os: 'linux', architecture: 'arm64', variant: 'v8' } });
  });

  it('keeps a variant segment, because two variants are different children', () => {
    expect(effectiveServicePlatform('linux/arm/v7', PLATFORM))
      .toEqual({ ok: true, platform: { os: 'linux', architecture: 'arm', variant: 'v7' } });
    expect(effectiveServicePlatform('linux/arm/v6', PLATFORM))
      .not.toEqual(effectiveServicePlatform('linux/arm/v7', PLATFORM));
  });

  it('falls back to the node platform when the service declares none', () => {
    expect(effectiveServicePlatform(null, PLATFORM)).toEqual({ ok: true, platform: PLATFORM });
    expect(effectiveServicePlatform('  ', PLATFORM)).toEqual({ ok: true, platform: PLATFORM });
  });

  it('rejects an override it cannot read instead of falling back to the node', () => {
    expect(effectiveServicePlatform('linux/amd64/arm/v7/extra', PLATFORM).ok).toBe(false);
    expect(effectiveServicePlatform('/', PLATFORM).ok).toBe(false);
  });
});

describe('pullPolicyPullsOnUp', () => {
  it('is true for every Compose policy that can fetch a present image', () => {
    for (const policy of ['always', 'refresh', 'daily', 'weekly', 'every_12h', 'every_5m', 'EVERY_1H', 'ALWAYS']) {
      expect(pullPolicyPullsOnUp(policy)).toBe(true);
    }
  });

  it('is false only for the policies that never fetch a present image', () => {
    for (const policy of [null, undefined, 'missing', 'build', 'never', '']) {
      expect(pullPolicyPullsOnUp(policy)).toBe(false);
    }
  });

  it('treats an unrecognised policy as pulling, never as safe to skip', () => {
    // A policy this build does not know could still fetch on a newer Compose;
    // reading it as "will not pull" would let that image pass unexamined.
    expect(pullPolicyPullsOnUp('sometimes')).toBe(true);
  });
});

describe('pull policy intervals', () => {
  it('parses the windows Compose compares against the image last tag time', () => {
    expect(pullPolicyRefreshAfterMs('refresh')).toBe(0);
    expect(pullPolicyRefreshAfterMs('daily')).toBe(24 * 60 * 60 * 1000);
    expect(pullPolicyRefreshAfterMs('weekly')).toBe(7 * 24 * 60 * 60 * 1000);
    expect(pullPolicyRefreshAfterMs('every_1h30m')).toBe(90 * 60 * 1000);
    expect(pullPolicyRefreshAfterMs('always')).toBeNull();
    expect(pullPolicyRefreshAfterMs('every_nonsense')).toBeNull();
  });

  it('is due only after the window, and treats an unknown or missing time as due', () => {
    const now = Date.UTC(2026, 0, 2);
    expect(pullPolicyRefreshDue('daily', now - 60 * 60 * 1000, now)).toBe(false);
    expect(pullPolicyRefreshDue('daily', now - 25 * 60 * 60 * 1000, now)).toBe(true);
    expect(pullPolicyRefreshDue('refresh', now, now)).toBe(true);
    expect(pullPolicyRefreshDue('daily', null, now)).toBe(true);
    expect(pullPolicyRefreshDue('every_nonsense', now, now)).toBe(true);
  });

  it('recognises a bare or explicit latest tag', () => {
    expect(isLatestImageTag('nginx')).toBe(true);
    expect(isLatestImageTag('nginx:latest')).toBe(true);
    expect(isLatestImageTag('registry.example.com:5000/web:latest')).toBe(true);
    expect(isLatestImageTag('nginx:1.27')).toBe(false);
    expect(isLatestImageTag('registry.example.com/web@sha256:abc')).toBe(true);
  });
});
