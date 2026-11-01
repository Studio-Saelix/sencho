/**
 * The observation routers: the stack list page, one stack's container facts and
 * one stack's readiness.
 *
 * Evidence is stubbed at the canonical producers (which have their own suites),
 * so what is pinned here is this surface's own behavior: pagination bounds,
 * error codes, the 200-with-unavailable shape, the container cap, and the fact
 * that readiness is computed for the named stack rather than read from the
 * summary's capped pass.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import type { StackStatusesEvidenceResult, StackStatusInfo } from '../services/stackStatusesEvidence';

const mockStatuses = vi.fn();
const mockHealthFacts = vi.fn();

vi.mock('../services/stackStatusesEvidence', () => ({
  buildStackStatusesEvidence: (...args: unknown[]) => mockStatuses(...args),
}));

vi.mock('../services/health/stackHealthFacts', () => ({
  readStackHealthFacts: (...args: unknown[]) => mockHealthFacts(...args),
}));

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;
let UpdateGuardService: typeof import('../services/UpdateGuardService').UpdateGuardService;

function stackInfo(overrides: Partial<StackStatusInfo> = {}): StackStatusInfo {
  return { status: 'running', running: 1, total: 1, source: 'local', isSelf: false, ...overrides };
}

function evidence(entries: Record<string, StackStatusInfo>, degraded = false): StackStatusesEvidenceResult {
  return {
    evidence: { data: entries, degraded, generatedAt: 1_700_000_000_000 },
    cacheOutcome: 'computed',
    dockerMs: null,
    enrichmentMs: null,
  };
}

function container(name: string, state = 'running') {
  return {
    id: name.padEnd(64, '0'),
    name,
    service: 'web',
    state,
    health: 'healthy',
    restartCount: 0,
    startedAt: '2026-01-01T00:00:00Z',
    imageId: 'sha256:deadbeef',
    exitCode: 0,
    restartPolicy: 'unless-stopped',
  };
}

function seedStacks(names: string[]): void {
  for (const name of names) {
    const dir = path.join(process.env.COMPOSE_DIR as string, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services:\n  web:\n    image: nginx:1.27\n');
  }
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ UpdateGuardService } = await import('../services/UpdateGuardService'));
  authHeader = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;
  seedStacks(['web', 'api', 'db', 'stack-26']);
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  mockStatuses.mockReset();
  mockHealthFacts.mockReset();
  vi.restoreAllMocks();
  mockStatuses.mockResolvedValue(evidence({
    'web.yml': stackInfo(),
    'api.yml': stackInfo({ status: 'partial', running: 1, total: 2 }),
    'db.yaml': stackInfo({ status: 'exited', running: 0, total: 1 }),
  }));
  mockHealthFacts.mockResolvedValue({ kind: 'ok', containers: [container('web-1')] });
});

describe('GET /api/stacks/platform/observation', () => {
  it('requires authentication', async () => {
    expect((await request(app).get('/api/stacks/platform/observation')).status).toBe(401);
  });

  it('serves a projected page and a cursor', async () => {
    const res = await request(app)
      .get('/api/stacks/platform/observation?limit=2')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.schemaVersion).toBe(1);
    expect(res.body.generatedAt).toBe(1_700_000_000_000);
    expect(res.body.data.total).toBe(3);
    expect(res.body.data.stacks.map((s: { name: string }) => s.name)).toEqual(['api', 'db']);
    expect(res.body.data.nextCursor).toBe('db');

    const next = await request(app)
      .get(`/api/stacks/platform/observation?limit=2&cursor=${res.body.data.nextCursor}`)
      .set('Authorization', authHeader);
    expect(next.body.data.stacks.map((s: { name: string }) => s.name)).toEqual(['web']);
    expect(next.body.data.nextCursor).toBeNull();
  });

  it('passes degraded through', async () => {
    mockStatuses.mockResolvedValue(evidence({ 'web.yml': stackInfo() }, true));
    const res = await request(app)
      .get('/api/stacks/platform/observation')
      .set('Authorization', authHeader);
    expect(res.body.data.degraded).toBe(true);
  });

  it('pages through names longer than 128 characters without losing the cursor', async () => {
    const long = 'q'.repeat(130);
    const longer = `${long}z`;
    mockStatuses.mockResolvedValue(evidence({
      [`${longer}.yml`]: stackInfo(),
      [`${long}.yml`]: stackInfo(),
      'alpha.yml': stackInfo(),
    }));

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const url: string = `/api/stacks/platform/observation?limit=1${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await request(app).get(url).set('Authorization', authHeader);
      expect(res.status).toBe(200);
      seen.push(...res.body.data.stacks.map((s: { name: string }) => s.name));
      cursor = res.body.data.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(['alpha', long, longer]);
  });

  it('pages names that differ only by case, underscore and hyphen without gaps or repeats', async () => {
    const names = ['Alpha', 'alpha', 'alpha-1', 'alpha_1', 'alpha1', 'Beta', '0x'];
    mockStatuses.mockResolvedValue(evidence(Object.fromEntries(names.map((n) => [`${n}.yml`, stackInfo()]))));

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < names.length + 1; page += 1) {
      const url: string = `/api/stacks/platform/observation?limit=1${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await request(app).get(url).set('Authorization', authHeader);
      expect(res.status).toBe(200);
      seen.push(...res.body.data.stacks.map((s: { name: string }) => s.name));
      cursor = res.body.data.nextCursor;
      if (cursor === null) break;
    }
    expect([...seen].sort()).toEqual([...names].sort());
    expect(new Set(seen).size).toBe(names.length);
  });

  it('does not list a directory the per-stack routes would reject', async () => {
    mockStatuses.mockResolvedValue(evidence({
      'web.yml': stackInfo(),
      'my.stack.yml': stackInfo(),
    }));
    const res = await request(app)
      .get('/api/stacks/platform/observation')
      .set('Authorization', authHeader);
    expect(res.body.data.stacks.map((s: { name: string }) => s.name)).toEqual(['web']);
    expect(res.body.data.total).toBe(1);
  });

  it.each(['abc', '0', '201', '-1', '1.5'])('rejects limit=%s with INVALID_LIMIT', async (limit) => {
    const res = await request(app)
      .get(`/api/stacks/platform/observation?limit=${limit}`)
      .set('Authorization', authHeader);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_LIMIT');
  });

  it.each(['a/b', 'a.b', '../x'])('rejects cursor=%s with INVALID_CURSOR', async (cursor) => {
    const res = await request(app)
      .get(`/api/stacks/platform/observation?cursor=${encodeURIComponent(cursor)}`)
      .set('Authorization', authHeader);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CURSOR');
  });
});

describe('GET /api/stacks/:stackName/observation/status', () => {
  it('serves projected container facts', async () => {
    const res = await request(app)
      .get('/api/stacks/web/observation/status')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.schemaVersion).toBe(1);
    expect(res.body.data).toEqual({
      stack: 'web',
      outcome: 'ok',
      containers: [{
        name: 'web-1',
        service: 'web',
        state: 'running',
        health: 'healthy',
        restartCount: 0,
        exitCode: 0,
        startedAt: '2026-01-01T00:00:00Z',
      }],
      truncated: false,
    });
  });

  it('answers 404 STACK_NOT_FOUND for a stack this node does not have', async () => {
    const res = await request(app)
      .get('/api/stacks/missing/observation/status')
      .set('Authorization', authHeader);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('STACK_NOT_FOUND');
    expect(mockHealthFacts).not.toHaveBeenCalled();
  });

  it('answers 200 unavailable when the node cannot read its containers', async () => {
    mockHealthFacts.mockResolvedValue({ kind: 'unavailable', cause: 'docker', detail: 'no socket' });
    const res = await request(app)
      .get('/api/stacks/web/observation/status')
      .set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('unavailable');
    expect(res.body.data.containers).toEqual([]);
  });

  it('echoes and serves a stack name longer than 128 characters, as the list publishes it', async () => {
    const long = 'q'.repeat(130);
    seedStacks([long]);
    const res = await request(app)
      .get(`/api/stacks/${long}/observation/status`)
      .set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.data.stack).toBe(long);

    mockHealthFacts.mockResolvedValue({ kind: 'unavailable', cause: 'docker', detail: 'no socket' });
    const unavailable = await request(app)
      .get(`/api/stacks/${long}/observation/status`)
      .set('Authorization', authHeader);
    expect(unavailable.body.data.stack).toBe(long);
  });

  it('keeps an exited container when the cap cuts the list', async () => {
    mockHealthFacts.mockResolvedValue({
      kind: 'ok',
      containers: [
        ...Array.from({ length: 105 }, (_, i) => container(`m-${i}`)),
        container('z-exited', 'exited'),
      ],
    });
    const res = await request(app)
      .get('/api/stacks/web/observation/status')
      .set('Authorization', authHeader);
    expect(res.body.data.truncated).toBe(true);
    expect(res.body.data.containers).toHaveLength(100);
    expect(res.body.data.containers[0]).toMatchObject({ name: 'z-exited', state: 'exited' });
  });

  it('bounds the list at 100 containers', async () => {
    mockHealthFacts.mockResolvedValue({
      kind: 'ok',
      containers: Array.from({ length: 101 }, (_, i) => container(`c-${i}`)),
    });
    const res = await request(app)
      .get('/api/stacks/web/observation/status')
      .set('Authorization', authHeader);
    expect(res.body.data.containers).toHaveLength(100);
    expect(res.body.data.truncated).toBe(true);
  });
});

describe('GET /api/stacks/:stackName/observation/readiness', () => {
  it('echoes a stack name longer than 128 characters unchanged', async () => {
    const long = 'r'.repeat(130);
    seedStacks([long]);
    vi.spyOn(UpdateGuardService.prototype, 'computeUpdateReadiness').mockRejectedValue(new Error('boom'));
    vi.spyOn(UpdateGuardService.prototype, 'computeRollbackReadiness').mockRejectedValue(new Error('boom'));
    const res = await request(app)
      .get(`/api/stacks/${long}/observation/readiness`)
      .set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.data.stack).toBe(long);
  });

  it('computes the named stack and projects only ids and verdicts', async () => {
    const computedAt = 1_700_000_100_000;
    const updateSpy = vi.spyOn(UpdateGuardService.prototype, 'computeUpdateReadiness').mockImplementation(async (
      _nodeId,
      _stackName,
      _serviceName,
      options,
    ) => {
      // The real computation hands its probes to the version phase; the stub
      // does the same so the optional phase is reachable in this test.
      options?.captureContainerProbes?.([]);
      return {
        stack: 'stack-26',
        computedAt,
        verdict: 'review_required',
        serviceName: null,
        advisories: [],
        signals: [
          { id: 'preflight', status: 'ok', title: 'Preflight', detail: 'ok', affectsVerdict: true },
          {
            id: 'containers',
            status: 'attention',
            title: 'Containers',
            detail: 'operator prose that must not leave the node',
            affectsVerdict: true,
          },
        ],
      };
    });
    const rollbackSpy = vi.spyOn(UpdateGuardService.prototype, 'computeRollbackReadiness').mockResolvedValue({
      stack: 'stack-26',
      computedAt,
      overall: 'not_ready',
      items: [{
        id: 'previous_images',
        state: 'missing',
        label: 'Previous images',
        detail: 'operator prose that must not leave the node',
      }],
    });

    // The optional Compose-version phase runs too, so a verdict that depends on
    // it matches what the fleet matrix publishes for the same stack.
    const versionSpy = vi.spyOn(UpdateGuardService.prototype, 'composeVersionSignalFor').mockResolvedValue({
      id: 'compose_version',
      status: 'blocked',
      title: 'Compose version',
      detail: 'operator prose that must not leave the node',
      affectsVerdict: true,
    });
    try {
      // stack-26 is past the summary's 25-stack cap; the observation route must
      // still evaluate it, which is what makes this tool useful at fleet scale.
      const res = await request(app)
        .get('/api/stacks/stack-26/observation/readiness')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(updateSpy).toHaveBeenCalledWith(
        expect.any(Number),
        'stack-26',
        undefined,
        expect.objectContaining({ includeComposeVersion: false }),
      );
      expect(versionSpy).toHaveBeenCalledWith(
        expect.any(Number),
        'stack-26',
        expect.anything(),
        expect.objectContaining({ deadlineEpochMs: expect.any(Number) }),
      );
      expect(res.body.data).toEqual({
        stack: 'stack-26',
        update: {
          verdict: 'blocked',
          topReasonId: 'compose_version',
          hasUpdate: false,
          computedAt,
        },
        rollback: {
          overall: 'not_ready',
          topReasonId: 'previous_images',
          computedAt,
        },
        unavailableReason: null,
      });
      expect(JSON.stringify(res.body)).not.toContain('operator prose');
    } finally {
      updateSpy.mockRestore();
      rollbackSpy.mockRestore();
      versionSpy.mockRestore();
    }
  });

  it('reports one failed slot as a partial row, with no unavailableReason', async () => {
    vi.spyOn(UpdateGuardService.prototype, 'computeUpdateReadiness').mockRejectedValue(new Error('boom'));
    vi.spyOn(UpdateGuardService.prototype, 'computeRollbackReadiness').mockResolvedValue({
      stack: 'web',
      computedAt: 5,
      overall: 'ready',
      items: [],
    });
    const res = await request(app)
      .get('/api/stacks/web/observation/readiness')
      .set('Authorization', authHeader);
    expect(res.body.data.update).toBeNull();
    expect(res.body.data.rollback).toEqual({ overall: 'ready', topReasonId: null, computedAt: 5 });
    expect(res.body.data.unavailableReason).toBeNull();
  });

  it('reports both slots failed as domain_error', async () => {
    vi.spyOn(UpdateGuardService.prototype, 'computeUpdateReadiness').mockRejectedValue(new Error('boom'));
    vi.spyOn(UpdateGuardService.prototype, 'computeRollbackReadiness').mockRejectedValue(new Error('boom'));
    const res = await request(app)
      .get('/api/stacks/web/observation/readiness')
      .set('Authorization', authHeader);
    expect(res.body.data.update).toBeNull();
    expect(res.body.data.rollback).toBeNull();
    expect(res.body.data.unavailableReason).toBe('domain_error');
  });

  it('answers 404 STACK_NOT_FOUND for a stack this node does not have', async () => {
    const res = await request(app)
      .get('/api/stacks/missing/observation/readiness')
      .set('Authorization', authHeader);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('STACK_NOT_FOUND');
  });
});

describe('the extracted per-stack readiness compute', () => {
  it('reports summary_truncated when the deadline has already passed', async () => {
    const { computeStackReadinessEvidence } = await import('../services/readiness/stackReadinessSummary');
    const row = await computeStackReadinessEvidence(1, 'web', Date.now() - 1);
    expect(row).toEqual({
      stack: 'web',
      update: null,
      rollback: null,
      unavailableReason: 'summary_truncated',
    });
  });
});
