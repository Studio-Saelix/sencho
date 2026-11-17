import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { createTestApiToken } from './helpers/apiTokenTestHelper';
import { setReadinessProbesForTest } from '../routes/pilotReadiness';
import { parseReadinessReport, REQUIRED_PILOT_CAPABILITIES } from '../pilot/readinessContract';
import { getActiveCapabilities } from '../services/CapabilityRegistry';
import { PROXY_ROLE_HEADER } from '../services/license-headers';

/**
 * The agent's readiness route is the hub's question to its own Pilot, so only
 * a request the tunnel carried for the hub itself reaches it: not a browser
 * session, not an API token, not a node-proxy credential, and not a signed-in
 * user's request the hub relayed through the tunnel.
 */

let tmpDir: string;
let app: import('express').Express;
const NONCE = 'f'.repeat(32);
const ENROLLED_TOKEN = jwt.sign({ scope: 'pilot_tunnel', nodeId: 12 }, 'hub-secret');

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  setReadinessProbesForTest({
    environment: () => ({
      proto: 'https',
      host: 'pilot',
      composeDir: '/opt/docker/sencho',
      pingDocker: async () => undefined,
      composeVersion: async () => '2.35.1',
      accessDir: async () => ({ exists: true, isDir: true, writable: true }),
      bindMounts: async () => null,
      selfStackDirectoryName: async () => null,
      diskUsage: async () => ({ usePercent: 10, freeBytes: 100 * 1024 ** 3 }),
    }),
    dockerVersion: async () => ({ Version: '28.1.1', ApiVersion: '1.49' }),
    listContainers: async () => [],
    persistedToken: () => ENROLLED_TOKEN,
    now: () => Date.now(),
  });
});

afterAll(() => {
  setReadinessProbesForTest(null);
  delete process.env.SENCHO_MODE;
  cleanupTestDb(tmpDir);
});

afterEach(() => {
  delete process.env.SENCHO_MODE;
});

const tunnel = () => `Bearer ${jwt.sign({ scope: 'pilot_tunnel', nodeId: 1 }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;

describe('agent readiness route', () => {
  it('does not exist outside Pilot mode', async () => {
    const res = await request(app).get(`/api/pilot/readiness?nonce=${NONCE}`).set('Authorization', tunnel());
    expect(res.status).toBe(404);
  });

  it('answers the hub through the tunnel with a report of this contract', async () => {
    process.env.SENCHO_MODE = 'pilot';
    const res = await request(app).get(`/api/pilot/readiness?nonce=${NONCE}`).set('Authorization', tunnel());
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const report = parseReadinessReport(res.body);
    expect(report).toMatchObject({ nonce: NONCE, agent: { enrolledNodeId: 12 }, composeDir: '/opt/docker/sencho' });
    expect(report?.checks.map((check) => check.id)).not.toContain('tls');
    // The capabilities are the ones this agent serves on its own /api/meta, taken for this request.
    expect(report?.agent.capabilities).toEqual([...getActiveCapabilities()]);
    expect(report?.agent.capabilities).toEqual(expect.arrayContaining([...REQUIRED_PILOT_CAPABILITIES]));
    expect(JSON.stringify(res.body)).not.toContain(ENROLLED_TOKEN);
  });

  it('refuses a request the hub relayed for a signed-in user', async () => {
    process.env.SENCHO_MODE = 'pilot';
    const res = await request(app).get(`/api/pilot/readiness?nonce=${NONCE}`).set('Authorization', tunnel()).set(PROXY_ROLE_HEADER, 'admin');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('READINESS_HUB_ONLY');
  });

  it('refuses a browser session, an API token and a node-proxy credential', async () => {
    process.env.SENCHO_MODE = 'pilot';
    const db = DatabaseService.getInstance();
    const admin = db.getUserByUsername(TEST_USERNAME);
    if (!admin) throw new Error('test admin missing');
    const apiToken = createTestApiToken({ db: DatabaseService, scope: 'full-admin', userId: admin.id, name: 'readiness-token', expiresAt: Date.now() + 60_000 });
    const credentials = [
      `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '5m' })}`,
      `Bearer ${apiToken}`,
      `Bearer ${jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '5m' })}`,
    ];
    for (const credential of credentials) {
      const res = await request(app).get(`/api/pilot/readiness?nonce=${NONCE}`).set('Authorization', credential);
      expect(res.status).toBe(403);
    }
    expect((await request(app).get(`/api/pilot/readiness?nonce=${NONCE}`)).status).toBe(401);
  });

  it('needs a nonce', async () => {
    process.env.SENCHO_MODE = 'pilot';
    for (const nonce of ['', 'short', 'Z'.repeat(32), 'a'.repeat(65)]) {
      const res = await request(app).get(`/api/pilot/readiness?nonce=${nonce}`).set('Authorization', tunnel());
      expect(res.status).toBe(400);
    }
  });
});
