/**
 * Observe Only (and unknown) API-token scopes on the WebSocket upgrade.
 *
 * The gate is an allowlist: `full-admin` passes, `read-only`/`deploy-only` reach
 * logs and notifications, and everything else is refused before dispatch. The
 * unknown-scope case is the regression this file exists for: the old gate only
 * restricted the two named scopes, so a value it did not recognize fell through
 * to the local exec handler, which accepts any decoded `api_token` principal.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { createTestApiToken } from './helpers/apiTokenTestHelper';

let tmpDir: string;
let server: import('http').Server;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

function createToken(scope: string): string {
  const db = DatabaseService.getInstance();
  const name = `ws-${scope || 'empty'}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const raw = createTestApiToken({
    db: DatabaseService,
    scope: 'read-only',
    userId: db.getUserByUsername('testadmin')!.id,
    name,
    expiresAt: Date.now() + 60_000,
  });
  db.getDb().prepare('UPDATE api_tokens SET scope = ? WHERE name = ?').run(scope, name);
  return raw;
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  const mod = await import('../index');
  server = mod.server;
  await new Promise<void>((resolve) => server.listen(0, resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  cleanupTestDb(tmpDir);
});

function wsUrl(path: string): string {
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Server not listening');
  return `ws://127.0.0.1:${addr.port}${path}`;
}

/** Resolve to the rejected-upgrade HTTP status, or 200 if the socket opens. */
function upgradeStatus(token: string, path: string): Promise<number> {
  return new Promise<number>((resolve) => {
    const ws = new WebSocket(wsUrl(path), { headers: { Authorization: `Bearer ${token}` } });
    ws.on('unexpected-response', (_req, res) => { ws.close(); resolve(res.statusCode ?? 0); });
    ws.on('open', () => { ws.close(); resolve(200); });
    ws.on('error', () => resolve(0));
  });
}

describe('Observe Only on WebSocket', () => {
  it.each([
    '/api/stacks/test-stack/logs',
    '/ws/notifications',
    '/ws',
    '/api/system/host-console',
    '/api/mesh/proxy-tunnel',
  ])('refuses %s', async (path) => {
    expect(await upgradeStatus(createToken('observe-only'), path)).toBe(403);
  });
});

describe('An unknown scope on WebSocket', () => {
  // The scope is validated at authentication, so a row carrying a value no
  // build issues is refused as an unauthorized credential before the path gate
  // runs. Either way it never reaches exec.
  it.each(['/ws', '/api/system/host-console', '/api/mesh/proxy-tunnel', '/ws/notifications'])(
    'refuses %s instead of falling through',
    async (path) => {
      expect(await upgradeStatus(createToken('legacy-observer'), path)).toBe(401);
    },
  );

  it('refuses an empty stored scope too', async () => {
    expect(await upgradeStatus(createToken(''), '/ws')).toBe(401);
  });
});

describe('Existing scopes keep their WebSocket matrix', () => {
  it('still lets read-only reach logs and notifications', async () => {
    const token = createToken('read-only');
    expect(await upgradeStatus(token, '/api/stacks/test-stack/logs')).not.toBe(403);
    expect(await upgradeStatus(token, '/ws/notifications')).not.toBe(403);
  });

  it('still blocks read-only from exec and host console', async () => {
    const token = createToken('read-only');
    expect(await upgradeStatus(token, '/ws')).toBe(403);
    expect(await upgradeStatus(token, '/api/system/host-console')).toBe(403);
  });

  it('still lets full-admin reach exec', async () => {
    expect(await upgradeStatus(createToken('full-admin'), '/ws')).not.toBe(403);
  });
});
