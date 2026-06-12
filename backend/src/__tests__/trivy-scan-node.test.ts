/**
 * Unit tests for TrivyService.scanNode: scan-type selection, the per-node
 * concurrency lock, scanner-availability and empty-selection guards, and
 * partial-failure tolerance. The actual Trivy/Docker calls are mocked so the
 * orchestration is exercised without a scanner.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService, type VulnerabilityScan } from '../services/DatabaseService';

let tmpDir: string;
let TrivyService: typeof import('../services/TrivyService').default;
let DockerController: typeof import('../services/DockerController').default;
let FileSystemService: typeof import('../services/FileSystemService').FileSystemService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  TrivyService = (await import('../services/TrivyService')).default;
  DockerController = (await import('../services/DockerController')).default;
  ({ FileSystemService } = await import('../services/FileSystemService'));
});

afterAll(() => cleanupTestDb(tmpDir));

function svc() {
  return TrivyService.getInstance();
}

function fakeRow(over: Partial<VulnerabilityScan> = {}): VulnerabilityScan {
  return {
    id: 1, node_id: 1, image_ref: 'a:1', image_digest: null, scanned_at: Date.now(),
    total_vulnerabilities: 0, critical_count: 1, high_count: 2, medium_count: 0, low_count: 0, unknown_count: 0,
    fixable_count: 0, secret_count: 0, misconfig_count: 0, scanners_used: 'vuln', highest_severity: 'HIGH',
    os_info: null, trivy_version: null, scan_duration_ms: null, triggered_by: 'manual', status: 'completed',
    error: null, stack_context: null, policy_evaluation: null, ...over,
  } as VulnerabilityScan;
}

let prevSource: unknown;
beforeEach(() => {
  vi.restoreAllMocks();
  prevSource = (svc() as unknown as { source: unknown }).source;
  (svc() as unknown as { source: string }).source = 'managed';
  (svc() as unknown as { scanningNodes: Set<number> }).scanningNodes.clear();
});
afterEach(() => {
  (svc() as unknown as { source: unknown }).source = prevSource;
});

describe('TrivyService.scanNode', () => {
  it('rejects when no scan type is selected', async () => {
    await expect(svc().scanNode(1, { vulns: false, secrets: false, misconfig: false })).rejects.toThrow(/at least one/i);
  });

  it('throws when the scanner is unavailable', async () => {
    (svc() as unknown as { source: string }).source = 'none';
    await expect(svc().scanNode(1, { vulns: true, secrets: false, misconfig: false })).rejects.toThrow(/not available/i);
  });

  it('refuses a second scan while the node is already scanning', async () => {
    (svc() as unknown as { scanningNodes: Set<number> }).scanningNodes.add(1);
    await expect(svc().scanNode(1, { vulns: true, secrets: false, misconfig: false })).rejects.toThrow(/already scanning/i);
  });

  it('scans images for the selected scanners and skips stacks when misconfig is off', async () => {
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({ getImages: async () => [{ RepoTags: ['a:1'] }] } as never);
    const run = vi.spyOn(svc(), 'runScanAndPersist').mockResolvedValue(fakeRow());
    const stack = vi.spyOn(svc(), 'scanComposeStack');

    const result = await svc().scanNode(1, { vulns: true, secrets: true, misconfig: false });

    expect(run).toHaveBeenCalledWith('a:1', 1, 'manual', null, { scanners: ['vuln', 'secret'] });
    expect(stack).not.toHaveBeenCalled();
    expect(result.images).not.toBeNull();
    expect(result.stacks).toBeNull();
    expect(result.severity).toMatchObject({ critical: 1, high: 2 });
  });

  it('scans secrets only and keys the digest cache on the scanner set', async () => {
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({ getImages: async () => [{ RepoTags: ['a:1'] }] } as never);
    // Force a digest so the cache lookup runs; return null so the scan proceeds.
    vi.spyOn(svc() as unknown as { getImageDigest: (r: string, n: number) => Promise<string | null> }, 'getImageDigest')
      .mockResolvedValue('sha256:abc');
    const cacheLookup = vi.spyOn(DatabaseService.getInstance(), 'getLatestScanByDigest').mockReturnValue(null);
    const run = vi.spyOn(svc(), 'runScanAndPersist').mockResolvedValue(fakeRow({ scanners_used: 'secret' }));

    await svc().scanNode(1, { vulns: false, secrets: true, misconfig: false });

    // A secrets-only scan must not reuse a vuln-only cached row.
    expect(cacheLookup).toHaveBeenCalledWith('sha256:abc', 'secret');
    expect(run).toHaveBeenCalledWith('a:1', 1, 'manual', null, { scanners: ['secret'] });
  });

  it('scans every stack for misconfig and skips images when vulns/secrets are off', async () => {
    vi.spyOn(FileSystemService, 'getInstance').mockReturnValue({ getStacks: async () => ['web', 'db'] } as never);
    const stack = vi.spyOn(svc(), 'scanComposeStack').mockResolvedValue(fakeRow({ misconfig_count: 3, scanners_used: 'config' }));
    const run = vi.spyOn(svc(), 'runScanAndPersist');

    const result = await svc().scanNode(1, { vulns: false, secrets: false, misconfig: true });

    expect(stack).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
    expect(result.stacks).toMatchObject({ scanned: 2, failed: 0, total: 2 });
    expect(result.images).toBeNull();
  });

  it('counts a failed stack without aborting the batch', async () => {
    vi.spyOn(FileSystemService, 'getInstance').mockReturnValue({ getStacks: async () => ['ok', 'bad'] } as never);
    vi.spyOn(svc(), 'scanComposeStack').mockImplementation(async (_nodeId: number, name: string) => {
      if (name === 'bad') throw new Error('boom');
      return fakeRow({ misconfig_count: 1 });
    });

    const result = await svc().scanNode(1, { vulns: false, secrets: false, misconfig: true });

    expect(result.stacks).toMatchObject({ scanned: 1, failed: 1, total: 2 });
  });
});
