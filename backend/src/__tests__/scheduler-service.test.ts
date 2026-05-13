/**
 * Unit tests for SchedulerService — task execution, concurrent prevention,
 * license gating, cron parsing, and error handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ScheduledTask } from '../services/DatabaseService';

// ── Hoisted mocks ──────────────────────────────────────────────────────

const {
  mockGetDueScheduledTasks, mockCreateScheduledTaskRun, mockUpdateScheduledTaskRun,
  mockUpdateScheduledTask, mockCleanupOldTaskRuns, mockGetScheduledTask, mockGetNodes, mockGetNode,
  mockCreateSnapshot, mockInsertSnapshotFiles, mockClearStackUpdateStatus,
  mockMarkStaleRunsAsFailed, mockDeleteOldScans,
  mockGetTier, mockGetVariant, mockGetProxyHeaders,
  mockGetContainersByStack, mockRestartContainer, mockPruneSystem,
  mockUpdateStack,
  mockGetStacks, mockGetStackContent, mockGetEnvContent,
  mockCheckImage,
  mockDispatchAlert,
  mockGetProxyTarget,
  mockIsTrivyAvailable,
  mockScanAllNodeImages,
  mockGetStackAutoUpdateSettingsForNode,
  mockDeleteScheduledTask,
  mockGetMatchingPolicy,
  mockRunCommand,
  mockDeployStack,
  mockBackupStackFiles,
} = vi.hoisted(() => ({
  mockGetDueScheduledTasks: vi.fn().mockReturnValue([]),
  mockCreateScheduledTaskRun: vi.fn().mockReturnValue(1),
  mockUpdateScheduledTaskRun: vi.fn(),
  mockUpdateScheduledTask: vi.fn(),
  mockCleanupOldTaskRuns: vi.fn(),
  mockGetScheduledTask: vi.fn(),
  mockGetNodes: vi.fn().mockReturnValue([]),
  mockGetNode: vi.fn().mockReturnValue({ id: 1, name: 'local', type: 'local', status: 'online' }),
  mockCreateSnapshot: vi.fn().mockReturnValue(1),
  mockInsertSnapshotFiles: vi.fn(),
  mockClearStackUpdateStatus: vi.fn(),
  mockMarkStaleRunsAsFailed: vi.fn().mockReturnValue(0),
  mockDeleteOldScans: vi.fn().mockReturnValue(0),
  mockGetTier: vi.fn().mockReturnValue('paid'),
  mockGetVariant: vi.fn().mockReturnValue('admiral'),
  mockGetProxyHeaders: vi.fn().mockReturnValue({ tier: 'paid', variant: 'admiral' }),
  mockGetContainersByStack: vi.fn().mockResolvedValue([]),
  mockRestartContainer: vi.fn().mockResolvedValue(undefined),
  mockPruneSystem: vi.fn().mockResolvedValue({ success: true, reclaimedBytes: 0 }),
  mockUpdateStack: vi.fn().mockResolvedValue(undefined),
  mockGetStacks: vi.fn().mockResolvedValue([]),
  mockGetStackContent: vi.fn().mockResolvedValue(''),
  mockGetEnvContent: vi.fn().mockResolvedValue(''),
  mockCheckImage: vi.fn().mockResolvedValue({ hasUpdate: false }),
  mockDispatchAlert: vi.fn().mockResolvedValue(undefined),
  mockGetProxyTarget: vi.fn().mockReturnValue(null),
  mockIsTrivyAvailable: vi.fn().mockReturnValue(true),
  mockScanAllNodeImages: vi.fn().mockResolvedValue({
    scanned: 0,
    skipped: 0,
    failed: 0,
    severity: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
    violations: [],
  }),
  mockGetStackAutoUpdateSettingsForNode: vi.fn().mockReturnValue({}),
  mockDeleteScheduledTask: vi.fn(),
  mockGetMatchingPolicy: vi.fn().mockReturnValue(null),
  mockRunCommand: vi.fn().mockResolvedValue(undefined),
  mockDeployStack: vi.fn().mockResolvedValue(undefined),
  mockBackupStackFiles: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({
      getDueScheduledTasks: mockGetDueScheduledTasks,
      createScheduledTaskRun: mockCreateScheduledTaskRun,
      updateScheduledTaskRun: mockUpdateScheduledTaskRun,
      updateScheduledTask: mockUpdateScheduledTask,
      cleanupOldTaskRuns: mockCleanupOldTaskRuns,
      getScheduledTask: mockGetScheduledTask,
      getNodes: mockGetNodes,
      getNode: mockGetNode,
      createSnapshot: mockCreateSnapshot,
      insertSnapshotFiles: mockInsertSnapshotFiles,
      clearStackUpdateStatus: mockClearStackUpdateStatus,
      markStaleRunsAsFailed: mockMarkStaleRunsAsFailed,
      deleteOldScans: mockDeleteOldScans,
      getStackAutoUpdateSettingsForNode: mockGetStackAutoUpdateSettingsForNode,
      deleteScheduledTask: mockDeleteScheduledTask,
      getMatchingPolicy: mockGetMatchingPolicy,
    }),
  },
}));

vi.mock('../services/FleetSyncService', () => ({
  FleetSyncService: {
    getSelfIdentity: () => 'self-node',
  },
}));

vi.mock('../services/LicenseService', () => ({
  LicenseService: {
    getInstance: () => ({
      getTier: mockGetTier,
      getVariant: mockGetVariant,
      getProxyHeaders: mockGetProxyHeaders,
    }),
  },
}));


vi.mock('../services/DockerController', () => ({
  default: {
    getInstance: () => ({
      getContainersByStack: mockGetContainersByStack,
      restartContainer: mockRestartContainer,
      pruneSystem: mockPruneSystem,
    }),
  },
}));

vi.mock('../services/ComposeService', () => ({
  ComposeService: {
    getInstance: () => ({
      updateStack: mockUpdateStack,
      runCommand: mockRunCommand,
      deployStack: mockDeployStack,
    }),
  },
}));

vi.mock('../services/FileSystemService', () => ({
  FileSystemService: {
    getInstance: () => ({
      getStacks: mockGetStacks,
      getStackContent: mockGetStackContent,
      getEnvContent: mockGetEnvContent,
      backupStackFiles: mockBackupStackFiles,
    }),
  },
}));

vi.mock('../services/ImageUpdateService', () => ({
  ImageUpdateService: {
    getInstance: () => ({
      checkImage: mockCheckImage,
    }),
  },
}));

vi.mock('../services/NotificationService', () => ({
  NotificationService: {
    getInstance: () => ({
      dispatchAlert: mockDispatchAlert,
    }),
  },
}));

vi.mock('../services/CloudBackupService', () => ({
  CloudBackupService: {
    getInstance: () => ({
      isEnabled: () => false,
      isAutoUploadOn: () => false,
      uploadSnapshot: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getDefaultNodeId: () => 1,
      getNode: mockGetNode,
      getProxyTarget: mockGetProxyTarget,
    }),
  },
}));

vi.mock('../services/TrivyService', () => ({
  default: {
    getInstance: () => ({
      isTrivyAvailable: mockIsTrivyAvailable,
      scanAllNodeImages: mockScanAllNodeImages,
      getSource: () => 'managed',
      detectTrivy: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

import { SchedulerService } from '../services/SchedulerService';

beforeEach(() => {
  vi.clearAllMocks();
  (SchedulerService as any).instance = undefined;
});

// ── calculateNextRun ───────────────────────────────────────────────────

describe('SchedulerService - calculateNextRun', () => {
  it('returns a future timestamp for valid cron expression', () => {
    const svc = SchedulerService.getInstance();
    const next = svc.calculateNextRun('*/5 * * * *'); // Every 5 minutes
    expect(next).toBeGreaterThan(Date.now());
  });

  it('throws on invalid cron expression', () => {
    const svc = SchedulerService.getInstance();
    expect(() => svc.calculateNextRun('not a cron')).toThrow();
  });
});

describe('SchedulerService - calculateRunsWithin', () => {
  it('expands hourly cron into every firing within a 24h window when limit allows', () => {
    const svc = SchedulerService.getInstance();
    const from = Date.now();
    const to = from + 24 * 60 * 60 * 1000;
    const runs = svc.calculateRunsWithin('0 * * * *', from, to, 32);
    expect(runs.length).toBeGreaterThanOrEqual(23);
    expect(runs.length).toBeLessThanOrEqual(24);
    for (const run of runs) {
      expect(run).toBeGreaterThanOrEqual(from);
      expect(run).toBeLessThanOrEqual(to);
    }
  });

  it('returns a single firing for a daily cron', () => {
    const svc = SchedulerService.getInstance();
    const from = Date.now();
    const to = from + 24 * 60 * 60 * 1000;
    const runs = svc.calculateRunsWithin('0 3 * * *', from, to);
    expect(runs.length).toBeLessThanOrEqual(2);
    expect(runs.length).toBeGreaterThanOrEqual(1);
  });

  it('honours the limit parameter to avoid runaway expansions', () => {
    const svc = SchedulerService.getInstance();
    const from = Date.now();
    const to = from + 60 * 60 * 1000;
    const runs = svc.calculateRunsWithin('* * * * *', from, to, 5);
    expect(runs.length).toBe(5);
  });

  it('returns empty array for invalid cron instead of throwing', () => {
    const svc = SchedulerService.getInstance();
    const from = Date.now();
    const to = from + 60 * 60 * 1000;
    expect(svc.calculateRunsWithin('not a cron', from, to)).toEqual([]);
  });
});

// ── License gating ─────────────────────────────────────────────────────

describe('SchedulerService - license gating', () => {
  function makeTask(overrides: Partial<any> = {}) {
    return {
      id: 1,
      name: 'test-task',
      action: 'restart',
      cron_expression: '*/5 * * * *',
      enabled: true,
      target_id: 'my-stack',
      node_id: 1,
      created_by: 'admin',
      last_status: null,
      ...overrides,
    };
  }

  it('skips all tasks when tier is not pro', async () => {
    mockGetTier.mockReturnValue('community');
    mockGetDueScheduledTasks.mockReturnValue([makeTask()]);

    const svc = SchedulerService.getInstance();
    await (svc as any).tick();

    expect(mockCreateScheduledTaskRun).not.toHaveBeenCalled();
  });

  it('allows update tasks for non-admiral pro', async () => {
    mockGetTier.mockReturnValue('paid');
    mockGetVariant.mockReturnValue('individual');
    mockGetDueScheduledTasks.mockReturnValue([makeTask({ action: 'update' })]);
    mockGetContainersByStack.mockResolvedValue([{ Id: 'c1', Image: 'nginx:latest' }]);
    mockCheckImage.mockResolvedValue({ hasUpdate: false });

    const svc = SchedulerService.getInstance();
    await (svc as any).tick();

    // Wait for the async task to settle
    await new Promise(r => setTimeout(r, 50));
    expect(mockCreateScheduledTaskRun).toHaveBeenCalled();
  });

  it('skips non-update/scan/snapshot tasks for non-admiral pro', async () => {
    mockGetTier.mockReturnValue('paid');
    mockGetVariant.mockReturnValue('individual');
    mockGetDueScheduledTasks.mockReturnValue([makeTask({ action: 'restart' })]);

    const svc = SchedulerService.getInstance();
    await (svc as any).tick();

    expect(mockCreateScheduledTaskRun).not.toHaveBeenCalled();
  });

  it('allows snapshot tasks for non-admiral pro (Skipper)', async () => {
    mockGetTier.mockReturnValue('paid');
    mockGetVariant.mockReturnValue('individual');
    mockGetDueScheduledTasks.mockReturnValue([makeTask({ action: 'snapshot', target_type: 'fleet' })]);

    const svc = SchedulerService.getInstance();
    await (svc as any).tick();

    await new Promise(r => setTimeout(r, 50));
    expect(mockCreateScheduledTaskRun).toHaveBeenCalled();
  });

  it('allows all actions for admiral (pro + team)', async () => {
    mockGetTier.mockReturnValue('paid');
    mockGetVariant.mockReturnValue('admiral');
    mockGetDueScheduledTasks.mockReturnValue([makeTask({ action: 'restart' })]);
    mockGetContainersByStack.mockResolvedValue([{ Id: 'c1', Service: 'web' }]);

    const svc = SchedulerService.getInstance();
    await (svc as any).tick();

    await new Promise(r => setTimeout(r, 50));
    expect(mockCreateScheduledTaskRun).toHaveBeenCalled();
  });
});

// ── Concurrent task prevention ─────────────────────────────────────────

describe('SchedulerService - concurrent task prevention', () => {
  it('does not execute a task that is already in runningTasks', async () => {
    mockGetTier.mockReturnValue('paid');
    mockGetVariant.mockReturnValue('admiral');
    mockGetDueScheduledTasks.mockReturnValue([{
      id: 42,
      name: 'running-task',
      action: 'restart',
      cron_expression: '*/5 * * * *',
      enabled: true,
      target_id: 'my-stack',
      node_id: 1,
      created_by: 'admin',
      last_status: null,
    }]);

    const svc = SchedulerService.getInstance();
    // Pre-add the task to runningTasks
    (svc as any).runningTasks.add(42);

    await (svc as any).tick();
    await new Promise(r => setTimeout(r, 50));

    expect(mockCreateScheduledTaskRun).not.toHaveBeenCalled();
  });

  it('removes task from runningTasks after completion', async () => {
    mockGetTier.mockReturnValue('paid');
    mockGetVariant.mockReturnValue('admiral');
    mockGetContainersByStack.mockResolvedValue([{ Id: 'c1', Service: 'web' }]);

    const svc = SchedulerService.getInstance();
    mockGetScheduledTask.mockReturnValue({
      id: 99,
      name: 'trigger-test',
      action: 'restart',
      cron_expression: '*/5 * * * *',
      enabled: true,
      target_id: 'my-stack',
      node_id: 1,
      created_by: 'admin',
      last_status: null,
    });

    await svc.triggerTask(99);

    expect((svc as any).runningTasks.has(99)).toBe(false);
  });

  it('removes task from runningTasks even on failure', async () => {
    const svc = SchedulerService.getInstance();
    mockGetScheduledTask.mockReturnValue({
      id: 100,
      name: 'fail-test',
      action: 'restart',
      cron_expression: '*/5 * * * *',
      enabled: true,
      target_id: null, // Will cause error: "requires target_id"
      node_id: null,
      created_by: 'admin',
      last_status: null,
    });

    await svc.triggerTask(100);

    expect((svc as any).runningTasks.has(100)).toBe(false);
    // Error should have been recorded
    expect(mockUpdateScheduledTaskRun).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ status: 'failure' })
    );
  });
});

// ── triggerTask ────────────────────────────────────────────────────────

describe('SchedulerService - triggerTask', () => {
  it('throws when task not found', async () => {
    mockGetScheduledTask.mockReturnValue(undefined);

    const svc = SchedulerService.getInstance();
    await expect(svc.triggerTask(999)).rejects.toThrow('Task not found');
  });

  it('throws when task is already running', async () => {
    mockGetScheduledTask.mockReturnValue({ id: 50, name: 'busy' });

    const svc = SchedulerService.getInstance();
    (svc as any).runningTasks.add(50);

    await expect(svc.triggerTask(50)).rejects.toThrow('already running');
  });

  it('sets triggered_by to manual', async () => {
    mockGetScheduledTask.mockReturnValue({
      id: 55,
      name: 'manual-test',
      action: 'restart',
      cron_expression: '*/5 * * * *',
      enabled: false, // Disabled — but triggerTask should still work
      target_id: 'my-stack',
      node_id: 1,
      created_by: 'admin',
      last_status: null,
    });
    mockGetContainersByStack.mockResolvedValue([{ Id: 'c1', Service: 'web' }]);

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(55);

    expect(mockCreateScheduledTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({ triggered_by: 'manual' })
    );
  });
});

// ── executeRestart ─────────────────────────────────────────────────────

describe('SchedulerService - executeRestart', () => {
  it('restarts all containers in a stack', async () => {
    mockGetScheduledTask.mockReturnValue({
      id: 60,
      name: 'restart-all',
      action: 'restart',
      cron_expression: '*/5 * * * *',
      enabled: true,
      target_id: 'my-stack',
      node_id: 1,
      created_by: 'admin',
      last_status: null,
    });
    mockGetContainersByStack.mockResolvedValue([
      { Id: 'c1', Service: 'web' },
      { Id: 'c2', Service: 'db' },
    ]);

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(60);

    expect(mockRestartContainer).toHaveBeenCalledTimes(2);
  });

  it('restarts only specified services when target_services set', async () => {
    mockGetScheduledTask.mockReturnValue({
      id: 61,
      name: 'restart-filtered',
      action: 'restart',
      cron_expression: '*/5 * * * *',
      enabled: true,
      target_id: 'my-stack',
      node_id: 1,
      target_services: JSON.stringify(['web']),
      created_by: 'admin',
      last_status: null,
    });
    mockGetContainersByStack.mockResolvedValue([
      { Id: 'c1', Service: 'web' },
      { Id: 'c2', Service: 'db' },
    ]);

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(61);

    expect(mockRestartContainer).toHaveBeenCalledTimes(1);
    expect(mockRestartContainer).toHaveBeenCalledWith('c1');
  });

  it('records failure when no containers found', async () => {
    mockGetScheduledTask.mockReturnValue({
      id: 62,
      name: 'restart-empty',
      action: 'restart',
      cron_expression: '*/5 * * * *',
      enabled: true,
      target_id: 'empty-stack',
      node_id: 1,
      created_by: 'admin',
      last_status: null,
    });
    mockGetContainersByStack.mockResolvedValue([]);

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(62);

    expect(mockUpdateScheduledTaskRun).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ status: 'failure', error: expect.stringContaining('No containers') })
    );
  });
});

// ── executePrune ───────────────────────────────────────────────────────

describe('SchedulerService - executePrune', () => {
  it('prunes all targets by default', async () => {
    mockGetScheduledTask.mockReturnValue({
      id: 70,
      name: 'prune-all',
      action: 'prune',
      cron_expression: '0 3 * * *',
      enabled: true,
      node_id: 1,
      created_by: 'admin',
      last_status: null,
    });

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(70);

    // Should prune all 4 targets
    expect(mockPruneSystem).toHaveBeenCalledTimes(4);
  });

  it('prunes only specified targets', async () => {
    mockGetScheduledTask.mockReturnValue({
      id: 71,
      name: 'prune-some',
      action: 'prune',
      cron_expression: '0 3 * * *',
      enabled: true,
      node_id: 1,
      prune_targets: JSON.stringify(['images', 'volumes']),
      created_by: 'admin',
      last_status: null,
    });

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(71);

    expect(mockPruneSystem).toHaveBeenCalledTimes(2);
    expect(mockPruneSystem).toHaveBeenCalledWith('images', undefined);
    expect(mockPruneSystem).toHaveBeenCalledWith('volumes', undefined);
  });

  it('includes label filter when configured', async () => {
    mockGetScheduledTask.mockReturnValue({
      id: 72,
      name: 'prune-labeled',
      action: 'prune',
      cron_expression: '0 3 * * *',
      enabled: true,
      node_id: 1,
      prune_targets: JSON.stringify(['containers']),
      prune_label_filter: 'env=staging',
      created_by: 'admin',
      last_status: null,
    });

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(72);

    expect(mockPruneSystem).toHaveBeenCalledWith('containers', 'env=staging');
  });
});

// ── executeUpdate ──────────────────────────────────────────────────────

describe('SchedulerService - executeUpdate', () => {
  it('updates stack when image update available', async () => {
    mockGetScheduledTask.mockReturnValue({
      id: 80,
      name: 'update-stack',
      action: 'update',
      cron_expression: '0 4 * * *',
      enabled: true,
      target_id: 'web-app',
      node_id: 1,
      created_by: 'admin',
      last_status: null,
    });
    mockGetContainersByStack.mockResolvedValue([
      { Id: 'c1', Image: 'nginx:latest' },
    ]);
    mockCheckImage.mockResolvedValue({ hasUpdate: true }); // Update available

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(80);

    expect(mockUpdateStack).toHaveBeenCalledWith('web-app', undefined, true);
    expect(mockClearStackUpdateStatus).toHaveBeenCalledWith(1, 'web-app');
  });

  it('skips when all images up to date', async () => {
    mockGetScheduledTask.mockReturnValue({
      id: 81,
      name: 'update-no-change',
      action: 'update',
      cron_expression: '0 4 * * *',
      enabled: true,
      target_id: 'web-app',
      node_id: 1,
      created_by: 'admin',
      last_status: null,
    });
    mockGetContainersByStack.mockResolvedValue([
      { Id: 'c1', Image: 'nginx:latest' },
    ]);
    mockCheckImage.mockResolvedValue({ hasUpdate: false }); // No update

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(81);

    expect(mockUpdateStack).not.toHaveBeenCalled();
  });

  it('handles wildcard target (*) by updating all stacks', async () => {
    mockGetScheduledTask.mockReturnValue({
      id: 82,
      name: 'update-all',
      action: 'update',
      cron_expression: '0 4 * * *',
      enabled: true,
      target_id: '*',
      node_id: 1,
      created_by: 'admin',
      last_status: null,
    });
    mockGetStacks.mockResolvedValue(['app1', 'app2']);
    mockGetContainersByStack.mockResolvedValue([
      { Id: 'c1', Image: 'nginx:latest' },
    ]);
    mockCheckImage.mockResolvedValue({ hasUpdate: true });

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(82);

    expect(mockUpdateStack).toHaveBeenCalledTimes(2);
  });

  it('reports warning when all image checks fail (B3 fix)', async () => {
    mockGetScheduledTask.mockReturnValue({
      id: 83,
      name: 'update-check-fail',
      action: 'update',
      cron_expression: '0 4 * * *',
      enabled: true,
      target_id: 'web-app',
      node_id: 1,
      created_by: 'admin',
      last_status: null,
    });
    mockGetContainersByStack.mockResolvedValue([
      { Id: 'c1', Image: 'nginx:latest' },
    ]);
    mockCheckImage.mockResolvedValue({ hasUpdate: false, error: 'Registry unreachable for registry-1.docker.io/library/nginx:latest' });

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(83);

    // Should succeed (not throw) but output should contain warning
    expect(mockUpdateScheduledTaskRun).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        status: 'success',
        output: expect.stringContaining('WARNING'),
      })
    );
    expect(mockUpdateStack).not.toHaveBeenCalled();
  });

  it('reports partial check failures with success count (B3 fix)', async () => {
    mockGetScheduledTask.mockReturnValue({
      id: 84,
      name: 'update-partial-fail',
      action: 'update',
      cron_expression: '0 4 * * *',
      enabled: true,
      target_id: 'web-app',
      node_id: 1,
      created_by: 'admin',
      last_status: null,
    });
    mockGetContainersByStack.mockResolvedValue([
      { Id: 'c1', Image: 'nginx:latest' },
      { Id: 'c2', Image: 'redis:7' },
    ]);
    // First image check succeeds (no update), second fails
    mockCheckImage
      .mockResolvedValueOnce({ hasUpdate: false })
      .mockResolvedValueOnce({ hasUpdate: false, error: 'Registry unreachable' });

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(84);

    expect(mockUpdateScheduledTaskRun).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        status: 'success',
        output: expect.stringContaining('check(s) failed'),
      })
    );
  });

  it('warns when targeted stack has 0 containers (E1 fix)', async () => {
    mockGetScheduledTask.mockReturnValue({
      id: 85,
      name: 'update-missing-stack',
      action: 'update',
      cron_expression: '0 4 * * *',
      enabled: true,
      target_id: 'deleted-stack',
      node_id: 1,
      created_by: 'admin',
      last_status: null,
    });
    mockGetContainersByStack.mockResolvedValue([]);

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(85);

    // Targeted (non-wildcard) stack with 0 containers should produce a WARNING
    expect(mockUpdateScheduledTaskRun).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        status: 'success',
        output: expect.stringContaining('WARNING'),
      })
    );
  });

  it('silently skips empty stacks in wildcard mode', async () => {
    mockGetScheduledTask.mockReturnValue({
      id: 86,
      name: 'update-wildcard-empty',
      action: 'update',
      cron_expression: '0 4 * * *',
      enabled: true,
      target_id: '*',
      node_id: 1,
      created_by: 'admin',
      last_status: null,
    });
    mockGetStacks.mockResolvedValue(['active-stack', 'empty-stack']);
    // First stack has containers, second has none
    mockGetContainersByStack
      .mockResolvedValueOnce([{ Id: 'c1', Image: 'nginx:latest' }])
      .mockResolvedValueOnce([]);
    mockCheckImage.mockResolvedValue({ hasUpdate: false });

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(86);

    // Empty stack in wildcard mode should say "skipped", not "WARNING"
    expect(mockUpdateScheduledTaskRun).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        status: 'success',
        output: expect.not.stringContaining('WARNING'),
      })
    );
  });

  it('exposes isTaskRunning status', async () => {
    const svc = SchedulerService.getInstance();
    expect(svc.isTaskRunning(999)).toBe(false);
  });

  it('fleet target updates all stacks whose policy allows it', async () => {
    mockGetScheduledTask.mockReturnValue({
      id: 87,
      name: 'fleet-update',
      action: 'update',
      target_type: 'fleet',
      cron_expression: '0 4 * * *',
      enabled: true,
      target_id: null,
      node_id: 1,
      created_by: 'admin',
      last_status: null,
    });
    mockGetStacks.mockResolvedValue(['app1', 'app2', 'app3']);
    // app2 explicitly disabled; app1 and app3 default to enabled
    mockGetStackAutoUpdateSettingsForNode.mockReturnValue({ app2: false });
    mockGetContainersByStack.mockResolvedValue([{ Id: 'c1', Image: 'nginx:latest' }]);
    mockCheckImage.mockResolvedValue({ hasUpdate: true });

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(87);

    // Only app1 and app3 should be updated
    expect(mockUpdateStack).toHaveBeenCalledTimes(2);
    expect(mockUpdateScheduledTaskRun).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        status: 'success',
        output: expect.stringContaining('auto-updates disabled; skipped'),
      })
    );
  });

  it('fleet target with zero eligible stacks records success', async () => {
    mockGetScheduledTask.mockReturnValue({
      id: 88,
      name: 'fleet-update-all-off',
      action: 'update',
      target_type: 'fleet',
      cron_expression: '0 4 * * *',
      enabled: true,
      target_id: null,
      node_id: 1,
      created_by: 'admin',
      last_status: null,
    });
    mockGetStacks.mockResolvedValue(['app1', 'app2']);
    mockGetStackAutoUpdateSettingsForNode.mockReturnValue({ app1: false, app2: false });

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(88);

    expect(mockUpdateStack).not.toHaveBeenCalled();
    expect(mockUpdateScheduledTaskRun).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'success' })
    );
  });

  it('fleet target on empty node returns early with skipped message', async () => {
    mockGetScheduledTask.mockReturnValue({
      id: 89,
      name: 'fleet-update-empty-node',
      action: 'update',
      target_type: 'fleet',
      cron_expression: '0 4 * * *',
      enabled: true,
      target_id: null,
      node_id: 1,
      created_by: 'admin',
      last_status: null,
    });
    mockGetStacks.mockResolvedValue([]);

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(89);

    expect(mockUpdateStack).not.toHaveBeenCalled();
    expect(mockUpdateScheduledTaskRun).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        status: 'success',
        output: expect.stringContaining('No stacks found'),
      })
    );
  });
});

// ── Error handling & notifications ─────────────────────────────────────

describe('SchedulerService - error handling', () => {
  it('records failure status in DB on error', async () => {
    mockGetScheduledTask.mockReturnValue({
      id: 90,
      name: 'error-task',
      action: 'restart',
      cron_expression: '*/5 * * * *',
      enabled: true,
      target_id: null,
      node_id: null,
      created_by: 'admin',
      last_status: null,
    });

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(90);

    expect(mockUpdateScheduledTask).toHaveBeenCalledWith(
      90,
      expect.objectContaining({ last_status: 'failure' })
    );
  });

  it('dispatches error notification on failure', async () => {
    mockGetScheduledTask.mockReturnValue({
      id: 91,
      name: 'notify-fail',
      action: 'restart',
      cron_expression: '*/5 * * * *',
      enabled: true,
      target_id: null,
      node_id: null,
      created_by: 'admin',
      last_status: null,
    });

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(91);

    expect(mockDispatchAlert).toHaveBeenCalledWith('error', 'system', expect.stringContaining('failed'), { stackName: undefined });
  });

  it('dispatches recovery notification when previous status was failure', async () => {
    mockGetScheduledTask.mockReturnValue({
      id: 92,
      name: 'recovery-task',
      action: 'restart',
      cron_expression: '*/5 * * * *',
      enabled: true,
      target_id: 'my-stack',
      node_id: 1,
      created_by: 'admin',
      last_status: 'failure', // Previous run failed
    });
    mockGetContainersByStack.mockResolvedValue([{ Id: 'c1', Service: 'web' }]);

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(92);

    expect(mockDispatchAlert).toHaveBeenCalledWith('info', 'system', expect.stringContaining('recovered'), { stackName: 'my-stack' });
  });
});

// ── Scheduled scan completion notifications ───────────────────────────

describe('SchedulerService - scheduled scan notifications', () => {
  function makeScanTask(overrides: Partial<any> = {}) {
    return {
      id: 200,
      name: 'nightly-scan',
      action: 'scan',
      cron_expression: '0 2 * * *',
      enabled: true,
      target_id: null,
      node_id: 1,
      created_by: 'admin',
      last_status: null,
      ...overrides,
    };
  }

  function scanResult(opts: {
    scanned?: number;
    skipped?: number;
    failed?: number;
    critical?: number;
    high?: number;
    medium?: number;
    low?: number;
    unknown?: number;
  } = {}) {
    return {
      scanned: opts.scanned ?? 0,
      skipped: opts.skipped ?? 0,
      failed: opts.failed ?? 0,
      severity: {
        critical: opts.critical ?? 0,
        high: opts.high ?? 0,
        medium: opts.medium ?? 0,
        low: opts.low ?? 0,
        unknown: opts.unknown ?? 0,
      },
      violations: [],
    };
  }

  it('dispatches info-level notification when scan completes cleanly', async () => {
    mockGetScheduledTask.mockReturnValue(makeScanTask());
    mockScanAllNodeImages.mockResolvedValue(scanResult({ scanned: 3, skipped: 1 }));

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(200);

    expect(mockDispatchAlert).toHaveBeenCalledWith(
      'info',
      'scan_finding',
      expect.stringContaining('nightly-scan'),
      { stackName: undefined },
    );
    expect(mockDispatchAlert).toHaveBeenCalledWith(
      'info',
      'scan_finding',
      expect.stringContaining('Scanned 3 image(s)'),
      { stackName: undefined },
    );
  });

  it('dispatches warning-level notification when scan has failures', async () => {
    mockGetScheduledTask.mockReturnValue(makeScanTask({ id: 201, name: 'flaky-scan' }));
    mockScanAllNodeImages.mockResolvedValue(scanResult({ scanned: 5, failed: 2 }));

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(201);

    expect(mockDispatchAlert).toHaveBeenCalledWith(
      'warning',
      'scan_finding',
      expect.stringContaining('2 failed'),
      { stackName: undefined },
    );
  });

  it('passes target_id to dispatchAlert when set', async () => {
    mockGetScheduledTask.mockReturnValue(makeScanTask({ id: 202, target_id: 'web-stack' }));
    mockScanAllNodeImages.mockResolvedValue(scanResult({ scanned: 1 }));

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(202);

    expect(mockDispatchAlert).toHaveBeenCalledWith(
      'info',
      'scan_finding',
      expect.stringContaining('completed'),
      { stackName: 'web-stack' },
    );
  });

  it('fires only the scan notification when previous run was failure (no duplicate recovery alert)', async () => {
    mockGetScheduledTask.mockReturnValue(makeScanTask({
      id: 204,
      name: 'recovered-scan',
      last_status: 'failure',
    }));
    mockScanAllNodeImages.mockResolvedValue(scanResult({ scanned: 2 }));

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(204);

    expect(mockDispatchAlert).toHaveBeenCalledTimes(1);
    expect(mockDispatchAlert).toHaveBeenCalledWith(
      'info',
      'scan_finding',
      expect.stringContaining('recovered-scan'),
      { stackName: undefined },
    );
  });

  it('does not dispatch a scan notification for non-scan actions', async () => {
    mockGetScheduledTask.mockReturnValue({
      id: 203,
      name: 'restart-task',
      action: 'restart',
      cron_expression: '*/5 * * * *',
      enabled: true,
      target_id: 'my-stack',
      node_id: 1,
      created_by: 'admin',
      last_status: null,
    });
    mockGetContainersByStack.mockResolvedValue([{ Id: 'c1', Service: 'web' }]);

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(203);

    expect(mockDispatchAlert).not.toHaveBeenCalled();
  });

  it('dispatches error-level notification when Trivy is unavailable', async () => {
    mockGetScheduledTask.mockReturnValue(makeScanTask({ id: 205, target_id: 'payment-stack' }));
    mockIsTrivyAvailable.mockReturnValueOnce(false);

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(205);

    expect(mockDispatchAlert).toHaveBeenCalledWith(
      'error',
      'system',
      expect.stringMatching(/failed.*Trivy/i),
      { stackName: 'payment-stack' },
    );
  });

  it('includes severity counts in the notification message', async () => {
    mockGetScheduledTask.mockReturnValue(makeScanTask({ id: 206 }));
    mockScanAllNodeImages.mockResolvedValue(
      scanResult({ scanned: 3, skipped: 1, critical: 2, high: 5, medium: 10 }),
    );

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(206);

    const message = mockDispatchAlert.mock.calls[0][2] as string;
    expect(message).toContain('2 critical');
    expect(message).toContain('5 high');
    expect(message).toContain('10 medium');
  });

  it('reports "No images to scan" when the node has nothing to scan', async () => {
    mockGetScheduledTask.mockReturnValue(makeScanTask({ id: 207 }));
    mockScanAllNodeImages.mockResolvedValue(scanResult());

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(207);

    expect(mockDispatchAlert).toHaveBeenCalledWith(
      'info',
      'scan_finding',
      expect.stringContaining('No images to scan'),
      { stackName: undefined },
    );
  });

  it('reports "All N image(s) already scanned recently" when every image was cached', async () => {
    mockGetScheduledTask.mockReturnValue(makeScanTask({ id: 208 }));
    mockScanAllNodeImages.mockResolvedValue(scanResult({ skipped: 12 }));

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(208);

    expect(mockDispatchAlert).toHaveBeenCalledWith(
      'info',
      'scan_finding',
      expect.stringContaining('All 12 image(s) already scanned recently'),
      { stackName: undefined },
    );
  });

  it('persists the run as success even when notification dispatch throws', async () => {
    mockGetScheduledTask.mockReturnValue(makeScanTask({ id: 209 }));
    mockScanAllNodeImages.mockResolvedValue(scanResult({ scanned: 1 }));
    mockDispatchAlert.mockRejectedValueOnce(new Error('webhook down'));

    const svc = SchedulerService.getInstance();
    await expect(svc.triggerTask(209)).resolves.not.toThrow();

    expect(mockUpdateScheduledTaskRun).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ status: 'success' }),
    );
  });
});

// ── Cleanup ────────────────────────────────────────────────────────────

describe('SchedulerService - cleanup', () => {
  it('calls cleanupOldTaskRuns(30) on every tick', async () => {
    mockGetTier.mockReturnValue('paid');
    mockGetVariant.mockReturnValue('admiral');
    mockGetDueScheduledTasks.mockReturnValue([]);

    const svc = SchedulerService.getInstance();
    await (svc as any).tick();

    expect(mockCleanupOldTaskRuns).toHaveBeenCalledWith(30);
  });
});

// ── isProcessing guard ─────────────────────────────────────────────────

describe('SchedulerService - isProcessing guard', () => {
  it('skips tick if already processing', async () => {
    mockGetTier.mockReturnValue('paid');

    const svc = SchedulerService.getInstance();
    (svc as any).isProcessing = true;

    await (svc as any).tick();

    expect(mockGetTier).not.toHaveBeenCalled();
  });

  it('resets isProcessing after tick completes (even on error)', async () => {
    mockGetTier.mockImplementationOnce(() => { throw new Error('boom'); });

    const svc = SchedulerService.getInstance();
    await (svc as any).tick();

    expect((svc as any).isProcessing).toBe(false);
  });
});

// ── Stale run cleanup (T1) ───────────────────────────────────────────

describe('SchedulerService - stale run cleanup', () => {
  it('calls markStaleRunsAsFailed on start and logs when records exist', () => {
    mockMarkStaleRunsAsFailed.mockReturnValue(2);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const svc = SchedulerService.getInstance();
    svc.start();

    expect(mockMarkStaleRunsAsFailed).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Cleaned up 2 stale run record(s)'));

    logSpy.mockRestore();
    svc.stop();
  });

  it('does not log when no stale runs exist', () => {
    mockMarkStaleRunsAsFailed.mockReturnValue(0);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const svc = SchedulerService.getInstance();
    svc.start();

    expect(mockMarkStaleRunsAsFailed).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('stale'));

    logSpy.mockRestore();
    svc.stop();
  });
});

// ── Invalid cron at execution time (T2) ──────────────────────────────

describe('SchedulerService - invalid cron at execution time', () => {
  it('disables task and records error when cron becomes invalid', async () => {
    mockGetScheduledTask.mockReturnValue({
      id: 95,
      name: 'bad-cron-task',
      action: 'restart',
      cron_expression: 'INVALID CRON',
      enabled: true,
      target_id: null,
      node_id: null,
      created_by: 'admin',
      last_status: null,
    });

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(95);

    expect(mockUpdateScheduledTask).toHaveBeenCalledWith(
      95,
      expect.objectContaining({
        enabled: 0,
        last_status: 'failure',
        last_error: expect.stringContaining('no longer valid'),
      })
    );

    expect(mockDispatchAlert).toHaveBeenCalledWith(
      'error',
      'system',
      expect.stringContaining('failed'),
      { stackName: undefined },
    );
  });
});

// ── executeSnapshot (T3) ─────────────────────────────────────────────

describe('SchedulerService - executeSnapshot', () => {
  it('creates a fleet snapshot capturing all local nodes', async () => {
    mockGetScheduledTask.mockReturnValue({
      id: 75,
      name: 'nightly-snapshot',
      action: 'snapshot',
      target_type: 'fleet',
      cron_expression: '0 3 * * *',
      enabled: true,
      created_by: 'admin',
      last_status: null,
    });
    mockGetNodes.mockReturnValue([
      { id: 1, name: 'local', type: 'local' },
    ]);
    mockGetStacks.mockResolvedValue(['app1']);
    mockGetStackContent.mockResolvedValue('version: "3"\nservices:\n  web:\n    image: nginx');

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(75);

    expect(mockCreateSnapshot).toHaveBeenCalledWith(
      expect.stringContaining('nightly-snapshot'),
      'admin',
      1,
      1,
      expect.any(String),
    );
    expect(mockUpdateScheduledTaskRun).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'success' })
    );
  });

  it('handles nodes with no stacks gracefully', async () => {
    mockGetScheduledTask.mockReturnValue({
      id: 76,
      name: 'empty-snapshot',
      action: 'snapshot',
      target_type: 'fleet',
      cron_expression: '0 3 * * *',
      enabled: true,
      created_by: 'admin',
      last_status: null,
    });
    mockGetNodes.mockReturnValue([
      { id: 1, name: 'local', type: 'local' },
    ]);
    mockGetStacks.mockResolvedValue([]);

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(76);

    expect(mockCreateSnapshot).toHaveBeenCalled();
    expect(mockUpdateScheduledTaskRun).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'success' })
    );
  });
});

// ── executeUpdateRemote (T4) ─────────────────────────────────────────

describe('SchedulerService - executeUpdateRemote', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('proxies update execution to remote node', async () => {
    mockGetNode.mockReturnValue({ id: 2, name: 'remote', type: 'remote', status: 'online' });
    mockGetProxyTarget.mockReturnValue({
      apiUrl: 'http://remote:1852',
      apiToken: 'test-token',
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: 'Stack "web": updated (nginx:latest).' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    mockGetScheduledTask.mockReturnValue({
      id: 88,
      name: 'remote-update',
      action: 'update',
      cron_expression: '0 4 * * *',
      enabled: true,
      target_id: 'web-app',
      node_id: 2,
      created_by: 'admin',
      last_status: null,
    });

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(88);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://remote:1852/api/auto-update/execute',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer test-token',
          'x-sencho-tier': 'paid',
          'x-sencho-variant': 'admiral',
        }),
        body: JSON.stringify({ target: 'web-app' }),
      })
    );
    expect(mockUpdateScheduledTaskRun).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'success' })
    );
  });

  it('records failure when remote node returns error', async () => {
    mockGetNode.mockReturnValue({ id: 2, name: 'remote', type: 'remote', status: 'online' });
    mockGetProxyTarget.mockReturnValue({
      apiUrl: 'http://remote:1852',
      apiToken: 'test-token',
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Internal error' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    mockGetScheduledTask.mockReturnValue({
      id: 89,
      name: 'remote-update-fail',
      action: 'update',
      cron_expression: '0 4 * * *',
      enabled: true,
      target_id: 'web-app',
      node_id: 2,
      created_by: 'admin',
      last_status: null,
    });

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(89);

    expect(mockUpdateScheduledTaskRun).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'failure', error: expect.stringContaining('Internal error') })
    );
  });
});

// ── Lifecycle actions (auto_backup, auto_stop, auto_down, auto_start) ───

function makeLifecycleTask(action: ScheduledTask['action'], overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 300,
    name: `lifecycle-${action}`,
    action,
    target_type: 'stack',
    target_id: 'my-stack',
    node_id: 1,
    cron_expression: '0 2 * * *',
    enabled: 1,
    created_by: 'admin',
    created_at: 0,
    updated_at: 0,
    last_run_at: null,
    next_run_at: null,
    last_status: null,
    last_error: null,
    prune_targets: null,
    target_services: null,
    prune_label_filter: null,
    delete_after_run: 0,
    ...overrides,
  };
}

describe('SchedulerService - lifecycle actions', () => {
  it('auto_stop calls runCommand with "stop"', async () => {
    mockGetScheduledTask.mockReturnValue(makeLifecycleTask('auto_stop'));
    await SchedulerService.getInstance().triggerTask(300);
    expect(mockRunCommand).toHaveBeenCalledWith('my-stack', 'stop');
    expect(mockUpdateScheduledTaskRun).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'success' }));
  });

  it('auto_down calls runCommand with "down"', async () => {
    mockGetScheduledTask.mockReturnValue(makeLifecycleTask('auto_down'));
    await SchedulerService.getInstance().triggerTask(300);
    expect(mockRunCommand).toHaveBeenCalledWith('my-stack', 'down');
    expect(mockUpdateScheduledTaskRun).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'success' }));
  });

  it('auto_start calls deployStack', async () => {
    mockGetScheduledTask.mockReturnValue(makeLifecycleTask('auto_start'));
    await SchedulerService.getInstance().triggerTask(300);
    expect(mockDeployStack).toHaveBeenCalledWith('my-stack');
    expect(mockUpdateScheduledTaskRun).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'success' }));
  });

  it('auto_backup calls backupStackFiles', async () => {
    mockGetScheduledTask.mockReturnValue(makeLifecycleTask('auto_backup'));
    await SchedulerService.getInstance().triggerTask(300);
    expect(mockBackupStackFiles).toHaveBeenCalledWith('my-stack');
    expect(mockUpdateScheduledTaskRun).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'success' }));
  });

  it('auto_stop records failure when target_id is missing', async () => {
    mockGetScheduledTask.mockReturnValue(makeLifecycleTask('auto_stop', { target_id: null }));
    await SchedulerService.getInstance().triggerTask(300);
    expect(mockRunCommand).not.toHaveBeenCalled();
    expect(mockUpdateScheduledTaskRun).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'failure' }));
  });

  it('auto_backup records failure when node_id is missing', async () => {
    mockGetScheduledTask.mockReturnValue(makeLifecycleTask('auto_backup', { node_id: null }));
    await SchedulerService.getInstance().triggerTask(300);
    expect(mockBackupStackFiles).not.toHaveBeenCalled();
    expect(mockUpdateScheduledTaskRun).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'failure' }));
  });

  it('non-admiral paid tier skips lifecycle actions', async () => {
    mockGetTier.mockReturnValue('paid');
    mockGetVariant.mockReturnValue('standard');
    mockGetScheduledTask.mockReturnValue(makeLifecycleTask('auto_stop'));
    mockGetDueScheduledTasks.mockReturnValue([makeLifecycleTask('auto_stop')]);

    const svc = SchedulerService.getInstance();
    await (svc as any).tick();

    expect(mockRunCommand).not.toHaveBeenCalled();
  });
});

// ── delete_after_run ────────────────────────────────────────────────────

describe('SchedulerService - delete_after_run', () => {
  it('deletes task after successful run when delete_after_run is 1', async () => {
    mockGetScheduledTask.mockReturnValue(makeLifecycleTask('auto_backup', { delete_after_run: 1 }));
    await SchedulerService.getInstance().triggerTask(300);
    expect(mockDeleteScheduledTask).toHaveBeenCalledWith(300);
    expect(mockUpdateScheduledTaskRun).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'success' }));
  });

  it('does not delete task when run fails even if delete_after_run is 1', async () => {
    mockBackupStackFiles.mockRejectedValueOnce(new Error('disk full'));
    mockGetScheduledTask.mockReturnValue(makeLifecycleTask('auto_backup', { delete_after_run: 1 }));
    await SchedulerService.getInstance().triggerTask(300);
    expect(mockDeleteScheduledTask).not.toHaveBeenCalled();
    expect(mockUpdateScheduledTaskRun).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'failure' }));
  });

  it('does not delete task when delete_after_run is 0', async () => {
    mockGetScheduledTask.mockReturnValue(makeLifecycleTask('auto_backup', { delete_after_run: 0 }));
    await SchedulerService.getInstance().triggerTask(300);
    expect(mockDeleteScheduledTask).not.toHaveBeenCalled();
    expect(mockUpdateScheduledTask).toHaveBeenCalledWith(300, expect.objectContaining({ last_status: 'success' }));
  });
});
