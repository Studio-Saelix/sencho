import { describe, expect, it } from 'vitest';
import {
  canonicalRepoKeyFromUrl,
  parseHttpsRepoUrl,
  parseLegacyRepoUrl,
  repoUrlRejectionMessage,
  secretFreeRepoUrl,
  serializeRepoIdentity,
} from '../services/gitops/repoIdentity';
import { canonicalMaterialConfigJson, materializationFingerprint } from '../services/gitops/fingerprint';

describe('secret-free repository identity', () => {
  it('rejects userinfo, query, fragment, and non-https urls', () => {
    expect(parseHttpsRepoUrl('http://github.com/org/repo.git').ok).toBe(false);
    const userinfo = parseHttpsRepoUrl('https://user:pass@github.com/org/repo.git');
    const query = parseHttpsRepoUrl('https://github.com/org/repo.git?token=1');
    const fragment = parseHttpsRepoUrl('https://github.com/org/repo.git#frag');
    expect(userinfo.ok ? null : userinfo.reason).toBe('userinfo');
    expect(query.ok ? null : query.reason).toBe('query');
    expect(fragment.ok ? null : fragment.reason).toBe('fragment');
    expect(parseHttpsRepoUrl('https://github.com/org/repo.git').ok).toBe(true);
  });

  it('serializes host and pathname only', () => {
    const parsed = parseHttpsRepoUrl('https://github.com/org/repo.git');
    if (!parsed.ok) throw new Error('expected parse success');
    const identity = serializeRepoIdentity(parsed.url);
    expect(identity).toEqual({ host: 'github.com', pathname: '/org/repo.git' });
    expect(secretFreeRepoUrl(identity)).toBe('https://github.com/org/repo.git');
  });

  describe('legacy operational urls (migration only)', () => {
    it('strips userinfo, query, and fragment instead of refusing the stack', () => {
      for (const raw of [
        'https://user:pass@github.com/org/repo.git',
        'https://github.com/org/repo.git?token=secret',
        'https://github.com/org/repo.git#frag',
        'https://user:pass@github.com/org/repo.git?token=secret#frag',
      ]) {
        const parsed = parseLegacyRepoUrl(raw);
        if (!parsed.ok) throw new Error(`expected legacy parse success for ${raw}`);
        expect({ host: parsed.url.host, pathname: parsed.url.pathname }).toEqual({
          host: 'github.com',
          pathname: '/org/repo.git',
        });
        expect(parsed.url.username).toBe('');
        expect(parsed.url.password).toBe('');
        expect(parsed.url.search).toBe('');
        expect(parsed.url.hash).toBe('');
        expect(secretFreeRepoUrl(serializeRepoIdentity(parsed.url))).toBe('https://github.com/org/repo.git');
      }
    });

    it('still refuses what has no storable identity', () => {
      expect(parseLegacyRepoUrl('http://github.com/org/repo.git').ok).toBe(false);
      expect(parseLegacyRepoUrl('not a url at all').ok).toBe(false);
      expect(parseLegacyRepoUrl('').ok).toBe(false);
      expect(parseLegacyRepoUrl(`https://github.com/${'x'.repeat(2100)}`).ok).toBe(false);
    });
  });

  describe('repo url ingress', () => {
    it('refuses a url that names no repository', () => {
      // A bare host parses, so without the canonical check it would be stored
      // as a source that no Blueprint conversion could ever claim.
      expect(repoUrlRejectionMessage('https://github.com/')).toMatch(/repository path/i);
      expect(repoUrlRejectionMessage('https://github.com')).toMatch(/repository path/i);
      expect(repoUrlRejectionMessage('git@foo/bar:org/repo')).toMatch(/repository path/i);
      // Refused too, by the parser rather than the path check.
      expect(repoUrlRejectionMessage('git@github.com:')).not.toBeNull();
    });

    it('accepts every spelling of a real repository', () => {
      for (const url of [
        'https://github.com/org/repo.git',
        'https://github.com/org/repo',
        'git@github.com:org/repo.git',
        'ssh://git@github.com/org/repo.git',
        'https://[::1]:8443/org/repo.git',
      ]) {
        expect(repoUrlRejectionMessage(url), url).toBeNull();
      }
    });
  });

  describe('canonical repository key', () => {
    it('collapses every spelling of one repository', () => {
      const expected = 'github.com/org/repo';
      for (const url of [
        'https://github.com/org/repo.git',
        'https://github.com/org/repo',
        'https://github.com/org/repo/',
        'https://github.com/org/repo.git/',
        'https://GitHub.com/org/repo.git',
        'git@github.com:org/repo.git',
        'git@github.com:org/repo',
        'git@GitHub.COM:org/repo.git',
        'ssh://git@github.com/org/repo.git',
        'ssh://git@github.com:22/org/repo.git',
      ]) {
        expect(canonicalRepoKeyFromUrl(url), url).toBe(expected);
      }
    });

    it('keeps different repositories apart', () => {
      const key = (url: string) => canonicalRepoKeyFromUrl(url);
      expect(key('https://github.com/org/repo.git')).not.toBe(key('https://gitlab.com/org/repo.git'));
      expect(key('https://github.com/org/repo.git')).not.toBe(key('https://github.com/org/repo-b.git'));
      expect(key('https://github.com/org.git/repo.git')).not.toBe(key('https://github.com/org/repo.git'));
      expect(key('https://github.com/org/repo.GIT')).not.toBe(key('https://github.com/org/repo.git'));
      expect(key('https://github.com/org/repo.git.git')).not.toBe(key('https://github.com/org/repo.git'));
      expect(key('https://github.com/org/repo.git')).not.toBe(key('https://github.com:8443/org/repo.git'));
    });

    it('has no key for a url that names no repository', () => {
      for (const url of [
        'not a url at all',
        'http://github.com/org/repo.git',
        'https://github.com',
        'https://github.com/',
        'https://github.com?token=1',
        '',
      ]) {
        expect(canonicalRepoKeyFromUrl(url), url).toBeNull();
      }
    });
  });

  it('fingerprints material config in the fixed key order', () => {
    const json = canonicalMaterialConfigJson({
      repoIdentity: { host: 'github.com', pathname: '/org/repo.git' },
      configuredRef: 'main',
      composePaths: ['compose.yml'],
      contextDir: '  ',
      syncEnv: false,
      envPath: '.env',
    });
    expect(json).toBe(JSON.stringify({
      composePaths: ['compose.yml'],
      contextDir: null,
      syncEnv: false,
      envPath: null,
      repoIdentity: { host: 'github.com', pathname: '/org/repo.git' },
      configuredRef: 'main',
    }));
    expect(materializationFingerprint({
      repoIdentity: { host: 'github.com', pathname: '/org/repo.git' },
      configuredRef: 'main',
      composePaths: ['compose.yml'],
      contextDir: null,
      syncEnv: false,
      envPath: null,
    })).toMatch(/^[0-9a-f]{64}$/);
    const synced = canonicalMaterialConfigJson({
      repoIdentity: { host: 'github.com', pathname: '/org/repo.git' },
      configuredRef: 'main',
      composePaths: ['compose.yml'],
      contextDir: null,
      syncEnv: true,
      envPath: '.env',
    });
    expect(JSON.parse(synced).envPath).toBe('.env');
    expect(JSON.parse(synced).syncEnv).toBe(true);
  });
});
