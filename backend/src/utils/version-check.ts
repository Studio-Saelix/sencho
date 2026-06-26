import semver from 'semver';
import { CacheService } from '../services/CacheService';

/**
 * Fetches the latest Sencho release version from GitHub or Docker Hub.
 * Extracted from index.ts so both the fleet endpoint and MonitorService
 * can share the same lookup logic.
 */

async function fetchFromGitHub(): Promise<string | null> {
  const res = await fetch('https://api.github.com/repos/studio-saelix/sencho/releases/latest', {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Sencho' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  const data = await res.json() as { tag_name?: string };
  const tag = data.tag_name?.replace(/^v/, '') ?? null;
  return tag && semver.valid(tag) ? tag : null;
}

async function fetchFromDockerHub(): Promise<string | null> {
  const res = await fetch(
    'https://hub.docker.com/v2/repositories/saelix/sencho/tags/?page_size=50&ordering=last_updated',
    { headers: { 'User-Agent': 'Sencho' }, signal: AbortSignal.timeout(10000) },
  );
  if (!res.ok) return null;
  const data = await res.json() as { results?: { name: string }[] };
  const tags = (data.results ?? [])
    .map(t => t.name)
    .filter(n => semver.valid(n));
  if (tags.length === 0) return null;
  tags.sort(semver.rcompare);
  return tags[0];
}

export async function fetchLatestSenchoVersion(): Promise<string> {
  try {
    const gh = await fetchFromGitHub();
    if (gh) return gh;
  } catch (err) {
    // GitHub API fails for private repos or rate limits; try Docker Hub
    console.warn('[VersionCheck] GitHub fetch failed:', (err as Error).message);
  }
  try {
    const hub = await fetchFromDockerHub();
    if (hub) return hub;
  } catch (err) {
    console.warn('[VersionCheck] Docker Hub fetch failed:', (err as Error).message);
  }
  // Throw so CacheService falls back to a stale value if one exists,
  // and so we do not poison the cache with null.
  throw new Error('Both GitHub and Docker Hub version lookups failed');
}

/**
 * Cached wrapper shared by the Fleet endpoint and MonitorService.
 * CacheService provides TTL, inflight deduplication, and stale-on-error
 * fallback so transient network blips do not cause user-visible gaps.
 */
const LATEST_VERSION_CACHE_KEY = 'latest-version';
const LATEST_VERSION_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

export async function getLatestVersion(forceRefresh = false): Promise<string | null> {
  if (forceRefresh) {
    CacheService.getInstance().invalidate(LATEST_VERSION_CACHE_KEY);
  }
  try {
    return await CacheService.getInstance().getOrFetch<string>(
      LATEST_VERSION_CACHE_KEY,
      LATEST_VERSION_CACHE_TTL,
      fetchLatestSenchoVersion,
    );
  } catch {
    return null;
  }
}

// --- Release details (includes body/notes for the changelog tab) ---

export interface SenchoRelease {
  tag_name: string;
  body: string;
  html_url: string;
}

async function fetchReleaseDetails(): Promise<SenchoRelease> {
  const res = await fetch('https://api.github.com/repos/studio-saelix/sencho/releases/latest', {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Sencho' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`GitHub releases API returned ${res.status}`);
  const data = await res.json() as { tag_name?: string; body?: string; html_url?: string };
  if (!data.tag_name) throw new Error('Release response missing tag_name');
  return {
    tag_name: data.tag_name,
    body: data.body ?? '',
    html_url: data.html_url ?? `https://github.com/studio-saelix/sencho/releases/tag/${data.tag_name}`,
  };
}

const LATEST_RELEASE_CACHE_KEY = 'latest-release';

export async function getLatestRelease(forceRefresh = false): Promise<SenchoRelease | null> {
  if (forceRefresh) {
    CacheService.getInstance().invalidate(LATEST_RELEASE_CACHE_KEY);
  }
  try {
    return await CacheService.getInstance().getOrFetch<SenchoRelease>(
      LATEST_RELEASE_CACHE_KEY,
      LATEST_VERSION_CACHE_TTL,
      fetchReleaseDetails,
    );
  } catch {
    return null;
  }
}
