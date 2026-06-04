/**
 * Tests for the Host Console feature: environment sanitization, session limits,
 * and console-token RBAC enforcement.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import * as path from 'path';
import { EventEmitter } from 'events';
import * as pty from 'node-pty';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  // Mock LicenseService so paid-gated endpoints accept requests
  const { LicenseService } = await import('../services/LicenseService');
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
  ({ app } = await import('../index'));
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

// ─── Environment Variable Sanitization ──────────────────────────────────────

describe('HostTerminalService.sanitizeEnv', () => {
  let sanitizeEnv: (env: Record<string, string>) => Record<string, string>;

  beforeAll(async () => {
    const mod = await import('../services/HostTerminalService');
    sanitizeEnv = mod.HostTerminalService.sanitizeEnv;
  });

  it('strips DATABASE_URL (explicit blocklist)', () => {
    const result = sanitizeEnv({ DATABASE_URL: 'postgres://...', PATH: '/usr/bin' });
    expect(result).not.toHaveProperty('DATABASE_URL');
    expect(result).toHaveProperty('PATH', '/usr/bin');
  });

  it('strips REDIS_URL, MONGO_URI, AMQP_URL, DSN (explicit blocklist)', () => {
    const result = sanitizeEnv({
      REDIS_URL: 'redis://localhost',
      MONGO_URI: 'mongodb://localhost',
      AMQP_URL: 'amqp://localhost',
      DSN: 'sentry://...',
      HOME: '/home/user',
    });
    expect(result).not.toHaveProperty('REDIS_URL');
    expect(result).not.toHaveProperty('MONGO_URI');
    expect(result).not.toHaveProperty('AMQP_URL');
    expect(result).not.toHaveProperty('DSN');
    expect(result).toHaveProperty('HOME');
  });

  it('strips vars matching SECRET pattern', () => {
    const result = sanitizeEnv({ JWT_SECRET: 'abc', APP_SECRET_KEY: 'xyz', LANG: 'en' });
    expect(result).not.toHaveProperty('JWT_SECRET');
    expect(result).not.toHaveProperty('APP_SECRET_KEY');
    expect(result).toHaveProperty('LANG');
  });

  it('strips vars matching PASSWORD pattern', () => {
    const result = sanitizeEnv({ DB_PASSWORD: 'pass', SMTP_PASSWORD: 'pass', USER: 'me' });
    expect(result).not.toHaveProperty('DB_PASSWORD');
    expect(result).not.toHaveProperty('SMTP_PASSWORD');
    expect(result).toHaveProperty('USER');
  });

  it('strips vars matching TOKEN pattern', () => {
    const result = sanitizeEnv({ API_TOKEN: '123', GITHUB_TOKEN: 'ghp_...', TERM: 'xterm' });
    expect(result).not.toHaveProperty('API_TOKEN');
    expect(result).not.toHaveProperty('GITHUB_TOKEN');
    expect(result).toHaveProperty('TERM');
  });

  it('strips vars matching KEY pattern', () => {
    const result = sanitizeEnv({ AWS_ACCESS_KEY_ID: 'AKIA...', ENCRYPTION_KEY: 'k', SHELL: '/bin/bash' });
    expect(result).not.toHaveProperty('AWS_ACCESS_KEY_ID');
    expect(result).not.toHaveProperty('ENCRYPTION_KEY');
    expect(result).toHaveProperty('SHELL');
  });

  it('strips vars matching CREDENTIAL pattern', () => {
    const result = sanitizeEnv({ GCP_CREDENTIAL: 'json...', PATH: '/usr/bin' });
    expect(result).not.toHaveProperty('GCP_CREDENTIAL');
    expect(result).toHaveProperty('PATH');
  });

  it('strips vars matching PRIVATE pattern', () => {
    const result = sanitizeEnv({ SSH_PRIVATE_KEY: '-----BEGIN', PRIVATE_KEY_PEM: 'pem', HOSTNAME: 'box' });
    expect(result).not.toHaveProperty('SSH_PRIVATE_KEY');
    expect(result).not.toHaveProperty('PRIVATE_KEY_PEM');
    expect(result).toHaveProperty('HOSTNAME');
  });

  it('strips vars matching AUTH pattern', () => {
    const result = sanitizeEnv({ GITHUB_AUTH: 'token', OAUTH_CLIENT: 'id', COMPOSE_DIR: '/app' });
    expect(result).not.toHaveProperty('GITHUB_AUTH');
    expect(result).not.toHaveProperty('OAUTH_CLIENT');
    expect(result).toHaveProperty('COMPOSE_DIR');
  });

  it('strips vars matching PASSPHRASE pattern', () => {
    const result = sanitizeEnv({ GPG_PASSPHRASE: 'secret', PWD: '/home' });
    expect(result).not.toHaveProperty('GPG_PASSPHRASE');
    expect(result).toHaveProperty('PWD');
  });

  it('strips vars matching ENCRYPT pattern', () => {
    const result = sanitizeEnv({ ENCRYPT_KEY: 'abc', ENCRYPTION_ALGO: 'aes', NODE_ENV: 'prod' });
    expect(result).not.toHaveProperty('ENCRYPT_KEY');
    expect(result).not.toHaveProperty('ENCRYPTION_ALGO');
    expect(result).toHaveProperty('NODE_ENV');
  });

  it('strips vars matching SIGNING pattern', () => {
    const result = sanitizeEnv({ SIGNING_KEY: 'key', JWT_SIGNING_SECRET: 's', LC_ALL: 'C' });
    expect(result).not.toHaveProperty('SIGNING_KEY');
    expect(result).not.toHaveProperty('JWT_SIGNING_SECRET');
    expect(result).toHaveProperty('LC_ALL');
  });

  it('preserves safe environment variables', () => {
    const safe = {
      PATH: '/usr/bin',
      HOME: '/home/user',
      COMPOSE_DIR: '/app/compose',
      NODE_ENV: 'production',
      TERM: 'xterm-256color',
      SHELL: '/bin/bash',
      LANG: 'en_US.UTF-8',
    };
    const result = sanitizeEnv(safe);
    expect(result).toEqual(safe);
  });

  it('pattern matching is case-insensitive', () => {
    const result = sanitizeEnv({ my_secret: 'val', My_Password: 'val', PATH: '/usr/bin' });
    expect(result).not.toHaveProperty('my_secret');
    expect(result).not.toHaveProperty('My_Password');
    expect(result).toHaveProperty('PATH');
  });
});

// ─── Session Limit ──────────────────────────────────────────────────────────

describe('HostTerminalService session tracking', () => {
  let HostTerminalService: typeof import('../services/HostTerminalService').HostTerminalService;

  beforeAll(async () => {
    const mod = await import('../services/HostTerminalService');
    HostTerminalService = mod.HostTerminalService;
  });

  it('activeSessions map is accessible and starts empty', () => {
    // Clear any leftover sessions
    HostTerminalService.activeSessions.clear();
    expect(HostTerminalService.activeSessions.size).toBe(0);
  });
});

// ─── Stack-Path Resolution ──────────────────────────────────────────────────

describe('HostTerminalService.resolveConsoleDirectory', () => {
  let resolveConsoleDirectory: (baseDir: string, stackParam: string | null) => string | null;

  beforeAll(async () => {
    const mod = await import('../services/HostTerminalService');
    resolveConsoleDirectory = mod.HostTerminalService.resolveConsoleDirectory;
  });

  it('returns the base directory when no stack is given', () => {
    expect(resolveConsoleDirectory('/srv/compose', null)).toBe(path.resolve('/srv/compose'));
  });

  it('resolves a stack subdirectory below the base', () => {
    expect(resolveConsoleDirectory('/srv/compose', 'my-stack')).toBe(
      path.resolve('/srv/compose', 'my-stack'),
    );
  });

  it('rejects a sibling-prefix escape (../<base>-evil)', () => {
    // The historical bug: a bare startsWith() matched `/srv/compose-evil`
    // because it shares the `/srv/compose` prefix. The path.sep boundary
    // must reject it.
    expect(resolveConsoleDirectory('/srv/compose', '../compose-evil')).toBeNull();
  });

  it('rejects a parent-directory escape', () => {
    expect(resolveConsoleDirectory('/srv/compose', '../..')).toBeNull();
  });

  it('rejects an absolute path outside the base', () => {
    const outside = path.resolve('/etc');
    if (outside !== path.resolve('/srv/compose')) {
      expect(resolveConsoleDirectory('/srv/compose', outside)).toBeNull();
    }
  });
});

// ─── Session Audit Trail + Resize Validation ────────────────────────────────

interface FakeWs extends EventEmitter {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  ping: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
}

function makeFakeWs(): FakeWs {
  const ws = new EventEmitter() as FakeWs;
  ws.readyState = 1; // WebSocket.OPEN
  ws.send = vi.fn();
  ws.close = vi.fn();
  ws.ping = vi.fn();
  ws.terminate = vi.fn();
  return ws;
}

function makeFakePty(pid = 4242) {
  let exitCb: ((e: { exitCode: number; signal: number }) => void) | undefined;
  return {
    pid,
    onData: vi.fn(),
    onExit: vi.fn((cb: (e: { exitCode: number; signal: number }) => void) => { exitCb = cb; }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    triggerExit: (e: { exitCode: number; signal: number }) => exitCb?.(e),
  };
}

describe('HostTerminalService.spawnTerminal', () => {
  let HostTerminalService: typeof import('../services/HostTerminalService').HostTerminalService;
  let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
  let insertSpy: ReturnType<typeof vi.spyOn>;
  let spawnSpy: ReturnType<typeof vi.spyOn>;
  const audit = { username: 'admin', nodeId: 7, ipAddress: '9.9.9.9' };

  beforeAll(async () => {
    HostTerminalService = (await import('../services/HostTerminalService')).HostTerminalService;
    DatabaseService = (await import('../services/DatabaseService')).DatabaseService;
  });

  beforeEach(() => {
    HostTerminalService.activeSessions.clear();
    insertSpy = vi.spyOn(DatabaseService.getInstance(), 'insertAuditLog').mockImplementation(() => {});
    spawnSpy = vi.spyOn(pty, 'spawn');
  });

  afterEach(() => {
    insertSpy.mockRestore();
    spawnSpy.mockRestore();
  });

  it('writes an open audit row when a session starts', () => {
    spawnSpy.mockReturnValue(makeFakePty() as unknown as pty.IPty);
    const ws = makeFakeWs();
    HostTerminalService.spawnTerminal(ws as never, '/tmp', audit);

    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        username: 'admin',
        method: 'WS',
        path: '/api/system/host-console',
        status_code: 101,
        node_id: 7,
        ip_address: '9.9.9.9',
        summary: 'Opened host console session',
      }),
    );
    ws.emit('close'); // clean up the heartbeat interval
  });

  it('writes a close audit row with duration when the socket closes', () => {
    spawnSpy.mockReturnValue(makeFakePty() as unknown as pty.IPty);
    const ws = makeFakeWs();
    HostTerminalService.spawnTerminal(ws as never, '/tmp', audit);
    insertSpy.mockClear();

    ws.emit('close');

    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'WS',
        path: '/api/system/host-console',
        status_code: 200,
        summary: expect.stringMatching(/^Closed host console session \(\d+ms\)$/),
      }),
    );
  });

  it('writes exactly one close row when the PTY exits and the socket then closes', () => {
    const fakePty = makeFakePty();
    spawnSpy.mockReturnValue(fakePty as unknown as pty.IPty);
    const ws = makeFakeWs();
    HostTerminalService.spawnTerminal(ws as never, '/tmp', audit);
    insertSpy.mockClear();

    // Both cleanup triggers fire (PTY exit, then the WS close it provokes); the
    // `cleaned` guard must collapse them to a single close audit row.
    fakePty.triggerExit({ exitCode: 0, signal: 0 });
    ws.emit('close');

    const closeRows = insertSpy.mock.calls.filter(
      ([entry]: [{ summary?: string }]) => entry?.summary?.startsWith('Closed host console session'),
    );
    expect(closeRows).toHaveLength(1);
  });

  it('applies a valid resize frame and rejects malformed ones', () => {
    const fakePty = makeFakePty();
    spawnSpy.mockReturnValue(fakePty as unknown as pty.IPty);
    const ws = makeFakeWs();
    HostTerminalService.spawnTerminal(ws as never, '/tmp', audit);

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 120, rows: 40 })));
    expect(fakePty.resize).toHaveBeenCalledWith(120, 40);

    // Boundary: the max dimension is accepted, one above it is rejected.
    fakePty.resize.mockClear();
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 1000, rows: 1000 })));
    expect(fakePty.resize).toHaveBeenCalledWith(1000, 1000);

    fakePty.resize.mockClear();
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 1001, rows: 40 })));
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: -1, rows: 40 })));
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 99999, rows: 40 })));
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: '80', rows: 40 })));
    expect(fakePty.resize).not.toHaveBeenCalled();

    ws.emit('close');
  });

  it('forwards input frames to the PTY', () => {
    const fakePty = makeFakePty();
    spawnSpy.mockReturnValue(fakePty as unknown as pty.IPty);
    const ws = makeFakeWs();
    HostTerminalService.spawnTerminal(ws as never, '/tmp', audit);

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'input', payload: 'ls -la\n' })));
    expect(fakePty.write).toHaveBeenCalledWith('ls -la\n');

    ws.emit('close');
  });

  it('reports a shell-not-found error and closes when spawn throws ENOENT', () => {
    spawnSpy.mockImplementation(() => { throw new Error('spawn sh ENOENT'); });
    const ws = makeFakeWs();
    HostTerminalService.spawnTerminal(ws as never, '/tmp', audit);

    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('Shell not found'));
    expect(ws.close).toHaveBeenCalled();
    expect(HostTerminalService.activeSessions.size).toBe(0);
    expect(insertSpy).not.toHaveBeenCalled();
  });
});

// ─── Console Token RBAC ─────────────────────────────────────────────────────

describe('POST /api/system/console-token', () => {
  it('returns 401 without authentication', async () => {
    const res = await request(app).post('/api/system/console-token');
    expect(res.status).toBe(401);
  });

  it('returns 200 for admin user', async () => {
    const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });
    const res = await request(app)
      .post('/api/system/console-token')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
  });

  it('returns 403 for non-admin user (viewer role)', async () => {
    // Create a viewer user in the DB
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    const viewerHash = await bcrypt.hash('viewerpass', 1);
    db.addUser({ username: 'viewer_test', password_hash: viewerHash, role: 'viewer' });

    const token = jwt.sign({ username: 'viewer_test' }, TEST_JWT_SECRET, { expiresIn: '1m' });
    const res = await request(app)
      .post('/api/system/console-token')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('returns 403 for deployer role', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    const deployerHash = await bcrypt.hash('deployerpass', 1);
    db.addUser({ username: 'deployer_test', password_hash: deployerHash, role: 'deployer' });

    const token = jwt.sign({ username: 'deployer_test' }, TEST_JWT_SECRET, { expiresIn: '1m' });
    const res = await request(app)
      .post('/api/system/console-token')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('returns 403 for API tokens', async () => {
    // Create an API token via the admin endpoint first
    const adminToken = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });
    const createRes = await request(app)
      .post('/api/api-tokens')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'test-console-blocked', scope: 'full-admin' });
    expect(createRes.status).toBe(201);
    const apiTokenValue = createRes.body.token;

    const res = await request(app)
      .post('/api/system/console-token')
      .set('Authorization', `Bearer ${apiTokenValue}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SCOPE_DENIED');
  });
});
