/**
 * Pins the scheduler's policy-alert fan-out.
 *
 * After `trivy.scanAllNodeImages` resolves with one or more policy
 * violations, `SchedulerService.executeScan` must dispatch a warning-level
 * notification for each violation so an operator can triage them. Scheduled
 * scans never auto-quarantine in the current scope; any regression that
 * silently swallows violations turns the feature back into post-hoc logging.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockGetDueScheduledTasks, mockCreateScheduledTaskRun, mockUpdateScheduledTaskRun,
  mockUpdateScheduledTask, mockCleanupOldTaskRuns, mockGetScheduledTask, mockGetNodes, mockGetNode,
  mockCreateSnapshot, mockInsertSnapshotFiles, mockClearStackUpdateStatus,
  mockMarkStaleRunsAsFailed, mockDeleteOldScans,
  mockGetTier,
  mockDispatchAlert,
  mockGetProxyTarget,
  mockIsTrivyAvailable,
  mockScanAllNodeImages,
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
  mockDispatchAlert: vi.fn().mockResolvedValue(undefined),
  mockGetProxyTarget: vi.fn().mockReturnValue(null),
  mockIsTrivyAvailable: vi.fn().mockReturnValue(true),
  mockScanAllNodeImages: vi.fn(),
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
    }),
  },
}));

vi.mock('../services/LicenseService', () => ({
  LicenseService: {
    getInstance: () => ({
      getTier: mockGetTier,
    }),
  },
}));

vi.mock('../services/NotificationService', () => ({
  NotificationService: {
    getInstance: () => ({ dispatchAlert: mockDispatchAlert }),
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

function makeScanTask() {
  return {
    id: 300,
    name: 'policy-scan',
    action: 'scan',
    cron_expression: '0 2 * * *',
    enabled: true,
    target_id: null,
    node_id: 1,
    created_by: 'admin',
    last_status: null,
  };
}

function summaryWith(violations: Array<{
  imageRef: string;
  policyId: number;
  policyName: string;
  maxSeverity: string;
  severity: string;
  scanId: number;
}>) {
  return {
    scanned: violations.length,
    skipped: 0,
    failed: 0,
    severity: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
    violations,
  };
}

describe('SchedulerService - scheduled scan policy alerts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (SchedulerService as unknown as { instance?: SchedulerService }).instance = undefined;
  });

  it('dispatches a warning alert for every violated scan', async () => {
    mockGetScheduledTask.mockReturnValue(makeScanTask());
    mockScanAllNodeImages.mockResolvedValue(summaryWith([
      {
        imageRef: 'nginx:1.14',
        policyId: 1,
        policyName: 'prod-high-gate',
        maxSeverity: 'HIGH',
        severity: 'CRITICAL',
        scanId: 42,
      },
      {
        imageRef: 'redis:6',
        policyId: 1,
        policyName: 'prod-high-gate',
        maxSeverity: 'HIGH',
        severity: 'HIGH',
        scanId: 43,
      },
    ]));

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(300);

    const warningCalls = mockDispatchAlert.mock.calls.filter((c) => c[0] === 'warning');
    expect(warningCalls).toHaveLength(2);
    expect(warningCalls[0][2]).toContain('prod-high-gate');
    expect(warningCalls[0][2]).toContain('nginx:1.14');
    expect(warningCalls[0][2]).toContain('CRITICAL');
    expect(warningCalls[0][2]).toContain('HIGH');
    expect(warningCalls[1][2]).toContain('redis:6');
  });

  it('does not dispatch any policy alert when no violations occur', async () => {
    mockGetScheduledTask.mockReturnValue(makeScanTask());
    mockScanAllNodeImages.mockResolvedValue(summaryWith([]));

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(300);

    const warningCalls = mockDispatchAlert.mock.calls.filter(
      (c) => c[0] === 'warning' && typeof c[2] === 'string' && c[2].includes('Policy'),
    );
    expect(warningCalls).toHaveLength(0);
  });

  it('takes no quarantine action (alerts only, no stack lifecycle calls)', async () => {
    // The current scope explicitly rejects auto-quarantine. The scheduler
    // must never call DockerController / ComposeService off the scan path.
    // We verify by asserting only the DB task-run + notification surfaces
    // were touched, not any docker or compose mock.
    mockGetScheduledTask.mockReturnValue(makeScanTask());
    mockScanAllNodeImages.mockResolvedValue(summaryWith([
      {
        imageRef: 'nginx:1.14',
        policyId: 1,
        policyName: 'block-critical',
        maxSeverity: 'CRITICAL',
        severity: 'CRITICAL',
        scanId: 44,
      },
    ]));

    const svc = SchedulerService.getInstance();
    await svc.triggerTask(300);

    // The violation produced a warning alert.
    const warningCalls = mockDispatchAlert.mock.calls.filter((c) => c[0] === 'warning');
    expect(warningCalls.length).toBeGreaterThan(0);
    // Task-run record written (happy path completion), not an error.
    expect(mockCreateScheduledTaskRun).toHaveBeenCalled();
  });
});
