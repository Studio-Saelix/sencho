/**
 * The deploy gate's scan cache is tied to the vulnerability database that
 * produced it.
 *
 * A 24-hour cache keyed only on digest and scanners served findings from an
 * older Trivy database, so an image could be allowed on an answer that predated
 * the advisory which added its CVE. These cover the four ways a cached row is
 * refused and the one way it is reused.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import DockerController from '../services/DockerController';

let tmpDir: string;
let TrivyService: typeof import('../services/TrivyService').default;

const DIGEST = `sha256:${'d'.repeat(64)}`;
const PLATFORM = 'linux/amd64';
const DB_BUILD = Date.UTC(2026, 0, 10, 6, 0, 0);
const NEXT_UPDATE = DB_BUILD + 6 * 60 * 60 * 1000;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  TrivyService = (await import('../services/TrivyService')).default;
});

afterAll(() => cleanupTestDb(tmpDir));

const svc = () => TrivyService.getInstance();
const db = () => DatabaseService.getInstance();

/** Seed a completed scan row; `vulnDbUpdatedAt` undefined means a pre-change row. */
function seedScan(options: {
  scannedAt?: number;
  vulnDbUpdatedAt?: number | null;
  platform?: string | null;
} = {}): number {
  return db().createVulnerabilityScan({
    node_id: 1,
    image_ref: 'registry.example.com/web:latest',
    image_digest: DIGEST,
    platform: options.platform === undefined ? PLATFORM : options.platform,
    scanned_at: options.scannedAt ?? Date.now(),
    total_vulnerabilities: 0,
    critical_count: 0,
    high_count: 0,
    medium_count: 0,
    low_count: 0,
    unknown_count: 0,
    fixable_count: 0,
    secret_count: 0,
    misconfig_count: 0,
    scanners_used: 'vuln',
    highest_severity: null,
    os_info: null,
    trivy_version: '0.50.0',
    scan_duration_ms: null,
    triggered_by: 'deploy-preflight',
    status: 'completed',
    error: null,
    stack_context: 'web',
    ...(options.vulnDbUpdatedAt === undefined ? {} : { vuln_db_updated_at: options.vulnDbUpdatedAt }),
  });
}

/** A cache hit resolves; a miss reaches the (deliberately absent) binary and throws. */
async function cacheHit(platform: string = PLATFORM): Promise<boolean> {
  try {
    await svc().scanImage('registry.example.com/web:latest', 1, {
      digest: DIGEST,
      platform,
      scanners: ['vuln'],
      cacheRule: 'database',
    });
    return true;
  } catch {
    return false;
  }
}

/** A local image as the Docker daemon reports it. */
function stubLocalImage(options: { digest?: string | null; os?: string; architecture?: string; variant?: string } = {}) {
  const inspect = vi.fn().mockResolvedValue({
    RepoDigests: options.digest === null
      ? []
      : [`registry.example.com/web@${options.digest ?? DIGEST}`],
    Os: options.os ?? 'linux',
    Architecture: options.architecture ?? 'amd64',
    ...(options.variant ? { Variant: options.variant } : {}),
  });
  vi.spyOn(DockerController, 'getInstance').mockReturnValue({
    getDocker: () => ({ getImage: () => ({ inspect }) }),
  } as unknown as DockerController);
  return inspect;
}

beforeEach(() => {
  // A spy installed by one test must not decide the next one's cache outcome.
  vi.restoreAllMocks();
  const raw = (db() as unknown as { db: { prepare: (s: string) => { run: () => void } } }).db;
  raw.prepare('DELETE FROM vulnerability_details').run();
  raw.prepare('DELETE FROM vulnerability_scans').run();
  (svc() as unknown as { scanningImages: Set<string> }).scanningImages.clear();
  (svc() as unknown as { binaryPath: string }).binaryPath = '/fake/trivy';
  (svc() as unknown as { vulnDbInfo: unknown }).vulnDbInfo = null;
  vi.spyOn(svc(), 'getVulnerabilityDbInfo').mockResolvedValue({
    updatedAt: DB_BUILD, nextUpdate: NEXT_UPDATE, readAt: Date.now(),
  });
  vi.spyOn(Date, 'now').mockReturnValue(DB_BUILD + 60 * 60 * 1000);
});

describe('the preflight cache rule', () => {
  it('reuses a row produced by the current database build inside its window', async () => {
    seedScan({ vulnDbUpdatedAt: DB_BUILD });
    expect(await cacheHit()).toBe(true);
  });

  it('misses when the database build has moved on, so a new CVE is not hidden by an old answer', async () => {
    seedScan({ vulnDbUpdatedAt: DB_BUILD - 24 * 60 * 60 * 1000 });
    expect(await cacheHit()).toBe(false);
  });

  it('misses once the database is past its next-update time', async () => {
    seedScan({ vulnDbUpdatedAt: DB_BUILD });
    vi.spyOn(Date, 'now').mockReturnValue(NEXT_UPDATE + 1);
    expect(await cacheHit()).toBe(false);
  });

  it('misses when the database revision cannot be read', async () => {
    seedScan({ vulnDbUpdatedAt: DB_BUILD });
    vi.spyOn(svc(), 'getVulnerabilityDbInfo').mockResolvedValue(null);
    expect(await cacheHit()).toBe(false);
  });

  it('misses a row written before revisions were recorded', async () => {
    seedScan();
    expect(await cacheHit()).toBe(false);
  });

  it('leaves the plain digest cache alone for every other scan path', async () => {
    // No revision on the row, and the morning-fresh rule would miss: a `digest`
    // rule scan still reuses it, which is the behaviour every non-gate path keeps.
    seedScan();
    await expect(svc().scanImage('registry.example.com/web:latest', 1, {
      digest: DIGEST, scanners: ['vuln'], cacheRule: 'digest',
    })).resolves.toBeDefined();
  });
});

describe('the cache key includes the platform child', () => {
  it('does not let one platform child\'s row answer for another', async () => {
    seedScan({ vulnDbUpdatedAt: DB_BUILD, platform: 'linux/amd64' });

    expect(await cacheHit('linux/arm64')).toBe(false);
    expect(db().getLatestScanByDigest(DIGEST, 'vuln', 'linux/arm64')).toBeNull();
    expect(db().getLatestScanByDigest(DIGEST, 'vuln', 'linux/amd64')?.id).toBeGreaterThan(0);
  });

  it('keys a plain-digest scan of the local image by its platform too', async () => {
    seedScan({ platform: 'linux/amd64' });
    stubLocalImage({ os: 'linux', architecture: 'arm64' });

    // A manual or scheduled scan of the local image must not take a candidate
    // row for another platform child of the same index digest.
    await expect(svc().scanImage('registry.example.com/web:latest', 1, {
      scanners: ['vuln'],
    })).rejects.toThrow();
  });

  it('keys an installed scan by the local image platform', async () => {
    seedScan({ vulnDbUpdatedAt: DB_BUILD, platform: 'linux/amd64' });
    stubLocalImage({ os: 'linux', architecture: 'arm64', variant: 'v8' });

    // The amd64 candidate row must not answer the arm64 installed scan.
    await expect(svc().scanImage('registry.example.com/web:latest', 1, {
      scanners: ['vuln'], cacheRule: 'database',
    })).rejects.toThrow();

    // With an arm64 row present, the same installed scan does reuse it.
    seedScan({ vulnDbUpdatedAt: DB_BUILD, platform: 'linux/arm64' });
    const result = await svc().scanImage('registry.example.com/web:latest', 1, {
      scanners: ['vuln'], cacheRule: 'database',
    });
    expect(result.fromCache).toBe(true);
    expect(result.platform).toBe('linux/arm64');
    expect(result.imageDigest).toBe(DIGEST);
  });

  it('records the platform a candidate scan resolved', async () => {
    const scanImage = vi.spyOn(svc(), 'scanImage').mockResolvedValue({
      imageRef: 'registry.example.com/web:latest',
      imageDigest: DIGEST,
      platform: PLATFORM,
      scannedAt: Date.now(),
      totalVulnerabilities: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0,
      unknownCount: 0, fixableCount: 0, secretCount: 0, scannersUsed: 'vuln', highestSeverity: null,
      vulnerabilities: [], secrets: [],
      metadata: { os: null, trivyVersion: '0.50.0', scanDurationMs: 5 },
    });

    const stored = await svc().scanImagePreflight('registry.example.com/web:latest', 1, 'web', {
      scanRef: `registry.example.com/web@${DIGEST}`,
      digest: DIGEST,
      platform: PLATFORM,
      useCache: false,
    });

    expect(scanImage).toHaveBeenCalledWith(
      'registry.example.com/web:latest', 1,
      expect.objectContaining({ platform: PLATFORM }),
    );
    expect(stored.platform).toBe(PLATFORM);
  });
});

describe('recording the database revision', () => {
  it('writes the revision read after the scan finishes', async () => {
    const scanId = seedScan({ vulnDbUpdatedAt: null });
    const info = vi.spyOn(svc(), 'getVulnerabilityDbInfo').mockResolvedValue({
      updatedAt: DB_BUILD, nextUpdate: NEXT_UPDATE, readAt: Date.now(),
    });
    vi.spyOn(svc(), 'scanImage').mockResolvedValue({
      imageRef: 'registry.example.com/web:latest',
      imageDigest: DIGEST,
      scannedAt: Date.now(),
      totalVulnerabilities: 0,
      criticalCount: 0,
      highCount: 0,
      mediumCount: 0,
      lowCount: 0,
      unknownCount: 0,
      fixableCount: 0,
      secretCount: 0,
      scannersUsed: 'vuln',
      highestSeverity: null,
      vulnerabilities: [],
      secrets: [],
      metadata: { os: null, trivyVersion: '0.50.0', scanDurationMs: 5 },
    });

    const stored = await svc().finishScan(scanId, 'registry.example.com/web:latest', 1, {
      useCache: true, scanners: ['vuln'], digest: DIGEST,
    });

    // Read after the scan, because a database download during it is the revision
    // these findings actually came from.
    expect(info).toHaveBeenCalledWith({ refresh: true });
    expect(stored.vuln_db_updated_at).toBe(DB_BUILD);
    // The digest the gate evaluated is the row's digest, not a fresh local one.
    expect(stored.image_digest).toBe(DIGEST);
  });

  it('keeps the cached row\'s revision on a cache hit, never the build that arrived since', async () => {
    // A manual or post-deploy scan may still reuse a row from an older database.
    // Stamping the current build on those findings would claim they were checked
    // against it.
    const olderBuild = DB_BUILD - 24 * 60 * 60 * 1000;
    const scanId = seedScan({ vulnDbUpdatedAt: olderBuild });

    const stored = await svc().finishScan(scanId, 'registry.example.com/web:latest', 1, {
      useCache: true, scanners: ['vuln'], digest: DIGEST, cacheRule: 'digest',
    });

    expect(stored.vuln_db_updated_at).toBe(olderBuild);
  });

  it('keeps the authored tag as the row identity while scanning the exact manifest', async () => {
    const scanImage = vi.spyOn(svc(), 'scanImage').mockResolvedValue({
      imageRef: 'registry.example.com/web:latest',
      imageDigest: DIGEST,
      scannedAt: Date.now(),
      totalVulnerabilities: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0,
      unknownCount: 0, fixableCount: 0, secretCount: 0, scannersUsed: 'vuln', highestSeverity: null,
      vulnerabilities: [], secrets: [],
      metadata: { os: null, trivyVersion: '0.50.0', scanDurationMs: 5 },
    });
    await svc().scanImagePreflight('registry.example.com/web:latest', 1, 'web', {
      scanRef: `registry.example.com/web@${DIGEST}`,
      digest: DIGEST,
    });
    expect(scanImage).toHaveBeenCalledWith(
      'registry.example.com/web:latest', 1,
      expect.objectContaining({
        scanRef: `registry.example.com/web@${DIGEST}`,
        digest: DIGEST,
        useCache: true,
        cacheRule: 'database',
      }),
    );
  });

  it('forwards an explicit cache bypass for a multi-platform index', async () => {
    const scanImage = vi.spyOn(svc(), 'scanImage').mockResolvedValue({
      imageRef: 'registry.example.com/web:latest',
      imageDigest: DIGEST,
      scannedAt: Date.now(),
      totalVulnerabilities: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0,
      unknownCount: 0, fixableCount: 0, secretCount: 0, scannersUsed: 'vuln', highestSeverity: null,
      vulnerabilities: [], secrets: [],
      metadata: { os: null, trivyVersion: '0.50.0', scanDurationMs: 5 },
    });
    await svc().scanImagePreflight('registry.example.com/web:latest', 1, 'web', {
      scanRef: `registry.example.com/web@${DIGEST}`,
      digest: DIGEST,
      useCache: false,
    });
    expect(scanImage).toHaveBeenCalledWith(
      'registry.example.com/web:latest', 1,
      expect.objectContaining({ useCache: false }),
    );
  });
});
