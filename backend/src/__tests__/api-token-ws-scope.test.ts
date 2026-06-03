/**
 * Integration tests for API-token scope enforcement on the WebSocket upgrade.
 * Restricted scopes (read-only, deploy-only) may reach only stack logs and
 * notifications; every other WS path (host console, generic) is 403'd by the
 * scope gate before dispatch. Driven through a real listening server, no mocks.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import WebSocket from 'ws';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { createTestApiToken } from './helpers/apiTokenTestHelper';

let tmpDir: string;
let server: import('http').Server;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

function createToken(scope: 'read-only' | 'deploy-only' | 'full-admin'): string {
  const db = DatabaseService.getInstance();
  return createTestApiToken({ db: DatabaseService, scope, userId: db.getUserByUsername('testadmin')!.id });
}

beforeAll(async () => {
  vi.restoreAllMocks();
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

describe('WebSocket API-token scope enforcement', () => {
  it('blocks a read-only token from the host console (403)', async () => {
    expect(await upgradeStatus(createToken('read-only'), '/api/system/host-console')).toBe(403);
  });

  it('blocks a deploy-only token from the host console (403)', async () => {
    expect(await upgradeStatus(createToken('deploy-only'), '/api/system/host-console')).toBe(403);
  });

  it('blocks a read-only token from a generic socket (403)', async () => {
    expect(await upgradeStatus(createToken('read-only'), '/ws')).toBe(403);
  });

  it('does not scope-block a read-only token from notifications', async () => {
    expect(await upgradeStatus(createToken('read-only'), '/ws/notifications')).not.toBe(403);
  });

  it('does not scope-block a deploy-only token from notifications', async () => {
    expect(await upgradeStatus(createToken('deploy-only'), '/ws/notifications')).not.toBe(403);
  });

  it('does not scope-block a read-only token from stack logs', async () => {
    expect(await upgradeStatus(createToken('read-only'), '/api/stacks/test-stack/logs')).not.toBe(403);
  });

  it('does not scope-block a full-admin token from a generic socket', async () => {
    expect(await upgradeStatus(createToken('full-admin'), '/ws')).not.toBe(403);
  });
});
