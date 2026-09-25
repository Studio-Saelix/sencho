/**
 * Route coverage for GET /api/stacks/:stackName/recoveries:
 *   - auth gates (401, 403, capability_unavailable)
 *   - happy path with per-service rows joined with health-gate status
 *   - null/missing health_gate_id maps to 'unknown'
 *   - 500 on unexpected errors
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import type { ServiceUpdateRecoveryRow } from '../services/DatabaseService';
import { DatabaseService } from '../services/DatabaseService';
import { HealthGateService } from '../services/HealthGateService';
import { ServiceUpdateRecoveryService } from '../services/ServiceUpdateRecoveryService';
import { getActiveCapabilities } from '../services/CapabilityRegistry';

vi.mock('../services/CapabilityRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/CapabilityRegistry')>();
  return { ...actual, getActiveCapabilities: vi.fn() };
});

function writeStack(name: string) {
  const dir = path.join(process.env.COMPOSE_DIR!, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services:\n  app:\n    image: nginx\n  db:\n    image: postgres\n');
}

let tmpDir: string;
let app: import('express').Express;
let adminCookie: string;

function insertRecovery(overrides: Partial<ServiceUpdateRecoveryRow> = {}): ServiceUpdateRecoveryRow {
  const row: ServiceUpdateRecoveryRow = {
    id: overrides.id ?? 'rec-1',
    node_id: 1,
    stack_name: 'web',
    service_name: overrides.service_name ?? 'api',
    replicas_json: '[]',
    majority_image_id: 'sha256:aaa',
    declared_image_ref: 'ghcr.io/acme/api:v1',
    weak_floating_tag: 0,
    health_gate_id: overrides.health_gate_id ?? null,
    status: 'active',
    expires_at: overrides.expires_at ?? Date.now() + 60_000,
    claim_expires_at: null,
    created_at: Date.now(),
    created_by: null,
    ...overrides,
  };
  DatabaseService.getInstance().insertServiceUpdateRecovery(row);
  return row;
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  writeStack('web');
  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

afterEach(() => {
  const raw = (DatabaseService.getInstance() as unknown as { db: { prepare: (s: string) => { run: () => void } } }).db;
  raw.prepare('DELETE FROM service_update_recovery').run();
  vi.mocked(getActiveCapabilities).mockReset();
  vi.mocked(getActiveCapabilities).mockReturnValue([]);
});

const gateReport = { id: 'gate-1', status: 'failed' as const, reason: 'timeout', failureSource: 'primary' as const, stack: 'web', trigger: 'update' as const, windowSeconds: 90, startedAt: Date.now(), endedAt: null, containers: [], targetScope: 'service' as const, serviceName: 'api' };

describe('GET /api/stacks/:stackName/recoveries', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(app).get('/api/stacks/web/recoveries');
    expect(res.status).toBe(401);
  });

  it('returns 403 when viewer lacks stack:deploy', async () => {
    const bcrypt = await import('bcrypt');
    const hash = await bcrypt.default.hash('viewerpass', 1);
    DatabaseService.getInstance().addUser({ username: 'viewer2', password_hash: hash, role: 'viewer' });
    const cookie = await new Promise<string>((resolve) => {
      request(app).post('/api/auth/login').send({ username: 'viewer2', password: 'viewerpass' })
        .then(r => resolve(Array.isArray(r.headers['set-cookie']) ? r.headers['set-cookie'][0] : r.headers['set-cookie']));
    });
    const res = await request(app).get('/api/stacks/web/recoveries').set('Cookie', cookie);
    expect(res.status).toBe(403);
  });

  it('returns 400 capability_unavailable when service-scoped updates are not supported', async () => {
    // getActiveCapabilities is reset to return [] in afterEach; no extra setup needed
    const res = await request(app).get('/api/stacks/web/recoveries').set('Cookie', adminCookie);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.any(String), code: 'capability_unavailable' });
  });

  it('returns 200 with per-service rows joined with health-gate status', async () => {
    // Reset the mock so it returns capabilities including service-scoped-update
    vi.mocked(getActiveCapabilities).mockReset();
    vi.mocked(getActiveCapabilities).mockReturnValue(['service-scoped-update' as const]);
    const getReportSpy = vi.spyOn(HealthGateService.prototype, 'getReport').mockReturnValue(gateReport);

    insertRecovery({ id: 'rec-api', service_name: 'api', health_gate_id: 'gate-1' });
    insertRecovery({ id: 'rec-db', service_name: 'db', health_gate_id: null });

    const res = await request(app).get('/api/stacks/web/recoveries').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    const body = res.body as Array<{ serviceName: string; recoveryId: string; healthGateId: string | null; healthGateStatus: string }>;
    expect(body).toHaveLength(2);
    const apiRow = body.find(r => r.serviceName === 'api');
    const dbRow = body.find(r => r.serviceName === 'db');
    expect(apiRow?.healthGateId).toBe('gate-1');
    expect(apiRow?.healthGateStatus).toBe('failed');
    expect(dbRow?.healthGateId).toBeNull();
    expect(dbRow?.healthGateStatus).toBe('unknown');
    getReportSpy.mockRestore();
  });

  it('returns only the newest active row per service', async () => {
    vi.mocked(getActiveCapabilities).mockReset();
    vi.mocked(getActiveCapabilities).mockReturnValue(['service-scoped-update' as const]);
    const now = Date.now();
    const getReportSpy = vi.spyOn(HealthGateService.prototype, 'getReport').mockImplementation((_nodeId: number, _stackName: string, gateId?: string) => {
      if (gateId === 'gate-old') return { ...gateReport, id: 'gate-old', status: 'failed' };
      return { ...gateReport, id: gateId ?? 'gate-new', status: 'passed', reason: null, failureSource: null };
    });

    // Older failed recovery followed by a newer passed one for the same service:
    // only the newer row may be returned, or a Restore offer would target a stale snapshot.
    insertRecovery({ id: 'rec-old', service_name: 'api', health_gate_id: 'gate-old', created_at: now - 10_000 });
    insertRecovery({ id: 'rec-new', service_name: 'api', health_gate_id: 'gate-new', created_at: now - 1_000 });

    const res = await request(app).get('/api/stacks/web/recoveries').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    const body = res.body as Array<{ recoveryId: string; healthGateStatus: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ recoveryId: 'rec-new', healthGateStatus: 'passed' });
    getReportSpy.mockRestore();
  });

  it('maps null health_gate_id to unknown with no-health-gate reason', async () => {
    vi.mocked(getActiveCapabilities).mockReset();
    vi.mocked(getActiveCapabilities).mockReturnValue(['service-scoped-update' as const]);
    insertRecovery({ id: 'rec-nogate', service_name: 'api', health_gate_id: null });

    const res = await request(app).get('/api/stacks/web/recoveries').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    const body = res.body as Array<{ healthGateStatus: string; healthGateReason: string | null }>;
    expect(body[0].healthGateStatus).toBe('unknown');
    expect(body[0].healthGateReason).toBe('no health gate linked');
  });

  it('returns 500 on unexpected database error', async () => {
    vi.mocked(getActiveCapabilities).mockReset();
    vi.mocked(getActiveCapabilities).mockReturnValue(['service-scoped-update' as const]);
    const listSpy = vi.spyOn(ServiceUpdateRecoveryService.prototype, 'listAllActiveForStack').mockImplementation(() => {
      throw new Error('db down');
    });
    try {
      const res = await request(app).get('/api/stacks/web/recoveries').set('Cookie', adminCookie);
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ error: 'Failed to load stack recoveries', code: 'stack_recovery_lookup_failed' });
    } finally {
      listSpy.mockRestore();
    }
  });
});
