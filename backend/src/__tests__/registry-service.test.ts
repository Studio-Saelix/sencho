/**
 * Unit tests for RegistryService.
 *
 * Covers:
 * - URL normalization (Docker Hub legacy form, protocol stripping, trailing slash)
 * - Encrypt/decrypt round-trip via create + resolveDockerConfig
 * - Update preserving secret when empty
 * - Exact-host matching in getAuthForRegistry (no substring leaks)
 * - resolveDockerConfig warnings path on decryption failure
 * - ECR token cache hit/miss/TTL
 * - testWithCredentials: 200 direct, 401 with challenge, 401 without challenge,
 *   network error, and ECR success/failure
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

// ── Hoisted mocks ──────────────────────────────────────────────────────

const { mockHttpsGet, mockHttpGet, mockEcrSend } = vi.hoisted(() => ({
  mockHttpsGet: vi.fn(),
  mockHttpGet: vi.fn(),
  mockEcrSend: vi.fn(),
}));

vi.mock('https', () => ({
  default: { get: mockHttpsGet },
  get: mockHttpsGet,
}));

vi.mock('http', () => ({
  default: { get: mockHttpGet },
  get: mockHttpGet,
}));

vi.mock('@aws-sdk/client-ecr', () => {
  class MockECRClient {
    send = mockEcrSend;
  }
  class MockGetAuthorizationTokenCommand {
    input: unknown;
    constructor(input: unknown) { this.input = input; }
  }
  return {
    ECRClient: MockECRClient,
    GetAuthorizationTokenCommand: MockGetAuthorizationTokenCommand,
  };
});

let tmpDir: string;
let RegistryService: typeof import('../services/RegistryService').RegistryService;
let normalizeRegistryUrl: typeof import('../services/RegistryService').normalizeRegistryUrl;
let dockerConfigKeyForHost: typeof import('../services/RegistryService').dockerConfigKeyForHost;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ RegistryService, normalizeRegistryUrl, dockerConfigKeyForHost } = await import('../services/RegistryService'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  // Reset HTTP mocks between tests
  mockHttpsGet.mockReset();
  mockHttpGet.mockReset();
  mockEcrSend.mockReset();
  // Wipe any persisted registries between tests
  const db = DatabaseService.getInstance();
  for (const r of db.getRegistries()) db.deleteRegistry(r.id);
  // Reset ECR cache
  RegistryService.getInstance().invalidateEcrCache();
});

/**
 * Build a fake IncomingMessage-like object that the real httpGet helper in
 * RegistryService can consume via `https.get(url, { headers }, cb)`.
 */
function mockHttpResponse(
  statusCode: number,
  headers: Record<string, string | undefined> = {},
  body = '',
) {
  return (_url: string, _opts: unknown, cb: (res: EventEmitter & Record<string, unknown>) => void) => {
    const res = new EventEmitter() as EventEmitter & Record<string, unknown>;
    res.statusCode = statusCode;
    res.headers = headers;
    res.resume = () => undefined;
    setImmediate(() => {
      cb(res);
      if (body) res.emit('data', Buffer.from(body));
      res.emit('end');
    });
    const req = new EventEmitter() as EventEmitter & { setTimeout: (ms: number, cb: () => void) => void; destroy: (e?: Error) => void };
    req.setTimeout = () => undefined;
    req.destroy = () => undefined;
    return req;
  };
}

function mockNetworkError(message: string) {
  return (_url: string, _opts: unknown, _cb: unknown) => {
    const req = new EventEmitter() as EventEmitter & { setTimeout: (ms: number, cb: () => void) => void; destroy: (e?: Error) => void };
    req.setTimeout = () => undefined;
    req.destroy = () => undefined;
    setImmediate(() => req.emit('error', new Error(message)));
    return req;
  };
}

// ── normalizeRegistryUrl ───────────────────────────────────────────────

describe('normalizeRegistryUrl', () => {
  it('returns the legacy Docker Hub v1 URL regardless of input', () => {
    expect(normalizeRegistryUrl('anything', 'dockerhub')).toBe('https://index.docker.io/v1/');
    expect(normalizeRegistryUrl('https://hub.docker.com', 'dockerhub')).toBe('https://index.docker.io/v1/');
    expect(normalizeRegistryUrl('', 'dockerhub')).toBe('https://index.docker.io/v1/');
  });

  it('strips protocol and trailing slashes for non-dockerhub types', () => {
    expect(normalizeRegistryUrl('https://ghcr.io', 'ghcr')).toBe('ghcr.io');
    expect(normalizeRegistryUrl('https://ghcr.io/', 'ghcr')).toBe('ghcr.io');
    expect(normalizeRegistryUrl('http://registry.local:5000/', 'custom')).toBe('registry.local:5000');
    expect(normalizeRegistryUrl('ghcr.io///', 'ghcr')).toBe('ghcr.io');
  });

  it('normalizes ECR hostnames', () => {
    expect(normalizeRegistryUrl('https://123.dkr.ecr.us-east-1.amazonaws.com', 'ecr'))
      .toBe('123.dkr.ecr.us-east-1.amazonaws.com');
  });
});

// ── dockerConfigKeyForHost ─────────────────────────────────────────────

describe('dockerConfigKeyForHost', () => {
  it('maps Docker Hub aliases to the legacy v1 auths key', () => {
    expect(dockerConfigKeyForHost('index.docker.io')).toBe('https://index.docker.io/v1/');
    expect(dockerConfigKeyForHost('docker.io')).toBe('https://index.docker.io/v1/');
    expect(dockerConfigKeyForHost('registry-1.docker.io')).toBe('https://index.docker.io/v1/');
    expect(dockerConfigKeyForHost('DOCKER.IO')).toBe('https://index.docker.io/v1/');
    expect(dockerConfigKeyForHost('')).toBe('https://index.docker.io/v1/');
  });

  it('passes non-Hub hosts through in normalized form', () => {
    expect(dockerConfigKeyForHost('ghcr.io')).toBe('ghcr.io');
    expect(dockerConfigKeyForHost('GHCR.IO')).toBe('ghcr.io');
    expect(dockerConfigKeyForHost('registry.local:5000')).toBe('registry.local:5000');
  });
});

// ── CRUD + encrypt round-trip ──────────────────────────────────────────

describe('RegistryService - CRUD', () => {
  it('encrypts secrets on create and round-trips via resolveDockerConfig', async () => {
    const svc = RegistryService.getInstance();
    svc.create({
      name: 'ghcr',
      url: 'https://ghcr.io',
      type: 'ghcr',
      username: 'alice',
      secret: 'supersecrettoken',
    });

    const raw = DatabaseService.getInstance().getRegistries()[0];
    expect(raw.secret).not.toBe('supersecrettoken');
    expect(raw.secret.startsWith('enc:')).toBe(true);
    expect(raw.url).toBe('ghcr.io');

    const { config, warnings } = await svc.resolveDockerConfig();
    expect(warnings).toEqual([]);
    const expectedAuth = Buffer.from('alice:supersecrettoken').toString('base64');
    expect(config.auths['ghcr.io']).toEqual({ auth: expectedAuth });
  });

  it('keys Docker Hub under the legacy v1 auths key', async () => {
    const svc = RegistryService.getInstance();
    svc.create({
      name: 'hub',
      url: '',
      type: 'dockerhub',
      username: 'bob',
      secret: 'hubpass',
    });

    const { config } = await svc.resolveDockerConfig();
    expect(config.auths['https://index.docker.io/v1/']).toBeDefined();
  });

  it('keys a single-host Docker Hub resolution under the legacy v1 auths key', async () => {
    const svc = RegistryService.getInstance();
    svc.create({
      name: 'hub-single',
      url: '',
      type: 'dockerhub',
      username: 'carol',
      secret: 'singlepass',
    });

    const { config } = await svc.resolveDockerConfigForHost('index.docker.io');
    expect(config.auths['https://index.docker.io/v1/']).toEqual({
      auth: Buffer.from('carol:singlepass').toString('base64'),
    });
    expect(config.auths['index.docker.io']).toBeUndefined();
  });

  it('update with empty secret preserves the existing secret', async () => {
    const svc = RegistryService.getInstance();
    const id = svc.create({
      name: 'ghcr',
      url: 'ghcr.io',
      type: 'ghcr',
      username: 'alice',
      secret: 'original-secret',
    });

    svc.update(id, { name: 'renamed', secret: '' });

    const { config } = await svc.resolveDockerConfig();
    const expectedAuth = Buffer.from('alice:original-secret').toString('base64');
    expect(config.auths['ghcr.io']).toEqual({ auth: expectedAuth });
    expect(DatabaseService.getInstance().getRegistry(id)!.name).toBe('renamed');
  });

  it('update with a new secret replaces the old one', async () => {
    const svc = RegistryService.getInstance();
    const id = svc.create({
      name: 'ghcr',
      url: 'ghcr.io',
      type: 'ghcr',
      username: 'alice',
      secret: 'old',
    });

    svc.update(id, { secret: 'new-secret' });

    const { config } = await svc.resolveDockerConfig();
    const expectedAuth = Buffer.from('alice:new-secret').toString('base64');
    expect(config.auths['ghcr.io']).toEqual({ auth: expectedAuth });
  });

  it('getAll omits the secret field and exposes has_secret', () => {
    const svc = RegistryService.getInstance();
    svc.create({
      name: 'ghcr',
      url: 'ghcr.io',
      type: 'ghcr',
      username: 'alice',
      secret: 'x',
    });

    const all = svc.getAll();
    expect(all[0].has_secret).toBe(true);
    expect((all[0] as unknown as { secret?: string }).secret).toBeUndefined();
  });
});

// ── getAuthForRegistry ─────────────────────────────────────────────────

describe('RegistryService - getAuthForRegistry', () => {
  it('matches on exact host (case-insensitive)', async () => {
    const svc = RegistryService.getInstance();
    svc.create({ name: 'ghcr', url: 'ghcr.io', type: 'ghcr', username: 'alice', secret: 'x' });

    const hit = await svc.getAuthForRegistry('GHCR.IO');
    expect(hit).toEqual({ username: 'alice', password: 'x' });
  });

  it('maps docker.io and registry-1.docker.io to the Docker Hub credential', async () => {
    const svc = RegistryService.getInstance();
    svc.create({ name: 'hub', url: '', type: 'dockerhub', username: 'bob', secret: 'pw' });

    expect(await svc.getAuthForRegistry('docker.io')).toEqual({ username: 'bob', password: 'pw' });
    expect(await svc.getAuthForRegistry('registry-1.docker.io')).toEqual({ username: 'bob', password: 'pw' });
    expect(await svc.getAuthForRegistry('index.docker.io')).toEqual({ username: 'bob', password: 'pw' });
  });

  it('does NOT match overlapping substrings (the old bidirectional-includes bug)', async () => {
    const svc = RegistryService.getInstance();
    // Stored: my-ghcr.io.internal. A lookup for ghcr.io must NOT match.
    svc.create({
      name: 'internal',
      url: 'my-ghcr.io.internal',
      type: 'custom',
      username: 'alice',
      secret: 'x',
    });

    expect(await svc.getAuthForRegistry('ghcr.io')).toBeNull();
  });

  it('returns null when no registry matches', async () => {
    const svc = RegistryService.getInstance();
    expect(await svc.getAuthForRegistry('ghcr.io')).toBeNull();
  });
});

// ── resolveDockerConfig warnings ───────────────────────────────────────

describe('RegistryService - resolveDockerConfig warnings', () => {
  it('returns a warning (not a throw) when a stored secret cannot be decrypted', async () => {
    const svc = RegistryService.getInstance();
    svc.create({ name: 'ghcr', url: 'ghcr.io', type: 'ghcr', username: 'alice', secret: 'x' });

    // Corrupt the stored secret so decryption fails.
    DatabaseService.getInstance().updateRegistry(
      DatabaseService.getInstance().getRegistries()[0].id,
      { secret: 'enc:not-real-ciphertext' },
    );

    const { config, warnings } = await svc.resolveDockerConfig();
    expect(Object.keys(config.auths)).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('credentials unavailable');
  });

  it('returns empty warnings when all registries decrypt cleanly', async () => {
    const svc = RegistryService.getInstance();
    svc.create({ name: 'ghcr', url: 'ghcr.io', type: 'ghcr', username: 'alice', secret: 'x' });
    svc.create({ name: 'custom', url: 'my.registry', type: 'custom', username: 'bob', secret: 'y' });

    const { warnings } = await svc.resolveDockerConfig();
    expect(warnings).toEqual([]);
  });
});

// ── testWithCredentials (non-ECR) ──────────────────────────────────────

describe('RegistryService - testWithCredentials', () => {
  it('returns success on HTTP 200 from /v2/', async () => {
    mockHttpsGet.mockImplementation(mockHttpResponse(200, {}, 'ok'));

    const svc = RegistryService.getInstance();
    const res = await svc.testWithCredentials({
      type: 'custom',
      url: 'registry.example.com',
      username: 'u',
      secret: 's',
    });

    expect(res.success).toBe(true);
    expect(mockHttpsGet).toHaveBeenCalled();
  });

  it('follows a 401 + Bearer challenge to the realm URL', async () => {
    mockHttpsGet
      .mockImplementationOnce(mockHttpResponse(401, {
        'www-authenticate': 'Bearer realm="https://auth.example.com/token",service="registry"',
      }))
      .mockImplementationOnce(mockHttpResponse(200, {}, '{"token":"t"}'));

    const svc = RegistryService.getInstance();
    const res = await svc.testWithCredentials({
      type: 'custom',
      url: 'registry.example.com',
      username: 'u',
      secret: 's',
    });

    expect(res.success).toBe(true);
    expect(mockHttpsGet).toHaveBeenCalledTimes(2);
  });

  it('fails when 401 has no auth challenge header', async () => {
    mockHttpsGet.mockImplementation(mockHttpResponse(401, {}));

    const svc = RegistryService.getInstance();
    const res = await svc.testWithCredentials({
      type: 'custom',
      url: 'registry.example.com',
      username: 'u',
      secret: 's',
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain('401');
  });

  it('fails when the token exchange returns non-200', async () => {
    mockHttpsGet
      .mockImplementationOnce(mockHttpResponse(401, {
        'www-authenticate': 'Bearer realm="https://auth.example.com/token"',
      }))
      .mockImplementationOnce(mockHttpResponse(403));

    const svc = RegistryService.getInstance();
    const res = await svc.testWithCredentials({
      type: 'custom',
      url: 'registry.example.com',
      username: 'u',
      secret: 's',
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain('403');
  });

  it('surfaces transport errors cleanly', async () => {
    mockHttpsGet.mockImplementation(mockNetworkError('ENOTFOUND registry.example.com'));

    const svc = RegistryService.getInstance();
    const res = await svc.testWithCredentials({
      type: 'custom',
      url: 'registry.example.com',
      username: 'u',
      secret: 's',
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain('ENOTFOUND');
  });

  it('rejects ECR credentials without an aws_region', async () => {
    const svc = RegistryService.getInstance();
    const res = await svc.testWithCredentials({
      type: 'ecr',
      url: '123.dkr.ecr.us-east-1.amazonaws.com',
      username: 'AKIA',
      secret: 'secret',
    });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/region/i);
  });

  it('returns success on ECR when GetAuthorizationTokenCommand resolves', async () => {
    const token = Buffer.from('AWS:supersecretpassword').toString('base64');
    mockEcrSend.mockResolvedValue({
      authorizationData: [{ authorizationToken: token, expiresAt: new Date(Date.now() + 12 * 3600 * 1000) }],
    });

    const svc = RegistryService.getInstance();
    const res = await svc.testWithCredentials({
      type: 'ecr',
      url: '123.dkr.ecr.us-east-1.amazonaws.com',
      username: 'AKIA',
      secret: 'secret',
      aws_region: 'us-east-1',
    });

    expect(res.success).toBe(true);
    expect(mockEcrSend).toHaveBeenCalled();
  });

  it('rejects malformed ECR authorization tokens', async () => {
    // Token with no colon separator
    const bad = Buffer.from('nocolonhere').toString('base64');
    mockEcrSend.mockResolvedValue({
      authorizationData: [{ authorizationToken: bad, expiresAt: new Date(Date.now() + 3600 * 1000) }],
    });

    const svc = RegistryService.getInstance();
    const res = await svc.testWithCredentials({
      type: 'ecr',
      url: '123.dkr.ecr.us-east-1.amazonaws.com',
      username: 'AKIA',
      secret: 'secret',
      aws_region: 'us-east-1',
    });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/malformed/i);
  });

  it('propagates ECR SDK errors', async () => {
    mockEcrSend.mockRejectedValue(new Error('InvalidSignatureException'));

    const svc = RegistryService.getInstance();
    const res = await svc.testWithCredentials({
      type: 'ecr',
      url: '123.dkr.ecr.us-east-1.amazonaws.com',
      username: 'AKIA',
      secret: 'bad',
      aws_region: 'us-east-1',
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain('InvalidSignatureException');
  });
});

// ── ECR token cache ────────────────────────────────────────────────────

describe('RegistryService - ECR token cache', () => {
  function seedEcrRegistry() {
    return RegistryService.getInstance().create({
      name: 'ecr',
      url: '123.dkr.ecr.us-east-1.amazonaws.com',
      type: 'ecr',
      username: 'AKIA',
      secret: 'secret',
      aws_region: 'us-east-1',
    });
  }

  it('fetches on first resolveDockerConfig call and caches on subsequent ones', async () => {
    seedEcrRegistry();
    const token = Buffer.from('AWS:pw').toString('base64');
    mockEcrSend.mockResolvedValue({
      authorizationData: [{ authorizationToken: token, expiresAt: new Date(Date.now() + 12 * 3600 * 1000) }],
    });

    const svc = RegistryService.getInstance();
    await svc.resolveDockerConfig();
    await svc.resolveDockerConfig();

    expect(mockEcrSend).toHaveBeenCalledTimes(1);
  });

  it('refetches when the cached token is within the safety window of expiry', async () => {
    seedEcrRegistry();
    const token = Buffer.from('AWS:pw').toString('base64');
    // Expires in 4 minutes; safety window is 5 minutes, so this counts as expired.
    mockEcrSend
      .mockResolvedValueOnce({ authorizationData: [{ authorizationToken: token, expiresAt: new Date(Date.now() + 4 * 60 * 1000) }] })
      .mockResolvedValueOnce({ authorizationData: [{ authorizationToken: token, expiresAt: new Date(Date.now() + 12 * 3600 * 1000) }] });

    const svc = RegistryService.getInstance();
    await svc.resolveDockerConfig();
    await svc.resolveDockerConfig();

    expect(mockEcrSend).toHaveBeenCalledTimes(2);
  });

  it('invalidates the cache when the registry is updated', async () => {
    const id = seedEcrRegistry();
    const token = Buffer.from('AWS:pw').toString('base64');
    mockEcrSend.mockResolvedValue({
      authorizationData: [{ authorizationToken: token, expiresAt: new Date(Date.now() + 12 * 3600 * 1000) }],
    });

    const svc = RegistryService.getInstance();
    await svc.resolveDockerConfig();
    svc.update(id, { username: 'AKIA2' });
    await svc.resolveDockerConfig();

    expect(mockEcrSend).toHaveBeenCalledTimes(2);
  });

  it('returns a warning when an ECR registry is missing aws_region', async () => {
    const id = RegistryService.getInstance().create({
      name: 'ecr',
      url: '123.dkr.ecr.us-east-1.amazonaws.com',
      type: 'ecr',
      username: 'AKIA',
      secret: 'secret',
      aws_region: 'us-east-1',
    });
    // Simulate a broken row where aws_region was lost.
    DatabaseService.getInstance().updateRegistry(id, { aws_region: null });

    const { warnings, config } = await RegistryService.getInstance().resolveDockerConfig();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/aws_region|region/i);
    expect(Object.keys(config.auths)).toHaveLength(0);
  });
});
