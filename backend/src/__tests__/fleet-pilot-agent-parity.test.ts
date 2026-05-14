/**
 * F9 regression guard: fleet aggregator routes return real data for
 * pilot-agent nodes (capabilities, version, metrics, stacks, drilldown,
 * configuration) by dispatching through NodeRegistry.getProxyTarget instead
 * of reading node.api_url/api_token directly.
 *
 * Pre-fix:
 *   - GET /api/fleet/overview returned stats=null/systemStats=null/stacks=null
 *     for pilot-agent rows.
 *   - GET /api/fleet/node/:id/stacks 503'd with "Remote node not configured".
 *   - GET /api/fleet/node/:id/stacks/:stack/containers 503'd the same way.
 *   - GET /api/fleet/update-status reported version=null and the Fleet card
 *     showed perpetual "Update available".
 *   - GET /api/fleet/configuration reported configuration=null.
 *
 * Post-fix: each surface fetches through the loopback URL when a pilot
 * tunnel is active and degrades to a mode-aware offline shape when not.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;
let pilotNodeId: number;
let NodeRegistry: typeof import('../services/NodeRegistry').NodeRegistry;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

const LOOPBACK = 'http://127.0.0.1:54321';

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ NodeRegistry } = await import('../services/NodeRegistry'));
  ({ DatabaseService } = await import('../services/DatabaseService'));

  pilotNodeId = DatabaseService.getInstance().addNode({
    name: 'pilot-parity-test',
    type: 'remote',
    mode: 'pilot_agent',
    compose_dir: '/tmp',
    is_default: false,
    api_url: '',
    api_token: '',
  });
  // Mark as recently seen so offline-status branches that key on
  // pilot_last_seen render the expected shape.
  DatabaseService.getInstance().updateNode(pilotNodeId, {
    pilot_last_seen: Date.now(),
    pilot_agent_version: '0.76.7',
  });

  const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });
  authHeader = `Bearer ${token}`;
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockTargetActive() {
  vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockImplementation((id: number) => {
    if (id === pilotNodeId) return { apiUrl: LOOPBACK, apiToken: '' };
    return null;
  });
}

function mockTargetOffline() {
  vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue(null);
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.toString() : (input as Request).url;
    return handler(url, init);
  });
}

describe('GET /api/fleet/node/:nodeId/stacks (pilot-agent)', () => {
  it('returns the pilot stacks via the loopback target', async () => {
    mockTargetActive();
    mockFetch((url) => {
      expect(url).toBe(`${LOOPBACK}/api/stacks`);
      return new Response(JSON.stringify(['audit-mesh-pilot', 'monitor']), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });

    const res = await request(app)
      .get(`/api/fleet/node/${pilotNodeId}/stacks`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(['audit-mesh-pilot', 'monitor']);
  });

  it('returns 503 with a pilot-tunnel-disconnected message when no target is available', async () => {
    mockTargetOffline();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await request(app)
      .get(`/api/fleet/node/${pilotNodeId}/stacks`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(503);
    expect(res.body?.error).toMatch(/pilot tunnel/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('omits Authorization when target.apiToken is empty', async () => {
    mockTargetActive();
    let observedHeaders: Record<string, string> | undefined;
    mockFetch((_url, init) => {
      observedHeaders = (init?.headers as Record<string, string> | undefined) ?? undefined;
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await request(app)
      .get(`/api/fleet/node/${pilotNodeId}/stacks`)
      .set('Authorization', authHeader);

    expect(observedHeaders).toBeDefined();
    expect(observedHeaders).not.toHaveProperty('Authorization');
  });
});

describe('GET /api/fleet/node/:nodeId/stacks/:stackName/containers (pilot-agent)', () => {
  it('returns containers via the loopback target', async () => {
    mockTargetActive();
    mockFetch((url) => {
      expect(url).toBe(`${LOOPBACK}/api/stacks/audit-mesh-pilot/containers`);
      return new Response(
        JSON.stringify([{ id: 'c1', name: 'audit-mesh-pilot-echo-1', state: 'running' }]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const res = await request(app)
      .get(`/api/fleet/node/${pilotNodeId}/stacks/audit-mesh-pilot/containers`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('audit-mesh-pilot-echo-1');
  });

  it('returns 503 with pilot-tunnel-disconnected when no target is available', async () => {
    mockTargetOffline();
    const res = await request(app)
      .get(`/api/fleet/node/${pilotNodeId}/stacks/audit-mesh-pilot/containers`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(503);
    expect(res.body?.error).toMatch(/pilot tunnel/i);
  });
});

describe('GET /api/fleet/overview (pilot-agent)', () => {
  it('populates stats, systemStats, and stacks for pilot-agent rows when the tunnel is up', async () => {
    mockTargetActive();
    mockFetch((url) => {
      if (url === `${LOOPBACK}/api/stats`) {
        return new Response(
          JSON.stringify({ active: 3, managed: 2, unmanaged: 1, exited: 0, total: 3 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === `${LOOPBACK}/api/system/stats`) {
        return new Response(
          JSON.stringify({
            cpu: { usage: '12.3', cores: 4 },
            memory: { total: 8000000000, used: 2000000000, free: 6000000000, usagePercent: '25.0' },
            disk: { total: 10, used: 5, free: 5, usagePercent: '50.0' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === `${LOOPBACK}/api/stacks`) {
        return new Response(JSON.stringify(['audit-mesh-pilot']), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });

    const res = await request(app).get('/api/fleet/overview').set('Authorization', authHeader);

    expect(res.status).toBe(200);
    const pilotRow = (res.body as Array<Record<string, unknown>>).find(r => r.id === pilotNodeId);
    expect(pilotRow).toBeDefined();
    expect(pilotRow!.status).toBe('online');
    expect(pilotRow!.stats).toEqual({ active: 3, managed: 2, unmanaged: 1, exited: 0, total: 3 });
    expect(pilotRow!.systemStats).toMatchObject({
      cpu: { usage: '12.3', cores: 4 },
      memory: { usagePercent: '25.0' },
    });
    expect(pilotRow!.stacks).toEqual(['audit-mesh-pilot']);
    expect(pilotRow!.pilot_last_seen).toBeTypeOf('number');
  });

  it('falls back to an offline shape when the tunnel is down, preserving pilot_last_seen', async () => {
    mockTargetOffline();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await request(app).get('/api/fleet/overview').set('Authorization', authHeader);

    expect(res.status).toBe(200);
    const pilotRow = (res.body as Array<Record<string, unknown>>).find(r => r.id === pilotNodeId);
    expect(pilotRow).toBeDefined();
    expect(pilotRow!.stats).toBeNull();
    expect(pilotRow!.systemStats).toBeNull();
    expect(pilotRow!.stacks).toBeNull();
    expect(pilotRow!.pilot_last_seen).toBeTypeOf('number');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('GET /api/fleet/update-status (pilot-agent)', () => {
  it('reports the pilot version via fetchMetaForNode', async () => {
    vi.spyOn(NodeRegistry.getInstance(), 'fetchMetaForNode').mockImplementation(async (id: number) => {
      if (id === pilotNodeId) {
        return {
          version: '0.76.7',
          capabilities: ['stacks', 'containers'],
          startedAt: 1700000000,
          updateError: null,
          online: true,
        };
      }
      return { version: null, capabilities: [], startedAt: null, updateError: null, online: false };
    });

    const res = await request(app).get('/api/fleet/update-status').set('Authorization', authHeader);

    expect(res.status).toBe(200);
    const nodes = (res.body as { nodes: Array<Record<string, unknown>> }).nodes;
    const pilotRow = nodes.find(n => n.nodeId === pilotNodeId);
    expect(pilotRow).toBeDefined();
    expect(pilotRow!.version).toBe('0.76.7');
  });

  it('reports null version when the pilot meta fetch returns offline', async () => {
    vi.spyOn(NodeRegistry.getInstance(), 'fetchMetaForNode').mockResolvedValue({
      version: null,
      capabilities: [],
      startedAt: null,
      updateError: null,
      online: false,
    });

    const res = await request(app).get('/api/fleet/update-status').set('Authorization', authHeader);

    expect(res.status).toBe(200);
    const nodes = (res.body as { nodes: Array<Record<string, unknown>> }).nodes;
    const pilotRow = nodes.find(n => n.nodeId === pilotNodeId);
    expect(pilotRow!.version).toBeNull();
  });
});

describe('GET /api/fleet/configuration (pilot-agent)', () => {
  it('fetches the dashboard configuration via the loopback target', async () => {
    mockTargetActive();
    mockFetch((url) => {
      expect(url).toBe(`${LOOPBACK}/api/dashboard/configuration`);
      return new Response(
        JSON.stringify({ ssoConfigured: false, alertsConfigured: true }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const res = await request(app).get('/api/fleet/configuration').set('Authorization', authHeader);

    expect(res.status).toBe(200);
    const pilotRow = (res.body as Array<Record<string, unknown>>).find(r => r.id === pilotNodeId);
    expect(pilotRow).toBeDefined();
    expect(pilotRow!.status).toBe('online');
    expect(pilotRow!.configuration).toMatchObject({ alertsConfigured: true });
  });

  it('returns offline configuration=null when the tunnel is down', async () => {
    mockTargetOffline();
    const res = await request(app).get('/api/fleet/configuration').set('Authorization', authHeader);

    expect(res.status).toBe(200);
    const pilotRow = (res.body as Array<Record<string, unknown>>).find(r => r.id === pilotNodeId);
    expect(pilotRow!.status).toBe('offline');
    expect(pilotRow!.configuration).toBeNull();
  });
});
