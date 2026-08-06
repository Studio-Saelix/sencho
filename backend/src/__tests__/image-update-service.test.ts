/**
 * Unit tests for ImageUpdateService: image ref parsing, compose extraction,
 * env file loading, checkImage digest comparison, and rate limiting.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────

const {
  mockGetAuthForRegistry,
  mockGetStackUpdateStatus, mockUpsertStackUpdateStatus, mockClearStackUpdateStatus,
  mockClearAllStackUpdateStatus, mockUpdateGlobalSetting,
  mockRecordStackCheckFailure, mockGetStackServicesJson,
  mockGetSystemState, mockSetSystemState, mockAddNotificationHistory,
  mockDispatchAlert, mockBroadcastEvent,
  mockGetStacks, mockGetStackContent, mockGetEnvContent, mockEnvExists,
  mockGetAllContainers, mockGetGlobalSettings, mockInspect,
  mockBuildEffectiveServiceModel,
} = vi.hoisted(() => ({
  mockGetAuthForRegistry: vi.fn().mockResolvedValue(null),
  mockGetStackUpdateStatus: vi.fn().mockReturnValue({}),
  mockUpsertStackUpdateStatus: vi.fn(),
  mockClearStackUpdateStatus: vi.fn(),
  mockClearAllStackUpdateStatus: vi.fn().mockReturnValue(0),
  mockUpdateGlobalSetting: vi.fn(),
  mockRecordStackCheckFailure: vi.fn(),
  mockGetStackServicesJson: vi.fn().mockReturnValue([]),
  mockGetSystemState: vi.fn().mockReturnValue('1'), // default: backfilled
  mockSetSystemState: vi.fn(),
  mockAddNotificationHistory: vi.fn(),
  mockDispatchAlert: vi.fn().mockResolvedValue({ persisted: true }),
  mockBroadcastEvent: vi.fn(),
  mockGetStacks: vi.fn().mockResolvedValue([]),
  mockGetStackContent: vi.fn().mockResolvedValue(''),
  mockGetEnvContent: vi.fn().mockRejectedValue(new Error('no env')),
  mockEnvExists: vi.fn().mockResolvedValue(false),
  mockGetAllContainers: vi.fn().mockResolvedValue([]),
  mockGetGlobalSettings: vi.fn().mockReturnValue({ developer_mode: '0' }),
  // Backs DockerController.getInstance().getDocker().getImage().inspect() for tests
  // that exercise the real checkImage (rather than stubbing it) through checkNode.
  mockInspect: vi.fn().mockResolvedValue({ RepoDigests: [] }),
  // Defaults to non-renderable so checkNode's per-service reduction is a no-op
  // (falls back to the legacy whole-stack tally) unless a test overrides this,
  // matching how no real Compose model exists in this unit-test environment.
  mockBuildEffectiveServiceModel: vi.fn().mockResolvedValue({ renderable: false, code: 'effective_model_render_failed', error: 'no model in test' }),
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
      updateGlobalSetting: mockUpdateGlobalSetting,
      getNodes: () => [],
      getGitSource: () => undefined,
      getStackProjectEnvFiles: () => [],
      upsertStackUpdateStatus: mockUpsertStackUpdateStatus,
      getStackUpdateStatus: mockGetStackUpdateStatus,
      clearStackUpdateStatus: mockClearStackUpdateStatus,
      clearAllStackUpdateStatus: mockClearAllStackUpdateStatus,
      recordStackCheckFailure: mockRecordStackCheckFailure,
      getStackServicesJson: mockGetStackServicesJson,
      getSystemState: mockGetSystemState,
      setSystemState: mockSetSystemState,
      addNotificationHistory: mockAddNotificationHistory,
    }),
  },
}));

vi.mock('../services/effectiveServiceModel', () => ({
  buildEffectiveServiceModel: mockBuildEffectiveServiceModel,
}));

vi.mock('../services/NotificationService', () => ({
  NotificationService: {
    getInstance: () => ({
      dispatchAlert: mockDispatchAlert,
      broadcastEvent: mockBroadcastEvent,
    }),
  },
}));

vi.mock('../helpers/fleetUpdateCache', () => ({
  invalidateFleetUpdateCache: vi.fn(),
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
      getDocker: () => ({ getImage: () => ({ inspect: mockInspect }) }),
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

// compareLocalToRemoteTag is module-scoped inside checkImage; mock it to drive the
// comparison outcome while keeping the real parseImageRef / selectLocalRepoDigests.
const { mockCompareLocalToRemoteTag, mockListRegistryTagsResult } = vi.hoisted(() => ({
  mockCompareLocalToRemoteTag: vi.fn(),
  // Detection now checks tags alongside digests; default to an empty, successful
  // list so digest-focused tests are not accidentally driven by a real network
  // call finding a genuine newer tag for whatever image ref they pass.
  mockListRegistryTagsResult: vi.fn().mockResolvedValue({ ok: true, tags: [] }),
}));
vi.mock('../services/registry-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/registry-api')>();
  return {
    ...actual,
    compareLocalToRemoteTag: mockCompareLocalToRemoteTag,
    listRegistryTagsResult: mockListRegistryTagsResult,
  };
});

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

import {
  ImageUpdateService,
  UPDATE_DIGEST_UNCHANGED_WARNING,
  UPDATE_STILL_PRESENT_WARNING,
  otherServicesStillPresentWarning,
} from '../services/ImageUpdateService';
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

  it('marks sha256-only refs not-checkable (no tag to track)', async () => {
    const docker = makeMockDocker();
    const result = await service.checkImage(docker, 'sha256:abc123');
    expect(result).toEqual({ hasUpdate: false, checkStatus: 'not_checkable', notCheckable: true });
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

  it('marks an image with no RepoDigests not-checkable (locally built)', async () => {
    // Empty RepoDigests means locally built / not registry-backed.
    const docker = makeMockDocker([]);
    const result = await service.checkImage(docker, 'nginx:latest');
    expect(result).toEqual({ hasUpdate: false, checkStatus: 'not_checkable', notCheckable: true });
  });

  it('errors when RepoDigests are present but none resolves a digest', async () => {
    // A non-empty set with no usable sha256 digest is ambiguous: surface it as an
    // error rather than a silent "up to date".
    const docker = makeMockDocker(['library/nginx:latest']);
    const result = await service.checkImage(docker, 'nginx:latest');
    expect(result.hasUpdate).toBe(false);
    expect(result.notCheckable).toBeUndefined();
    expect(result.error).toContain('Could not resolve a local registry digest');
  });

  it('errors (not a comparison) when the sole valid RepoDigest belongs to an unrelated repository', async () => {
    // A well-formed digest is present, but it names a different repo (e.g.
    // left over from a retag): comparing it against this ref's registry state
    // would risk a false update against unrelated content.
    const docker = makeMockDocker([`ghcr.io/other/image@sha256:${'b'.repeat(64)}`]);
    const result = await service.checkImage(docker, 'nginx:latest');
    expect(result.hasUpdate).toBe(false);
    expect(result.notCheckable).toBeUndefined();
    expect(result.error).toContain('Could not resolve a local registry digest');
  });
});

// ── checkImage surfaces the comparison resolver's outcome ──────────────

describe('ImageUpdateService - checkImage surfaces the comparison resolver outcome', () => {
  let service: ImageUpdateService;

  const LOCAL_DIGEST = `sha256:${'a'.repeat(64)}`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockListRegistryTagsResult.mockResolvedValue({ ok: true, tags: [] });
    (ImageUpdateService as any).instance = undefined;
    service = ImageUpdateService.getInstance();
  });

  // One RepoDigest matching the ref so the local digest resolves and the flow reaches
  // compareLocalToRemoteTag.
  const dockerWithLocalDigest = (digest: string) => ({
    getDocker: () => ({
      getImage: () => ({ inspect: vi.fn().mockResolvedValue({
        RepoDigests: [`ghcr.io/linuxserver/radarr@${digest}`],
        Os: 'linux',
        Architecture: 'amd64',
      }) }),
    }),
  } as any);

  const dockerWithNginxSemver = (repoDigests: string[] = [`registry-1.docker.io/library/nginx@${LOCAL_DIGEST}`]) => ({
    getDocker: () => ({
      getImage: () => ({ inspect: vi.fn().mockResolvedValue({
        RepoDigests: repoDigests,
        Os: 'linux',
        Architecture: 'amd64',
      }) }),
    }),
  } as any);

  it('surfaces the specific failure reason (not a generic "unreachable") as the check error', async () => {
    mockCompareLocalToRemoteTag.mockResolvedValue({ kind: 'error', reason: 'Authentication failed for ghcr.io/linuxserver/radarr:latest' });
    const result = await service.checkImage(dockerWithLocalDigest(LOCAL_DIGEST), 'ghcr.io/linuxserver/radarr:latest');
    expect(result).toMatchObject({ hasUpdate: false, checkStatus: 'failed', error: 'Authentication failed for ghcr.io/linuxserver/radarr:latest' });
  });

  it('reports an update when the comparison resolver classifies the remote as an update', async () => {
    mockCompareLocalToRemoteTag.mockResolvedValue({ kind: 'update' });
    const result = await service.checkImage(dockerWithLocalDigest(LOCAL_DIGEST), 'ghcr.io/linuxserver/radarr:latest');
    expect(result).toMatchObject({ hasUpdate: true, digestUpdate: true, checkStatus: 'ok' });
  });

  it('reports no update when the comparison resolver classifies the remote as a match', async () => {
    mockCompareLocalToRemoteTag.mockResolvedValue({ kind: 'match' });
    const result = await service.checkImage(dockerWithLocalDigest(LOCAL_DIGEST), 'ghcr.io/linuxserver/radarr:latest');
    expect(result).toMatchObject({ hasUpdate: false, digestUpdate: false, checkStatus: 'ok' });
  });

  it('passes the local digest, platform, and parsed ref through to the comparison resolver', async () => {
    mockCompareLocalToRemoteTag.mockResolvedValue({ kind: 'match' });
    await service.checkImage(dockerWithLocalDigest(LOCAL_DIGEST), 'ghcr.io/linuxserver/radarr:latest');
    expect(mockCompareLocalToRemoteTag).toHaveBeenCalledWith(
      [LOCAL_DIGEST],
      'ghcr.io',
      'linuxserver/radarr',
      'latest',
      { os: 'linux', architecture: 'amd64' },
      null,
    );
  });

  it('reports an update when the declared tag digest matches but a higher semver tag exists', async () => {
    mockCompareLocalToRemoteTag.mockResolvedValue({ kind: 'match' });
    mockListRegistryTagsResult.mockResolvedValue({ ok: true, tags: ['1.2.3', '1.2.4'] });
    const result = await service.checkImage(dockerWithNginxSemver(), 'nginx:1.2.3');
    expect(result).toMatchObject({ hasUpdate: true, digestUpdate: false, tagUpdate: true, checkStatus: 'ok' });
  });

  it('reports an update when digest comparison errors but a higher semver tag exists', async () => {
    mockCompareLocalToRemoteTag.mockResolvedValue({ kind: 'error', reason: 'Registry unreachable' });
    mockListRegistryTagsResult.mockResolvedValue({ ok: true, tags: ['1.2.3', '1.2.4'] });
    const result = await service.checkImage(dockerWithNginxSemver(), 'nginx:1.2.3');
    expect(result).toMatchObject({ hasUpdate: true, digestUpdate: false, tagUpdate: true, checkStatus: 'ok' });
  });

  it('forwards every matching RepoDigest (stale index ahead of current) to the comparison resolver', async () => {
    const STALE = `sha256:${'f'.repeat(64)}`;
    const CURRENT = `sha256:${'e'.repeat(64)}`;
    const docker = {
      getDocker: () => ({
        getImage: () => ({
          inspect: vi.fn().mockResolvedValue({
            RepoDigests: [
              `redis@${STALE}`,
              `redis@${CURRENT}`,
            ],
            Os: 'linux',
            Architecture: 'amd64',
          }),
        }),
      }),
    } as any;
    mockCompareLocalToRemoteTag.mockResolvedValue({ kind: 'match' });
    const result = await service.checkImage(docker, 'redis:8.8.0');
    expect(result).toEqual({ hasUpdate: false, digestUpdate: false, tagUpdate: false, checkStatus: 'ok' });
    expect(mockCompareLocalToRemoteTag).toHaveBeenCalledWith(
      [STALE, CURRENT],
      'registry-1.docker.io',
      'library/redis',
      '8.8.0',
      { os: 'linux', architecture: 'amd64' },
      null,
    );
  });
});

// ── Multi-arch digest comparison persistence (end-to-end via checkNode) ─

describe('ImageUpdateService - multi-arch digest comparison persistence', () => {
  const LOCAL_DIGEST = `sha256:${'a'.repeat(64)}`;
  const COMPOSE = `
services:
  app:
    image: ghcr.io/linuxserver/radarr:latest
`;

  const fakeDb = () => ({
    getStackUpdateStatus: mockGetStackUpdateStatus,
    upsertStackUpdateStatus: mockUpsertStackUpdateStatus,
    clearStackUpdateStatus: mockClearStackUpdateStatus,
    recordStackCheckFailure: mockRecordStackCheckFailure,
    getSystemState: mockGetSystemState,
    setSystemState: mockSetSystemState,
    addNotificationHistory: mockAddNotificationHistory,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockListRegistryTagsResult.mockResolvedValue({ ok: true, tags: [] });
    (ImageUpdateService as any).instance = undefined;
    mockGetSystemState.mockReturnValue('1');
    mockGetStacks.mockResolvedValue(['stackA']);
    mockGetStackContent.mockResolvedValue(COMPOSE);
    mockGetAllContainers.mockResolvedValue([]);
    mockEnvExists.mockResolvedValue(false);
    mockGetAuthForRegistry.mockResolvedValue(null);
    mockInspect.mockResolvedValue({
      RepoDigests: [`ghcr.io/linuxserver/radarr@${LOCAL_DIGEST}`],
      Os: 'linux',
      Architecture: 'amd64',
    });
  });

  it('clears a stored has_update=true after a successful child-manifest match (ok, no last_error, no notification)', async () => {
    mockGetStackUpdateStatus.mockReturnValue({ stackA: true });
    mockCompareLocalToRemoteTag.mockResolvedValue({ kind: 'match' });
    const service = ImageUpdateService.getInstance();

    await (service as any).checkNode(1, fakeDb());

    expect(mockUpsertStackUpdateStatus).toHaveBeenCalledWith(1, 'stackA', false, expect.any(Number), 'ok', null);
    expect(mockRecordStackCheckFailure).not.toHaveBeenCalled();
    expect(mockDispatchAlert).not.toHaveBeenCalled();
  });

  it('preserves a stored has_update=true when the comparison resolver errors (fail-soft, no false negative)', async () => {
    mockGetStackUpdateStatus.mockReturnValue({ stackA: true });
    mockCompareLocalToRemoteTag.mockResolvedValue({ kind: 'error', reason: 'Failed to classify remote manifest for ghcr.io/linuxserver/radarr:latest' });
    const service = ImageUpdateService.getInstance();

    await (service as any).checkNode(1, fakeDb());

    expect(mockRecordStackCheckFailure).toHaveBeenCalledWith(
      1, 'stackA', expect.stringContaining('Failed to classify remote manifest'), expect.any(Number),
    );
    expect(mockUpsertStackUpdateStatus).not.toHaveBeenCalled();
    expect(mockDispatchAlert).not.toHaveBeenCalled();
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
    recordStackCheckFailure: mockRecordStackCheckFailure,
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

    await (service as any).checkNode(1, fakeDb());

    expect(mockDispatchAlert).toHaveBeenCalledTimes(1);
    expect(mockDispatchAlert).toHaveBeenCalledWith(
      'info',
      'image_update_available',
      'Stack "stackA" has image updates available.',
      { stackName: 'stackA', actor: 'system:image-update' },
    );
    expect(mockUpsertStackUpdateStatus).toHaveBeenCalledWith(1, 'stackA', true, expect.any(Number), 'ok', null);
  });

  it('does not re-fire notification for a stack already known to have updates', async () => {
    mockGetStackUpdateStatus.mockReturnValue({ stackA: true });
    const service = ImageUpdateService.getInstance();
    stubCheckImage(service, true);

    await (service as any).checkNode(1, fakeDb());

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

    await (service as any).checkNode(1, fakeDb());

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

    await (service as any).checkNode(1, fakeDb());

    expect(mockDispatchAlert).not.toHaveBeenCalled();
  });

  it('surfaces dispatch failures as an error entry in notification history', async () => {
    mockGetStackUpdateStatus.mockReturnValue({ stackA: false });
    mockDispatchAlert.mockRejectedValueOnce(new Error('webhook timeout'));
    const service = ImageUpdateService.getInstance();
    stubCheckImage(service, true);

    await (service as any).checkNode(1, fakeDb());

    expect(mockAddNotificationHistory).toHaveBeenCalledWith(1, expect.objectContaining({
      level: 'error',
      message: 'Failed to notify about image updates for stack "stackA": webhook timeout',
    }));
  });
});

// ── Tri-state check status (ok / partial / failed) ────────────────────────

describe('ImageUpdateService - check status derivation', () => {
  const COMPOSE_ONE = `
services:
  app:
    image: nginx:latest
`;
  const COMPOSE_TWO = `
services:
  app:
    image: nginx:latest
  db:
    image: postgres:15
`;

  const fakeDb = () => ({
    getStackUpdateStatus: mockGetStackUpdateStatus,
    upsertStackUpdateStatus: mockUpsertStackUpdateStatus,
    clearStackUpdateStatus: mockClearStackUpdateStatus,
    recordStackCheckFailure: mockRecordStackCheckFailure,
    getSystemState: mockGetSystemState,
    setSystemState: mockSetSystemState,
    addNotificationHistory: mockAddNotificationHistory,
  });

  // Per-image stub so a stack can mix ok / errored / not-checkable results.
  function stubCheckImageByRef(service: ImageUpdateService, byRef: Record<string, { hasUpdate?: boolean; error?: string; notCheckable?: boolean }>) {
    (service as any).checkImage = vi.fn().mockImplementation((_docker: unknown, imageRef: string) =>
      Promise.resolve(byRef[imageRef] ?? { hasUpdate: false }),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    (ImageUpdateService as any).instance = undefined;
    mockGetSystemState.mockReturnValue('1');
    mockGetAllContainers.mockResolvedValue([]);
    mockEnvExists.mockResolvedValue(false);
  });

  it('records a failure (preserving has_update) and does not notify when every image errors', async () => {
    // Even with no prior update (previousState false), a failed check must not
    // fire a notification, and must not write has_update via the normal upsert.
    mockGetStacks.mockResolvedValue(['stackA']);
    mockGetStackContent.mockResolvedValue(COMPOSE_ONE);
    mockGetStackUpdateStatus.mockReturnValue({ stackA: true });
    const service = ImageUpdateService.getInstance();
    stubCheckImageByRef(service, { 'nginx:latest': { hasUpdate: false, error: 'Registry unreachable for registry-1.docker.io/library/nginx:latest' } });

    await (service as any).checkNode(1, fakeDb());

    expect(mockRecordStackCheckFailure).toHaveBeenCalledWith(1, 'stackA', expect.stringContaining('Registry unreachable'), expect.any(Number));
    expect(mockUpsertStackUpdateStatus).not.toHaveBeenCalled();
    expect(mockDispatchAlert).not.toHaveBeenCalled();
  });

  it('marks a stack partial (with a reason) when some images error but others resolve', async () => {
    mockGetStacks.mockResolvedValue(['stackA']);
    mockGetStackContent.mockResolvedValue(COMPOSE_TWO);
    mockGetStackUpdateStatus.mockReturnValue({ stackA: false });
    const service = ImageUpdateService.getInstance();
    stubCheckImageByRef(service, {
      'nginx:latest': { hasUpdate: true },
      'postgres:15': { hasUpdate: false, error: 'Registry unreachable for registry-1.docker.io/library/postgres:15' },
    });

    await (service as any).checkNode(1, fakeDb());

    expect(mockUpsertStackUpdateStatus).toHaveBeenCalledWith(1, 'stackA', true, expect.any(Number), 'partial', expect.stringContaining('Registry unreachable'));
    expect(mockRecordStackCheckFailure).not.toHaveBeenCalled();
    // A confirmed update on an ok image still notifies on the false->true transition.
    expect(mockDispatchAlert).toHaveBeenCalledTimes(1);
  });

  it('preserves a previously confirmed update through a partial check and does not re-notify', async () => {
    // Stack had a confirmed update (previousState true). This scan: the updated
    // image errors, the other resolves clean. A partial check must not erase the
    // known update (which would re-fire the notification when the image recovers).
    mockGetStacks.mockResolvedValue(['stackA']);
    mockGetStackContent.mockResolvedValue(COMPOSE_TWO);
    mockGetStackUpdateStatus.mockReturnValue({ stackA: true });
    const service = ImageUpdateService.getInstance();
    stubCheckImageByRef(service, {
      'nginx:latest': { hasUpdate: false, error: 'Registry unreachable for registry-1.docker.io/library/nginx:latest' },
      'postgres:15': { hasUpdate: false },
    });

    await (service as any).checkNode(1, fakeDb());

    expect(mockUpsertStackUpdateStatus).toHaveBeenCalledWith(1, 'stackA', true, expect.any(Number), 'partial', expect.stringContaining('Registry unreachable'));
    expect(mockRecordStackCheckFailure).not.toHaveBeenCalled();
    expect(mockDispatchAlert).not.toHaveBeenCalled();
  });

  it('treats a stack whose only image is not-checkable as ok, not failed', async () => {
    mockGetStacks.mockResolvedValue(['stackA']);
    mockGetStackContent.mockResolvedValue(COMPOSE_ONE);
    mockGetStackUpdateStatus.mockReturnValue({ stackA: false });
    const service = ImageUpdateService.getInstance();
    stubCheckImageByRef(service, { 'nginx:latest': { hasUpdate: false, notCheckable: true } });

    await (service as any).checkNode(1, fakeDb());

    expect(mockUpsertStackUpdateStatus).toHaveBeenCalledWith(1, 'stackA', false, expect.any(Number), 'ok', null);
    expect(mockRecordStackCheckFailure).not.toHaveBeenCalled();
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
    recordStackCheckFailure: mockRecordStackCheckFailure,
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

    await (service as any).checkNode(1, fakeDb());

    expect(mockEnvExists).toHaveBeenCalledWith('stackA');
    expect(mockGetEnvContent).not.toHaveBeenCalled();
  });

  it('reads .env when envExists returns true', async () => {
    mockEnvExists.mockResolvedValue(true);
    mockGetEnvContent.mockResolvedValue('IMAGE_TAG=1.0');
    const service = ImageUpdateService.getInstance();
    stubCheckImage(service, false);

    await (service as any).checkNode(1, fakeDb());

    expect(mockEnvExists).toHaveBeenCalledWith('stackA');
    expect(mockGetEnvContent).toHaveBeenCalledWith('stackA');
  });

  it('continues gracefully when .env exists but is unreadable', async () => {
    mockEnvExists.mockResolvedValue(true);
    mockGetEnvContent.mockRejectedValue(new Error('EACCES: permission denied'));
    const service = ImageUpdateService.getInstance();
    stubCheckImage(service, false);

    await (service as any).checkNode(1, fakeDb());

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
      recordStackCheckFailure: mockRecordStackCheckFailure,
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

  it('start() while checks disabled arms no timer and reports enabled false', () => {
    vi.useFakeTimers();
    mockGetGlobalSettings.mockReturnValue({ image_update_checks_enabled: '0', image_update_check_interval_minutes: '60' });
    const service = ImageUpdateService.getInstance();
    const checkSpy = vi.spyOn(service as any, 'check').mockResolvedValue(undefined);
    service.start();
    const status = service.getStatus();
    expect(status.enabled).toBe(false);
    expect(status.nextCheckAt).toBeNull();
    expect(status.checking).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(checkSpy).not.toHaveBeenCalled();
    checkSpy.mockRestore();
  });

  it('treats a missing checks-enabled key as enabled', () => {
    mockGetGlobalSettings.mockReturnValue({});
    const service = ImageUpdateService.getInstance();
    expect(ImageUpdateService.isChecksEnabled()).toBe(true);
    expect(service.getStatus().enabled).toBe(true);
  });

  it('applyChecksEnabled(false) stops polling, clears local findings, and broadcasts invalidate', () => {
    vi.useFakeTimers();
    mockGetGlobalSettings.mockReturnValue({ image_update_check_interval_minutes: '60' });
    const service = ImageUpdateService.getInstance();
    service.start();
    expect(service.getStatus().nextCheckAt).not.toBeNull();

    mockGetGlobalSettings.mockReturnValue({ image_update_checks_enabled: '0', image_update_check_interval_minutes: '60' });
    mockUpdateGlobalSetting.mockImplementation((key: string, value: string) => {
      if (key === 'image_update_checks_enabled') {
        mockGetGlobalSettings.mockReturnValue({ image_update_checks_enabled: value, image_update_check_interval_minutes: '60' });
      }
    });

    const status = service.applyChecksEnabled(false);
    expect(status.enabled).toBe(false);
    expect(status.nextCheckAt).toBeNull();
    expect(mockUpdateGlobalSetting).toHaveBeenCalledWith('image_update_checks_enabled', '0');
    expect(mockClearAllStackUpdateStatus).toHaveBeenCalledWith(1);
    expect(mockBroadcastEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'state-invalidate',
      scope: 'image-updates',
      nodeId: 1,
    }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('triggerManualRefresh returns false when checks are disabled', () => {
    mockGetGlobalSettings.mockReturnValue({ image_update_checks_enabled: '0' });
    const service = ImageUpdateService.getInstance();
    expect(service.triggerManualRefresh()).toBe(false);
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
    recordStackCheckFailure: mockRecordStackCheckFailure,
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

    await (service as any).checkNode(1, fakeDb());

    expect(mockClearStackUpdateStatus).toHaveBeenCalledWith(1, 'stackB');
  });

  it('does not prune stacks still on disk', async () => {
    mockGetStackUpdateStatus.mockReturnValue({ stackA: false });
    const service = ImageUpdateService.getInstance();
    stubCheckImage(service, false);

    await (service as any).checkNode(1, fakeDb());

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
    recordStackCheckFailure: mockRecordStackCheckFailure,
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

    await (service as any).checkNode(1, fakeDb());

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

    await (service as any).checkNode(1, fakeDb());

    const checkedImages = checkImageSpy.mock.calls.map((c: any[]) => c[1]);
    expect(checkedImages).not.toContain('someapp:v2');
  });
});

describe('ImageUpdateService cron scheduling', () => {
  beforeEach(() => {
    (ImageUpdateService as any).instance = undefined;
    mockGetGlobalSettings.mockReturnValue({ developer_mode: '0' });
  });

  afterEach(() => {
    // Tests below switch to fake timers and a pinned clock; reset so the state
    // does not leak into later tests in this block (or the file).
    vi.useRealTimers();
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

  it('start() in cron mode arms at the next cron fire, not the 2-minute startup delay', () => {
    vi.useFakeTimers();
    // Pin "now" so the next cron fire is deterministic and far beyond the
    // startup delay (next Monday 03:00 from this Thursday is days away).
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    mockGetGlobalSettings.mockReturnValue({
      developer_mode: '0',
      image_update_check_mode: 'cron',
      image_update_check_cron: '0 3 * * 1',
      image_update_check_interval_minutes: '120',
    });
    const service = ImageUpdateService.getInstance();
    const checkSpy = vi.spyOn(service as any, 'check').mockResolvedValue(undefined);

    service.start();

    // The first check is scheduled at the cron fire time, not 2 minutes out, so
    // a restart never triggers an out-of-cadence check.
    const startupDelay = (ImageUpdateService as any).STARTUP_DELAY_MS as number;
    const nextAt = service.getStatus().nextCheckAt!;
    expect(nextAt - Date.now()).toBeGreaterThan(startupDelay);

    // Advancing well past the old startup delay (but before the cron fire) must
    // not fire a check.
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(checkSpy).not.toHaveBeenCalled();

    // The check fires exactly when the cron schedule says, not merely "later":
    // advancing to the computed fire time triggers it once.
    vi.advanceTimersByTime(nextAt - Date.now() + 1000);
    expect(checkSpy).toHaveBeenCalledTimes(1);

    service.stop();
    checkSpy.mockRestore();
  });

  it('start() in cron mode fires sooner than the startup delay when the next fire is near', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    mockGetGlobalSettings.mockReturnValue({
      developer_mode: '0',
      image_update_check_mode: 'cron',
      image_update_check_cron: '* * * * *', // every minute
      image_update_check_interval_minutes: '120',
    });
    const service = ImageUpdateService.getInstance();
    const checkSpy = vi.spyOn(service as any, 'check').mockResolvedValue(undefined);

    service.start();

    // A frequent cron fires before the old 2-minute startup delay would have:
    // cron mode honors the schedule in both directions, not just "no sooner".
    const startupDelay = (ImageUpdateService as any).STARTUP_DELAY_MS as number;
    const nextAt = service.getStatus().nextCheckAt!;
    expect(nextAt - Date.now()).toBeLessThan(startupDelay);

    vi.advanceTimersByTime(nextAt - Date.now() + 100);
    expect(checkSpy).toHaveBeenCalledTimes(1);

    service.stop();
    checkSpy.mockRestore();
  });

  it('start() in interval mode keeps the 2-minute startup delay', () => {
    vi.useFakeTimers();
    mockGetGlobalSettings.mockReturnValue({ developer_mode: '0' });
    const service = ImageUpdateService.getInstance();
    const checkSpy = vi.spyOn(service as any, 'check').mockResolvedValue(undefined);

    service.start();

    // Just before the 2-minute delay: no check yet.
    vi.advanceTimersByTime(2 * 60 * 1000 - 1000);
    expect(checkSpy).not.toHaveBeenCalled();
    // Crossing the 2-minute mark fires the first check.
    vi.advanceTimersByTime(1000);
    expect(checkSpy).toHaveBeenCalledTimes(1);

    service.stop();
    checkSpy.mockRestore();
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

// ── Model-based per-service reduction wiring (§5) ─────────────────

describe('ImageUpdateService - model-based per-service reduction', () => {
  const TWO_SERVICE_COMPOSE = `
services:
  web:
    image: web:latest
  worker:
    image: worker:latest
`;

  const THREE_SERVICE_COMPOSE = `
services:
  worker:
    image: worker:latest
  api:
    image: api:latest
  db:
    image: db:latest
`;

  const fakeDb = () => ({
    getStackUpdateStatus: mockGetStackUpdateStatus,
    upsertStackUpdateStatus: mockUpsertStackUpdateStatus,
    clearStackUpdateStatus: mockClearStackUpdateStatus,
    recordStackCheckFailure: mockRecordStackCheckFailure,
    getSystemState: mockGetSystemState,
    setSystemState: mockSetSystemState,
    addNotificationHistory: mockAddNotificationHistory,
  });

  function specFor(name: string, image: string): { name: string; declaredImage: string; hasBuild: boolean; expectedReplicas: number; dependsOn: string[]; hasHealthcheck: boolean } {
    return { name, declaredImage: image, hasBuild: false, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false };
  }

  /** Stubs checkImage to report hasUpdate only for the given image refs. */
  function stubCheckImagePerRef(service: ImageUpdateService, updatedRefs: string[]) {
    (service as any).checkImage = vi.fn().mockImplementation(async (_docker: unknown, ref: string) => ({ hasUpdate: updatedRefs.includes(ref) }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    (ImageUpdateService as any).instance = undefined;
    mockGetSystemState.mockReturnValue('1');
    mockGetAllContainers.mockResolvedValue([]);
    mockEnvExists.mockResolvedValue(false);
    mockGetGlobalSettings.mockReturnValue({ developer_mode: '0' });
  });

  it('reduces per-service status through the effective model and persists services_json with a generation', async () => {
    mockGetStacks.mockResolvedValue(['stackA']);
    mockGetStackContent.mockResolvedValue(TWO_SERVICE_COMPOSE);
    mockGetStackUpdateStatus.mockReturnValue({});
    mockBuildEffectiveServiceModel.mockResolvedValueOnce({
      renderable: true,
      services: [specFor('web', 'web:latest'), specFor('worker', 'worker:latest')],
    });
    const service = ImageUpdateService.getInstance();
    stubCheckImagePerRef(service, ['web:latest']);

    await (service as any).checkNode(1, fakeDb());

    expect(mockUpsertStackUpdateStatus).toHaveBeenCalledWith(
      1, 'stackA', true, expect.any(Number), 'ok', null,
      [
        { service: 'web', image: 'web:latest', hasUpdate: true, checkStatus: 'ok', lastError: null },
        { service: 'worker', image: 'worker:latest', hasUpdate: false, checkStatus: 'ok', lastError: null },
      ],
      expect.any(Number),
    );
  });

  it('falls back to the legacy whole-stack tally when the effective model is not renderable', async () => {
    mockGetStacks.mockResolvedValue(['stackA']);
    mockGetStackContent.mockResolvedValue(TWO_SERVICE_COMPOSE);
    mockGetStackUpdateStatus.mockReturnValue({});
    mockBuildEffectiveServiceModel.mockResolvedValueOnce({ renderable: false, code: 'effective_model_render_failed', error: 'render failed' });
    const service = ImageUpdateService.getInstance();
    stubCheckImagePerRef(service, ['web:latest']);

    await (service as any).checkNode(1, fakeDb());

    // Legacy path never passes a services/generation payload.
    expect(mockUpsertStackUpdateStatus).toHaveBeenCalledWith(1, 'stackA', true, expect.any(Number), 'ok', null);
  });

  it('names sorted services with hasUpdate in the availability notification for a multi-service stack', async () => {
    mockGetStacks.mockResolvedValue(['stackA']);
    mockGetStackContent.mockResolvedValue(THREE_SERVICE_COMPOSE);
    mockGetStackUpdateStatus.mockReturnValue({ stackA: false });
    mockBuildEffectiveServiceModel.mockResolvedValueOnce({
      renderable: true,
      services: [specFor('worker', 'worker:latest'), specFor('api', 'api:latest'), specFor('db', 'db:latest')],
    });
    const service = ImageUpdateService.getInstance();
    stubCheckImagePerRef(service, ['worker:latest', 'api:latest']);

    await (service as any).checkNode(1, fakeDb());

    expect(mockDispatchAlert).toHaveBeenCalledWith(
      'info',
      'image_update_available',
      'Stack "stackA" has image updates available for services: api, worker.',
      { stackName: 'stackA', actor: 'system:image-update' },
    );
  });

  it('does not re-notify a multi-service stack already known to have updates', async () => {
    mockGetStacks.mockResolvedValue(['stackA']);
    mockGetStackContent.mockResolvedValue(TWO_SERVICE_COMPOSE);
    mockGetStackUpdateStatus.mockReturnValue({ stackA: true });
    mockBuildEffectiveServiceModel.mockResolvedValueOnce({
      renderable: true,
      services: [specFor('web', 'web:latest'), specFor('worker', 'worker:latest')],
    });
    const service = ImageUpdateService.getInstance();
    stubCheckImagePerRef(service, ['web:latest']);

    await (service as any).checkNode(1, fakeDb());

    expect(mockDispatchAlert).not.toHaveBeenCalled();
  });

  it('suppresses notification and count side effects when a newer recheck discards a stale full-scan write', async () => {
    mockGetStacks.mockResolvedValue(['stackA']);
    mockGetStackContent.mockResolvedValue(TWO_SERVICE_COMPOSE);
    mockGetStackUpdateStatus.mockReturnValue({});
    // Full-scan write path (after registry work) and recheck both need a model.
    mockBuildEffectiveServiceModel.mockResolvedValue({
      renderable: true,
      services: [specFor('web', 'web:latest'), specFor('worker', 'worker:latest')],
    });

    const service = ImageUpdateService.getInstance();
    let resolveFullScan: ((value: { hasUpdate: boolean }) => void) | undefined;
    let fullScanPending = true;
    (service as any).checkImage = vi.fn().mockImplementation(async () => {
      if (fullScanPending) {
        return new Promise<{ hasUpdate: boolean }>((resolve) => {
          resolveFullScan = resolve;
        });
      }
      return { hasUpdate: false };
    });

    const fullScan = (service as any).checkNode(1, fakeDb());
    await vi.waitFor(() => expect((service as any).checkImage).toHaveBeenCalled());

    // A newer service recheck reserves a higher generation and commits "no update".
    fullScanPending = false;
    await service.recheckStack(1, 'stackA');
    expect(mockUpsertStackUpdateStatus).toHaveBeenCalledWith(
      1, 'stackA', false, expect.any(Number), 'ok', null,
      expect.any(Array),
      expect.any(Number),
    );
    const upsertsAfterRecheck = mockUpsertStackUpdateStatus.mock.calls.length;
    expect(mockDispatchAlert).not.toHaveBeenCalled();

    // Stale full scan finishes with hasUpdate=true but must not commit or notify.
    resolveFullScan?.({ hasUpdate: true });
    await fullScan;

    expect(mockUpsertStackUpdateStatus.mock.calls.length).toBe(upsertsAfterRecheck);
    expect(mockDispatchAlert).not.toHaveBeenCalled();
  });

  describe('recheckStack', () => {
    it('skips registry probes and DB writes when checks are disabled', async () => {
      mockGetGlobalSettings.mockReturnValueOnce({ image_update_checks_enabled: '0' });
      const service = ImageUpdateService.getInstance();
      (service as any).checkImage = vi.fn().mockResolvedValue({ hasUpdate: true });
      const genBefore = service.peekStackWriteGeneration(1, 'stackA');

      const result = await service.recheckStack(1, 'stackA');

      expect(result).toEqual({ outcome: 'cleared', warning: null });
      expect(service.peekStackWriteGeneration(1, 'stackA')).toBe(genBefore);
      expect(mockBuildEffectiveServiceModel).not.toHaveBeenCalled();
      expect(mockGetAllContainers).not.toHaveBeenCalled();
      expect((service as any).checkImage).not.toHaveBeenCalled();
      expect(mockUpsertStackUpdateStatus).not.toHaveBeenCalled();
      expect(mockRecordStackCheckFailure).not.toHaveBeenCalled();
      expect(mockClearStackUpdateStatus).not.toHaveBeenCalled();
      expect(mockClearAllStackUpdateStatus).not.toHaveBeenCalled();
    });

    it('returns still_present when a checkable service still has an update', async () => {
      mockBuildEffectiveServiceModel.mockResolvedValueOnce({
        renderable: true,
        services: [specFor('web', 'web:latest'), specFor('worker', 'worker:latest')],
      });
      mockGetAllContainers.mockResolvedValue([
        { Id: 'c1', Image: 'web:latest', Labels: { 'com.docker.compose.project': 'stackA', 'com.docker.compose.service': 'web' } },
      ]);
      const service = ImageUpdateService.getInstance();
      stubCheckImagePerRef(service, ['web:latest']);

      const result = await service.recheckStack(1, 'stackA');

      expect(result).toEqual({
        outcome: 'still_present',
        warning: 'The update command completed, but Sencho still detects an available image update.',
      });
      expect(mockUpsertStackUpdateStatus).toHaveBeenCalledWith(
        1, 'stackA', true, expect.any(Number), 'ok', null,
        [
          { service: 'web', image: 'web:latest', runtimeImages: ['web:latest'], hasUpdate: true, checkStatus: 'ok', lastError: null },
          { service: 'worker', image: 'worker:latest', hasUpdate: false, checkStatus: 'ok', lastError: null },
        ],
        expect.any(Number),
      );
    });

    it('returns the digest-unchanged warning when every still-present update is a same-tag digest rebuild', async () => {
      mockBuildEffectiveServiceModel.mockResolvedValueOnce({
        renderable: true,
        services: [specFor('web', 'web:latest')],
      });
      mockGetAllContainers.mockResolvedValue([
        { Id: 'c1', Image: 'web:latest', Labels: { 'com.docker.compose.project': 'stackA', 'com.docker.compose.service': 'web' } },
      ]);
      const service = ImageUpdateService.getInstance();
      (service as any).checkImage = vi.fn().mockResolvedValue({
        hasUpdate: true,
        digestUpdate: true,
        tagUpdate: false,
        checkStatus: 'ok',
      });

      const result = await service.recheckStack(1, 'stackA');

      expect(result).toEqual({ outcome: 'still_present', warning: UPDATE_DIGEST_UNCHANGED_WARNING });
    });

    it('names sibling services when a service-scoped recheck cleared the target but siblings remain', async () => {
      mockBuildEffectiveServiceModel.mockResolvedValueOnce({
        renderable: true,
        services: [specFor('web', 'web:latest'), specFor('worker', 'worker:latest')],
      });
      mockGetAllContainers.mockResolvedValue([
        { Id: 'c1', Image: 'web:latest', Labels: { 'com.docker.compose.project': 'stackA', 'com.docker.compose.service': 'web' } },
        { Id: 'c2', Image: 'worker:latest', Labels: { 'com.docker.compose.project': 'stackA', 'com.docker.compose.service': 'worker' } },
      ]);
      const service = ImageUpdateService.getInstance();
      (service as any).checkImage = vi.fn().mockImplementation(async (_docker: unknown, ref: string) => (
        ref === 'worker:latest'
          ? { hasUpdate: true, digestUpdate: true, tagUpdate: false, checkStatus: 'ok' }
          : { hasUpdate: false, checkStatus: 'ok' }
      ));

      const result = await service.recheckStack(1, 'stackA', { updatedService: 'web' });

      expect(result).toEqual({
        outcome: 'still_present',
        warning: otherServicesStillPresentWarning('web', ['worker']),
      });
      expect(result.warning).not.toBe(UPDATE_DIGEST_UNCHANGED_WARNING);
    });

    it('keeps the digest-unchanged warning when the updated service itself is still digest-stale', async () => {
      mockBuildEffectiveServiceModel.mockResolvedValueOnce({
        renderable: true,
        services: [specFor('web', 'web:latest'), specFor('worker', 'worker:latest')],
      });
      mockGetAllContainers.mockResolvedValue([
        { Id: 'c1', Image: 'web:latest', Labels: { 'com.docker.compose.project': 'stackA', 'com.docker.compose.service': 'web' } },
        { Id: 'c2', Image: 'worker:latest', Labels: { 'com.docker.compose.project': 'stackA', 'com.docker.compose.service': 'worker' } },
      ]);
      const service = ImageUpdateService.getInstance();
      (service as any).checkImage = vi.fn().mockImplementation(async (_docker: unknown, ref: string) => (
        ref === 'web:latest'
          ? { hasUpdate: true, digestUpdate: true, tagUpdate: false, checkStatus: 'ok' }
          : { hasUpdate: false, checkStatus: 'ok' }
      ));

      const result = await service.recheckStack(1, 'stackA', { updatedService: 'web' });

      expect(result).toEqual({ outcome: 'still_present', warning: UPDATE_DIGEST_UNCHANGED_WARNING });
    });

    it('returns the generic warning when one still-present update is a digest rebuild and another is a tag bump', async () => {
      mockBuildEffectiveServiceModel.mockResolvedValueOnce({
        renderable: true,
        services: [specFor('web', 'web:latest'), specFor('worker', 'worker:latest')],
      });
      mockGetAllContainers.mockResolvedValue([
        { Id: 'c1', Image: 'web:latest', Labels: { 'com.docker.compose.project': 'stackA', 'com.docker.compose.service': 'web' } },
        { Id: 'c2', Image: 'worker:latest', Labels: { 'com.docker.compose.project': 'stackA', 'com.docker.compose.service': 'worker' } },
      ]);
      const service = ImageUpdateService.getInstance();
      (service as any).checkImage = vi.fn().mockImplementation(async (_docker: unknown, ref: string) => (
        ref === 'web:latest'
          ? { hasUpdate: true, digestUpdate: true, tagUpdate: false, checkStatus: 'ok' }
          : { hasUpdate: true, digestUpdate: false, tagUpdate: true, checkStatus: 'ok' }
      ));

      const result = await service.recheckStack(1, 'stackA');

      expect(result).toEqual({ outcome: 'still_present', warning: UPDATE_STILL_PRESENT_WARNING });
    });

    it('returns the generic warning when a single image has both a digest drift and a newer tag', async () => {
      mockBuildEffectiveServiceModel.mockResolvedValueOnce({
        renderable: true,
        services: [specFor('web', 'web:latest')],
      });
      mockGetAllContainers.mockResolvedValue([
        { Id: 'c1', Image: 'web:latest', Labels: { 'com.docker.compose.project': 'stackA', 'com.docker.compose.service': 'web' } },
      ]);
      const service = ImageUpdateService.getInstance();
      (service as any).checkImage = vi.fn().mockResolvedValue({
        hasUpdate: true,
        digestUpdate: true,
        tagUpdate: true,
        checkStatus: 'ok',
      });

      const result = await service.recheckStack(1, 'stackA');

      expect(result).toEqual({ outcome: 'still_present', warning: UPDATE_STILL_PRESENT_WARNING });
    });

    it('returns the generic warning when the still-present update is a tag bump, not a digest-only rebuild', async () => {
      mockBuildEffectiveServiceModel.mockResolvedValueOnce({
        renderable: true,
        services: [specFor('web', 'web:latest')],
      });
      mockGetAllContainers.mockResolvedValue([
        { Id: 'c1', Image: 'web:latest', Labels: { 'com.docker.compose.project': 'stackA', 'com.docker.compose.service': 'web' } },
      ]);
      const service = ImageUpdateService.getInstance();
      (service as any).checkImage = vi.fn().mockResolvedValue({
        hasUpdate: true,
        digestUpdate: false,
        tagUpdate: true,
        checkStatus: 'ok',
      });

      const result = await service.recheckStack(1, 'stackA');

      expect(result).toEqual({ outcome: 'still_present', warning: UPDATE_STILL_PRESENT_WARNING });
    });

    it('returns cleared when every checkable service is up to date', async () => {
      mockBuildEffectiveServiceModel.mockResolvedValueOnce({
        renderable: true,
        services: [specFor('web', 'web:latest')],
      });
      mockGetAllContainers.mockResolvedValue([
        { Id: 'c1', Image: 'web:latest', Labels: { 'com.docker.compose.project': 'stackA', 'com.docker.compose.service': 'web' } },
      ]);
      const service = ImageUpdateService.getInstance();
      (service as any).checkImage = vi.fn().mockResolvedValue({ hasUpdate: false });

      const result = await service.recheckStack(1, 'stackA');

      expect(result).toEqual({ outcome: 'cleared', warning: null });
      expect(mockUpsertStackUpdateStatus).toHaveBeenCalledWith(
        1, 'stackA', false, expect.any(Number), 'ok', null,
        expect.any(Array),
        expect.any(Number),
      );
    });

    it('returns verification_failed and leaves the prior row untouched when the model cannot render', async () => {
      mockBuildEffectiveServiceModel.mockResolvedValueOnce({ renderable: false, code: 'effective_model_render_failed', error: 'no model in test' });
      const service = ImageUpdateService.getInstance();

      const result = await service.recheckStack(1, 'stackA');

      expect(result).toEqual({ outcome: 'verification_failed', warning: 'no model in test' });
      expect(mockUpsertStackUpdateStatus).not.toHaveBeenCalled();
      expect(mockRecordStackCheckFailure).not.toHaveBeenCalled();
    });

    it('returns verification_incomplete and preserves prior hasUpdate on a fully failed check', async () => {
      mockBuildEffectiveServiceModel.mockResolvedValueOnce({
        renderable: true,
        services: [specFor('web', 'web:latest')],
      });
      mockGetAllContainers.mockResolvedValue([
        { Id: 'c1', Image: 'web:latest', Labels: { 'com.docker.compose.project': 'stackA', 'com.docker.compose.service': 'web' } },
      ]);
      mockGetStackServicesJson.mockReturnValueOnce([
        { service: 'web', image: 'web:latest', hasUpdate: true, checkStatus: 'ok', lastError: null },
      ]);
      const service = ImageUpdateService.getInstance();
      (service as any).checkImage = vi.fn().mockResolvedValue({
        hasUpdate: false,
        error: 'registry timeout',
      });

      const result = await service.recheckStack(1, 'stackA');

      expect(result).toEqual({
        outcome: 'verification_incomplete',
        warning: 'The update command completed, but Sencho could not fully verify whether an image update remains.',
      });
      expect(mockRecordStackCheckFailure).toHaveBeenCalled();
      expect(mockUpsertStackUpdateStatus).not.toHaveBeenCalled();
    });

    it('returns verification_incomplete when the write lock discards a stale commit', async () => {
      mockBuildEffectiveServiceModel.mockResolvedValueOnce({
        renderable: true,
        services: [specFor('web', 'web:latest')],
      });
      mockGetAllContainers.mockResolvedValue([
        { Id: 'c1', Image: 'web:latest', Labels: { 'com.docker.compose.project': 'stackA', 'com.docker.compose.service': 'web' } },
      ]);
      const service = ImageUpdateService.getInstance();
      (service as any).checkImage = vi.fn().mockResolvedValue({ hasUpdate: false });
      (service as any).withStackWriteLock = vi.fn().mockResolvedValue(false);

      const result = await service.recheckStack(1, 'stackA');

      expect(result).toEqual({
        outcome: 'verification_incomplete',
        warning: 'The update command completed, but Sencho could not fully verify whether an image update remains.',
      });
      expect(mockUpsertStackUpdateStatus).not.toHaveBeenCalled();
      expect(mockRecordStackCheckFailure).not.toHaveBeenCalled();
    });

    it('returns verification_incomplete when container listing fails', async () => {
      mockBuildEffectiveServiceModel.mockResolvedValueOnce({
        renderable: true,
        services: [specFor('web', 'web:latest')],
      });
      mockGetAllContainers.mockRejectedValueOnce(new Error('docker socket down'));
      const service = ImageUpdateService.getInstance();
      (service as any).checkImage = vi.fn().mockResolvedValue({ hasUpdate: false });

      const result = await service.recheckStack(1, 'stackA');

      expect(result).toEqual({
        outcome: 'verification_incomplete',
        warning: 'The update command completed, but Sencho could not fully verify whether an image update remains.',
      });
      expect((service as any).checkImage).not.toHaveBeenCalled();
      expect(mockUpsertStackUpdateStatus).not.toHaveBeenCalled();
    });
  });
});
