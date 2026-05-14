import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_JWT_SECRET, TEST_USERNAME } from './helpers/setupTestDb';

const {
  mockCreateStackFromGit,
  mockDeployStack,
  mockGetStacks,
  mockListContainers,
  mockIsTrivyAvailable,
  mockGetImageDigest,
  mockRunScanAndPersist,
} = vi.hoisted(() => ({
  mockCreateStackFromGit: vi.fn(),
  mockDeployStack: vi.fn(),
  mockGetStacks: vi.fn(),
  mockListContainers: vi.fn(),
  mockIsTrivyAvailable: vi.fn(),
  mockGetImageDigest: vi.fn(),
  mockRunScanAndPersist: vi.fn(),
}));

vi.mock('../services/FileSystemService', () => ({
  FileSystemService: {
    getInstance: () => ({
      getStacks: mockGetStacks,
    }),
  },
}));

vi.mock('../services/GitSourceService', async () => {
  const actual = await vi.importActual<typeof import('../services/GitSourceService')>(
    '../services/GitSourceService',
  );
  return {
    ...actual,
    GitSourceService: {
      getInstance: () => ({
        createStackFromGit: mockCreateStackFromGit,
      }),
    },
  };
});

vi.mock('../services/ComposeService', async () => {
  const actual = await vi.importActual<typeof import('../services/ComposeService')>(
    '../services/ComposeService',
  );
  return {
    ...actual,
    ComposeService: {
      getInstance: () => ({
        deployStack: mockDeployStack,
      }),
    },
  };
});

vi.mock('../services/DockerController', async () => {
  const actual = await vi.importActual<typeof import('../services/DockerController')>(
    '../services/DockerController',
  );
  return {
    ...actual,
    default: {
      ...actual.default,
      getInstance: () => ({
        getDocker: () => ({
          listContainers: mockListContainers,
        }),
      }),
    },
  };
});

vi.mock('../services/TrivyService', async () => {
  const actual = await vi.importActual<typeof import('../services/TrivyService')>(
    '../services/TrivyService',
  );
  return {
    ...actual,
    default: {
      ...actual.default,
      getInstance: () => ({
        isTrivyAvailable: mockIsTrivyAvailable,
        getImageDigest: mockGetImageDigest,
        runScanAndPersist: mockRunScanAndPersist,
      }),
    },
  };
});

let tmpDir: string;
let app: import('express').Express;

function adminToken(): string {
  return jwt.sign({ username: TEST_USERNAME, role: 'admin' }, TEST_JWT_SECRET, { expiresIn: '1m' });
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  mockCreateStackFromGit.mockReset();
  mockDeployStack.mockReset();
  mockGetStacks.mockReset();
  mockListContainers.mockReset();
  mockIsTrivyAvailable.mockReset();
  mockGetImageDigest.mockReset();
  mockRunScanAndPersist.mockReset();

  mockGetStacks.mockResolvedValue([]);
  mockCreateStackFromGit.mockResolvedValue({
    source: { stackName: 'route-from-git', repoUrl: 'https://github.com/example/repo.git' },
    commitSha: 'abcdef1234567890',
    envWritten: false,
    warnings: [],
  });
  mockDeployStack.mockResolvedValue(undefined);
  mockIsTrivyAvailable.mockReturnValue(true);
  mockListContainers.mockResolvedValue([{ Image: 'nginx:latest' }]);
  mockGetImageDigest.mockResolvedValue(null);
  mockRunScanAndPersist.mockResolvedValue({ critical_count: 0, high_count: 0 });
});

describe('POST /api/stacks/from-git scan opt-out', () => {
  it('does not trigger a post-deploy scan when deploy_now and skip_scan are true', async () => {
    const res = await request(app)
      .post('/api/stacks/from-git')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        stack_name: 'route-from-git',
        repo_url: 'https://github.com/example/repo.git',
        branch: 'main',
        compose_path: 'compose.yaml',
        auth_type: 'none',
        deploy_now: true,
        skip_scan: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.deployed).toBe(true);
    await new Promise(resolve => setImmediate(resolve));
    expect(mockListContainers).not.toHaveBeenCalled();
    expect(mockRunScanAndPersist).not.toHaveBeenCalled();
  });
});
