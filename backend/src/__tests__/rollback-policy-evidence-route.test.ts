/**
 * Rollback through a current recovery generation, under the evidence policy.
 *
 * Driven through the real route, the real eligibility probe, the real policy
 * engine, and the real database. Only the pieces that need a Docker daemon or a
 * Compose project on disk are stubbed: the held-image inspect, the file restore
 * context, the recovery probe, and the scanner.
 *
 * The defect these cover: the eligibility probe evaluated the policy with no
 * bypass and vetoed the rollback before the gate that honors the operator's
 * `ignorePolicy` and reports the decision. A scanner-unavailable block therefore
 * stranded a node whose only way back was this rollback, and the refusal carried
 * no policy payload, so the block dialog (and its bypass button) never opened.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

const { restoreFromContext, mockComposeUp } = vi.hoisted(() => ({
  restoreFromContext: vi.fn(),
  mockComposeUp: vi.fn(),
}));

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

vi.mock('../services/composeProjectContext', async () => {
  const actual = await vi.importActual<typeof import('../services/composeProjectContext')>('../services/composeProjectContext');
  const context = {
    validateForMutation: vi.fn().mockResolvedValue(undefined),
    backupFromContext: vi.fn().mockResolvedValue('gen'),
    restoreFromContext,
  };
  return {
    ...actual,
    resolveComposeProjectContext: vi.fn().mockResolvedValue(context),
    resolveComposeProjectContextForGeneration: vi.fn().mockResolvedValue(context),
  };
});

vi.mock('../services/ComposeService', async () => {
  const actual = await vi.importActual<typeof import('../services/ComposeService')>('../services/ComposeService');
  return {
    ...actual,
    ComposeService: {
      ...actual.ComposeService,
      getInstance: () => ({
        deployStack: vi.fn(),
        composeUpWithRecoveryOverride: mockComposeUp,
      }),
    },
  };
});

const GEN_ID = '11111111-1111-4111-8111-111111111111';
const HOLD_TAG = 'sencho-rb/aaaaaaaaaaaa/web:hold';

let tmpDir: string;
let app: import('express').Express;
let authCookie: string;
let trivyAvailableSpy: ReturnType<typeof vi.spyOn>;
let scanSpy: ReturnType<typeof vi.spyOn>;

async function db() {
  const { DatabaseService } = await import('../services/DatabaseService');
  return DatabaseService.getInstance();
}

// The audit table is not reset between tests, so each test reads only the rows it caused.
let testStartedAt = 0;

async function bypassRows() {
  const database = await db();
  database.flushAuditLogBuffer();
  return database.getAuditLogsInRange(testStartedAt, Date.now() + 60_000, 1000)
    .filter((e) => e.summary.startsWith('policy.bypass'));
}

async function insertGeneration(servicesJson?: string): Promise<void> {
  (await db()).insertStackUpdateRecoveryGeneration({
    id: GEN_ID, node_id: 1, stack_name: 'web', status: 'active', phase: 'immediate_verified',
    is_current: 1, backup_slot_id: null, content_path: null, operation_kind: 'update',
    override_path: 'rollback-override-path',
    services_json: servicesJson ?? JSON.stringify([{
      serviceName: 'web',
      scale: 1,
      hasBuild: false,
      declaredImageRef: 'nginx:latest',
      referenceKind: 'moving_tag',
      replicas: [{ containerId: 'c1', imageId: 'sha256:held', repoDigest: null, state: 'running', rollbackTag: HOLD_TAG }],
    }]),
    health_gate_id: null, gate_retain_until: null,
    artifact_expires_at: null, operation_lease_expires_at: null, created_at: Date.now(),
    updated_at: Date.now(), created_by: 'tester', artifacts_retired: 0,
    released_at: null, released_by: null,
  });
}

async function clearGenerations(): Promise<void> {
  const raw = (await db() as unknown as { db: { prepare: (s: string) => { run: () => void } } }).db;
  raw.prepare('DELETE FROM stack_update_recovery_generations').run();
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authCookie = await loginAsTestAdmin(app);

  const DockerController = (await import('../services/DockerController')).default;
  vi.spyOn(DockerController.prototype, 'getDocker').mockReturnValue({
    getImage: () => ({ inspect: vi.fn().mockResolvedValue({ Id: 'present' }) }),
  } as never);

  const { StackUpdateRecoveryService } = await import('../services/StackUpdateRecoveryService');
  vi.spyOn(StackUpdateRecoveryService.prototype, 'probeRecoveredStack').mockResolvedValue(true);

  const TrivyService = (await import('../services/TrivyService')).default;
  const trivy = TrivyService.getInstance();
  trivyAvailableSpy = vi.spyOn(trivy, 'isTrivyAvailable');
  scanSpy = vi.spyOn(trivy, 'scanImagePreflight');

  (await db()).createScanPolicy({
    name: 'rollback-gate',
    node_id: null,
    node_identity: '',
    stack_pattern: 'web',
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
  testStartedAt = Date.now();
  restoreFromContext.mockReset().mockResolvedValue(undefined);
  mockComposeUp.mockReset().mockResolvedValue(undefined);
  trivyAvailableSpy.mockReturnValue(false);
  scanSpy.mockReset().mockRejectedValue(new Error('scan engine crashed'));
  (await db()).updateGlobalSettings({
    security_scanner_unavailable: 'block',
    security_scan_failure: 'block',
  });
  await insertGeneration();
});

afterEach(async () => {
  await clearGenerations();
});

describe('rollback with the scanner unavailable and the policy set to block', () => {
  it('refuses with the decision the block dialog renders, and moves no file', async () => {
    const res = await request(app).post('/api/stacks/web/rollback').set('Cookie', authCookie);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'ROLLBACK_PROHIBITED',
      policy: { name: 'rollback-gate' },
      violations: [expect.objectContaining({ imageRef: '(scanner unavailable)' })],
      evidence: {
        outcome: 'block',
        records: [expect.objectContaining({ source: 'scanner_availability', state: 'unavailable' })],
        applications: [expect.objectContaining({ rule: 'security_scanner_unavailable=block' })],
      },
      failureClass: 'pre_mutation',
    });
    expect(restoreFromContext).not.toHaveBeenCalled();
    expect(mockComposeUp).not.toHaveBeenCalled();
  });

  it('lets an admin bypass it, and records the bypass once with the evidence clause', async () => {
    const res = await request(app).post('/api/stacks/web/rollback?ignorePolicy=true').set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(restoreFromContext).toHaveBeenCalledTimes(1);
    expect(mockComposeUp).toHaveBeenCalledTimes(1);
    expect(res.body.policyEvidence).toMatchObject({ bypassed: true, evidence: { outcome: 'block' } });

    const rows = await bypassRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toContain('scanner_availability:unavailable');
    expect(rows[0].summary).toContain('security_scanner_unavailable=block');
  });

  it('does not let a bypass reach past an integrity refusal', async () => {
    await clearGenerations();
    await insertGeneration('not json');

    const res = await request(app).post('/api/stacks/web/rollback?ignorePolicy=true').set('Cookie', authCookie);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ROLLBACK_PROHIBITED');
    expect(res.body.policy).toBeUndefined();
    expect(res.body.violations).toBeUndefined();
    expect(restoreFromContext).not.toHaveBeenCalled();
  });
});

describe('rollback when the scan of the held image fails (the shipped default is block)', () => {
  beforeEach(() => {
    trivyAvailableSpy.mockReturnValue(true);
  });

  it('refuses with the decision, and moves no file', async () => {
    const res = await request(app).post('/api/stacks/web/rollback').set('Cookie', authCookie);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'ROLLBACK_PROHIBITED',
      policy: { name: 'rollback-gate' },
      evidence: {
        outcome: 'block',
        applications: [expect.objectContaining({ rule: 'security_scan_failure=block', target: HOLD_TAG })],
      },
    });
    expect(restoreFromContext).not.toHaveBeenCalled();
  });

  it('lets an admin bypass it', async () => {
    const res = await request(app).post('/api/stacks/web/rollback?ignorePolicy=true').set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(restoreFromContext).toHaveBeenCalledTimes(1);
    expect(await bypassRows()).toHaveLength(1);
  });
});
