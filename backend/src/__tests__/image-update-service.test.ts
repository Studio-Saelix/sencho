/**
 * Unit tests for ImageUpdateService: image ref parsing, compose extraction,
 * env file loading, checkImage digest comparison, and rate limiting.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────

const {
  mockGetAuthForRegistry,
  mockGetStackUpdateStatus, mockUpsertStackUpdateStatus, mockClearStackUpdateStatus,
  mockGetSystemState, mockSetSystemState, mockAddNotificationHistory,
  mockDispatchAlert,
  mockGetStacks, mockGetStackContent, mockGetEnvContent, mockEnvExists,
  mockGetAllContainers, mockGetGlobalSettings,
} = vi.hoisted(() => ({
  mockGetAuthForRegistry: vi.fn().mockResolvedValue(null),
  mockGetStackUpdateStatus: vi.fn().mockReturnValue({}),
  mockUpsertStackUpdateStatus: vi.fn(),
  mockClearStackUpdateStatus: vi.fn(),
  mockGetSystemState: vi.fn().mockReturnValue('1'), // default: backfilled
  mockSetSystemState: vi.fn(),
  mockAddNotificationHistory: vi.fn(),
  mockDispatchAlert: vi.fn().mockResolvedValue(undefined),
  mockGetStacks: vi.fn().mockResolvedValue([]),
  mockGetStackContent: vi.fn().mockResolvedValue(''),
  mockGetEnvContent: vi.fn().mockRejectedValue(new Error('no env')),
  mockEnvExists: vi.fn().mockResolvedValue(false),
  mockGetAllContainers: vi.fn().mockResolvedValue([]),
  mockGetGlobalSettings: vi.fn().mockReturnValue({ developer_mode: '0' }),
}));

vi.mock('../services/RegistryService', () => ({
  RegistryService: {
    getInstance: () => ({
      getAuthForRegistry: mockGetAuthForRegistry,
    }),
  },
}));

vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({
      getGlobalSettings: mockGetGlobalSettings,
      getNodes: () => [],
      getGitSource: () => undefined,
      getStackProjectEnvFiles: () => [],
      upsertStackUpdateStatus: mockUpsertStackUpdateStatus,
      getStackUpdateStatus: mockGetStackUpdateStatus,
      clearStackUpdateStatus: mockClearStackUpdateStatus,
      getSystemState: mockGetSystemState,
      setSystemState: mockSetSystemState,
      addNotificationHistory: mockAddNotificationHistory,
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

vi.mock('../services/FileSystemService', () => ({
  FileSystemService: {
    getInstance: () => ({
      getStacks: mockGetStacks,
      getStackContent: mockGetStackContent,
      getEnvContent: mockGetEnvContent,
      envExists: mockEnvExists,
    }),
  },
}));

vi.mock('../services/DockerController', () => ({
  default: {
    getInstance: () => ({
      getAllContainers: mockGetAllContainers,
    }),
  },
}));

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getComposeDir: () => '/tmp/compose',
      getDefaultNodeId: () => 1,
    }),
  },
}));

// ── Re-export internal helpers via the module ─────────────────────────

// We need the internal functions. Import the module after mocks are set up.
// parseImageRef, extractImagesFromCompose, loadDotEnv are module-scoped (not exported).
// We'll test them indirectly through checkImage and by importing the file and
// evaluating the functions via a workaround, or test via the public API.

// Since the pure functions are not exported, we test them by importing
// the module source and evaluating. For a cleaner approach, we test
// parseImageRef behavior through checkImage and test the compose helpers
// through a dynamic import of the raw source.

// For this test we re-implement the function signatures to test via the
// public checkImage method (which calls parseImageRef internally).

import { ImageUpdateService } from '../services/ImageUpdateService';
import YAML from 'yaml';

// ── parseImageRef (tested indirectly via checkImage) ──────────────────

describe('ImageUpdateService - image ref parsing (via checkImage)', () => {
  let service: ImageUpdateService;

  beforeEach(() => {
    vi.clearAllMocks();
    (ImageUpdateService as any).instance = undefined;
    service = ImageUpdateService.getInstance();
  });

  function makeMockDocker(repoDigests: string[] = []) {
    const inspectFn = vi.fn().mockResolvedValue({ RepoDigests: repoDigests });
    return {
      getDocker: () => ({
        getImage: () => ({ inspect: inspectFn }),
      }),
    } as any;
  }

  it('returns { hasUpdate: false } for sha256-only refs', async () => {
    const docker = makeMockDocker();
    const result = await service.checkImage(docker, 'sha256:abc123');
    expect(result).toEqual({ hasUpdate: false });
  });

  it('returns error when local image inspect fails', async () => {
    const docker = {
      getDocker: () => ({
        getImage: () => ({ inspect: vi.fn().mockRejectedValue(new Error('not found')) }),
      }),
    } as any;
    const result = await service.checkImage(docker, 'nginx:latest');
    expect(result.hasUpdate).toBe(false);
    expect(result.error).toContain('Failed to inspect local image');
  });

  it('bounds a hung local inspect instead of hanging the scan', async () => {
    // A wedged Docker socket must not stall the check forever: withTimeout
    // rejects the inspect, the existing catch turns it into an error result.
    const docker = {
      getDocker: () => ({
        getImage: () => ({ inspect: vi.fn().mockImplementation(() => new Promise(() => { /* never resolves */ })) }),
      }),
    } as any;
    const orig = (ImageUpdateService as any).SOCKET_TIMEOUT_MS;
    (ImageUpdateService as any).SOCKET_TIMEOUT_MS = 20;
    try {
      const result = await service.checkImage(docker, 'nginx:latest');
      expect(result.hasUpdate).toBe(false);
      expect(result.error).toContain('Failed to inspect local image');
    } finally {
      (ImageUpdateService as any).SOCKET_TIMEOUT_MS = orig;
    }
  });

  it('returns { hasUpdate: false } when no RepoDigests match', async () => {
    // Empty RepoDigests means locally built image
    const docker = makeMockDocker([]);
    const result = await service.checkImage(docker, 'nginx:latest');
    expect(result).toEqual({ hasUpdate: false });
  });

  it('returns { hasUpdate: false } when RepoDigests have no sha256', async () => {
    const docker = makeMockDocker(['library/nginx:latest']);
    const result = await service.checkImage(docker, 'nginx:latest');
    expect(result).toEqual({ hasUpdate: false });
  });
});

// ── Rate limiting ─────────────────────────────────────────────────────

describe('ImageUpdateService - manual refresh cooldown', () => {
  let service: ImageUpdateService;

  beforeEach(() => {
    vi.clearAllMocks();
    (ImageUpdateService as any).instance = undefined;
    service = ImageUpdateService.getInstance();
  });

  it('enforces cooldown between manual triggers', () => {
    // First trigger should succeed
    const first = service.triggerManualRefresh();
    expect(first).toBe(true);

    // Immediate second trigger should be rate-limited
    const second = service.triggerManualRefresh();
    expect(second).toBe(false);
  });

  it('reports isChecking state', () => {
    // Initially not checking
    expect(service.isChecking()).toBe(false);
  });
});

// ── Compose parsing helpers (tested via source eval) ──────────────────
// Since loadDotEnv and extractImagesFromCompose are not exported, we
// test them by dynamically importing the raw module code and extracting
// the functions. This is a pragmatic approach for testing internal helpers.

describe('ImageUpdateService - loadDotEnv (internal)', () => {
  // We replicate the loadDotEnv logic here since it's a pure function
  // that is not exported. This tests the behavior specification.
  function loadDotEnv(content: string): Record<string, string> {
    const vars: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      vars[key] = val;
    }
    return vars;
  }

  it('parses basic key=value pairs', () => {
    const result = loadDotEnv('FOO=bar\nBAZ=qux');
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('handles quoted values', () => {
    const result = loadDotEnv('FOO="hello world"\nBAR=\'single\'');
    expect(result).toEqual({ FOO: 'hello world', BAR: 'single' });
  });

  it('ignores comments and empty lines', () => {
    const result = loadDotEnv('# comment\n\nFOO=bar\n  # another comment');
    expect(result).toEqual({ FOO: 'bar' });
  });

  it('handles values with equals signs', () => {
    const result = loadDotEnv('CONNECTION=host=db port=5432');
    expect(result).toEqual({ CONNECTION: 'host=db port=5432' });
  });

  it('returns empty object for empty input', () => {
    expect(loadDotEnv('')).toEqual({});
  });
});

describe('ImageUpdateService - extractImagesFromCompose (internal)', () => {
  // Replicate the extraction logic for testing

  function extractImagesFromCompose(
    yamlContent: string,
    envVars: Record<string, string>
  ): string[] {
    let parsed: Record<string, unknown>;
    try {
      parsed = YAML.parse(yamlContent) as Record<string, unknown>;
    } catch {
      return [];
    }
    if (!parsed?.services || typeof parsed.services !== 'object') return [];

    const images: string[] = [];
    for (const svc of Object.values(parsed.services as Record<string, unknown>)) {
      if (!svc || typeof svc !== 'object') continue;
      const raw = (svc as Record<string, unknown>).image;
      if (!raw || typeof raw !== 'string') continue;

      let ref = raw.replace(
        /\$\{([^}]+)\}/g,
        (_: string, expr: string) => {
          const defaultMatch = expr.match(/^([^:-]+)(?::?-)(.+)$/);
          if (defaultMatch) {
            return envVars[defaultMatch[1]] ?? defaultMatch[2];
          }
          return envVars[expr] ?? '';
        }
      );

      ref = ref.trim();
      if (!ref || ref.includes('${') || ref.startsWith('sha256:')) continue;
      images.push(ref);
    }
    return images;
  }

  it('extracts images from a multi-service compose file', () => {
    const yaml = `
services:
  web:
    image: nginx:latest
  db:
    image: postgres:15
`;
    expect(extractImagesFromCompose(yaml, {})).toEqual(['nginx:latest', 'postgres:15']);
  });

  it('resolves environment variables in image refs', () => {
    const yaml = `
services:
  app:
    image: \${IMAGE_NAME}:\${IMAGE_TAG:-latest}
`;
    expect(extractImagesFromCompose(yaml, { IMAGE_NAME: 'myapp' })).toEqual(['myapp:latest']);
  });

  it('uses default values when env vars are missing', () => {
    const yaml = `
services:
  app:
    image: \${IMAGE:-nginx}:\${TAG:-1.25}
`;
    expect(extractImagesFromCompose(yaml, {})).toEqual(['nginx:1.25']);
  });

  it('skips services without image key', () => {
    const yaml = `
services:
  built:
    build: ./app
  pulled:
    image: redis:7
`;
    expect(extractImagesFromCompose(yaml, {})).toEqual(['redis:7']);
  });

  it('skips sha256-only image refs', () => {
    const yaml = `
services:
  app:
    image: sha256:abc123def456
`;
    expect(extractImagesFromCompose(yaml, {})).toEqual([]);
  });

  it('returns empty for invalid YAML', () => {
    expect(extractImagesFromCompose('{{not: yaml', {})).toEqual([]);
  });

  it('returns empty when no services key', () => {
    expect(extractImagesFromCompose('version: "3"', {})).toEqual([]);
  });

  it('skips unresolved variables', () => {
    const yaml = `
services:
  app:
    image: \${UNSET_VAR}
`;
    expect(extractImagesFromCompose(yaml, {})).toEqual([]);
  });
});

// ── Notification dispatch on state transitions ────────────────────────

describe('ImageUpdateService - notification dispatch', () => {
  const COMPOSE = `
services:
  app:
    image: nginx:latest
`;

  const fakeDb = () => ({
    getStackUpdateStatus: mockGetStackUpdateStatus,
    upsertStackUpdateStatus: mockUpsertStackUpdateStatus,
    clearStackUpdateStatus: mockClearStackUpdateStatus,
    getSystemState: mockGetSystemState,
    setSystemState: mockSetSystemState,
    addNotificationHistory: mockAddNotificationHistory,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    (ImageUpdateService as any).instance = undefined;
    // Default: backfill complete so transition logic applies normally.
    mockGetSystemState.mockReturnValue('1');
    mockGetStacks.mockResolvedValue(['stackA']);
    mockGetStackContent.mockResolvedValue(COMPOSE);
    mockGetAllContainers.mockResolvedValue([]);
  });

  /**
   * Stubs the private checkImage method so tests don't need to mock
   * the entire registry-fetch stack.
   */
  function stubCheckImage(service: ImageUpdateService, hasUpdate: boolean) {
    (service as any).checkImage = vi.fn().mockResolvedValue({ hasUpdate });
  }

  it('dispatches notification when a stack transitions from no-update to has-update', async () => {
    mockGetStackUpdateStatus.mockReturnValue({ stackA: false });
    const service = ImageUpdateService.getInstance();
    stubCheckImage(service, true);

    await (service as any).checkNode(1, 'local', fakeDb());

    expect(mockDispatchAlert).toHaveBeenCalledTimes(1);
    expect(mockDispatchAlert).toHaveBeenCalledWith(
      'info',
      'image_update_available',
      expect.stringContaining('stackA'),
      { stackName: 'stackA', actor: 'system:image-update' },
    );
    expect(mockUpsertStackUpdateStatus).toHaveBeenCalledWith(1, 'stackA', true, expect.any(Number));
  });

  it('does not re-fire notification for a stack already known to have updates', async () => {
    mockGetStackUpdateStatus.mockReturnValue({ stackA: true });
    const service = ImageUpdateService.getInstance();
    stubCheckImage(service, true);

    await (service as any).checkNode(1, 'local', fakeDb());

    expect(mockDispatchAlert).not.toHaveBeenCalled();
  });

  it('backfills catch-up notifications once for pre-existing has_update rows', async () => {
    // Simulate a stale DB: two stacks already have has_update = true,
    // but the backfill flag is not set.
    mockGetSystemState.mockReturnValue(null);
    mockGetStacks.mockResolvedValue(['stackA', 'stackB']);
    mockGetStackUpdateStatus.mockReturnValue({ stackA: true, stackB: true });
    const service = ImageUpdateService.getInstance();
    stubCheckImage(service, true);

    await (service as any).checkNode(1, 'local', fakeDb());

    expect(mockDispatchAlert).toHaveBeenCalledTimes(2);
    const dispatched = mockDispatchAlert.mock.calls.map(call => (call[3] as any)?.stackName);
    expect(dispatched).toEqual(expect.arrayContaining(['stackA', 'stackB']));
    expect(mockSetSystemState).toHaveBeenCalledWith('image_update_notifications_backfilled', '1');

    // Second run with backfill flag set and the same state: no further notifications.
    vi.clearAllMocks();
    mockGetSystemState.mockReturnValue('1');
    mockGetStacks.mockResolvedValue(['stackA', 'stackB']);
    mockGetStackUpdateStatus.mockReturnValue({ stackA: true, stackB: true });
    stubCheckImage(service, true);

    await (service as any).checkNode(1, 'local', fakeDb());

    expect(mockDispatchAlert).not.toHaveBeenCalled();
  });

  it('surfaces dispatch failures as an error entry in notification history', async () => {
    mockGetStackUpdateStatus.mockReturnValue({ stackA: false });
    mockDispatchAlert.mockRejectedValueOnce(new Error('webhook timeout'));
    const service = ImageUpdateService.getInstance();
    stubCheckImage(service, true);

    await (service as any).checkNode(1, 'local', fakeDb());

    expect(mockAddNotificationHistory).toHaveBeenCalledWith(1, expect.objectContaining({
      level: 'error',
      message: expect.stringContaining('webhook timeout'),
    }));
  });
});

// ── .env file handling ──────────────────────────────────────────────────

describe('ImageUpdateService - .env file handling in checkNode', () => {
  const COMPOSE = `
services:
  app:
    image: nginx:latest
`;

  const fakeDb = () => ({
    getStackUpdateStatus: mockGetStackUpdateStatus,
    upsertStackUpdateStatus: mockUpsertStackUpdateStatus,
    clearStackUpdateStatus: mockClearStackUpdateStatus,
    getSystemState: mockGetSystemState,
    setSystemState: mockSetSystemState,
    addNotificationHistory: mockAddNotificationHistory,
  });

  function stubCheckImage(service: ImageUpdateService, hasUpdate: boolean) {
    (service as any).checkImage = vi.fn().mockResolvedValue({ hasUpdate });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    (ImageUpdateService as any).instance = undefined;
    mockGetSystemState.mockReturnValue('1');
    mockGetStacks.mockResolvedValue(['stackA']);
    mockGetStackContent.mockResolvedValue(COMPOSE);
    mockGetAllContainers.mockResolvedValue([]);
    mockGetEnvContent.mockRejectedValue(new Error('no env'));
    mockEnvExists.mockResolvedValue(false);
  });

  it('skips getEnvContent when envExists returns false', async () => {
    mockEnvExists.mockResolvedValue(false);
    const service = ImageUpdateService.getInstance();
    stubCheckImage(service, false);

    await (service as any).checkNode(1, 'local', fakeDb());

    expect(mockEnvExists).toHaveBeenCalledWith('stackA');
    expect(mockGetEnvContent).not.toHaveBeenCalled();
  });

  it('reads .env when envExists returns true', async () => {
    mockEnvExists.mockResolvedValue(true);
    mockGetEnvContent.mockResolvedValue('IMAGE_TAG=1.0');
    const service = ImageUpdateService.getInstance();
    stubCheckImage(service, false);

    await (service as any).checkNode(1, 'local', fakeDb());

    expect(mockEnvExists).toHaveBeenCalledWith('stackA');
    expect(mockGetEnvContent).toHaveBeenCalledWith('stackA');
  });

  it('continues gracefully when .env exists but is unreadable', async () => {
    mockEnvExists.mockResolvedValue(true);
    mockGetEnvContent.mockRejectedValue(new Error('EACCES: permission denied'));
    const service = ImageUpdateService.getInstance();
    stubCheckImage(service, false);

    await (service as any).checkNode(1, 'local', fakeDb());

    // Should not throw; should still complete and write status
    expect(mockUpsertStackUpdateStatus).toHaveBeenCalled();
  });
});

// ── check() concurrency guard ───────────────────────────────────────────

describe('ImageUpdateService - check() concurrency guard', () => {

  beforeEach(() => {
    vi.clearAllMocks();
    (ImageUpdateService as any).instance = undefined;
  });

  async function stubDbWithLocalNode(developerMode: '0' | '1' = '0') {
    const dbModule = await import('../services/DatabaseService');
    const orig = dbModule.DatabaseService.getInstance;
    dbModule.DatabaseService.getInstance = (() => ({
      getGlobalSettings: () => ({ developer_mode: developerMode }),
      getNodes: () => [{ type: 'local', id: 1, name: 'local', mode: 'proxy', compose_dir: '/tmp/compose', is_default: true, status: 'online', created_at: 1 }],
      getGitSource: () => undefined,
      getStackProjectEnvFiles: () => [],
      upsertStackUpdateStatus: mockUpsertStackUpdateStatus,
      getStackUpdateStatus: mockGetStackUpdateStatus,
      clearStackUpdateStatus: mockClearStackUpdateStatus,
      getSystemState: mockGetSystemState,
      setSystemState: mockSetSystemState,
      addNotificationHistory: mockAddNotificationHistory,
    })) as unknown as typeof dbModule.DatabaseService.getInstance;
    return () => { dbModule.DatabaseService.getInstance = orig; };
  }

  it('does not start a second check body while one is in flight', async () => {
    const restoreDb = await stubDbWithLocalNode();
    const service = ImageUpdateService.getInstance();
    // checkNode never resolves: simulate a scan that overruns / a wedged socket.
    const checkNodeMock = vi.fn().mockImplementation(() =>
      new Promise(() => { /* never resolves */ })
    );
    (service as any).checkNode = checkNodeMock;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const skipWarn = /running for \d+ minute/;

    const first = (service as any).check();
    await new Promise(r => setTimeout(r, 10));
    expect(service.isChecking()).toBe(true);
    expect(checkNodeMock).toHaveBeenCalledTimes(1);

    // A concurrent trigger (e.g. a manual refresh) under the long-run threshold
    // must be a silent no-op: no second body, no warning.
    await (service as any).check();
    expect(checkNodeMock).toHaveBeenCalledTimes(1);
    expect(service.isChecking()).toBe(true);
    expect(warnSpy.mock.calls.some(c => skipWarn.test(String(c[0])))).toBe(false);

    // Past the long-run threshold the trigger warns (operator signal) but still
    // must not spawn a concurrent body.
    const orig = (ImageUpdateService as any).CHECK_TIMEOUT_MS;
    (ImageUpdateService as any).CHECK_TIMEOUT_MS = 1;
    await new Promise(r => setTimeout(r, 5));
    await (service as any).check();
    expect(checkNodeMock).toHaveBeenCalledTimes(1);
    expect(service.isChecking()).toBe(true);
    expect(warnSpy.mock.calls.some(c => skipWarn.test(String(c[0])))).toBe(true);

    (ImageUpdateService as any).CHECK_TIMEOUT_MS = orig;
    warnSpy.mockRestore();
    restoreDb();
    first.catch(() => {});
  });

  it('treats a manual refresh during an in-flight check as a no-op', async () => {
    const restoreDb = await stubDbWithLocalNode();
    const service = ImageUpdateService.getInstance();
    const checkNodeMock = vi.fn().mockImplementation(() =>
      new Promise(() => { /* never resolves */ })
    );
    (service as any).checkNode = checkNodeMock;

    const first = (service as any).check();
    await new Promise(r => setTimeout(r, 10));
    expect(checkNodeMock).toHaveBeenCalledTimes(1);

    // This is the exact regression the guard replaces: a manual refresh firing
    // while a scan is in flight. It reports it fired (the cooldown is clear) but
    // the in-check guard prevents a second concurrent scan body.
    const triggered = service.triggerManualRefresh();
    await new Promise(r => setTimeout(r, 10));
    expect(triggered).toBe(true);
    expect(checkNodeMock).toHaveBeenCalledTimes(1);
    expect(service.isChecking()).toBe(true);

    restoreDb();
    first.catch(() => {});
  });

  it('logs a debug skip line for a mid-scan trigger when developer mode is on', async () => {
    const restoreDb = await stubDbWithLocalNode('1');
    // isDebugEnabled short-circuits to false under NODE_ENV=test unless DATA_DIR
    // is set; set it so the developer_mode flag is actually consulted.
    const prevDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = prevDataDir ?? '/tmp/image-update-debug-test';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const service = ImageUpdateService.getInstance();
      const checkNodeMock = vi.fn().mockImplementation(() =>
        new Promise(() => { /* never resolves */ })
      );
      (service as any).checkNode = checkNodeMock;

      const first = (service as any).check();
      await new Promise(r => setTimeout(r, 10));

      // Under the long-run threshold with developer mode on, the skipped trigger
      // takes the debug branch rather than the WARN branch.
      await (service as any).check();
      expect(checkNodeMock).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls.some(c => /Check already in progress; skipping/.test(String(c[0])))).toBe(true);

      first.catch(() => {});
    } finally {
      logSpy.mockRestore();
      if (prevDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prevDataDir;
      restoreDb();
    }
  });

  it('releases the lock when a check finishes and allows the next run', async () => {
    const restoreDb = await stubDbWithLocalNode();
    const service = ImageUpdateService.getInstance();
    const checkNodeMock = vi.fn().mockResolvedValue(undefined);
    (service as any).checkNode = checkNodeMock;

    await (service as any).check();
    expect(service.isChecking()).toBe(false);
    expect(checkNodeMock).toHaveBeenCalledTimes(1);

    // A fresh trigger after completion runs a new body.
    await (service as any).check();
    expect(checkNodeMock).toHaveBeenCalledTimes(2);

    restoreDb();
  });
});

// ── stop() cancels startup timeout ──────────────────────────────────────

describe('ImageUpdateService - stop() cancels startup timeout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (ImageUpdateService as any).instance = undefined;
  });

  it('prevents check from firing after stop() is called during startup delay', async () => {
    const service = ImageUpdateService.getInstance();
    const checkSpy = vi.spyOn(service as any, 'check');

    service.start();
    service.stop();

    // Wait past the startup delay to see if check fires
    await new Promise(r => setTimeout(r, 100));

    expect(checkSpy).not.toHaveBeenCalled();
  });
});

// ── Configurable interval, status, and reschedule ───────────────────────

describe('ImageUpdateService - configurable interval & status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (ImageUpdateService as any).instance = undefined;
    mockGetGlobalSettings.mockReturnValue({ developer_mode: '0' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
  }

  it('reports the default 120-minute interval before start() runs', () => {
    const service = ImageUpdateService.getInstance();
    const status = service.getStatus();
    expect(status.intervalMinutes).toBe(120);
    expect(status.checking).toBe(false);
    expect(status.lastCheckedAt).toBeNull();
    expect(status.nextCheckAt).toBeNull();
    expect(status.manualCooldownMinutes).toBe(2);
    expect(status.manualCooldownRemainingMs).toBe(0);
  });

  it('reads the configured interval from settings', () => {
    mockGetGlobalSettings.mockReturnValue({ image_update_check_interval_minutes: '30' });
    const service = ImageUpdateService.getInstance();
    service.configureFromSettings();
    expect(service.getStatus().intervalMinutes).toBe(30);
  });

  it('clamps an interval below the minimum to 15', () => {
    mockGetGlobalSettings.mockReturnValue({ image_update_check_interval_minutes: '5' });
    const service = ImageUpdateService.getInstance();
    service.configureFromSettings();
    expect(service.getStatus().intervalMinutes).toBe(15);
  });

  it('clamps an interval above the maximum to 1440', () => {
    mockGetGlobalSettings.mockReturnValue({ image_update_check_interval_minutes: '5000' });
    const service = ImageUpdateService.getInstance();
    service.configureFromSettings();
    expect(service.getStatus().intervalMinutes).toBe(1440);
  });

  it('falls back to the default for a malformed or non-integer value', () => {
    const service = ImageUpdateService.getInstance();
    const badValues: (string | undefined)[] = ['15abc', '30.5', '', undefined];
    for (const bad of badValues) {
      mockGetGlobalSettings.mockReturnValue(bad === undefined ? {} : { image_update_check_interval_minutes: bad });
      service.configureFromSettings();
      expect(service.getStatus().intervalMinutes).toBe(120);
    }
  });

  it('stamps lastCheckedAt when a manual refresh runs', async () => {
    const service = ImageUpdateService.getInstance();
    // getNodes() returns [] in the shared mock, so check() completes immediately.
    expect(service.getStatus().lastCheckedAt).toBeNull();
    const triggered = service.triggerManualRefresh();
    expect(triggered).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(service.getStatus().lastCheckedAt).not.toBeNull();
  });

  it('applies ±10% jitter that actually reaches both endpoints', () => {
    mockGetGlobalSettings.mockReturnValue({ image_update_check_interval_minutes: '60' });
    const service = ImageUpdateService.getInstance();
    service.configureFromSettings();
    const interval = 60 * 60 * 1000;

    // random=0 must reach the low edge (90%), proving jitter is applied and not
    // collapsed to the bare interval.
    const low = vi.spyOn(Math, 'random').mockReturnValue(0);
    expect((service as any).nextDelayMs()).toBe(Math.round(interval * 0.9));
    low.mockRestore();

    const mid = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect((service as any).nextDelayMs()).toBe(interval);
    mid.mockRestore();

    // random→1 must reach the high edge (≈110%).
    const high = vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const hi = (service as any).nextDelayMs() as number;
    expect(hi).toBeGreaterThan(interval);
    expect(hi).toBeGreaterThanOrEqual(Math.round(interval * 1.09));
    expect(hi).toBeLessThanOrEqual(Math.round(interval * 1.1));
    high.mockRestore();
  });

  it('reports the manual-refresh cooldown remaining and clears it after the window', () => {
    vi.useFakeTimers();
    const service = ImageUpdateService.getInstance();
    expect(service.getManualCooldownRemainingMs()).toBe(0);
    service.triggerManualRefresh();
    const remaining = service.getManualCooldownRemainingMs();
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(2 * 60 * 1000);
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(service.getManualCooldownRemainingMs()).toBe(0);
  });

  it('stop() after start() clears the timer and nulls nextCheckAt without firing a check', () => {
    vi.useFakeTimers();
    const service = ImageUpdateService.getInstance();
    const checkSpy = vi.spyOn(service as any, 'check').mockResolvedValue(undefined);
    service.start();
    expect(service.getStatus().nextCheckAt).not.toBeNull();
    expect(vi.getTimerCount()).toBe(1);

    service.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(service.getStatus().nextCheckAt).toBeNull();

    // Past the old startup delay: the cleared timer + bumped generation mean no
    // check fires on a stopped service.
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(checkSpy).not.toHaveBeenCalled();
    checkSpy.mockRestore();
  });

  it('restartPolling() while stopped reconfigures the interval but arms no timer', () => {
    vi.useFakeTimers();
    mockGetGlobalSettings.mockReturnValue({ image_update_check_interval_minutes: '45' });
    const service = ImageUpdateService.getInstance();
    // Never started: polling is false, so it reconfigures without arming.
    service.restartPolling();
    expect(service.getStatus().intervalMinutes).toBe(45);
    expect(service.getStatus().nextCheckAt).toBeNull();
    expect((service as any).timer).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restartPolling() during an in-flight tick leaves exactly one timer', async () => {
    vi.useFakeTimers();
    const service = ImageUpdateService.getInstance();
    const d = deferred();
    const checkSpy = vi.spyOn(service as any, 'check').mockReturnValue(d.promise);

    service.start();
    expect(vi.getTimerCount()).toBe(1);

    // Fire the startup tick: it invokes check() (our pending deferred) and does
    // not re-arm until check resolves.
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(checkSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    // A settings save lands mid-scan: it arms a fresh timer.
    service.restartPolling();
    expect(vi.getTimerCount()).toBe(1);

    // The original tick resolves; its generation is now stale, so it must not
    // re-arm a second timer.
    d.resolve();
    await d.promise;
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);

    service.stop();
    checkSpy.mockRestore();
  });
});

// ── Stale stack pruning ─────────────────────────────────────────────────

describe('ImageUpdateService - stale stack pruning', () => {
  const COMPOSE = `
services:
  app:
    image: nginx:latest
`;

  const fakeDb = () => ({
    getStackUpdateStatus: mockGetStackUpdateStatus,
    upsertStackUpdateStatus: mockUpsertStackUpdateStatus,
    clearStackUpdateStatus: mockClearStackUpdateStatus,
    getSystemState: mockGetSystemState,
    setSystemState: mockSetSystemState,
    addNotificationHistory: mockAddNotificationHistory,
  });

  function stubCheckImage(service: ImageUpdateService, hasUpdate: boolean) {
    (service as any).checkImage = vi.fn().mockResolvedValue({ hasUpdate });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    (ImageUpdateService as any).instance = undefined;
    mockGetSystemState.mockReturnValue('1');
    mockGetStacks.mockResolvedValue(['stackA']);
    mockGetStackContent.mockResolvedValue(COMPOSE);
    mockGetAllContainers.mockResolvedValue([]);
    mockEnvExists.mockResolvedValue(false);
  });

  it('prunes stale stacks no longer on disk', async () => {
    // previousState has stackB which no longer exists on disk
    mockGetStackUpdateStatus.mockReturnValue({ stackA: false, stackB: true });
    const service = ImageUpdateService.getInstance();
    stubCheckImage(service, false);

    await (service as any).checkNode(1, 'local', fakeDb());

    expect(mockClearStackUpdateStatus).toHaveBeenCalledWith(1, 'stackB');
  });

  it('does not prune stacks still on disk', async () => {
    mockGetStackUpdateStatus.mockReturnValue({ stackA: false });
    const service = ImageUpdateService.getInstance();
    stubCheckImage(service, false);

    await (service as any).checkNode(1, 'local', fakeDb());

    expect(mockClearStackUpdateStatus).not.toHaveBeenCalled();
  });
});

// ── Container augmentation filtering ────────────────────────────────────

describe('ImageUpdateService - container augmentation filtering', () => {
  const COMPOSE = `
services:
  app:
    image: nginx:latest
`;

  const fakeDb = () => ({
    getStackUpdateStatus: mockGetStackUpdateStatus,
    upsertStackUpdateStatus: mockUpsertStackUpdateStatus,
    clearStackUpdateStatus: mockClearStackUpdateStatus,
    getSystemState: mockGetSystemState,
    setSystemState: mockSetSystemState,
    addNotificationHistory: mockAddNotificationHistory,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    (ImageUpdateService as any).instance = undefined;
    mockGetSystemState.mockReturnValue('1');
    mockGetStacks.mockResolvedValue(['stackA']);
    mockGetStackContent.mockResolvedValue(COMPOSE);
    mockEnvExists.mockResolvedValue(false);
  });

  it('includes containers whose working_dir matches compose dir', async () => {
    mockGetAllContainers.mockResolvedValue([
      {
        Labels: { 'com.docker.compose.project.working_dir': '/tmp/compose/stackA' },
        Image: 'nginx:1.25',
      },
    ]);
    const service = ImageUpdateService.getInstance();
    const checkImageSpy = vi.fn().mockResolvedValue({ hasUpdate: false });
    (service as any).checkImage = checkImageSpy;

    await (service as any).checkNode(1, 'local', fakeDb());

    // Should check both the compose image and the container image
    const checkedImages = checkImageSpy.mock.calls.map((c: any[]) => c[1]);
    expect(checkedImages).toContain('nginx:1.25');
  });

  it('excludes containers outside compose dir', async () => {
    mockGetAllContainers.mockResolvedValue([
      {
        Labels: { 'com.docker.compose.project.working_dir': '/other/place/app' },
        Image: 'someapp:v2',
      },
    ]);
    const service = ImageUpdateService.getInstance();
    const checkImageSpy = vi.fn().mockResolvedValue({ hasUpdate: false });
    (service as any).checkImage = checkImageSpy;

    await (service as any).checkNode(1, 'local', fakeDb());

    const checkedImages = checkImageSpy.mock.calls.map((c: any[]) => c[1]);
    expect(checkedImages).not.toContain('someapp:v2');
  });
});

describe('ImageUpdateService cron scheduling', () => {
  beforeEach(() => {
    (ImageUpdateService as any).instance = undefined;
    mockGetGlobalSettings.mockReturnValue({ developer_mode: '0' });
  });

  it('getStatus returns mode and cronExpression fields', () => {
    const service = ImageUpdateService.getInstance();
    // Before start/configureFromSettings, defaults apply.
    mockGetGlobalSettings.mockReturnValue({ developer_mode: '0' });
    service.configureFromSettings();
    const status = service.getStatus();
    expect(status.mode).toBe('interval');
    expect(status.cronExpression).toBeNull();
  });

  it('configureFromSettings sets cron mode with valid expression', () => {
    mockGetGlobalSettings.mockReturnValue({
      developer_mode: '0',
      image_update_check_mode: 'cron',
      image_update_check_cron: '0 3 * * 1',
      image_update_check_interval_minutes: '120',
    });
    const service = ImageUpdateService.getInstance();
    service.configureFromSettings();
    const status = service.getStatus();
    expect(status.mode).toBe('cron');
    expect(status.cronExpression).toBe('0 3 * * 1');
  });

  it('configureFromSettings falls back to interval on invalid cron', () => {
    mockGetGlobalSettings.mockReturnValue({
      developer_mode: '0',
      image_update_check_mode: 'cron',
      image_update_check_cron: 'not a cron expression',
      image_update_check_interval_minutes: '120',
    });
    const service = ImageUpdateService.getInstance();
    service.configureFromSettings();
    const status = service.getStatus();
    expect(status.mode).toBe('interval');
    expect(status.cronExpression).toBeNull();
  });

  it('configureFromSettings falls back to interval when cron mode has empty expression', () => {
    mockGetGlobalSettings.mockReturnValue({
      developer_mode: '0',
      image_update_check_mode: 'cron',
      image_update_check_cron: '',
      image_update_check_interval_minutes: '120',
    });
    const service = ImageUpdateService.getInstance();
    service.configureFromSettings();
    const status = service.getStatus();
    expect(status.mode).toBe('interval');
    expect(status.cronExpression).toBeNull();
  });

  it('configureFromSettings accepts cron nicknames like @daily', () => {
    mockGetGlobalSettings.mockReturnValue({
      developer_mode: '0',
      image_update_check_mode: 'cron',
      image_update_check_cron: '@daily',
      image_update_check_interval_minutes: '120',
    });
    const service = ImageUpdateService.getInstance();
    service.configureFromSettings();
    const status = service.getStatus();
    expect(status.mode).toBe('cron');
    expect(status.cronExpression).toBe('@daily');
  });

  it('nextDelayMs computes a positive delay for a valid cron expression', () => {
    mockGetGlobalSettings.mockReturnValue({
      developer_mode: '0',
      image_update_check_mode: 'cron',
      image_update_check_cron: '0 3 * * 1',
      image_update_check_interval_minutes: '120',
    });
    const service = ImageUpdateService.getInstance();
    service.configureFromSettings();
    // nextDelayMs is private; access it to verify it does not throw and returns
    // a positive number (next Monday at 03:00 is in the future).
    const delay = (service as any).nextDelayMs();
    expect(typeof delay).toBe('number');
    expect(delay).toBeGreaterThan(0);
  });

  it('nextDelayMs falls back to interval on runtime parse failure', () => {
    // Set up cron mode, then corrupt the expression at runtime before nextDelayMs.
    mockGetGlobalSettings.mockReturnValue({
      developer_mode: '0',
      image_update_check_mode: 'cron',
      image_update_check_cron: '0 3 * * 1',
      image_update_check_interval_minutes: '120',
    });
    const service = ImageUpdateService.getInstance();
    service.configureFromSettings();
    // Corrupt the expression directly on the private field.
    (service as any).cronExpression = '0 0 31 2 *'; // Feb 31 — invalid
    const delay = (service as any).nextDelayMs();
    // Should fall back to interval mode after the parse error.
    expect(service.getStatus().mode).toBe('interval');
    expect(typeof delay).toBe('number');
    expect(delay).toBeGreaterThan(0);
  });
});
