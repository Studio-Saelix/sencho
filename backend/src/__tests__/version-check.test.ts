/**
 * Unit tests for Sencho upstream version lookup and registry publish gating.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetRemoteDigestResult = vi.fn();
const mockFetch = vi.fn();

vi.stubGlobal('fetch', mockFetch);

vi.mock('../services/registry-api', () => ({
  getRemoteDigestResult: (...args: unknown[]) => mockGetRemoteDigestResult(...args),
}));

import { CacheService } from '../services/CacheService';
import {
  fetchLatestSenchoVersion,
  fetchLatestSenchoVersionInfo,
  getLatestVersion,
  getReleaseByVersion,
  isSenchoVersionPublished,
} from '../utils/version-check';

function ghRelease(version: string) {
  return {
    ok: true,
    json: async () => ({ tag_name: `v${version}` }),
  };
}

function dockerHubTags(...versions: string[]) {
  return {
    ok: true,
    json: async () => ({
      results: versions.map(name => ({ name })),
    }),
  };
}

describe('isSenchoVersionPublished', () => {
  beforeEach(() => {
    mockGetRemoteDigestResult.mockReset();
  });

  it('returns true when either mirror has a pullable manifest', async () => {
    mockGetRemoteDigestResult
      .mockResolvedValueOnce({ ok: false, reason: 'not found' })
      .mockResolvedValueOnce({ ok: true, digest: 'sha256:abc' });

    await expect(isSenchoVersionPublished('0.94.0')).resolves.toBe(true);
    expect(mockGetRemoteDigestResult).toHaveBeenCalledTimes(2);
  });

  it('returns false when every mirror probe fails', async () => {
    mockGetRemoteDigestResult.mockResolvedValue({ ok: false, reason: 'not found' });

    await expect(isSenchoVersionPublished('0.94.0')).resolves.toBe(false);
  });

  it('returns false for invalid semver input', async () => {
    await expect(isSenchoVersionPublished('not-a-version')).resolves.toBe(false);
    expect(mockGetRemoteDigestResult).not.toHaveBeenCalled();
  });
});

describe('fetchLatestSenchoVersionInfo', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockGetRemoteDigestResult.mockReset();
    mockGetRemoteDigestResult.mockResolvedValue({ ok: false, reason: 'not found' });
  });

  it('returns GitHub version when the registry manifest is published', async () => {
    mockFetch
      .mockResolvedValueOnce(ghRelease('0.94.0'))
      .mockResolvedValueOnce(dockerHubTags('0.94.0', '0.93.0'));
    mockGetRemoteDigestResult.mockResolvedValue({ ok: true, digest: 'sha256:abc' });

    await expect(fetchLatestSenchoVersionInfo()).resolves.toEqual({
      version: '0.94.0',
      publishPending: false,
    });
  });

  it('falls back to Docker Hub and marks publishPending when GitHub is ahead of the registry', async () => {
    mockFetch
      .mockResolvedValueOnce(ghRelease('0.94.0'))
      .mockResolvedValueOnce(dockerHubTags('0.93.0'));

    await expect(fetchLatestSenchoVersionInfo()).resolves.toEqual({
      version: '0.93.0',
      publishPending: true,
    });
    expect(mockGetRemoteDigestResult).toHaveBeenCalled();
  });

  it('uses Docker Hub when GitHub is unavailable', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce(dockerHubTags('0.93.0'));

    await expect(fetchLatestSenchoVersionInfo()).resolves.toEqual({
      version: '0.93.0',
      publishPending: false,
    });
    expect(mockGetRemoteDigestResult).not.toHaveBeenCalled();
  });

  it('throws when both upstream lookups fail', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false });

    await expect(fetchLatestSenchoVersionInfo()).rejects.toThrow(
      'Both GitHub and Docker Hub version lookups failed',
    );
  });
});

describe('getLatestVersion cache', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockGetRemoteDigestResult.mockReset();
    CacheService.getInstance().flush();
  });

  afterEach(() => {
    CacheService.getInstance().flush();
  });

  it('returns the published semver from the cached lookup', async () => {
    mockFetch
      .mockResolvedValueOnce(ghRelease('0.94.0'))
      .mockResolvedValueOnce(dockerHubTags('0.94.0'));
    mockGetRemoteDigestResult.mockResolvedValue({ ok: true, digest: 'sha256:abc' });

    await expect(getLatestVersion()).resolves.toBe('0.94.0');
    await expect(getLatestVersion()).resolves.toBe('0.94.0');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('fetchLatestSenchoVersion returns the version string only', async () => {
    mockFetch
      .mockResolvedValueOnce(ghRelease('0.94.0'))
      .mockResolvedValueOnce(dockerHubTags('0.94.0'));
    mockGetRemoteDigestResult.mockResolvedValue({ ok: true, digest: 'sha256:abc' });

    await expect(fetchLatestSenchoVersion()).resolves.toBe('0.94.0');
  });
});

describe('getReleaseByVersion', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    CacheService.getInstance().flush();
  });

  afterEach(() => {
    CacheService.getInstance().flush();
  });

  function tagRelease(version: string, body: string) {
    return {
      ok: true,
      json: async () => ({ tag_name: `v${version}`, body, html_url: `https://example.test/v${version}` }),
    };
  }

  it('fetches the release for that tag and serves repeat reads from the cache', async () => {
    mockFetch.mockResolvedValueOnce(tagRelease('0.98.1', '### Highlights\n\nShort overview.'));

    const first = await getReleaseByVersion('0.98.1');
    const second = await getReleaseByVersion('0.98.1');

    expect(first?.body).toContain('Short overview.');
    expect(second).toEqual(first);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toMatch(/\/releases\/tags\/v0\.98\.1$/);
  });

  it('refetches on forceRefresh', async () => {
    mockFetch
      .mockResolvedValueOnce(tagRelease('0.98.1', 'old'))
      .mockResolvedValueOnce(tagRelease('0.98.1', 'new'));

    await getReleaseByVersion('0.98.1');
    const fresh = await getReleaseByVersion('0.98.1', true);

    expect(fresh?.body).toBe('new');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns null without calling GitHub for a non-canonical version', async () => {
    for (const version of ['../latest', 'v0.98.1', '=0.98.1', ' 0.98.1', '0.98.1 ', 'latest']) {
      await expect(getReleaseByVersion(version)).resolves.toBeNull();
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('keeps one cache entry per version', async () => {
    mockFetch
      .mockResolvedValueOnce(tagRelease('0.98.1', 'one'))
      .mockResolvedValueOnce(tagRelease('0.98.0', 'zero'));

    await expect(getReleaseByVersion('0.98.1')).resolves.toMatchObject({ body: 'one' });
    await expect(getReleaseByVersion('0.98.0')).resolves.toMatchObject({ body: 'zero' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('refetches after the short TTL so a body edited after publish is picked up', async () => {
    vi.useFakeTimers();
    try {
      mockFetch
        .mockResolvedValueOnce(tagRelease('0.98.1', 'before highlights'))
        .mockResolvedValueOnce(tagRelease('0.98.1', 'after highlights'));

      await getReleaseByVersion('0.98.1');
      vi.advanceTimersByTime(4 * 60 * 1000);
      await expect(getReleaseByVersion('0.98.1')).resolves.toMatchObject({ body: 'before highlights' });
      vi.advanceTimersByTime(2 * 60 * 1000);
      await expect(getReleaseByVersion('0.98.1')).resolves.toMatchObject({ body: 'after highlights' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns null and does not cache a failed lookup', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce(tagRelease('0.98.1', 'recovered'));

    await expect(getReleaseByVersion('0.98.1')).resolves.toBeNull();
    await expect(getReleaseByVersion('0.98.1')).resolves.toMatchObject({ body: 'recovered' });
  });
});
