/**
 * Hardening coverage for the fleet node self-update flow:
 *   - GET /api/fleet/update-status terminal resolution: hard timeout, early-fail,
 *     the version-change and process-restart completion signals, and the tightened
 *     offline-then-online rule (a bounce on the same version with an unchanged,
 *     known process start time must NOT be reported as completed).
 *   - The failure-class terminal transitions emit an operator-visible WARN.
 *   - POST /api/fleet/nodes/:id/update concurrency guard (409).
 *   - Authorization: both DELETE clear routes require admin.
 *   - The forced-recheck throttle on DELETE /update-status?recheck=true.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import type { RemoteMeta } from '../services/CapabilityRegistry';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { CacheService } from '../services/CacheService';

let tmpDir: string;
let app: import('express').Express;
let adminAuth: string;
let viewerAuth: string;
let proxyNodeId: number;
let NodeRegistry: typeof import('../services/NodeRegistry').NodeRegistry;
let FleetUpdateTrackerService: typeof import('../services/FleetUpdateTrackerService').FleetUpdateTrackerService;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let SelfUpdateService: typeof import('../services/SelfUpdateService').default;
let UPDATE_TIMEOUT_MS: number;
let localNodeId: number;

// Recent enough to clear neither the early-fail (3 min) nor the timeout (5 min).
const RECENT_MS = 30_000;
// Past the early-fail heuristic but inside the hard timeout window.
const EARLY_FAIL_ELAPSED_MS = 240_000;

const ONLINE = (over: Partial<RemoteMeta> = {}): RemoteMeta => ({
  version: '0.83.0',
  capabilities: ['stacks', 'self-update'],
  startedAt: 1,
  updateError: null,
  online: true,
  ...over,
});

function mockMeta(meta: RemoteMeta) {
  vi.spyOn(NodeRegistry.getInstance(), 'fetchMetaForNode').mockResolvedValue(meta);
}

function mockTarget() {
  vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockImplementation((id: number) =>
    id === proxyNodeId ? { apiUrl: 'http://192.168.1.99:1852', apiToken: 'proxy-token' } : null,
  );
}

// getCompareTarget hits GitHub; pin it to a version above the node's so the
// node reads as outdated and never trips signal 4 unintentionally.
function mockCompareTargetFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify({ tag_name: 'v0.99.0' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function setTracker(over: Partial<import('../services/FleetUpdateTrackerService').UpdateTracker>, nodeId = proxyNodeId) {
  FleetUpdateTrackerService.getInstance().set(nodeId, {
    status: 'updating',
    startedAt: Date.now() - RECENT_MS,
    previousVersion: '0.83.0',
    previousProcessStart: 1,
    wasOffline: false,
    ...over,
  });
}

async function getStatus(nodeId = proxyNodeId): Promise<number | null | undefined> {
  const res = await request(app).get('/api/fleet/update-status').set('Authorization', adminAuth);
  expect(res.status).toBe(200);
  return res.body.nodes.find((n: { nodeId: number }) => n.nodeId === nodeId)?.updateStatus;
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ NodeRegistry } = await import('../services/NodeRegistry'));
  const trackerMod = await import('../services/FleetUpdateTrackerService');
  FleetUpdateTrackerService = trackerMod.FleetUpdateTrackerService;
  UPDATE_TIMEOUT_MS = trackerMod.UPDATE_TIMEOUT_MS;
  ({ DatabaseService } = await import('../services/DatabaseService'));
  SelfUpdateService = (await import('../services/SelfUpdateService')).default;

  const db = DatabaseService.getInstance();
  localNodeId = db.getNodes().find(n => n.type === 'local')!.id;
  proxyNodeId = db.addNode({
    name: 'proxy-hardening-test',
    type: 'remote',
    mode: 'proxy',
    compose_dir: '/tmp',
    is_default: false,
    api_url: 'http://192.168.1.99:1852',
    api_token: 'proxy-token',
  });
  db.addUser({ username: 'viewer-hardening-test', password_hash: 'unused', role: 'viewer' });

  adminAuth = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' })}`;
  viewerAuth = `Bearer ${jwt.sign({ username: 'viewer-hardening-test' }, TEST_JWT_SECRET, { expiresIn: '1m' })}`;
});

afterAll(() => cleanupTestDb(tmpDir));

afterEach(() => {
  vi.restoreAllMocks();
  const tracker = FleetUpdateTrackerService.getInstance();
  for (const [id] of tracker.entries()) tracker.delete(id);
});

describe('GET /api/fleet/update-status terminal resolution', () => {
  it('times out an in-flight tracker past the hard ceiling and warns', async () => {
    mockTarget();
    mockCompareTargetFetch();
    mockMeta(ONLINE());
    const warnSpy = vi.spyOn(console, 'warn');
    setTracker({ startedAt: Date.now() - (UPDATE_TIMEOUT_MS + 1_000) });

    expect(await getStatus()).toBe('timeout');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Node update timeout'));
  });

  it('fails via the early-fail heuristic when the node stays online and unchanged, and warns', async () => {
    mockTarget();
    mockCompareTargetFetch();
    mockMeta(ONLINE()); // version unchanged, startedAt unchanged
    const warnSpy = vi.spyOn(console, 'warn');
    setTracker({ startedAt: Date.now() - EARLY_FAIL_ELAPSED_MS });

    expect(await getStatus()).toBe('failed');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Node update failed'));
  });

  it('completes via signal 1 when the remote version changed, without warning', async () => {
    mockTarget();
    mockCompareTargetFetch();
    mockMeta(ONLINE({ version: '0.99.0', startedAt: 1 }));
    const warnSpy = vi.spyOn(console, 'warn');
    setTracker({ previousVersion: '0.83.0' });

    expect(await getStatus()).toBe('completed');
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Node update'));
  });

  it('completes via signal 2 when the remote process restarted (startedAt changed)', async () => {
    mockTarget();
    mockCompareTargetFetch();
    mockMeta(ONLINE({ version: '0.83.0', startedAt: 2 })); // same version, new process start
    setTracker({ previousProcessStart: 1 });

    expect(await getStatus()).toBe('completed');
  });

  it('does NOT complete a same-version bounce when the process start time is unchanged', async () => {
    mockTarget();
    mockCompareTargetFetch();
    // Bounced offline then back, but same version AND same (known) process start:
    // the process never actually restarted, so this is a blip, not a completed update.
    mockMeta(ONLINE({ version: '0.83.0', startedAt: 1 }));
    setTracker({ wasOffline: true, previousProcessStart: 1 });

    expect(await getStatus()).toBe('updating');
  });

  it('completes an offline->online bounce when the process start time is unavailable', async () => {
    mockTarget();
    mockCompareTargetFetch();
    // No startedAt reported by the remote: offline->online is the only restart
    // evidence available, so signal 3 remains a valid completion fallback.
    mockMeta(ONLINE({ version: '0.83.0', startedAt: null }));
    setTracker({ wasOffline: true, previousProcessStart: null });

    expect(await getStatus()).toBe('completed');
  });

  it('fails a local-node update via the early-fail heuristic and warns', async () => {
    // The local node reads its own version, never fetchMetaForNode; with no
    // recorded self-update error it resolves through the early-fail heuristic.
    mockCompareTargetFetch();
    vi.spyOn(SelfUpdateService.getInstance(), 'getLastError').mockReturnValue(null);
    const warnSpy = vi.spyOn(console, 'warn');
    setTracker({ startedAt: Date.now() - EARLY_FAIL_ELAPSED_MS }, localNodeId);

    expect(await getStatus(localNodeId)).toBe('failed');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Node update failed'));
  });
});

describe('POST /api/fleet/nodes/:id/update concurrency', () => {
  it('returns 409 when an update is already in progress for the node', async () => {
    setTracker({ startedAt: Date.now() - RECENT_MS });

    const res = await request(app)
      .post(`/api/fleet/nodes/${proxyNodeId}/update`)
      .set('Authorization', adminAuth);

    expect(res.status).toBe(409);
    expect(res.body?.error).toMatch(/already in progress/i);
  });
});

describe('clear-route authorization', () => {
  it('rejects DELETE /nodes/:id/update-status for a non-admin', async () => {
    const res = await request(app)
      .delete(`/api/fleet/nodes/${proxyNodeId}/update-status`)
      .set('Authorization', viewerAuth);
    expect(res.status).toBe(403);
  });

  it('rejects DELETE /update-status for a non-admin', async () => {
    const res = await request(app)
      .delete('/api/fleet/update-status?recheck=true')
      .set('Authorization', viewerAuth);
    expect(res.status).toBe(403);
  });

  it('allows DELETE /nodes/:id/update-status for an admin and clears the tracker', async () => {
    setTracker({ status: 'failed', error: 'boom', startedAt: Date.now() - RECENT_MS });
    const res = await request(app)
      .delete(`/api/fleet/nodes/${proxyNodeId}/update-status`)
      .set('Authorization', adminAuth);
    expect(res.status).toBe(204);
    expect(FleetUpdateTrackerService.getInstance().get(proxyNodeId)).toBeUndefined();
  });
});

describe('forced-recheck throttle', () => {
  it('forces the latest-version refresh once, then throttles within the cooldown', async () => {
    // Reset the module-scope throttle clock so this assertion does not depend on
    // whether an earlier test happened to force a recheck first.
    const { _resetForcedRecheckThrottleForTests } = await import('../routes/fleet');
    _resetForcedRecheckThrottleForTests();
    mockCompareTargetFetch();
    const invalidateSpy = vi.spyOn(CacheService.getInstance(), 'invalidate');

    const first = await request(app)
      .delete('/api/fleet/update-status?recheck=true')
      .set('Authorization', adminAuth);
    expect(first.status).toBe(200);
    expect(first.body.rechecked).toBe(true);
    expect(invalidateSpy).toHaveBeenCalledWith('latest-version');

    invalidateSpy.mockClear();

    const second = await request(app)
      .delete('/api/fleet/update-status?recheck=true')
      .set('Authorization', adminAuth);
    expect(second.status).toBe(200);
    expect(second.body.rechecked).toBe(false);
    expect(invalidateSpy).not.toHaveBeenCalledWith('latest-version');
  });
});
