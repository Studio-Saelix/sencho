import { describe, it, expect } from 'vitest';
import {
  parsePullReference,
  normalizePullRefList,
  PULL_REF_MAX_COUNT,
} from '../helpers/registryPullReference';

const DIGEST = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('parsePullReference', () => {
  it('parses a fully-qualified tag ref', () => {
    expect(parsePullReference('ghcr.io/acme/app:1.0.0')).toEqual({
      kind: 'tag',
      value: 'ghcr.io/acme/app:1.0.0',
    });
  });

  it('preserves a digest-pinned ref exactly and never substitutes latest', () => {
    expect(parsePullReference(`ghcr.io/acme/app@${DIGEST}`)).toEqual({
      kind: 'digest',
      value: `ghcr.io/acme/app@${DIGEST}`,
    });
  });

  it('strips a pinned tag from a digest ref and applies the Hub library prefix', () => {
    expect(parsePullReference(`ghcr.io/acme/app:1.2.3@${DIGEST}`)).toEqual({
      kind: 'digest',
      value: `ghcr.io/acme/app@${DIGEST}`,
    });
    expect(parsePullReference(`nginx@${DIGEST}`)).toEqual({
      kind: 'digest',
      value: `index.docker.io/library/nginx@${DIGEST}`,
    });
  });

  it('folds Docker Hub aliases to index.docker.io and applies the library prefix', () => {
    expect(parsePullReference('nginx')).toEqual({
      kind: 'tag',
      value: 'index.docker.io/library/nginx:latest',
    });
    expect(parsePullReference('docker.io/library/node:20')).toEqual({
      kind: 'tag',
      value: 'index.docker.io/library/node:20',
    });
  });

  it('preserves a custom registry port', () => {
    expect(parsePullReference('localhost:5000/repo/app:1')).toEqual({
      kind: 'tag',
      value: 'localhost:5000/repo/app:1',
    });
  });

  it('returns null for a bare local image ID', () => {
    expect(parsePullReference(DIGEST)).toBeNull();
  });

  it('accepts a short name whose tag is all hex digits', () => {
    expect(parsePullReference('alpine:3')).toEqual({
      kind: 'tag',
      value: 'index.docker.io/library/alpine:3',
    });
    expect(parsePullReference('node:20')).toEqual({
      kind: 'tag',
      value: 'index.docker.io/library/node:20',
    });
  });

  it('rejects a sha256-prefixed non-port form instead of parsing a garbage host', () => {
    expect(parsePullReference('sha256:abcdef0123456789/org/app:latest')).toBeNull();
  });

  it('returns null for an unparseable digest and for empty input', () => {
    expect(parsePullReference('ghcr.io/app@sha256:nothex')).toBeNull();
    expect(parsePullReference('')).toBeNull();
    expect(parsePullReference('   ')).toBeNull();
  });
});

describe('normalizePullRefList', () => {
  it('canonicalizes, deduplicates, omits unparseable refs, and sorts for stable hashing', () => {
    const out = normalizePullRefList([
      'nginx',
      'ghcr.io/app:1',
      'nginx',
      'ghcr.io/app@sha256:nothex',
    ]);
    expect(out).toEqual(['ghcr.io/app:1', 'index.docker.io/library/nginx:latest']);
  });

  it('returns a stable sorted order regardless of input order', () => {
    const a = normalizePullRefList(['z.example/app:1', 'a.example/app:1']);
    const b = normalizePullRefList(['a.example/app:1', 'z.example/app:1']);
    expect(a).toEqual(b);
    expect(a).toEqual(['a.example/app:1', 'z.example/app:1']);
  });

  it('throws a 413 error when the distinct ref count exceeds the cap', () => {
    const refs = Array.from({ length: PULL_REF_MAX_COUNT + 1 }, (_, i) => `ghcr.io/repo/r${i}:latest`);
    expect(() => normalizePullRefList(refs)).toThrow();
    try {
      normalizePullRefList(refs);
    } catch (error) {
      expect((error as { status?: number }).status).toBe(413);
    }
  });

  it('throws a 413 error when the serialized list exceeds the byte cap', () => {
    const hugeRepo = 'ghcr.io/' + 'a'.repeat(70_000) + ':latest';
    try {
      normalizePullRefList([hugeRepo]);
    } catch (error) {
      expect((error as { status?: number }).status).toBe(413);
    }
  });
});