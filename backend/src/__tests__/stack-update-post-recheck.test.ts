/**
 * Manual POST /api/stacks/:name/update must start the health gate before
 * registry recheck, never blind-clear update status, and keep Compose success
 * as HTTP 200 even when recheck throws.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import { UPDATE_DIGEST_UNCHANGED_WARNING } from '../services/ImageUpdateService';

const {
  mockExecute,
  mockRecheckStack,
  mockBeginStack,
  mockClearStackUpdateStatus,
  mockBroadcastEvent,
  mockDispatchAlert,
} = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockRecheckStack: vi.fn(),
  mockBeginStack: vi.fn(),
  mockClearStackUpdateStatus: vi.fn(),
  mockBroadcastEvent: vi.fn(),
  mockDispatchAlert: vi.fn(),
}));

vi.mock('../services/StackUpdateOrchestrator', () => ({
  StackUpdateOrchestrator: {
    getInstance: () => ({ execute: mockExecute }),
  },
  shortImageId: (id: string) => id.slice(0, 12),
}));

vi.mock('../services/ImageUpdateService', async () => {
  const actual = await vi.importActual<typeof import('../services/ImageUpdateService')>(
    '../services/ImageUpdateService',
  );
  return {
    ...actual,
    ImageUpdateService: {
      isChecksEnabled: () => true,
      getInstance: () => ({ recheckStack: mockRecheckStack }),
    },
  };
});

vi.mock('../services/HealthGateService', () => ({
  HealthGateService: {
    getInstance: () => ({
      beginStack: mockBeginStack,
    }),
  },
}));

vi.mock('../services/FileSystemService', () => ({
  FileSystemService: {
    getInstance: () => ({
      getBaseDir: () => '/tmp/compose',
      hasComposeFile: vi.fn().mockResolvedValue(true),
    }),
  },
}));

vi.mock('../helpers/policyGate', async () => {
  const actual = await vi.importActual<typeof import('../helpers/policyGate')>(
    '../helpers/policyGate',
  );
  return {
    ...actual,
    runPolicyGate: vi.fn().mockResolvedValue(true),
    triggerPostDeployScan: vi.fn().mockResolvedValue(undefined),
  };
});

let tmpDir: string;
let app: import('express').Express;
let authCookie: string;
let clearSpy: ReturnType<typeof vi.spyOn> | undefined;
let broadcastSpy: ReturnType<typeof vi.spyOn> | undefined;
const callOrder: string[] = [];

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authCookie = await loginAsTestAdmin(app);

  const { DatabaseService } = await import('../services/DatabaseService');
  const { NotificationService } = await import('../services/NotificationService');
  clearSpy = vi.spyOn(DatabaseService.getInstance(), 'clearStackUpdateStatus').mockImplementation((...args) => {
    callOrder.push('clearStackUpdateStatus');
    return mockClearStackUpdateStatus(...args);
  });
  broadcastSpy = vi.spyOn(NotificationService.getInstance(), 'broadcastEvent').mockImplementation((...args) => {
    callOrder.push('broadcastEvent');
    return mockBroadcastEvent(...args);
  });
  vi.spyOn(NotificationService.getInstance(), 'dispatchAlert').mockImplementation((...args) => {
    callOrder.push(`dispatchAlert:${String(args[2] ?? args[0])}`);
    return mockDispatchAlert(...args) ?? Promise.resolve({ persisted: true });
  });
});

afterAll(() => {
  clearSpy?.mockRestore();
  broadcastSpy?.mockRestore();
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  callOrder.length = 0;
  mockExecute.mockReset();
  mockRecheckStack.mockReset();
  mockBeginStack.mockReset();
  mockClearStackUpdateStatus.mockReset();
  mockBroadcastEvent.mockReset();
  mockDispatchAlert.mockReset().mockResolvedValue({ persisted: true });

  mockExecute.mockImplementation(async () => {
    callOrder.push('execute');
    return { kind: 'stack_compose_done', recoveryId: null, deployedGenerationId: null };
  });
  mockBeginStack.mockImplementation(() => {
    callOrder.push('beginStack');
    return 'gate-1';
  });
  mockRecheckStack.mockImplementation(async () => {
    callOrder.push('recheckStack');
    return { outcome: 'cleared', warning: null };
  });
});

describe('POST /api/stacks/:name/update post-compose verification', () => {
  it('starts the health gate before recheck, skips clear, and broadcasts after recheck', async () => {
    const res = await request(app)
      .post('/api/stacks/web/update')
      .set('Cookie', authCookie)
      .send({ skip_scan: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'Update completed', healthGateId: 'gate-1' });
    expect(res.body.recheckWarning).toBeUndefined();
    expect(callOrder.indexOf('execute')).toBeLessThan(callOrder.indexOf('beginStack'));
    expect(callOrder.indexOf('beginStack')).toBeLessThan(callOrder.indexOf('recheckStack'));
    expect(callOrder.indexOf('recheckStack')).toBeLessThan(callOrder.indexOf('broadcastEvent'));
    expect(callOrder).not.toContain('clearStackUpdateStatus');
    expect(mockClearStackUpdateStatus).not.toHaveBeenCalled();
  });

  it('returns recheckWarning when the update condition remains', async () => {
    mockRecheckStack.mockImplementation(async () => {
      callOrder.push('recheckStack');
      return {
        outcome: 'still_present',
        warning: 'The update command completed, but Sencho still detects an available image update.',
      };
    });

    const res = await request(app)
      .post('/api/stacks/web/update')
      .set('Cookie', authCookie)
      .send({ skip_scan: true });

    expect(res.status).toBe(200);
    expect(res.body.recheckWarning).toBe(
      'The update command completed, but Sencho still detects an available image update.',
    );
  });

  it('surfaces the digest-unchanged warning when the image digest did not move after update', async () => {
    mockRecheckStack.mockImplementation(async () => {
      callOrder.push('recheckStack');
      return {
        outcome: 'still_present',
        warning: UPDATE_DIGEST_UNCHANGED_WARNING,
      };
    });

    const res = await request(app)
      .post('/api/stacks/web/update')
      .set('Cookie', authCookie)
      .send({ skip_scan: true });

    expect(res.status).toBe(200);
    expect(res.body.recheckWarning).toBe(UPDATE_DIGEST_UNCHANGED_WARNING);
  });

  it('keeps HTTP 200 and success notification when recheck throws after Compose', async () => {
    mockRecheckStack.mockImplementation(async () => {
      callOrder.push('recheckStack');
      throw new Error('registry blew up');
    });

    const res = await request(app)
      .post('/api/stacks/web/update')
      .set('Cookie', authCookie)
      .send({ skip_scan: true });

    expect(res.status).toBe(200);
    expect(res.body.healthGateId).toBe('gate-1');
    expect(res.body.recheckWarning).toMatch(/could not fully verify/i);
    expect(callOrder.indexOf('beginStack')).toBeLessThan(callOrder.indexOf('recheckStack'));
    expect(callOrder).toContain('broadcastEvent');
    // Success path still notifies; failure notification must not fire.
    expect(mockDispatchAlert).toHaveBeenCalledWith(
      'info',
      'image_update_applied',
      expect.any(String),
      expect.objectContaining({ stackName: 'web' }),
    );
    expect(mockDispatchAlert.mock.calls.some((c) => c[0] === 'error' && c[1] === 'deploy_failure')).toBe(false);
  });
});
