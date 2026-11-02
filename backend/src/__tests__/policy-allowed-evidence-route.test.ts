/**
 * An operation the gate allows on evidence that was not a clean pass must say so.
 *
 * Driven through the real stack routes, the real gate, and the real database,
 * because the defect these cover lived in the seams: the engine produced the
 * evidence, the shared helpers returned a bare boolean, and every successful
 * caller therefore discarded it. A clean pass and an allowed-on-failed-scan
 * deploy returned the same body and left the same trace.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

vi.mock('../services/FileSystemService', () => ({
  FileSystemService: {
    getInstance: () => ({
      getStacks: vi.fn().mockResolvedValue([]),
      getBaseDir: () => '/tmp/compose',
      readComposeFile: vi.fn().mockResolvedValue(''),
      hasComposeFile: vi.fn().mockResolvedValue(true),
    }),
  },
}));

let tmpDir: string;
let app: import('express').Express;
let authCookie: string;
let deploySpy: ReturnType<typeof vi.spyOn>;
let trivyAvailableSpy: ReturnType<typeof vi.spyOn>;
let scanSpy: ReturnType<typeof vi.spyOn>;

const CLEAN_SCAN = {
  id: 42,
  node_id: 1,
  image_ref: 'nginx:1.27',
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
  stack_context: 'evidence-app',
  policy_evaluation: null,
} as const;

async function auditSummaries(): Promise<string[]> {
  const { DatabaseService } = await import('../services/DatabaseService');
  const db = DatabaseService.getInstance();
  db.flushAuditLogBuffer();
  return db.getAuditLogsInRange(0, Date.now() + 60_000, 1000).map((e) => e.summary);
}

async function auditEntries() {
  const { DatabaseService } = await import('../services/DatabaseService');
  const db = DatabaseService.getInstance();
  db.flushAuditLogBuffer();
  return db.getAuditLogsInRange(0, Date.now() + 60_000, 1000);
}

async function setSettings(values: Record<string, string>): Promise<void> {
  const { DatabaseService } = await import('../services/DatabaseService');
  DatabaseService.getInstance().updateGlobalSettings(values);
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authCookie = await loginAsTestAdmin(app);

  const { ComposeService } = await import('../services/ComposeService');
  vi.spyOn(ComposeService.prototype, 'listStackImages').mockResolvedValue(['nginx:1.27']);
  // The route's Docker endpoint check renders the stack's Compose config; this test is about the policy gate that follows it.
  vi.spyOn(ComposeService.prototype, 'evaluateDockerEndpoint').mockResolvedValue(null);
  // The update policy renders the stack before an unattended or manual update
  // may run, so the model answers for the label set this suite expects.
  vi.spyOn(ComposeService.prototype, 'renderConfig').mockResolvedValue({
    rendered: JSON.stringify({ services: { web: { image: 'nginx:1' } } }),
    stderr: '', code: 0, timedOut: false,
  });
  deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockResolvedValue({ recoveryId: null, deployedGenerationId: null, gitopsOperationId: null });

  const TrivyService = (await import('../services/TrivyService')).default;
  const trivy = TrivyService.getInstance();
  trivyAvailableSpy = vi.spyOn(trivy, 'isTrivyAvailable').mockReturnValue(true);
  scanSpy = vi.spyOn(trivy, 'scanImagePreflight').mockResolvedValue({ ...CLEAN_SCAN });

  const { DatabaseService } = await import('../services/DatabaseService');
  DatabaseService.getInstance().createScanPolicy({
    name: 'evidence-gate',
    node_id: null,
    node_identity: '',
    stack_pattern: 'evidence-*',
    max_severity: 'HIGH',
    block_on_deploy: 1,
    block_on_severity: 1,
    block_on_kev: 0,
    block_on_fixable: 0,
    enabled: 1,
    replicated_from_control: 0,
  });
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

beforeEach(async () => {
  deploySpy.mockClear();
  trivyAvailableSpy.mockReturnValue(true);
  scanSpy.mockReset().mockResolvedValue({ ...CLEAN_SCAN });
  await setSettings({
    security_scanner_unavailable: 'allow',
    security_scan_failure: 'block',
  });
});

describe('a deploy allowed on incomplete evidence', () => {
  it('reports the decision in the response when the scanner is missing and that is allowed', async () => {
    trivyAvailableSpy.mockReturnValue(false);
    const res = await request(app).post('/api/stacks/evidence-no-scanner/deploy').set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(deploySpy).toHaveBeenCalled();
    expect(res.body.policyEvidence).toMatchObject({
      policy: { name: 'evidence-gate' },
      bypassed: false,
      evidence: {
        outcome: 'allow',
        records: [expect.objectContaining({ source: 'scanner_availability', state: 'unavailable' })],
        applications: [expect.objectContaining({ rule: 'security_scanner_unavailable=allow' })],
      },
    });
    // The durable half names who and what triggered the allowed decision.
    const rows = (await auditEntries()).filter((e) => e.summary.startsWith('policy.evidence_allowed') && e.summary.includes('stack="evidence-no-scanner"'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ username: 'testadmin', method: 'POST', path: '/api/stacks/evidence-no-scanner/deploy' });
    expect(rows[0].summary).toContain('scanner_availability:unavailable:(node)');
    expect(rows[0].summary).toContain('security_scanner_unavailable=allow');
  });

  it('reports the decision in the response when a failed scan is allowed, and leaves an audit row', async () => {
    await setSettings({ security_scan_failure: 'allow' });
    scanSpy.mockRejectedValue(new Error('scan process crashed'));

    const res = await request(app).post('/api/stacks/evidence-failed-scan/deploy').set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body.policyEvidence.evidence.records).toEqual([
      expect.objectContaining({ source: 'vulnerability_scan', state: 'failed', target: 'nginx:1.27' }),
    ]);
    expect(res.body.policyEvidence.evidence.applications).toEqual([
      expect.objectContaining({ rule: 'security_scan_failure=allow', target: 'nginx:1.27' }),
    ]);
    const rows = (await auditSummaries()).filter((s) => s.startsWith('policy.evidence_allowed') && s.includes('stack="evidence-failed-scan"'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('vulnerability_scan:failed:nginx:1.27');
    expect(rows[0]).toContain('security_scan_failure=allow@nginx:1.27');
  });

  it('is distinguishable from a clean pass, which reports and records nothing', async () => {
    const res = await request(app).post('/api/stacks/evidence-clean/deploy').set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('policyEvidence');
    const rows = (await auditSummaries()).filter((s) => s.includes('stack="evidence-clean"'));
    expect(rows).toEqual([]);
  });

  it('reports the decision from the update route too', async () => {
    trivyAvailableSpy.mockReturnValue(false);
    const { StackUpdateOrchestrator } = await import('../services/StackUpdateOrchestrator');
    vi.spyOn(StackUpdateOrchestrator.prototype, 'execute').mockResolvedValue({ kind: 'stack_compose_done', recoveryId: null, deployedGenerationId: null } as never);

    const res = await request(app).post('/api/stacks/evidence-update/update').set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body.policyEvidence?.evidence.records[0]).toMatchObject({ state: 'unavailable' });
  });
});
