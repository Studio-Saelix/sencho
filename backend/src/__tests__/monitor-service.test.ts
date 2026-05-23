/**
 * Unit tests for MonitorService — alert state machine, metric calculations,
 * cleanup delegation, global settings evaluation, and concurrency guards.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────

const { mockGetGlobalSettings, mockGetNodes, mockGetStackAlerts, mockAddContainerMetric,
  mockCleanupOldMetrics, mockCleanupOldNotifications, mockCleanupOldAuditLogs,
  mockUpdateStackAlertLastFired, mockGetSystemState, mockSetSystemState,
  mockGetRunningContainers, mockGetAllContainers, mockGetContainerStatsStream,
  mockGetContainerRestartCount, mockGetDiskUsage,
  mockDispatchAlert,
  mockCurrentLoad, mockMem, mockFsSize,
  mockExecAsync,
  mockFetchLatestSenchoVersion,
  mockGetLatestVersion,
  mockGetSenchoVersion,
} = vi.hoisted(() => ({
  mockGetGlobalSettings: vi.fn().mockReturnValue({}),
  mockGetNodes: vi.fn().mockReturnValue([]),
  mockGetStackAlerts: vi.fn().mockReturnValue([]),
  mockAddContainerMetric: vi.fn(),
  mockCleanupOldMetrics: vi.fn(),
  mockCleanupOldNotifications: vi.fn(),
  mockCleanupOldAuditLogs: vi.fn(),
  mockUpdateStackAlertLastFired: vi.fn(),
  mockGetSystemState: vi.fn().mockReturnValue(null),
  mockSetSystemState: vi.fn(),
  mockGetRunningContainers: vi.fn().mockResolvedValue([]),
  mockGetAllContainers: vi.fn().mockResolvedValue([]),
  mockGetContainerStatsStream: vi.fn().mockResolvedValue('{}'),
  mockGetContainerRestartCount: vi.fn().mockResolvedValue(0),
  mockGetDiskUsage: vi.fn().mockResolvedValue({
    reclaimableImages: 0, reclaimableContainers: 0, reclaimableVolumes: 0, reclaimableBuildCache: 0,
    reclaimableImageCount: 0, reclaimableContainerCount: 0, reclaimableVolumeCount: 0, reclaimableBuildCacheCount: 0,
  }),
  mockDispatchAlert: vi.fn().mockResolvedValue(undefined),
  mockCurrentLoad: vi.fn().mockResolvedValue({ currentLoad: 10 }),
  mockMem: vi.fn().mockResolvedValue({ used: 4e9, total: 16e9 }),
  mockFsSize: vi.fn().mockResolvedValue([{ mount: '/', use: 30 }]),
  mockExecAsync: vi.fn().mockResolvedValue({ stdout: '' }),
  mockFetchLatestSenchoVersion: vi.fn().mockRejectedValue(new Error('not configured')),
  mockGetLatestVersion: vi.fn().mockResolvedValue(null),
  mockGetSenchoVersion: vi.fn().mockReturnValue(null),
}));

vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({
      getGlobalSettings: mockGetGlobalSettings,
      getNodes: mockGetNodes,
      getStackAlerts: mockGetStackAlerts,
      addContainerMetric: mockAddContainerMetric,
      cleanupOldMetrics: mockCleanupOldMetrics,
      cleanupOldNotifications: mockCleanupOldNotifications,
      cleanupOldAuditLogs: mockCleanupOldAuditLogs,
      updateStackAlertLastFired: mockUpdateStackAlertLastFired,
      getSystemState: mockGetSystemState,
      setSystemState: mockSetSystemState,
    }),
  },
}));

vi.mock('../services/DockerController', () => ({
  default: {
    getInstance: () => ({
      getRunningContainers: mockGetRunningContainers,
      getAllContainers: mockGetAllContainers,
      getContainerStatsStream: mockGetContainerStatsStream,
      getContainerRestartCount: mockGetContainerRestartCount,
      getDiskUsage: mockGetDiskUsage,
    }),
  },
}));

vi.mock('../utils/version-check', () => ({
  fetchLatestSenchoVersion: (...args: unknown[]) => mockFetchLatestSenchoVersion(...args),
  getLatestVersion: (...args: unknown[]) => mockGetLatestVersion(...args),
}));

vi.mock('../services/CapabilityRegistry', async () => {
  const semver = await import('semver');
  return {
    isValidVersion: (v: string | null | undefined): v is string =>
      !!v && v !== 'unknown' && v !== '0.0.0-dev' && !!semver.default.valid(v),
    getSenchoVersion: () => mockGetSenchoVersion(),
  };
});

vi.mock('../services/NotificationService', () => ({
  NotificationService: {
    getInstance: () => ({
      dispatchAlert: mockDispatchAlert,
    }),
  },
}));

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getDefaultNodeId: () => 1,
      getNode: () => ({ id: 1, name: 'local-test', type: 'local' }),
    }),
  },
}));

vi.mock('systeminformation', () => ({
  default: {
    currentLoad: (...args: unknown[]) => mockCurrentLoad(...args),
    mem: (...args: unknown[]) => mockMem(...args),
    fsSize: (...args: unknown[]) => mockFsSize(...args),
  },
}));

vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

vi.mock('util', () => ({
  promisify: () => mockExecAsync,
}));

import { MonitorService, _resetHostAlertSuppressionStateForTests } from '../services/MonitorService';

beforeEach(() => {
  vi.clearAllMocks();
  (MonitorService as any).instance = undefined;
  _resetHostAlertSuppressionStateForTests();
  mockGetSystemState.mockReturnValue(null);
});

// ── Pure calculation helpers (accessed via private method reflection) ───

describe('MonitorService - calculateCpuPercent', () => {
  function calcCpu(stats: any): number {
    const svc = MonitorService.getInstance();
    return (svc as any).calculateCpuPercent(stats);
  }

  it('returns correct percentage for normal stats', () => {
    const stats = {
      cpu_stats: { cpu_usage: { total_usage: 2000 }, system_cpu_usage: 10000, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 5000 },
    };
    // (1000 / 5000) * 4 * 100 = 80%
    expect(calcCpu(stats)).toBeCloseTo(80, 1);
  });

  it('returns 0 when cpu_stats is missing', () => {
    expect(calcCpu({})).toBe(0);
    expect(calcCpu(null)).toBe(0);
    expect(calcCpu({ cpu_stats: {} })).toBe(0);
  });

  it('returns 0 when systemDelta is zero', () => {
    const stats = {
      cpu_stats: { cpu_usage: { total_usage: 2000 }, system_cpu_usage: 5000, online_cpus: 1 },
      precpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 5000 },
    };
    expect(calcCpu(stats)).toBe(0);
  });

  it('accounts for online_cpus count', () => {
    const stats = {
      cpu_stats: { cpu_usage: { total_usage: 2000 }, system_cpu_usage: 10000, online_cpus: 8 },
      precpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 5000 },
    };
    // (1000/5000) * 8 * 100 = 160%
    expect(calcCpu(stats)).toBeCloseTo(160, 1);
  });

  it('falls back to percpu_usage length when online_cpus missing', () => {
    const stats = {
      cpu_stats: { cpu_usage: { total_usage: 2000, percpu_usage: [0, 0] }, system_cpu_usage: 10000 },
      precpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 5000 },
    };
    // (1000/5000) * 2 * 100 = 40%
    expect(calcCpu(stats)).toBeCloseTo(40, 1);
  });
});

describe('MonitorService - calculateMemoryPercent', () => {
  function calcMem(stats: any): number {
    const svc = MonitorService.getInstance();
    return (svc as any).calculateMemoryPercent(stats);
  }

  it('returns correct percentage subtracting cache', () => {
    const stats = {
      memory_stats: { usage: 500e6, limit: 1e9, stats: { cache: 100e6 } },
    };
    // (400e6 / 1e9) * 100 = 40%
    expect(calcMem(stats)).toBeCloseTo(40, 1);
  });

  it('returns 0 when memory_stats is missing', () => {
    expect(calcMem({})).toBe(0);
    expect(calcMem({ memory_stats: {} })).toBe(0);
  });

  it('returns 0 when limit is zero', () => {
    const stats = { memory_stats: { usage: 100, limit: 0 } };
    expect(calcMem(stats)).toBe(0);
  });

  it('handles missing cache field', () => {
    const stats = { memory_stats: { usage: 500e6, limit: 1e9 } };
    // No cache → (500e6 / 1e9) * 100 = 50%
    expect(calcMem(stats)).toBeCloseTo(50, 1);
  });
});

describe('MonitorService - calculateNetwork', () => {
  function calcNet(stats: any, dir: 'rx' | 'tx'): number {
    const svc = MonitorService.getInstance();
    return (svc as any).calculateNetwork(stats, dir);
  }

  it('sums rx_bytes across all interfaces', () => {
    const stats = {
      networks: {
        eth0: { rx_bytes: 1024 * 1024, tx_bytes: 0 },
        eth1: { rx_bytes: 2 * 1024 * 1024, tx_bytes: 0 },
      },
    };
    expect(calcNet(stats, 'rx')).toBeCloseTo(3, 0); // 3 MB
  });

  it('sums tx_bytes across all interfaces', () => {
    const stats = {
      networks: {
        eth0: { rx_bytes: 0, tx_bytes: 512 * 1024 },
      },
    };
    expect(calcNet(stats, 'tx')).toBeCloseTo(0.5, 1); // 0.5 MB
  });

  it('returns 0 when no networks present', () => {
    expect(calcNet({}, 'rx')).toBe(0);
    expect(calcNet({ networks: null }, 'tx')).toBe(0);
  });
});

describe('MonitorService - evaluateCondition', () => {
  function evalCond(actual: number, operator: string, threshold: number): boolean {
    const svc = MonitorService.getInstance();
    return (svc as any).evaluateCondition(actual, operator, threshold);
  }

  it('handles > operator', () => {
    expect(evalCond(81, '>', 80)).toBe(true);
    expect(evalCond(80, '>', 80)).toBe(false);
  });

  it('handles < operator', () => {
    expect(evalCond(79, '<', 80)).toBe(true);
    expect(evalCond(80, '<', 80)).toBe(false);
  });

  it('handles >= operator at boundary', () => {
    expect(evalCond(80, '>=', 80)).toBe(true);
    expect(evalCond(79, '>=', 80)).toBe(false);
  });

  it('handles <= operator at boundary', () => {
    expect(evalCond(80, '<=', 80)).toBe(true);
    expect(evalCond(81, '<=', 80)).toBe(false);
  });

  it('handles == operator', () => {
    expect(evalCond(80, '==', 80)).toBe(true);
    expect(evalCond(81, '==', 80)).toBe(false);
  });

  it('returns false for unknown operator', () => {
    expect(evalCond(80, '!=', 80)).toBe(false);
    expect(evalCond(80, 'foo', 80)).toBe(false);
  });
});

// ── Integration-level: evaluateGlobalSettings ──────────────────────────

describe('MonitorService - evaluateGlobalSettings', () => {
  it('dispatches CPU warning when over threshold', async () => {
    mockGetGlobalSettings.mockReturnValue({ host_cpu_limit: '50' });
    mockCurrentLoad.mockResolvedValue({ currentLoad: 75 });

    const svc = MonitorService.getInstance();
    await (svc as any).evaluateGlobalSettings({ host_cpu_limit: '50' });

    expect(mockDispatchAlert).toHaveBeenCalledWith('warning', 'monitor_alert', expect.stringContaining('CPU'));
  });

  it('does not dispatch when CPU below threshold', async () => {
    mockCurrentLoad.mockResolvedValue({ currentLoad: 25 });

    const svc = MonitorService.getInstance();
    await (svc as any).evaluateGlobalSettings({ host_cpu_limit: '50' });

    expect(mockDispatchAlert).not.toHaveBeenCalledWith('warning', 'monitor_alert', expect.stringContaining('CPU'));
  });

  it('dispatches RAM warning when over threshold', async () => {
    mockMem.mockResolvedValue({ used: 15e9, total: 16e9 }); // ~94%

    const svc = MonitorService.getInstance();
    await (svc as any).evaluateGlobalSettings({ host_ram_limit: '80' });

    expect(mockDispatchAlert).toHaveBeenCalledWith('warning', 'monitor_alert', expect.stringContaining('Memory'));
  });

  it('dispatches disk warning when over threshold', async () => {
    mockFsSize.mockResolvedValue([{ mount: '/', use: 92 }]);

    const svc = MonitorService.getInstance();
    await (svc as any).evaluateGlobalSettings({ host_disk_limit: '90' });

    expect(mockDispatchAlert).toHaveBeenCalledWith('warning', 'monitor_alert', expect.stringContaining('Disk'));
  });

  it('skips host limits when threshold is 0 or NaN', async () => {
    mockCurrentLoad.mockResolvedValue({ currentLoad: 99 });

    const svc = MonitorService.getInstance();
    await (svc as any).evaluateGlobalSettings({ host_cpu_limit: '0' });
    expect(mockDispatchAlert).not.toHaveBeenCalledWith('warning', 'monitor_alert', expect.stringContaining('CPU'));

    await (svc as any).evaluateGlobalSettings({ host_cpu_limit: 'abc' });
    expect(mockDispatchAlert).not.toHaveBeenCalledWith('warning', 'monitor_alert', expect.stringContaining('CPU'));
  });
});

// Crash + healthcheck detection now lives in DockerEventService (event-driven).
// Tests for those flows live in docker-event-service.test.ts.

// ── F-11: host-metric alert suppression ────────────────────────────────

describe('MonitorService - host alert suppression (F-11)', () => {
  // Force RAM-over-threshold for every test in this block; CPU/disk are
  // independently controlled per-test so a single mockMem set-up covers the
  // common "I want a breach happening" case without test repetition.
  beforeEach(() => {
    mockMem.mockResolvedValue({ used: 15e9, total: 16e9 }); // ~94%
  });

  it('first breach dispatches immediately', async () => {
    const svc = MonitorService.getInstance();
    await (svc as any).evaluateGlobalSettings({ host_ram_limit: '80' });

    expect(mockDispatchAlert).toHaveBeenCalledTimes(1);
    const [, , message] = mockDispatchAlert.mock.calls[0];
    expect(message).toContain('Memory');
    expect(message).not.toContain('Suppressed');
  });

  it('second breach within window does not dispatch', async () => {
    const svc = MonitorService.getInstance();
    const baseTime = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseTime);

    await (svc as any).evaluateGlobalSettings({ host_ram_limit: '80' });
    expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

    // 30 seconds later — well inside the 60-minute default window.
    nowSpy.mockReturnValue(baseTime + 30_000);
    await (svc as any).evaluateGlobalSettings({ host_ram_limit: '80' });
    expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

    nowSpy.mockRestore();
  });

  it('many breaches within window accumulate count without dispatching', async () => {
    const svc = MonitorService.getInstance();
    const baseTime = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseTime);

    await (svc as any).evaluateGlobalSettings({ host_ram_limit: '80' });
    for (let i = 1; i < 10; i++) {
      nowSpy.mockReturnValue(baseTime + i * 30_000);
      await (svc as any).evaluateGlobalSettings({ host_ram_limit: '80' });
    }

    expect(mockDispatchAlert).toHaveBeenCalledTimes(1);
    nowSpy.mockRestore();
  });

  it('breach after window elapses dispatches follow-up with count summary and persists new timestamp', async () => {
    const svc = MonitorService.getInstance();
    const baseTime = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseTime);

    // First dispatch.
    await (svc as any).evaluateGlobalSettings({ host_ram_limit: '80' });
    expect(mockDispatchAlert).toHaveBeenCalledTimes(1);
    expect(mockSetSystemState).toHaveBeenCalledWith('last_host_ram_alert_ts', String(baseTime));

    // 5 cycles inside the window, each suppressed.
    for (let i = 1; i <= 5; i++) {
      nowSpy.mockReturnValue(baseTime + i * 30_000);
      await (svc as any).evaluateGlobalSettings({ host_ram_limit: '80' });
    }
    expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

    // Jump past the suppression window — 61 minutes.
    const followUpTime = baseTime + 61 * 60 * 1000;
    nowSpy.mockReturnValue(followUpTime);
    mockSetSystemState.mockClear();
    await (svc as any).evaluateGlobalSettings({ host_ram_limit: '80' });

    expect(mockDispatchAlert).toHaveBeenCalledTimes(2);
    const [, , followUpMessage] = mockDispatchAlert.mock.calls[1];
    expect(followUpMessage).toMatch(/Suppressed 5 alerts in the last \d+m/);
    expect(followUpMessage).toMatch(/first over threshold at \d{2}:\d{2} UTC/);
    // Follow-up dispatch must persist the new timestamp so a subsequent
    // restart-survivability seed picks up the most-recent fire, not the
    // pre-window first fire (otherwise a restart 30min later would see a
    // 90min-old persisted row and re-fire immediately).
    expect(mockSetSystemState).toHaveBeenCalledWith('last_host_ram_alert_ts', String(followUpTime));

    nowSpy.mockRestore();
  });

  it('dispatches at exactly the suppression window boundary', async () => {
    const svc = MonitorService.getInstance();
    const baseTime = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseTime);

    await (svc as any).evaluateGlobalSettings({ host_ram_limit: '80' });
    expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

    // Exactly 60 minutes later — at the boundary. The check is `<`, so the
    // boundary tick should DISPATCH a follow-up rather than suppress.
    nowSpy.mockReturnValue(baseTime + 60 * 60 * 1000);
    await (svc as any).evaluateGlobalSettings({ host_ram_limit: '80' });
    expect(mockDispatchAlert).toHaveBeenCalledTimes(2);

    nowSpy.mockRestore();
  });

  it('follow-up summary uses singular "alert" when exactly one cycle was suppressed', async () => {
    const svc = MonitorService.getInstance();
    const baseTime = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseTime);

    await (svc as any).evaluateGlobalSettings({ host_ram_limit: '80' });
    expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

    // One suppressed cycle.
    nowSpy.mockReturnValue(baseTime + 30_000);
    await (svc as any).evaluateGlobalSettings({ host_ram_limit: '80' });

    // Past window.
    nowSpy.mockReturnValue(baseTime + 61 * 60 * 1000);
    await (svc as any).evaluateGlobalSettings({ host_ram_limit: '80' });

    expect(mockDispatchAlert).toHaveBeenCalledTimes(2);
    const [, , followUpMessage] = mockDispatchAlert.mock.calls[1];
    expect(followUpMessage).toContain('Suppressed 1 alert in the last');
    expect(followUpMessage).not.toContain('Suppressed 1 alerts'); // singular form, not plural

    nowSpy.mockRestore();
  });

  it('disk-metric path dispatches and suppresses through the same mechanism', async () => {
    const svc = MonitorService.getInstance();
    mockFsSize.mockResolvedValue([{ mount: '/', use: 95 }]);
    // Set RAM below threshold so it does not interfere with the disk-only assertions.
    mockMem.mockResolvedValue({ used: 4e9, total: 16e9 });
    const baseTime = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseTime);

    await (svc as any).evaluateGlobalSettings({ host_disk_limit: '80' });
    expect(mockDispatchAlert).toHaveBeenCalledTimes(1);
    expect((mockDispatchAlert.mock.calls[0][2] as string)).toContain('Disk');

    nowSpy.mockReturnValue(baseTime + 30_000);
    await (svc as any).evaluateGlobalSettings({ host_disk_limit: '80' });
    expect(mockDispatchAlert).toHaveBeenCalledTimes(1); // suppressed

    nowSpy.mockRestore();
  });

  it('metric drop below threshold clears in-memory state and persisted timestamp', async () => {
    const svc = MonitorService.getInstance();

    await (svc as any).evaluateGlobalSettings({ host_ram_limit: '80' });
    expect(mockDispatchAlert).toHaveBeenCalledTimes(1);
    expect(mockSetSystemState).toHaveBeenCalledWith('last_host_ram_alert_ts', expect.any(String));

    // Drop RAM back under threshold.
    mockMem.mockResolvedValue({ used: 4e9, total: 16e9 }); // 25%
    mockSetSystemState.mockClear();
    await (svc as any).evaluateGlobalSettings({ host_ram_limit: '80' });

    // Recovery branch resets the persisted timestamp to '0'.
    expect(mockSetSystemState).toHaveBeenCalledWith('last_host_ram_alert_ts', '0');
  });

  it('re-breach after recovery fires fresh first alert (no Suppressed suffix)', async () => {
    const svc = MonitorService.getInstance();

    // Initial breach.
    await (svc as any).evaluateGlobalSettings({ host_ram_limit: '80' });
    expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

    // Recovery.
    mockMem.mockResolvedValue({ used: 4e9, total: 16e9 });
    await (svc as any).evaluateGlobalSettings({ host_ram_limit: '80' });

    // Re-breach.
    mockMem.mockResolvedValue({ used: 15e9, total: 16e9 });
    await (svc as any).evaluateGlobalSettings({ host_ram_limit: '80' });

    expect(mockDispatchAlert).toHaveBeenCalledTimes(2);
    const [, , reBreachMessage] = mockDispatchAlert.mock.calls[1];
    expect(reBreachMessage).not.toContain('Suppressed');
  });

  it('CPU and RAM suppression states are isolated per metric', async () => {
    const svc = MonitorService.getInstance();
    mockCurrentLoad.mockResolvedValue({ currentLoad: 95 });

    // First cycle: both fire.
    await (svc as any).evaluateGlobalSettings({ host_cpu_limit: '80', host_ram_limit: '80' });
    expect(mockDispatchAlert).toHaveBeenCalledTimes(2);

    const messages1 = mockDispatchAlert.mock.calls.map(c => c[2] as string);
    expect(messages1.some(m => m.includes('CPU'))).toBe(true);
    expect(messages1.some(m => m.includes('Memory'))).toBe(true);

    // Second cycle: both suppressed.
    await (svc as any).evaluateGlobalSettings({ host_cpu_limit: '80', host_ram_limit: '80' });
    expect(mockDispatchAlert).toHaveBeenCalledTimes(2);

    // CPU drops below threshold (recovers); RAM stays high.
    mockCurrentLoad.mockResolvedValue({ currentLoad: 10 });
    await (svc as any).evaluateGlobalSettings({ host_cpu_limit: '80', host_ram_limit: '80' });

    // CPU re-breaches; RAM still in suppression window.
    mockCurrentLoad.mockResolvedValue({ currentLoad: 95 });
    await (svc as any).evaluateGlobalSettings({ host_cpu_limit: '80', host_ram_limit: '80' });

    // CPU fires fresh; RAM stays silent.
    expect(mockDispatchAlert).toHaveBeenCalledTimes(3);
    const newCpuMessage = mockDispatchAlert.mock.calls[2][2] as string;
    expect(newCpuMessage).toContain('CPU');
    expect(newCpuMessage).not.toContain('Suppressed');
  });

  it('respects custom host_alert_suppression_mins setting (5 minutes)', async () => {
    const svc = MonitorService.getInstance();
    const baseTime = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseTime);

    await (svc as any).evaluateGlobalSettings({ host_ram_limit: '80', host_alert_suppression_mins: '5' });
    expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

    // 3 minutes — still within custom 5-minute window.
    nowSpy.mockReturnValue(baseTime + 3 * 60 * 1000);
    await (svc as any).evaluateGlobalSettings({ host_ram_limit: '80', host_alert_suppression_mins: '5' });
    expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

    // 6 minutes — past the custom window; follow-up should fire.
    nowSpy.mockReturnValue(baseTime + 6 * 60 * 1000);
    await (svc as any).evaluateGlobalSettings({ host_ram_limit: '80', host_alert_suppression_mins: '5' });
    expect(mockDispatchAlert).toHaveBeenCalledTimes(2);

    nowSpy.mockRestore();
  });

  it('post-restart with persisted timestamp inside window does not re-fire', async () => {
    const baseTime = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseTime + 10 * 60 * 1000); // "now" = T+10min

    // Simulate a previous process having persisted a fire 10 minutes ago.
    mockGetSystemState.mockImplementation((key: string) =>
      key === 'last_host_ram_alert_ts' ? String(baseTime) : null,
    );

    const svc = MonitorService.getInstance();
    await (svc as any).evaluateGlobalSettings({ host_ram_limit: '80' });

    // Post-restart cycle must NOT re-fire because the persisted cooldown
    // is still active (10 min into the default 60 min window).
    expect(mockDispatchAlert).not.toHaveBeenCalled();

    nowSpy.mockRestore();
  });

  it('zero or negative suppression_mins falls back to default', async () => {
    const svc = MonitorService.getInstance();
    const baseTime = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseTime);

    await (svc as any).evaluateGlobalSettings({ host_ram_limit: '80', host_alert_suppression_mins: '0' });
    expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

    // Default 60-minute window applies — a cycle 30 minutes later stays
    // suppressed even though the setting said 0.
    nowSpy.mockReturnValue(baseTime + 30 * 60 * 1000);
    await (svc as any).evaluateGlobalSettings({ host_ram_limit: '80', host_alert_suppression_mins: '0' });
    expect(mockDispatchAlert).toHaveBeenCalledTimes(1);

    nowSpy.mockRestore();
  });
});

// ── Alert breach state machine ─────────────────────────────────────────

describe('MonitorService - breach state machine', () => {
  function setupAlertScenario(cpuPercent: number) {
    mockGetNodes.mockReturnValue([{ id: 1, name: 'local', type: 'local' }]);
    mockGetRunningContainers.mockResolvedValue([{
      Id: 'c1',
      Labels: { 'com.docker.compose.project': 'my-stack' },
    }]);
    mockGetContainerStatsStream.mockResolvedValue(JSON.stringify({
      cpu_stats: { cpu_usage: { total_usage: 1000 + cpuPercent * 50 }, system_cpu_usage: 10000, online_cpus: 1 },
      precpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 5000 },
      memory_stats: { usage: 100e6, limit: 1e9 },
    }));
    mockGetStackAlerts.mockReturnValue([{
      id: 1,
      stack_name: 'my-stack',
      metric: 'cpu_percent',
      operator: '>',
      threshold: 80,
      duration_mins: 0, // Fire immediately on breach
      cooldown_mins: 60,
      last_fired_at: 0,
    }]);
    mockGetGlobalSettings.mockReturnValue({});
  }

  it('fires alert when condition met and duration is 0', async () => {
    setupAlertScenario(90); // Will produce CPU > 80%

    const svc = MonitorService.getInstance();
    await (svc as any).evaluate();

    expect(mockDispatchAlert).toHaveBeenCalledWith('warning', 'monitor_alert', expect.stringContaining('CPU'), { stackName: 'my-stack' });
    expect(mockUpdateStackAlertLastFired).toHaveBeenCalledWith(1, expect.any(Number));
  });

  it('does not fire when condition not met', async () => {
    setupAlertScenario(10); // Will produce CPU < 80%

    const svc = MonitorService.getInstance();
    await (svc as any).evaluate();

    expect(mockDispatchAlert).not.toHaveBeenCalledWith('warning', expect.stringContaining('CPU'));
  });

  it('respects cooldown after firing', async () => {
    setupAlertScenario(90);
    // Simulate that alert was fired 30 minutes ago (within 60-min cooldown)
    mockGetStackAlerts.mockReturnValue([{
      id: 1,
      stack_name: 'my-stack',
      metric: 'cpu_percent',
      operator: '>',
      threshold: 80,
      duration_mins: 0,
      cooldown_mins: 60,
      last_fired_at: Date.now() - 30 * 60 * 1000,
    }]);

    const svc = MonitorService.getInstance();
    await (svc as any).evaluate();

    expect(mockUpdateStackAlertLastFired).not.toHaveBeenCalled();
  });

  it('resets breach state when condition clears', async () => {
    const svc = MonitorService.getInstance();

    // First: breach starts
    setupAlertScenario(90);
    mockGetStackAlerts.mockReturnValue([{
      id: 42,
      stack_name: 'my-stack',
      metric: 'cpu_percent',
      operator: '>',
      threshold: 80,
      duration_mins: 999, // Won't fire due to long duration
      cooldown_mins: 0,
      last_fired_at: 0,
    }]);
    await (svc as any).evaluate();
    expect((svc as any).activeBreaches.has(42)).toBe(true);

    // Second: condition clears
    setupAlertScenario(10);
    mockGetStackAlerts.mockReturnValue([{
      id: 42,
      stack_name: 'my-stack',
      metric: 'cpu_percent',
      operator: '>',
      threshold: 80,
      duration_mins: 999,
      cooldown_mins: 0,
      last_fired_at: 0,
    }]);
    await (svc as any).evaluate();
    expect((svc as any).activeBreaches.has(42)).toBe(false);
  });
});

// ── Cleanup triggers ───────────────────────────────────────────────────

describe('MonitorService - cleanup triggers', () => {
  it('calls cleanup methods with configured retention', async () => {
    mockGetNodes.mockReturnValue([]);
    mockGetStackAlerts.mockReturnValue([]);
    mockGetGlobalSettings.mockReturnValue({
      metrics_retention_hours: '48',
      log_retention_days: '7',
      audit_retention_days: '30',
    });

    const svc = MonitorService.getInstance();
    await (svc as any).evaluate();

    expect(mockCleanupOldMetrics).toHaveBeenCalledWith(48);
    expect(mockCleanupOldNotifications).toHaveBeenCalledWith(7);
    expect(mockCleanupOldAuditLogs).toHaveBeenCalledWith(30);
  });

  it('uses defaults when settings are NaN', async () => {
    mockGetNodes.mockReturnValue([]);
    mockGetStackAlerts.mockReturnValue([]);
    mockGetGlobalSettings.mockReturnValue({
      metrics_retention_hours: 'bad',
      log_retention_days: 'bad',
      audit_retention_days: 'bad',
    });

    const svc = MonitorService.getInstance();
    await (svc as any).evaluate();

    expect(mockCleanupOldMetrics).toHaveBeenCalledWith(24);
    expect(mockCleanupOldNotifications).toHaveBeenCalledWith(30);
    expect(mockCleanupOldAuditLogs).toHaveBeenCalledWith(90);
  });
});

// ── isProcessing guard ─────────────────────────────────────────────────

describe('MonitorService - isProcessing guard', () => {
  it('skips evaluation if already processing', async () => {
    mockGetGlobalSettings.mockReturnValue({});
    mockGetNodes.mockReturnValue([]);
    mockGetStackAlerts.mockReturnValue([]);

    const svc = MonitorService.getInstance();
    (svc as any).isProcessing = true;

    await (svc as any).evaluate();

    // Should have been skipped — no DB calls
    expect(mockGetGlobalSettings).not.toHaveBeenCalled();
  });

  it('resets isProcessing after evaluate completes (even on error)', async () => {
    mockGetGlobalSettings.mockImplementationOnce(() => { throw new Error('boom'); });

    const svc = MonitorService.getInstance();
    await (svc as any).evaluate();

    // isProcessing should be reset in finally block
    expect((svc as any).isProcessing).toBe(false);
  });
});

// ── restart_count metric ──────────────────────────────────────────────

describe('MonitorService - restart_count metric', () => {
  function setupRestartScenario(restartCount: number, hasRestartRule: boolean) {
    mockGetNodes.mockReturnValue([{ id: 1, name: 'local', type: 'local' }]);
    mockGetRunningContainers.mockResolvedValue([{
      Id: 'c1',
      Labels: { 'com.docker.compose.project': 'my-stack' },
    }]);
    mockGetContainerStatsStream.mockResolvedValue(JSON.stringify({
      cpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 5000, online_cpus: 1 },
      precpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 5000 },
      memory_stats: { usage: 100e6, limit: 1e9 },
    }));
    mockGetContainerRestartCount.mockResolvedValue(restartCount);
    const alerts = [];
    if (hasRestartRule) {
      alerts.push({
        id: 100,
        stack_name: 'my-stack',
        metric: 'restart_count',
        operator: '>',
        threshold: 3,
        duration_mins: 0,
        cooldown_mins: 60,
        last_fired_at: 0,
      });
    }
    mockGetStackAlerts.mockReturnValue(alerts);
    mockGetGlobalSettings.mockReturnValue({});
  }

  it('fetches restart count from Docker when a restart_count rule exists', async () => {
    setupRestartScenario(5, true);

    const svc = MonitorService.getInstance();
    await (svc as any).evaluate();

    expect(mockGetContainerRestartCount).toHaveBeenCalledWith('c1');
    // restart_count=5 > threshold=3, should fire
    expect(mockDispatchAlert).toHaveBeenCalledWith('warning', 'monitor_alert', expect.stringContaining('Restart count'), { stackName: 'my-stack' });
  });

  it('skips Docker inspect when no restart_count rules exist', async () => {
    setupRestartScenario(5, false);

    const svc = MonitorService.getInstance();
    await (svc as any).evaluate();

    expect(mockGetContainerRestartCount).not.toHaveBeenCalled();
  });

  it('does not fire when restart count is below threshold', async () => {
    setupRestartScenario(2, true);

    const svc = MonitorService.getInstance();
    await (svc as any).evaluate();

    expect(mockGetContainerRestartCount).toHaveBeenCalledWith('c1');
    expect(mockDispatchAlert).not.toHaveBeenCalledWith('warning', 'monitor_alert', expect.stringContaining('Restart count'), expect.anything());
  });
});

// ── Sencho version update check ───────────────────────────────────────

describe('MonitorService - Sencho version check', () => {
  /** Stateful system_state backing for tests that need getSystemState to
   *  reflect setSystemState writes within the same evaluation. */
  function wireStatefulSystemState(seed: Record<string, string> = {}) {
    const store: Record<string, string> = { ...seed };
    mockGetSystemState.mockImplementation((key: string) => store[key] ?? null);
    mockSetSystemState.mockImplementation((key: string, value: string) => { store[key] = value; });
    return store;
  }

  beforeEach(() => {
    mockGetGlobalSettings.mockReturnValue({});
    mockGetNodes.mockReturnValue([]);
    mockGetStackAlerts.mockReturnValue([]);
  });

  it('dispatches notification when newer version available', async () => {
    mockGetSenchoVersion.mockReturnValue('0.45.0');
    mockGetLatestVersion.mockResolvedValue('0.46.0');
    mockGetSystemState.mockReturnValue(null); // No previous notification

    const svc = MonitorService.getInstance();
    // Reset the version check timer so it runs immediately
    (svc as any).lastVersionCheckAt = 0;
    await (svc as any).evaluate();

    expect(mockDispatchAlert).toHaveBeenCalledWith('info', 'system', expect.stringContaining('0.46.0'));
    // Message must include the real running version, not "0.0.0".
    expect(mockDispatchAlert).toHaveBeenCalledWith('info', 'system', expect.stringContaining('currently running 0.45.0'));
    expect(mockSetSystemState).toHaveBeenCalledWith('last_sencho_update_notified_version', '0.46.0');
  });

  it('does not re-notify for the same version', async () => {
    mockGetSenchoVersion.mockReturnValue('0.45.0');
    mockGetLatestVersion.mockResolvedValue('0.46.0');
    // Running version < last notified, so self-heal does NOT clear the key.
    mockGetSystemState.mockReturnValue('0.46.0');

    const svc = MonitorService.getInstance();
    (svc as any).lastVersionCheckAt = 0;
    await (svc as any).evaluate();

    expect(mockDispatchAlert).not.toHaveBeenCalledWith('info', 'system', expect.stringContaining('0.46.0'));
  });

  it('handles version check failure gracefully', async () => {
    mockGetSenchoVersion.mockReturnValue('0.45.0');
    mockGetLatestVersion.mockResolvedValue(null); // CacheService failed + no stale

    const svc = MonitorService.getInstance();
    (svc as any).lastVersionCheckAt = 0;

    // Should not throw
    await expect((svc as any).evaluate()).resolves.toBeUndefined();
    expect(mockDispatchAlert).not.toHaveBeenCalledWith('info', 'system', expect.stringContaining('available'));
  });

  it('respects the 6-hour cooldown interval', async () => {
    mockGetSenchoVersion.mockReturnValue('0.45.0');
    mockGetLatestVersion.mockResolvedValue('0.46.0');
    mockGetSystemState.mockReturnValue(null);

    const svc = MonitorService.getInstance();
    // Simulate the check ran 1 hour ago (within 6-hour window)
    (svc as any).lastVersionCheckAt = Date.now() - 1 * 60 * 60 * 1000;
    await (svc as any).evaluate();

    // getLatestVersion should not have been called since we're within cooldown
    expect(mockGetLatestVersion).not.toHaveBeenCalled();
  });

  it('skips version check when getSenchoVersion returns null', async () => {
    // Simulates the production-Docker scenario that previously leaked "0.0.0"
    mockGetSenchoVersion.mockReturnValue(null);
    mockGetLatestVersion.mockResolvedValue('0.46.0');
    mockGetSystemState.mockReturnValue(null);

    const svc = MonitorService.getInstance();
    (svc as any).lastVersionCheckAt = 0;
    await (svc as any).evaluate();

    expect(mockDispatchAlert).not.toHaveBeenCalledWith('info', 'system', expect.stringContaining('0.46.0'));
    expect(mockSetSystemState).not.toHaveBeenCalledWith('last_sencho_update_notified_version', expect.anything());
    // Should not have even attempted the lookup.
    expect(mockGetLatestVersion).not.toHaveBeenCalled();
  });

  // ── Regression coverage for PR: cooldown leak + dedup self-heal ───────

  it('does NOT advance cooldown when getLatestVersion returns null (retries next cycle)', async () => {
    mockGetSenchoVersion.mockReturnValue('0.45.0');
    mockGetLatestVersion.mockResolvedValue(null);
    mockGetSystemState.mockReturnValue(null);

    const svc = MonitorService.getInstance();
    (svc as any).lastVersionCheckAt = 0;

    await (svc as any).evaluate();
    await (svc as any).evaluate();

    // Both evals should attempt the lookup since failures do not lock cooldown.
    expect(mockGetLatestVersion).toHaveBeenCalledTimes(2);
    expect((svc as any).lastVersionCheckAt).toBe(0);
  });

  it('DOES advance cooldown on a successful lookup (prevents re-fetch inside window)', async () => {
    mockGetSenchoVersion.mockReturnValue('0.45.0');
    mockGetLatestVersion.mockResolvedValue('0.46.0');
    mockGetSystemState.mockReturnValue(null);

    const svc = MonitorService.getInstance();
    (svc as any).lastVersionCheckAt = 0;

    await (svc as any).evaluate();
    const firstCooldown = (svc as any).lastVersionCheckAt;
    expect(firstCooldown).toBeGreaterThan(0);

    // Second eval immediately after: cooldown gate should block it.
    mockGetLatestVersion.mockClear();
    await (svc as any).evaluate();

    expect(mockGetLatestVersion).not.toHaveBeenCalled();
    // Exactly one dispatch across both evals.
    const availabilityDispatches = mockDispatchAlert.mock.calls.filter(
      (args: unknown[]) => typeof args[2] === 'string' && args[2].includes('available'),
    );
    expect(availabilityDispatches).toHaveLength(1);
  });

  it('self-heals dedup after user upgrades to the previously-notified version', async () => {
    // Prior notification stored "0.46.0" back when the user was on 0.45.0.
    // User has now upgraded to 0.46.0; a new release (0.47.0) just dropped.
    const store = wireStatefulSystemState({ last_sencho_update_notified_version: '0.46.0' });
    mockGetSenchoVersion.mockReturnValue('0.46.0');
    mockGetLatestVersion.mockResolvedValue('0.47.0');

    const svc = MonitorService.getInstance();
    (svc as any).lastVersionCheckAt = 0;
    await (svc as any).evaluate();

    expect(mockDispatchAlert).toHaveBeenCalledWith('info', 'system', expect.stringContaining('0.47.0'));
    expect(store.last_sencho_update_notified_version).toBe('0.47.0');
  });
});

// ── Per-container parallel fan-out ────────────────────────────────────

describe('MonitorService - parallel container processing', () => {
  /** Build a stats payload that yields a positive CPU percent so the
   *  metric pipeline runs end-to-end (calculateCpuPercent + DB write). */
  function statsPayload(): string {
    return JSON.stringify({
      cpu_stats: { cpu_usage: { total_usage: 2000 }, system_cpu_usage: 10000, online_cpus: 1 },
      precpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 5000 },
      memory_stats: { usage: 100e6, limit: 1e9 },
    });
  }

  beforeEach(() => {
    mockGetGlobalSettings.mockReturnValue({});
    mockGetStackAlerts.mockReturnValue([]);
    mockGetNodes.mockReturnValue([{ id: 1, name: 'local', type: 'local' }]);
  });

  it('fans out per-container stats fetches in parallel (wall time ~ max not sum)', async () => {
    const containerCount = 10;
    const perCallDelayMs = 200;
    const containers = Array.from({ length: containerCount }, (_, i) => ({
      Id: `container-${i}`,
      Labels: { 'com.docker.compose.project': 'stack-x' },
    }));
    mockGetRunningContainers.mockResolvedValue(containers);
    mockGetContainerStatsStream.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(statsPayload()), perCallDelayMs)),
    );

    const svc = MonitorService.getInstance();
    const start = Date.now();
    await (svc as any).evaluate();
    const elapsed = Date.now() - start;

    // Serial would be containerCount * perCallDelayMs = 2000ms; parallel
    // collapses to ~perCallDelayMs plus a little dispatch overhead. Allow
    // generous headroom (3x the per-call delay) to avoid CI flake.
    expect(elapsed).toBeLessThan(perCallDelayMs * 3);
    // All containers were processed: one stats call and one metric write each.
    expect(mockGetContainerStatsStream).toHaveBeenCalledTimes(containerCount);
    expect(mockAddContainerMetric).toHaveBeenCalledTimes(containerCount);
  });

  it('isolates per-container failures: one rejection does not abort siblings', async () => {
    const containers = Array.from({ length: 5 }, (_, i) => ({
      Id: `container-${i}`,
      Labels: { 'com.docker.compose.project': 'stack-x' },
    }));
    mockGetRunningContainers.mockResolvedValue(containers);
    mockGetContainerStatsStream.mockImplementation(async (id: string) => {
      if (id === 'container-2') {
        const err = Object.assign(new Error('no such container'), { statusCode: 404 });
        throw err;
      }
      return statsPayload();
    });

    const svc = MonitorService.getInstance();
    await (svc as any).evaluate();

    // 4 successful containers each wrote a metric; the 404 container is silently skipped.
    expect(mockAddContainerMetric).toHaveBeenCalledTimes(4);
  });

  it('dispatches a stack alert exactly once per cycle even when multiple containers in the stack breach', async () => {
    // 5 containers in the same stack, all breaching the same rule. Without
    // the per-cycle dedup, parallel workers race past the cooldown check
    // and each fire dispatchAlert before any DB write lands.
    const containers = Array.from({ length: 5 }, (_, i) => ({
      Id: `container-${i}`,
      Labels: { 'com.docker.compose.project': 'shared-stack' },
    }));
    mockGetRunningContainers.mockResolvedValue(containers);
    mockGetContainerStatsStream.mockResolvedValue(JSON.stringify({
      // Produces CPU = 90% to breach threshold of 80%.
      cpu_stats: { cpu_usage: { total_usage: 5500 }, system_cpu_usage: 10000, online_cpus: 1 },
      precpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 5000 },
      memory_stats: { usage: 100e6, limit: 1e9 },
    }));
    mockGetStackAlerts.mockReturnValue([{
      id: 7,
      stack_name: 'shared-stack',
      metric: 'cpu_percent',
      operator: '>',
      threshold: 80,
      duration_mins: 0,
      cooldown_mins: 60,
      last_fired_at: 0,
    }]);

    const svc = MonitorService.getInstance();
    await (svc as any).evaluate();

    const cpuDispatches = mockDispatchAlert.mock.calls.filter(
      (args: unknown[]) => args[1] === 'monitor_alert' && typeof args[2] === 'string' && args[2].includes('CPU'),
    );
    expect(cpuDispatches).toHaveLength(1);
    expect(mockUpdateStackAlertLastFired).toHaveBeenCalledTimes(1);
  });

  it('caps simultaneous Docker calls at MAX_CONTAINER_CONCURRENCY', async () => {
    // 25 containers with a long per-call delay; observe that no more than
    // 10 (MAX_CONTAINER_CONCURRENCY) are in flight at the same time.
    const containerCount = 25;
    const perCallDelayMs = 100;
    let inFlight = 0;
    let peakInFlight = 0;
    const containers = Array.from({ length: containerCount }, (_, i) => ({
      Id: `container-${i}`,
      Labels: { 'com.docker.compose.project': 'stack-x' },
    }));
    mockGetRunningContainers.mockResolvedValue(containers);
    mockGetContainerStatsStream.mockImplementation(
      () => new Promise((resolve) => {
        inFlight += 1;
        if (inFlight > peakInFlight) peakInFlight = inFlight;
        setTimeout(() => {
          inFlight -= 1;
          resolve(statsPayload());
        }, perCallDelayMs);
      }),
    );

    const svc = MonitorService.getInstance();
    await (svc as any).evaluate();

    expect(peakInFlight).toBeLessThanOrEqual(10);
    // And we still saw real concurrency (not serialized), so peak should be
    // close to the cap when we have many more items than workers.
    expect(peakInFlight).toBeGreaterThan(1);
    expect(mockAddContainerMetric).toHaveBeenCalledTimes(containerCount);
  });
});

// ── Janitor cycle and circuit breaker (F-6) ────────────────────────────

describe('MonitorService - janitor cycle and circuit breaker', () => {
  // Convenience: builds a never-settling promise used to simulate a hung df().
  function hangForever(): Promise<never> {
    return new Promise<never>(() => { /* never resolves */ });
  }

  // Reclaimable payload large enough to cross a 0.5 GB janitor threshold.
  const RECLAIMABLE_3GB = {
    reclaimableImages: 3 * 1024 * 1024 * 1024,
    reclaimableContainers: 0,
    reclaimableVolumes: 0,
    reclaimableBuildCache: 0,
    reclaimableImageCount: 5,
    reclaimableContainerCount: 0,
    reclaimableVolumeCount: 0,
    reclaimableBuildCacheCount: 0,
  };

  it('evaluate() does NOT call getDiskUsage (decoupling guardrail)', async () => {
    // F-6 regression guard: the 30s monitor cycle must never call df().
    // If someone re-couples the janitor into evaluate(), this test fails.
    mockGetGlobalSettings.mockReturnValue({ docker_janitor_gb: '0.5' });
    mockGetNodes.mockReturnValue([]);
    mockGetStackAlerts.mockReturnValue([]);

    const svc = MonitorService.getInstance();
    await (svc as any).evaluate();

    expect(mockGetDiskUsage).not.toHaveBeenCalled();
  });

  it('evaluate() completes promptly even when getDiskUsage would hang (F-6 regression)', async () => {
    // If df() were still on the 30s cycle, hangForever would compound the
    // cycle beyond its 25s threshold. Decoupled, evaluate() must return
    // within a small wall-clock budget regardless.
    mockGetDiskUsage.mockReturnValue(hangForever());
    mockGetGlobalSettings.mockReturnValue({ docker_janitor_gb: '0.5' });
    mockGetNodes.mockReturnValue([]);
    mockGetStackAlerts.mockReturnValue([]);

    const svc = MonitorService.getInstance();
    const t0 = Date.now();
    await (svc as any).evaluate();
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(2000);
    expect(mockGetDiskUsage).not.toHaveBeenCalled();
  });

  it('evaluateJanitor() honors isJanitorProcessing re-entrancy guard', async () => {
    mockGetGlobalSettings.mockReturnValue({ docker_janitor_gb: '0.5' });
    mockGetDiskUsage.mockResolvedValue(RECLAIMABLE_3GB);

    const svc = MonitorService.getInstance();
    (svc as any).isJanitorProcessing = true;

    await (svc as any).evaluateJanitor();

    // Second concurrent call must skip without touching settings or df.
    expect(mockGetGlobalSettings).not.toHaveBeenCalled();
    expect(mockGetDiskUsage).not.toHaveBeenCalled();
  });

  it('skips when docker_janitor_gb is unset, zero, or NaN', async () => {
    const svc = MonitorService.getInstance();

    mockGetGlobalSettings.mockReturnValue({});
    await (svc as any).evaluateJanitor();
    mockGetGlobalSettings.mockReturnValue({ docker_janitor_gb: '0' });
    await (svc as any).evaluateJanitor();
    mockGetGlobalSettings.mockReturnValue({ docker_janitor_gb: 'abc' });
    await (svc as any).evaluateJanitor();

    expect(mockGetDiskUsage).not.toHaveBeenCalled();
  });

  it('dispatches an alert when reclaimable exceeds the threshold', async () => {
    mockGetGlobalSettings.mockReturnValue({ docker_janitor_gb: '0.5' });
    mockGetDiskUsage.mockResolvedValue(RECLAIMABLE_3GB);
    mockGetSystemState.mockReturnValue('0'); // No prior alert; cooldown elapsed.

    const svc = MonitorService.getInstance();
    await (svc as any).evaluateJanitor();

    expect(mockDispatchAlert).toHaveBeenCalledWith(
      'info', 'system', expect.stringContaining('3.0 GB'), { stackName: undefined },
    );
  });

  it('does NOT alert when reclaimable is below MIN_RECLAIMABLE_GB even if threshold is aggressive', async () => {
    mockGetGlobalSettings.mockReturnValue({ docker_janitor_gb: '0.001' });
    mockGetDiskUsage.mockResolvedValue({
      ...RECLAIMABLE_3GB,
      reclaimableImages: 50 * 1024 * 1024, // 50 MB, below the 100 MB floor
    });
    mockGetSystemState.mockReturnValue('0');

    const svc = MonitorService.getInstance();
    await (svc as any).evaluateJanitor();

    expect(mockDispatchAlert).not.toHaveBeenCalled();
  });

  it('opens the circuit breaker after JANITOR_BREAKER_THRESHOLD consecutive timeouts', async () => {
    mockGetGlobalSettings.mockReturnValue({ docker_janitor_gb: '0.5' });
    mockGetDiskUsage.mockReturnValue(hangForever());
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const svc = MonitorService.getInstance();
    await (svc as any).evaluateJanitor();
    await (svc as any).evaluateJanitor();
    expect(warnSpy).not.toHaveBeenCalled(); // Threshold not yet reached.
    await (svc as any).evaluateJanitor(); // Third timeout trips the breaker.

    const breakerLine = warnSpy.mock.calls.find(
      (args) => typeof args[0] === 'string' && args[0].includes('circuit breaker opened'),
    );
    expect(breakerLine).toBeDefined();
    expect((svc as any).janitorBreakerUntil).toBeGreaterThan(Date.now());
    // Counter resets on open so the cooldown is what gates the next attempt.
    expect((svc as any).janitorConsecutiveTimeouts).toBe(0);

    warnSpy.mockRestore();
  });

  it('respects the breaker cooldown; does not call getDiskUsage while open', async () => {
    mockGetGlobalSettings.mockReturnValue({ docker_janitor_gb: '0.5' });

    const svc = MonitorService.getInstance();
    (svc as any).janitorBreakerUntil = Date.now() + 60 * 60 * 1000;

    await (svc as any).evaluateJanitor();

    expect(mockGetDiskUsage).not.toHaveBeenCalled();
    expect(mockGetGlobalSettings).not.toHaveBeenCalled();
  });

  it('resets the timeout counter on a successful call after partial failures', async () => {
    mockGetGlobalSettings.mockReturnValue({ docker_janitor_gb: '0.5' });
    mockGetDiskUsage
      .mockReturnValueOnce(hangForever())
      .mockReturnValueOnce(hangForever())
      .mockResolvedValueOnce(RECLAIMABLE_3GB);

    const svc = MonitorService.getInstance();
    await (svc as any).evaluateJanitor();
    await (svc as any).evaluateJanitor();
    expect((svc as any).janitorConsecutiveTimeouts).toBe(2);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await (svc as any).evaluateJanitor();

    expect((svc as any).janitorConsecutiveTimeouts).toBe(0);
    const recoveryLine = logSpy.mock.calls.find(
      (args) => typeof args[0] === 'string' && args[0].includes('recovered'),
    );
    expect(recoveryLine).toBeDefined();
    logSpy.mockRestore();
  });

  it('logs recovery on the first successful call after a full breaker-open cooldown', async () => {
    // After the breaker opens, the counter is zeroed; once the cooldown
    // lapses, a successful call must still emit the recovered log so the
    // operator observability story is symmetric with the partial-failure
    // recovery path.
    mockGetGlobalSettings.mockReturnValue({ docker_janitor_gb: '0.5' });

    const svc = MonitorService.getInstance();
    (svc as any).janitorBreakerUntil = Date.now() - 1; // cooldown just elapsed
    (svc as any).janitorConsecutiveTimeouts = 0;       // zeroed on open
    mockGetDiskUsage.mockResolvedValue(RECLAIMABLE_3GB);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await (svc as any).evaluateJanitor();

    const recoveryLine = logSpy.mock.calls.find(
      (args) => typeof args[0] === 'string' && args[0].includes('recovered'),
    );
    expect(recoveryLine).toBeDefined();
    expect((svc as any).janitorBreakerUntil).toBe(0);
    expect((svc as any).janitorConsecutiveTimeouts).toBe(0);
    logSpy.mockRestore();
  });

  it('does NOT advance the breaker counter on non-timeout errors', async () => {
    mockGetGlobalSettings.mockReturnValue({ docker_janitor_gb: '0.5' });
    mockGetDiskUsage.mockRejectedValue(Object.assign(new Error('daemon unreachable'), { statusCode: 500 }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const svc = MonitorService.getInstance();
    await (svc as any).evaluateJanitor();
    await (svc as any).evaluateJanitor();
    await (svc as any).evaluateJanitor();
    await (svc as any).evaluateJanitor();

    expect((svc as any).janitorConsecutiveTimeouts).toBe(0);
    expect((svc as any).janitorBreakerUntil).toBe(0);
    // The original support-grep line must still fire on every non-timeout error.
    const janitorErrorLines = errSpy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('Error checking docker janitor limits'),
    );
    expect(janitorErrorLines.length).toBe(4);

    errSpy.mockRestore();
  });

  it('stop() clears both intervals AND both deferred first-tick timeouts', () => {
    // Without canceling the first-tick setTimeouts, stop() would let
    // evaluate() / evaluateJanitor() fire on a service that the caller
    // believes is dormant. The 5s and 45s windows are wider than typical
    // graceful-shutdown budgets, so this matters.
    const svc = MonitorService.getInstance();
    svc.start();
    expect((svc as any).intervalId).not.toBeNull();
    expect((svc as any).firstTickTimeoutId).not.toBeNull();
    expect((svc as any).janitorIntervalId).not.toBeNull();
    expect((svc as any).janitorFirstTickTimeoutId).not.toBeNull();

    svc.stop();

    expect((svc as any).intervalId).toBeNull();
    expect((svc as any).firstTickTimeoutId).toBeNull();
    expect((svc as any).janitorIntervalId).toBeNull();
    expect((svc as any).janitorFirstTickTimeoutId).toBeNull();
  });
});
