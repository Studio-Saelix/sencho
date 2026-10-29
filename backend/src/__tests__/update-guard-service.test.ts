/**
 * Wiring tests for UpdateGuardService: container probing resilience and the
 * degrade-everything-to-unknown contract when every collaborator fails. The
 * grading rules themselves are covered by the pure readiness tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The rollback-readiness rows read managed-input coverage through the real
// inventory, so the fixtures below need a compose root it can actually read.
const mockState = { composeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-guard-')) };
fs.mkdirSync(path.join(mockState.composeDir, 'app'), { recursive: true });
fs.writeFileSync(path.join(mockState.composeDir, 'app', 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');

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
  mockComposeVersion,
  mockGetStacksStrict,
  mockGetStackUpdateDetail,
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
  mockComposeVersion: vi.fn(),
  mockGetStacksStrict: vi.fn(),
  mockGetStackUpdateDetail: vi.fn(),
}));

vi.mock('../services/DockerController', () => ({
  default: {
    getInstance: () => ({
      getDocker: () => ({
        // Docker applies `filters.label` in the engine. Model that here so a
        // regression to a project-label-only lookup cannot pass on a fixture
        // that returns every container regardless of the filter it supplied.
        listContainers: async (options?: { filters?: { label?: string[] } }) => {
          const listed = await mockListContainers(options) as Array<{ Labels?: Record<string, string> }>;
          const labels = options?.filters?.label ?? [];
          if (labels.length === 0) return listed;
          return listed.filter(container => labels.every((label) => {
            const at = label.indexOf('=');
            const key = at === -1 ? label : label.slice(0, at);
            const value = at === -1 ? undefined : label.slice(at + 1);
            return value === undefined
              ? container.Labels?.[key] !== undefined
              : container.Labels?.[key] === value;
          }));
        },
        getContainer: mockGetContainer,
      }),
    }),
  },
}));

vi.mock('../services/ComposeDoctorService', () => ({
  ComposeDoctorService: { getInstance: () => ({ getLatest: mockGetLatest }) },
}));

vi.mock('../services/ComposeService', () => ({
  ComposeService: { getInstance: () => ({ composeVersion: mockComposeVersion }) },
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
      getBaseDir: () => mockState.composeDir,
      getOverrideFilename: async () => null,
      // The real inventory resolves COMPOSE_FILE through these, so a stack whose
      // env sets it must read as unverifiable rather than as a read failure.
      getEnvContent: async (stackName: string) =>
        fs.readFileSync(path.join(mockState.composeDir, stackName, '.env'), 'utf8'),
      readFile: async (absPath: string) => fs.readFileSync(absPath, 'utf8'),
      getStacksStrict: mockGetStacksStrict,
    }),
  },
}));

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getComposeDir: () => mockState.composeDir,
      getDefaultNodeId: () => 0,
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
      // Managed-input coverage reads these through the real inventory.
      isMeshStackEnabled: () => false,
      getStackProjectEnvFiles: () => [],
      getStackUpdateDetail: mockGetStackUpdateDetail,
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
import { buildStackReadinessSummary } from '../services/readiness/stackReadinessSummary';
import { CacheService } from '../services/CacheService';
import type { RollbackReadinessReport } from '../services/updateGuard/types';

const inspectResult = (over: Record<string, unknown> = {}) => ({
  State: { Status: 'running', ExitCode: 0 },
  Config: { Healthcheck: { Test: ['CMD', 'true'] } },
  HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
  Mounts: [],
  ...over,
});

/** A listed container the readiness probes see as part of the `app` stack. */
const listed = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  Id: id,
  Names: [`/${name}`],
  State: 'running',
  Labels: { 'com.docker.compose.project': 'app' },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetGlobalSettings.mockReturnValue({ host_disk_limit: '90' });
  mockComposeVersion.mockResolvedValue('5.6.0');
  mockGetStackUpdateDetail.mockReturnValue({});
  // Sensible defaults for the rollback-readiness inputs (only computeRollbackReadiness reads these).
  mockGetBackupEnvSummary.mockResolvedValue({ exists: true, envPresent: true, keys: ['DB_HOST'] });
  mockEnvExists.mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(mockState.composeDir, { recursive: true, force: true });
});

describe('UpdateGuardService.probeContainers', () => {
  it('skips a container that vanished between list and inspect (404)', async () => {
    mockListContainers.mockResolvedValue([
      listed('aaa', 'app-web-1'),
      listed('bbb', 'app-db-1'),
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
      listed('aaa', 'app-web-1'),
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
      listed('aaa', 'app-web-1'),
    ]);
    mockGetContainer.mockReturnValue({
      inspect: vi.fn().mockRejectedValue(Object.assign(new Error('daemon hiccup'), { statusCode: 500 })),
    });

    await expect(UpdateGuardService.getInstance().probeContainers(0, 'app')).rejects.toThrow('daemon hiccup');
  });

  it('maps the Compose labels, treating an empty label as absent', async () => {
    mockListContainers.mockResolvedValue([
      listed('aaa', 'app-web-1', {
        Labels: {
          'com.docker.compose.project': 'app',
          'com.docker.compose.service': 'web',
          'com.docker.compose.version': '2.38.1',
          'com.docker.compose.oneoff': 'True',
        },
      }),
      listed('bbb', 'app-db-1', {
        Labels: {
          'com.docker.compose.project': 'app',
          'com.docker.compose.service': '',
          'com.docker.compose.version': '',
        },
      }),
    ]);
    mockGetContainer.mockReturnValue({ inspect: vi.fn().mockResolvedValue(inspectResult()) });

    const probes = await UpdateGuardService.getInstance().probeContainers(0, 'app');
    expect(probes[0]).toMatchObject({ service: 'web', composeVersion: '2.38.1', oneOff: true });
    expect(probes[1]).toMatchObject({ service: null, composeVersion: null, oneOff: false });
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
    mockListContainers.mockResolvedValue([listed('aaa', 'app-web-1')]);
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

  /** Every input other than the Compose version answers healthy. */
  function healthyCollaborators(containers: unknown[] = [], composeVersion: string | null = '5.6.0') {
    mockGetLatest.mockReturnValue({ activeStatus: 'pass' });
    mockGetOpenDriftFindings.mockReturnValue([]);
    mockListContainers.mockResolvedValue(containers);
    mockGetContainer.mockReturnValue({ inspect: vi.fn().mockResolvedValue(inspectResult()) });
    mockGetPreview.mockResolvedValue({
      stack_name: 'app',
      images: [],
      build_services: [],
      summary: {
        has_update: false, primary_image: null, current_tag: null, next_tag: null,
        semver_bump: 'none', update_kind: 'none', blocked: false, blocked_reason: null,
        has_build_services: false, rebuild_available: false, check_status: 'ok', verification_failed: false, verification_error: null,
      },
      rollback_target: null,
      changelog: null,
    });
    mockGetBackupInfo.mockResolvedValue({ exists: true, timestamp: Date.now() });
    mockFsSize.mockResolvedValue([{ mount: '/', use: 42 }]);
    mockComposeVersion.mockResolvedValue(composeVersion);
  }

  const labeled = (service: string, version: string) => ({
    Id: `${service}-1`,
    Names: [`/app-${service}-1`],
    State: 'running',
    Labels: {
      'com.docker.compose.project': 'app',
      'com.docker.compose.service': service,
      'com.docker.compose.version': version,
    },
  });

  it('shows the Compose version as ok when every container matches', async () => {
    healthyCollaborators([labeled('web', '5.6.0')]);
    const report = await UpdateGuardService.getInstance().computeUpdateReadiness(0, 'app');
    const signal = report.signals.find(s => s.id === 'compose_version');
    expect(signal?.status).toBe('ok');
    expect(report.verdict).toBe('ready');
  });

  it('warns, without blocking, when a container was created by another version', async () => {
    healthyCollaborators([labeled('web', '2.38.1'), labeled('db', '2.38.1')]);
    const report = await UpdateGuardService.getInstance().computeUpdateReadiness(0, 'app');
    const signal = report.signals.find(s => s.id === 'compose_version');
    expect(signal?.status).toBe('warning');
    expect(signal?.detail).toContain('db and web were created by Docker Compose 2.38.1');
    expect(report.verdict).toBe('ready_with_warnings');
  });

  it('finds the stack by working directory when its Compose project name differs', async () => {
    // The directory is `app` but Compose runs under the project name
    // `production` (a top-level `name:` key). A project-label-only lookup would
    // see no containers and positively report matching versions.
    const stackDir = path.join(mockState.composeDir, 'app');
    const named = (service: string, version: string) => ({
      Id: `production-${service}-1`,
      Names: [`/production-${service}-1`],
      State: 'running',
      Labels: {
        'com.docker.compose.project': 'production',
        'com.docker.compose.project.working_dir': stackDir,
        'com.docker.compose.service': service,
        'com.docker.compose.version': version,
      },
    });
    healthyCollaborators([
      named('web', '2.38.1'),
      // Another project whose service shares the name must not leak in.
      {
        Id: 'other-web-1',
        Names: ['/other-web-1'],
        State: 'running',
        Labels: {
          'com.docker.compose.project': 'other',
          'com.docker.compose.project.working_dir': path.join(mockState.composeDir, 'other'),
          'com.docker.compose.service': 'web',
          'com.docker.compose.version': '2.38.1',
        },
      },
    ]);

    const report = await UpdateGuardService.getInstance().computeUpdateReadiness(0, 'app');
    const signal = report.signals.find(s => s.id === 'compose_version');
    expect(signal?.status).toBe('warning');
    expect(signal?.detail).toContain('web was created by Docker Compose 2.38.1');
    expect(report.signals.find(s => s.id === 'containers')?.detail).toContain('1 container');
    expect(report.verdict).toBe('ready_with_warnings');
  });

  it('does not report a matching version when a listed stack container cannot be inspected', async () => {
    // A container with no id (a proxy that omitted it) makes the container set
    // incomplete; the readiness report must not fall back to a positive
    // "everything matches" from the containers it could inspect.
    healthyCollaborators([
      labeled('web', '5.6.0'),
      { Names: ['/app-db-1'], State: 'running', Labels: { 'com.docker.compose.project': 'app' } },
    ]);

    const report = await UpdateGuardService.getInstance().computeUpdateReadiness(0, 'app');

    expect(report.signals.find(s => s.id === 'compose_version')).toBeUndefined();
    expect(report.signals.find(s => s.id === 'containers')).toMatchObject({ status: 'unknown', affectsVerdict: true });
    expect(report.verdict).toBe('unknown');
  });

  it('reports an informational unknown when the version probe rejects, and still returns', async () => {
    healthyCollaborators([labeled('web', '2.38.1')]);
    mockComposeVersion.mockRejectedValue(new Error('compose hung'));
    const report = await UpdateGuardService.getInstance().computeUpdateReadiness(0, 'app');
    const signal = report.signals.find(s => s.id === 'compose_version');
    expect(signal?.status).toBe('unknown');
    expect(signal?.affectsVerdict).toBe(false);
    expect(report.verdict).toBe('ready');
  });

  it('bounds a hung version probe inside the dialog deadline and keeps every other signal', async () => {
    healthyCollaborators([labeled('web', '2.38.1')]);
    mockComposeVersion.mockReturnValue(new Promise(() => {}));
    // A second network-backed input is slow too; both start together, so the
    // version probe must not be appended after the others.
    mockGetPreview.mockReturnValue(new Promise(() => {}));

    vi.useFakeTimers();
    try {
      let settled = false;
      const pending = UpdateGuardService.getInstance().computeUpdateReadiness(0, 'app')
        .finally(() => { settled = true; });
      // The dialog aborts at 4,000 ms. Both hung inputs share the 3,000 ms
      // readiness budget, so the report settles with 1,000 ms of transport
      // margin. Fail fast when it has not settled, instead of hanging an await.
      await vi.advanceTimersByTimeAsync(3_000);
      expect(settled).toBe(true);
      const report = await pending;

      expect(report.signals.find(s => s.id === 'compose_version')).toMatchObject({
        status: 'unknown',
        affectsVerdict: false,
      });
      expect(report.signals.find(s => s.id === 'update_preview')).toMatchObject({
        status: 'unknown',
        affectsVerdict: false,
      });
      expect(report.signals.find(s => s.id === 'containers')?.status).toBe('ok');
      expect(report.verdict).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends the optional probe before a caller deadline, keeping headroom', async () => {
    healthyCollaborators([labeled('web', '2.38.1')]);
    mockComposeVersion.mockReturnValue(new Promise(() => {}));

    vi.useFakeTimers();
    try {
      let settled = false;
      const pending = UpdateGuardService.getInstance()
        .computeUpdateReadiness(0, 'app', undefined, { deadlineEpochMs: Date.now() + 1_000 })
        .finally(() => { settled = true; });
      // The probe gets 750 ms: the deadline minus the 250 ms the report needs
      // to be assembled after the probe settles.
      await vi.advanceTimersByTimeAsync(749);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      const report = await pending;

      expect(report.signals.find(s => s.id === 'compose_version')).toMatchObject({
        status: 'unknown',
        affectsVerdict: false,
      });
      expect(report.verdict).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each<[string, number]>([
    ['a past instant', 0],
    ['exactly the headroom', 250],
    ['a non-finite value', Number.NaN],
  ])('skips the optional probe when the deadline is %s', async (_case, offset) => {
    healthyCollaborators([labeled('web', '2.38.1')]);
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Freeze the clock so "exactly the headroom" leaves a budget of exactly
    // zero, not one that a millisecond of test overhead makes negative.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_700_000_000_000);
      const report = await UpdateGuardService.getInstance()
        .computeUpdateReadiness(0, 'app', undefined, { deadlineEpochMs: Date.now() + offset });

      expect(mockComposeVersion).not.toHaveBeenCalled();
      expect(report.signals.find(s => s.id === 'compose_version')).toMatchObject({
        status: 'unknown',
        affectsVerdict: false,
      });
      expect(report.verdict).toBe('ready');
      expect(warned).toHaveBeenCalledWith(
        '[UpdateGuard] compose version probe skipped for %s: the readiness deadline leaves no usable time for it',
        'app',
      );
    } finally {
      vi.useRealTimers();
    }
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
      listed('web1', 'web', { Labels: { 'com.docker.compose.project': 'app', 'com.docker.compose.service': 'web' } }),
      listed('db1', 'db', { Labels: { 'com.docker.compose.project': 'app', 'com.docker.compose.service': 'db' } }),
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

  it('omits the Compose version signal, which belongs to a full-stack update', async () => {
    mockBuildEffectiveServiceModel.mockResolvedValue(twoServiceModel);

    const report = await UpdateGuardService.getInstance().computeUpdateReadiness(0, 'app', 'web');

    expect(report.signals.some(s => s.id === 'compose_version')).toBe(false);
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
      listed('web1', 'web', { Labels: { 'com.docker.compose.project': 'app', 'com.docker.compose.service': 'web' } }),
      listed('db1', 'db', {
        State: 'exited',
        ExitCode: 1,
        Labels: { 'com.docker.compose.project': 'app', 'com.docker.compose.service': 'db' },
      }),
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

  it('keeps the selected service ready when an unrelated sibling has no id', async () => {
    // A proxy or partial list response can omit `Id` for a container it still
    // reports. The selected-service probe answers for `web` alone, so the
    // unrelated `db` must not turn that verdict into unknown; the whole-stack
    // sibling probe beside it still fails closed on the same response.
    mockBuildEffectiveServiceModel.mockResolvedValue(twoServiceModel);
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockListContainers.mockResolvedValue([
      listed('web1', 'web', { Labels: { 'com.docker.compose.project': 'app', 'com.docker.compose.service': 'web' } }),
      {
        Names: ['/app-db-1'],
        State: 'running',
        Labels: { 'com.docker.compose.project': 'app', 'com.docker.compose.service': 'db' },
      },
    ]);

    const report = await UpdateGuardService.getInstance().computeUpdateReadiness(0, 'app', 'web');

    expect(report.verdict).toBe('ready');
    expect(report.signals.find(s => s.id === 'containers')).toMatchObject({ status: 'ok', affectsVerdict: true });
    expect(report.advisories).toEqual([]);
    expect(warned).toHaveBeenCalledWith(
      '[UpdateGuard] %s unavailable for %s:',
      'sibling containers',
      'app',
      expect.stringContaining('has no id'),
    );
  });

  it('fails closed when the selected service container itself has no id', async () => {
    mockBuildEffectiveServiceModel.mockResolvedValue(twoServiceModel);
    mockListContainers.mockResolvedValue([
      {
        Names: ['/app-web-1'],
        State: 'running',
        Labels: { 'com.docker.compose.project': 'app', 'com.docker.compose.service': 'web' },
      },
      listed('db1', 'db', { Labels: { 'com.docker.compose.project': 'app', 'com.docker.compose.service': 'db' } }),
    ]);

    const report = await UpdateGuardService.getInstance().computeUpdateReadiness(0, 'app', 'web');

    expect(report.signals.find(s => s.id === 'containers')).toMatchObject({ status: 'unknown', affectsVerdict: true });
    expect(report.verdict).toBe('unknown');
  });

  it('scopes a named project by working directory before requiring ids', async () => {
    // The directory is `app` but Compose runs under the project name
    // `production`. Scoping must still find `web` through the working-directory
    // label and exclude the id-less `db` sibling.
    const stackDir = path.join(mockState.composeDir, 'app');
    mockBuildEffectiveServiceModel.mockResolvedValue(twoServiceModel);
    mockListContainers.mockResolvedValue([
      {
        Id: 'production-web-1',
        Names: ['/production-web-1'],
        State: 'running',
        Labels: {
          'com.docker.compose.project': 'production',
          'com.docker.compose.project.working_dir': stackDir,
          'com.docker.compose.service': 'web',
        },
      },
      {
        Names: ['/production-db-1'],
        State: 'running',
        Labels: {
          'com.docker.compose.project': 'production',
          'com.docker.compose.project.working_dir': stackDir,
          'com.docker.compose.service': 'db',
        },
      },
    ]);

    const report = await UpdateGuardService.getInstance().computeUpdateReadiness(0, 'app', 'web');

    expect(report.signals.find(s => s.id === 'containers')).toMatchObject({ status: 'ok' });
    expect(report.verdict).toBe('ready');
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

  it('fails the healthchecks item closed when a stack container has no id', async () => {
    // The rollback probe judges the whole stack, so an uninspectable container
    // must not let the inspectable ones stand in for it.
    mockGetPreview.mockResolvedValue(preview([{ current_tag: '1.2.3' }]));
    mockGetContainer.mockReturnValue({ inspect: vi.fn().mockResolvedValue(inspectResult()) });
    mockListContainers.mockResolvedValue([
      { Names: ['/app-web-1'], State: 'running', Labels: { 'com.docker.compose.project': 'app' } },
      listed('db1', 'app-db-1', { Labels: { 'com.docker.compose.project': 'app' } }),
    ]);
    const report = await UpdateGuardService.getInstance().computeRollbackReadiness(0, 'app');
    expect(report.items.find(i => i.id === 'healthchecks')).toMatchObject({ state: 'unknown' });
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

describe('readiness summary under the pass deadline', () => {
  // Real aggregate builder and real update readiness. The rollback verdict is
  // stubbed to an already-complete report, so the optional Compose version
  // probe is the only bounded wait under test.
  const stacks = ['alpha', 'beta', 'gamma', 'delta'];
  /** The pass orders stacks alphabetically within a rank; `gamma` still runs last. */
  const orderedStacks = [...stacks].sort();

  const healthyPreview = {
    stack_name: 'any',
    images: [],
    build_services: [],
    summary: {
      has_update: false, primary_image: null, current_tag: null, next_tag: null,
      semver_bump: 'none', update_kind: 'none', blocked: false, blocked_reason: null,
      has_build_services: false, rebuild_available: false, check_status: 'ok',
      verification_failed: false, verification_error: null,
    },
    rollback_target: null,
    changelog: null,
  };

  /** One healthy container per stack; `versions` overrides a stack's recorded version. */
  function stackContainers(versions: Record<string, string> = {}) {
    return stacks.map(stack => ({
      Id: `${stack}-web-1`,
      Names: [`/${stack}-web-1`],
      State: 'running',
      Labels: {
        'com.docker.compose.project': stack,
        'com.docker.compose.service': 'web',
        'com.docker.compose.version': versions[stack] ?? '5.6.0',
      },
    }));
  }

  /** A rollback verdict that was already complete when the pass read it. */
  const completedRollback = (stack: string): RollbackReadinessReport => ({
    stack, computedAt: 1, overall: 'ready', items: [],
  });

  beforeEach(() => {
    CacheService.getInstance().flush();
    mockGetStacksStrict.mockImplementation(() => new Promise<string[]>((resolve) => {
      // Nonzero scan latency, so the pass's stack scan is not a single instant.
      setTimeout(() => resolve([...stacks]), 5);
    }));
    mockGetStackUpdateDetail.mockReturnValue({});
    mockGetLatest.mockReturnValue({ activeStatus: 'pass' });
    mockGetOpenDriftFindings.mockReturnValue([]);
    mockListContainers.mockResolvedValue(stackContainers());
    mockGetContainer.mockImplementation(() => ({ inspect: vi.fn().mockResolvedValue(inspectResult()) }));
    mockGetPreview.mockResolvedValue(healthyPreview);
    mockGetBackupInfo.mockResolvedValue({ exists: true, timestamp: Date.now() });
    mockFsSize.mockResolvedValue([{ mount: '/', use: 42 }]);
    vi.spyOn(UpdateGuardService.getInstance(), 'computeRollbackReadiness')
      .mockImplementation(async (_nodeId, stack) => completedRollback(stack));
  });

  /** Run the pass under fake timers, advancing the listing delay and every bounded wait. */
  async function runSummaryWithFakeTimers(): Promise<Awaited<ReturnType<typeof buildStackReadinessSummary>>> {
    let settled = false;
    const pending = buildStackReadinessSummary(0).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(5);
    for (let elapsed = 0; elapsed < 10_000 && !settled; elapsed += 250) {
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(settled).toBe(true);
    return pending;
  }

  async function withFakeTimers(body: () => Promise<void>): Promise<void> {
    vi.useFakeTimers();
    try {
      await body();
    } finally {
      vi.useRealTimers();
    }
  }

  it('keeps responsive version evidence for a late stack', async () => {
    const mismatched = orderedStacks[orderedStacks.length - 1];
    mockListContainers.mockResolvedValue(stackContainers({ [mismatched]: '2.38.1' }));
    let calls = 0;
    mockComposeVersion.mockImplementation(() => {
      calls += 1;
      // The first batch hangs, so the last stack starts with less than three
      // seconds of the pass left. Its probe answers inside that reduced room,
      // and the evidence still reaches the row.
      if (calls < stacks.length) return new Promise(() => {});
      return new Promise((resolve) => { setTimeout(() => resolve('5.6.0'), 1_000); });
    });

    await withFakeTimers(async () => {
      const summary = await runSummaryWithFakeTimers();

      expect(summary.truncated).toBe(false);
      expect(summary.stacks.map(row => row.stack)).toEqual(orderedStacks);
      for (const row of summary.stacks) {
        expect(row.update).not.toBeNull();
        expect(row.rollback).not.toBeNull();
      }
      // The probe still produced evidence for the late stack, and the row
      // carries the warning instead of a generic ready verdict.
      expect(summary.stacks.find(row => row.stack === mismatched)?.update).toMatchObject({
        verdict: 'ready_with_warnings',
        topReasonId: 'compose_version',
      });
      expect(mockComposeVersion).toHaveBeenCalledTimes(stacks.length);
    });
  });

  it('keeps completed update and rollback results when only the version probe hangs', async () => {
    mockComposeVersion.mockReturnValue(new Promise(() => {}));

    await withFakeTimers(async () => {
      const summary = await runSummaryWithFakeTimers();

      // The first batch of hung probes spends the full three-second budget, so
      // the fourth stack starts at 2,995 ms of the pass left. Before the pass
      // deadline was handed to the probe, its fixed three-second wait outlived
      // the per-stack timeout and the row lost both verdicts.
      expect(summary.truncated).toBe(false);
      expect(summary.stacks.map(row => row.stack)).toEqual(orderedStacks);
      for (const row of summary.stacks) {
        expect(row.unavailableReason).toBeNull();
        expect(row.update).not.toBeNull();
        expect(row.rollback).not.toBeNull();
      }
      // The optional evidence degrades to its informational unknown; the
      // verdict it does not affect stays ready. The probe was attempted and
      // bounded for every stack, not skipped.
      expect(summary.stacks.every(row => row.update?.verdict === 'ready')).toBe(true);
      expect(mockComposeVersion).toHaveBeenCalledTimes(stacks.length);
    });
  });
});
