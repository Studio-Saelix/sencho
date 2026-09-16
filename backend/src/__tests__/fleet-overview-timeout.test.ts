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
    expect(row!.status).toBe('online');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(elapsedMs).toBeLessThan(FAST_PATH_CEILING_MS);
  });

  it('returns a mixed fleet without waiting on the hung remote', async () => {
    const hungId = addProxyNode('mixed-hung', PROXY_BASE);
    const healthyId = addProxyNode('mixed-healthy', HEALTHY_BASE);
    mockTargets({
      [hungId]: { apiUrl: PROXY_BASE, apiToken: 'test-token', trustedLoopback: false },
      [healthyId]: { apiUrl: HEALTHY_BASE, apiToken: 'test-token', trustedLoopback: false },
    });
    mockFetch((url, init) => {
      if (url.startsWith(HEALTHY_BASE)) return healthyHandler(HEALTHY_BASE)(url, init);
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
