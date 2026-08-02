/**
 * Real-DB tests for the rollback-generation retention/cap/release lifecycle:
 * DatabaseService's retention/cap/release SQL, StackUpdateRecoveryService's
 * cap enforcement and releaseGeneration orchestration, and the
 * GET/POST /api/system/rollback/generations routes. Docker is stubbed
 * (no real daemon); the DB is real via setupTestDb() so the SQL under test
 * (atomic release UPDATE, retention/cap queries) runs for real.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import type { StackUpdateRecoveryGenerationRow, HealthGateRunRow } from '../services/DatabaseService';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let StackUpdateRecoveryService: typeof import('../services/StackUpdateRecoveryService').StackUpdateRecoveryService;
let DockerController: typeof import('../services/DockerController').default;

const mockRemove = vi.fn().mockResolvedValue(undefined);
const mockGetImage = vi.fn(() => ({ remove: mockRemove }));

const NODE = 1;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ StackUpdateRecoveryService } = await import('../services/StackUpdateRecoveryService'));
  ({ default: DockerController } = await import('../services/DockerController'));
  const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });
  authHeader = `Bearer ${token}`;
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  mockRemove.mockClear().mockResolvedValue(undefined);
  vi.spyOn(DockerController, 'getInstance').mockReturnValue({
    getDocker: () => ({ getImage: mockGetImage }),
  } as unknown as ReturnType<typeof DockerController.getInstance>);
});

afterEach(() => {
  vi.restoreAllMocks();
  const db = DatabaseService.getInstance();
  // Restore the shipped defaults so a test that tunes retention/cap does not
  // leak that value into the next one.
  db.updateGlobalSetting('recovery_retention_days', '7');
  db.updateGlobalSetting('recovery_max_generations', '0');
  db.getDb().prepare('DELETE FROM stack_update_recovery_generations').run();
  db.getDb().prepare('DELETE FROM health_gate_runs').run();
});

function makeRow(overrides: Partial<StackUpdateRecoveryGenerationRow> = {}): StackUpdateRecoveryGenerationRow {
  const id = overrides.id ?? randomUUID();
  const now = Date.now();
  return {
    id,
    node_id: NODE,
    stack_name: 'my-stack',
    status: 'active',
    phase: 'immediate_verified',
    is_current: 1,
    backup_slot_id: null,
    override_path: null,
    services_json: JSON.stringify([{
      serviceName: 'web',
      scale: 1,
      hasBuild: false,
      declaredImageRef: 'nginx:latest',
      referenceKind: 'moving_tag',
      replicas: [{
        containerId: 'c1',
        imageId: `sha256:${id.replace(/-/g, '').padEnd(64, '0').slice(0, 64)}`,
        repoDigest: null,
        state: 'running',
        rollbackTag: `sencho-rb/${id.replace(/-/g, '').slice(0, 12)}/web:hold`,
      }],
    }]),
    health_gate_id: null,
    gate_retain_until: null,
    artifact_expires_at: null,
    operation_lease_expires_at: null,
    created_at: now,
    updated_at: now,
    created_by: null,
    artifacts_retired: 0,
    released_at: null,
    released_by: null,
    ...overrides,
  };
}

function insertRow(overrides: Partial<StackUpdateRecoveryGenerationRow> = {}): StackUpdateRecoveryGenerationRow {
  const row = makeRow(overrides);
  DatabaseService.getInstance().insertStackUpdateRecoveryGeneration(row);
  return row;
}

function insertHealthGate(overrides: Partial<HealthGateRunRow> = {}): HealthGateRunRow {
  const run: HealthGateRunRow = {
    id: randomUUID(),
    node_id: NODE,
    stack_name: 'my-stack',
    trigger_action: 'update',
    status: 'observing',
    reason: null,
    window_seconds: 90,
    containers_json: '[]',
    started_at: Date.now(),
    ended_at: null,
    created_by: null,
    target_scope: 'stack',
    service_name: null,
    failure_source: null,
    ...overrides,
  };
  DatabaseService.getInstance().insertHealthGateRun(run);
  return run;
}

function imageIdOf(row: StackUpdateRecoveryGenerationRow): string {
  const parsed = JSON.parse(row.services_json);
  return parsed[0].replicas[0].imageId as string;
}

describe('recovery_retention_days wired into casHandoffGeneration', () => {
  it('uses a configured retention value instead of the hardcoded 7 days', () => {
    const db = DatabaseService.getInstance();
    db.updateGlobalSetting('recovery_retention_days', '2');
    const current = insertRow({ status: 'active', is_current: 1 });
    const candidate = insertRow({
      id: randomUUID(),
      status: 'candidate',
      phase: 'acquired',
      is_current: 0,
      stack_name: current.stack_name,
    });
    const ok = db.casHandoffGeneration(candidate.id, NODE, current.stack_name);
    expect(ok).toBe(true);

    const superseded = db.getStackUpdateRecoveryGeneration(current.id)!;
    expect(superseded.status).toBe('superseded');
    const expiresInDays = (superseded.artifact_expires_at! - Date.now()) / (24 * 60 * 60 * 1000);
    expect(expiresInDays).toBeGreaterThan(1.9);
    expect(expiresInDays).toBeLessThan(2.1);
  });

  it('reflects a retention-days change made between two consecutive handoffs, not the value at the time of the first', () => {
    const db = DatabaseService.getInstance();
    db.updateGlobalSetting('recovery_retention_days', '2');
    const stackA = insertRow({ stack_name: 'stack-a', status: 'active', is_current: 1 });
    const candidateA = insertRow({
      id: randomUUID(), status: 'candidate', phase: 'acquired', is_current: 0, stack_name: stackA.stack_name,
    });
    expect(db.casHandoffGeneration(candidateA.id, NODE, stackA.stack_name)).toBe(true);
    const supersededA = db.getStackUpdateRecoveryGeneration(stackA.id)!;
    const daysA = (supersededA.artifact_expires_at! - Date.now()) / (24 * 60 * 60 * 1000);
    expect(daysA).toBeGreaterThan(1.9);
    expect(daysA).toBeLessThan(2.1);

    // Change the setting without restarting anything, then handoff a
    // different stack: its expiry must reflect the new value, not a value
    // cached from the first call.
    db.updateGlobalSetting('recovery_retention_days', '5');
    const stackB = insertRow({ stack_name: 'stack-b', status: 'active', is_current: 1 });
    const candidateB = insertRow({
      id: randomUUID(), status: 'candidate', phase: 'acquired', is_current: 0, stack_name: stackB.stack_name,
    });
    expect(db.casHandoffGeneration(candidateB.id, NODE, stackB.stack_name)).toBe(true);
    const supersededB = db.getStackUpdateRecoveryGeneration(stackB.id)!;
    const daysB = (supersededB.artifact_expires_at! - Date.now()) / (24 * 60 * 60 * 1000);
    expect(daysB).toBeGreaterThan(4.9);
    expect(daysB).toBeLessThan(5.1);

    // The earlier write is not retroactively touched by the later setting change.
    const supersededAAfter = db.getStackUpdateRecoveryGeneration(stackA.id)!;
    expect(supersededAAfter.artifact_expires_at).toBe(supersededA.artifact_expires_at);
  });
});

describe('recovery_max_generations cap enforcement (reconcileIncomplete)', () => {
  it('retains current + (cap - 1) superseded generations; forces the rest to expire now', async () => {
    const db = DatabaseService.getInstance();
    db.updateGlobalSetting('recovery_max_generations', '2');
    const stackName = 'capped-stack';
    insertRow({ stack_name: stackName, status: 'active', is_current: 1 });
    const superseded: StackUpdateRecoveryGenerationRow[] = [];
    for (let i = 0; i < 3; i++) {
      superseded.push(insertRow({
        id: randomUUID(),
        stack_name: stackName,
        status: 'superseded',
        is_current: 0,
        artifact_expires_at: Date.now() + 6 * 24 * 60 * 60 * 1000,
        created_at: Date.now() - (3 - i) * 60_000,
      }));
    }

    const svc = StackUpdateRecoveryService.getInstance();
    svc.start();
    await svc.reconcileIncomplete();
    svc.stop();

    // cap=2 => current (1) + 1 superseded kept; the other 2 superseded get
    // artifact_expires_at pulled to now and their artifacts retired.
    const rows = superseded.map((r) => db.getStackUpdateRecoveryGeneration(r.id)!);
    const stillRetained = rows.filter((r) => !r.artifacts_retired);
    expect(stillRetained.length).toBe(1);
    // Keeps the newest superseded row.
    expect(stillRetained[0].id).toBe(superseded[2].id);
  });

  it('never touches a recovery_required generation', async () => {
    const db = DatabaseService.getInstance();
    db.updateGlobalSetting('recovery_max_generations', '1');
    const stackName = 'stuck-stack';
    insertRow({ stack_name: stackName, status: 'active', is_current: 1 });
    const stuck = insertRow({
      id: randomUUID(),
      stack_name: stackName,
      status: 'recovery_required',
      is_current: 0,
    });

    const svc = StackUpdateRecoveryService.getInstance();
    svc.start();
    await svc.reconcileIncomplete();
    svc.stop();

    const after = db.getStackUpdateRecoveryGeneration(stuck.id)!;
    expect(after.artifacts_retired).toBe(0);
    expect(after.artifact_expires_at).toBeNull();
  });
});

describe('StackUpdateRecoveryService.releaseGeneration', () => {
  it('release on the current generation clears the held-image set for its image', async () => {
    const row = insertRow({ status: 'active', is_current: 1 });
    const svc = StackUpdateRecoveryService.getInstance();

    expect(svc.getHeldImageIds(NODE)?.has(imageIdOf(row))).toBe(true);

    const result = await svc.releaseGeneration(row.id, 'tester');
    expect(result.ok).toBe(true);
    expect(svc.getHeldImageIds(NODE)?.has(imageIdOf(row))).toBe(false);

    const after = DatabaseService.getInstance().getStackUpdateRecoveryGeneration(row.id)!;
    expect(after.is_current).toBe(0);
    expect(after.released_at).not.toBeNull();
  });

  it('release on a restored_current generation clears the service-update pin', async () => {
    const row = insertRow({ status: 'restored_current', is_current: 1 });
    const svc = StackUpdateRecoveryService.getInstance();

    expect(svc.isRestoredCurrentPinActive(NODE, row.stack_name)).toBe(true);
    const result = await svc.releaseGeneration(row.id, 'tester');
    expect(result.ok).toBe(true);
    expect(svc.isRestoredCurrentPinActive(NODE, row.stack_name)).toBe(false);
  });

  it('rejects release while the linked health gate is observing', async () => {
    const gate = insertHealthGate({ status: 'observing' });
    const row = insertRow({ status: 'active', is_current: 1, health_gate_id: gate.id, stack_name: gate.stack_name });
    const svc = StackUpdateRecoveryService.getInstance();

    const result = await svc.releaseGeneration(row.id, 'tester');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_eligible');

    const after = DatabaseService.getInstance().getStackUpdateRecoveryGeneration(row.id)!;
    expect(after.released_at).toBeNull();
    expect(after.is_current).toBe(1);
  });

  it('allows release once the linked health gate has passed', async () => {
    const gate = insertHealthGate({ status: 'passed' });
    const row = insertRow({ status: 'active', is_current: 1, health_gate_id: gate.id, stack_name: gate.stack_name });
    const svc = StackUpdateRecoveryService.getInstance();

    const result = await svc.releaseGeneration(row.id, 'tester');
    expect(result.ok).toBe(true);
  });

  it('rejects release when the row has already moved to recovery_required (race)', async () => {
    const row = insertRow({ status: 'recovery_required', is_current: 1 });
    const svc = StackUpdateRecoveryService.getInstance();

    const result = await svc.releaseGeneration(row.id, 'tester');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_eligible');

    const after = DatabaseService.getInstance().getStackUpdateRecoveryGeneration(row.id)!;
    expect(after.artifacts_retired).toBe(0);
  });

  it('rejects a second release of an already-released generation', async () => {
    const row = insertRow({ status: 'active', is_current: 1 });
    const svc = StackUpdateRecoveryService.getInstance();

    const first = await svc.releaseGeneration(row.id, 'tester');
    expect(first.ok).toBe(true);
    const second = await svc.releaseGeneration(row.id, 'tester');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('already_released');
  });

  it('leaves artifacts_retired at 0 (retryable) when Docker tag removal fails', async () => {
    mockRemove.mockRejectedValueOnce(Object.assign(new Error('docker busy'), { statusCode: 500 }));
    const row = insertRow({ status: 'active', is_current: 1 });
    const svc = StackUpdateRecoveryService.getInstance();

    const result = await svc.releaseGeneration(row.id, 'tester');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.artifactsCleaned).toBe(false);

    const after = DatabaseService.getInstance().getStackUpdateRecoveryGeneration(row.id)!;
    expect(after.released_at).not.toBeNull();
    expect(after.artifacts_retired).toBe(0);

    // The reconcile sweep retries a released-but-uncleaned row immediately.
    mockRemove.mockResolvedValue(undefined);
    svc.start();
    await svc.reconcileIncomplete();
    svc.stop();
    const retried = DatabaseService.getInstance().getStackUpdateRecoveryGeneration(row.id)!;
    expect(retried.artifacts_retired).toBe(1);
  });
});

describe('GET/POST /api/system/rollback/generations', () => {
  it('lists generations for the requesting node with a releasable flag', async () => {
    const row = insertRow({ status: 'active', is_current: 1 });
    const res = await request(app)
      .get('/api/system/rollback/generations')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    const found = res.body.find((g: { id: string }) => g.id === row.id);
    expect(found).toBeDefined();
    expect(found.stackName).toBe(row.stack_name);
    expect(found.isCurrent).toBe(true);
    expect(found.releasable).toBe(true);
  });

  it('releases a generation and returns success', async () => {
    const row = insertRow({ status: 'superseded', is_current: 0 });
    const res = await request(app)
      .post(`/api/system/rollback/generations/${row.id}/release`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('404s releasing a generation that belongs to a different node', async () => {
    const row = insertRow({ status: 'superseded', is_current: 0, node_id: 999 });
    const res = await request(app)
      .post(`/api/system/rollback/generations/${row.id}/release`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(404);
  });

  it('409s releasing an ineligible generation', async () => {
    const row = insertRow({ status: 'recovery_required', is_current: 1 });
    const res = await request(app)
      .post(`/api/system/rollback/generations/${row.id}/release`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_ELIGIBLE');
  });
});
