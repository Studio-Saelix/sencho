import { describe, expect, it } from 'vitest';
import {
  parseHttpsRepoUrl,
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
