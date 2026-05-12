/**
 * Covers the pre-deploy policy gate across the six behaviours defined in the
 * PR 1 plan: no-policy, disabled-policy, Trivy-missing (fail open),
 * violation, admin bypass (audit-logged), compose-parse-failure (fail closed).
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

import { enforcePolicyForImageRefs, enforcePolicyPreDeploy } from '../services/PolicyEnforcement';

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
    notificationStub.dispatchAlert.mockReset();
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
    expect(trivyStub.scanImagePreflight).not.toHaveBeenCalled();
    expect(composeStub.listStackImages).not.toHaveBeenCalled();
  });
});
