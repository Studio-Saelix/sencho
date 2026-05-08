/**
 * Regression guard for the agent-side loopback auth injection.
 *
 * The central proxy strips browser cookies and the (empty) pilot-agent api_token
 * before forwarding through the tunnel. Without an inline auth header on the
 * agent's loopback request, the local Sencho's `authMiddleware` would 401 every
 * proxied call. The agent injects a `pilot_tunnel`-scoped JWT signed by the
 * LOCAL `auth_jwt_secret`, which the loopback `authMiddleware` accepts via the
 * existing scope branch with no special-case bypass.
 *
 * This test verifies:
 *   1. `getLoopbackAuthHeader` returns a Bearer header backed by a JWT that
 *      the local secret verifies, with the expected scope.
 *   2. Subsequent calls within the refresh window return the cached header
 *      (no re-mint per request).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { PilotAgent } from '../pilot/agent';

describe('PilotAgent loopback auth injection', () => {
  let tmpDir: string;
  let agent: PilotAgent;
  let mintHeader: () => string | null;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    // Importing the index loads DatabaseService against the seeded baseline so
    // getGlobalSettings().auth_jwt_secret resolves to TEST_JWT_SECRET.
    await import('../index');
    agent = new PilotAgent({
      primaryUrl: 'http://primary.invalid',
      loopbackPort: 1,
      initialToken: 'irrelevant-for-this-test',
      enrolling: false,
    });
    mintHeader = (agent as unknown as { getLoopbackAuthHeader: () => string | null }).getLoopbackAuthHeader.bind(agent);
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  it('mints a Bearer header with a pilot_tunnel-scoped JWT signed by the local secret', () => {
    const header = mintHeader();
    expect(header).toMatch(/^Bearer /);
    const token = header!.slice('Bearer '.length);
    const decoded = jwt.verify(token, TEST_JWT_SECRET) as { scope?: string; nodeId?: number; exp?: number };
    expect(decoded.scope).toBe('pilot_tunnel');
    expect(typeof decoded.exp).toBe('number');
  });

  it('returns the cached header on a quick second call', () => {
    const a = mintHeader();
    const b = mintHeader();
    expect(a).toBe(b);
  });
});
