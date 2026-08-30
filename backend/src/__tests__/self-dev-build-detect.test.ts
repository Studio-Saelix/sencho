/**
 * Unit tests for detectSelfDevBuildUpdate: the self-image build detector that
 * compares the running Sencho container's image against the rolling
 * ghcr.io/studio-saelix/sencho-dev:dev tag. Drives the function entirely
 * through the deps injection point (inspectImage, compareDetailed) so no
 * real Docker socket or registry call is involved.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  detectSelfDevBuildUpdate,
  type DetectSelfDevBuildUpdateDeps,
  type SelfDevBuildDetectInput,
} from '../services/selfDevBuildDetect';
import type { compareLocalToRemoteTagDetailed } from '../services/registry-api';

const REGISTRY = 'ghcr.io';
const REPO = 'studio-saelix/sencho-dev';
const TAG = 'dev';

const LOCAL_DIGEST = `sha256:${'b'.repeat(64)}`;
const NEW_DIGEST = `sha256:${'c'.repeat(64)}`;
const LOCAL_REPO_DIGEST = `${REGISTRY}/${REPO}@${LOCAL_DIGEST}`;

const INPUT: SelfDevBuildDetectInput = {
  runningImageId: 'a'.repeat(64),
  registry: REGISTRY,
  repo: REPO,
  tag: TAG,
  credentials: null,
};

function inspectReturning(repoDigests: string[]) {
  return vi.fn().mockResolvedValue({ RepoDigests: repoDigests, Os: 'linux', Architecture: 'amd64' });
}

function compareReturning(
  result: Awaited<ReturnType<typeof compareLocalToRemoteTagDetailed>>,
): typeof compareLocalToRemoteTagDetailed {
  return vi.fn().mockResolvedValue(result);
}

describe('detectSelfDevBuildUpdate', () => {
  it('returns up_to_date on a parent-index digest match (local digest equals a remote index primary digest)', async () => {
    const deps: DetectSelfDevBuildUpdateDeps = {
      inspectImage: inspectReturning([LOCAL_REPO_DIGEST]),
      compareDetailed: compareReturning({ kind: 'match', primaryDigest: LOCAL_DIGEST }),
    };
    expect(await detectSelfDevBuildUpdate(INPUT, deps)).toEqual({ kind: 'up_to_date' });
  });

  it('returns up_to_date on platform-child membership (local RepoDigest is the platform-specific child, not the parent index digest)', async () => {
    // The compareDetailed injection point owns the index-expansion logic; this
    // test only needs to prove the detector trusts that verdict rather than
    // doing its own raw digest equality check, which would wrongly report an
    // update here since LOCAL_DIGEST != the (hypothetical) parent index digest.
    const compareDetailed = compareReturning({ kind: 'match', primaryDigest: `sha256:${'d'.repeat(64)}` });
    const deps: DetectSelfDevBuildUpdateDeps = { inspectImage: inspectReturning([LOCAL_REPO_DIGEST]), compareDetailed };

    expect(await detectSelfDevBuildUpdate(INPUT, deps)).toEqual({ kind: 'up_to_date' });
    expect(compareDetailed).toHaveBeenCalledWith(
      [LOCAL_DIGEST],
      REGISTRY,
      REPO,
      TAG,
      { os: 'linux', architecture: 'amd64' },
      null,
    );
  });

  it('returns update with the new digest when the remote has a genuinely newer build', async () => {
    const deps: DetectSelfDevBuildUpdateDeps = {
      inspectImage: inspectReturning([LOCAL_REPO_DIGEST]),
      compareDetailed: compareReturning({ kind: 'update', primaryDigest: NEW_DIGEST }),
    };
    expect(await detectSelfDevBuildUpdate(INPUT, deps)).toEqual({ kind: 'update', digest: NEW_DIGEST });
  });

  it('returns inconclusive when RepoDigests is empty', async () => {
    const compareDetailed = vi.fn();
    const deps: DetectSelfDevBuildUpdateDeps = { inspectImage: inspectReturning([]), compareDetailed };

    const result = await detectSelfDevBuildUpdate(INPUT, deps);
    expect(result.kind).toBe('inconclusive');
    expect(compareDetailed).not.toHaveBeenCalled();
  });

  it('returns inconclusive when RepoDigests is present but none match the target registry/repo', async () => {
    const compareDetailed = vi.fn();
    const deps: DetectSelfDevBuildUpdateDeps = {
      inspectImage: inspectReturning([`docker.io/library/other@sha256:${'e'.repeat(64)}`]),
      compareDetailed,
    };

    const result = await detectSelfDevBuildUpdate(INPUT, deps);
    expect(result.kind).toBe('inconclusive');
    expect(compareDetailed).not.toHaveBeenCalled();
  });

  it('returns inconclusive, not a throw, when inspectImage throws', async () => {
    const deps: DetectSelfDevBuildUpdateDeps = {
      inspectImage: vi.fn().mockRejectedValue(new Error('no such image')),
      compareDetailed: vi.fn(),
    };
    const result = await detectSelfDevBuildUpdate(INPUT, deps);
    expect(result).toEqual({ kind: 'inconclusive', reason: expect.stringContaining('no such image') });
  });

  it('returns inconclusive with the carried-through reason when compareDetailed returns kind: error', async () => {
    const deps: DetectSelfDevBuildUpdateDeps = {
      inspectImage: inspectReturning([LOCAL_REPO_DIGEST]),
      compareDetailed: compareReturning({ kind: 'error', reason: 'Registry unreachable for ghcr.io/studio-saelix/sencho-dev:dev' }),
    };
    const result = await detectSelfDevBuildUpdate(INPUT, deps);
    expect(result).toEqual({ kind: 'inconclusive', reason: 'Registry unreachable for ghcr.io/studio-saelix/sencho-dev:dev' });
  });

  it('returns inconclusive (not a fabricated update) when compareDetailed returns kind: update with no primaryDigest', async () => {
    const deps: DetectSelfDevBuildUpdateDeps = {
      inspectImage: inspectReturning([LOCAL_REPO_DIGEST]),
      compareDetailed: compareReturning({ kind: 'update' }),
    };
    const result = await detectSelfDevBuildUpdate(INPUT, deps);
    expect(result).toEqual({ kind: 'inconclusive', reason: expect.stringContaining('no digest') });
  });

  it('returns inconclusive, not a throw, when compareDetailed rejects', async () => {
    const deps: DetectSelfDevBuildUpdateDeps = {
      inspectImage: inspectReturning([LOCAL_REPO_DIGEST]),
      compareDetailed: vi.fn().mockRejectedValue(new Error('registry socket reset')),
    };
    const result = await detectSelfDevBuildUpdate(INPUT, deps);
    expect(result).toEqual({ kind: 'inconclusive', reason: expect.stringContaining('registry socket reset') });
  });

  it('returns inconclusive, not a throw, when inspectImage resolves with a non-array RepoDigests', async () => {
    // A misbehaving injected inspectImage (or a future Docker SDK shape change)
    // can violate its declared return type at runtime; the cast below
    // constructs exactly that violation on purpose to prove the detector
    // guards against it rather than trusting the type signature blindly.
    const malformedInspect = vi.fn().mockResolvedValue({ RepoDigests: undefined, Os: 'linux', Architecture: 'amd64' }) as unknown as NonNullable<DetectSelfDevBuildUpdateDeps['inspectImage']>;
    const compareDetailed = vi.fn();
    const deps: DetectSelfDevBuildUpdateDeps = { inspectImage: malformedInspect, compareDetailed };

    const result = await detectSelfDevBuildUpdate(INPUT, deps);
    expect(result.kind).toBe('inconclusive');
    expect(compareDetailed).not.toHaveBeenCalled();
  });
});
