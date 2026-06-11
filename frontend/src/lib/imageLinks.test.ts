import { describe, it, expect } from 'vitest';
import { parseImageRef, buildImageLinks, extractImageSourceMeta } from './imageLinks';

describe('parseImageRef', () => {
  it('parses an official Docker Hub image with a tag', () => {
    expect(parseImageRef('nginx:latest')).toEqual({
      registry: 'docker.io', namespace: null, repo: 'nginx', tag: 'latest', digest: null,
    });
  });

  it('parses a bare image name with no tag', () => {
    expect(parseImageRef('nginx')).toEqual({
      registry: 'docker.io', namespace: null, repo: 'nginx', tag: null, digest: null,
    });
  });

  it('parses a Docker Hub namespace image', () => {
    expect(parseImageRef('linuxserver/sonarr:latest')).toEqual({
      registry: 'docker.io', namespace: 'linuxserver', repo: 'sonarr', tag: 'latest', digest: null,
    });
  });

  it('parses a GHCR image', () => {
    expect(parseImageRef('ghcr.io/owner/image:tag')).toEqual({
      registry: 'ghcr.io', namespace: 'owner', repo: 'image', tag: 'tag', digest: null,
    });
  });

  it('parses a private registry with a port', () => {
    expect(parseImageRef('registry.example.com:5000/team/app:1.2')).toEqual({
      registry: 'registry.example.com:5000', namespace: 'team', repo: 'app', tag: '1.2', digest: null,
    });
  });

  it('captures the digest of a digest-pinned namespace image', () => {
    const digest = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
    expect(parseImageRef(`myrepo/app@${digest}`)).toEqual({
      registry: 'docker.io', namespace: 'myrepo', repo: 'app', tag: null, digest,
    });
  });

  it('captures the digest of a digest-pinned official image', () => {
    const digest = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
    expect(parseImageRef(`nginx@${digest}`)).toEqual({
      registry: 'docker.io', namespace: null, repo: 'nginx', tag: null, digest,
    });
  });

  it('keeps both the tag and the digest of a tag-and-digest pinned ref', () => {
    const digest = 'sha256:3333333333333333333333333333333333333333333333333333333333333333';
    expect(parseImageRef(`nginx:1.25@${digest}`)).toEqual({
      registry: 'docker.io', namespace: null, repo: 'nginx', tag: '1.25', digest,
    });
  });

  it('does not mistake a registry port for a tag when no tag is present', () => {
    expect(parseImageRef('registry.example.com:5000/team/app')).toEqual({
      registry: 'registry.example.com:5000', namespace: 'team', repo: 'app', tag: null, digest: null,
    });
  });

  it('returns null for a bare digest and for empty input', () => {
    expect(parseImageRef('sha256:abc')).toBeNull();
    expect(parseImageRef('   ')).toBeNull();
  });
});

describe('buildImageLinks', () => {
  it('links official Docker Hub images to the _/ page', () => {
    const links = buildImageLinks('nginx:latest');
    expect(links?.kind).toBe('dockerhub-official');
    expect(links?.registryUrl).toBe('https://hub.docker.com/_/nginx');
  });

  it('treats library/ as an official image', () => {
    expect(buildImageLinks('library/nginx')?.registryUrl).toBe('https://hub.docker.com/_/nginx');
  });

  it('treats docker.io / registry-1 / index aliases as Docker Hub', () => {
    for (const ref of [
      'docker.io/library/nginx',
      'registry-1.docker.io/library/nginx:latest',
      'index.docker.io/library/nginx',
    ]) {
      const links = buildImageLinks(ref);
      expect(links?.kind, ref).toBe('dockerhub-official');
      expect(links?.registryUrl, ref).toBe('https://hub.docker.com/_/nginx');
    }
  });

  it('links Docker Hub namespace images to the r/ page', () => {
    const links = buildImageLinks('linuxserver/sonarr:latest');
    expect(links?.kind).toBe('dockerhub-namespace');
    expect(links?.registryUrl).toBe('https://hub.docker.com/r/linuxserver/sonarr');
  });

  it('links GHCR images to the owner profile', () => {
    const links = buildImageLinks('ghcr.io/owner/image:tag');
    expect(links?.kind).toBe('ghcr');
    expect(links?.registryHost).toBe('ghcr.io');
    expect(links?.registryUrl).toBe('https://github.com/owner');
  });

  it('never guesses a link for an unknown/private registry', () => {
    const links = buildImageLinks('registry.example.com:5000/team/app:1.2');
    expect(links?.kind).toBe('other');
    expect(links?.registryHost).toBe('registry.example.com:5000');
    expect(links?.registryUrl).toBeNull();
  });

  it('still resolves the registry page for a digest-pinned ref', () => {
    const links = buildImageLinks('linuxserver/sonarr@sha256:2222222222222222222222222222222222222222222222222222222222222222');
    expect(links?.registryUrl).toBe('https://hub.docker.com/r/linuxserver/sonarr');
  });

  it('returns null for an unparseable ref', () => {
    expect(buildImageLinks('sha256:abc')).toBeNull();
  });
});

describe('extractImageSourceMeta', () => {
  it('returns nothing for empty or missing labels', () => {
    expect(extractImageSourceMeta(null)).toEqual({ links: [], version: null, revision: null });
    expect(extractImageSourceMeta({})).toEqual({ links: [], version: null, revision: null });
  });

  it('emits links only for valid absolute http(s) label values', () => {
    const meta = extractImageSourceMeta({
      'org.opencontainers.image.source': 'https://github.com/owner/repo',
      'org.opencontainers.image.url': 'https://example.com',
      'org.opencontainers.image.documentation': 'http://docs.example.com',
    });
    expect(meta.links.map(l => l.id)).toEqual(['source', 'url', 'documentation']);
  });

  it('rejects relative, javascript:, and non-URL label values', () => {
    const meta = extractImageSourceMeta({
      'org.opencontainers.image.source': '/owner/repo',
      'org.opencontainers.image.url': 'javascript:alert(1)',
      'org.opencontainers.image.documentation': 'not a url',
    });
    expect(meta.links).toEqual([]);
  });

  it('renders version as text only, never a derived release link', () => {
    const meta = extractImageSourceMeta({ 'org.opencontainers.image.version': '1.2.3' });
    expect(meta.version).toBe('1.2.3');
    expect(meta.links).toEqual([]);
  });

  it('links a SHA-like revision to a GitHub commit when source is a github repo', () => {
    const meta = extractImageSourceMeta({
      'org.opencontainers.image.source': 'https://github.com/owner/repo.git',
      'org.opencontainers.image.revision': 'abcdef1234567890',
    });
    const rev = meta.links.find(l => l.id === 'revision');
    expect(rev?.url).toBe('https://github.com/owner/repo/commit/abcdef1234567890');
    expect(meta.revision).toBeNull();
  });

  it('keeps a SHA-like revision as text when there is no source label to anchor it', () => {
    const meta = extractImageSourceMeta({
      'org.opencontainers.image.revision': 'abcdef1234567890',
    });
    expect(meta.links).toEqual([]);
    expect(meta.revision).toBe('abcdef1234567890');
  });

  it('keeps revision as text when it is not SHA-like or source is not github', () => {
    const notSha = extractImageSourceMeta({
      'org.opencontainers.image.source': 'https://github.com/owner/repo',
      'org.opencontainers.image.revision': 'v1.2.3',
    });
    expect(notSha.links.find(l => l.id === 'revision')).toBeUndefined();
    expect(notSha.revision).toBe('v1.2.3');

    const notGithub = extractImageSourceMeta({
      'org.opencontainers.image.source': 'https://gitlab.com/owner/repo',
      'org.opencontainers.image.revision': 'abcdef1234567890',
    });
    expect(notGithub.links.find(l => l.id === 'revision')).toBeUndefined();
    expect(notGithub.revision).toBe('abcdef1234567890');
  });
});
