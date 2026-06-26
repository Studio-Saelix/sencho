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
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

  it('allows deploy without scanning when paid-tier blocking is disabled', async () => {
    dbStub.getMatchingPolicy.mockReturnValue(mkPolicy());

    const result = await enforcePolicyPreDeploy('web', 1, {
      bypass: false,
      actor: 'u',
      blockingEnabled: false,
    });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(trivyStub.isTrivyAvailable).not.toHaveBeenCalled();
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
