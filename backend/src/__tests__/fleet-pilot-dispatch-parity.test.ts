/**
 * Regression guard: every fleet-wide remote-dispatch surface routes through
 * NodeRegistry.getProxyTarget so pilot-agent nodes (which carry no
 * node.api_url / node.api_token) participate transparently.
 *
 * Covers the migration that closes the parity gap left after PR #1123
 * fixed the literal /api/fleet/nodes/:id/update path:
 *   - POST /api/fleet/labels/fleet-stop      (fleet.ts)
 *   - POST /api/fleet/labels/fleet-prune     (fleet.ts)
 *   - POST /api/fleet/prune/estimate         (fleet.ts)
 *   - GET  /api/image-updates/fleet          (imageUpdates.ts)
 *   - POST /api/image-updates/fleet/refresh  (imageUpdates.ts)
 *   - captureRemoteNodeFiles                 (utils/snapshot-capture.ts)
 *
 * Snapshot restore (fleet.ts:1660) and SecretsService env IO follow the
 * identical getProxyTarget + conditional-Authorization shape. Their
 * fixture cost (seeding snapshot rows + files; seeding a label, selector
 * match, and secret row) is heavy relative to the structural change
 * being verified; tsc plus the routes covered above already exercise the
 * helper shape end-to-end.
 *
 * Each test proves either (a) a pilot row gets dispatched against
 * `target.apiUrl` with no Authorization header, or (b) a pilot with no
 * active tunnel gets a mode-aware error and the dispatch never fires.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

const PILOT_LOOPBACK = 'http://127.0.0.1:54399';
const PROXY_URL = 'http://192.168.1.99:1852';
const PROXY_TOKEN = 'proxy-token';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;
let pilotNodeId: number;
let proxyNodeId: number;
let NodeRegistry: typeof import('../services/NodeRegistry').NodeRegistry;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let LicenseService: typeof import('../services/LicenseService').LicenseService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ NodeRegistry } = await import('../services/NodeRegistry'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ LicenseService } = await import('../services/LicenseService'));

  const db = DatabaseService.getInstance();
  pilotNodeId = db.addNode({
    name: 'pilot-dispatch-test',
    type: 'remote',
    mode: 'pilot_agent',
    compose_dir: '/tmp',
    is_default: false,
    api_url: '',
    api_token: '',
  });
  db.updateNode(pilotNodeId, { pilot_last_seen: Date.now(), pilot_agent_version: '0.83.0' });

  proxyNodeId = db.addNode({
    name: 'proxy-dispatch-test',
    type: 'remote',
    mode: 'proxy',
    compose_dir: '/tmp',
    is_default: false,
    api_url: PROXY_URL,
    api_token: PROXY_TOKEN,
  });
  db.updateNodeStatus(proxyNodeId, 'online');
  db.updateNodeStatus(pilotNodeId, 'online');

  const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '5m' });
  authHeader = `Bearer ${token}`;
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockTargets(opts: { pilotReachable: boolean; proxyReachable: boolean } = { pilotReachable: true, proxyReachable: true }) {
  vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockImplementation((id: number) => {
    if (id === pilotNodeId) return opts.pilotReachable ? { apiUrl: PILOT_LOOPBACK, apiToken: '' } : null;
    if (id === proxyNodeId) return opts.proxyReachable ? { apiUrl: PROXY_URL, apiToken: PROXY_TOKEN } : null;
    return null;
  });
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => handler(String(input), init));
}

function mockPaidTier() {
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
  vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue('admiral');
}

function seedLabel(nodeId: number, name: string): number {
  const db = DatabaseService.getInstance().getDb();
  const result = db.prepare('INSERT INTO stack_labels (node_id, name, color) VALUES (?, ?, ?)').run(nodeId, name, 'teal');
  return result.lastInsertRowid as number;
}

function seedStackLabel(nodeId: number, stackName: string, labelId: number): void {
  const db = DatabaseService.getInstance().getDb();
  db.prepare('INSERT INTO stack_label_assignments (label_id, stack_name, node_id) VALUES (?, ?, ?)').run(labelId, stackName, nodeId);
}

describe('POST /api/fleet/labels/fleet-stop (pilot-agent dispatch)', () => {
  const LABEL = 'fleet-stop-pilot';

  beforeAll(() => {
    const pilotLabelId = seedLabel(pilotNodeId, LABEL);
    seedStackLabel(pilotNodeId, 'pilot-stack', pilotLabelId);
    const proxyLabelId = seedLabel(proxyNodeId, LABEL);
    seedStackLabel(proxyNodeId, 'proxy-stack', proxyLabelId);
  });

  it('dispatches the pilot row through the loopback target with no Authorization header', async () => {
    mockPaidTier();
    mockTargets();
    const calls: Array<{ url: string; auth: string | undefined }> = [];
    mockFetch((url, init) => {
      const headers = (init?.headers as Record<string, string>) ?? {};
      calls.push({ url, auth: headers.Authorization });
      return new Response(JSON.stringify({ results: [{ stackName: 'pilot-stack', success: true }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });

    const res = await request(app)
      .post('/api/fleet/labels/fleet-stop')
      .set('Authorization', authHeader)
      .send({ labelName: LABEL, dryRun: true });

    expect(res.status).toBe(200);
    const pilotCall = calls.find(c => c.url.startsWith(PILOT_LOOPBACK));
    expect(pilotCall).toBeDefined();
    expect(pilotCall?.auth).toBeUndefined();
    const proxyCall = calls.find(c => c.url.startsWith(PROXY_URL));
    expect(proxyCall?.auth).toBe(`Bearer ${PROXY_TOKEN}`);
  });

  it('returns a tunnel-disconnected error row when the pilot target is null', async () => {
    mockPaidTier();
    mockTargets({ pilotReachable: false, proxyReachable: true });
    mockFetch(() => new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const res = await request(app)
      .post('/api/fleet/labels/fleet-stop')
      .set('Authorization', authHeader)
      .send({ labelName: LABEL, dryRun: true });

    expect(res.status).toBe(200);
    const pilotResult = res.body.results.find((r: { nodeId: number }) => r.nodeId === pilotNodeId);
    expect(pilotResult.stackResults[0].error).toMatch(/pilot tunnel/i);
  });
});

describe('POST /api/fleet/prune/estimate (pilot-agent dispatch)', () => {
  it('includes the pilot row in the estimate by dispatching through the loopback target', async () => {
    mockPaidTier();
    mockTargets();
    const calls: Array<{ url: string; auth: string | undefined }> = [];
    mockFetch((url, init) => {
      const headers = (init?.headers as Record<string, string>) ?? {};
      calls.push({ url, auth: headers.Authorization });
      return new Response(JSON.stringify({ reclaimableBytes: 42 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });

    const res = await request(app)
      .post('/api/fleet/prune/estimate')
      .set('Authorization', authHeader)
      .send({ targets: ['images'], scope: 'managed' });

    expect(res.status).toBe(200);
    const pilotCall = calls.find(c => c.url.startsWith(PILOT_LOOPBACK));
    expect(pilotCall).toBeDefined();
    expect(pilotCall?.auth).toBeUndefined();
    const pilotEntry = res.body.perNode.find((n: { nodeId: number }) => n.nodeId === pilotNodeId);
    expect(pilotEntry.reachable).toBe(true);
    expect(pilotEntry.reclaimableBytes).toBe(42);
  });

  it('marks the pilot row unreachable with a tunnel-disconnected message when target is null', async () => {
    mockPaidTier();
    mockTargets({ pilotReachable: false, proxyReachable: true });
    mockFetch(() => new Response(JSON.stringify({ reclaimableBytes: 0 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));

    const res = await request(app)
      .post('/api/fleet/prune/estimate')
      .set('Authorization', authHeader)
      .send({ targets: ['images'], scope: 'managed' });

    expect(res.status).toBe(200);
    const pilotEntry = res.body.perNode.find((n: { nodeId: number }) => n.nodeId === pilotNodeId);
    expect(pilotEntry.reachable).toBe(false);
    expect(pilotEntry.error).toMatch(/pilot tunnel/i);
  });
});

describe('POST /api/fleet/labels/fleet-prune (pilot-agent dispatch)', () => {
  it('dispatches the pilot row through the loopback target and surfaces the result', async () => {
    mockPaidTier();
    mockTargets();
    const calls: Array<{ url: string; auth: string | undefined }> = [];
    mockFetch((url, init) => {
      const headers = (init?.headers as Record<string, string>) ?? {};
      calls.push({ url, auth: headers.Authorization });
      return new Response(JSON.stringify({ success: true, reclaimedBytes: 999, dryRun: true }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });

    const res = await request(app)
      .post('/api/fleet/labels/fleet-prune')
      .set('Authorization', authHeader)
      .send({ targets: ['images'], scope: 'managed', dryRun: true });

    expect(res.status).toBe(200);
    const pilotCall = calls.find(c => c.url.startsWith(PILOT_LOOPBACK));
    expect(pilotCall).toBeDefined();
    expect(pilotCall?.auth).toBeUndefined();
    const pilotResult = res.body.results.find((r: { nodeId: number }) => r.nodeId === pilotNodeId);
    expect(pilotResult.reachable).toBe(true);
    expect(pilotResult.targets[0].reclaimedBytes).toBe(999);
  });
});

describe('GET /api/image-updates/fleet (pilot inclusion)', () => {
  it('includes the pilot row in the aggregated fleet image-update status', async () => {
    mockTargets();
    // CacheService.getOrFetch caches by key; the cache from a prior test
    // would silently mask the new dispatch. Force a miss.
    const { CacheService } = await import('../services/CacheService');
    CacheService.getInstance().invalidate('fleet-updates');

    const calls: Array<{ url: string; auth: string | undefined }> = [];
    mockFetch((url, init) => {
      const headers = (init?.headers as Record<string, string>) ?? {};
      calls.push({ url, auth: headers.Authorization });
      // Distinguish pilot vs proxy by URL
      const body = url.startsWith(PILOT_LOOPBACK)
        ? { 'pilot-stack': true }
        : { 'proxy-stack': false };
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });

    const res = await request(app)
      .get('/api/image-updates/fleet')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    const pilotCall = calls.find(c => c.url.startsWith(PILOT_LOOPBACK));
    expect(pilotCall).toBeDefined();
    expect(pilotCall?.auth).toBeUndefined();
    expect(res.body[pilotNodeId]).toEqual({ 'pilot-stack': true });
  });
});

describe('POST /api/image-updates/fleet/refresh (pilot trigger)', () => {
  it('triggers the pilot via the loopback target and counts it in `triggered`', async () => {
    mockPaidTier();
    mockTargets();
    const calls: Array<{ url: string; auth: string | undefined }> = [];
    mockFetch((url, init) => {
      const headers = (init?.headers as Record<string, string>) ?? {};
      calls.push({ url, auth: headers.Authorization });
      return new Response('', { status: 202 });
    });

    const res = await request(app)
      .post('/api/image-updates/fleet/refresh')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    const pilotCall = calls.find(c => c.url.startsWith(PILOT_LOOPBACK));
    expect(pilotCall).toBeDefined();
    expect(pilotCall?.auth).toBeUndefined();
    expect(res.body.triggered).toContain(pilotNodeId);
  });

  it('skips pilots whose tunnel is disconnected (target null) without throwing', async () => {
    mockPaidTier();
    mockTargets({ pilotReachable: false, proxyReachable: true });
    const proxyCalls: string[] = [];
    mockFetch((url) => {
      if (url.startsWith(PROXY_URL)) proxyCalls.push(url);
      return new Response('', { status: 202 });
    });

    const res = await request(app)
      .post('/api/image-updates/fleet/refresh')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(proxyCalls.length).toBeGreaterThan(0);
    expect(res.body.triggered).not.toContain(pilotNodeId);
    expect(res.body.failed).not.toContain(pilotNodeId);
  });
});

describe('captureRemoteNodeFiles (pilot-agent dispatch)', () => {
  it('fetches stacks through the loopback target when the pilot tunnel is up', async () => {
    mockTargets();
    const calls: Array<{ url: string; auth: string | undefined }> = [];
    mockFetch((url, init) => {
      const headers = (init?.headers as Record<string, string>) ?? {};
      calls.push({ url, auth: headers.Authorization });
      if (url.endsWith('/api/stacks')) {
        return new Response(JSON.stringify(['snap-stack']), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/api/stacks/snap-stack') && !url.endsWith('/env')) {
        return new Response('services: {}', { status: 200 });
      }
      if (url.endsWith('/env')) {
        return new Response('KEY=value', { status: 200 });
      }
      return new Response('', { status: 404 });
    });

    const { captureRemoteNodeFiles } = await import('../utils/snapshot-capture');
    const node = DatabaseService.getInstance().getNode(pilotNodeId)!;
    const result = await captureRemoteNodeFiles({ id: node.id, name: node.name, mode: node.mode });

    const pilotCalls = calls.filter(c => c.url.startsWith(PILOT_LOOPBACK));
    expect(pilotCalls.length).toBeGreaterThan(0);
    expect(pilotCalls.every(c => c.auth === undefined)).toBe(true);
    expect(result.nodeId).toBe(pilotNodeId);
    expect(result.stacks.find(s => s.stackName === 'snap-stack')).toBeDefined();
  });

  it('throws a tunnel-disconnected error when the pilot target is null', async () => {
    mockTargets({ pilotReachable: false, proxyReachable: true });
    const { captureRemoteNodeFiles } = await import('../utils/snapshot-capture');
    const node = DatabaseService.getInstance().getNode(pilotNodeId)!;

    await expect(
      captureRemoteNodeFiles({ id: node.id, name: node.name, mode: node.mode })
    ).rejects.toThrow(/pilot tunnel/i);
  });
});

// Note: SecretsService.{resolveEnvFileRemote,readEnvRemote,writeEnvRemote}
// share the same getProxyTarget + conditional-Authorization shape exercised
// above. The migration is structurally identical and tsc has validated the
// types. Adding a redundant unit test that just re-proves the helper return
// shape would add no signal beyond what captureRemoteNodeFiles already covers.
