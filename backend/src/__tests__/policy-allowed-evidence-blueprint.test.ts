/**
 * A blueprint apply the gate allows on evidence that was not a clean pass must
 * say so in the response the caller is holding, not only in the audit log.
 *
 * Real route, real filesystem, real gate, real database. Only Compose and the
 * scanner are stubbed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let authCookie: string;
let trivyAvailableSpy: ReturnType<typeof vi.spyOn>;

const body = (stackName: string) => ({
  stackName,
  composeContent: 'services:\n  app:\n    image: nginx:1.27\n',
  markerContent: JSON.stringify({ blueprintId: 1, revision: 1, lastApplied: 123 }),
});

async function auditSummaries(): Promise<string[]> {
  const { DatabaseService } = await import('../services/DatabaseService');
  const db = DatabaseService.getInstance();
  db.flushAuditLogBuffer();
  return db.getAuditLogsInRange(0, Date.now() + 60_000, 1000).map((e) => e.summary);
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authCookie = await loginAsTestAdmin(app);

  const { ComposeService } = await import('../services/ComposeService');
  vi.spyOn(ComposeService.prototype, 'listStackImages').mockResolvedValue(['nginx:1.27']);
  vi.spyOn(ComposeService.prototype, 'deployStack').mockResolvedValue({ recoveryId: null, deployedGenerationId: null, gitopsOperationId: null });

  const TrivyService = (await import('../services/TrivyService')).default;
  trivyAvailableSpy = vi.spyOn(TrivyService.getInstance(), 'isTrivyAvailable');
  vi.spyOn(TrivyService.getInstance(), 'scanImagePreflight').mockResolvedValue({
    id: 1, node_id: 1, image_ref: 'nginx:1.27', image_digest: null, scanned_at: Date.now(),
    total_vulnerabilities: 0, critical_count: 0, high_count: 0, medium_count: 0, low_count: 0,
    unknown_count: 0, fixable_count: 0, secret_count: 0, misconfig_count: 0, scanners_used: 'vuln',
    highest_severity: 'LOW', os_info: null, trivy_version: '0.50.0', scan_duration_ms: null,
    triggered_by: 'deploy-preflight', status: 'completed', error: null, stack_context: null,
    policy_evaluation: null,
  });

  const { DatabaseService } = await import('../services/DatabaseService');
  DatabaseService.getInstance().createScanPolicy({
    name: 'evidence-gate', node_id: null, node_identity: '', stack_pattern: 'evidence-*',
    max_severity: 'HIGH', block_on_deploy: 1, block_on_severity: 1, block_on_kev: 0,
    block_on_fixable: 0, enabled: 1, replicated_from_control: 0,
  });
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

beforeEach(async () => {
  const { LicenseService } = await import('../services/LicenseService');
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
  const { DatabaseService } = await import('../services/DatabaseService');
  DatabaseService.getInstance().updateGlobalSettings({ security_scanner_unavailable: 'allow' });
});

describe('POST /api/blueprints/apply-local', () => {
  it('reports the decision when the scanner is missing and that is allowed, with one audit row', async () => {
    trivyAvailableSpy.mockReturnValue(false);

    const res = await request(app).post('/api/blueprints/apply-local').set('Cookie', authCookie).send(body('evidence-bp-no-scanner'));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      deployed: true,
      policyEvidence: { policy: { name: 'evidence-gate' }, evidence: { outcome: 'allow' } },
    });
    const rows = (await auditSummaries()).filter((s) => s.startsWith('policy.evidence_allowed') && s.includes('stack="evidence-bp-no-scanner"'));
    expect(rows).toHaveLength(1);
  });

  it('adds nothing to the response of a clean pass', async () => {
    trivyAvailableSpy.mockReturnValue(true);

    const res = await request(app).post('/api/blueprints/apply-local').set('Cookie', authCookie).send(body('evidence-bp-clean'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deployed: true });
  });
});
