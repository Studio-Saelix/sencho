import semver from 'semver';
import { CacheService } from '../services/CacheService';
import { getRemoteDigestResult } from '../services/registry-api';
import { isDebugEnabled } from './debug';
import { sanitizeForLog } from './safeLog';

/**
 * Fetches the latest Sencho release version from GitHub or Docker Hub.
 * Extracted from index.ts so both the fleet endpoint and MonitorService
 * can share the same lookup logic.
 *
 * GitHub releases/latest is the canonical semver source, but availability
 * is gated on a pullable registry manifest so operators are not prompted
 * before docker-publish.yml finishes pushing the image.
 */

const SENCHO_PUBLISH_MIRRORS = [
  { registry: 'registry-1.docker.io', repo: 'saelix/sencho' },
  { registry: 'ghcr.io', repo: 'studio-saelix/sencho' },
] as const;

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

/** True when at least one public mirror has a pullable manifest for the semver tag. */
export async function isSenchoVersionPublished(version: string): Promise<boolean> {
  if (!semver.valid(version)) return false;

  const results = await Promise.all(
    SENCHO_PUBLISH_MIRRORS.map(async ({ registry, repo }) => {
      const result = await getRemoteDigestResult(registry, repo, version, null);
      if (isDebugEnabled() && !result.ok) {
        console.debug(
          `[VersionCheck] Manifest probe failed for ${sanitizeForLog(registry)}/${sanitizeForLog(repo)}:${sanitizeForLog(version)}: ${sanitizeForLog(result.reason)}`,
        );
      }
      return result.ok;
    }),
  );
  return results.some(Boolean);
}

export interface LatestVersionInfo {
  version: string;
  /** GitHub announced a newer release than the highest published registry tag. */
  publishPending: boolean;
}

export async function fetchLatestSenchoVersionInfo(): Promise<LatestVersionInfo> {
  let gh: string | null = null;
  let hub: string | null = null;

  try {
    gh = await fetchFromGitHub();
  } catch (err) {
    console.warn('[VersionCheck] GitHub fetch failed:', (err as Error).message);
  }

  try {
    hub = await fetchFromDockerHub();
  } catch (err) {
    console.warn('[VersionCheck] Docker Hub fetch failed:', (err as Error).message);
  }

  if (gh && semver.valid(gh)) {
    if (await isSenchoVersionPublished(gh)) {
      return { version: gh, publishPending: false };
    }
    if (hub && semver.valid(hub)) {
      return { version: hub, publishPending: true };
    }
    throw new Error(`GitHub release ${gh} is not yet published on any registry mirror`);
  }

  if (hub && semver.valid(hub)) {
    return { version: hub, publishPending: false };
  }

  throw new Error('Both GitHub and Docker Hub version lookups failed');
}

export async function fetchLatestSenchoVersion(): Promise<string> {
  const info = await fetchLatestSenchoVersionInfo();
  return info.version;
}

/**
 * Cached wrapper shared by the Fleet endpoint and MonitorService.
 * CacheService provides TTL, inflight deduplication, and stale-on-error
 * fallback so transient network blips do not cause user-visible gaps.
 */
const LATEST_VERSION_INFO_CACHE_KEY = 'latest-version-info';
const LATEST_VERSION_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const PENDING_PUBLISH_CACHE_TTL = 3 * 60 * 1000; // 3 minutes

let inflightLatestVersionInfo: Promise<LatestVersionInfo> | null = null;

export async function getLatestVersionInfo(forceRefresh = false): Promise<LatestVersionInfo | null> {
  const cache = CacheService.getInstance();
  if (forceRefresh) {
    cache.invalidate(LATEST_VERSION_INFO_CACHE_KEY);
  }

  const cached = cache.get<LatestVersionInfo>(LATEST_VERSION_INFO_CACHE_KEY);
  if (cached) return cached;

  if (!inflightLatestVersionInfo) {
    inflightLatestVersionInfo = (async () => {
      try {
        const info = await fetchLatestSenchoVersionInfo();
        const ttl = info.publishPending ? PENDING_PUBLISH_CACHE_TTL : LATEST_VERSION_CACHE_TTL;
        cache.set(LATEST_VERSION_INFO_CACHE_KEY, info, ttl);
        return info;
      } finally {
        inflightLatestVersionInfo = null;
      }
    })();
  }

  try {
    return await inflightLatestVersionInfo;
  } catch {
    return null;
  }
}

export async function getLatestVersion(forceRefresh = false): Promise<string | null> {
  const info = await getLatestVersionInfo(forceRefresh);
  return info?.version ?? null;
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
