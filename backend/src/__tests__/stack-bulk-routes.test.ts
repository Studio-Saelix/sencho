/**
 * Integration tests for POST /api/stacks/bulk.
 *
 * The bulk endpoint replaces the frontend's per-stack fan-out for
 * start/stop/restart/update with a single server-side request that runs the
 * lifecycle ops under bounded parallelism and returns a per-stack outcome
 * map. The endpoint reuses the per-(nodeId, stackName) lock from H-1 so a
 * stack that is already busy reports `code: stack_op_in_progress` for that
 * row instead of doubling the op.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

const {
  mockUpdateStack,
  mockGetContainersByStack,
  mockRestartContainer,
  mockStopContainer,
  mockStartContainer,
} = vi.hoisted(() => ({
  mockUpdateStack: vi.fn(),
  mockGetContainersByStack: vi.fn(),
  mockRestartContainer: vi.fn(),
  mockStopContainer: vi.fn(),
  mockStartContainer: vi.fn(),
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
        updateStack: mockUpdateStack,
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
        getContainersByStack: mockGetContainersByStack,
        restartContainer: mockRestartContainer,
        stopContainer: mockStopContainer,
        startContainer: mockStartContainer,
      }),
    },
  };
});

vi.mock('../services/FileSystemService', () => ({
  FileSystemService: {
    getInstance: () => ({
      getBaseDir: () => '/tmp/compose',
      hasComposeFile: vi.fn().mockResolvedValue(true),
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

  const { NotificationService } = await import('../services/NotificationService');
  vi.spyOn(NotificationService.getInstance(), 'dispatchAlert').mockResolvedValue(undefined);
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

beforeEach(async () => {
  mockUpdateStack.mockReset();
  mockGetContainersByStack.mockReset();
  mockRestartContainer.mockReset();
  mockStopContainer.mockReset();
  mockStartContainer.mockReset();
  mockGetContainersByStack.mockResolvedValue([{ Id: 'c1' }]);
  const { StackOpLockService } = await import('../services/StackOpLockService');
  StackOpLockService.resetForTests();
});

describe('POST /api/stacks/bulk request validation', () => {
  it('rejects an unknown action with 400', async () => {
    const res = await request(app)
      .post('/api/stacks/bulk')
      .set('Cookie', authCookie)
      .send({ action: 'reboot', stackNames: ['web'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid action/);
  });

  it('rejects an empty stackNames array', async () => {
    const res = await request(app)
      .post('/api/stacks/bulk')
      .set('Cookie', authCookie)
      .send({ action: 'restart', stackNames: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-empty array/);
  });

  it('rejects more than 100 stacks per request', async () => {
    const stackNames = Array.from({ length: 101 }, (_, i) => `stack-${i}`);
    const res = await request(app)
      .post('/api/stacks/bulk')
      .set('Cookie', authCookie)
      .send({ action: 'restart', stackNames });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/limited to 100/);
  });

  it('rejects non-string stackNames entries', async () => {
    const res = await request(app)
      .post('/api/stacks/bulk')
      .set('Cookie', authCookie)
      .send({ action: 'restart', stackNames: ['web', 42, 'api'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/array of strings/);
  });
});

describe('POST /api/stacks/bulk execution', () => {
  it('restarts three stacks and returns ok results for each', async () => {
    const res = await request(app)
      .post('/api/stacks/bulk')
      .set('Cookie', authCookie)
      .send({ action: 'restart', stackNames: ['web', 'api', 'db'] });

    expect(res.status).toBe(200);
    expect(res.body.action).toBe('restart');
    expect(res.body.results).toHaveLength(3);
    expect(res.body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    expect(mockRestartContainer).toHaveBeenCalledTimes(3);
  });

  it('reports per-stack failures without short-circuiting other stacks', async () => {
    let callCount = 0;
    mockRestartContainer.mockImplementation(() => {
      callCount += 1;
      if (callCount === 2) return Promise.reject(new Error('container crashed'));
      return Promise.resolve();
    });

    const res = await request(app)
      .post('/api/stacks/bulk')
      .set('Cookie', authCookie)
      .send({ action: 'restart', stackNames: ['web', 'api', 'db'] });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(3);
    const okResults = res.body.results.filter((r: { ok: boolean }) => r.ok);
    const failedResults = res.body.results.filter((r: { ok: boolean }) => !r.ok);
    expect(okResults).toHaveLength(2);
    expect(failedResults).toHaveLength(1);
    expect(failedResults[0].code).toBe('op_failed');
    expect(failedResults[0].error).toMatch(/container crashed/);
  });

  it('reports stack_op_in_progress when a per-stack lock is already held', async () => {
    const { StackOpLockService } = await import('../services/StackOpLockService');
    StackOpLockService.getInstance().tryAcquire(1, 'busy-stack', 'deploy', 'someone-else');

    const res = await request(app)
      .post('/api/stacks/bulk')
      .set('Cookie', authCookie)
      .send({ action: 'restart', stackNames: ['busy-stack', 'free-stack'] });

    expect(res.status).toBe(200);
    const busy = res.body.results.find((r: { stackName: string }) => r.stackName === 'busy-stack');
    const free = res.body.results.find((r: { stackName: string }) => r.stackName === 'free-stack');
    expect(busy.ok).toBe(false);
    expect(busy.code).toBe('stack_op_in_progress');
    expect(busy.error).toMatch(/already deploying/i);
    expect(free.ok).toBe(true);
  });

  it('rejects invalid stack names with code=invalid_name per-row', async () => {
    const res = await request(app)
      .post('/api/stacks/bulk')
      .set('Cookie', authCookie)
      .send({ action: 'restart', stackNames: ['..bad..', 'web'] });

    expect(res.status).toBe(200);
    const bad = res.body.results.find((r: { stackName: string }) => r.stackName === '..bad..');
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('invalid_name');
  });

  it('returns no_containers when a stack has nothing to restart', async () => {
    mockGetContainersByStack.mockResolvedValueOnce([]);
    const res = await request(app)
      .post('/api/stacks/bulk')
      .set('Cookie', authCookie)
      .send({ action: 'restart', stackNames: ['empty-stack'] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].ok).toBe(false);
    expect(res.body.results[0].code).toBe('no_containers');
  });

  it('releases each stack lock after the op finishes', async () => {
    await request(app)
      .post('/api/stacks/bulk')
      .set('Cookie', authCookie)
      .send({ action: 'restart', stackNames: ['web', 'api'] });

    const { StackOpLockService } = await import('../services/StackOpLockService');
    expect(StackOpLockService.getInstance().size()).toBe(0);
  });

  it('runs at most BULK_PARALLELISM ops concurrently', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    mockRestartContainer.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 20));
      inFlight -= 1;
    });

    const stackNames = Array.from({ length: 10 }, (_, i) => `stack-${i}`);
    const res = await request(app)
      .post('/api/stacks/bulk')
      .set('Cookie', authCookie)
      .send({ action: 'restart', stackNames });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(10);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('handles stop action by dispatching stopContainer per stack', async () => {
    const res = await request(app)
      .post('/api/stacks/bulk')
      .set('Cookie', authCookie)
      .send({ action: 'stop', stackNames: ['web'] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].ok).toBe(true);
    expect(mockStopContainer).toHaveBeenCalledTimes(1);
    expect(mockRestartContainer).not.toHaveBeenCalled();
  });

  it('handles update action (paid tier) by calling ComposeService.updateStack', async () => {
    mockUpdateStack.mockResolvedValue(undefined);
    const { LicenseService } = await import('../services/LicenseService');
    const tierSpy = vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
    try {
      const res = await request(app)
        .post('/api/stacks/bulk')
        .set('Cookie', authCookie)
        .send({ action: 'update', stackNames: ['web'] });

      expect(res.status).toBe(200);
      expect(res.body.results[0].ok).toBe(true);
      expect(mockUpdateStack).toHaveBeenCalledTimes(1);
    } finally {
      tierSpy.mockRestore();
    }
  });

  it('returns policy_blocked per-row when the policy gate rejects an update', async () => {
    const { LicenseService } = await import('../services/LicenseService');
    const policyMod = await import('../services/PolicyEnforcement');
    const tierSpy = vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
    const policySpy = vi.spyOn(policyMod, 'enforcePolicyPreDeploy').mockResolvedValue({
      ok: false,
      bypassed: false,
      policy: { id: 1, name: 'block-criticals', node_id: null, node_identity: '', stack_pattern: null, max_severity: 'HIGH', block_on_deploy: 1, enabled: 1, replicated_from_control: 0, created_at: Date.now(), updated_at: Date.now() },
      violations: [{ imageRef: 'nginx:latest', severity: 'CRITICAL', criticalCount: 3, highCount: 0, scanId: 1 }],
    });
    mockUpdateStack.mockResolvedValue(undefined);
    try {
      const res = await request(app)
        .post('/api/stacks/bulk')
        .set('Cookie', authCookie)
        .send({ action: 'update', stackNames: ['web', 'api'] });

      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(2);
      expect(res.body.results.every((r: { ok: boolean }) => !r.ok)).toBe(true);
      expect(res.body.results.every((r: { code: string }) => r.code === 'policy_blocked')).toBe(true);
      expect(mockUpdateStack).not.toHaveBeenCalled();
    } finally {
      tierSpy.mockRestore();
      policySpy.mockRestore();
    }
  });

  it('dedupes repeated stackNames before scheduling work', async () => {
    const res = await request(app)
      .post('/api/stacks/bulk')
      .set('Cookie', authCookie)
      .send({ action: 'restart', stackNames: ['web', 'web', 'web'] });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].ok).toBe(true);
    expect(mockRestartContainer).toHaveBeenCalledTimes(1);
  });

  it('does not shadow POST /:stackName/restart for a stack literally named bulk', async () => {
    // The bulk endpoint is mounted at /api/stacks/bulk (no trailing path).
    // A stack named "bulk" must still be reachable at /api/stacks/bulk/restart
    // because Express matches /:stackName/restart there, not the bulk handler.
    const res = await request(app)
      .post('/api/stacks/bulk/restart')
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(mockRestartContainer).toHaveBeenCalledTimes(1);
    expect(res.body.success).toBe(true);
  });

  it('allows the update action on the community tier (bulk ops are free)', async () => {
    const { LicenseService } = await import('../services/LicenseService');
    const tierSpy = vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
    try {
      const res = await request(app)
        .post('/api/stacks/bulk')
        .set('Cookie', authCookie)
        .send({ action: 'update', stackNames: ['web'] });

      expect(res.status).toBe(200);
      expect(mockUpdateStack).toHaveBeenCalled();
    } finally {
      tierSpy.mockRestore();
    }
  });
});
