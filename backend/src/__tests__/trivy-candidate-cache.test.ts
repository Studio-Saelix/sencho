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
import { triggerPostDeployScan } from '../helpers/policyGate';

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
  nodeId?: number;
  trigger?: 'manual' | 'scheduled' | 'deploy' | 'deploy-preflight';
} = {}): number {
  return db().createVulnerabilityScan({
    node_id: options.nodeId ?? 1,
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
    triggered_by: options.trigger ?? 'deploy-preflight',
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

  it('misses rather than reusing a row when the local platform cannot be read', async () => {
    seedScan({ vulnDbUpdatedAt: DB_BUILD, platform: 'linux/amd64' });
    stubLocalImage({ digest: DIGEST });
    vi.spyOn(svc(), 'getImagePlatform').mockResolvedValue(null);

    // Without the platform the gate cannot prove which child a row describes,
    // so it scans instead of taking the same-digest row.
    await expect(svc().scanImage('registry.example.com/web:latest', 1, {
      scanners: ['vuln'], cacheRule: 'database',
    })).rejects.toThrow();
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

/**
 * A cache hit is the stored row's answer. It must not be written into a new row:
 * the deploy preflight and the manual scan both used to open a placeholder first,
 * so every cached scan added a history entry with the same image, digest and
 * timestamp, and the per-image retention limit pruned genuine history.
 */
describe('a cached scan reuses its row', () => {
  function scanCount(): number {
    return (db().getDb().prepare('SELECT COUNT(*) AS cnt FROM vulnerability_scans').get() as { cnt: number }).cnt;
  }

  function freshResult() {
    return {
      imageRef: 'registry.example.com/web:latest',
      imageDigest: DIGEST,
      platform: PLATFORM,
      scannedAt: Date.now(),
      totalVulnerabilities: 1, criticalCount: 1, highCount: 0, mediumCount: 0, lowCount: 0,
      unknownCount: 0, fixableCount: 0, secretCount: 0, scannersUsed: 'vuln', highestSeverity: 'CRITICAL' as const,
      vulnerabilities: [{
        vulnerabilityId: 'CVE-2026-0001', pkgName: 'openssl', installedVersion: '1', fixedVersion: null,
        severity: 'CRITICAL' as const, title: '', description: '', primaryUrl: null, status: null,
        cvssScore: null, cvssVector: null, cvssSource: null, vendorSeverity: null, purl: null,
        pkgPath: null, layerDigest: null,
      }],
      secrets: [],
      metadata: { os: null, trivyVersion: '0.50.0', scanDurationMs: 5 },
    };
  }

  it('does not insert a preflight row when the cache answers', async () => {
    // The stored row keeps the trigger of the observation it records; the
    // preflight that reused it did not scan.
    const seeded = seedScan({ vulnDbUpdatedAt: DB_BUILD, trigger: 'manual' });

    const persisted = await svc().scanImagePreflight('registry.example.com/web:latest', 1, 'web', {
      digest: DIGEST,
      platform: PLATFORM,
    });

    expect(persisted.id).toBe(seeded);
    expect(persisted.triggered_by).toBe('manual');
    expect(scanCount()).toBe(1);
  });

  it('returns the stored row from the manual cache lookup, with no insert', async () => {
    const seeded = seedScan({ vulnDbUpdatedAt: DB_BUILD });
    vi.spyOn(svc(), 'getImagePlatform').mockResolvedValue(PLATFORM);
    vi.spyOn(svc(), 'getImageDigest').mockResolvedValue(DIGEST);

    const reusable = await svc().findReusableScan('registry.example.com/web:latest', 1, {
      useCache: true,
      scanners: ['vuln'],
    });

    expect(reusable?.id).toBe(seeded);
    expect(scanCount()).toBe(1);
  });

  it('never reuses another node\'s row for a local scan', async () => {
    seedScan({ vulnDbUpdatedAt: DB_BUILD, nodeId: 2 });

    const reusable = await svc().findReusableScan('registry.example.com/web:latest', 1, {
      useCache: true,
      scanners: ['vuln'],
      digest: DIGEST,
      platform: PLATFORM,
    });
    expect(reusable).toBeNull();

    // The scan itself applies the same node scope, so it does not return the
    // other node's cached answer either.
    await expect(svc().scanImage('registry.example.com/web:latest', 1, {
      useCache: true,
      scanners: ['vuln'],
      digest: DIGEST,
      platform: PLATFORM,
      cacheRule: 'database',
    })).rejects.toThrow();
  });

  it('does not let another platform child answer the cache check', async () => {
    const seeded = seedScan({ vulnDbUpdatedAt: DB_BUILD, platform: 'linux/amd64' });

    const wrongChild = await svc().findReusableScan('registry.example.com/web:latest', 1, {
      useCache: true,
      scanners: ['vuln'],
      digest: DIGEST,
      platform: 'linux/arm64',
      cacheRule: 'database',
    });
    expect(wrongChild).toBeNull();

    const sameChild = await svc().findReusableScan('registry.example.com/web:latest', 1, {
      useCache: true,
      scanners: ['vuln'],
      digest: DIGEST,
      platform: 'linux/amd64',
      cacheRule: 'database',
    });
    expect(sameChild?.id).toBe(seeded);
  });

  it('rescans instead of copying a cached result whose row vanished', async () => {
    const placeholder = svc().beginScan('registry.example.com/web:latest', 1, 'manual');
    expect(scanCount()).toBe(1);
    // The cached row's detail set is already gone, as an orphan cleanup would
    // leave it; copying this result would report a count with no findings.
    const cached = {
      ...freshResult(),
      vulnerabilities: [],
      scannedAt: DB_BUILD - 60_000,
      fromCache: true,
      cachedScanId: 424242,
    };
    const fresh = { ...freshResult(), scannedAt: Date.now() + 60_000 };
    const scanImage = vi.spyOn(svc(), 'scanImage')
      .mockResolvedValueOnce(cached)
      .mockResolvedValueOnce(fresh);

    const stored = await svc().finishScan(placeholder, 'registry.example.com/web:latest', 1, {
      useCache: true,
      scanners: ['vuln'],
      digest: DIGEST,
      platform: PLATFORM,
      cacheRule: 'digest',
    });

    // The cached row was pruned between the scan's lookup and the reuse. The
    // placeholder is the scan that never ran, so it must run rather than store
    // the vanished row's old timestamp and findings under a new identity. The
    // replay keeps the original identity: same digest, platform and cache rule.
    expect(scanImage).toHaveBeenCalledTimes(2);
    expect(scanImage.mock.calls[1][2]).toEqual(expect.objectContaining({
      useCache: false,
      digest: DIGEST,
      platform: PLATFORM,
    }));
    expect(stored.id).toBe(placeholder);
    expect(stored.status).toBe('completed');
    expect(stored.scanned_at).toBe(fresh.scannedAt);
    expect(stored.scanned_at).not.toBe(cached.scannedAt);
    expect(stored.critical_count).toBe(1);
    expect(db().getAllVulnerabilityDetails(placeholder)).toHaveLength(1);
    expect(scanCount()).toBe(1);
  });

  it('discards a placeholder opened before a cache hit was discovered', async () => {
    const seeded = seedScan({ vulnDbUpdatedAt: DB_BUILD });
    const placeholder = svc().beginScan('registry.example.com/web:latest', 1, 'manual');
    expect(scanCount()).toBe(2);

    const stored = await svc().finishScan(placeholder, 'registry.example.com/web:latest', 1, {
      useCache: true,
      scanners: ['vuln'],
      digest: DIGEST,
      platform: PLATFORM,
      cacheRule: 'digest',
    });

    expect(stored.id).toBe(seeded);
    expect(db().getVulnerabilityScan(placeholder)).toBeNull();
    expect(scanCount()).toBe(1);
  });

  it('still inserts exactly one row, labelled with the trigger, on a cache miss', async () => {
    vi.spyOn(svc(), 'scanImage').mockResolvedValue(freshResult());

    const stored = await svc().runScanAndPersist(
      'registry.example.com/web:latest',
      1,
      'deploy-preflight',
      'web',
      { scanners: ['vuln'], digest: DIGEST, platform: PLATFORM },
    );

    expect(scanCount()).toBe(1);
    expect(stored.triggered_by).toBe('deploy-preflight');
    expect(stored.image_digest).toBe(DIGEST);
    expect(stored.total_vulnerabilities).toBe(1);
  });
});

/**
 * The post-deploy scan has its own cache pre-check before it calls
 * runScanAndPersist. It must use the node-scoped lookup too, or another node's
 * fresh row would suppress this node's scan.
 */
describe('the post-deploy scan cache is node-scoped', () => {
  function stubContainers(): void {
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDocker: () => ({
        listContainers: vi.fn().mockResolvedValue([{ Image: 'registry.example.com/web:latest' }]),
      }),
    } as unknown as DockerController);
  }

  function stubScan(): ReturnType<typeof vi.spyOn> {
    vi.spyOn(svc(), 'isTrivyAvailable').mockReturnValue(true);
    vi.spyOn(svc(), 'getImageDigest').mockResolvedValue(DIGEST);
    vi.spyOn(svc(), 'getImagePlatform').mockResolvedValue(PLATFORM);
    return vi.spyOn(svc(), 'runScanAndPersist')
      .mockResolvedValue({ critical_count: 0, high_count: 0 } as never);
  }

  it('scans when only another node has the fresh row', async () => {
    seedScan({ vulnDbUpdatedAt: DB_BUILD, nodeId: 2 });
    stubContainers();
    const scan = stubScan();

    await triggerPostDeployScan('web', 1);

    expect(scan).toHaveBeenCalledWith('registry.example.com/web:latest', 1, 'deploy', 'web');
  });

  it('skips when this node has its own fresh row', async () => {
    seedScan({ vulnDbUpdatedAt: DB_BUILD, nodeId: 1 });
    stubContainers();
    const scan = stubScan();

    await triggerPostDeployScan('web', 1);

    expect(scan).not.toHaveBeenCalled();
  });
});
