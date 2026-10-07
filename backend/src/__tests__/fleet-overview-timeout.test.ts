/**
 * Fleet overview must return inside a short per-remote probe budget so one
 * unreachable Distributed API Proxy node cannot hold GET /api/fleet/overview
 * (and the Fleet, Heartbeat, and Mobile loading states).
 *
 * Hung remotes stay pending until the request AbortSignal fires, then reject.
 * Fast-fail remotes reject immediately. Both map to the existing offline overview shape.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import type { ProxyTarget } from '../services/NodeRegistry';
import DockerController from '../services/DockerController';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;
let NodeRegistry: typeof import('../services/NodeRegistry').NodeRegistry;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

const PROXY_BASE = 'http://remote.example.com';
const HEALTHY_BASE = 'http://good-host.example.com';
const PRIOR_CONTACT = 1_700_000_000;
const OVERVIEW_BUDGET_CEILING_MS = 8_000;
const OVERVIEW_ABORT_FLOOR_MS = 1_500;
const FAST_PATH_CEILING_MS = 2_000;

const STATS = { active: 3, managed: 2, unmanaged: 1, exited: 0, total: 3 };
const SYSTEM_STATS = {
  cpu: { usage: '12.3', cores: 4 },
  memory: { total: 8000000000, used: 2000000000, free: 6000000000, usagePercent: '25.0' },
  disk: { total: 10, used: 5, free: 5, usagePercent: '50.0' },
};

type OverviewRow = {
  id: number;
  name: string;
  type: string;
  mode?: string;
  status: string;
  stats: unknown;
  systemStats: unknown;
  stacks: unknown;
  last_successful_contact?: number | null;
  pilot_last_seen?: number | null;
};

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ NodeRegistry } = await import('../services/NodeRegistry'));
  ({ DatabaseService } = await import('../services/DatabaseService'));

  const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });
  authHeader = `Bearer ${token}`;
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  const db = DatabaseService.getInstance();
  for (const node of db.getNodes()) {
    if (node.type === 'remote') db.deleteNode(node.id);
  }
});

function addProxyNode(name: string, apiUrl: string): number {
  const db = DatabaseService.getInstance();
  const id = db.addNode({
    name,
    type: 'remote',
    mode: 'proxy',
    compose_dir: '/tmp',
    is_default: false,
    api_url: apiUrl,
    api_token: 'test-token',
  });
  db.getDb().prepare('UPDATE nodes SET last_successful_contact = ? WHERE id = ?').run(PRIOR_CONTACT, id);
  return id;
}

function addPilotNode(name: string): number {
  const db = DatabaseService.getInstance();
  const id = db.addNode({
    name,
    type: 'remote',
    mode: 'pilot_agent',
    compose_dir: '/tmp',
    is_default: false,
    api_url: '',
    api_token: '',
  });
  db.updateNode(id, { pilot_last_seen: Date.now(), pilot_agent_version: '0.97.1' });
  return id;
}

function mockTargets(targets: Record<number, ProxyTarget | null>): void {
  vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockImplementation((id: number) => {
    if (Object.prototype.hasOwnProperty.call(targets, id)) return targets[id];
    return null;
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function hungUntilAbort(init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) {
      // Stay pending. Rejecting here would let a missing AbortSignal look like
      // a fast offline, which is the regression this mock exists to catch.
      return;
    }
    const abort = () => {
      reject(signal.reason instanceof Error
        ? signal.reason
        : new DOMException('The operation was aborted.', 'AbortError'));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.toString() : (input as Request).url;
    return handler(url, init);
  });
}

function healthyHandler(base: string): (url: string, init?: RequestInit) => Response {
  return (url) => {
    if (url === `${base}/api/stats`) return jsonResponse(STATS);
    if (url === `${base}/api/system/stats`) return jsonResponse(SYSTEM_STATS);
    if (url === `${base}/api/stacks`) return jsonResponse(['web']);
    return new Response('not found', { status: 404 });
  };
}

async function getOverview(): Promise<{ status: number; body: OverviewRow[]; elapsedMs: number }> {
  const started = Date.now();
  const res = await request(app).get('/api/fleet/overview').set('Authorization', authHeader);
  return { status: res.status, body: res.body as OverviewRow[], elapsedMs: Date.now() - started };
}

describe('GET /api/fleet/overview remote probe budget', () => {
  it('populates stats, systemStats, and stacks for a healthy proxy remote', async () => {
    const nodeId = addProxyNode('healthy-proxy', PROXY_BASE);
    mockTargets({ [nodeId]: { apiUrl: PROXY_BASE, apiToken: 'test-token', trustedLoopback: false } });
    mockFetch(healthyHandler(PROXY_BASE));

    const { status, body } = await getOverview();
    expect(status).toBe(200);
    const row = body.find(n => n.id === nodeId);
    expect(row).toBeDefined();
    expect(row!.status).toBe('online');
    expect(row!.stats).toEqual(STATS);
    expect(row!.systemStats).toMatchObject({ cpu: { usage: '12.3', cores: 4 } });
    expect(row!.stacks).toEqual(['web']);
    expect(row!.last_successful_contact).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) - 5);
  });

  it('degrades a hung proxy remote to offline and preserves last contact', async () => {
    const nodeId = addProxyNode('hung-proxy', PROXY_BASE);
    mockTargets({ [nodeId]: { apiUrl: PROXY_BASE, apiToken: 'test-token', trustedLoopback: false } });
    mockFetch((_url, init) => hungUntilAbort(init));

    const { status, body, elapsedMs } = await getOverview();
    expect(status).toBe(200);
    const row = body.find(n => n.id === nodeId);
    expect(row).toBeDefined();
    expect(row!.status).toBe('offline');
    expect(row!.stats).toBeNull();
    expect(row!.systemStats).toBeNull();
    expect(row!.stacks).toBeNull();
    expect(row!.last_successful_contact).toBe(PRIOR_CONTACT);
    expect(elapsedMs).toBeGreaterThan(OVERVIEW_ABORT_FLOOR_MS);
    expect(elapsedMs).toBeLessThan(OVERVIEW_BUDGET_CEILING_MS);
  });

  it('degrades a fast-fail proxy remote to the same offline row', async () => {
    const nodeId = addProxyNode('refused-proxy', PROXY_BASE);
    mockTargets({ [nodeId]: { apiUrl: PROXY_BASE, apiToken: 'test-token', trustedLoopback: false } });
    mockFetch(() => Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })));

    const { status, body, elapsedMs } = await getOverview();
    expect(status).toBe(200);
    const row = body.find(n => n.id === nodeId);
    expect(row).toBeDefined();
    expect(row!.status).toBe('offline');
    expect(row!.stats).toBeNull();
    expect(row!.systemStats).toBeNull();
    expect(row!.stacks).toBeNull();
    expect(row!.last_successful_contact).toBe(PRIOR_CONTACT);
    expect(elapsedMs).toBeLessThan(FAST_PATH_CEILING_MS);
  });

  it('degrades a disconnected Pilot without issuing HTTP probes', async () => {
    const nodeId = addPilotNode('disconnected-pilot');
    mockTargets({ [nodeId]: null });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const { status, body, elapsedMs } = await getOverview();
    expect(status).toBe(200);
    const row = body.find(n => n.id === nodeId);
    expect(row).toBeDefined();
    expect(row!.stats).toBeNull();
    expect(row!.systemStats).toBeNull();
    expect(row!.stacks).toBeNull();
    expect(row!.pilot_last_seen).toBeTypeOf('number');
    // Tunnel closed moments ago: still inside the reconnect grace window.
    expect(row!.status).toBe('online');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(elapsedMs).toBeLessThan(FAST_PATH_CEILING_MS);
  });

  it.each([
    [29_000, 'online'],
    [31_000, 'offline'],
  ])('reports a Pilot whose tunnel closed %ims ago as %s', async (agoMs, expected) => {
    const nodeId = addPilotNode('boundary-pilot');
    DatabaseService.getInstance().updateNode(nodeId, { pilot_last_seen: Date.now() - agoMs });
    mockTargets({ [nodeId]: null });

    const { body } = await getOverview();
    expect(body.find(n => n.id === nodeId)?.status).toBe(expected);
  });

  it('reports a Pilot gone longer than the reconnect grace window as offline', async () => {
    const nodeId = addPilotNode('gone-pilot');
    DatabaseService.getInstance().updateNode(nodeId, { pilot_last_seen: Date.now() - 5 * 60_000 });
    mockTargets({ [nodeId]: null });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const { status, body } = await getOverview();
    expect(status).toBe(200);
    const row = body.find(n => n.id === nodeId);
    expect(row).toBeDefined();
    expect(row!.status).toBe('offline');
    expect(row!.stats).toBeNull();
    // The last time the tunnel was up is still reported for the card.
    expect(row!.pilot_last_seen).toBeTypeOf('number');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns a mixed fleet without waiting on the hung remote', async () => {
    const hungId = addProxyNode('mixed-hung', PROXY_BASE);
    const healthyId = addProxyNode('mixed-healthy', HEALTHY_BASE);
    mockTargets({
      [hungId]: { apiUrl: PROXY_BASE, apiToken: 'test-token', trustedLoopback: false },
      [healthyId]: { apiUrl: HEALTHY_BASE, apiToken: 'test-token', trustedLoopback: false },
    });
    mockFetch((url, init) => {
      try {
        if (new URL(url).origin === HEALTHY_BASE) return healthyHandler(HEALTHY_BASE)(url, init);
      } catch {
        // Invalid URLs are not the healthy host.
      }
      return hungUntilAbort(init);
    });

    const { status, body, elapsedMs } = await getOverview();
    expect(status).toBe(200);
    const hung = body.find(n => n.id === hungId);
    const healthy = body.find(n => n.id === healthyId);
    const local = body.find(n => n.type === 'local');
    expect(local).toBeDefined();
    expect(healthy).toBeDefined();
    expect(healthy!.status).toBe('online');
    expect(healthy!.stats).toEqual(STATS);
    expect(hung).toBeDefined();
    expect(hung!.status).toBe('offline');
    expect(hung!.last_successful_contact).toBe(PRIOR_CONTACT);
    expect(elapsedMs).toBeGreaterThan(OVERVIEW_ABORT_FLOOR_MS);
    expect(elapsedMs).toBeLessThan(OVERVIEW_BUDGET_CEILING_MS);
  });

  it('keeps a remote online when only one of the three probes fails', async () => {
    const nodeId = addProxyNode('partial-proxy', PROXY_BASE);
    mockTargets({ [nodeId]: { apiUrl: PROXY_BASE, apiToken: 'test-token', trustedLoopback: false } });
    mockFetch((url, init) => {
      if (url === `${PROXY_BASE}/api/stats`) return hungUntilAbort(init);
      if (url === `${PROXY_BASE}/api/system/stats`) return jsonResponse(SYSTEM_STATS);
      if (url === `${PROXY_BASE}/api/stacks`) return jsonResponse(['web']);
      return new Response('not found', { status: 404 });
    });

    const { status, body, elapsedMs } = await getOverview();
    expect(status).toBe(200);
    const row = body.find(n => n.id === nodeId);
    expect(row).toBeDefined();
    expect(row!.status).toBe('online');
    expect(row!.stats).toBeNull();
    expect(row!.systemStats).toMatchObject({ cpu: { usage: '12.3', cores: 4 } });
    expect(row!.stacks).toEqual(['web']);
    expect(row!.last_successful_contact).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) - 5);
    expect(elapsedMs).toBeGreaterThan(OVERVIEW_ABORT_FLOOR_MS);
    expect(elapsedMs).toBeLessThan(OVERVIEW_BUDGET_CEILING_MS);
  });

  it('preserves last contact when proxy target resolution throws', async () => {
    const nodeId = addProxyNode('throwing-proxy', PROXY_BASE);
    vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockImplementation((id: number) => {
      if (id === nodeId) throw new Error('registry failed');
      return null;
    });

    const { status, body, elapsedMs } = await getOverview();
    expect(status).toBe(200);
    const row = body.find(n => n.id === nodeId);
    expect(row).toBeDefined();
    expect(row!.status).toBe('offline');
    expect(row!.mode).toBe('proxy');
    expect(row!.stats).toBeNull();
    expect(row!.last_successful_contact).toBe(PRIOR_CONTACT);
    expect(elapsedMs).toBeLessThan(FAST_PATH_CEILING_MS);
  });
});

describe('node-data fan-outs share the per-remote read budget', () => {
  // Above the 8s read budget, well under the old 15s ceiling.
  const READ_BUDGET_FLOOR_MS = 7_000;
  const READ_BUDGET_CEILING_MS = 12_000;

  function stubLocalDocker(): void {
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDependencySnapshot: vi.fn().mockResolvedValue({ containers: [], networks: [], volumes: [] }),
    } as unknown as DockerController);
  }

  it('degrades a half-open remote to a nodeError on the dependency map within the budget', async () => {
    stubLocalDocker();
    const nodeId = addProxyNode('hung-map', PROXY_BASE);
    const healthyId = addProxyNode('healthy-map', HEALTHY_BASE);
    mockTargets({
      [nodeId]: { apiUrl: PROXY_BASE, apiToken: 'test-token', trustedLoopback: false },
      [healthyId]: { apiUrl: HEALTHY_BASE, apiToken: 'test-token', trustedLoopback: false },
    });
    mockFetch((url, init) => {
      if (url.startsWith(`${HEALTHY_BASE}/api/dependency-map/node-graph`)) {
        return jsonResponse({ nodes: [{ id: 'host', kind: 'host', label: 'healthy-map', stack: null, state: null, flags: [] }], edges: [], flags: [], parseErrors: [] });
      }
      return hungUntilAbort(init);
    });

    const started = Date.now();
    const res = await request(app).get('/api/fleet/dependency-map').set('Authorization', authHeader);
    const elapsedMs = Date.now() - started;

    expect(res.status).toBe(200);
    const errors = res.body.nodeErrors as { nodeId: number; error: string }[];
    const hungError = errors.find(e => e.nodeId === nodeId);
    expect(hungError?.error).toBe('Timed out after 8s');
    // The healthy neighbour is not held back by the hung one.
    expect(errors.map(e => e.nodeId)).not.toContain(healthyId);
    expect((res.body.nodes as { nodeId: number }[]).some(n => n.nodeId === healthyId)).toBe(true);
    expect(elapsedMs).toBeGreaterThan(READ_BUDGET_FLOOR_MS);
    expect(elapsedMs).toBeLessThan(READ_BUDGET_CEILING_MS);
  }, 20_000);

  it('degrades a half-open remote to an error row on the networking summary within the budget', async () => {
    stubLocalDocker();
    const nodeId = addProxyNode('hung-networking', PROXY_BASE);
    mockTargets({ [nodeId]: { apiUrl: PROXY_BASE, apiToken: 'test-token', trustedLoopback: false } });
    mockFetch((_url, init) => hungUntilAbort(init));

    const started = Date.now();
    const res = await request(app).get('/api/fleet/networking-summary').set('Authorization', authHeader);
    const elapsedMs = Date.now() - started;

    expect(res.status).toBe(200);
    const row = (res.body.nodes as { nodeId: number; status: string; error?: string }[]).find(n => n.nodeId === nodeId);
    expect(row?.status).toBe('error');
    expect(row?.error).toBe('Timed out after 8s');
    expect(elapsedMs).toBeGreaterThan(READ_BUDGET_FLOOR_MS);
    expect(elapsedMs).toBeLessThan(READ_BUDGET_CEILING_MS);
  }, 20_000);

  describe('GET /api/fleet/dependency-map?nodeId=', () => {
    const graph = { nodes: [{ id: 'host', kind: 'host', label: 'x', stack: null, state: null, flags: [] }], edges: [], flags: [], parseErrors: [] };

    async function getMap(query: string) {
      return request(app).get(`/api/fleet/dependency-map${query}`).set('Authorization', authHeader);
    }

    it('answers for one node without waiting on a hung neighbour', async () => {
      stubLocalDocker();
      const hungId = addProxyNode('hung-neighbour', PROXY_BASE);
      const healthyId = addProxyNode('healthy-slice', HEALTHY_BASE);
      mockTargets({
        [hungId]: { apiUrl: PROXY_BASE, apiToken: 'test-token', trustedLoopback: false },
        [healthyId]: { apiUrl: HEALTHY_BASE, apiToken: 'test-token', trustedLoopback: false },
      });
      const fetchSpy = mockFetch((url, init) => (url.startsWith(HEALTHY_BASE) ? jsonResponse(graph) : hungUntilAbort(init)));

      const started = Date.now();
      const res = await getMap(`?nodeId=${healthyId}`);
      expect(res.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(FAST_PATH_CEILING_MS);
      expect((res.body.nodes as { nodeId: number }[]).every(n => n.nodeId === healthyId)).toBe(true);
      expect(res.body.nodes).toHaveLength(1);
      expect(res.body.nodeErrors).toEqual([]);
      // Only the asked-for node was read.
      const requested = fetchSpy.mock.calls.map((call: unknown[]) => String(call[0]));
      expect(requested.length).toBeGreaterThan(0);
      expect(requested.every((u: string) => u.startsWith(HEALTHY_BASE))).toBe(true);
    });

    it('reports a failing node as that node\'s error, not a failed request', async () => {
      stubLocalDocker();
      const goneId = addPilotNode('gone-slice');
      mockTargets({ [goneId]: null });
      const res = await getMap(`?nodeId=${goneId}`);
      expect(res.status).toBe(200);
      expect(res.body.nodes).toEqual([]);
      expect((res.body.nodeErrors as { nodeId: number }[]).map(e => e.nodeId)).toEqual([goneId]);
    });

    it.each(['abc', '0', '-3', '1.5', ''])('rejects a malformed nodeId (%s)', async (bad) => {
      const res = await getMap(`?nodeId=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
    });

    it('answers 404 for a node that does not exist', async () => {
      const res = await getMap('?nodeId=99999');
      expect(res.status).toBe(404);
    });

    it('still returns the whole fleet without the filter', async () => {
      stubLocalDocker();
      const addedId = addPilotNode('unfiltered-gone');
      mockTargets({ [addedId]: null });
      const res = await getMap('');
      expect(res.status).toBe(200);
      expect((res.body.nodeErrors as { nodeId: number }[]).map(e => e.nodeId)).toContain(addedId);
    });
  });
});
