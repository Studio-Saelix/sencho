/**
 * Route tests for GET /api/stacks/:stackName/effective-artifact-context:
 * auth, missing-stack 404, and leaf context shape.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

const mockLoadContext = vi.fn();

vi.mock('../services/gitops/effectiveArtifactContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/gitops/effectiveArtifactContext')>();
  return {
    ...actual,
    loadEffectiveArtifactContext: (...args: unknown[]) => mockLoadContext(...args),
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

describe('GET /api/stacks/:stackName/effective-artifact-context', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/stacks/myapp/effective-artifact-context');
    expect(res.status).toBe(401);
  });

  it('returns 404 for an unknown stack', async () => {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
    const res = await request(app)
      .get('/api/stacks/myapp/effective-artifact-context')
      .set('Authorization', authHeader);
    expect(res.status).toBe(404);
    vi.restoreAllMocks();
  });

  it('returns the leaf rendered model and platform', async () => {
    const composeDir = process.env.COMPOSE_DIR as string;
    const stackDir = path.join(composeDir, 'effartctx');
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx:1.27\n');

    mockLoadContext.mockResolvedValue({
      renderable: true,
      platform: { os: 'linux', architecture: 'amd64' },
      services: [{
        name: 'web',
        declaredImage: 'nginx:1.27',
        hasBuild: false,
        expectedReplicas: 1,
        dependsOn: [],
        hasHealthcheck: false,
      }],
    });

    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
    const res = await request(app)
      .get('/api/stacks/effartctx/effective-artifact-context')
      .set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      renderable: true,
      platform: { os: 'linux', architecture: 'amd64' },
      services: [expect.objectContaining({ name: 'web', declaredImage: 'nginx:1.27' })],
    });
    expect(mockLoadContext).toHaveBeenCalledWith(expect.any(Number), 'effartctx');

    vi.restoreAllMocks();
    mockLoadContext.mockReset();
    fs.rmSync(stackDir, { recursive: true, force: true });
  });
});
