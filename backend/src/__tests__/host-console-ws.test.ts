/**
 * Integration tests for the Host Console WebSocket upgrade. These drive the
 * real upgrade handler through a listening server (no mocked sockets) to verify
 * the gate chain end-to-end: unauthenticated, machine-credential, RBAC, and
 * tier rejections, plus the accepted path (which must record an audit row) and
 * the stack-path boundary rejection.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import WebSocket from 'ws';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

const HOST_CONSOLE_PATH = '/api/system/host-console';

describe('WebSocket upgrade - host console auth enforcement', () => {
  let tmpDir: string;
  let server: import('http').Server;
  let getTierSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    vi.restoreAllMocks();
    tmpDir = await setupTestDb();
    // Host console is available on every tier for admins; mock paid so other
    // suites that share LicenseService state stay stable.
    const { LicenseService } = await import('../services/LicenseService');
    getTierSpy = vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
    const mod = await import('../index');
    server = mod.server;
    await new Promise<void>((resolve) => server.listen(0, resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.restoreAllMocks();
    cleanupTestDb(tmpDir);
  });

  function wsUrl(query = ''): string {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Server not listening');
    return `ws://127.0.0.1:${addr.port}${HOST_CONSOLE_PATH}${query}`;
  }

  function adminToken(): string {
    return jwt.sign({ username: TEST_USERNAME, role: 'admin' }, TEST_JWT_SECRET, { expiresIn: '1m' });
  }

  /** Resolve to the HTTP status of a rejected upgrade (0 if no response). */
  function expectRejected(ws: WebSocket): Promise<number> {
    return new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => { ws.close(); resolve(200); });
      ws.on('error', () => resolve(0));
    });
  }

  it('rejects an upgrade with no token (401)', async () => {
    expect(await expectRejected(new WebSocket(wsUrl()))).toBe(401);
  });

  it('rejects a node_proxy machine token (403)', async () => {
    const token = jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });
    const ws = new WebSocket(wsUrl(), { headers: { Authorization: `Bearer ${token}` } });
    expect(await expectRejected(ws)).toBe(403);
  });

  // All five built-in roles: only admin (system:console) is accepted on host
  // console. Every other role must be rejected at upgrade time.
  const NON_ADMIN_HOST_CONSOLE_ROLES = ['viewer', 'deployer', 'node-admin', 'auditor'] as const;

  for (const role of NON_ADMIN_HOST_CONSOLE_ROLES) {
    it(`rejects ${role} user without system:console (403)`, async () => {
      const { DatabaseService } = await import('../services/DatabaseService');
      const username = `hc_${role.replace('-', '_')}`;
      const hash = await bcrypt.hash('password123', 1);
      try {
        DatabaseService.getInstance().addUser({ username, password_hash: hash, role });
      } catch {
        // already exists from a prior run in the same worker
      }
      const token = jwt.sign({ username, role }, TEST_JWT_SECRET, { expiresIn: '1m' });
      const ws = new WebSocket(wsUrl(), { headers: { Cookie: `sencho_token=${token}` } });
      expect(await expectRejected(ws)).toBe(403);
    });
  }

  it('accepts a Community-tier admin', async () => {
    getTierSpy.mockReturnValueOnce('community');
    const ws = new WebSocket(wsUrl(), { headers: { Cookie: `sencho_token=${adminToken()}` } });
    const opened = await new Promise<boolean>((resolve) => {
      ws.on('open', () => { ws.close(); resolve(true); });
      ws.on('error', () => resolve(false));
      ws.on('unexpected-response', () => resolve(false));
    });
    expect(opened).toBe(true);
  });

  it('accepts a console_session Bearer on Community (remote bridge mint path)', async () => {
    getTierSpy.mockReturnValueOnce('community');
    const { mintConsoleSession } = await import('../helpers/consoleSession');
    const token = mintConsoleSession({ path: 'host-console', actingAs: TEST_USERNAME });
    const ws = new WebSocket(wsUrl(), { headers: { Authorization: `Bearer ${token}` } });
    const opened = await new Promise<boolean>((resolve) => {
      ws.on('open', () => { ws.close(); resolve(true); });
      ws.on('error', () => resolve(false));
      ws.on('unexpected-response', () => resolve(false));
    });
    expect(opened).toBe(true);
  });

  it('accepts an admin on Admiral and records an open audit row', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const insertSpy = vi.spyOn(DatabaseService.getInstance(), 'insertAuditLog');
    const ws = new WebSocket(wsUrl(), { headers: { Cookie: `sencho_token=${adminToken()}` } });

    const opened = await new Promise<boolean>((resolve) => {
      ws.on('open', () => resolve(true));
      ws.on('error', () => resolve(false));
      ws.on('unexpected-response', () => resolve(false));
    });
    expect(opened).toBe(true);

    // The session-open audit row is written server-side just after the PTY
    // spawns; poll briefly for it, then assert it captures the real identity.
    let openRow: Omit<import('../services/DatabaseService').AuditLogEntry, 'id'> | undefined;
    await waitFor(() => {
      const call = insertSpy.mock.calls.find(
        ([entry]) => entry?.path === HOST_CONSOLE_PATH && entry?.summary === 'Opened host console session',
      );
      if (call) openRow = call[0];
      return openRow !== undefined;
    });
    expect(openRow).toBeDefined();
    expect(openRow?.username).toBe(TEST_USERNAME);
    expect(typeof openRow?.node_id).toBe('number');
    expect(openRow?.ip_address).toBeTruthy();

    ws.close();
    insertSpy.mockRestore();
  });

  it('rejects a stack path that escapes the base directory', async () => {
    const ws = new WebSocket(wsUrl('?stack=' + encodeURIComponent('../escape-evil')), {
      headers: { Cookie: `sencho_token=${adminToken()}` },
    });
    const firstMessage = await new Promise<string>((resolve) => {
      ws.on('message', (data) => resolve(data.toString()));
      ws.on('error', () => resolve(''));
      ws.on('unexpected-response', () => resolve(''));
    });
    expect(firstMessage).toContain('Invalid stack path');
    ws.close();
  });


  it('rejects an unknown nodeId without spawning a PTY (404)', async () => {
    const { HostTerminalService } = await import('../services/HostTerminalService');
    const spawnSpy = vi.spyOn(HostTerminalService, 'spawnTerminal');
    try {
      const ws = new WebSocket(wsUrl('?nodeId=99999999'), {
        headers: { Cookie: `sencho_token=${adminToken()}` },
      });
      expect(await expectRejected(ws)).toBe(404);
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('rejects a malformed nodeId that parseInt would coerce (404)', async () => {
    const ws = new WebSocket(wsUrl('?nodeId=1abc'), {
      headers: { Cookie: `sencho_token=${adminToken()}` },
    });
    expect(await expectRejected(ws)).toBe(404);
  });

  it('rejects zero and negative nodeId values (404)', async () => {
    for (const id of ['0', '-1']) {
      const ws = new WebSocket(wsUrl(`?nodeId=${id}`), {
        headers: { Cookie: `sencho_token=${adminToken()}` },
      });
      expect(await expectRejected(ws)).toBe(404);
    }
  });

  it('rejects a replayed console_session token on second Host Console upgrade', async () => {
    const { mintConsoleSession } = await import('../helpers/consoleSession');
    const token = mintConsoleSession({ path: 'host-console', actingAs: 'qaadmin' });
    const first = new WebSocket(wsUrl(), { headers: { Authorization: `Bearer ${token}` } });
    const firstOpened = await new Promise<boolean>((resolve) => {
      first.on('open', () => { first.close(); resolve(true); });
      first.on('error', () => resolve(false));
      first.on('unexpected-response', () => resolve(false));
    });
    expect(firstOpened).toBe(true);
    const second = new WebSocket(wsUrl(), { headers: { Authorization: `Bearer ${token}` } });
    expect(await expectRejected(second)).toBe(401);
  });

  it('rejects a host-console console_session on the container-exec /ws path', async () => {
    const { mintConsoleSession } = await import('../helpers/consoleSession');
    const token = mintConsoleSession({ path: 'host-console' });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Server not listening');
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(await expectRejected(ws)).toBe(403);
  });

  it('records acting_as on console_session open audit rows', async () => {
    const { mintConsoleSession } = await import('../helpers/consoleSession');
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    const insertSpy = vi.spyOn(db, 'insertAuditLog');
    const token = mintConsoleSession({ path: 'host-console', actingAs: 'qaadmin' });
    try {
      const ws = new WebSocket(wsUrl(), { headers: { Authorization: `Bearer ${token}` } });
      const opened = await new Promise<boolean>((resolve) => {
        ws.on('open', () => { ws.close(); resolve(true); });
        ws.on('error', () => resolve(false));
        ws.on('unexpected-response', () => resolve(false));
      });
      expect(opened).toBe(true);
      await waitFor(() => insertSpy.mock.calls.some((c) => {
        const e = c[0] as { summary?: string };
        return typeof e.summary === 'string' && e.summary.includes('Opened host console');
      }));
      const openEntry = insertSpy.mock.calls
        .map((c) => c[0] as { username: string; acting_as?: string | null; summary: string })
        .find((e) => e.summary.includes('Opened host console'));
      expect(openEntry?.username).toBe('console_session');
      expect(openEntry?.acting_as).toBe('qaadmin');
    } finally {
      insertSpy.mockRestore();
    }
  });

  it('closes without spawning a PTY when directory resolution throws (no default-node fallback)', async () => {
    const { FileSystemService } = await import('../services/FileSystemService');
    const { HostTerminalService } = await import('../services/HostTerminalService');
    const spawnSpy = vi.spyOn(HostTerminalService, 'spawnTerminal');
    const getInstanceSpy = vi.spyOn(FileSystemService, 'getInstance').mockImplementation(() => {
      throw new Error('compose dir unavailable');
    });

    try {
      const ws = new WebSocket(wsUrl(), { headers: { Cookie: `sencho_token=${adminToken()}` } });
      const firstMessage = await new Promise<string>((resolve) => {
        ws.on('message', (data) => resolve(data.toString()));
        ws.on('error', () => resolve(''));
        ws.on('unexpected-response', () => resolve(''));
      });
      expect(firstMessage).toMatch(/Failed to resolve console directory/i);
      expect(spawnSpy).not.toHaveBeenCalled();
      // getInstance must not be retried against a fallback/default node id.
      expect(getInstanceSpy).toHaveBeenCalledTimes(1);
      ws.close();
    } finally {
      spawnSpy.mockRestore();
      getInstanceSpy.mockRestore();
    }
  });
});

/** Poll a predicate up to ~1s; resolve true as soon as it passes. */
async function waitFor(predicate: () => boolean): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
}
