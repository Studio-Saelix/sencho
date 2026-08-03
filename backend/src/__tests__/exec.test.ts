/**
 * Tests for container exec: state validation, shell fallback,
 * input handling, cleanup, and WebSocket upgrade auth enforcement.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { EventEmitter } from 'events';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

// ── Hoisted mocks ──────────────────────────────────────────────────────

const { mockDocker, mockContainer, mockExecInstance } = vi.hoisted(() => {
  const mockExecInstance = {
    start: vi.fn(),
    resize: vi.fn().mockResolvedValue(undefined),
  };

  const mockContainer = {
    inspect: vi.fn(),
    exec: vi.fn(),
  };

  const mockDocker = {
    getContainer: vi.fn().mockReturnValue(mockContainer),
    listContainers: vi.fn().mockResolvedValue([]),
    listImages: vi.fn().mockResolvedValue([]),
    listVolumes: vi.fn().mockResolvedValue({ Volumes: [] }),
    listNetworks: vi.fn().mockResolvedValue([]),
    df: vi.fn().mockResolvedValue({ LayersSize: 0, Images: [], Containers: [], Volumes: [] }),
    pruneContainers: vi.fn().mockResolvedValue({ SpaceReclaimed: 0 }),
    pruneImages: vi.fn().mockResolvedValue({ SpaceReclaimed: 0 }),
    pruneNetworks: vi.fn().mockResolvedValue({}),
    pruneVolumes: vi.fn().mockResolvedValue({ SpaceReclaimed: 0 }),
  };

  return { mockDocker, mockContainer, mockExecInstance };
});

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getDocker: () => mockDocker,
      getDefaultNodeId: () => 1,
      getNode: () => ({ id: 1, type: 'local', name: 'Local' }),
    }),
  },
}));

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>();
  return { ...actual, promisify: actual.promisify };
});

import DockerController from '../services/DockerController';
import WebSocket from 'ws';

// ── Helper: mock stream (fresh per test) ───────────────────────────────

function createMockStream() {
  const stream = new EventEmitter();
  (stream as EventEmitter & { write: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }).write = vi.fn();
  (stream as EventEmitter & { write: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }).destroy = vi.fn();
  return stream as EventEmitter & { write: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
}

// ── Helper: mock WebSocket ─────────────────────────────────────────────

function createMockWs(): WebSocket {
  const ws = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
    close: vi.fn(),
    terminate: vi.fn(),
    ping: vi.fn(),
    pong: vi.fn(),
  });
  return ws as unknown as WebSocket;
}

let mockStream: ReturnType<typeof createMockStream>;

beforeEach(() => {
  vi.clearAllMocks();
  mockStream = createMockStream();
  // Reset defaults
  mockContainer.inspect.mockResolvedValue({ State: { Running: true } });
  mockContainer.exec.mockResolvedValue(mockExecInstance);
  mockExecInstance.start.mockResolvedValue(mockStream);
  mockExecInstance.resize.mockResolvedValue(undefined);
});

// ── execContainer: input validation ────────────────────────────────────

describe('DockerController.execContainer - input validation', () => {
  it('rejects empty containerId', async () => {
    const ws = createMockWs();
    const dc = DockerController.getInstance(1);
    await dc.execContainer('', ws);

    expect(ws.send).toHaveBeenCalledWith(
      expect.stringContaining('No container ID provided'),
    );
    expect(ws.close).toHaveBeenCalled();
    expect(mockDocker.getContainer).not.toHaveBeenCalled();
  });
});

// ── execContainer: container state validation ──────────────────────────

describe('DockerController.execContainer - state validation', () => {
  it('rejects exec on a stopped container', async () => {
    mockContainer.inspect.mockResolvedValue({ State: { Running: false } });

    const ws = createMockWs();
    const dc = DockerController.getInstance(1);
    await dc.execContainer('abc123', ws);

    expect(ws.send).toHaveBeenCalledWith(
      expect.stringContaining('Container is not running'),
    );
    expect(ws.close).toHaveBeenCalled();
    expect(mockContainer.exec).not.toHaveBeenCalled();
  });

  it('proceeds when container is running', async () => {
    const ws = createMockWs();
    const dc = DockerController.getInstance(1);
    await dc.execContainer('abc123', ws);

    expect(mockContainer.inspect).toHaveBeenCalled();
    expect(mockContainer.exec).toHaveBeenCalled();
    expect(mockExecInstance.start).toHaveBeenCalled();
    expect(ws.close).not.toHaveBeenCalled();
  });
});

// ── execContainer: shell fallback ──────────────────────────────────────

describe('DockerController.execContainer - shell fallback', () => {
  it('falls back to /bin/sh when /bin/bash exec creation fails', async () => {
    mockContainer.exec
      .mockRejectedValueOnce(new Error('OCI: bash not found'))
      .mockResolvedValueOnce(mockExecInstance);

    const ws = createMockWs();
    const dc = DockerController.getInstance(1);
    await dc.execContainer('abc123', ws);

    expect(mockContainer.exec).toHaveBeenCalledTimes(2);
    expect(mockContainer.exec.mock.calls[0][0]).toMatchObject({ Cmd: ['/bin/bash'] });
    expect(mockContainer.exec.mock.calls[1][0]).toMatchObject({ Cmd: ['/bin/sh'] });
    expect(mockExecInstance.start).toHaveBeenCalled();
  });

  it('falls back to /bin/sh when /bin/bash start() fails', async () => {
    // Exec creation succeeds for bash but start() fails (common Docker behavior)
    const failingExec = {
      start: vi.fn().mockRejectedValueOnce(new Error('exec failed: bash not found')),
      resize: vi.fn(),
    };
    mockContainer.exec
      .mockResolvedValueOnce(failingExec)
      .mockResolvedValueOnce(mockExecInstance);

    const ws = createMockWs();
    const dc = DockerController.getInstance(1);
    await dc.execContainer('abc123', ws);

    expect(mockContainer.exec).toHaveBeenCalledTimes(2);
    expect(failingExec.start).toHaveBeenCalled();
    expect(mockExecInstance.start).toHaveBeenCalled();
  });

  it('sends error to client when both shells fail', async () => {
    mockContainer.exec
      .mockRejectedValueOnce(new Error('bash not found'))
      .mockRejectedValueOnce(new Error('sh not found'));

    const ws = createMockWs();
    const dc = DockerController.getInstance(1);
    await dc.execContainer('abc123', ws);

    expect(ws.send).toHaveBeenCalledWith(
      expect.stringContaining('Failed to start shell'),
    );
  });
});

// ── execContainer: stream piping ───────────────────────────────────────

describe('DockerController.execContainer - stream handling', () => {
  it('forwards container output to WebSocket', async () => {
    const ws = createMockWs();
    const dc = DockerController.getInstance(1);
    await dc.execContainer('abc123', ws);

    mockStream.emit('data', Buffer.from('hello world'));
    expect(ws.send).toHaveBeenCalledWith('hello world');
  });

  it('handles input messages from client', async () => {
    const ws = createMockWs();
    const dc = DockerController.getInstance(1);
    await dc.execContainer('abc123', ws);

    (ws as unknown as EventEmitter).emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'input', data: 'ls\n' })),
    );
    expect(mockStream.write).toHaveBeenCalledWith('ls\n');
  });

  it('handles resize messages from client', async () => {
    const ws = createMockWs();
    const dc = DockerController.getInstance(1);
    await dc.execContainer('abc123', ws);

    (ws as unknown as EventEmitter).emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'resize', rows: 24, cols: 80 })),
    );
    expect(mockExecInstance.resize).toHaveBeenCalledWith({ h: 24, w: 80 });
  });

  it('handles ping messages without error', async () => {
    const ws = createMockWs();
    const dc = DockerController.getInstance(1);
    await dc.execContainer('abc123', ws);

    (ws as unknown as EventEmitter).emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'ping' })),
    );
    expect(mockStream.write).not.toHaveBeenCalled();
  });

  it('handles malformed JSON messages gracefully', async () => {
    const ws = createMockWs();
    const dc = DockerController.getInstance(1);
    await dc.execContainer('abc123', ws);

    // Should not throw
    (ws as unknown as EventEmitter).emit('message', Buffer.from('not json'));
    expect(mockStream.write).not.toHaveBeenCalled();
  });

  it('closes WebSocket when stream ends', async () => {
    const ws = createMockWs();
    const dc = DockerController.getInstance(1);
    await dc.execContainer('abc123', ws);

    mockStream.emit('end');
    expect(ws.close).toHaveBeenCalled();
  });
});

// ── execContainer: cleanup ─────────────────────────────────────────────

describe('DockerController.execContainer - cleanup', () => {
  it('destroys stream when WebSocket closes', async () => {
    const ws = createMockWs();
    const dc = DockerController.getInstance(1);
    await dc.execContainer('abc123', ws);

    (ws as unknown as EventEmitter).emit('close');
    expect(mockStream.destroy).toHaveBeenCalled();
  });

  it('handles double-destroy gracefully', async () => {
    mockStream.destroy.mockImplementationOnce(() => {
      throw new Error('Already destroyed');
    });

    const ws = createMockWs();
    const dc = DockerController.getInstance(1);
    await dc.execContainer('abc123', ws);

    // Should not throw
    (ws as unknown as EventEmitter).emit('close');
    expect(mockStream.destroy).toHaveBeenCalled();
  });
});

// ── WebSocket upgrade: auth enforcement ────────────────────────────────

describe('WebSocket upgrade - exec auth enforcement', () => {
  let tmpDir: string;
  let server: import('http').Server;

  beforeAll(async () => {
    // Clear module mocks so the real NodeRegistry is used for integration tests
    vi.restoreAllMocks();
    tmpDir = await setupTestDb();
    const mod = await import('../index');
    server = mod.server;
    await new Promise<void>((resolve) => server.listen(0, resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    cleanupTestDb(tmpDir);
  });

  function getWsUrl(path = '/ws'): string {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Server not listening');
    return `ws://127.0.0.1:${addr.port}${path}`;
  }

  it('rejects WebSocket upgrade with no token (401)', async () => {
    const ws = new WebSocket(getWsUrl());
    const code = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(0));
    });
    expect(code).toBe(401);
  });

  // All five built-in roles: container exec requires admin. Every non-admin
  // role must be rejected at upgrade time by generic.ts's role === 'admin' gate.
  const NON_ADMIN_EXEC_ROLES = ['viewer', 'deployer', 'node-admin', 'auditor'] as const;

  for (const role of NON_ADMIN_EXEC_ROLES) {
    it(`rejects /ws upgrade with ${role} token (403)`, async () => {
      const { DatabaseService } = await import('../services/DatabaseService');
      const bcrypt = await import('bcrypt');
      const username = `exec_${role.replace('-', '_')}`;
      const hash = bcrypt.hashSync('password123', 1);
      try {
        DatabaseService.getInstance().addUser({ username, password_hash: hash, role });
      } catch {
        // User may already exist from a prior run in the same worker
      }

      const token = jwt.sign(
        { username, role },
        TEST_JWT_SECRET,
        { expiresIn: '1m' },
      );
      const ws = new WebSocket(getWsUrl(), { headers: { Cookie: `sencho_token=${token}` } });
      const code = await new Promise<number>((resolve) => {
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.on('error', () => resolve(0));
      });
      expect(code).toBe(403);
    });
  }

  it('rejects legacy no-tv admin JWT after token_version bump (401)', async () => {
    // A legacy token without a tv claim is treated as version 1; once the
    // account version is bumped it must be rejected on /ws like on HTTP.
    const { DatabaseService } = await import('../services/DatabaseService');
    const bcrypt = await import('bcrypt');
    const db = DatabaseService.getInstance();
    const username = `legacy-tv-admin-${Date.now()}`;
    const id = db.addUser({
      username,
      password_hash: await bcrypt.hash('password123', 1),
      role: 'admin',
    });
    db.bumpTokenVersion(id);

    const legacyNoTv = jwt.sign(
      { username, role: 'admin' },
      TEST_JWT_SECRET,
      { expiresIn: '1m' },
    );
    const ws = new WebSocket(getWsUrl(), { headers: { Cookie: `sencho_token=${legacyNoTv}` } });
    const code = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      // A regression (upgrade accepted) must fail fast with 200, not hang.
      ws.on('open', () => { ws.close(); resolve(200); });
      ws.on('error', () => resolve(0));
    });
    expect(code).toBe(401);
  });

  it('rejects WebSocket upgrade with node_proxy token (403)', async () => {
    const token = jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });
    const ws = new WebSocket(getWsUrl(), { headers: { Authorization: `Bearer ${token}` } });
    const code = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(0));
    });
    expect(code).toBe(403);
  });

  it('rejects WebSocket upgrade with mfa_pending token (403)', async () => {
    // Partial-auth must not open /ws (upgrade early-reject + generic deny-by-default).
    // Pre-fix: any set scope skipped the admin check and unlocked execContainer.
    const token = jwt.sign(
      { scope: 'mfa_pending', user_id: 1, username: 'viewer' },
      TEST_JWT_SECRET,
      { expiresIn: '5m' },
    );
    const ws = new WebSocket(getWsUrl(), { headers: { Authorization: `Bearer ${token}` } });
    const code = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(0));
    });
    expect(code).toBe(403);
  });

  it('rejects WebSocket upgrade with pilot_enroll token (403)', async () => {
    const token = jwt.sign(
      { scope: 'pilot_enroll', nodeId: 1, enrollNonce: 'test-nonce' },
      TEST_JWT_SECRET,
      { expiresIn: '15m' },
    );
    const ws = new WebSocket(getWsUrl(), { headers: { Authorization: `Bearer ${token}` } });
    const code = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(0));
    });
    expect(code).toBe(403);
  });

  it('rejects WebSocket upgrade with an unknown scoped JWT (403)', async () => {
    const token = jwt.sign({ scope: 'future_machine_scope' }, TEST_JWT_SECRET, { expiresIn: '1m' });
    const ws = new WebSocket(getWsUrl(), { headers: { Authorization: `Bearer ${token}` } });
    const code = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(0));
    });
    expect(code).toBe(403);
  });

  it('accepts WebSocket upgrade with pilot_tunnel token (pilot loopback)', async () => {
    // Agent loopback injects pilot_tunnel on every forwarded WS, including /ws.
    const token = jwt.sign({ scope: 'pilot_tunnel', nodeId: 1 }, TEST_JWT_SECRET, { expiresIn: '1h' });
    const ws = new WebSocket(getWsUrl(), { headers: { Authorization: `Bearer ${token}` } });
    const connected = await new Promise<boolean>((resolve) => {
      ws.on('open', () => {
        ws.close();
        resolve(true);
      });
      ws.on('error', () => resolve(false));
      ws.on('unexpected-response', () => resolve(false));
    });
    expect(connected).toBe(true);
  });

  it('accepts WebSocket upgrade with container-exec console_session (remote exec)', async () => {
    const { mintConsoleSession } = await import('../helpers/consoleSession');
    const token = mintConsoleSession({ path: 'container-exec' });
    const ws = new WebSocket(getWsUrl(), { headers: { Authorization: `Bearer ${token}` } });
    const connected = await new Promise<boolean>((resolve) => {
      ws.on('open', () => {
        ws.close();
        resolve(true);
      });
      ws.on('error', () => resolve(false));
      ws.on('unexpected-response', () => resolve(false));
    });
    expect(connected).toBe(true);
  });

  it('rejects host-console console_session on /ws (path gate before allowlist)', async () => {
    // Path mismatch is enforced in upgradeHandler (consoleSessionPathForPathname)
    // before the generic allowlist; allowlist must not be the sole path gate.
    const { mintConsoleSession } = await import('../helpers/consoleSession');
    const token = mintConsoleSession({ path: 'host-console' });
    const ws = new WebSocket(getWsUrl(), { headers: { Authorization: `Bearer ${token}` } });
    const code = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(0));
    });
    expect(code).toBe(403);
  });

  it('accepts WebSocket upgrade with admin token', async () => {
    const token = jwt.sign(
      { username: TEST_USERNAME, role: 'admin' },
      TEST_JWT_SECRET,
      { expiresIn: '1m' },
    );
    const ws = new WebSocket(getWsUrl(), { headers: { Cookie: `sencho_token=${token}` } });
    const connected = await new Promise<boolean>((resolve) => {
      ws.on('open', () => {
        ws.close();
        resolve(true);
      });
      ws.on('error', () => resolve(false));
      ws.on('unexpected-response', () => resolve(false));
    });
    expect(connected).toBe(true);
  });
});
