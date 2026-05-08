/**
 * Regression guard for the pilot-agent dispatch path in the remote-node HTTP
 * proxy.
 *
 * `docs/internal/architecture/pilot-agent.md` describes the intended routing:
 * `PilotTunnelBridge` opens a loopback HTTP server and `NodeRegistry.getProxyTarget`
 * returns that loopback URL for pilot-agent nodes. The proxy middleware must
 * resolve targets via `getProxyTarget` rather than reading `node.api_url`
 * directly, otherwise pilot-agent nodes can never accept HTTP API calls
 * regardless of tunnel state.
 *
 * This test covers two assertions on the response gate:
 *   1. A pilot-agent node with no active tunnel returns 503 with a
 *      tunnel-disconnected message (not the proxy-mode "configure api_url"
 *      message, which would mislead the operator).
 *   2. A proxy-mode node missing api_url still returns the original
 *      configuration message, so the diagnostic preserved for proxy mode is
 *      not lost.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

describe('remoteNodeProxy pilot-agent dispatch', () => {
  let tmpDir: string;
  let app: import('express').Express;
  let authHeader: string;
  let pilotAgentNodeId: number;
  let proxyModeMissingNodeId: number;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ app } = await import('../index'));

    const { DatabaseService } = await import('../services/DatabaseService');

    pilotAgentNodeId = DatabaseService.getInstance().addNode({
      name: 'pilot-agent-test',
      type: 'remote',
      mode: 'pilot_agent',
      compose_dir: '/tmp',
      is_default: false,
      api_url: '',
      api_token: '',
    });

    proxyModeMissingNodeId = DatabaseService.getInstance().addNode({
      name: 'proxy-mode-misconfigured',
      type: 'remote',
      mode: 'proxy',
      compose_dir: '/tmp',
      is_default: false,
      api_url: '',
      api_token: '',
    });

    const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });
    authHeader = `Bearer ${token}`;
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  it('returns 503 with a pilot-tunnel-disconnected message when no tunnel is active', async () => {
    const res = await request(app)
      .post('/api/stacks')
      .set('Authorization', authHeader)
      .set('x-node-id', String(pilotAgentNodeId))
      .send({ name: 'whatever' });

    expect(res.status).toBe(503);
    expect(res.body?.error).toMatch(/pilot tunnel/i);
    expect(res.body?.error).toMatch(/disconnected/i);
    expect(res.body?.error).not.toMatch(/api url or token/i);
  });

  it('returns 503 with the configuration message for proxy-mode nodes missing api_url', async () => {
    const res = await request(app)
      .post('/api/stacks')
      .set('Authorization', authHeader)
      .set('x-node-id', String(proxyModeMissingNodeId))
      .send({ name: 'whatever' });

    expect(res.status).toBe(503);
    expect(res.body?.error).toMatch(/api url or token/i);
    expect(res.body?.error).toMatch(/Settings/);
    expect(res.body?.error).not.toMatch(/pilot tunnel/i);
  });
});
