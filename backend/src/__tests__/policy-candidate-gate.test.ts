/**
 * The deploy gate on the image an operation will run, not the one already on the
 * node.
 *
 * The defect these cover: every pulling path claimed a policy check but scanned
 * the installed image, so a floating tag was proven safe and then replaced by
 * whatever the pull found. Each test drives the real evaluator with a stubbed
 * scanner, registry resolver and effective model, and asserts what was evaluated,
 * what was recorded, and what was refused.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ScanPolicy, VulnerabilityScan } from '../services/DatabaseService';

const INDEX = `sha256:${'1'.repeat(64)}`;
const PLATFORM_DIGEST = `sha256:${'2'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'3'.repeat(64)}`;

interface TrivyStub {
  isTrivyAvailable: ReturnType<typeof vi.fn>;
  scanImagePreflight: ReturnType<typeof vi.fn>;
}
interface DbStub {
  getMatchingPolicy: ReturnType<typeof vi.fn>;
  insertAuditLog: ReturnType<typeof vi.fn>;
  getGlobalSettings: ReturnType<typeof vi.fn>;
  getAllVulnerabilityDetails: ReturnType<typeof vi.fn>;
  getCveSuppressions: ReturnType<typeof vi.fn>;
  getCveIntel: ReturnType<typeof vi.fn>;
}

const trivyStub: TrivyStub = { isTrivyAvailable: vi.fn(), scanImagePreflight: vi.fn() };
const composeStub = { listStackImages: vi.fn() };
const dbStub: DbStub = {
  getMatchingPolicy: vi.fn(),
  insertAuditLog: vi.fn(),
  getGlobalSettings: vi.fn(),
  getAllVulnerabilityDetails: vi.fn(),
  getCveSuppressions: vi.fn(),
  getCveIntel: vi.fn(),
};
const notificationStub = { dispatchAlert: vi.fn() };

/** Injected resolver behaviour, changed per test. */
const candidates = vi.hoisted(() => ({
  resolve: vi.fn(),
  localImageExists: vi.fn(),
  lastTagTime: vi.fn(),
  platform: { os: 'linux', architecture: 'amd64' } as { os: string; architecture: string } | null,
}));
/** Injected effective model, changed per test. */
const models = vi.hoisted(() => ({
  build: vi.fn(),
}));
const dockerStub = vi.hoisted(() => ({ getDocker: vi.fn(), getImage: vi.fn(), inspect: vi.fn() }));

vi.mock('../services/TrivyService', () => ({ default: { getInstance: () => trivyStub } }));
vi.mock('../services/ComposeService', () => ({ ComposeService: { getInstance: () => composeStub } }));
vi.mock('../services/DatabaseService', () => ({ DatabaseService: { getInstance: () => dbStub } }));
vi.mock('../services/NotificationService', () => ({ NotificationService: { getInstance: () => notificationStub } }));
vi.mock('../services/FleetSyncService', () => ({ FleetSyncService: { getSelfIdentity: () => 'self-node' } }));
vi.mock('../services/effectiveServiceModel', () => ({ buildEffectiveServiceModel: models.build }));
vi.mock('../services/DockerController', () => ({
  default: {
    getInstance: () => ({
      getDocker: () => {
        dockerStub.getDocker();
        return { getImage: (ref: string) => { dockerStub.getImage(ref); return { inspect: dockerStub.inspect }; } };
      },
    }),
  },
}));
vi.mock('../services/candidateImage', async () => {
  const actual = await vi.importActual<typeof import('../services/candidateImage')>('../services/candidateImage');
  return {
    ...actual,
    nodePlatformFor: async () => candidates.platform,
    localImageExists: (nodeId: number, ref: string, platform?: { os: string; architecture: string } | null) =>
      candidates.localImageExists(nodeId, ref, platform),
    localImageLastTagTime: (nodeId: number, ref: string) => candidates.lastTagTime(nodeId, ref),
    resolveCandidateImage: (nodeId: number, ref: string, platform: unknown) =>
      candidates.resolve(nodeId, ref, platform),
  };
});

import { enforcePolicyForImageRefs, enforcePolicyPreDeploy } from '../services/PolicyEnforcement';

function mkPolicy(overrides: Partial<ScanPolicy> = {}): ScanPolicy {
  return {
    id: 1,
    name: 'prod-gate',
    node_id: 1,
    stack_pattern: null,
    max_severity: 'HIGH',
    block_on_severity: 1,
    block_on_kev: 0,
    block_on_fixable: 0,
    block_on_deploy: 1,
    enabled: 1,
    created_at: Date.now(),
    fleet_node_id: null,
    ...overrides,
  } as ScanPolicy;
}

function mkScan(overrides: Partial<VulnerabilityScan> = {}): VulnerabilityScan {
  return {
    id: 42,
    node_id: 1,
    image_ref: 'web:latest',
    image_digest: INDEX,
    scanned_at: Date.now(),
    total_vulnerabilities: 0,
    critical_count: 0,
    high_count: 0,
    medium_count: 0,
    low_count: 0,
    unknown_count: 0,
    fixable_count: 0,
    secret_count: 0,
    misconfig_count: 0,
    scanners_used: 'vuln',
    highest_severity: 'LOW',
    os_info: null,
    trivy_version: '0.50.0',
    scan_duration_ms: 12,
    triggered_by: 'deploy-preflight',
    status: 'completed',
    error: null,
    stack_context: 'web',
    policy_evaluation: null,
    vuln_db_updated_at: Date.UTC(2026, 0, 2),
    ...overrides,
  };
}

const CANDIDATE_RESOLUTION = {
  kind: 'candidate' as const,
  ref: 'registry.example.com/web:latest',
  scanRef: `registry.example.com/web@${PLATFORM_DIGEST}`,
  indexDigest: INDEX,
  platformDigest: PLATFORM_DIGEST,
  platform: 'linux/amd64',
  qualification: 'qualified' as const,
};

function modelWith(services: Array<Record<string, unknown>>) {
  models.build.mockResolvedValue({ renderable: true, services, projectName: 'my-stack' });
}

beforeEach(() => {
  vi.clearAllMocks();
  dbStub.getMatchingPolicy.mockReturnValue(mkPolicy());
  dbStub.getGlobalSettings.mockReturnValue({});
  dbStub.getCveIntel.mockReturnValue(new Map());
  dbStub.getCveSuppressions.mockReturnValue([]);
  dbStub.getAllVulnerabilityDetails.mockReturnValue([]);
  trivyStub.isTrivyAvailable.mockReturnValue(true);
  trivyStub.scanImagePreflight.mockResolvedValue(mkScan());
  composeStub.listStackImages.mockResolvedValue(['registry.example.com/web:latest']);
  candidates.platform = { os: 'linux', architecture: 'amd64' };
  candidates.localImageExists.mockResolvedValue(true);
  candidates.lastTagTime.mockResolvedValue(Date.now());
  candidates.resolve.mockResolvedValue(CANDIDATE_RESOLUTION);
  models.build.mockResolvedValue({
    renderable: true,
    services: [
      { name: 'web', declaredImage: 'registry.example.com/web:latest', hasBuild: false, pullPolicy: null, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false },
    ],
  });
  dockerStub.inspect.mockResolvedValue({ RepoDigests: [`registry.example.com/web@${INDEX}`] });
});

describe('registry mode (an update that pulls)', () => {
  it('scans the registry image by platform digest and keeps the authored tag on the row', async () => {
    const result = await enforcePolicyPreDeploy('web', 1, {
      bypass: false, actor: 'u', imageSource: 'registry',
    });

    expect(result.ok).toBe(true);
    // The exact manifest, not the tag: a tag would resolve to the index or to the
    // local image, and neither is what this node will run.
    expect(trivyStub.scanImagePreflight).toHaveBeenCalledWith(
      'registry.example.com/web:latest', 1, 'web',
      { scanRef: `registry.example.com/web@${PLATFORM_DIGEST}`, digest: INDEX },
    );
    // The installed image is not scanned in addition: it is not what will run.
    expect(trivyStub.scanImagePreflight).toHaveBeenCalledTimes(1);

    const record = result.evidence?.records.find((r) => r.source === 'vulnerability_scan');
    expect(record).toMatchObject({
      subject: 'candidate',
      target: 'registry.example.com/web:latest',
      digest: INDEX,
      platformDigest: PLATFORM_DIGEST,
      platform: 'linux/amd64',
      databaseUpdatedAt: Date.UTC(2026, 0, 2),
    });
    expect(result.evaluatedCandidates).toEqual([
      {
        ref: 'registry.example.com/web:latest',
        indexDigest: INDEX,
        platformDigest: PLATFORM_DIGEST,
        // The deploy boundary pulls exactly this service before `up`.
        services: ['web'],
      },
    ]);
  });

  it('refuses a vulnerable candidate even though the installed image is clean', async () => {
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan({
      highest_severity: 'CRITICAL',
      critical_count: 1,
      total_vulnerabilities: 1,
    }));

    const result = await enforcePolicyPreDeploy('web', 1, {
      bypass: false, actor: 'u', imageSource: 'registry',
    });

    expect(result.ok).toBe(false);
    expect(result.violations[0]).toMatchObject({ imageRef: 'registry.example.com/web:latest', severity: 'CRITICAL' });
    // The clean installed image was never consulted, which is the whole point.
    expect(trivyStub.scanImagePreflight).toHaveBeenCalledTimes(1);
  });

  it('allows a clean candidate even when the installed image would have been vulnerable', async () => {
    // The scanner only ever sees the candidate, so a clean answer is a clean
    // candidate; there is no installed scan to disagree with.
    const result = await enforcePolicyPreDeploy('web', 1, {
      bypass: false, actor: 'u', imageSource: 'registry',
    });
    expect(result.ok).toBe(true);
    expect(trivyStub.scanImagePreflight.mock.calls[0][3]).toMatchObject({ digest: INDEX });
  });

  it('does not pull, tag or inspect any image to evaluate the candidate', async () => {
    await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'registry' });
    expect(dockerStub.getDocker).not.toHaveBeenCalled();
    expect(dockerStub.getImage).not.toHaveBeenCalled();
  });

  it('keeps a digest-pinned reference on the installed image, with no registry call', async () => {
    composeStub.listStackImages.mockResolvedValue([`registry.example.com/web@${PLATFORM_DIGEST}`]);
    modelWith([{ name: 'web', declaredImage: `registry.example.com/web@${PLATFORM_DIGEST}`, hasBuild: false, pullPolicy: null, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false }]);
    candidates.resolve.mockResolvedValue({
      kind: 'installed',
      ref: `registry.example.com/web@${PLATFORM_DIGEST}`,
      why: 'digest_pinned',
    });

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'registry' });

    expect(result.ok).toBe(true);
    expect(trivyStub.scanImagePreflight).toHaveBeenCalledWith(
      `registry.example.com/web@${PLATFORM_DIGEST}`, 1, 'web', undefined,
    );
    expect(result.evaluatedCandidates).toBeUndefined();
  });

  it('keeps a build-backed service on the installed image, because a registry update builds it first', async () => {
    composeStub.listStackImages.mockResolvedValue(['web:latest']);
    modelWith([{ name: 'web', declaredImage: 'web:latest', hasBuild: true, pullPolicy: 'always', expectedReplicas: 1, dependsOn: [], hasHealthcheck: false }]);

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'registry' });

    expect(result.ok).toBe(true);
    expect(candidates.resolve).not.toHaveBeenCalled();
    expect(trivyStub.scanImagePreflight).toHaveBeenCalledWith('web:latest', 1, 'web', undefined);
    expect(result.evidence?.records[0]).toMatchObject({ subject: 'installed' });
  });

  it('keeps a pull_policy: never service on the installed image, which its pull never replaces', async () => {
    modelWith([{ name: 'web', declaredImage: 'registry.example.com/web:latest', hasBuild: false, pullPolicy: 'never', expectedReplicas: 1, dependsOn: [], hasHealthcheck: false }]);

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'registry' });

    expect(result.ok).toBe(true);
    expect(candidates.resolve).not.toHaveBeenCalled();
    expect(trivyStub.scanImagePreflight).toHaveBeenCalledWith(
      'registry.example.com/web:latest', 1, 'web', undefined,
    );
    expect(result.evaluatedCandidates).toBeUndefined();
    expect(result.evidence?.records[0]).toMatchObject({ subject: 'installed' });
  });

  it('keeps a missing pull_policy on the installed image when Compose skips the present non-latest image', async () => {
    modelWith([{ name: 'web', declaredImage: 'registry.example.com/web:1.2', hasBuild: false, pullPolicy: 'missing', expectedReplicas: 1, dependsOn: [], hasHealthcheck: false }]);
    composeStub.listStackImages.mockResolvedValue(['registry.example.com/web:1.2']);
    candidates.localImageExists.mockResolvedValue(true);

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'registry' });

    expect(result.ok).toBe(true);
    expect(candidates.resolve).not.toHaveBeenCalled();
    expect(result.evaluatedCandidates).toBeUndefined();
  });

  it('treats a present latest tag under missing as a candidate, because an explicit pull refreshes it', async () => {
    modelWith([{ name: 'web', declaredImage: 'registry.example.com/web:latest', hasBuild: false, pullPolicy: 'missing', expectedReplicas: 1, dependsOn: [], hasHealthcheck: false }]);
    candidates.localImageExists.mockResolvedValue(true);

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'registry' });

    expect(candidates.resolve).toHaveBeenCalledTimes(1);
    expect(result.evaluatedCandidates).toHaveLength(1);
  });

  it('evaluates a missing pull_policy when the image is absent, because the pull fetches it', async () => {
    modelWith([{ name: 'web', declaredImage: 'registry.example.com/web:latest', hasBuild: false, pullPolicy: 'missing', expectedReplicas: 1, dependsOn: [], hasHealthcheck: false }]);
    candidates.localImageExists.mockResolvedValue(false);

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'registry' });

    expect(candidates.resolve).toHaveBeenCalledTimes(1);
    expect(result.evaluatedCandidates).toHaveLength(1);
  });

  it('applies the same pull-policy decision on the service-scoped path with its rendered model', async () => {
    // A single-service update supplies one ref and the service's own model; it
    // must not treat a pull_policy: never service as a registry candidate.
    const result = await enforcePolicyForImageRefs(
      'web',
      1,
      ['registry.example.com/web:latest'],
      { bypass: false, actor: 'u', imageSource: 'registry' },
      undefined,
      false,
      {
        renderable: true,
        services: [
          { name: 'web', declaredImage: 'registry.example.com/web:latest', hasBuild: false, pullPolicy: 'never', expectedReplicas: 1, dependsOn: [], hasHealthcheck: false },
        ],
      },
    );

    expect(result.ok).toBe(true);
    expect(candidates.resolve).not.toHaveBeenCalled();
    expect(result.evaluatedCandidates).toBeUndefined();
  });

  it('resolves the service platform override for an update that pulls', async () => {
    candidates.platform = { os: 'linux', architecture: 'arm64' };
    candidates.resolve.mockImplementation(async (_nodeId: number, _ref: string, platform: { architecture: string }) => (
      platform.architecture === 'amd64'
        ? { ...CANDIDATE_RESOLUTION, platform: 'linux/amd64', platformDigest: OTHER_DIGEST }
        : CANDIDATE_RESOLUTION
    ));
    modelWith([{ name: 'web', declaredImage: 'registry.example.com/web:latest', hasBuild: false, pullPolicy: null, platform: 'linux/amd64', expectedReplicas: 1, dependsOn: [], hasHealthcheck: false }]);

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'registry' });

    expect(result.ok).toBe(true);
    expect(candidates.resolve).toHaveBeenCalledWith(
      1, 'registry.example.com/web:latest', { os: 'linux', architecture: 'amd64' },
    );
    expect(result.evaluatedCandidates?.[0]).toMatchObject({
      ref: 'registry.example.com/web:latest',
      platformDigest: OTHER_DIGEST,
    });
  });

  it('keeps resolving references when the model will not render in registry mode', async () => {
    // A registry update's own `compose pull` is what fetches, and an
    // unrenderable model cannot say which reference it skips, so nothing it
    // fetches may run unevaluated.
    models.build.mockResolvedValue({
      renderable: false,
      code: 'effective_model_render_failed',
      error: 'Sencho could not render the effective Compose model.',
    });

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'registry' });

    expect(result.ok).toBe(true);
    expect(candidates.resolve).toHaveBeenCalledTimes(1);
    expect(result.evaluatedCandidates).toHaveLength(1);
  });
});

describe('compose mode (a plain up)', () => {
  it('evaluates the registry image for a service whose pull policy pulls on up', async () => {
    modelWith([{ name: 'web', declaredImage: 'registry.example.com/web:latest', hasBuild: false, pullPolicy: 'always', expectedReplicas: 1, dependsOn: [], hasHealthcheck: false }]);

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'compose' });

    expect(result.ok).toBe(true);
    expect(candidates.resolve).toHaveBeenCalledTimes(1);
    expect(trivyStub.scanImagePreflight.mock.calls[0][3]).toMatchObject({ digest: INDEX });
  });

  it('keeps the installed image when the policy is the default and the image is present', async () => {
    modelWith([{ name: 'web', declaredImage: 'registry.example.com/web:latest', hasBuild: false, pullPolicy: null, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false }]);
    candidates.localImageExists.mockResolvedValue(true);

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'compose' });

    expect(result.ok).toBe(true);
    expect(candidates.resolve).not.toHaveBeenCalled();
    expect(trivyStub.scanImagePreflight).toHaveBeenCalledWith('registry.example.com/web:latest', 1, 'web', undefined);
  });

  it('evaluates the registry image when Compose would pull because the image is missing', async () => {
    modelWith([{ name: 'web', declaredImage: 'registry.example.com/web:latest', hasBuild: false, pullPolicy: 'missing', expectedReplicas: 1, dependsOn: [], hasHealthcheck: false }]);
    candidates.localImageExists.mockResolvedValue(false);

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'compose' });

    expect(candidates.resolve).toHaveBeenCalledTimes(1);
    expect(result.pullServices).toEqual(['web']);
  });

  it('evaluates the registry image for a build-backed service whose pull policy pulls on up', async () => {
    // `image` + `build` is not build-only: Compose tries the registry image
    // under `always` (or a due interval), and a successful pull runs it instead
    // of building. Skipping it let a blocked registry image deploy.
    modelWith([{ name: 'web', declaredImage: 'registry.example.com/web:latest', hasBuild: true, pullPolicy: 'always', expectedReplicas: 1, dependsOn: [], hasHealthcheck: false }]);

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'compose' });

    expect(result.ok).toBe(true);
    expect(candidates.resolve).toHaveBeenCalledTimes(1);
    expect(result.evaluatedCandidates?.[0]).toMatchObject({
      ref: 'registry.example.com/web:latest',
      platformDigest: PLATFORM_DIGEST,
      services: ['web'],
    });
    expect(result.pullServices).toEqual(['web']);
  });

  it('refuses a blocked registry image for a build-backed service with pull_policy always', async () => {
    modelWith([{ name: 'web', declaredImage: 'registry.example.com/web:latest', hasBuild: true, pullPolicy: 'always', expectedReplicas: 1, dependsOn: [], hasHealthcheck: false }]);
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan({
      highest_severity: 'CRITICAL',
      critical_count: 1,
      total_vulnerabilities: 1,
    }));

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'compose' });

    expect(result.ok).toBe(false);
    expect(result.violations[0]).toMatchObject({ imageRef: 'registry.example.com/web:latest', severity: 'CRITICAL' });
    expect(trivyStub.scanImagePreflight).toHaveBeenCalledTimes(1);
  });

  it('evaluates a build-backed default policy only when the image is missing', async () => {
    modelWith([{ name: 'web', declaredImage: 'registry.example.com/web:latest', hasBuild: true, pullPolicy: null, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false }]);

    candidates.localImageExists.mockResolvedValue(true);
    const present = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'compose' });
    expect(present.ok).toBe(true);
    expect(candidates.resolve).not.toHaveBeenCalled();
    expect(present.evidence?.records[0]).toMatchObject({ subject: 'installed' });

    candidates.localImageExists.mockResolvedValue(false);
    const absent = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'compose' });
    expect(absent.ok).toBe(true);
    expect(candidates.resolve).toHaveBeenCalledTimes(1);
    expect(absent.pullServices).toEqual(['web']);
  });

  it('applies interval timing to a build-backed service', async () => {
    modelWith([{ name: 'web', declaredImage: 'registry.example.com/web:latest', hasBuild: true, pullPolicy: 'daily', expectedReplicas: 1, dependsOn: [], hasHealthcheck: false }]);
    candidates.localImageExists.mockResolvedValue(true);

    candidates.lastTagTime.mockResolvedValue(Date.now() - 25 * 60 * 60 * 1000);
    const due = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'compose' });
    expect(due.ok).toBe(true);
    expect(candidates.resolve).toHaveBeenCalledTimes(1);
    expect(due.pullServices).toEqual(['web']);

    candidates.lastTagTime.mockResolvedValue(Date.now());
    const notDue = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'compose' });
    expect(notDue.ok).toBe(true);
    expect(candidates.resolve).toHaveBeenCalledTimes(1);
    expect(notDue.pullServices).toBeUndefined();
    // `up` must not start the refresh if the window elapses before it runs.
    expect(notDue.noPullOnUp).toBe(true);
  });

  it('keeps a build-backed service on its build for pull_policy build and never', async () => {
    for (const pullPolicy of ['build', 'never']) {
      vi.clearAllMocks();
      dbStub.getMatchingPolicy.mockReturnValue(mkPolicy());
      dbStub.getGlobalSettings.mockReturnValue({});
      dbStub.getCveIntel.mockReturnValue(new Map());
      dbStub.getCveSuppressions.mockReturnValue([]);
      dbStub.getAllVulnerabilityDetails.mockReturnValue([]);
      trivyStub.isTrivyAvailable.mockReturnValue(true);
      trivyStub.scanImagePreflight.mockResolvedValue(mkScan());
      composeStub.listStackImages.mockResolvedValue(['registry.example.com/web:latest']);
      candidates.localImageExists.mockResolvedValue(false);
      candidates.resolve.mockResolvedValue(CANDIDATE_RESOLUTION);
      modelWith([{ name: 'web', declaredImage: 'registry.example.com/web:latest', hasBuild: true, pullPolicy, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false }]);

      const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'compose' });

      expect(result.ok).toBe(true);
      expect(candidates.resolve).not.toHaveBeenCalled();
      expect(result.evidence?.records[0]).toMatchObject({ subject: 'installed' });
    }
  });

  it('resolves the service platform override, not the node platform, for a plain up', async () => {
    // The node is arm64 and its arm64 child is clean, but the service asks for
    // the amd64 child, which is the image Compose pulls and runs. Evaluating the
    // node's child proved the wrong image.
    candidates.platform = { os: 'linux', architecture: 'arm64' };
    candidates.resolve.mockImplementation(async (_nodeId: number, _ref: string, platform: { architecture: string }) => (
      platform.architecture === 'amd64'
        ? {
            ...CANDIDATE_RESOLUTION,
            scanRef: `registry.example.com/web@${OTHER_DIGEST}`,
            platform: 'linux/amd64',
            platformDigest: OTHER_DIGEST,
          }
        : CANDIDATE_RESOLUTION
    ));
    trivyStub.scanImagePreflight.mockImplementation(async (
      _ref: string,
      _nodeId: number,
      _stack: string,
      opts?: { scanRef?: string },
    ) => (opts?.scanRef?.includes(OTHER_DIGEST)
      ? mkScan({ highest_severity: 'CRITICAL', critical_count: 1, total_vulnerabilities: 1 })
      : mkScan()));
    modelWith([{ name: 'web', declaredImage: 'registry.example.com/web:latest', hasBuild: false, pullPolicy: 'always', platform: 'linux/amd64', expectedReplicas: 1, dependsOn: [], hasHealthcheck: false }]);

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'compose' });

    expect(candidates.resolve).toHaveBeenCalledWith(
      1, 'registry.example.com/web:latest', { os: 'linux', architecture: 'amd64' },
    );
    expect(trivyStub.scanImagePreflight).toHaveBeenCalledTimes(1);
    expect(trivyStub.scanImagePreflight.mock.calls[0][3]).toMatchObject({
      scanRef: `registry.example.com/web@${OTHER_DIGEST}`,
    });
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toMatchObject({ imageRef: 'registry.example.com/web:latest', severity: 'CRITICAL' });
  });

  it('resolves every platform a shared reference is used at', async () => {
    candidates.platform = { os: 'linux', architecture: 'arm64' };
    candidates.resolve.mockImplementation(async (_nodeId: number, _ref: string, platform: { architecture: string }) => (
      platform.architecture === 'amd64'
        ? {
            ...CANDIDATE_RESOLUTION,
            scanRef: `registry.example.com/web@${OTHER_DIGEST}`,
            platform: 'linux/amd64',
            platformDigest: OTHER_DIGEST,
          }
        : {
            ...CANDIDATE_RESOLUTION,
            scanRef: `registry.example.com/web@${PLATFORM_DIGEST}`,
            platform: 'linux/arm64',
            platformDigest: PLATFORM_DIGEST,
          }
    ));
    modelWith([
      { name: 'web', declaredImage: 'registry.example.com/web:latest', hasBuild: false, pullPolicy: 'always', platform: 'linux/amd64', expectedReplicas: 1, dependsOn: [], hasHealthcheck: false },
      { name: 'tools', declaredImage: 'registry.example.com/web:latest', hasBuild: false, pullPolicy: 'always', platform: 'linux/arm64', expectedReplicas: 1, dependsOn: [], hasHealthcheck: false },
    ]);

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'compose' });

    expect(result.ok).toBe(true);
    expect(candidates.resolve.mock.calls.map((call) => call[2])).toEqual([
      { os: 'linux', architecture: 'amd64' },
      { os: 'linux', architecture: 'arm64' },
    ]);
    expect(result.evaluatedCandidates?.map((candidate) => candidate.platformDigest).sort()).toEqual([
      OTHER_DIGEST,
      PLATFORM_DIGEST,
    ].sort());
    expect(result.pullServices).toEqual(['web', 'tools']);
  });

  it('evaluates the platform child Compose would fetch when the local copy is another platform', async () => {
    // F5: the ref is on the node as the arm64 child only, and the service asks
    // for amd64. Compose fetches the amd64 child at `up`, so the gate must
    // evaluate that child instead of treating the present arm64 copy as
    // installed and letting the fetch happen behind the gate.
    candidates.platform = { os: 'linux', architecture: 'arm64' };
    candidates.localImageExists.mockImplementation(async (
      _nodeId: number,
      _ref: string,
      platform?: { os: string; architecture: string } | null,
    ) => platform === undefined || platform?.architecture === 'arm64');
    candidates.resolve.mockImplementation(async (_nodeId: number, _ref: string, platform: { architecture: string }) => (
      platform.architecture === 'amd64'
        ? {
            ...CANDIDATE_RESOLUTION,
            scanRef: `registry.example.com/web@${OTHER_DIGEST}`,
            platform: 'linux/amd64',
            platformDigest: OTHER_DIGEST,
          }
        : {
            ...CANDIDATE_RESOLUTION,
            scanRef: `registry.example.com/web@${PLATFORM_DIGEST}`,
            platform: 'linux/arm64',
            platformDigest: PLATFORM_DIGEST,
          }
    ));
    modelWith([{ name: 'web', declaredImage: 'registry.example.com/web:latest', hasBuild: false, pullPolicy: null, platform: 'linux/amd64', expectedReplicas: 1, dependsOn: [], hasHealthcheck: false }]);

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'compose' });

    expect(result.ok).toBe(true);
    expect(candidates.resolve).toHaveBeenCalledWith(
      1, 'registry.example.com/web:latest', { os: 'linux', architecture: 'amd64' },
    );
    expect(result.evaluatedCandidates).toEqual([{
      ref: 'registry.example.com/web:latest',
      indexDigest: INDEX,
      platformDigest: OTHER_DIGEST,
      services: ['web'],
    }]);
    // The boundary pulls this service before `up --pull never`, so the child
    // the gate scanned is the one that lands.
    expect(result.pullServices).toEqual(['web']);
    expect(trivyStub.scanImagePreflight.mock.calls[0][3]).toMatchObject({
      scanRef: `registry.example.com/web@${OTHER_DIGEST}`,
    });
  });

  it.each([
    ['the default', null],
    ['missing', 'missing'],
    ['a daily interval', 'daily'],
  ] as const)('applies the per-platform presence check to %s pull policy', async (_label, pullPolicy) => {
    candidates.platform = { os: 'linux', architecture: 'arm64' };
    candidates.localImageExists.mockImplementation(async (
      _nodeId: number,
      _ref: string,
      platform?: { os: string; architecture: string } | null,
    ) => platform === undefined || platform?.architecture === 'arm64');
    candidates.resolve.mockResolvedValue({
      ...CANDIDATE_RESOLUTION,
      scanRef: `registry.example.com/web@${OTHER_DIGEST}`,
      platform: 'linux/amd64',
      platformDigest: OTHER_DIGEST,
    });
    candidates.lastTagTime.mockResolvedValue(Date.now());
    modelWith([{ name: 'web', declaredImage: 'registry.example.com/web:latest', hasBuild: false, pullPolicy, platform: 'linux/amd64', expectedReplicas: 1, dependsOn: [], hasHealthcheck: false }]);

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'compose' });

    expect(result.evaluatedCandidates).toHaveLength(1);
    expect(result.pullServices).toEqual(['web']);
  });

  it('checks presence per platform when services share a reference', async () => {
    // The local arm64 child satisfies the arm64 service, but not the amd64 one,
    // so only the amd64 service is a candidate and only it is pulled.
    candidates.platform = { os: 'linux', architecture: 'arm64' };
    candidates.localImageExists.mockImplementation(async (
      _nodeId: number,
      _ref: string,
      platform?: { os: string; architecture: string } | null,
    ) => platform === undefined || platform?.architecture === 'arm64');
    candidates.resolve.mockImplementation(async (_nodeId: number, _ref: string, platform: { architecture: string }) => ({
      ...CANDIDATE_RESOLUTION,
      scanRef: `registry.example.com/web@${OTHER_DIGEST}`,
      platform: `linux/${platform.architecture}`,
      platformDigest: OTHER_DIGEST,
    }));
    modelWith([
      { name: 'web', declaredImage: 'registry.example.com/web:latest', hasBuild: false, pullPolicy: null, platform: 'linux/amd64', expectedReplicas: 1, dependsOn: [], hasHealthcheck: false },
      { name: 'tools', declaredImage: 'registry.example.com/web:latest', hasBuild: false, pullPolicy: null, platform: 'linux/arm64', expectedReplicas: 1, dependsOn: [], hasHealthcheck: false },
    ]);

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'compose' });

    expect(candidates.resolve).toHaveBeenCalledTimes(1);
    expect(candidates.resolve).toHaveBeenCalledWith(
      1, 'registry.example.com/web:latest', { os: 'linux', architecture: 'amd64' },
    );
    expect(result.evaluatedCandidates).toEqual([{
      ref: 'registry.example.com/web:latest',
      indexDigest: INDEX,
      platformDigest: OTHER_DIGEST,
      services: ['web'],
    }]);
    expect(result.pullServices).toEqual(['web']);
  });

  it('keeps one violation and one evidence record per platform variant', async () => {
    // F6's backend half: the dialog can only label each row with its own
    // platform when the row and the record carry it.
    candidates.platform = { os: 'linux', architecture: 'arm64' };
    candidates.resolve.mockImplementation(async (_nodeId: number, _ref: string, platform: { architecture: string }) => ({
      ...CANDIDATE_RESOLUTION,
      scanRef: `registry.example.com/web@${platform.architecture === 'amd64' ? OTHER_DIGEST : PLATFORM_DIGEST}`,
      platform: `linux/${platform.architecture}`,
      platformDigest: platform.architecture === 'amd64' ? OTHER_DIGEST : PLATFORM_DIGEST,
    }));
    trivyStub.scanImagePreflight.mockImplementation(async (
      _ref: string,
      _nodeId: number,
      _stack: string,
      opts?: { scanRef?: string },
    ) => (opts?.scanRef?.includes(OTHER_DIGEST)
      ? mkScan({ id: 11, highest_severity: 'CRITICAL', critical_count: 1, total_vulnerabilities: 1 })
      : mkScan({ id: 12, highest_severity: 'CRITICAL', critical_count: 1, total_vulnerabilities: 1 })));
    modelWith([
      { name: 'web', declaredImage: 'registry.example.com/web:latest', hasBuild: false, pullPolicy: 'always', platform: 'linux/amd64', expectedReplicas: 1, dependsOn: [], hasHealthcheck: false },
      { name: 'tools', declaredImage: 'registry.example.com/web:latest', hasBuild: false, pullPolicy: 'always', platform: 'linux/arm64', expectedReplicas: 1, dependsOn: [], hasHealthcheck: false },
    ]);

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'compose' });

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.platform).sort()).toEqual(['linux/amd64', 'linux/arm64']);
    const candidateRecords = (result.evidence?.records ?? []).filter((r) => r.subject === 'candidate');
    expect(candidateRecords.map((r) => r.platform).sort()).toEqual(['linux/amd64', 'linux/arm64']);
    expect(candidateRecords.map((r) => r.platformDigest).sort()).toEqual([OTHER_DIGEST, PLATFORM_DIGEST].sort());
  });

  it('refuses a service platform override it cannot read instead of scanning the node child', async () => {
    modelWith([{ name: 'web', declaredImage: 'registry.example.com/web:latest', hasBuild: false, pullPolicy: 'always', platform: 'linux/amd64/arm/v7/extra', expectedReplicas: 1, dependsOn: [], hasHealthcheck: false }]);

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'compose' });

    expect(candidates.resolve).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toMatchObject({
      imageRef: 'registry.example.com/web:latest',
      error: expect.stringContaining('platform'),
    });
    expect(result.evidence?.records[0]).toMatchObject({
      subject: 'candidate',
      state: 'unknown',
    });
  });

  it('keeps a build-only service on the image Compose generates, not a registry candidate', async () => {
    composeStub.listStackImages.mockResolvedValue(['registry.example.com/web:latest', 'my-stack-built']);
    modelWith([
      { name: 'web', declaredImage: 'registry.example.com/web:latest', hasBuild: false, pullPolicy: null, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false },
      { name: 'built', declaredImage: null, hasBuild: true, pullPolicy: null, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false },
    ]);

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'compose' });

    // `config --images` names the generated image, but no service declares it,
    // and it does not exist until the build.
    expect(candidates.resolve).not.toHaveBeenCalled();
    expect(result.evaluatedCandidates).toBeUndefined();
    expect(result.pullServices).toBeUndefined();
    expect(trivyStub.scanImagePreflight).toHaveBeenCalledWith(
      'my-stack-built', 1, 'web', undefined,
    );
  });

  it('recognizes a generated build image when the rendered model names no project', async () => {
    // Compose omits `name` only in unusual renders, but the generated image is
    // still a bare repository ending in `-<service>`. A registry-qualified
    // reference ending the same way, and a digest pin, are not generated names.
    composeStub.listStackImages.mockResolvedValue([
      'my-stack-built',
      'registry.example.com/acme/x-built:latest',
      `my-stack-built@${PLATFORM_DIGEST}`,
    ]);
    models.build.mockResolvedValue({
      renderable: true,
      projectName: null,
      services: [
        { name: 'built', declaredImage: null, hasBuild: true, pullPolicy: null, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false },
      ],
    });

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'compose' });

    expect(result.ok).toBe(true);
    expect(candidates.resolve.mock.calls.map((call) => call[1])).toEqual([
      'registry.example.com/acme/x-built:latest',
      `my-stack-built@${PLATFORM_DIGEST}`,
    ]);
    expect(result.evaluatedCandidates).toHaveLength(2);
    expect(trivyStub.scanImagePreflight).toHaveBeenCalledWith('my-stack-built', 1, 'web', undefined);
  });

  it('recognizes a tagged generated build image when the project name is known', async () => {
    composeStub.listStackImages.mockResolvedValue(['my-stack-built:latest']);
    modelWith([
      { name: 'built', declaredImage: null, hasBuild: true, pullPolicy: null, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false },
    ]);

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'compose' });

    expect(result.ok).toBe(true);
    expect(candidates.resolve).not.toHaveBeenCalled();
    expect(result.evaluatedCandidates).toBeUndefined();
    expect(result.pullServices).toBeUndefined();
  });

  it('does not pull any reference by name when the model will not render', async () => {
    // The model failed, so no reference can be attributed to the service that
    // owns it, and `config --images` still lists the image Compose generates for
    // a build-only service next to ordinary registry images. Pulling any of them
    // by reference would be a fetch the gate could not attribute, so the
    // boundary keeps `up --pull never` and the gate evaluates the installed
    // image for every reference.
    composeStub.listStackImages.mockResolvedValue(['my-stack-built', 'registry.example.com/web:latest']);
    models.build.mockResolvedValue({
      renderable: false,
      code: 'effective_model_render_failed',
      error: 'Sencho could not render the effective Compose model.',
    });

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'compose' });

    expect(result.ok).toBe(true);
    expect(candidates.resolve).not.toHaveBeenCalled();
    expect(result.evaluatedCandidates).toBeUndefined();
    expect(result.pullServices).toBeUndefined();
    expect(result.noPullOnUp).toBe(true);
    expect(trivyStub.scanImagePreflight).toHaveBeenCalledTimes(2);
    expect(trivyStub.scanImagePreflight).toHaveBeenCalledWith('my-stack-built', 1, 'web', undefined);
    expect(trivyStub.scanImagePreflight).toHaveBeenCalledWith('registry.example.com/web:latest', 1, 'web', undefined);
  });

  it('still resolves references supplied without a model', async () => {
    // Blueprint preflight and GitOps acceptance hand the gate their own
    // references and no model. They are not a plain `up` of a rendered stack, so
    // the no-model case keeps the candidate reading instead of applying the
    // generated-name heuristic to a bare name.
    const result = await enforcePolicyForImageRefs(
      'web',
      1,
      ['my-stack-built'],
      { bypass: false, actor: 'u', imageSource: 'compose' },
    );

    expect(result.ok).toBe(true);
    expect(candidates.resolve).toHaveBeenCalledTimes(1);
    expect(result.evaluatedCandidates).toHaveLength(1);
  });

  it('leaves a daily policy on the installed image while its window has not elapsed', async () => {
    modelWith([{ name: 'web', declaredImage: 'registry.example.com/web:latest', hasBuild: false, pullPolicy: 'daily', expectedReplicas: 1, dependsOn: [], hasHealthcheck: false }]);
    candidates.localImageExists.mockResolvedValue(true);
    candidates.lastTagTime.mockResolvedValue(Date.now() - 60 * 60 * 1000);

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'compose' });

    expect(candidates.resolve).not.toHaveBeenCalled();
    expect(result.evaluatedCandidates).toBeUndefined();
    // The deploy boundary must not force the refresh `up` would skip, but `up`
    // must not be free to start one if the window elapses before it runs.
    expect(result.pullServices).toBeUndefined();
    expect(result.noPullOnUp).toBe(true);
  });

  it('evaluates a daily policy once its window has elapsed', async () => {
    modelWith([{ name: 'web', declaredImage: 'registry.example.com/web:latest', hasBuild: false, pullPolicy: 'daily', expectedReplicas: 1, dependsOn: [], hasHealthcheck: false }]);
    candidates.localImageExists.mockResolvedValue(true);
    candidates.lastTagTime.mockResolvedValue(Date.now() - 25 * 60 * 60 * 1000);

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'compose' });

    expect(candidates.resolve).toHaveBeenCalledTimes(1);
    expect(result.pullServices).toEqual(['web']);
  });

  it('does not fetch a service Compose skips, and does name a digest pin it must fetch', async () => {
    const pinned = `registry.example.com/web@${PLATFORM_DIGEST}`;
    composeStub.listStackImages.mockResolvedValue(['registry.example.com/web:latest', pinned]);
    modelWith([
      { name: 'web', declaredImage: 'registry.example.com/web:latest', hasBuild: false, pullPolicy: null, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false },
      { name: 'pinned', declaredImage: pinned, hasBuild: false, pullPolicy: null, expectedReplicas: 1, dependsOn: [], hasHealthcheck: false },
    ]);
    candidates.localImageExists.mockImplementation(async (_nodeId: number, ref: string) => ref !== pinned);
    candidates.resolve.mockResolvedValue({
      kind: 'installed', ref: pinned, why: 'digest_pinned',
    });

    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'compose' });

    // The ordinary present image is not fetched (`up` would skip it), while the
    // absent digest pin is, so the boundary pulls only what `up` would have.
    expect(result.pullServices).toEqual(['pinned']);
    expect(result.evaluatedCandidates).toBeUndefined();
  });
});

describe('a candidate that cannot be resolved', () => {
  const UNRESOLVED = {
    kind: 'unresolved' as const,
    ref: 'registry.example.com/web:latest',
    state: 'unavailable' as const,
    failureClass: 'registry_unavailable' as const,
    reason: 'The registry image could not be resolved: Registry error (503)',
  };

  beforeEach(() => {
    candidates.resolve.mockResolvedValue(UNRESOLVED);
  });

  it('blocks a manual update under the Scan failed rule and never scans the installed image', async () => {
    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'registry' });

    expect(result.ok).toBe(false);
    expect(trivyStub.scanImagePreflight).not.toHaveBeenCalled();
    expect(result.violations[0].error).toContain('could not be resolved');
    const application = result.evidence?.applications.find((a) => a.target === 'registry.example.com/web:latest');
    expect(application?.rule).toBe('security_scan_failure=block');
    expect(result.evidence?.records[0]).toMatchObject({ subject: 'candidate', state: 'unavailable' });
  });

  it('holds an unattended update under Candidate not evaluated even when Scan failed is set to allow', async () => {
    dbStub.getGlobalSettings.mockReturnValue({
      security_scan_failure: 'allow',
      security_scanner_unavailable: 'allow',
      security_candidate_unproven: 'block',
    });

    const result = await enforcePolicyPreDeploy('web', 1, {
      bypass: false, actor: 'system:scheduler', imageSource: 'registry', unattended: true,
    });

    expect(result.ok).toBe(false);
    expect(result.evidence?.applications[0].rule).toBe('security_candidate_unproven=block');
  });

  it('allows an unattended update when Candidate not evaluated is set to allow', async () => {
    dbStub.getGlobalSettings.mockReturnValue({
      security_scan_failure: 'block',
      security_scanner_unavailable: 'allow',
      security_candidate_unproven: 'allow',
    });

    const result = await enforcePolicyPreDeploy('web', 1, {
      bypass: false, actor: 'system:webhook', imageSource: 'registry', unattended: true,
    });

    expect(result.ok).toBe(true);
    expect(trivyStub.scanImagePreflight).not.toHaveBeenCalled();
  });
});

describe('unattended vocabulary', () => {
  it('applies Candidate not evaluated to a failed candidate scan, not Scan failed', async () => {
    trivyStub.scanImagePreflight.mockRejectedValue(new Error('trivy process crashed'));

    const result = await enforcePolicyPreDeploy('web', 1, {
      bypass: false, actor: 'system:image-update', imageSource: 'registry', unattended: true,
    });

    expect(result.ok).toBe(false);
    expect(result.evidence?.applications[0].rule).toBe('security_candidate_unproven=block');
  });

  it('applies Candidate not evaluated to a missing scanner on an unattended pulling path', async () => {
    trivyStub.isTrivyAvailable.mockReturnValue(false);

    const result = await enforcePolicyPreDeploy('web', 1, {
      bypass: false, actor: 'system:scheduler', imageSource: 'compose', unattended: true,
    });

    expect(result.ok).toBe(false);
    expect(result.evidence?.applications[0].rule).toBe('security_candidate_unproven=block');
  });

  it('keeps Scan failed for an unattended operation that runs the installed image', async () => {
    trivyStub.scanImagePreflight.mockRejectedValue(new Error('trivy process crashed'));

    const result = await enforcePolicyPreDeploy('web', 1, {
      bypass: false, actor: 'system:recovery', imageSource: 'installed', unattended: true,
    });

    expect(result.ok).toBe(false);
    expect(result.evidence?.applications[0].rule).toBe('security_scan_failure=block');
  });
});

describe('installed mode is unchanged', () => {
  it('scans the installed tag with no candidate options and no registry call', async () => {
    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u' });

    expect(result.ok).toBe(true);
    expect(candidates.resolve).not.toHaveBeenCalled();
    expect(trivyStub.scanImagePreflight).toHaveBeenCalledWith(
      'registry.example.com/web:latest', 1, 'web', undefined,
    );
    expect(result.evaluatedCandidates).toBeUndefined();
  });

  it('reports a candidate digest only when one was actually evaluated', async () => {
    // A different candidate on the same tag is a different decision; the pair is
    // carried so the pull can prove it installed that one.
    trivyStub.scanImagePreflight.mockResolvedValue(mkScan({ image_digest: OTHER_DIGEST }));
    const result = await enforcePolicyPreDeploy('web', 1, { bypass: false, actor: 'u', imageSource: 'registry' });
    expect(result.evaluatedCandidates?.[0].indexDigest).toBe(INDEX);
  });
});
