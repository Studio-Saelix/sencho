import { describe, expect, it } from 'vitest';
import {
  buildManagedImageRepoSet,
  classifyManagedImageCandidate,
  imageRepositoryKey,
} from '../helpers/managedImageAttribution';

describe('imageRepositoryKey', () => {
  it('strips tags and normalizes Docker Hub library refs', () => {
    expect(imageRepositoryKey('nginx:1.27')).toBe('registry-1.docker.io/library/nginx');
    expect(imageRepositoryKey('docker.io/library/nginx:alpine')).toBe('registry-1.docker.io/library/nginx');
    expect(imageRepositoryKey('ghcr.io/acme/api:v1')).toBe('ghcr.io/acme/api');
  });

  it('returns null for digests and dangling placeholders', () => {
    expect(imageRepositoryKey('sha256:' + 'a'.repeat(64))).toBeNull();
    expect(imageRepositoryKey('<none>:<none>')).toBeNull();
    expect(imageRepositoryKey('')).toBeNull();
  });
});

describe('buildManagedImageRepoSet', () => {
  it('collects container Image tags and listed RepoTags for managed ImageIDs', () => {
    const { repoKeys, repoToStack } = buildManagedImageRepoSet(
      [{ Image: 'sha256:' + 'b'.repeat(64), ImageID: 'img-cur', stack: 'my-stack' }],
      [
        { Id: 'img-cur', RepoTags: ['myapp:2'] },
        { Id: 'img-old', RepoTags: ['myapp:1'] },
      ],
    );
    expect(repoKeys.has('registry-1.docker.io/library/myapp') || repoKeys.has('registry-1.docker.io/library/myapp'.replace('library/', ''))
      || [...repoKeys].some((k) => k.endsWith('/myapp') || k.endsWith('myapp'))).toBe(true);
    // parseImageRef puts library/ for bare names
    expect([...repoKeys].some((k) => k.includes('myapp'))).toBe(true);
    expect(repoToStack.get([...repoKeys].find((k) => k.includes('myapp'))!)).toBe('my-stack');
  });
});

describe('classifyManagedImageCandidate', () => {
  const emptySets = {
    managedImageIds: new Set<string>(),
    unmanagedImageIds: new Set<string>(),
    repoKeys: new Set<string>(),
    repoToStack: new Map<string, string>(),
    resolveStack: () => null as string | null,
  };

  it('rejects present foreign project labels before becomesFree and repo-match', () => {
    const result = classifyManagedImageCandidate({
      ...emptySets,
      imageId: 'img1',
      labels: { 'com.docker.compose.project': 'other' },
      repoTags: ['nginx:1'],
      becomesFree: true,
      repoKeys: new Set(['registry-1.docker.io/library/nginx']),
      resolveStack: () => null,
    });
    expect(result).toEqual({ eligible: false });
  });

  it('accepts becomesFree when no foreign project bar applies', () => {
    const result = classifyManagedImageCandidate({
      ...emptySets,
      imageId: 'img1',
      labels: undefined,
      repoTags: ['orphan:1'],
      becomesFree: true,
    });
    expect(result).toEqual({ eligible: true, reason: 'becomes-free' });
  });
});
