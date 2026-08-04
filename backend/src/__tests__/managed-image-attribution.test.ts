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

  it('keeps host:port registry in the repository key', () => {
    expect(imageRepositoryKey('myhost:5000/foo:1')).toBe('myhost:5000/foo');
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
    expect(repoKeys).toEqual(new Set(['registry-1.docker.io/library/myapp']));
    expect(repoToStack.get('registry-1.docker.io/library/myapp')).toBe('my-stack');
  });

  it('normalizes private registry host:port refs as repository keys', () => {
    const { repoKeys, repoToStack } = buildManagedImageRepoSet(
      [{ Image: 'myhost:5000/foo:1', ImageID: 'img-private', stack: 'private-stack' }],
      [{ Id: 'img-private', RepoTags: ['myhost:5000/foo:1'] }],
    );
    expect(repoKeys).toEqual(new Set(['myhost:5000/foo']));
    expect(repoToStack.get('myhost:5000/foo')).toBe('private-stack');
  });
});

describe('classifyManagedImageCandidate', () => {
  const emptySets = {
    managedImageIds: new Set<string>(),
    unmanagedImageIds: new Set<string>(),
    repoKeys: new Set<string>(),
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

  it('does not attach stackName on repo-match (repository sharing is not ownership)', () => {
    const result = classifyManagedImageCandidate({
      imageId: 'img-free',
      labels: undefined,
      repoTags: ['nginx:1.14'],
      becomesFree: false,
      managedImageIds: new Set(),
      unmanagedImageIds: new Set(),
      repoKeys: new Set(['registry-1.docker.io/library/nginx']),
      resolveStack: () => null,
    });
    expect(result).toEqual({ eligible: true, reason: 'repo-match' });
  });
});
