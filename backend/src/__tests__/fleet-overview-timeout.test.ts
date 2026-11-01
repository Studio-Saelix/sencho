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
import si from 'systeminformation';
import { CacheService } from '../services/CacheService';
import DockerController from '../services/DockerController';
import { HOST_USAGE_UNKNOWN_HEADER } from '../services/CapabilityRegistry';
import { _resetHostSampleStateForTests } from '../helpers/hostSample';
import { _resetLocalLabelInventoryShareForTests } from '../helpers/localLabelInventory';
import { createTestApiToken } from './helpers/apiTokenTestHelper';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;
let NodeRegistry: typeof import('../services/NodeRegistry').NodeRegistry;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

const PROXY_BASE = 'http://remote.example.com';
const HEALTHY_BASE = 'http://good-host.example.com';
const PRIOR_CONTACT = 1_700_000_000;
const OVERVIEW_BUDGET_CEILING_MS = 12_000;
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

  // Long enough for the whole file: several cases wait out the 5s read budget,
  // and a token that expires mid-run turns later assertions into 401s.
  const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1h' });
  authHeader = `Bearer ${token}`;
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetLocalLabelInventoryShareForTests();
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

/** The origin of a request URL, or null when it is not a URL. Compared whole, never by prefix. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
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

async function getOverview(
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: OverviewRow[]; elapsedMs: number }> {
  const started = Date.now();
  let req = request(app).get('/api/fleet/overview').set('Authorization', authHeader);
  for (const [name, value] of Object.entries(extraHeaders)) req = req.set(name, value);
  const res = await req;
  return { status: res.status, body: res.body as OverviewRow[], elapsedMs: Date.now() - started };
}

function addReadOnlyToken(name: string): string {
  const admin = DatabaseService.getInstance().getUserByUsername(TEST_USERNAME);
  if (!admin?.id) throw new Error('expected the seeded admin');
  return createTestApiToken({ db: DatabaseService, scope: 'read-only', userId: admin.id, name });
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

  // The boundary sits 5s either side of the 30s grace window, so the request
  // itself outlasting the window on a loaded box cannot flip the expectation.
  it.each([
    [25_000, 'online'],
    [35_000, 'offline'],
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

describe('node-data fan-outs share the fleet-read budget', () => {
  // A hung remote must answer at the 5s budget. The floor catches an early
  // return; the ceiling is loose on purpose, because a loaded CI box inflates
  // the whole request and the old per-node ceilings were 8s and 30s.
  const READ_BUDGET_FLOOR_MS = 4_000;
  const READ_BUDGET_CEILING_MS = 12_000;
  // A healthy or never-contacted node must not wait on the budget at all.
  const HEALTHY_PATH_CEILING_MS = 5_000;

  function stubLocalDocker(): void {
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      ping: vi.fn().mockResolvedValue(undefined),
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
    expect(hungError?.error).toBe('Timed out after 5s');
    // The healthy neighbour is not held back by the hung one.
    expect(errors.map(e => e.nodeId)).not.toContain(healthyId);
    expect((res.body.nodes as { nodeId: number }[]).some(n => n.nodeId === healthyId)).toBe(true);
    expect(elapsedMs).toBeGreaterThan(READ_BUDGET_FLOOR_MS);
    expect(elapsedMs).toBeLessThan(READ_BUDGET_CEILING_MS);
  }, 30_000);

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
    expect(row?.error).toBe('Timed out after 5s');
    expect(elapsedMs).toBeGreaterThan(READ_BUDGET_FLOOR_MS);
    expect(elapsedMs).toBeLessThan(READ_BUDGET_CEILING_MS);
  }, 30_000);

  describe('hub-local reads use the local deadline', () => {
    /**
     * The hub's own graph and summary build from a Docker snapshot that grows
     * with the host. 5.5 s is longer than the flat remote budget and shorter
     * than the local deadline the route must apply.
     */
    function stubSlowLocalDocker(delayMs: number): void {
      vi.spyOn(DockerController, 'getInstance').mockReturnValue({
        ping: vi.fn().mockResolvedValue(undefined),
        getDependencySnapshot: vi.fn(() => new Promise((resolve) => {
          setTimeout(() => resolve({ containers: [], networks: [], volumes: [] }), delayMs);
        })),
      } as unknown as DockerController);
    }

    it('does not cut the hub\'s own dependency graph at the flat 5 s budget', async () => {
      stubSlowLocalDocker(5_500);

      const started = Date.now();
      const res = await request(app).get('/api/fleet/dependency-map?nodeId=1').set('Authorization', authHeader);
      const elapsedMs = Date.now() - started;

      expect(res.status).toBe(200);
      // The route merges each node's graph, so the local host node is in
      // `nodes` and a cut read would instead appear in `nodeErrors`.
      expect(res.body.nodeErrors).toEqual([]);
      expect((res.body.nodes as { nodeId?: number }[]).some(n => n.nodeId === 1)).toBe(true);
      expect(elapsedMs).toBeGreaterThan(5_000);
      expect(elapsedMs).toBeLessThan(18_000);
    }, 30_000);

    it('does not cut the hub\'s own networking summary at the flat 5 s budget', async () => {
      stubSlowLocalDocker(5_500);

      const started = Date.now();
      const res = await request(app).get('/api/fleet/networking-summary?nodeId=1').set('Authorization', authHeader);
      const elapsedMs = Date.now() - started;

      expect(res.status).toBe(200);
      const row = (res.body.nodes as { nodeId: number; status: string; summary: unknown; error: string | null }[])[0];
      expect(row).toMatchObject({ nodeId: 1, status: 'ok', error: null });
      expect(row.summary).not.toBeNull();
      expect(elapsedMs).toBeGreaterThan(5_000);
      expect(elapsedMs).toBeLessThan(18_000);
    }, 30_000);
  });

  describe('GET /api/fleet/networking-summary?nodeId=', () => {
    it('narrows the fan-out to one node', async () => {
      stubLocalDocker();
      const healthyId = addProxyNode('summary-slice', HEALTHY_BASE);
      mockTargets({ [healthyId]: { apiUrl: HEALTHY_BASE, apiToken: 'test-token', trustedLoopback: false } });
      const fetchSpy = mockFetch((url) => (String(url).startsWith(`${HEALTHY_BASE}/api/networking/summary`)
        ? jsonResponse({ exposed: { count: 1, stacks: ['web'] }, unknownExposure: { count: 0, stacks: [] }, networkDrift: { count: 0, stacks: [] } })
        : new Response('not found', { status: 404 })));

      const res = await request(app).get(`/api/fleet/networking-summary?nodeId=${healthyId}`).set('Authorization', authHeader);
      expect(res.status).toBe(200);
      const rows = res.body.nodes as { nodeId: number; status: string; summary: { exposed: { count: number } } | null }[];
      expect(rows.map(n => n.nodeId)).toEqual([healthyId]);
      expect(rows[0]).toMatchObject({ status: 'ok', summary: { exposed: { count: 1 } } });
      const requested = fetchSpy.mock.calls.map((call: unknown[]) => String(call[0]));
      expect(requested.length).toBeGreaterThan(0);
      expect(requested.every((u: string) => originOf(u) === HEALTHY_BASE)).toBe(true);
    });
  });

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
      const fetchSpy = mockFetch((url, init) => (originOf(url) === HEALTHY_BASE ? jsonResponse(graph) : hungUntilAbort(init)));

      const started = Date.now();
      const res = await getMap(`?nodeId=${healthyId}`);
      expect(res.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(HEALTHY_PATH_CEILING_MS);
      expect((res.body.nodes as { nodeId: number }[]).every(n => n.nodeId === healthyId)).toBe(true);
      expect(res.body.nodes).toHaveLength(1);
      expect(res.body.nodeErrors).toEqual([]);
      // Only the asked-for node was read.
      const requested = fetchSpy.mock.calls.map((call: unknown[]) => String(call[0]));
      expect(requested.length).toBeGreaterThan(0);
      expect(requested.every((u: string) => originOf(u) === HEALTHY_BASE)).toBe(true);
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

  describe('GET /api/fleet/container-labels', () => {
    function stubLocalLabelDocker(): void {
      vi.spyOn(DockerController, 'getInstance').mockReturnValue({
        // The route pings, then builds the inventory; both answer at once in
        // the healthy case. getAllContainers is absent on purpose: the old
        // pre-count must fail loudly if it comes back.
        ping: vi.fn().mockResolvedValue(undefined),
        listContainersForLabelInventory: vi.fn().mockResolvedValue([]),
        inspectImageLabels: vi.fn(),
      } as unknown as DockerController);
    }

    function inventory(nodeId: number): Record<string, unknown> {
      return { nodeId, partial: false, generatedAt: Date.now(), containers: [], byLabel: [] };
    }

    function labelsHandler(healthyId: number) {
      return (url: string, init?: RequestInit) => {
        if (originOf(url) === HEALTHY_BASE && String(url).startsWith(`${HEALTHY_BASE}/api/system/container-labels`)) {
          return jsonResponse(inventory(healthyId));
        }
        return hungUntilAbort(init);
      };
    }

    async function getLabels(query = '') {
      return request(app).get(`/api/fleet/container-labels${query}`).set('Authorization', authHeader);
    }

    it('merges an all-healthy fleet', async () => {
      stubLocalLabelDocker();
      const healthyId = addProxyNode('healthy-labels', HEALTHY_BASE);
      mockTargets({ [healthyId]: { apiUrl: HEALTHY_BASE, apiToken: 'test-token', trustedLoopback: false } });
      mockFetch(labelsHandler(healthyId));

      const started = Date.now();
      const res = await getLabels();
      expect(res.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(HEALTHY_PATH_CEILING_MS);
      const rows = res.body.nodes as { nodeId: number; status: string; inventory: { nodeId: number } | null }[];
      expect(rows.every(r => r.status === 'ok')).toBe(true);
      const healthy = rows.find(r => r.nodeId === healthyId);
      expect(healthy?.inventory).toMatchObject({ nodeId: healthyId });
      expect(res.body.nodeErrors).toEqual({});
    });

    it('degrades a hung proxy remote inside the budget while the healthy nodes still answer', async () => {
      stubLocalLabelDocker();
      const hungId = addProxyNode('hung-labels', PROXY_BASE);
      const healthyId = addProxyNode('healthy-labels', HEALTHY_BASE);
      mockTargets({
        [hungId]: { apiUrl: PROXY_BASE, apiToken: 'test-token', trustedLoopback: false },
        [healthyId]: { apiUrl: HEALTHY_BASE, apiToken: 'test-token', trustedLoopback: false },
      });
      mockFetch(labelsHandler(healthyId));

      const started = Date.now();
      const res = await getLabels();
      const elapsedMs = Date.now() - started;

      expect(res.status).toBe(200);
      const rows = res.body.nodes as { nodeId: number; status: string; error: string | null }[];
      expect(rows.find(r => r.nodeId === hungId)).toMatchObject({ status: 'error', error: 'Timed out after 5s' });
      expect(rows.find(r => r.nodeId === healthyId)).toMatchObject({ status: 'ok', error: null });
      expect(rows.find(r => r.nodeId !== hungId && r.nodeId !== healthyId)?.status).toBe('ok');
      expect((res.body.nodeErrors as Record<string, string>)[String(hungId)]).toBe('Timed out after 5s');
      expect(elapsedMs).toBeGreaterThan(READ_BUDGET_FLOOR_MS);
      expect(elapsedMs).toBeLessThan(READ_BUDGET_CEILING_MS);
    }, 30_000);

    it('reports a disconnected Pilot without a 30-second wait and without issuing HTTP', async () => {
      stubLocalLabelDocker();
      const goneId = addPilotNode('gone-labels');
      mockTargets({ [goneId]: null });
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const started = Date.now();
      const res = await getLabels();
      expect(res.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(HEALTHY_PATH_CEILING_MS);
      expect(fetchSpy).not.toHaveBeenCalled();
      const row = (res.body.nodes as { nodeId: number; status: string; error: string | null }[]).find(r => r.nodeId === goneId);
      expect(row?.status).toBe('error');
      expect(row?.error).toContain('Pilot tunnel');
    });

    it('answers for one node with ?nodeId= and keeps the aggregate shape', async () => {
      stubLocalLabelDocker();
      const healthyId = addProxyNode('slice-labels', HEALTHY_BASE);
      const otherId = addProxyNode('other-labels', PROXY_BASE);
      mockTargets({
        [healthyId]: { apiUrl: HEALTHY_BASE, apiToken: 'test-token', trustedLoopback: false },
        [otherId]: { apiUrl: PROXY_BASE, apiToken: 'test-token', trustedLoopback: false },
      });
      const fetchSpy = mockFetch(labelsHandler(healthyId));

      const res = await getLabels(`?nodeId=${healthyId}`);
      expect(res.status).toBe(200);
      expect((res.body.nodes as { nodeId: number }[]).map(r => r.nodeId)).toEqual([healthyId]);
      const requested = fetchSpy.mock.calls.map((call: unknown[]) => String(call[0]));
      expect(requested.length).toBeGreaterThan(0);
      expect(requested.every((u: string) => originOf(u) === HEALTHY_BASE)).toBe(true);
    });

    it('bounds the hub\'s own read by the time Docker takes to answer it', async () => {
      vi.spyOn(DockerController, 'getInstance').mockReturnValue({
        // A wedged local Docker socket never answers the liveness check and
        // cannot be aborted, so the first contact with Docker costs one budget.
        ping: vi.fn().mockReturnValue(new Promise(() => {})),
        getAllContainers: vi.fn().mockReturnValue(new Promise(() => {})),
        listContainersForLabelInventory: vi.fn().mockReturnValue(new Promise(() => {})),
      } as unknown as DockerController);

      const started = Date.now();
      const res = await getLabels('?nodeId=1');
      const elapsedMs = Date.now() - started;

      expect(res.status).toBe(200);
      expect((res.body.nodes as { nodeId: number; status: string; error: string | null }[])[0])
        .toMatchObject({ status: 'error', error: 'Timed out after 5s' });
      expect(elapsedMs).toBeGreaterThan(READ_BUDGET_FLOOR_MS);
      expect(elapsedMs).toBeLessThan(READ_BUDGET_CEILING_MS);
    }, 30_000);

    it('returns a large hub\'s own inventory instead of calling it a timeout', async () => {
      const containers = Array.from({ length: 455 }, (_, i) => ({
        id: `container-${i}`,
        name: `container-${i}`,
        state: 'running',
        stack: 'demo',
        service: 'web',
        labels: { 'traefik.enable': 'true' },
        imageId: 'sha256:image',
        inspectFailed: false,
      }));
      vi.spyOn(DockerController, 'getInstance').mockReturnValue({
        ping: vi.fn().mockResolvedValue(undefined),
        // The old pre-count listing: never answers, so a regression to it
        // cannot pass this test on a fast stub.
        getAllContainers: vi.fn(() => new Promise(() => {})),
        // A hub this size needs longer than the transport budget even when
        // Docker answers every call promptly.
        listContainersForLabelInventory: vi.fn(() => new Promise((resolve) => {
          setTimeout(() => resolve(containers), 5_500);
        })),
        inspectImageLabels: vi.fn().mockResolvedValue({ labels: {} }),
      } as unknown as DockerController);

      const res = await getLabels('?nodeId=1');

      expect(res.status).toBe(200);
      const localRow = (res.body.nodes as { nodeId: number; status: string; inventory: { containers: unknown[] } | null }[])[0];
      expect(localRow.status).toBe('ok');
      expect(localRow.inventory?.containers).toHaveLength(455);
      expect(res.body.nodeErrors).toEqual({});
    }, 30_000);

    it('returns a hub build that outlasts the old 12-second ceiling', async () => {
      // At 458 containers the hub's build alone needed more than the old
      // fixed 12 s slice after the ping in the real tab. The read now owns one
      // 18 s deadline, so a 12.5 s build (a fast ping leaves nearly all of it)
      // must return every row instead of a `Timed out after 12s` row.
      const containers = Array.from({ length: 3 }, (_, i) => ({
        id: `container-${i}`,
        name: `container-${i}`,
        state: 'running',
        stack: 'demo',
        service: 'web',
        labels: { 'traefik.enable': 'true' },
        imageId: 'sha256:image',
        inspectFailed: false,
      }));
      vi.spyOn(DockerController, 'getInstance').mockReturnValue({
        ping: vi.fn().mockResolvedValue(undefined),
        getAllContainers: vi.fn(() => new Promise(() => {})),
        listContainersForLabelInventory: vi.fn(() => new Promise((resolve) => {
          setTimeout(() => resolve(containers), 12_500);
        })),
        inspectImageLabels: vi.fn().mockResolvedValue({ labels: {} }),
      } as unknown as DockerController);

      const res = await getLabels('?nodeId=1');

      expect(res.status).toBe(200);
      const localRow = (res.body.nodes as { nodeId: number; status: string; inventory: { containers: unknown[] } | null }[])[0];
      expect(localRow.status).toBe('ok');
      expect(localRow.inventory?.containers).toHaveLength(3);
      expect(res.body.nodeErrors).toEqual({});
    }, 30_000);

    it.each(['abc', '0', '-3', '1.5', ''])('rejects a malformed nodeId (%s)', async (bad) => {
      const res = await getLabels(`?nodeId=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
    });

    it('answers 404 for a node that does not exist', async () => {
      const res = await getLabels('?nodeId=99999');
      expect(res.status).toBe(404);
    });
  });
});

// Host scope parity across the three transports: the local sample is scoped to
// the Docker host, and a remote that reports unknown usage passes it through
// unchanged instead of being coerced to 0.
describe('GET /api/fleet/overview host scope', () => {
  const GiB = 1024 ** 3;
  const UNKNOWN_STATS = {
    cpu: { usage: null, cores: 2 },
    memory: { total: 4 * GiB, used: null, free: null, usagePercent: null },
    disk: null,
  };

  it('passes a remote node\'s unknown usage through unchanged', async () => {
    const nodeId = addProxyNode('nested-remote', PROXY_BASE);
    mockTargets({ [nodeId]: { apiUrl: PROXY_BASE, apiToken: 'test-token', trustedLoopback: false } });
    mockFetch((url) => {
      if (url === `${PROXY_BASE}/api/stats`) return jsonResponse(STATS);
      if (url === `${PROXY_BASE}/api/system/stats`) return jsonResponse(UNKNOWN_STATS);
      if (url === `${PROXY_BASE}/api/stacks`) return jsonResponse(['web']);
      return new Response('not found', { status: 404 });
    });

    const { status, body } = await getOverview();
    expect(status).toBe(200);
    const row = body.find(n => n.id === nodeId);
    expect(row!.systemStats).toEqual(UNKNOWN_STATS);
  });

  it('advertises nullable host usage on the remote system-stats probe', async () => {
    const nodeId = addProxyNode('capable-remote', PROXY_BASE);
    mockTargets({ [nodeId]: { apiUrl: PROXY_BASE, apiToken: 'test-token', trustedLoopback: false } });
    let seenHeaders: Record<string, string> | undefined;
    mockFetch((url, init) => {
      if (url === `${PROXY_BASE}/api/system/stats`) seenHeaders = init?.headers as Record<string, string> | undefined;
      if (url === `${PROXY_BASE}/api/stats`) return jsonResponse(STATS);
      if (url === `${PROXY_BASE}/api/system/stats`) return jsonResponse(UNKNOWN_STATS);
      if (url === `${PROXY_BASE}/api/stacks`) return jsonResponse(['web']);
      return new Response('not found', { status: 404 });
    });

    await getOverview();
    expect((seenHeaders as Record<string, string>)[HOST_USAGE_UNKNOWN_HEADER]).toBe('1');
  });

  it('advertises nullable host usage on a pilot target with no token', async () => {
    const nodeId = addProxyNode('pilot-remote', PROXY_BASE);
    mockTargets({ [nodeId]: { apiUrl: PROXY_BASE, apiToken: '', trustedLoopback: true } });
    let seenHeaders: Record<string, string> | undefined;
    mockFetch((url, init) => {
      if (url === `${PROXY_BASE}/api/system/stats`) seenHeaders = init?.headers as Record<string, string> | undefined;
      if (url === `${PROXY_BASE}/api/stats`) return jsonResponse(STATS);
      if (url === `${PROXY_BASE}/api/system/stats`) return jsonResponse(UNKNOWN_STATS);
      if (url === `${PROXY_BASE}/api/stacks`) return jsonResponse(['web']);
      return new Response('not found', { status: 404 });
    });

    await getOverview();
    expect(seenHeaders?.[HOST_USAGE_UNKNOWN_HEADER]).toBe('1');
    expect(seenHeaders?.Authorization).toBeUndefined();
  });

  it('keeps a remote token caller on the numeric shape it did not opt out of', async () => {
    const nodeId = addProxyNode('legacy-token-remote', PROXY_BASE);
    mockTargets({ [nodeId]: { apiUrl: PROXY_BASE, apiToken: 'test-token', trustedLoopback: false } });
    let seenHeaders: Record<string, string> | undefined;
    mockFetch((url, init) => {
      if (url === `${PROXY_BASE}/api/system/stats`) {
        seenHeaders = init?.headers as Record<string, string> | undefined;
        const unknown = seenHeaders?.[HOST_USAGE_UNKNOWN_HEADER] === '1';
        return jsonResponse(unknown ? UNKNOWN_STATS : SYSTEM_STATS);
      }
      if (url === `${PROXY_BASE}/api/stats`) return jsonResponse(STATS);
      if (url === `${PROXY_BASE}/api/stacks`) return jsonResponse(['web']);
      return new Response('not found', { status: 404 });
    });

    const { status, body } = await getOverview({
      Authorization: `Bearer ${addReadOnlyToken('legacy-fleet-token')}`,
    });
    expect(status).toBe(200);
    // The hub must ask the remote for the shape its own caller can render,
    // exactly as the proxy hop does, or a monitoring token gets `null`.
    expect(seenHeaders?.[HOST_USAGE_UNKNOWN_HEADER]).toBeUndefined();
    expect(body.find(n => n.id === nodeId)!.systemStats).toEqual(SYSTEM_STATS);
  });

  it('passes a token caller\'s nullable-usage request through to the remote', async () => {
    const nodeId = addProxyNode('capable-token-remote', PROXY_BASE);
    mockTargets({ [nodeId]: { apiUrl: PROXY_BASE, apiToken: 'test-token', trustedLoopback: false } });
    let seenHeaders: Record<string, string> | undefined;
    mockFetch((url, init) => {
      if (url === `${PROXY_BASE}/api/system/stats`) {
        seenHeaders = init?.headers as Record<string, string> | undefined;
        return jsonResponse(UNKNOWN_STATS);
      }
      if (url === `${PROXY_BASE}/api/stats`) return jsonResponse(STATS);
      if (url === `${PROXY_BASE}/api/stacks`) return jsonResponse(['web']);
      return new Response('not found', { status: 404 });
    });

    const { status, body } = await getOverview({
      Authorization: `Bearer ${addReadOnlyToken('capable-fleet-token')}`,
      [HOST_USAGE_UNKNOWN_HEADER]: '1',
    });
    expect(status).toBe(200);
    expect(seenHeaders?.[HOST_USAGE_UNKNOWN_HEADER]).toBe('1');
    expect(body.find(n => n.id === nodeId)!.systemStats).toEqual(UNKNOWN_STATS);
  });

  it('keeps a machine hub caller on the numeric shape when it sends no header', async () => {
    const nodeId = addProxyNode('legacy-hub-remote', PROXY_BASE);
    mockTargets({ [nodeId]: { apiUrl: PROXY_BASE, apiToken: 'test-token', trustedLoopback: false } });
    let seenHeaders: Record<string, string> | undefined;
    mockFetch((url, init) => {
      if (url === `${PROXY_BASE}/api/system/stats`) {
        seenHeaders = init?.headers as Record<string, string> | undefined;
        const unknown = seenHeaders?.[HOST_USAGE_UNKNOWN_HEADER] === '1';
        return jsonResponse(unknown ? UNKNOWN_STATS : SYSTEM_STATS);
      }
      if (url === `${PROXY_BASE}/api/stats`) return jsonResponse(STATS);
      if (url === `${PROXY_BASE}/api/stacks`) return jsonResponse(['web']);
      return new Response('not found', { status: 404 });
    });

    const hubToken = jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });
    const { status, body } = await getOverview({ Authorization: `Bearer ${hubToken}` });
    expect(status).toBe(200);
    expect(seenHeaders?.[HOST_USAGE_UNKNOWN_HEADER]).toBeUndefined();
    expect(body.find(n => n.id === nodeId)!.systemStats).toEqual(SYSTEM_STATS);
  });

  /**
   * Stub a nested local host whose Docker capacity (2 cores, 4 GiB) disagrees
   * with the kernel view (8 cores, 16 GiB). The container list must not hit the
   * real socket in CI, and the cgroup path must not resolve so usage is unknown.
   */
  function stubNestedLocalHost(): number {
    const db = DatabaseService.getInstance();
    const localNode = db.getDefaultNode();
    if (!localNode) throw new Error('expected a default local node');
    CacheService.getInstance().flush();
    _resetHostSampleStateForTests();
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getAllContainers: () => Promise.resolve([]),
    } as unknown as DockerController);
    process.env.SENCHO_HOST_CGROUP_PATH = '/nonexistent/fleet-overview-cgroup';
    vi.spyOn(NodeRegistry.prototype, 'getDocker').mockReturnValue({
      info: () => Promise.resolve({ NCPU: 2, MemTotal: 4 * GiB }),
    } as unknown as ReturnType<typeof NodeRegistry.prototype.getDocker>);
    vi.spyOn(si, 'currentLoad').mockResolvedValue({
      currentLoad: 33,
      cpus: Array.from({ length: 8 }, () => ({})),
    } as unknown as Awaited<ReturnType<typeof si.currentLoad>>);
    vi.spyOn(si, 'mem').mockResolvedValue({
      total: 16 * GiB,
      available: 12 * GiB,
      active: 4 * GiB,
      used: 4 * GiB,
      free: 12 * GiB,
      buffcache: 0,
    } as unknown as Awaited<ReturnType<typeof si.mem>>);
    vi.spyOn(si, 'fsSize').mockResolvedValue([
      { fs: '/dev/sda1', mount: '/', size: 100 * GiB, used: 40 * GiB, available: 60 * GiB, use: 40 },
    ] as unknown as Awaited<ReturnType<typeof si.fsSize>>);
    return localNode.id;
  }

  it('reports Docker capacity for a local node whose kernel view is the outer machine', async () => {
    const localNodeId = stubNestedLocalHost();
    try {
      const { body } = await getOverview();
      const row = body.find(n => n.id === localNodeId);
      expect(row!.systemStats).toMatchObject({
        cpu: { usage: null, cores: 2 },
        memory: { total: 4 * GiB, used: null, free: null, usagePercent: null },
      });
    } finally {
      delete process.env.SENCHO_HOST_CGROUP_PATH;
    }
  });

  it('keeps a local token caller on the numeric shape it did not opt out of', async () => {
    const localNodeId = stubNestedLocalHost();
    try {
      const { body } = await getOverview({
        Authorization: `Bearer ${addReadOnlyToken('legacy-local-fleet-token')}`,
      });
      const row = body.find(n => n.id === localNodeId);
      expect(row!.systemStats).toMatchObject({
        cpu: { usage: '33.0', cores: 8 },
        memory: { total: 16 * GiB, used: 4 * GiB, free: 12 * GiB, usagePercent: '25.0' },
      });
    } finally {
      delete process.env.SENCHO_HOST_CGROUP_PATH;
    }
  });

  it('keeps a local machine hub caller on the numeric shape when it sends no header', async () => {
    const localNodeId = stubNestedLocalHost();
    try {
      const hubToken = jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });
      const { body } = await getOverview({ Authorization: `Bearer ${hubToken}` });
      const row = body.find(n => n.id === localNodeId);
      expect(row!.systemStats).toMatchObject({
        cpu: { usage: '33.0', cores: 8 },
        memory: { total: 16 * GiB, used: 4 * GiB, free: 12 * GiB, usagePercent: '25.0' },
      });
    } finally {
      delete process.env.SENCHO_HOST_CGROUP_PATH;
    }
  });

  it('gives a local token caller the nullable shape when it asks for it', async () => {
    const localNodeId = stubNestedLocalHost();
    try {
      const { body } = await getOverview({
        Authorization: `Bearer ${addReadOnlyToken('capable-local-fleet-token')}`,
        [HOST_USAGE_UNKNOWN_HEADER]: '1',
      });
      const row = body.find(n => n.id === localNodeId);
      expect(row!.systemStats).toMatchObject({
        cpu: { usage: null, cores: 2 },
        memory: { total: 4 * GiB, used: null, free: null, usagePercent: null },
      });
    } finally {
      delete process.env.SENCHO_HOST_CGROUP_PATH;
    }
  });
});
