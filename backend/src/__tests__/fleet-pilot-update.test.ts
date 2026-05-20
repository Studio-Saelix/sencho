/**
 * Regression guard: POST /api/fleet/nodes/:id/update and POST /api/fleet/update-all
 * route through NodeRegistry.getProxyTarget so pilot-agent nodes (which carry no
 * node.api_url / node.api_token) can receive remote update commands.
 *
 * Pre-fix:
 *   - Single update on a pilot returned 503 "Remote node not configured."
 *   - Update-all filtered every pilot row out before dispatch.
 *
 * Post-fix: each route dispatches against target.apiUrl (the loopback URL for
 * pilots, the configured api_url for proxy-mode remotes), and emits a
 * mode-aware 503 when the target is unavailable.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import type { RemoteMeta } from '../services/CapabilityRegistry';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

const LOOPBACK = 'http://127.0.0.1:54322';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;
let pilotNodeId: number;
let proxyNodeId: number;
let NodeRegistry: typeof import('../services/NodeRegistry').NodeRegistry;
let FleetUpdateTrackerService: typeof import('../services/FleetUpdateTrackerService').FleetUpdateTrackerService;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let LicenseService: typeof import('../services/LicenseService').LicenseService;

const META_ONLINE_OUTDATED: RemoteMeta = {
  version: '0.83.0',
  capabilities: ['stacks', 'self-update'],
  startedAt: 1,
  updateError: null,
  online: true,
};

const META_OFFLINE: RemoteMeta = {
  version: null,
  capabilities: [],
  startedAt: null,
  updateError: null,
  online: false,
};

const META_NO_SELF_UPDATE: RemoteMeta = {
  ...META_ONLINE_OUTDATED,
  capabilities: ['stacks'],
};

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ NodeRegistry } = await import('../services/NodeRegistry'));
  ({ FleetUpdateTrackerService } = await import('../services/FleetUpdateTrackerService'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ LicenseService } = await import('../services/LicenseService'));

  const db = DatabaseService.getInstance();
  pilotNodeId = db.addNode({
    name: 'pilot-update-test',
    type: 'remote',
    mode: 'pilot_agent',
    compose_dir: '/tmp',
    is_default: false,
    api_url: '',
    api_token: '',
  });
  db.updateNode(pilotNodeId, {
    pilot_last_seen: Date.now(),
    pilot_agent_version: '0.83.0',
  });

  proxyNodeId = db.addNode({
    name: 'proxy-update-test',
    type: 'remote',
    mode: 'proxy',
    compose_dir: '/tmp',
    is_default: false,
    api_url: 'http://192.168.1.99:1852',
    api_token: 'proxy-token',
  });

  const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });
  authHeader = `Bearer ${token}`;
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  const tracker = FleetUpdateTrackerService.getInstance();
  for (const [id] of tracker.entries()) tracker.delete(id);
});

function mockTargetForPilot() {
  vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockImplementation((id: number) => {
    if (id === pilotNodeId) return { apiUrl: LOOPBACK, apiToken: '' };
    if (id === proxyNodeId) return { apiUrl: 'http://192.168.1.99:1852', apiToken: 'proxy-token' };
    return null;
  });
}

function mockTargetUnreachable() {
  vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue(null);
}

function mockMeta(meta: RemoteMeta) {
  vi.spyOn(NodeRegistry.getInstance(), 'fetchMetaForNode').mockResolvedValue(meta);
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => handler(String(input), init));
}

describe('POST /api/fleet/nodes/:nodeId/update (pilot-agent)', () => {
  it('dispatches /api/system/update via the loopback target and returns 202', async () => {
    mockTargetForPilot();
    mockMeta(META_ONLINE_OUTDATED);
    let postedUrl: string | undefined;
    let postedHeaders: Record<string, string> | undefined;
    mockFetch((url, init) => {
      postedUrl = url;
      postedHeaders = (init?.headers as Record<string, string>) ?? undefined;
      return new Response('', { status: 202 });
    });

    const res = await request(app)
      .post(`/api/fleet/nodes/${pilotNodeId}/update`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(202);
    expect(postedUrl).toBe(`${LOOPBACK}/api/system/update`);
    expect(postedHeaders).not.toHaveProperty('Authorization');

    const tracker = FleetUpdateTrackerService.getInstance().get(pilotNodeId);
    expect(tracker?.status).toBe('updating');
  });

  it('returns 503 with a pilot-tunnel-disconnected message when target is null', async () => {
    mockTargetUnreachable();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await request(app)
      .post(`/api/fleet/nodes/${pilotNodeId}/update`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(503);
    expect(res.body?.error).toMatch(/pilot tunnel/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 503 with the self-update-unsupported message when capability missing', async () => {
    mockTargetForPilot();
    mockMeta(META_NO_SELF_UPDATE);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await request(app)
      .post(`/api/fleet/nodes/${pilotNodeId}/update`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(503);
    expect(res.body?.error).toMatch(/does not support self-update/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 503 with unreachable message when meta.online is false', async () => {
    mockTargetForPilot();
    mockMeta(META_OFFLINE);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await request(app)
      .post(`/api/fleet/nodes/${pilotNodeId}/update`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(503);
    expect(res.body?.error).toMatch(/unreachable/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('POST /api/fleet/update-all (pilot-agent mixed fleet)', () => {
  // /update-all is requirePaid; spy the license tier so the test DB does not
  // need a real activation row.
  function mockPaidTier() {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
    vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue('admiral');
  }

  it('includes the pilot node in the candidate set and dispatches through its target', async () => {
    mockPaidTier();
    mockTargetForPilot();
    mockMeta(META_ONLINE_OUTDATED);
    const postedUrls: string[] = [];
    mockFetch((url) => {
      postedUrls.push(url);
      return new Response('', { status: 202 });
    });

    const res = await request(app)
      .post('/api/fleet/update-all')
      .set('Authorization', authHeader);

    expect(res.status).toBe(202);
    expect(res.body.updating).toContain('pilot-update-test');
    expect(res.body.updating).toContain('proxy-update-test');
    expect(postedUrls).toContain(`${LOOPBACK}/api/system/update`);
    expect(postedUrls).toContain('http://192.168.1.99:1852/api/system/update');
  });

  it('skips remotes whose target resolves to null and never calls /api/system/update on them', async () => {
    mockPaidTier();
    mockTargetUnreachable();
    // /update-all also calls api.github.com to compute the compare target;
    // pin the assertion to the route's own dispatch surface.
    const systemUpdateCalls: string[] = [];
    mockFetch((url) => {
      if (url.endsWith('/api/system/update')) systemUpdateCalls.push(url);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const res = await request(app)
      .post('/api/fleet/update-all')
      .set('Authorization', authHeader);

    expect(res.status).toBe(202);
    expect(res.body.updating).toEqual([]);
    expect(res.body.skipped).toEqual(expect.arrayContaining(['pilot-update-test', 'proxy-update-test']));
    expect(systemUpdateCalls).toEqual([]);
  });
});
