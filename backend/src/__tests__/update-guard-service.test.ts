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
  mockBuildEffectiveServiceModel,
  mockGetGitSource,
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
  mockBuildEffectiveServiceModel: vi.fn(),
  mockGetGitSource: vi.fn(),
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
      // Rollback-readiness partial-revert disclosure reads the git source row;
      // no git-managed stacks in these fixtures by default.
      getGitSource: mockGetGitSource,
      // Generation supersede path; no current recovery generation in these fixtures.
      getCurrentStackUpdateRecovery: () => undefined,
    }),
  },
}));

vi.mock('systeminformation', () => ({
  default: { fsSize: mockFsSize },
}));

vi.mock('../services/effectiveServiceModel', () => ({
  buildEffectiveServiceModel: mockBuildEffectiveServiceModel,
}));

import { UpdateGuardService, SingleServiceUpdateReadinessError } from '../services/UpdateGuardService';

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

  it('treats Test NONE as no effective healthcheck', async () => {
    mockListContainers.mockResolvedValue([
      { Id: 'aaa', Names: ['/app-web-1'], State: 'running' },
    ]);
    mockGetContainer.mockReturnValue({
      inspect: vi.fn().mockResolvedValue(inspectResult({
        Config: { Healthcheck: { Test: ['NONE'] } },
      })),
    });

    const probes = await UpdateGuardService.getInstance().probeContainers(0, 'app');
    expect(probes).toHaveLength(1);
    expect(probes[0].hasHealthcheck).toBe(false);
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
      'preflight', 'drift', 'containers', 'healthchecks', 'update_preview', 'build_services', 'backup_slot', 'disk',
    ]);
    // The container probe failure is the verdict-affecting unknown.
    expect(report.verdict).toBe('unknown');
  });

  it('produces a ready verdict from healthy collaborator outputs', async () => {
    mockGetLatest.mockReturnValue({ activeStatus: 'pass' });
    mockGetOpenDriftFindings.mockReturnValue([]);
    mockListContainers.mockResolvedValue([{ Id: 'aaa', Names: ['/app-web-1'], State: 'running' }]);
    mockGetContainer.mockReturnValue({ inspect: vi.fn().mockResolvedValue(inspectResult()) });
    mockGetPreview.mockResolvedValue({
      stack_name: 'app',
      images: [],
      build_services: [],
      summary: {
        has_update: true, primary_image: 'nginx', current_tag: '1.27.0', next_tag: '1.27.1',
        semver_bump: 'patch', update_kind: 'tag', blocked: false, blocked_reason: null,
        has_build_services: false, rebuild_available: false, check_status: 'ok', verification_failed: false, verification_error: null,
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

describe('UpdateGuardService.computeUpdateReadiness with a serviceName', () => {
  const twoServiceModel = {
    renderable: true as const,
    services: [
      { name: 'web', declaredImage: 'nginx:1.27', hasBuild: false, expectedReplicas: 1, dependsOn: [], hasHealthcheck: true },
      { name: 'db', declaredImage: 'postgres:16', hasBuild: false, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false },
    ],
  };
  const multiServicePreview = {
    stack_name: 'app',
    images: [
      { service: 'web', image: 'nginx', current_tag: '1.27.0', next_tag: '1.27.1', has_update: true, semver_bump: 'patch' },
      { service: 'db', image: 'postgres', current_tag: '16.0', next_tag: null, has_update: false, semver_bump: 'none' },
    ],
    build_services: [],
    summary: {
      has_update: true, primary_image: 'nginx', current_tag: '1.27.0', next_tag: '1.27.1',
      semver_bump: 'patch', update_kind: 'tag', blocked: false, blocked_reason: null,
      has_build_services: false, rebuild_available: false, check_status: 'ok', verification_failed: false, verification_error: null,
    },
    rollback_target: 'nginx:1.27.0',
    changelog: null,
  };

  beforeEach(() => {
    mockGetLatest.mockReturnValue({ activeStatus: 'pass' });
    mockGetOpenDriftFindings.mockReturnValue([]);
    mockGetPreview.mockResolvedValue(multiServicePreview);
    mockGetBackupInfo.mockResolvedValue({ exists: true, timestamp: Date.now() });
    mockFsSize.mockResolvedValue([{ mount: '/', use: 42 }]);
    mockListContainers.mockResolvedValue([
      { Id: 'web1', Names: ['/web'], State: 'running' },
      { Id: 'db1', Names: ['/db'], State: 'running' },
    ]);
    mockGetContainer.mockReturnValue({ inspect: vi.fn().mockResolvedValue(inspectResult()) });
  });

  it('scopes the verdict to the selected service, includes a service signal, and filters the preview', async () => {
    mockBuildEffectiveServiceModel.mockResolvedValue(twoServiceModel);

    const report = await UpdateGuardService.getInstance().computeUpdateReadiness(0, 'app', 'web');

    expect(report.serviceName).toBe('web');
    expect(report.verdict).toBe('ready');
    const serviceSig = report.signals.find(s => s.id === 'service');
    expect(serviceSig?.status).toBe('ok');
    // update_preview signal is derived from the filtered summary (recomputed for 'web' only).
    const previewSig = report.signals.find(s => s.id === 'update_preview');
    expect(previewSig?.status).toBe('ok');
  });

  it('throws SingleServiceUpdateReadinessError for a single-service stack', async () => {
    mockBuildEffectiveServiceModel.mockResolvedValue({
      renderable: true,
      services: [{ name: 'web', declaredImage: 'nginx:1.27', hasBuild: false, expectedReplicas: 1, dependsOn: [], hasHealthcheck: true }],
    });

    await expect(UpdateGuardService.getInstance().computeUpdateReadiness(0, 'app', 'web'))
      .rejects.toBeInstanceOf(SingleServiceUpdateReadinessError);
  });

  it('fails closed (blocked service signal) when the effective model fails to render', async () => {
    mockBuildEffectiveServiceModel.mockResolvedValue({
      renderable: false,
      code: 'effective_model_render_failed',
      error: 'bad yaml',
    });

    const report = await UpdateGuardService.getInstance().computeUpdateReadiness(0, 'app', 'web');

    const serviceSig = report.signals.find(s => s.id === 'service');
    expect(serviceSig?.status).toBe('blocked');
    expect(report.verdict).toBe('blocked');
  });

  it('fails closed when the selected service is not declared in the model', async () => {
    mockBuildEffectiveServiceModel.mockResolvedValue(twoServiceModel);

    const report = await UpdateGuardService.getInstance().computeUpdateReadiness(0, 'app', 'cache');

    const serviceSig = report.signals.find(s => s.id === 'service');
    expect(serviceSig?.status).toBe('blocked');
    expect(report.verdict).toBe('blocked');
  });

  it('reports a sibling advisory without affecting the verdict', async () => {
    mockBuildEffectiveServiceModel.mockResolvedValue(twoServiceModel);
    mockListContainers.mockResolvedValue([
      { Id: 'web1', Names: ['/web'], State: 'running' },
      { Id: 'db1', Names: ['/db'], State: 'exited', ExitCode: 1 },
    ]);
    mockGetContainer.mockImplementation((id: string) => ({
      inspect: vi.fn().mockResolvedValue(id === 'db1'
        ? inspectResult({ State: { Status: 'exited', ExitCode: 1 } })
        : inspectResult()),
    }));

    const report = await UpdateGuardService.getInstance().computeUpdateReadiness(0, 'app', 'web');

    expect(report.verdict).toBe('ready');
    expect(report.advisories.some(a => a.includes('db'))).toBe(true);
  });
});

describe('UpdateGuardService.computeRollbackReadiness moving-tag wiring', () => {
  const preview = (images: Array<{ current_tag: string }>) => ({
    stack_name: 'app',
    images,
    build_services: [],
    summary: {
      has_update: false, primary_image: 'app', current_tag: images[0]?.current_tag ?? null,
      next_tag: null, semver_bump: 'none', update_kind: 'none', blocked: false, blocked_reason: null,
      has_build_services: false, rebuild_available: false, check_status: 'ok', verification_failed: false, verification_error: null,
    },
    rollback_target: 'app:1.2.3',
    changelog: null,
  });

  beforeEach(() => {
    mockGetBackupInfo.mockResolvedValue({ exists: true, timestamp: Date.now() });
    mockListContainers.mockResolvedValue([]);
  });

  it('marks previous_images ready when any image uses a moving tag (full-stack image ID capture)', async () => {
    mockGetPreview.mockResolvedValue(preview([{ current_tag: '1.2.3' }, { current_tag: 'latest' }]));
    const report = await UpdateGuardService.getInstance().computeRollbackReadiness(0, 'app');
    expect(report.items.find(i => i.id === 'previous_images')?.state).toBe('ready');
    expect(report.overall).toBe('ready');
  });

  it('marks previous_images ready (overall ready) when every image is pinned', async () => {
    mockGetPreview.mockResolvedValue(preview([{ current_tag: '1.2.3' }, { current_tag: 'v2.0.1' }]));
    const report = await UpdateGuardService.getInstance().computeRollbackReadiness(0, 'app');
    expect(report.items.find(i => i.id === 'previous_images')?.state).toBe('ready');
    expect(report.overall).toBe('ready');
  });
});

describe('UpdateGuardService.computeRollbackReadiness git-managed disclosure', () => {
    beforeEach(() => {
        mockGetGitSource.mockReturnValue(undefined);
    });

    it('adds the partial-revert note when the stack is Git-managed and active', async () => {
        mockGetGitSource.mockReturnValue({ manifest_state: 'active' });
        const report = await UpdateGuardService.getInstance().computeRollbackReadiness(1, 'git-stack');
        expect(report.note).toContain('Git-managed');
        expect(report.note).toContain('compose files and .env');
    });

    it('omits the note when the stack has no Git source or no manifest', async () => {
        const report = await UpdateGuardService.getInstance().computeRollbackReadiness(1, 'plain-stack');
        expect(report.note).toBeUndefined();
    });
});
