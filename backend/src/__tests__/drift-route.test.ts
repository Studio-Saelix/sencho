/**
 * Route tests for the per-stack drift endpoint: auth enforcement and that the
 * read-only report is reachable on the Community tier (no tier gate). Deep diff
 * behaviour is covered by drift-detection.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import DockerController from '../services/DockerController';

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

describe('GET /api/stacks/:stackName/drift', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/stacks/myapp/drift');
    expect(res.status).toBe(401);
  });

  it('is reachable on the Community tier (404 for an unknown stack, not 403)', async () => {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
    const res = await request(app).get('/api/stacks/myapp/drift').set('Authorization', authHeader);
    expect(res.status).toBe(404);
    vi.restoreAllMocks();
  });

  it('returns 200 with a report for an existing stack on the Community tier', async () => {
    const composeDir = process.env.COMPOSE_DIR as string;
    const stackDir = path.join(composeDir, 'driftroutetest');
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx:1.27\n');

    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
    // Stub only the Docker boundary so the test is deterministic and daemon-free;
    // the route, requireStackExists, compose parse, and the diff all run for real.
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDependencySnapshot: vi.fn().mockResolvedValue({ containers: [], networks: [], volumes: [] }),
    } as unknown as DockerController);

    const res = await request(app).get('/api/stacks/driftroutetest/drift').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stack: 'driftroutetest', status: 'missing-runtime' });
    expect(Array.isArray(res.body.findings)).toBe(true);

    vi.restoreAllMocks();
    fs.rmSync(stackDir, { recursive: true, force: true });
  });
});
