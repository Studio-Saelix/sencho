/**
 * Route tests for POST /api/stacks/:name/down and optional ?removeVolumes=true.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import { generateApiToken } from '../utils/apiTokenFormat';
import {
  disableCapability,
  enableCapability,
  STACK_DOWN_REMOVE_VOLUMES_CAPABILITY,
} from '../services/CapabilityRegistry';

const { mockRunDown } = vi.hoisted(() => ({
  mockRunDown: vi.fn(),
}));

vi.mock('../services/ComposeService', async () => {
  const actual = await vi.importActual<typeof import('../services/ComposeService')>(
    '../services/ComposeService',
  );
  return {
    ...actual,
    ComposeService: {
      ...actual.ComposeService,
      getInstance: () => ({
        runDown: mockRunDown,
      }),
    },
  };
});

let tmpDir: string;
let app: import('express').Express;
let authCookie: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

function writeStack(name: string) {
  const dir = path.join(process.env.COMPOSE_DIR!, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');
}

function createDeployOnlyToken(): string {
  const rawToken = generateApiToken();
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const db = DatabaseService.getInstance();
  db.addApiToken({
    token_hash: tokenHash,
    name: `deploy-only-down-${Date.now()}`,
    scope: 'deploy-only',
    user_id: db.getUserByUsername('testadmin')!.id,
    created_at: Date.now(),
    expires_at: null,
  });
  return rawToken;
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ app } = await import('../index'));
  authCookie = await loginAsTestAdmin(app);
  writeStack('web');

  const { NotificationService } = await import('../services/NotificationService');
  vi.spyOn(NotificationService.getInstance(), 'dispatchAlert').mockResolvedValue(undefined);
});

afterAll(() => {
  vi.restoreAllMocks();
  enableCapability(STACK_DOWN_REMOVE_VOLUMES_CAPABILITY);
  cleanupTestDb(tmpDir);
});

beforeEach(async () => {
  mockRunDown.mockReset();
  mockRunDown.mockResolvedValue(undefined);
  enableCapability(STACK_DOWN_REMOVE_VOLUMES_CAPABILITY);
  const { StackOpLockService } = await import('../services/StackOpLockService');
  StackOpLockService.resetForTests();
});

describe('POST /api/stacks/:name/down removeVolumes', () => {
  it('runs plain down when removeVolumes is omitted', async () => {
    const res = await request(app)
      .post('/api/stacks/web/down')
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(mockRunDown).toHaveBeenCalledWith('web', { removeVolumes: false }, undefined);
  });

  it('runs plain down when removeVolumes=false', async () => {
    const res = await request(app)
      .post('/api/stacks/web/down?removeVolumes=false')
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(mockRunDown).toHaveBeenCalledWith('web', { removeVolumes: false }, undefined);
  });

  it('does not enable volumes when removeVolumes=1 (only exact true)', async () => {
    const res = await request(app)
      .post('/api/stacks/web/down?removeVolumes=1')
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(mockRunDown).toHaveBeenCalledWith('web', { removeVolumes: false }, undefined);
  });

  it('returns 400 when removeVolumes=true but capability is absent locally', async () => {
    disableCapability(STACK_DOWN_REMOVE_VOLUMES_CAPABILITY);

    const res = await request(app)
      .post('/api/stacks/web/down?removeVolumes=true')
      .set('Cookie', authCookie);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not supported/i);
    expect(mockRunDown).not.toHaveBeenCalled();
  });

  it('passes removeVolumes=true to runDown when capability is present', async () => {
    const res = await request(app)
      .post('/api/stacks/web/down?removeVolumes=true')
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(mockRunDown).toHaveBeenCalledWith('web', { removeVolumes: true }, undefined);
  });

  it('allows deploy-only API tokens to POST /down?removeVolumes=true', async () => {
    const token = createDeployOnlyToken();
    const res = await request(app)
      .post('/api/stacks/web/down?removeVolumes=true')
      .set('Authorization', `Bearer ${token}`);

    expect(res.body.code).not.toBe('SCOPE_DENIED');
    expect(res.status).toBe(200);
    expect(mockRunDown).toHaveBeenCalledWith('web', { removeVolumes: true }, undefined);
  });
});
