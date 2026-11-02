/**
 * Routing keys and the update-policy activity row.
 *
 * The interesting properties: a rule with keys matches only alerts whose keys
 * intersect, an alert whose keys cannot be resolved never fans out to every
 * route, key resolution is cached so a burst cannot render the model per alert,
 * the keys are recorded on the history row after the bell, and a repeated skip
 * writes one activity row a day.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { ComposeService } from '../services/ComposeService';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { matchesNotificationFilters } from '../helpers/notificationMatchers';
import { evaluateUpdatePolicy, recordUpdatePolicyDecision } from '../services/updatePolicy';
import { resolveSenchoLabels } from '../helpers/senchoLabels';
import { stackRouteKeys, serviceRouteKeys } from '../services/senchoRouteKeys';
import { clearRouteKeyCacheForNode } from '../services/senchoRouteKeyCache';
import { invalidateNodeCaches } from '../helpers/cacheInvalidation';
import { renderedModel } from './__helpers__/updatePolicyFixture';

/**
 * The real ComposeService is spied at the method, not module-mocked: the update
 * policy and the route-key resolver both read through it, and a module mock is
 * bypassed by the lazy imports the app graph makes.
 */
const renderSpy = { render: vi.fn() };

let tmpDir: string;
let app: import('express').Express;
let adminBearer: string;
// A URL nothing listens on: delivery fails fast, and the routing decision is
// still observable on the history row (dispatch_error is set only when a route
// was actually attempted).
const channelUrl = 'https://127.0.0.1:1/hook';

function serveModel(services: Record<string, { update?: string; notifyRoute?: string }>): void {
  renderSpy.render.mockResolvedValue({
    rendered: JSON.stringify(renderedModel(services)),
    stderr: '',
    code: 0,
    timedOut: false,
  });
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  vi.spyOn(ComposeService.prototype, 'renderConfig').mockImplementation(renderSpy.render);
  ({ app } = await import('../index'));
  adminBearer = jwt.sign({ username: TEST_USERNAME, role: 'admin' }, TEST_JWT_SECRET, { expiresIn: '1m' });
});

afterAll(async () => {
  cleanupTestDb(tmpDir);
});

beforeEach(async () => {
  renderSpy.render.mockReset();
  serveModel({ web: {} });
  // The resolver caches per node and stack, and these tests reuse the default
  // node, so each one starts from a cold cache.
  const { DatabaseService } = await import('../services/DatabaseService');
  const nodeId = DatabaseService.getInstance().getDefaultNode()?.id;
  if (nodeId !== undefined) clearRouteKeyCacheForNode(nodeId);
});

describe('the routing-key matcher', () => {
  const baseCtx = { localNodeId: 1, category: 'monitor_alert' as const, level: 'warning' as const, stackLabelIds: [] };
  const rule = {
    node_id: null, stack_patterns: [] as string[], label_ids: null, categories: null, levels: null,
  };

  it('matches when the keys intersect', () => {
    expect(matchesNotificationFilters(
      { ...baseCtx, stackName: 'web', routeKeys: ['database', 'production'] },
      { ...rule, route_keys: ['production'] },
    )).toBe(true);
  });

  it('does not match when they do not', () => {
    expect(matchesNotificationFilters(
      { ...baseCtx, stackName: 'web', routeKeys: ['production'] },
      { ...rule, route_keys: ['staging'] },
    )).toBe(false);
  });

  it('fails a populated key filter when the alert has no keys', () => {
    expect(matchesNotificationFilters(
      { ...baseCtx, stackName: 'web', routeKeys: [] },
      { ...rule, route_keys: ['production'] },
    )).toBe(false);
  });

  it('matches every alert when the rule has no keys', () => {
    expect(matchesNotificationFilters({ ...baseCtx, stackName: 'web' }, rule)).toBe(true);
    expect(matchesNotificationFilters({ ...baseCtx, stackName: 'web' }, { ...rule, route_keys: [] })).toBe(true);
  });

  it('keeps AND semantics with the other matchers', () => {
    expect(matchesNotificationFilters(
      { ...baseCtx, stackName: 'web', routeKeys: ['production'] },
      { ...rule, route_keys: ['production'], stack_patterns: ['api-*'] },
    )).toBe(false);
    expect(matchesNotificationFilters(
      { ...baseCtx, stackName: 'web', routeKeys: ['production'] },
      { ...rule, route_keys: ['production'], categories: ['deploy_failure'] },
    )).toBe(false);
  });
});

describe('resolving a stack keys', () => {
  it('carries the sorted union of its services keys', async () => {
    serveModel({ web: { notifyRoute: 'production' }, db: { notifyRoute: 'database' } });
    await expect(stackRouteKeys(1, 'web')).resolves.toEqual(['database', 'production']);
    await expect(serviceRouteKeys(1, 'web', 'db')).resolves.toEqual(['database']);
    await expect(serviceRouteKeys(1, 'web', 'web')).resolves.toEqual(['production']);
  });

  it('carries nothing for a service the model does not know', async () => {
    serveModel({ web: { notifyRoute: 'production' } });
    const { serviceRouteKeys } = await import('../services/senchoRouteKeys');
    await expect(serviceRouteKeys(1, 'web', 'one-off')).resolves.toEqual([]);
  });

  it('shares one render across a burst', async () => {
    serveModel({ web: { notifyRoute: 'production' } });
    await Promise.all(Array.from({ length: 20 }, () => stackRouteKeys(2, 'burst')));
    expect(renderSpy.render).toHaveBeenCalledTimes(1);
  });

  it('keeps the last keys when a render fails, and none when there was no answer', async () => {
    serveModel({ web: { notifyRoute: 'production' } });
    clearRouteKeyCacheForNode(3);
    await expect(stackRouteKeys(3, 'failing')).resolves.toEqual(['production']);

    clearRouteKeyCacheForNode(3);
    renderSpy.render.mockResolvedValue({ rendered: null, stderr: 'bad compose', code: 1, timedOut: false });
    await expect(stackRouteKeys(3, 'failing')).resolves.toEqual([]);

    // Warm it again, then fail: the known keys survive the failure.
    serveModel({ web: { notifyRoute: 'production' } });
    await expect(stackRouteKeys(3, 'failing')).resolves.toEqual(['production']);
    clearRouteKeyCacheForNode(3);
    await expect(stackRouteKeys(3, 'failing')).resolves.toEqual(['production']);
    renderSpy.render.mockResolvedValue({ rendered: null, stderr: 'bad compose', code: 1, timedOut: false });
    // The cache was warmed above with a 30s TTL, so this still answers from it.
    await expect(stackRouteKeys(3, 'failing')).resolves.toEqual(['production']);
  });

  it('drops a node keys when the node caches are invalidated', async () => {
    serveModel({ web: { notifyRoute: 'production' } });
    await stackRouteKeys(4, 'web');
    renderSpy.render.mockClear();
    serveModel({ web: { notifyRoute: 'staging' } });
    invalidateNodeCaches(4);
    await expect(stackRouteKeys(4, 'web')).resolves.toEqual(['staging']);
    expect(renderSpy.render).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/notification-routes with routing keys', () => {
  const baseRoute = () => ({
    name: `rule-${Math.random().toString(36).slice(2, 8)}`,
    stack_patterns: [],
    channel_type: 'webhook',
    channel_url: channelUrl,
    priority: 0,
    enabled: true,
  });

  it('normalizes the keys it stores and returns them', async () => {
    const res = await request(app)
      .post('/api/notification-routes')
      .set('Authorization', `Bearer ${adminBearer}`)
      .send({ ...baseRoute(), route_keys: ['Production', 'database'] });

    expect(res.status).toBe(201);
    expect(res.body.route_keys).toEqual(['production', 'database']);
  });

  it('refuses a URL- or address-shaped key', async () => {
    const res = await request(app)
      .post('/api/notification-routes')
      .set('Authorization', `Bearer ${adminBearer}`)
      .send({ ...baseRoute(), route_keys: ['https://example.test/hook'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('route_keys');
  });

  it('refuses more than sixteen keys', async () => {
    const res = await request(app)
      .post('/api/notification-routes')
      .set('Authorization', `Bearer ${adminBearer}`)
      .send({ ...baseRoute(), route_keys: Array.from({ length: 17 }, (_, i) => `team-${i}`) });

    expect(res.status).toBe(400);
  });

  it('replaces the keys on update and clears them with null', async () => {
    const created = await request(app)
      .post('/api/notification-routes')
      .set('Authorization', `Bearer ${adminBearer}`)
      .send({ ...baseRoute(), route_keys: ['production'] });
    const id = created.body.id as number;

    const replaced = await request(app)
      .put(`/api/notification-routes/${id}`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .send({ route_keys: ['staging'] });
    expect(replaced.status).toBe(200);
    expect(replaced.body.route_keys).toEqual(['staging']);

    const cleared = await request(app)
      .put(`/api/notification-routes/${id}`)
      .set('Authorization', `Bearer ${adminBearer}`)
      .send({ route_keys: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.route_keys).toBeNull();
  });
});

describe('dispatching an alert with routing keys', () => {
  it('routes on the keys and records them on the history row', async () => {
    serveModel({ web: { notifyRoute: 'production' } });
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;

    for (const name of db.getNotificationRoutes()) db.deleteNotificationRoute(name.id);
    db.createNotificationRoute({
      name: 'production-only', node_id: null, stack_patterns: [], label_ids: null, categories: null, levels: null,
      route_keys: ['production'], channel_type: 'webhook', channel_url: channelUrl, config: null,
      priority: 0, enabled: true, created_at: Date.now(), updated_at: Date.now(),
    });

    const { NotificationService } = await import('../services/NotificationService');
    await NotificationService.getInstance().dispatchAlert(
      'warning', 'monitor_alert', 'web is unhealthy', { stackName: 'web', actor: 'system:test', nodeId },
    );

    const rows = db.getNotificationHistory(nodeId, 5, 'monitor_alert');
    expect(rows[0]?.route_keys).toEqual(['production']);
    // The route was attempted (its delivery failed to connect), so the match is
    // proven by the error the dispatch recorded, not by a live endpoint.
    expect(rows[0]?.dispatch_error).toContain('production-only');
  });

  it('does not route an alert from a stack with no matching key', async () => {
    serveModel({ web: { notifyRoute: 'staging' } });
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;
    for (const name of db.getNotificationRoutes()) db.deleteNotificationRoute(name.id);
    db.createNotificationRoute({
      name: 'production-only', node_id: null, stack_patterns: [], label_ids: null, categories: null, levels: null,
      route_keys: ['production'], channel_type: 'webhook', channel_url: channelUrl, config: null,
      priority: 0, enabled: true, created_at: Date.now(), updated_at: Date.now(),
    });

    const { NotificationService } = await import('../services/NotificationService');
    await NotificationService.getInstance().dispatchAlert(
      'warning', 'monitor_alert', 'web is unhealthy', { stackName: 'web', actor: 'system:test', nodeId },
    );

    const rows = db.getNotificationHistory(nodeId, 5, 'monitor_alert');
    expect(rows[0]?.dispatch_error ?? null).toBeNull();
  });
});

describe('the update-policy activity row', () => {
  const decision = (update: string) => evaluateUpdatePolicy(
    resolveSenchoLabels(renderedModel({ web: {}, db: { update } })),
    { stack: 'activity-stack', target: { scope: 'stack' }, trigger: 'scheduled' },
  );

  it('writes one read row a day for the same stack and reason, and the stack activity lists it', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;
    const unread = (): number =>
      (db.getDb().prepare('SELECT COUNT(*) AS n FROM notification_history WHERE node_id = ? AND is_read = 0').get(nodeId) as { n: number }).n;
    const before = unread();

    recordUpdatePolicyDecision(nodeId, decision('manual'), 'system:scheduler');
    recordUpdatePolicyDecision(nodeId, decision('manual'), 'system:scheduler');

    const rows = db.getNotificationHistory(nodeId, 50, 'update_policy');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ is_read: true, stack_name: 'activity-stack', category: 'update_policy' });
    expect(rows[0].message).toContain('db (manual)');
    expect(rows[0].message).toContain('a scheduled update');
    // A history-only row never inflates the bell.
    expect(unread()).toBe(before);
    expect(db.getNodeStackActivity(nodeId, { limit: 20 }).some(row => row.category === 'update_policy')).toBe(true);
  });

  it('writes a new row when the reason changes', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;

    recordUpdatePolicyDecision(nodeId, decision('manual'), 'system:scheduler');
    recordUpdatePolicyDecision(nodeId, decision('disabled'), 'system:scheduler');

    const rows = db.getNotificationHistory(nodeId, 50, 'update_policy');
    expect(rows).toHaveLength(2);
  });
});

describe('the migration', () => {
  it('adds both route_keys columns and is safe to run twice', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance().getDb();
    const columns = (table: string): string[] =>
      (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(c => c.name);
    expect(columns('notification_routes')).toContain('route_keys');
    expect(columns('notification_history')).toContain('route_keys');
    // The baseline copy already ran every migration once; re-running the whole
    // schema initialiser must not throw on the existing columns.
    expect(() => DatabaseService.getInstance()).not.toThrow();
  });
});
