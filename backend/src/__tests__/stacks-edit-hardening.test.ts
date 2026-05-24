import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

const {
  mockGetContainersByStack,
  mockGetStackContent,
} = vi.hoisted(() => ({
  mockGetContainersByStack: vi.fn(),
  mockGetStackContent: vi.fn(),
}));

vi.mock('../services/DockerController', async () => {
  const actual = await vi.importActual<typeof import('../services/DockerController')>(
    '../services/DockerController',
  );
  return {
    ...actual,
    default: {
      ...actual.default,
      getInstance: () => ({
        getContainersByStack: mockGetContainersByStack,
      }),
    },
  };
});

vi.mock('../services/FileSystemService', () => ({
  FileSystemService: {
    getInstance: () => ({
      getStacks: vi.fn().mockResolvedValue([]),
      getBaseDir: () => '/tmp/compose',
      hasComposeFile: vi.fn().mockResolvedValue(true),
      getStackContent: mockGetStackContent,
    }),
  },
}));

let tmpDir: string;
let app: import('express').Express;
let authCookie: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authCookie = await loginAsTestAdmin(app);
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  mockGetContainersByStack.mockReset();
  mockGetStackContent.mockReset();
});

describe('GET /:stackName/containers — input validation', () => {
  it('returns 400 for a stackName containing path traversal', async () => {
    const res = await request(app)
      .get('/api/stacks/..%2Fetc%2Fpasswd/containers')
      .set('Cookie', authCookie);
    expect(res.status).toBe(400);
    expect(mockGetContainersByStack).not.toHaveBeenCalled();
  });

  it('passes a valid stackName through to the DockerController', async () => {
    mockGetContainersByStack.mockResolvedValue([]);
    const res = await request(app)
      .get('/api/stacks/myapp/containers')
      .set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(mockGetContainersByStack).toHaveBeenCalledWith('myapp');
  });
});

describe('GET /:stackName/services — YAML parse size guard', () => {
  it('returns 413 when the compose file exceeds the parse cap', async () => {
    // 1 MiB cap; produce 1 MiB + 1 byte of content.
    mockGetStackContent.mockResolvedValue('x'.repeat(1_048_577));
    const res = await request(app)
      .get('/api/stacks/myapp/services')
      .set('Cookie', authCookie);
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/too large/i);
  });

  it('parses a small compose file normally', async () => {
    mockGetStackContent.mockResolvedValue('services:\n  web:\n    image: nginx\n');
    const res = await request(app)
      .get('/api/stacks/myapp/services')
      .set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(['web']);
  });
});
