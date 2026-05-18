/**
 * Regression guard for `hubOnlyGuard` middleware.
 *
 * Hub-only paths (e.g. /api/scheduled-tasks, /api/audit-log,
 * /api/notification-routes) manage state owned by the local hub. When a
 * request carries `x-node-id` for a remote node, the guard must reject
 * with 409 before the remote proxy forwards it. Without this guard, a
 * scripted client could trick the proxy into running hub-level operations
 * on a remote instance, crossing a node-authority boundary that the UI
 * promises will not happen.
 *
 * The guard sits between `enforceApiTokenScope` (step 13) and
 * `createRemoteProxyMiddleware` (step 15).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

describe('hubOnlyGuard', () => {
  let tmpDir: string;
  let app: import('express').Express;
  let authHeader: string;
  let remoteNodeId: number;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ app } = await import('../index'));

    const { DatabaseService } = await import('../services/DatabaseService');
    remoteNodeId = DatabaseService.getInstance().addNode({
      name: 'hub-only-remote',
      type: 'remote',
      compose_dir: '/tmp',
      is_default: false,
      api_url: 'http://127.0.0.1:1',
      api_token: 'hub-only-token',
    });

    const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });
    authHeader = `Bearer ${token}`;
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  it('rejects /api/scheduled-tasks with 403 when nodeId targets a remote node', async () => {
    const res = await request(app)
      .get('/api/scheduled-tasks/')
      .set('Authorization', authHeader)
      .set('x-node-id', String(remoteNodeId));

    expect(res.status).toBe(403);
    expect(res.body?.code).toBe('HUB_ONLY_ENDPOINT');
    expect(res.body?.error).toMatch(/hub-only/i);
  });

  it('rejects /api/audit-log with 403 when nodeId targets a remote node', async () => {
    const res = await request(app)
      .get('/api/audit-log/')
      .set('Authorization', authHeader)
      .set('x-node-id', String(remoteNodeId));

    expect(res.status).toBe(403);
    expect(res.body?.code).toBe('HUB_ONLY_ENDPOINT');
  });

  it('rejects /api/notification-routes with 403 when nodeId targets a remote node', async () => {
    const res = await request(app)
      .get('/api/notification-routes/')
      .set('Authorization', authHeader)
      .set('x-node-id', String(remoteNodeId));

    expect(res.status).toBe(403);
    expect(res.body?.code).toBe('HUB_ONLY_ENDPOINT');
  });

  it('lets /api/scheduled-tasks through to the local handler when no nodeId is set', async () => {
    const res = await request(app)
      .get('/api/scheduled-tasks/')
      .set('Authorization', authHeader);

    // Anything other than 403 with HUB_ONLY_ENDPOINT proves the guard fell
    // through. Local handler may return 200 or a tier-gate 403; both are
    // acceptable here, so assert on the body code rather than the status.
    expect(res.body?.code).not.toBe('HUB_ONLY_ENDPOINT');
  });

  it('does not interfere with non-hub paths even when nodeId targets a remote node', async () => {
    // /api/stacks is not hub-only and should be forwarded by the proxy.
    // The exact upstream-error status is not the contract here; what
    // matters is that the guard did not reject with HUB_ONLY_ENDPOINT.
    const res = await request(app)
      .get('/api/stacks')
      .set('Authorization', authHeader)
      .set('x-node-id', String(remoteNodeId));

    expect(res.body?.code).not.toBe('HUB_ONLY_ENDPOINT');
  });
});
