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
  mockGetContainerRestartCount,
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

import { MonitorService } from '../services/MonitorService';

beforeEach(() => {
  vi.clearAllMocks();
  (MonitorService as any).instance = undefined;
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

    expect(mockDispatchAlert).toHaveBeenCalledWith('warning', 'monitor_alert', expect.stringContaining('CPU'), { stackName: undefined });
  });

  it('does not dispatch when CPU below threshold', async () => {
    mockCurrentLoad.mockResolvedValue({ currentLoad: 25 });

    const svc = MonitorService.getInstance();
    await (svc as any).evaluateGlobalSettings({ host_cpu_limit: '50' });

    expect(mockDispatchAlert).not.toHaveBeenCalledWith('warning', 'monitor_alert', expect.stringContaining('CPU'), { stackName: undefined });
  });

  it('dispatches RAM warning when over threshold', async () => {
    mockMem.mockResolvedValue({ used: 15e9, total: 16e9 }); // ~94%

    const svc = MonitorService.getInstance();
    await (svc as any).evaluateGlobalSettings({ host_ram_limit: '80' });

    expect(mockDispatchAlert).toHaveBeenCalledWith('warning', 'monitor_alert', expect.stringContaining('Memory'), { stackName: undefined });
  });

  it('dispatches disk warning when over threshold', async () => {
    mockFsSize.mockResolvedValue([{ mount: '/', use: 92 }]);

    const svc = MonitorService.getInstance();
    await (svc as any).evaluateGlobalSettings({ host_disk_limit: '90' });

    expect(mockDispatchAlert).toHaveBeenCalledWith('warning', 'monitor_alert', expect.stringContaining('Disk'), { stackName: undefined });
  });

  it('skips host limits when threshold is 0 or NaN', async () => {
    mockCurrentLoad.mockResolvedValue({ currentLoad: 99 });

    const svc = MonitorService.getInstance();
    await (svc as any).evaluateGlobalSettings({ host_cpu_limit: '0' });
    expect(mockDispatchAlert).not.toHaveBeenCalledWith('warning', 'monitor_alert', expect.stringContaining('CPU'), { stackName: undefined });

    await (svc as any).evaluateGlobalSettings({ host_cpu_limit: 'abc' });
    expect(mockDispatchAlert).not.toHaveBeenCalledWith('warning', 'monitor_alert', expect.stringContaining('CPU'), { stackName: undefined });
  });
});

// Crash + healthcheck detection now lives in DockerEventService (event-driven).
// Tests for those flows live in docker-event-service.test.ts.

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
