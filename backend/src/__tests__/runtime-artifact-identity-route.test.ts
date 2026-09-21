/**
 * Route tests for GET /api/stacks/:stackName/runtime-artifact-identity:
 * auth, missing-stack 404, and Community reachability.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

const mockObserve = vi.fn();

vi.mock('../services/gitops/artifactResolve', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/gitops/artifactResolve')>();
  return {
    ...actual,
    observeStackRuntimeArtifact: (...args: unknown[]) => mockObserve(...args),
  };
});

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;
let LicenseService: typeof import('../services/LicenseService').LicenseService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ LicenseService } = await import('../services/LicenseService'));
  const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });
  authHeader = `Bearer ${token}`;
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

describe('GET /api/stacks/:stackName/runtime-artifact-identity', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/stacks/myapp/runtime-artifact-identity');
    expect(res.status).toBe(401);
  });

  it('returns 404 for an unknown stack on Community (not 403)', async () => {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
    const res = await request(app)
      .get('/api/stacks/myapp/runtime-artifact-identity')
      .set('Authorization', authHeader);
    expect(res.status).toBe(404);
    vi.restoreAllMocks();
  });

  it('returns the observed identity for an existing stack', async () => {
    const composeDir = process.env.COMPOSE_DIR as string;
    const stackDir = path.join(composeDir, 'runtimearttest');
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx:1.27\n');

    mockObserve.mockResolvedValue({
      kind: 'exact',
      identity: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      observedAt: 1_700_000_000_000,
    });

    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
    const res = await request(app)
      .get('/api/stacks/runtimearttest/runtime-artifact-identity')
      .set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      kind: 'exact',
      identity: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      observedAt: 1_700_000_000_000,
    });
    expect(mockObserve).toHaveBeenCalledWith(
      expect.objectContaining({ stackName: 'runtimearttest' }),
    );

    vi.restoreAllMocks();
    mockObserve.mockReset();
    fs.rmSync(stackDir, { recursive: true, force: true });
  });
});
