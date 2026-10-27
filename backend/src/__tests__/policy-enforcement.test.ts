/**
 * Covers the pre-deploy policy gate: no-policy, disabled-policy, Trivy-missing
 * (fail open + notification de-dup), violation, admin bypass (audit-logged),
 * and compose-parse-failure (fail closed) paths.
 *
 * The gate is the only code path that can block a `docker compose up`, so
 * regressions here are high-impact. We stub the four collaborators the helper
 * talks to rather than spinning up the real services, since the contracts
 * between them are stable and already exercised by their own tests.
 */
import { format } from 'node:util';
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import type { ScanPolicy, VulnerabilityScan } from '../services/DatabaseService';

interface TrivyStub {
  isTrivyAvailable: ReturnType<typeof vi.fn>;
  scanImagePreflight: ReturnType<typeof vi.fn>;
}
interface ComposeStub {
  listStackImages: ReturnType<typeof vi.fn>;
}
interface DbStub {
  getMatchingPolicy: ReturnType<typeof vi.fn>;
  insertAuditLog: ReturnType<typeof vi.fn>;
  getGlobalSettings: ReturnType<typeof vi.fn>;
  getAllVulnerabilityDetails: ReturnType<typeof vi.fn>;
  getCveSuppressions: ReturnType<typeof vi.fn>;
  getCveIntel: ReturnType<typeof vi.fn>;
}
interface NotificationStub {
  dispatchAlert: ReturnType<typeof vi.fn>;
}

const trivyStub: TrivyStub = {
  isTrivyAvailable: vi.fn(),
  scanImagePreflight: vi.fn(),
};
const composeStub: ComposeStub = {
  listStackImages: vi.fn(),
};
const dbStub: DbStub = {
  getMatchingPolicy: vi.fn(),
  insertAuditLog: vi.fn(),
  getGlobalSettings: vi.fn(),
  getAllVulnerabilityDetails: vi.fn(),
  getCveSuppressions: vi.fn(),
  getCveIntel: vi.fn(),
};
const notificationStub: NotificationStub = {
  dispatchAlert: vi.fn(),
};

vi.mock('../services/TrivyService', () => ({
  default: { getInstance: () => trivyStub },
}));
vi.mock('../services/ComposeService', () => ({
  ComposeService: { getInstance: () => composeStub },
}));
vi.mock('../services/DatabaseService', () => ({
  DatabaseService: { getInstance: () => dbStub },
}));
vi.mock('../services/NotificationService', () => ({
  NotificationService: { getInstance: () => notificationStub },
}));
vi.mock('../services/FleetSyncService', () => ({
  FleetSyncService: { getSelfIdentity: () => 'self-node' },
}));

import {
  _resetTrivyMissingNotificationStateForTests,
  enforcePolicyForImageRefs,
  enforcePolicyPreDeploy,
  evaluateCandidatePolicy,
} from '../services/PolicyEnforcement';

function mkPolicy(overrides: Partial<ScanPolicy> = {}): ScanPolicy {
  return {
    id: 1,
    name: 'block-high',
    node_id: null,
    node_identity: 'self-node',
    stack_pattern: '*',
    max_severity: 'HIGH',
    block_on_deploy: 1,
    enabled: 1,
    block_on_severity: 1,
    block_on_kev: 0,
    block_on_fixable: 0,
    replicated_from_control: 0,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

function mkScan(overrides: Partial<VulnerabilityScan> = {}): VulnerabilityScan {
  return {
    id: 1,
    node_id: 1,
    image_ref: 'nginx:1.14',
    image_digest: null,
    scanned_at: Date.now(),
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
    highest_severity: 'LOW',
    os_info: null,
    trivy_version: '0.50.0',
    scan_duration_ms: null,
    triggered_by: 'deploy-preflight',
    status: 'completed',
    error: null,
    stack_context: 'web',
    policy_evaluation: null,
    ...overrides,
  };
}

describe('enforcePolicyPreDeploy', () => {
  beforeEach(() => {
    trivyStub.isTrivyAvailable.mockReset();
    trivyStub.scanImagePreflight.mockReset();
    composeStub.listStackImages.mockReset();
    dbStub.getMatchingPolicy.mockReset();
    dbStub.insertAuditLog.mockReset();
    dbStub.getGlobalSettings.mockReset();
    dbStub.getAllVulnerabilityDetails.mockReset();
    dbStub.getCveSuppressions.mockReset();
    // Default: suppression-aware blocking off, so behavior matches the raw-scan
    // path unless a test opts in.
    dbStub.getGlobalSettings.mockReturnValue({});
    dbStub.getAllVulnerabilityDetails.mockReturnValue([]);
    dbStub.getCveSuppressions.mockReturnValue([]);
    dbStub.getCveIntel.mockReset().mockReturnValue(new Map());
    notificationStub.dispatchAlert.mockReset();
    _resetTrivyMissingNotificationStateForTests();
  });

  it('allows deploy when no matching policy exists', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(null);

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u' });

    expect(result.ok).toBe(true);
    expect(result.bypassed).toBe(false);
    expect(result.violations).toEqual([]);
    expect(result.policy).toBeUndefined();
    expect(trivyStub.isTrivyAvailable).not.toHaveBeenCalled();
    expect(composeStub.listStackImages).not.toHaveBeenCalled();
  });

  it('allows deploy when the matching policy is disabled', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy({ enabled: 0 }));

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u' });

    expect(result.ok).toBe(true);
    expect(result.bypassed).toBe(false);
    expect(result.violations).toEqual([]);
    expect(composeStub.listStackImages).not.toHaveBeenCalled();
  });

  it('allows deploy when the matching policy does not block on deploy', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy({ block_on_deploy: 0 }));

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u' });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(composeStub.listStackImages).not.toHaveBeenCalled();
  });

  it('fails open with a warning alert when Trivy is not installed', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy());
    trivyStub.isTrivyAvailable.mockReturnValue(false);

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u' });

    expect(result.ok).toBe(true);
    expect(result.trivyMissing).toBe(true);
    expect(result.violations).toEqual([]);
    expect(notificationStub.dispatchAlert).toHaveBeenCalledTimes(1);
    expect(notificationStub.dispatchAlert.mock.calls[0][0]).toBe('warning');
    expect(notificationStub.dispatchAlert.mock.calls[0][1]).toBe('scan_finding');
    expect(notificationStub.dispatchAlert.mock.calls[0][2]).toContain('Trivy not installed');
    expect(composeStub.listStackImages).not.toHaveBeenCalled();
  });

  it('collapses repeated trivy-missing notifications for the same stack within the cooldown', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy());
    trivyStub.isTrivyAvailable.mockReturnValue(false);

    for (let i = 0; i < 5; i++) {
      const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u' });
      expect(result.trivyMissing).toBe(true);
    }

    expect(notificationStub.dispatchAlert).toHaveBeenCalledTimes(1);
  });

  it('dispatches a separate trivy-missing notification per stack', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy());
    trivyStub.isTrivyAvailable.mockReturnValue(false);

    await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u' });
    await enforcePolicyPreDeploy('db', 1, { bypass: false, actor: 'u' });
    await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u' });
    await enforcePolicyPreDeploy('db', 1, { bypass: false, actor: 'u' });

    expect(notificationStub.dispatchAlert).toHaveBeenCalledTimes(2);
    const stackNames = notificationStub.dispatchAlert.mock.calls.map((c) => (c[3] as { stackName: string }).stackName);
    expect(stackNames).toEqual(['web', 'db']);
  });

  it('dispatches a separate trivy-missing notification per node for the same stack name', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy());
    trivyStub.isTrivyAvailable.mockReturnValue(false);

    await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u' });
    await enforcePolicyPreDeploy('web', 2, { bypass: false, actor: 'u' });
    await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u' });
    await enforcePolicyPreDeploy('web', 2, { bypass: false, actor: 'u' });

    expect(notificationStub.dispatchAlert).toHaveBeenCalledTimes(2);
  });

  it('redispatches the trivy-missing notification after the cooldown elapses', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy());
    trivyStub.isTrivyAvailable.mockReturnValue(false);
    const nowSpy = vi.spyOn(Date, 'now');
    const start = 1_700_000_000_000;
    nowSpy.mockReturnValue(start);

    await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u' });
    nowSpy.mockReturnValue(start + 30 * 60 * 1000);
    await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u' });
    expect(notificationStub.dispatchAlert).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(start + 60 * 60 * 1000 + 1);
    await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u' });
    expect(notificationStub.dispatchAlert).toHaveBeenCalledTimes(2);

    nowSpy.mockRestore();
  });

  it('blocks deploy when a scanned image exceeds the policy severity', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy());
    trivyStub.isTrivyAvailable.mockReturnValue(true);
    composeStub.listStackImages.mockResolvedValue(['nginx:1.14']);
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan({
      id: 99,
      highest_severity: 'CRITICAL',
      critical_count: 2,
      high_count: 5,
    }));

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u' });

    expect(result.ok).toBe(false);
    expect(result.bypassed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      imageRef: 'nginx:1.14',
      severity: 'CRITICAL',
      criticalCount: 2,
      highCount: 5,
      scanId: 99,
    });
    expect(dbStub.insertAuditLog).not.toHaveBeenCalled();
  });

  it('allows deploy on admin bypass and records a policy.bypass audit entry', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy());
    trivyStub.isTrivyAvailable.mockReturnValue(true);
    composeStub.listStackImages.mockResolvedValue(['nginx:1.14']);
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan({
      id: 99,
      highest_severity: 'CRITICAL',
      critical_count: 2,
    }));

    const result = await enforcePolicyPreDeploy('web', 1, {
      bypass: true,
      actor: 'admin',
      ip: '10.0.0.1',
    });

    expect(result.ok).toBe(true);
    expect(result.bypassed).toBe(true);
    expect(result.violations).toHaveLength(1);
    expect(dbStub.insertAuditLog).toHaveBeenCalledTimes(1);
    const entry = dbStub.insertAuditLog.mock.calls[0][0];
    expect(entry.username).toBe('admin');
    expect(entry.ip_address).toBe('10.0.0.1');
    expect(entry.node_id).toBe(1);
    expect(entry.summary).toContain('policy.bypass');
    expect(entry.summary).toContain('nginx:1.14');
  });

  it('fails closed with a synthetic violation when compose parse fails', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy());
    trivyStub.isTrivyAvailable.mockReturnValue(true);
    composeStub.listStackImages.mockRejectedValue(new Error('compose file missing'));

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u' });

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].imageRef).toBe('(compose parse error)');
    expect(result.violations[0].severity).toBe('UNKNOWN');
    // The block is unactionable without naming why the gate ran a synthetic block.
    expect(result.violations[0].error).toMatch(/compose file missing/i);
    expect(trivyStub.scanImagePreflight).not.toHaveBeenCalled();
  });

  it('records a violation when an individual image scan throws', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy());
    trivyStub.isTrivyAvailable.mockReturnValue(true);
    composeStub.listStackImages.mockResolvedValue(['nginx:1.14']);
    trivyStub.scanImagePreflight.mockRejectedValue(new Error('trivy crashed'));

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u' });

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].imageRef).toBe('nginx:1.14');
    expect(result.violations[0].severity).toBe('UNKNOWN');
    expect(result.violations[0].scanId).toBe(0);
    // The synthetic violation must carry the scan failure reason so the block is
    // actionable rather than an unexplained zero-count block.
    expect(result.violations[0].error).toMatch(/trivy crashed/i);
  });

  it('records an evaluation-failure violation that keeps the scan id and names the reason', async () => {
    // A KEV policy forces the per-finding detail path, and an intel lookup that
    // throws after a successful scan exercises the evaluation-failure catch,
    // which (unlike a scan failure) keeps the real scan id.
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy({ block_on_severity: 0, block_on_kev: 1 }));
    trivyStub.isTrivyAvailable.mockReturnValue(true);
    composeStub.listStackImages.mockResolvedValue(['nginx:1.14']);
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan({ id: 42, total_vulnerabilities: 1, highest_severity: 'CRITICAL', critical_count: 1 }));
    dbStub.getAllVulnerabilityDetails.mockReturnValue([
      { id: 1, scan_id: 42, vulnerability_id: 'CVE-2024-1', pkg_name: 'p', installed_version: '1', fixed_version: null, severity: 'CRITICAL', title: null, description: null, primary_url: null },
    ]);
    dbStub.getCveIntel.mockImplementation(() => { throw new Error('intel db read failed'); });

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u' });

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].scanId).toBe(42);
    expect(result.violations[0].error).toMatch(/policy evaluation failed/i);
  });

  it('skips image refs that fail validation without calling the scanner', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy());
    trivyStub.isTrivyAvailable.mockReturnValue(true);
    composeStub.listStackImages.mockResolvedValue(['not a valid ref!!!', 'nginx:1.14']);
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan({ highest_severity: 'LOW' }));

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u' });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(trivyStub.scanImagePreflight).toHaveBeenCalledTimes(1);
    expect(trivyStub.scanImagePreflight).toHaveBeenCalledWith('nginx:1.14', 1, 'web');
  });

  it('allows deploy when all scans fall below the policy threshold', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy({ max_severity: 'CRITICAL' }));
    trivyStub.isTrivyAvailable.mockReturnValue(true);
    composeStub.listStackImages.mockResolvedValue(['nginx:1.14', 'redis:7']);
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan({ highest_severity: 'HIGH' }));

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u' });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(trivyStub.scanImagePreflight).toHaveBeenCalledTimes(2);
  });

  it('enforces a supplied image list without reading compose from disk', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy());
    trivyStub.isTrivyAvailable.mockReturnValue(true);
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan({
      id: 42,
      highest_severity: 'HIGH',
      high_count: 1,
    }));

    const result = await enforcePolicyForImageRefs('blueprint-web', 1, ['nginx:1.27-alpine'], { bypass: false, actor: 'u' });

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      imageRef: 'nginx:1.27-alpine',
      severity: 'HIGH',
      highCount: 1,
      scanId: 42,
    });
    expect(composeStub.listStackImages).not.toHaveBeenCalled();
  });

  it('fails closed on invalid supplied image refs when requested', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy());
    trivyStub.isTrivyAvailable.mockReturnValue(true);

    const result = await enforcePolicyForImageRefs('blueprint-web', 1, ['${IMAGE}'], { bypass: false, actor: 'u' }, undefined, true);

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      imageRef: '${IMAGE}',
      severity: 'UNKNOWN',
      scanId: 0,
    });
    expect(result.violations[0].error).toMatch(/invalid image reference/i);
    expect(trivyStub.scanImagePreflight).not.toHaveBeenCalled();
    expect(composeStub.listStackImages).not.toHaveBeenCalled();
  });
});

describe('blocked-deploy log line', () => {
  let warnSpy: MockInstance<typeof console.warn>;

  beforeEach(() => {
    trivyStub.isTrivyAvailable.mockReset().mockReturnValue(true);
    trivyStub.scanImagePreflight.mockReset();
    dbStub.getMatchingPolicy.mockReset().mockReturnValue(mkPolicy({ block_on_kev: 1, block_on_fixable: 1 }));
    dbStub.getGlobalSettings.mockReset().mockReturnValue({});
    dbStub.getAllVulnerabilityDetails.mockReset().mockReturnValue([
      { id: 1, scan_id: 42, vulnerability_id: 'CVE-2024-1', pkg_name: 'p', installed_version: '1', fixed_version: null, severity: 'CRITICAL', title: null, description: null, primary_url: null },
    ]);
    dbStub.getCveSuppressions.mockReset().mockReturnValue([]);
    dbStub.getCveIntel.mockReset().mockReturnValue(new Map());
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The total matches the one stored row, so evaluation takes the full-detail
  // path instead of the fail-closed aggregate fallback.
  function criticalScan(): VulnerabilityScan {
    return mkScan({ id: 42, total_vulnerabilities: 1, highest_severity: 'CRITICAL', critical_count: 1 });
  }

  function blockLines(): string[] {
    return warnSpy.mock.calls
      .map((args) => format(...args))
      .filter((line) => line.startsWith('[Policy] Blocked deploy'));
  }

  it('keeps the policy-inputs wording when a scanned image has a real finding', async () => {
    trivyStub.scanImagePreflight.mockResolvedValue(criticalScan());

    const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

    expect(result.ok).toBe(false);
    expect(blockLines()).toEqual([
      '[Policy] Blocked deploy for "web": 1 image(s) matched severity>=HIGH, KEV, fixable Critical/High (policy "block-high")',
    ]);
  });

  it('names the scan failure, not findings, when the image scan failed', async () => {
    trivyStub.scanImagePreflight.mockRejectedValue(new Error('trivy crashed'));

    const result = await enforcePolicyForImageRefs('web', 1, ['alpine:3.17'], { bypass: false, actor: 'u' });

    expect(result.ok).toBe(false);
    expect(blockLines()).toEqual([
      '[Policy] Blocked deploy for "web": 1 image(s) could not be evaluated (policy "block-high"): alpine:3.17: Pre-flight scan failed: trivy crashed',
    ]);
  });

  it('names an invalid image reference as the cause', async () => {
    const result = await enforcePolicyForImageRefs('web', 1, ['${IMAGE}'], { bypass: false, actor: 'u' }, undefined, true);

    expect(result.ok).toBe(false);
    expect(blockLines()).toEqual([
      '[Policy] Blocked deploy for "web": 1 image(s) could not be evaluated (policy "block-high"): ${IMAGE}: Invalid image reference; the image could not be scanned',
    ]);
  });

  it('names a policy evaluation failure as the cause', async () => {
    trivyStub.scanImagePreflight.mockResolvedValue(criticalScan());
    dbStub.getCveIntel.mockImplementation(() => { throw new Error('intel db read failed'); });

    const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

    expect(result.ok).toBe(false);
    expect(blockLines()).toEqual([
      '[Policy] Blocked deploy for "web": 1 image(s) could not be evaluated (policy "block-high"): nginx:1.14: Policy evaluation failed: intel db read failed',
    ]);
  });

  it('lists every image that could not be evaluated, each with its own cause', async () => {
    trivyStub.scanImagePreflight
      .mockRejectedValueOnce(new Error('pull timed out'))
      .mockRejectedValueOnce(new Error('trivy crashed'));

    const result = await enforcePolicyForImageRefs('web', 1, ['alpine:3.17', 'alpine:3.19'], { bypass: false, actor: 'u' });

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(2);
    expect(blockLines()).toEqual([
      '[Policy] Blocked deploy for "web": 2 image(s) could not be evaluated (policy "block-high"): alpine:3.17: Pre-flight scan failed: pull timed out; alpine:3.19: Pre-flight scan failed: trivy crashed',
    ]);
  });

  it('redacts credentials and strips control characters from a logged image reference', async () => {
    const result = await enforcePolicyForImageRefs('web', 1, ['user:secret@registry.example.com/app:1\nINJECTED'], { bypass: false, actor: 'u' }, undefined, true);

    expect(result.ok).toBe(false);
    expect(trivyStub.scanImagePreflight).not.toHaveBeenCalled();
    const lines = blockLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[redacted]@registry.example.com/app:1');
    expect(lines[0]).not.toContain('secret');
    expect(lines[0]).not.toMatch(/[\r\n]/);
  });

  it('redacts credentials and strips control characters from a logged scan error', async () => {
    trivyStub.scanImagePreflight.mockRejectedValue(new Error('pull failed: https://user:secret@registry.example.com/v2/\nstderr line'));

    const result = await enforcePolicyForImageRefs('web', 1, ['registry.example.com/app:1'], { bypass: false, actor: 'u' });

    expect(result.ok).toBe(false);
    const lines = blockLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('https://[redacted]@registry.example.com/v2/');
    expect(lines[0]).not.toContain('secret');
    expect(lines[0]).not.toMatch(/[\r\n]/);
  });

  // Trivy prints its failure as several tab-separated stderr lines, the first
  // ending in the image tag. Deleting the breaks fused the tag with the
  // timestamp ("no-such-tag2026-10-27T03:48:54ZFATAL").
  const TRIVY_STDERR = 'trivy failed for nginx:no-such-tag:\n2026-10-27T03:48:54Z\tFATAL\tFatal error\trun error: image scan error: scan error: unable to initialize a scanner';

  it('keeps the fields of a multi-line scanner error apart on the could-not-be-evaluated line', async () => {
    trivyStub.scanImagePreflight.mockRejectedValue(new Error(TRIVY_STDERR));

    await enforcePolicyForImageRefs('web', 1, ['nginx:no-such-tag'], { bypass: false, actor: 'u' });

    expect(blockLines()).toEqual([
      '[Policy] Blocked deploy for "web": 1 image(s) could not be evaluated (policy "block-high"): nginx:no-such-tag: Pre-flight scan failed: trivy failed for nginx:no-such-tag: 2026-10-27T03:48:54Z FATAL Fatal error run error: image scan error: scan error: unable to initialize a scanner',
    ]);
  });

  it('keeps the fields of a multi-line evaluation error apart', async () => {
    trivyStub.scanImagePreflight.mockResolvedValue(criticalScan());
    dbStub.getCveIntel.mockImplementation(() => { throw new Error('intel db read failed\r\n\tat readIntel\n\tat evaluate'); });

    await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

    expect(blockLines()).toEqual([
      '[Policy] Blocked deploy for "web": 1 image(s) could not be evaluated (policy "block-high"): nginx:1.14: Policy evaluation failed: intel db read failed at readIntel at evaluate',
    ]);
  });

  it('separates a reference carrying line breaks from the text after it', async () => {
    const result = await enforcePolicyForImageRefs('web', 1, ['app:1\nINJECTED\t:x'], { bypass: false, actor: 'u' }, undefined, true);

    expect(result.ok).toBe(false);
    expect(blockLines()).toEqual([
      '[Policy] Blocked deploy for "web": 1 image(s) could not be evaluated (policy "block-high"): app:1 INJECTED :x: Invalid image reference; the image could not be scanned',
    ]);
  });

  it('logs each cause with its own count when a block mixes a real finding and a failed scan', async () => {
    trivyStub.scanImagePreflight
      .mockResolvedValueOnce(criticalScan())
      .mockRejectedValueOnce(new Error('trivy crashed'));

    const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14', 'alpine:3.19'], { bypass: false, actor: 'u' });

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(2);

    expect(blockLines()).toEqual([
      '[Policy] Blocked deploy for "web": 1 image(s) matched severity>=HIGH, KEV, fixable Critical/High (policy "block-high")',
      '[Policy] Blocked deploy for "web": 1 image(s) could not be evaluated (policy "block-high"): alpine:3.19: Pre-flight scan failed: trivy crashed',
    ]);
  });

  describe('fail-closed on missing evidence', () => {
    const TRUNCATED = 'stored detail rows (1) do not match the scan total (5)';
    const UNREADABLE = 'stored scan evidence could not be read';

    // Five findings counted, one stored row: the cache-hit preflight shape.
    function lowOnlyTruncatedScan(): VulnerabilityScan {
      return mkScan({ id: 43, total_vulnerabilities: 5, highest_severity: 'LOW' });
    }

    it('names truncated detail rows, not matched KEV/fixable findings, for a LOW-only image', async () => {
      trivyStub.scanImagePreflight.mockResolvedValue(lowOnlyTruncatedScan());

      const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

      expect(result.ok).toBe(false);
      expect(blockLines()).toEqual([
        `[Policy] Blocked deploy for "web": 1 image(s) had evidence that could not be verified (policy "block-high"): nginx:1.14: known-exploited CVE (KEV), fixable Critical/High not verified, ${TRUNCATED}`,
      ]);
    });

    it('does not leave a trailing line break in a reference on the unverified line', async () => {
      trivyStub.scanImagePreflight.mockResolvedValue(lowOnlyTruncatedScan());

      await enforcePolicyForImageRefs('web', 1, ['nginx:1.14\n'], { bypass: false, actor: 'u' });

      expect(blockLines()).toEqual([
        `[Policy] Blocked deploy for "web": 1 image(s) had evidence that could not be verified (policy "block-high"): nginx:1.14: known-exploited CVE (KEV), fixable Critical/High not verified, ${TRUNCATED}`,
      ]);
    });

    it('names an unreadable detail set as the cause', async () => {
      trivyStub.scanImagePreflight.mockResolvedValue(lowOnlyTruncatedScan());
      dbStub.getAllVulnerabilityDetails.mockImplementation(() => { throw new Error('db locked'); });

      const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

      expect(result.ok).toBe(false);
      expect(blockLines()).toEqual([
        `[Policy] Blocked deploy for "web": 1 image(s) had evidence that could not be verified (policy "block-high"): nginx:1.14: known-exploited CVE (KEV), fixable Critical/High not verified, ${UNREADABLE}`,
      ]);
    });

    it('names the stored row count against the scan total when only some rows were kept', async () => {
      trivyStub.scanImagePreflight.mockResolvedValue(lowOnlyTruncatedScan());
      const row = { id: 1, scan_id: 43, vulnerability_id: 'CVE-2024-9', pkg_name: 'p', installed_version: '1', fixed_version: null, severity: 'LOW', title: null, description: null, primary_url: null };
      dbStub.getAllVulnerabilityDetails.mockReturnValue([row, row, row]);

      await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

      expect(blockLines()).toEqual([
        '[Policy] Blocked deploy for "web": 1 image(s) had evidence that could not be verified (policy "block-high"): nginx:1.14: known-exploited CVE (KEV), fixable Critical/High not verified, stored detail rows (3) do not match the scan total (5)',
      ]);
    });

    it('lists every image with unverified evidence on one line', async () => {
      trivyStub.scanImagePreflight.mockResolvedValue(lowOnlyTruncatedScan());

      await enforcePolicyForImageRefs('web', 1, ['nginx:1.14', 'redis:6'], { bypass: false, actor: 'u' });

      expect(blockLines()).toEqual([
        `[Policy] Blocked deploy for "web": 2 image(s) had evidence that could not be verified (policy "block-high"): nginx:1.14: known-exploited CVE (KEV), fixable Critical/High not verified, ${TRUNCATED}; redis:6: known-exploited CVE (KEV), fixable Critical/High not verified, ${TRUNCATED}`,
      ]);
    });

    it('names the cause when the suppression read is what failed', async () => {
      trivyStub.scanImagePreflight.mockResolvedValue(lowOnlyTruncatedScan());
      dbStub.getCveSuppressions.mockImplementation(() => { throw new Error('db locked'); });

      await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

      expect(blockLines()).toEqual([
        `[Policy] Blocked deploy for "web": 1 image(s) had evidence that could not be verified (policy "block-high"): nginx:1.14: known-exploited CVE (KEV), fixable Critical/High not verified, ${UNREADABLE}`,
      ]);
    });

    it('names only the unverified inputs the policy enables', async () => {
      dbStub.getMatchingPolicy.mockReturnValue(mkPolicy({ block_on_kev: 1, block_on_fixable: 0 }));
      trivyStub.scanImagePreflight.mockResolvedValue(lowOnlyTruncatedScan());

      await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

      expect(blockLines()).toEqual([
        `[Policy] Blocked deploy for "web": 1 image(s) had evidence that could not be verified (policy "block-high"): nginx:1.14: known-exploited CVE (KEV) not verified, ${TRUNCATED}`,
      ]);
    });

    it('also names the severity match when the same image genuinely crosses the threshold', async () => {
      trivyStub.scanImagePreflight.mockResolvedValue(
        mkScan({ id: 44, total_vulnerabilities: 5, highest_severity: 'CRITICAL', critical_count: 2 }),
      );

      const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

      expect(result.violations[0].reasons).toEqual(['severity', 'kev', 'fixable']);
      expect(blockLines()).toEqual([
        `[Policy] Blocked deploy for "web": 1 image(s) had evidence that could not be verified (policy "block-high"): nginx:1.14: known-exploited CVE (KEV), fixable Critical/High not verified, ${TRUNCATED}; severity threshold matched`,
      ]);
    });

    // Suppressions are off, so a severity match on the aggregate is a real match:
    // the unreadable evidence is only why KEV/fixable are assumed.
    it.each([
      ['detail', () => dbStub.getAllVulnerabilityDetails.mockImplementation(() => { throw new Error('db locked'); })],
      ['suppression', () => dbStub.getCveSuppressions.mockImplementation(() => { throw new Error('db locked'); })],
    ])('keeps the severity match plain when the %s read fails with suppressions off', async (_name, failRead) => {
      trivyStub.scanImagePreflight.mockResolvedValue(
        mkScan({ id: 44, total_vulnerabilities: 5, highest_severity: 'CRITICAL', critical_count: 2 }),
      );
      failRead();

      const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

      expect(result.ok).toBe(false);
      expect(result.violations[0].reasons).toEqual(['severity', 'kev', 'fixable']);
      const lines = blockLines();
      expect(lines).toEqual([
        `[Policy] Blocked deploy for "web": 1 image(s) had evidence that could not be verified (policy "block-high"): nginx:1.14: known-exploited CVE (KEV), fixable Critical/High not verified, ${UNREADABLE}; severity threshold matched`,
      ]);
      expect(lines[0]).not.toContain('before suppressions could be applied');
    });

    // A severity-only policy with suppressions off never loads detail rows, so
    // truncated rows cannot reach the fail-closed fallback: the match is verified.
    it('keeps the matched wording for a severity-only policy when suppressions are off', async () => {
      dbStub.getMatchingPolicy.mockReturnValue(mkPolicy());
      trivyStub.scanImagePreflight.mockResolvedValue(
        mkScan({ id: 45, total_vulnerabilities: 5, highest_severity: 'CRITICAL', critical_count: 2 }),
      );

      const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

      expect(result.violations[0].reasons).toEqual(['severity']);
      expect(blockLines()).toEqual([
        '[Policy] Blocked deploy for "web": 1 image(s) matched severity>=HIGH (policy "block-high")',
      ]);
    });

    // Suppressions are off, so a stored dismissing row is not applied anywhere and
    // cannot be what the match is waiting on.
    it('keeps the severity match plain on truncated rows when suppressions are off, whatever is stored', async () => {
      dbStub.getCveSuppressions.mockReturnValue([mkSuppression({ cve_id: 'CVE-2026-0001' })]);
      trivyStub.scanImagePreflight.mockResolvedValue(
        mkScan({ id: 44, total_vulnerabilities: 5, highest_severity: 'CRITICAL', critical_count: 2 }),
      );

      const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

      expect(result.violations[0].reasons).toEqual(['severity', 'kev', 'fixable']);
      const lines = blockLines();
      expect(lines).toEqual([
        `[Policy] Blocked deploy for "web": 1 image(s) had evidence that could not be verified (policy "block-high"): nginx:1.14: known-exploited CVE (KEV), fixable Critical/High not verified, ${TRUNCATED}; severity threshold matched`,
      ]);
      expect(lines[0]).not.toContain('before suppressions could be applied');
    });

    describe('with suppressions honored', () => {
      const BEFORE_SUPPRESSIONS = 'severity threshold matched before suppressions could be applied';
      const CRITICAL_TRUNCATED = (): VulnerabilityScan =>
        mkScan({ id: 45, total_vulnerabilities: 5, highest_severity: 'CRITICAL', critical_count: 2 });
      const MATCHED_ONLY = '[Policy] Blocked deploy for "web": 1 image(s) matched severity>=HIGH (policy "block-high")';
      const UNVERIFIED_SEVERITY = `[Policy] Blocked deploy for "web": 1 image(s) had evidence that could not be verified (policy "block-high"): nginx:1.14: ${BEFORE_SUPPRESSIONS}, ${TRUNCATED}`;

      beforeEach(() => {
        dbStub.getMatchingPolicy.mockReturnValue(mkPolicy());
        dbStub.getGlobalSettings.mockReturnValue({ deploy_block_honor_suppressions: '1' });
        dbStub.getCveSuppressions.mockReturnValue([mkSuppression({ cve_id: 'CVE-2026-0001' })]);
        trivyStub.scanImagePreflight.mockResolvedValue(CRITICAL_TRUNCATED());
      });

      afterEach(() => {
        vi.unstubAllEnvs();
      });

      it('reports the severity match as unverified, not as a plain match, when the rows are truncated', async () => {
        const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

        expect(result.ok).toBe(false);
        expect(result.violations[0].reasons).toEqual(['severity']);
        expect(blockLines()).toEqual([
          `[Policy] Blocked deploy for "web": 1 image(s) had evidence that could not be verified (policy "block-high"): nginx:1.14: ${BEFORE_SUPPRESSIONS}, ${TRUNCATED}`,
        ]);
      });

      it('reads matched when no suppression is stored', async () => {
        dbStub.getCveSuppressions.mockReturnValue([]);

        const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

        expect(result.ok).toBe(false);
        expect(blockLines()).toEqual([MATCHED_ONLY]);
      });

      // Each row below is stored, so the list is non-empty, but none can dismiss
      // a finding on nginx:1.14: the raw aggregate severity equals the post-suppression one.
      it.each([
        ['scoped to another image', { image_pattern: 'redis:*' }],
        ['expired', { expires_at: 1 }],
        ['needs_review', { status: 'needs_review' }],
        ['affected', { status: 'affected' }],
      ])('reads matched when the only stored suppression is %s', async (_name, overrides) => {
        dbStub.getCveSuppressions.mockReturnValue([mkSuppression(overrides)]);

        const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

        expect(result.ok).toBe(false);
        expect(result.violations[0].reasons).toEqual(['severity']);
        expect(blockLines()).toEqual([MATCHED_ONLY]);
      });

      it('reads matched when every stored suppression is one that cannot dismiss', async () => {
        dbStub.getCveSuppressions.mockReturnValue([
          mkSuppression({ id: 1, image_pattern: 'redis:*' }),
          mkSuppression({ id: 2, expires_at: 1 }),
          mkSuppression({ id: 3, status: 'needs_review' }),
        ]);

        await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

        expect(blockLines()).toEqual([MATCHED_ONLY]);
      });

      // The truncated rows may hold the finding such a row covers, so the
      // post-suppression severity is unknown.
      it.each([
        ['image-wide', {}],
        ['matching the image by glob', { image_pattern: 'nginx:*' }],
        ['pinned to a package', { pkg_name: 'openssl' }],
        ['not_affected', { status: 'not_affected' }],
        ['not expired yet', { expires_at: Date.now() + 3_600_000 }],
      ])('reports the severity match as unverified when an active dismissing suppression is %s', async (_name, overrides) => {
        dbStub.getCveSuppressions.mockReturnValue([mkSuppression(overrides)]);

        await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

        expect(blockLines()).toEqual([UNVERIFIED_SEVERITY]);
      });

      it('reports the severity match as unverified when one usable suppression sits among ones that cannot dismiss', async () => {
        dbStub.getCveSuppressions.mockReturnValue([
          mkSuppression({ id: 1, image_pattern: 'redis:*' }),
          mkSuppression({ id: 2, status: 'needs_review' }),
          mkSuppression({ id: 3 }),
        ]);

        await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

        expect(blockLines()).toEqual([UNVERIFIED_SEVERITY]);
      });

      it('judges each image against its own suppressions', async () => {
        dbStub.getCveSuppressions.mockReturnValue([mkSuppression({ image_pattern: 'redis:*' })]);
        trivyStub.scanImagePreflight.mockResolvedValue(CRITICAL_TRUNCATED());

        await enforcePolicyForImageRefs('web', 1, ['nginx:1.14', 'redis:6'], { bypass: false, actor: 'u' });

        expect(blockLines()).toEqual([
          '[Policy] Blocked deploy for "web": 1 image(s) matched severity>=HIGH (policy "block-high")',
          `[Policy] Blocked deploy for "web": 1 image(s) had evidence that could not be verified (policy "block-high"): redis:6: ${BEFORE_SUPPRESSIONS}, ${TRUNCATED}`,
        ]);
      });

      it('names unapplied suppressions when the suppression read failed', async () => {
        dbStub.getCveSuppressions.mockImplementation(() => { throw new Error('db locked'); });

        const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

        expect(result.ok).toBe(false);
        expect(blockLines()).toEqual([
          `[Policy] Blocked deploy for "web": 1 image(s) had evidence that could not be verified (policy "block-high"): nginx:1.14: ${BEFORE_SUPPRESSIONS}, ${UNREADABLE}`,
        ]);
      });

      it('names unapplied suppressions when the detail read failed', async () => {
        dbStub.getAllVulnerabilityDetails.mockImplementation(() => { throw new Error('db locked'); });

        const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

        expect(result.ok).toBe(false);
        expect(blockLines()).toEqual([
          `[Policy] Blocked deploy for "web": 1 image(s) had evidence that could not be verified (policy "block-high"): nginx:1.14: ${BEFORE_SUPPRESSIONS}, ${UNREADABLE}`,
        ]);
      });

      it('names the unapplied suppressions beside the unverified KEV/fixable inputs', async () => {
        dbStub.getMatchingPolicy.mockReturnValue(mkPolicy({ block_on_kev: 1, block_on_fixable: 1 }));

        const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

        expect(result.violations[0].reasons).toEqual(['severity', 'kev', 'fixable']);
        expect(blockLines()).toEqual([
          `[Policy] Blocked deploy for "web": 1 image(s) had evidence that could not be verified (policy "block-high"): nginx:1.14: known-exploited CVE (KEV), fixable Critical/High not verified, ${TRUNCATED}; ${BEFORE_SUPPRESSIONS}`,
        ]);
      });

      it('keeps the severity match plain beside the unverified KEV/fixable inputs when no suppression can dismiss', async () => {
        dbStub.getMatchingPolicy.mockReturnValue(mkPolicy({ block_on_kev: 1, block_on_fixable: 1 }));
        dbStub.getCveSuppressions.mockReturnValue([mkSuppression({ status: 'needs_review' })]);

        const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

        expect(result.violations[0].reasons).toEqual(['severity', 'kev', 'fixable']);
        expect(blockLines()).toEqual([
          `[Policy] Blocked deploy for "web": 1 image(s) had evidence that could not be verified (policy "block-high"): nginx:1.14: known-exploited CVE (KEV), fixable Critical/High not verified, ${TRUNCATED}; severity threshold matched`,
        ]);
      });

      it('lists the unapplied severity match under unverified, not matched, on the debug line', async () => {
        vi.stubEnv('DATA_DIR', '/unused');
        dbStub.getGlobalSettings.mockReturnValue({ deploy_block_honor_suppressions: '1', developer_mode: '1' });
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

        const scanned = logSpy.mock.calls.map((args) => format(...args)).filter((line) => line.includes('scanned:'));
        expect(scanned).toEqual(['[Policy:debug] nginx:1.14 scanned: severity=CRITICAL kev=0 fixable=0 matched=[] unverified=[severity]']);
      });

      it('lists the severity match under matched on the debug line when no suppression can dismiss', async () => {
        vi.stubEnv('DATA_DIR', '/unused');
        dbStub.getGlobalSettings.mockReturnValue({ deploy_block_honor_suppressions: '1', developer_mode: '1' });
        dbStub.getCveSuppressions.mockReturnValue([mkSuppression({ status: 'needs_review' })]);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

        const scanned = logSpy.mock.calls.map((args) => format(...args)).filter((line) => line.includes('scanned:'));
        expect(scanned).toEqual(['[Policy:debug] nginx:1.14 scanned: severity=CRITICAL kev=0 fixable=0 matched=[severity] unverified=[]']);
      });

      it('does not mark severity unverified for a KEV-only policy even when the raw severity is critical', async () => {
        dbStub.getMatchingPolicy.mockReturnValue(mkPolicy({ block_on_severity: 0, block_on_kev: 1 }));

        const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

        expect(result.violations[0].reasons).toEqual(['kev']);
        expect(blockLines()).toEqual([
          `[Policy] Blocked deploy for "web": 1 image(s) had evidence that could not be verified (policy "block-high"): nginx:1.14: known-exploited CVE (KEV) not verified, ${TRUNCATED}`,
        ]);
      });

      it('does not name suppressions for an image whose raw severity is below the threshold', async () => {
        dbStub.getMatchingPolicy.mockReturnValue(mkPolicy({ block_on_kev: 1 }));
        trivyStub.scanImagePreflight.mockResolvedValue(lowOnlyTruncatedScan());

        await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

        expect(blockLines()).toEqual([
          `[Policy] Blocked deploy for "web": 1 image(s) had evidence that could not be verified (policy "block-high"): nginx:1.14: known-exploited CVE (KEV) not verified, ${TRUNCATED}`,
        ]);
      });

      it('allows the deploy when nothing is assumed and raw severity is below the threshold', async () => {
        trivyStub.scanImagePreflight.mockResolvedValue(lowOnlyTruncatedScan());

        const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

        expect(result.ok).toBe(true);
        expect(blockLines()).toEqual([]);
      });

      it('still reads matched for an image whose full rows cross the threshold unsuppressed', async () => {
        trivyStub.scanImagePreflight.mockResolvedValue(criticalScan());

        const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

        expect(result.ok).toBe(false);
        expect(blockLines()).toEqual([
          '[Policy] Blocked deploy for "web": 1 image(s) matched severity>=HIGH (policy "block-high")',
        ]);
      });

      it('logs the unapplied suppressions and a real match on their own lines', async () => {
        trivyStub.scanImagePreflight
          .mockResolvedValueOnce(CRITICAL_TRUNCATED())
          .mockResolvedValueOnce(criticalScan());
        dbStub.getAllVulnerabilityDetails.mockImplementation((scanId: number) => (scanId === 42
          ? [{ id: 1, scan_id: 42, vulnerability_id: 'CVE-2024-1', pkg_name: 'p', installed_version: '1', fixed_version: null, severity: 'CRITICAL', title: null, description: null, primary_url: null }]
          : []));

        const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14', 'redis:6'], { bypass: false, actor: 'u' });

        expect(result.violations).toHaveLength(2);
        expect(blockLines()).toEqual([
          '[Policy] Blocked deploy for "web": 1 image(s) matched severity>=HIGH (policy "block-high")',
          `[Policy] Blocked deploy for "web": 1 image(s) had evidence that could not be verified (policy "block-high"): nginx:1.14: ${BEFORE_SUPPRESSIONS}, stored detail rows (0) do not match the scan total (5)`,
        ]);
      });

      it('keeps the plain violation, with no unverified field, and still blocks', async () => {
        const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

        expect(result.ok).toBe(false);
        expect(result.violations).toStrictEqual([{
          imageRef: 'nginx:1.14',
          severity: 'CRITICAL',
          criticalCount: 2,
          highCount: 0,
          kevCount: 0,
          fixableCount: 0,
          reasons: ['severity'],
          scanId: 45,
        }]);
      });
    });

    it('logs every cause on its own line when one block mixes all three', async () => {
      trivyStub.scanImagePreflight
        .mockResolvedValueOnce(criticalScan())
        .mockResolvedValueOnce(lowOnlyTruncatedScan())
        .mockRejectedValueOnce(new Error('trivy crashed'));
      dbStub.getAllVulnerabilityDetails.mockImplementation((scanId: number) => (scanId === 42
        ? [{ id: 1, scan_id: 42, vulnerability_id: 'CVE-2024-1', pkg_name: 'p', installed_version: '1', fixed_version: null, severity: 'CRITICAL', title: null, description: null, primary_url: null }]
        : []));

      const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14', 'redis:6', 'alpine:3.19'], { bypass: false, actor: 'u' });

      expect(result.violations).toHaveLength(3);
      expect(blockLines()).toEqual([
        '[Policy] Blocked deploy for "web": 1 image(s) matched severity>=HIGH, KEV, fixable Critical/High (policy "block-high")',
        `[Policy] Blocked deploy for "web": 1 image(s) had evidence that could not be verified (policy "block-high"): redis:6: known-exploited CVE (KEV), fixable Critical/High not verified, stored detail rows (0) do not match the scan total (5)`,
        '[Policy] Blocked deploy for "web": 1 image(s) could not be evaluated (policy "block-high"): alpine:3.19: Pre-flight scan failed: trivy crashed',
      ]);
    });

    it('keeps the plain violation, with no unverified field, for assumed KEV/fixable inputs', async () => {
      trivyStub.scanImagePreflight.mockResolvedValue(lowOnlyTruncatedScan());

      const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

      expect(result.ok).toBe(false);
      expect(result.violations).toEqual([{
        imageRef: 'nginx:1.14',
        severity: 'LOW',
        criticalCount: 0,
        highCount: 0,
        kevCount: 0,
        fixableCount: 0,
        reasons: ['kev', 'fixable'],
        scanId: 43,
      }]);
    });

    it('logs no blocked-deploy line when an admin bypasses the block', async () => {
      trivyStub.scanImagePreflight.mockResolvedValue(lowOnlyTruncatedScan());

      const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: true, actor: 'admin' });

      expect(result.bypassed).toBe(true);
      expect(blockLines()).toEqual([]);
    });

    it('redacts credentials from the image reference', async () => {
      trivyStub.scanImagePreflight.mockResolvedValue(lowOnlyTruncatedScan());

      await enforcePolicyForImageRefs('web', 1, ['user:secret@registry.example.com/app:1'], { bypass: false, actor: 'u' });

      const lines = blockLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('[redacted]@registry.example.com/app:1');
      expect(lines[0]).not.toContain('secret');
    });

    it('names a fixable-only policy\'s unverified input', async () => {
      dbStub.getMatchingPolicy.mockReturnValue(mkPolicy({ block_on_kev: 0, block_on_fixable: 1 }));
      trivyStub.scanImagePreflight.mockResolvedValue(lowOnlyTruncatedScan());

      await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

      expect(blockLines()).toEqual([
        `[Policy] Blocked deploy for "web": 1 image(s) had evidence that could not be verified (policy "block-high"): nginx:1.14: fixable Critical/High not verified, ${TRUNCATED}`,
      ]);
    });

    it('gives each unverified image its own cause', async () => {
      trivyStub.scanImagePreflight
        .mockResolvedValueOnce(lowOnlyTruncatedScan())
        .mockResolvedValueOnce(mkScan({ id: 46, total_vulnerabilities: 5, highest_severity: 'LOW' }));
      dbStub.getAllVulnerabilityDetails.mockImplementation((scanId: number) => {
        if (scanId === 46) throw new Error('db locked');
        return [];
      });

      await enforcePolicyForImageRefs('web', 1, ['nginx:1.14', 'redis:6'], { bypass: false, actor: 'u' });

      expect(blockLines()).toEqual([
        `[Policy] Blocked deploy for "web": 2 image(s) had evidence that could not be verified (policy "block-high"): nginx:1.14: known-exploited CVE (KEV), fixable Critical/High not verified, stored detail rows (0) do not match the scan total (5); redis:6: known-exploited CVE (KEV), fixable Critical/High not verified, ${UNREADABLE}`,
      ]);
    });
  });
});

interface FindingStub {
  vulnerability_id: string;
  pkg_name: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  fixed_version: string | null;
}

function mkFinding(overrides: Partial<FindingStub> = {}): FindingStub {
  return { vulnerability_id: 'CVE-2026-0001', pkg_name: 'openssl', severity: 'CRITICAL', fixed_version: null, ...overrides };
}

function mkSuppression(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    cve_id: 'CVE-2026-0001',
    pkg_name: null,
    image_pattern: null,
    reason: 'accepted after review',
    created_by: 'admin',
    created_at: Date.now(),
    expires_at: null,
    replicated_from_control: 0,
    ...overrides,
  };
}

describe('enforcePolicyForImageRefs with suppression-aware blocking', () => {
  beforeEach(() => {
    trivyStub.isTrivyAvailable.mockReset().mockReturnValue(true);
    trivyStub.scanImagePreflight.mockReset();
    composeStub.listStackImages.mockReset();
    dbStub.getMatchingPolicy.mockReset().mockReturnValue(mkPolicy());
    dbStub.insertAuditLog.mockReset();
    dbStub.getGlobalSettings.mockReset().mockReturnValue({ deploy_block_honor_suppressions: '1' });
    dbStub.getAllVulnerabilityDetails.mockReset().mockReturnValue([]);
    dbStub.getCveSuppressions.mockReset().mockReturnValue([]);
    dbStub.getCveIntel.mockReset().mockReturnValue(new Map());
    notificationStub.dispatchAlert.mockReset();
    _resetTrivyMissingNotificationStateForTests();
  });

  it('allows the deploy and audits when a suppression covers the sole blocking CVE', async () => {
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan({ id: 7, highest_severity: 'CRITICAL', critical_count: 1, total_vulnerabilities: 1 }));
    dbStub.getAllVulnerabilityDetails.mockReturnValue([mkFinding({ vulnerability_id: 'CVE-2026-0001', severity: 'CRITICAL' })]);
    dbStub.getCveSuppressions.mockReturnValue([mkSuppression({ cve_id: 'CVE-2026-0001' })]);

    const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'admin', ip: '10.0.0.2' });

    expect(result.ok).toBe(true);
    expect(result.bypassed).toBe(false);
    expect(result.violations).toEqual([]);
    expect(dbStub.insertAuditLog).toHaveBeenCalledTimes(1);
    const entry = dbStub.insertAuditLog.mock.calls[0][0];
    expect(entry.summary).toContain('policy.suppression_pass');
    expect(entry.summary).toContain('CVE-2026-0001');
    expect(entry.summary).toContain('nginx:1.14');
    expect(entry.username).toBe('admin');
  });

  it('still blocks when only some of the blocking findings are suppressed, with recomputed counts', async () => {
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan({ id: 8, highest_severity: 'CRITICAL', critical_count: 1, high_count: 1, total_vulnerabilities: 2 }));
    dbStub.getAllVulnerabilityDetails.mockReturnValue([
      mkFinding({ vulnerability_id: 'CVE-2026-0001', pkg_name: 'openssl', severity: 'CRITICAL' }),
      mkFinding({ vulnerability_id: 'CVE-2026-0002', pkg_name: 'zlib', severity: 'HIGH' }),
    ]);
    dbStub.getCveSuppressions.mockReturnValue([mkSuppression({ cve_id: 'CVE-2026-0001' })]);

    const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ imageRef: 'nginx:1.14', severity: 'HIGH', criticalCount: 0, highCount: 1, scanId: 8 });
    expect(dbStub.insertAuditLog).not.toHaveBeenCalled();
  });

  it('does not audit when the raw scan was already below the threshold', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy({ max_severity: 'HIGH' }));
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan({ id: 9, highest_severity: 'LOW', total_vulnerabilities: 1 }));
    dbStub.getAllVulnerabilityDetails.mockReturnValue([mkFinding({ vulnerability_id: 'CVE-2026-0003', severity: 'LOW' })]);
    dbStub.getCveSuppressions.mockReturnValue([mkSuppression({ cve_id: 'CVE-2026-0003' })]);

    const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(dbStub.insertAuditLog).not.toHaveBeenCalled();
  });

  it('still blocks when the matching suppression has expired', async () => {
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan({ id: 10, highest_severity: 'CRITICAL', critical_count: 1, total_vulnerabilities: 1 }));
    dbStub.getAllVulnerabilityDetails.mockReturnValue([mkFinding({ vulnerability_id: 'CVE-2026-0001', severity: 'CRITICAL' })]);
    dbStub.getCveSuppressions.mockReturnValue([mkSuppression({ cve_id: 'CVE-2026-0001', expires_at: Date.now() - 1000 })]);

    const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

    expect(result.ok).toBe(false);
    expect(result.violations[0]).toMatchObject({ severity: 'CRITICAL', scanId: 10 });
    expect(dbStub.insertAuditLog).not.toHaveBeenCalled();
  });

  it('honors an image-pattern-scoped suppression that matches the deployed image', async () => {
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan({ id: 11, highest_severity: 'CRITICAL', critical_count: 1, total_vulnerabilities: 1 }));
    dbStub.getAllVulnerabilityDetails.mockReturnValue([mkFinding({ vulnerability_id: 'CVE-2026-0001', severity: 'CRITICAL' })]);
    dbStub.getCveSuppressions.mockReturnValue([mkSuppression({ cve_id: 'CVE-2026-0001', image_pattern: '*nginx*' })]);

    const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(dbStub.insertAuditLog).toHaveBeenCalledTimes(1);
  });

  it('aggregates a suppression-driven pass across multiple images and de-dupes CVEs in the audit', async () => {
    trivyStub.scanImagePreflight
      .mockResolvedValueOnce(mkScan({ id: 20, highest_severity: 'CRITICAL', critical_count: 1, total_vulnerabilities: 1 }))
      .mockResolvedValueOnce(mkScan({ id: 21, highest_severity: 'CRITICAL', critical_count: 2, total_vulnerabilities: 2 }));
    dbStub.getAllVulnerabilityDetails
      .mockReturnValueOnce([mkFinding({ vulnerability_id: 'CVE-2026-0001', severity: 'CRITICAL' })])
      .mockReturnValueOnce([
        mkFinding({ vulnerability_id: 'CVE-2026-0001', severity: 'CRITICAL' }),
        mkFinding({ vulnerability_id: 'CVE-2026-0009', pkg_name: 'curl', severity: 'CRITICAL' }),
      ]);
    dbStub.getCveSuppressions.mockReturnValue([
      mkSuppression({ id: 1, cve_id: 'CVE-2026-0001' }),
      mkSuppression({ id: 2, cve_id: 'CVE-2026-0009' }),
    ]);

    const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14', 'redis:7'], { bypass: false, actor: 'u' });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(dbStub.insertAuditLog).toHaveBeenCalledTimes(1);
    const summary = dbStub.insertAuditLog.mock.calls[0][0].summary as string;
    expect(summary).toContain('nginx:1.14');
    expect(summary).toContain('redis:7');
    // CVE-2026-0001 appears on both images but must be listed once.
    expect(summary.match(/CVE-2026-0001/g)).toHaveLength(1);
    expect(summary).toContain('CVE-2026-0009');
  });

  it('does not audit a suppression pass when another image still violates the policy', async () => {
    trivyStub.scanImagePreflight
      .mockResolvedValueOnce(mkScan({ id: 22, highest_severity: 'CRITICAL', critical_count: 1, total_vulnerabilities: 1 }))
      .mockResolvedValueOnce(mkScan({ id: 23, highest_severity: 'CRITICAL', critical_count: 1, total_vulnerabilities: 1 }));
    dbStub.getAllVulnerabilityDetails
      .mockReturnValueOnce([mkFinding({ vulnerability_id: 'CVE-2026-0001', severity: 'CRITICAL' })])
      .mockReturnValueOnce([mkFinding({ vulnerability_id: 'CVE-2026-0099', severity: 'CRITICAL' })]);
    dbStub.getCveSuppressions.mockReturnValue([mkSuppression({ cve_id: 'CVE-2026-0001' })]);

    const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14', 'redis:7'], { bypass: false, actor: 'u' });

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ imageRef: 'redis:7', severity: 'CRITICAL' });
    expect(dbStub.insertAuditLog).not.toHaveBeenCalled();
  });

  it('short-circuits before reading findings when the policy does not block on deploy', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy({ block_on_deploy: 0 }));

    const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

    expect(result.ok).toBe(true);
    expect(trivyStub.scanImagePreflight).not.toHaveBeenCalled();
    expect(dbStub.getAllVulnerabilityDetails).not.toHaveBeenCalled();
  });

  it('still blocks when a suppression is scoped to a non-matching image pattern', async () => {
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan({ id: 24, highest_severity: 'CRITICAL', critical_count: 1, total_vulnerabilities: 1 }));
    dbStub.getAllVulnerabilityDetails.mockReturnValue([mkFinding({ vulnerability_id: 'CVE-2026-0001', severity: 'CRITICAL' })]);
    dbStub.getCveSuppressions.mockReturnValue([mkSuppression({ cve_id: 'CVE-2026-0001', image_pattern: 'registry.internal/*' })]);

    const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

    expect(result.ok).toBe(false);
    expect(result.violations[0]).toMatchObject({ severity: 'CRITICAL', scanId: 24 });
    expect(dbStub.insertAuditLog).not.toHaveBeenCalled();
  });

  it('gates on raw severity when stored detail rows are incomplete (cache-truncated scan)', async () => {
    // The scan aggregate reports 1500 findings but only one detail row is
    // present (a cache hit copies a bounded slice). The lone loaded finding is
    // suppressed, but the recompute must not trust the truncated set: a
    // blocking CVE could live in the rows that were not copied, so gate on raw.
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan({ id: 30, highest_severity: 'CRITICAL', critical_count: 5, total_vulnerabilities: 1500 }));
    dbStub.getAllVulnerabilityDetails.mockReturnValue([mkFinding({ vulnerability_id: 'CVE-2026-0001', severity: 'CRITICAL' })]);
    dbStub.getCveSuppressions.mockReturnValue([mkSuppression({ cve_id: 'CVE-2026-0001' })]);

    const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

    expect(result.ok).toBe(false);
    expect(result.violations[0]).toMatchObject({ severity: 'CRITICAL', criticalCount: 5, scanId: 30 });
    expect(dbStub.insertAuditLog).not.toHaveBeenCalled();
  });

  it('still allows the deploy when the suppression-pass audit write fails', async () => {
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan({ id: 31, highest_severity: 'CRITICAL', critical_count: 1, total_vulnerabilities: 1 }));
    dbStub.getAllVulnerabilityDetails.mockReturnValue([mkFinding({ vulnerability_id: 'CVE-2026-0001', severity: 'CRITICAL' })]);
    dbStub.getCveSuppressions.mockReturnValue([mkSuppression({ cve_id: 'CVE-2026-0001' })]);
    dbStub.insertAuditLog.mockImplementation(() => { throw new Error('audit buffer full'); });

    const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(dbStub.insertAuditLog).toHaveBeenCalledTimes(1);
  });

  it('ignores suppressions entirely when the toggle is off (identical to raw blocking)', async () => {
    dbStub.getGlobalSettings.mockReturnValue({ deploy_block_honor_suppressions: '0' });
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan({ id: 12, highest_severity: 'CRITICAL', critical_count: 1 }));
    dbStub.getCveSuppressions.mockReturnValue([mkSuppression({ cve_id: 'CVE-2026-0001' })]);

    const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

    expect(result.ok).toBe(false);
    expect(result.violations[0]).toMatchObject({ severity: 'CRITICAL', scanId: 12 });
    expect(dbStub.getAllVulnerabilityDetails).not.toHaveBeenCalled();
    expect(dbStub.insertAuditLog).not.toHaveBeenCalled();
  });
});

describe('enforcePolicyForImageRefs - risk-based inputs (KEV / fixable / optional severity)', () => {
  beforeEach(() => {
    trivyStub.isTrivyAvailable.mockReset().mockReturnValue(true);
    trivyStub.scanImagePreflight.mockReset();
    composeStub.listStackImages.mockReset();
    dbStub.getMatchingPolicy.mockReset();
    dbStub.insertAuditLog.mockReset();
    // Suppressions off by default; KEV/fixable still force a detail read.
    dbStub.getGlobalSettings.mockReset().mockReturnValue({});
    dbStub.getAllVulnerabilityDetails.mockReset().mockReturnValue([]);
    dbStub.getCveSuppressions.mockReset().mockReturnValue([]);
    dbStub.getCveIntel.mockReset().mockReturnValue(new Map());
    notificationStub.dispatchAlert.mockReset();
    _resetTrivyMissingNotificationStateForTests();
  });

  const kevIntel = (cve: string) => new Map([[cve, { kev: true, kevDate: null, epssScore: null, epssPercentile: null }]]);

  it('blocks a KEV-only policy when a known-exploited CVE is present, even at LOW severity', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy({ block_on_severity: 0, block_on_kev: 1, block_on_fixable: 0 }));
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan({ id: 40, highest_severity: 'LOW', total_vulnerabilities: 1 }));
    dbStub.getAllVulnerabilityDetails.mockReturnValue([mkFinding({ vulnerability_id: 'CVE-2026-1000', severity: 'LOW' })]);
    dbStub.getCveIntel.mockReturnValue(kevIntel('CVE-2026-1000'));

    const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

    expect(result.ok).toBe(false);
    expect(result.violations[0]).toMatchObject({ reasons: ['kev'], kevCount: 1, scanId: 40 });
  });

  it('allows a KEV-only policy when no finding is known-exploited', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy({ block_on_severity: 0, block_on_kev: 1, block_on_fixable: 0 }));
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan({ id: 41, highest_severity: 'CRITICAL', critical_count: 1, total_vulnerabilities: 1 }));
    dbStub.getAllVulnerabilityDetails.mockReturnValue([mkFinding({ vulnerability_id: 'CVE-2026-2000', severity: 'CRITICAL' })]);
    dbStub.getCveIntel.mockReturnValue(new Map());

    const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('blocks a fixable-only policy when a Critical/High finding has a fix available', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy({ block_on_severity: 0, block_on_kev: 0, block_on_fixable: 1 }));
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan({ id: 42, highest_severity: 'HIGH', high_count: 1, total_vulnerabilities: 1 }));
    dbStub.getAllVulnerabilityDetails.mockReturnValue([mkFinding({ vulnerability_id: 'CVE-2026-3000', severity: 'HIGH', fixed_version: '1.2.3' })]);

    const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

    expect(result.ok).toBe(false);
    expect(result.violations[0]).toMatchObject({ reasons: ['fixable'], fixableCount: 1, scanId: 42 });
  });

  it('allows a fixable-only policy when the Critical/High findings have no fix', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy({ block_on_severity: 0, block_on_kev: 0, block_on_fixable: 1 }));
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan({ id: 43, highest_severity: 'CRITICAL', critical_count: 1, total_vulnerabilities: 1 }));
    dbStub.getAllVulnerabilityDetails.mockReturnValue([mkFinding({ vulnerability_id: 'CVE-2026-3001', severity: 'CRITICAL', fixed_version: null })]);

    const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('does not gate on severity when the severity input is off (KEV/fixable only)', async () => {
    // A CRITICAL image with no KEV and no fix must pass a risk-first policy that
    // leaves severity off: severity alone is no longer a blocking basis.
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy({ block_on_severity: 0, block_on_kev: 1, block_on_fixable: 1, max_severity: 'LOW' }));
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan({ id: 44, highest_severity: 'CRITICAL', critical_count: 1, total_vulnerabilities: 1 }));
    dbStub.getAllVulnerabilityDetails.mockReturnValue([mkFinding({ vulnerability_id: 'CVE-2026-4000', severity: 'CRITICAL', fixed_version: null })]);
    dbStub.getCveIntel.mockReturnValue(new Map());

    const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('fails closed on a KEV input when detail rows are truncated (assume it is automatable)', async () => {
    // Aggregate reports 1500 findings but only one detail row is present; KEV
    // membership cannot be proven absent, so the gate must block.
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy({ block_on_severity: 0, block_on_kev: 1, block_on_fixable: 0 }));
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan({ id: 45, highest_severity: 'LOW', total_vulnerabilities: 1500 }));
    dbStub.getAllVulnerabilityDetails.mockReturnValue([mkFinding({ vulnerability_id: 'CVE-2026-5000', severity: 'LOW' })]);
    dbStub.getCveIntel.mockReturnValue(new Map());

    const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

    expect(result.ok).toBe(false);
    expect(result.violations[0].reasons).toContain('kev');
  });

  it('fails closed on a KEV input when the detail read throws (transient DB error)', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy({ block_on_severity: 0, block_on_kev: 1, block_on_fixable: 0 }));
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan({ id: 47, highest_severity: 'LOW', total_vulnerabilities: 3 }));
    dbStub.getAllVulnerabilityDetails.mockImplementation(() => { throw new Error('database is locked'); });

    const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

    expect(result.ok).toBe(false);
    expect(result.violations[0].reasons).toContain('kev');
  });

  it('still allows when only the severity input is set and the detail read throws', async () => {
    // Severity stays verifiable from the aggregate; a below-threshold image passes
    // even though the (honor-suppressions) detail read failed.
    dbStub.getGlobalSettings.mockReturnValue({ deploy_block_honor_suppressions: '1' });
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy({ block_on_severity: 1, block_on_kev: 0, block_on_fixable: 0, max_severity: 'HIGH' }));
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan({ id: 48, highest_severity: 'LOW', total_vulnerabilities: 2 }));
    dbStub.getAllVulnerabilityDetails.mockImplementation(() => { throw new Error('database is locked'); });

    const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('does not audit a suppression pass when the suppressed finding is not KEV (KEV policy)', async () => {
    // A non-KEV finding is suppressed under a KEV-only policy. The raw set carries
    // no KEV finding, so there is nothing the suppression "saved": no audit.
    dbStub.getGlobalSettings.mockReturnValue({ deploy_block_honor_suppressions: '1' });
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy({ block_on_severity: 0, block_on_kev: 1, block_on_fixable: 0 }));
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan({ id: 49, highest_severity: 'CRITICAL', critical_count: 1, total_vulnerabilities: 1 }));
    dbStub.getAllVulnerabilityDetails.mockReturnValue([mkFinding({ vulnerability_id: 'CVE-2026-7000', severity: 'CRITICAL' })]);
    dbStub.getCveSuppressions.mockReturnValue([mkSuppression({ cve_id: 'CVE-2026-7000' })]);
    dbStub.getCveIntel.mockReturnValue(new Map()); // CVE-2026-7000 is not KEV

    const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'u' });

    expect(result.ok).toBe(true);
    expect(dbStub.insertAuditLog).not.toHaveBeenCalled();
  });

  it('allows and audits when an honored suppression covers the sole KEV finding', async () => {
    dbStub.getGlobalSettings.mockReturnValue({ deploy_block_honor_suppressions: '1' });
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy({ block_on_severity: 0, block_on_kev: 1, block_on_fixable: 0 }));
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan({ id: 46, highest_severity: 'CRITICAL', critical_count: 1, total_vulnerabilities: 1 }));
    dbStub.getAllVulnerabilityDetails.mockReturnValue([mkFinding({ vulnerability_id: 'CVE-2026-6000', severity: 'CRITICAL' })]);
    dbStub.getCveSuppressions.mockReturnValue([mkSuppression({ cve_id: 'CVE-2026-6000' })]);
    dbStub.getCveIntel.mockReturnValue(kevIntel('CVE-2026-6000'));

    const result = await enforcePolicyForImageRefs('web', 1, ['nginx:1.14'], { bypass: false, actor: 'admin' });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(dbStub.insertAuditLog).toHaveBeenCalledTimes(1);
    expect(dbStub.insertAuditLog.mock.calls[0][0].summary).toContain('policy.suppression_pass');
  });
});

// Candidate (pre-acceptance) evaluation must not fail open the way the
// deploy-time gate deliberately does: an unresolvable scanner state must
// surface as its own `unavailable` outcome so a caller can withhold automatic
// acceptance, rather than silently reusing `ok: true`.
describe('evaluateCandidatePolicy', () => {
  beforeEach(() => {
    trivyStub.isTrivyAvailable.mockReset();
    trivyStub.scanImagePreflight.mockReset();
    composeStub.listStackImages.mockReset();
    dbStub.getMatchingPolicy.mockReset();
    dbStub.insertAuditLog.mockReset();
    dbStub.getGlobalSettings.mockReset().mockReturnValue({});
    dbStub.getAllVulnerabilityDetails.mockReset().mockReturnValue([]);
    dbStub.getCveSuppressions.mockReset().mockReturnValue([]);
    dbStub.getCveIntel.mockReset().mockReturnValue(new Map());
    notificationStub.dispatchAlert.mockReset();
    _resetTrivyMissingNotificationStateForTests();
  });

  it('reports allowed when no matching policy exists', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(null);

    const result = await evaluateCandidatePolicy('web', 1, ['nginx:1.27'], { bypass: false, actor: 'u' });

    expect(result.status).toBe('allowed');
  });

  it('reports unavailable, not allowed, when the scanner cannot be evaluated', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy());
    trivyStub.isTrivyAvailable.mockReturnValue(false);

    const result = await evaluateCandidatePolicy('web', 1, ['nginx:1.27'], { bypass: false, actor: 'u' });

    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reason).toBeTruthy();
    }
    expect(dbStub.insertAuditLog).not.toHaveBeenCalled();
  });

  it('reports blocked when a scanned image exceeds the policy severity', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy());
    trivyStub.isTrivyAvailable.mockReturnValue(true);
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan({ id: 7, highest_severity: 'CRITICAL', critical_count: 1 }));

    const result = await evaluateCandidatePolicy('web', 1, ['nginx:1.27'], { bypass: false, actor: 'u' });

    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') {
      expect(result.violations).toHaveLength(1);
    }
    expect(dbStub.insertAuditLog).not.toHaveBeenCalled();
  });

  it('reports allowed on an authorized bypass', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy());
    trivyStub.isTrivyAvailable.mockReturnValue(true);
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan({ id: 8, highest_severity: 'CRITICAL', critical_count: 1 }));

    const result = await evaluateCandidatePolicy('web', 1, ['nginx:1.27'], { bypass: true, actor: 'admin' });

    expect(result.status).toBe('allowed');
  });

  it('never reads compose from disk; the caller supplies candidate image refs', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy());
    trivyStub.isTrivyAvailable.mockReturnValue(true);
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan({ id: 9, highest_severity: 'LOW' }));

    await evaluateCandidatePolicy('web', 1, ['nginx:1.27'], { bypass: false, actor: 'u' });

    expect(composeStub.listStackImages).not.toHaveBeenCalled();
  });

  it('reports unavailable, not allowed, for an image reference that cannot be scanned', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy());
    trivyStub.isTrivyAvailable.mockReturnValue(true);

    const result = await evaluateCandidatePolicy('web', 1, ['not a valid ref!!'], { bypass: false, actor: 'u' });

    expect(result.status).toBe('unavailable');
    expect(trivyStub.scanImagePreflight).not.toHaveBeenCalled();
  });

  it('reports unavailable, not blocked, when the scanner throws for every image', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy());
    trivyStub.isTrivyAvailable.mockReturnValue(true);
    trivyStub.scanImagePreflight.mockRejectedValue(new Error('scan process crashed'));

    const result = await evaluateCandidatePolicy('web', 1, ['nginx:1.27'], { bypass: false, actor: 'u' });

    expect(result.status).toBe('unavailable');
  });

  it('still reports blocked when at least one image has a genuine scanned violation', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy());
    trivyStub.isTrivyAvailable.mockReturnValue(true);
    trivyStub.scanImagePreflight
      .mockRejectedValueOnce(new Error('scan process crashed'))
      .mockResolvedValueOnce(mkScan({ id: 11, highest_severity: 'CRITICAL', critical_count: 1 }));

    const result = await evaluateCandidatePolicy('web', 1, ['unreachable:1', 'nginx:1.27'], { bypass: false, actor: 'u' });

    expect(result.status).toBe('blocked');
  });

  it('honors an explicit bypass even when the scanner is unavailable', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy());
    trivyStub.isTrivyAvailable.mockReturnValue(false);

    const result = await evaluateCandidatePolicy('web', 1, ['nginx:1.27'], { bypass: true, actor: 'admin' });

    expect(result.status).toBe('allowed');
  });

  it('does not attribute its audit trail to a deploy that never happened', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy());
    trivyStub.isTrivyAvailable.mockReturnValue(true);
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan({ id: 10, highest_severity: 'CRITICAL', critical_count: 1 }));

    await evaluateCandidatePolicy('web', 1, ['nginx:1.27'], { bypass: true, actor: 'admin' });

    expect(dbStub.insertAuditLog).toHaveBeenCalledTimes(1);
    const entry = dbStub.insertAuditLog.mock.calls[0][0];
    expect(entry.path).not.toMatch(/\/deploy$/);
  });
});
