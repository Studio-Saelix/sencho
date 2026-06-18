/**
 * Wiring tests for UpdateGuardService: container probing resilience and the
 * degrade-everything-to-unknown contract when every collaborator fails. The
 * grading rules themselves are covered by the pure readiness tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockListContainers,
  mockGetContainer,
  mockGetLatest,
  mockGetPreview,
  mockGetBackupInfo,
  mockGetBackupEnvSummary,
  mockEnvExists,
  mockGetOpenDriftFindings,
  mockGetGlobalSettings,
  mockFsSize,
} = vi.hoisted(() => ({
  mockListContainers: vi.fn(),
  mockGetContainer: vi.fn(),
  mockGetLatest: vi.fn(),
  mockGetPreview: vi.fn(),
  mockGetBackupInfo: vi.fn(),
  mockGetBackupEnvSummary: vi.fn(),
  mockEnvExists: vi.fn(),
  mockGetOpenDriftFindings: vi.fn(),
  mockGetGlobalSettings: vi.fn(),
  mockFsSize: vi.fn(),
}));

vi.mock('../services/DockerController', () => ({
  default: {
    getInstance: () => ({
      getDocker: () => ({
        listContainers: mockListContainers,
        getContainer: mockGetContainer,
      }),
    }),
  },
}));

vi.mock('../services/ComposeDoctorService', () => ({
  ComposeDoctorService: { getInstance: () => ({ getLatest: mockGetLatest }) },
}));

vi.mock('../services/UpdatePreviewService', async (importOriginal) => ({
  // Keep the real pure helpers (isMovingTag, parseSemverTag) that
  // UpdateGuardService imports; only stub the service singleton.
  ...(await importOriginal<typeof import('../services/UpdatePreviewService')>()),
  UpdatePreviewService: { getInstance: () => ({ getPreview: mockGetPreview }) },
}));

vi.mock('../services/FileSystemService', () => ({
  FileSystemService: {
    getInstance: () => ({
      getBackupInfo: mockGetBackupInfo,
      getBackupEnvSummary: mockGetBackupEnvSummary,
      envExists: mockEnvExists,
    }),
  },
}));

vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({
      getOpenDriftFindings: mockGetOpenDriftFindings,
      getGlobalSettings: mockGetGlobalSettings,
      getStackActivity: vi.fn().mockReturnValue([]),
    }),
  },
}));

vi.mock('systeminformation', () => ({
  default: { fsSize: mockFsSize },
}));

import { UpdateGuardService } from '../services/UpdateGuardService';

const inspectResult = (over: Record<string, unknown> = {}) => ({
  State: { Status: 'running', ExitCode: 0 },
  Config: { Healthcheck: { Test: ['CMD', 'true'] } },
  HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
  Mounts: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetGlobalSettings.mockReturnValue({ host_disk_limit: '90' });
  // Sensible defaults for the rollback-readiness inputs (only computeRollbackReadiness reads these).
  mockGetBackupEnvSummary.mockResolvedValue({ exists: true, envPresent: true, keys: ['DB_HOST'] });
  mockEnvExists.mockResolvedValue(true);
});

describe('UpdateGuardService.probeContainers', () => {
  it('skips a container that vanished between list and inspect (404)', async () => {
    mockListContainers.mockResolvedValue([
      { Id: 'aaa', Names: ['/app-web-1'], State: 'running' },
      { Id: 'bbb', Names: ['/app-db-1'], State: 'running' },
    ]);
    mockGetContainer.mockImplementation((id: string) => ({
      inspect: id === 'bbb'
        ? vi.fn().mockRejectedValue(Object.assign(new Error('no such container'), { statusCode: 404 }))
        : vi.fn().mockResolvedValue(inspectResult()),
    }));

    const probes = await UpdateGuardService.getInstance().probeContainers(0, 'app');
    expect(probes).toHaveLength(1);
    expect(probes[0].name).toBe('app-web-1');
  });

  it('propagates non-404 inspect failures so the whole signal degrades honestly', async () => {
    mockListContainers.mockResolvedValue([
      { Id: 'aaa', Names: ['/app-web-1'], State: 'running' },
    ]);
    mockGetContainer.mockReturnValue({
      inspect: vi.fn().mockRejectedValue(Object.assign(new Error('daemon hiccup'), { statusCode: 500 })),
    });

    await expect(UpdateGuardService.getInstance().probeContainers(0, 'app')).rejects.toThrow('daemon hiccup');
  });
});

describe('UpdateGuardService.computeUpdateReadiness wiring', () => {
  it('returns a complete unknown-verdict report when every collaborator fails', async () => {
    mockGetLatest.mockImplementation(() => { throw new Error('db gone'); });
    mockGetOpenDriftFindings.mockImplementation(() => { throw new Error('db gone'); });
    mockListContainers.mockRejectedValue(new Error('docker gone'));
    mockGetPreview.mockRejectedValue(new Error('registry gone'));
    mockGetBackupInfo.mockRejectedValue(new Error('fs gone'));
    mockFsSize.mockRejectedValue(new Error('si gone'));

    const report = await UpdateGuardService.getInstance().computeUpdateReadiness(0, 'app');

    expect(report.stack).toBe('app');
    expect(report.signals.map(s => s.id)).toEqual([
      'preflight', 'drift', 'containers', 'healthchecks', 'update_preview', 'backup_slot', 'disk',
    ]);
    // The container probe failure is the verdict-affecting unknown.
    expect(report.verdict).toBe('unknown');
  });

  it('produces a ready verdict from healthy collaborator outputs', async () => {
    mockGetLatest.mockReturnValue({ status: 'pass' });
    mockGetOpenDriftFindings.mockReturnValue([]);
    mockListContainers.mockResolvedValue([{ Id: 'aaa', Names: ['/app-web-1'], State: 'running' }]);
    mockGetContainer.mockReturnValue({ inspect: vi.fn().mockResolvedValue(inspectResult()) });
    mockGetPreview.mockResolvedValue({
      stack_name: 'app',
      images: [],
      summary: {
        has_update: true, primary_image: 'nginx', current_tag: '1.27.0', next_tag: '1.27.1',
        semver_bump: 'patch', update_kind: 'tag', blocked: false, blocked_reason: null,
      },
      rollback_target: 'nginx:1.27.0',
      changelog: null,
    });
    mockGetBackupInfo.mockResolvedValue({ exists: true, timestamp: Date.now() });
    mockFsSize.mockResolvedValue([{ mount: '/', use: 42 }]);

    const report = await UpdateGuardService.getInstance().computeUpdateReadiness(0, 'app');
    expect(report.verdict).toBe('ready');
  });
});

describe('UpdateGuardService.computeRollbackReadiness moving-tag wiring', () => {
  const preview = (images: Array<{ current_tag: string }>) => ({
    stack_name: 'app',
    images,
    summary: {
      has_update: false, primary_image: 'app', current_tag: images[0]?.current_tag ?? null,
      next_tag: null, semver_bump: 'none', update_kind: 'none', blocked: false, blocked_reason: null,
    },
    rollback_target: 'app:1.2.3',
    changelog: null,
  });

  beforeEach(() => {
    mockGetBackupInfo.mockResolvedValue({ exists: true, timestamp: Date.now() });
    mockListContainers.mockResolvedValue([]);
  });

  it('marks previous_images not_covered (overall partial) when any image uses a moving tag', async () => {
    // Primary pinned, sidecar on a moving tag: a file rollback cannot revert it.
    mockGetPreview.mockResolvedValue(preview([{ current_tag: '1.2.3' }, { current_tag: 'latest' }]));
    const report = await UpdateGuardService.getInstance().computeRollbackReadiness(0, 'app');
    expect(report.items.find(i => i.id === 'previous_images')?.state).toBe('not_covered');
    expect(report.overall).toBe('partial');
  });

  it('marks previous_images ready (overall ready) when every image is pinned', async () => {
    mockGetPreview.mockResolvedValue(preview([{ current_tag: '1.2.3' }, { current_tag: 'v2.0.1' }]));
    const report = await UpdateGuardService.getInstance().computeRollbackReadiness(0, 'app');
    expect(report.items.find(i => i.id === 'previous_images')?.state).toBe('ready');
    expect(report.overall).toBe('ready');
  });
});
