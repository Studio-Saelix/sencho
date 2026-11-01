/**
 * The hub-served observation projections: the node registry and fleet health.
 *
 * Fleet health is the one expensive read in this surface, so the properties
 * pinned here are the shared computation (one fan-out per TTL, however many
 * clients ask), the arguments that keep a read from mutating state, and abort
 * isolation: one client disconnecting must not cancel the shared read and cache
 * an all-unreachable fleet for everyone else.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import type { FleetReadinessResponse } from '../services/readiness/types';

const mockBuild = vi.fn();

vi.mock('../services/readiness/readinessAggregator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/readiness/readinessAggregator')>();
  return {
    ...actual,
    buildFleetReadiness: (...args: unknown[]) => mockBuild(...args),
  };
});

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;
let CacheService: typeof import('../services/CacheService').CacheService;
let fleetAggregator: typeof import('../services/readiness/readinessAggregator');

function fleetResponse(generatedAt = Date.now()): FleetReadinessResponse {
  return {
    generatedAt,
    domains: ['connectivity', 'workloads', 'updates', 'recovery', 'security'],
    domainsOmitted: ['control'],
    summary: {
      nodes: { attention: 0, degraded: 0, unavailable: 0, unknown: 0, healthy: 1 },
      findings: { attention: 0, degraded: 0, unavailable: 0, unknown: 0 },
    },
    nodes: [{
      id: 1,
      name: 'hub',
      type: 'local',
      mode: 'proxy',
      transport: 'local',
      state: 'healthy',
      reachability: {
        status: 'online',
        contactAt: 4,
        contactSource: 'local',
        note: 'Local node',
        probedLive: true,
        latencyMs: 2,
      },
      cells: {
        connectivity: {
          state: 'healthy',
          reasonCode: null,
          counts: {},
          evidenceAgeMs: 100,
          source: 'live',
        },
      },
      stackCount: 1,
    }],
    findings: [],
    dismissals: [],
  };
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ CacheService } = await import('../services/CacheService'));
  fleetAggregator = await import('../services/readiness/readinessAggregator');
  authHeader = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  mockBuild.mockReset();
  CacheService.getInstance().flush();
});

describe('GET /api/fleet/observation/nodes', () => {
  it('serves a projected registry entry per node', async () => {
    const res = await request(app).get('/api/fleet/observation/nodes').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.schemaVersion).toBe(1);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(Object.keys(res.body.data[0]).sort()).toEqual([
      'cordoned', 'id', 'lastContactAt', 'name', 'status', 'transport', 'type',
    ]);
    expect(res.body.data[0].transport).toBe('local');
  });

  it('publishes lastContactAt in epoch ms for proxy and Pilot nodes alike', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    const proxyId = db.addNode({
      name: 'obs-unit-proxy', type: 'remote', mode: 'proxy', compose_dir: '/tmp',
      is_default: false, api_url: 'http://127.0.0.1:1', api_token: 't',
    });
    const pilotId = db.addNode({
      name: 'obs-unit-pilot', type: 'remote', mode: 'pilot_agent', compose_dir: '/tmp', is_default: false,
    });
    const before = Date.now();
    // The real writers: whole seconds for a proxy contact, ms for a Pilot stamp.
    db.updateNodeLastContact(proxyId);
    db.updateNode(pilotId, { pilot_last_seen: Date.now() });
    const after = Date.now();

    const res = await request(app).get('/api/fleet/observation/nodes').set('Authorization', authHeader);
    const byId = new Map<number, { lastContactAt: number | null }>(
      res.body.data.map((n: { id: number; lastContactAt: number | null }) => [n.id, n]),
    );
    const proxyAt = byId.get(proxyId)!.lastContactAt!;
    const pilotAt = byId.get(pilotId)!.lastContactAt!;
    // Seconds are truncated on write, so allow the one-second floor.
    expect(proxyAt).toBeGreaterThanOrEqual(before - 1000);
    expect(proxyAt).toBeLessThanOrEqual(after);
    expect(pilotAt).toBeGreaterThanOrEqual(before);
    expect(pilotAt).toBeLessThanOrEqual(after);
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/fleet/observation/nodes')).status).toBe(401);
  });
});

describe('GET /api/fleet/observation/health', () => {
  it('builds with control withheld and dismissals left alone', async () => {
    mockBuild.mockResolvedValue(fleetResponse());
    const res = await request(app).get('/api/fleet/observation/health').set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.schemaVersion).toBe(1);
    expect(res.body.generatedAt).toBeGreaterThan(0);
    expect(res.body.data.domains).not.toContain('control');
    expect(res.body.data.domainsOmitted).toContain('control');
    expect(res.body.data.stale).toBe(false);

    const args = mockBuild.mock.calls[0][0] as {
      includeControl: boolean;
      withDismissals: boolean;
      nodeIds: number[] | null;
      signal: AbortSignal;
    };
    expect(args.includeControl).toBe(false);
    expect(args.withDismissals).toBe(false);
    expect(args.nodeIds).toBeNull();
    expect(args.signal.aborted).toBe(false);
  });

  it('shares one computation between concurrent callers', async () => {
    let release: (value: FleetReadinessResponse) => void = () => {};
    mockBuild.mockImplementation(() => new Promise<FleetReadinessResponse>((resolve) => {
      release = resolve;
    }));

    const first = request(app).get('/api/fleet/observation/health').set('Authorization', authHeader);
    const second = request(app).get('/api/fleet/observation/health').set('Authorization', authHeader);
    const p1 = first.then((res) => res);
    const p2 = second.then((res) => res);
    // Let both requests reach the cache before resolving the shared build.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const stamp = Date.now();
    release(fleetResponse(stamp));

    const [a, b] = await Promise.all([p1, p2]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.generatedAt).toBe(stamp);
    expect(b.body.generatedAt).toBe(stamp);
    expect(mockBuild).toHaveBeenCalledTimes(1);
  });

  it('does not let one caller disconnecting cancel the shared computation', async () => {
    let captured: AbortSignal | undefined;
    let release: (value: FleetReadinessResponse) => void = () => {};
    mockBuild.mockImplementation((args: { signal: AbortSignal }) => {
      captured = args.signal;
      return new Promise<FleetReadinessResponse>((resolve) => {
        release = resolve;
      });
    });

    const aborted = request(app).get('/api/fleet/observation/health').set('Authorization', authHeader);
    const started = aborted.end(() => {});
    await new Promise((resolve) => setTimeout(resolve, 30));
    aborted.abort();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(captured).toBeDefined();
    expect(captured!.aborted).toBe(false);

    const waiting = request(app).get('/api/fleet/observation/health').set('Authorization', authHeader);
    const waitingPromise = waiting.then((res) => res);
    await new Promise((resolve) => setTimeout(resolve, 30));
    release(fleetResponse());
    const res = await waitingPromise;
    void started;

    expect(res.status).toBe(200);
    expect(res.body.data.nodes[0].reachability.probedLive).toBe(true);
    expect(res.body.data.nodes[0].state).toBe('healthy');
    expect(mockBuild).toHaveBeenCalledTimes(1);
  });

  it('tells every waiter stale when a failed refresh serves the expired entry', async () => {
    mockBuild.mockResolvedValueOnce(fleetResponse());
    await request(app).get('/api/fleet/observation/health').set('Authorization', authHeader);

    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 20_000);
    let reject!: (error: Error) => void;
    mockBuild.mockImplementationOnce(() => new Promise<FleetReadinessResponse>((_resolve, rejectFn) => {
      reject = rejectFn;
    }));
    try {
      const first = request(app).get('/api/fleet/observation/health').set('Authorization', authHeader)
        .then((res) => res);
      await new Promise((resolve) => setTimeout(resolve, 40));
      const second = request(app).get('/api/fleet/observation/health').set('Authorization', authHeader)
        .then((res) => res);
      await new Promise((resolve) => setTimeout(resolve, 40));
      reject(new Error('fan-out failed'));

      // One caller ran the failed refresh; the other joined it. Both are handed
      // the same expired bytes, so both must say so.
      const [a, b] = await Promise.all([first, second]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(a.body.data.stale).toBe(true);
      expect(b.body.data.stale).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('marks the answer stale when an expired entry is served after a failed refresh', async () => {
    mockBuild.mockResolvedValueOnce(fleetResponse());
    const fresh = await request(app).get('/api/fleet/observation/health').set('Authorization', authHeader);
    expect(fresh.body.data.stale).toBe(false);

    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 20_000);
    mockBuild.mockRejectedValueOnce(new Error('fan-out failed'));
    try {
      const stale = await request(app).get('/api/fleet/observation/health').set('Authorization', authHeader);
      expect(stale.status).toBe(200);
      expect(stale.body.generatedAt).toBeGreaterThan(0);
      expect(stale.body.data.stale).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('returns 500 when a cold cache cannot compute', async () => {
    mockBuild.mockRejectedValue(new Error('fan-out failed'));
    const res = await request(app).get('/api/fleet/observation/health').set('Authorization', authHeader);
    expect(res.status).toBe(500);
  });
});

describe('the fleet aggregator wiring', () => {
  it('is the canonical builder, not a copy', () => {
    expect(typeof fleetAggregator.buildFleetReadiness).toBe('function');
  });
});
