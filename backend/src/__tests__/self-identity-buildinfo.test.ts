/**
 * Unit tests for SelfIdentityService.getBuildInfo(): the canonical runtime
 * build identity (version, channel, imageRef, imageId, revision), the detached
 * bounded revision enrichment, and the failure-isolation guarantee.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────

const { mockContainer, mockDocker, mockInspectImage, mockGetSenchoVersion } = vi.hoisted(() => {
  const mockContainer = { inspect: vi.fn() };
  const mockDocker = {
    getContainer: vi.fn(() => mockContainer),
    getImage: vi.fn(),
    listImages: vi.fn().mockResolvedValue([]),
    listVolumes: vi.fn().mockResolvedValue({ Volumes: [] }),
    listNetworks: vi.fn().mockResolvedValue([]),
    listContainers: vi.fn().mockResolvedValue([]),
  };
  return {
    mockContainer,
    mockDocker,
    mockInspectImage: vi.fn(),
    mockGetSenchoVersion: vi.fn(() => '0.97.1'),
  };
});

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getDocker: () => mockDocker,
      getDefaultNodeId: () => 1,
    }),
  },
}));

// Replace defaultInspectImage so enrichment is deterministic and isolated.
vi.mock('../services/selfDevBuildDetect', () => ({
  defaultInspectImage: (...args: unknown[]) => mockInspectImage(...args),
}));

vi.mock('../services/CapabilityRegistry', () => ({
  getSenchoVersion: () => mockGetSenchoVersion(),
}));

vi.mock('child_process', () => ({ exec: vi.fn(), execFile: vi.fn() }));
vi.mock('util', () => ({ promisify: () => vi.fn() }));

import SelfIdentityService from '../services/SelfIdentityService';

const FULL_IMAGE_ID_HEX = 'b'.repeat(64);
const DIGEST = 'a'.repeat(64);

const originalHostname = process.env.HOSTNAME;

beforeEach(() => {
  vi.clearAllMocks();
  mockContainer.inspect.mockReset();
  mockDocker.getImage.mockReset();
  mockInspectImage.mockReset();
  mockGetSenchoVersion.mockReturnValue('0.97.1');
  SelfIdentityService.getInstance().resetForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalHostname === undefined) delete process.env.HOSTNAME;
  else process.env.HOSTNAME = originalHostname;
});

async function initWith(configImage: string | undefined): Promise<SelfIdentityService> {
  process.env.HOSTNAME = 'sencho-1';
  mockContainer.inspect.mockResolvedValue({
    Id: 'a'.repeat(64),
    Name: '/sencho',
    Image: 'sha256:' + FULL_IMAGE_ID_HEX,
    ...(configImage !== undefined ? { Config: { Image: configImage } } : {}),
    NetworkSettings: { Networks: {} },
    Mounts: [],
  });
  const svc = SelfIdentityService.getInstance();
  await svc.initialize();
  return svc;
}

/** Enrichment runs detached; poll until the condition holds so assertions are stable. */
async function until(assert: () => void): Promise<void> {
  await vi.waitFor(assert, { timeout: 2000 });
}

describe('SelfIdentityService.getBuildInfo', () => {
  it('identifies a dev image as DEV even when the packaged semver matches the previous stable', async () => {
    // The regression case from the ticket: dev image, version still 0.97.1.
    // The inspect mock must be set before initialize(): enrichment fires
    // detached during initialize(), before the awaited call returns.
    mockInspectImage.mockResolvedValue({
      RepoDigests: [`ghcr.io/studio-saelix/sencho-dev@sha256:${DIGEST}`],
      Os: 'linux',
      Architecture: 'amd64',
    });
    const svc = await initWith('ghcr.io/studio-saelix/sencho-dev:dev');
    await until(() => expect(svc.getBuildInfo().revision).toBe(`sha256:${DIGEST}`));

    const info = svc.getBuildInfo();
    expect(info.version).toBe('0.97.1');
    expect(info.channel).toBe('dev');
    expect(info.imageRef).toBe('ghcr.io/studio-saelix/sencho-dev:dev');
    expect(info.imageId).toBe(FULL_IMAGE_ID_HEX);
  });

  it('derives the revision from a pinned dev-<sha> tag without an image inspect', async () => {
    const svc = await initWith('ghcr.io/studio-saelix/sencho-dev:dev-abc1234');
    await until(() => expect(svc.getBuildInfo().revision).toBe('dev-abc1234'));

    const info = svc.getBuildInfo();
    expect(info.channel).toBe('dev');
    expect(mockInspectImage).not.toHaveBeenCalled();
  });

  it('classifies a stable image as stable', async () => {
    mockInspectImage.mockResolvedValue({
      RepoDigests: [`ghcr.io/studio-saelix/sencho@sha256:${DIGEST}`],
      Os: 'linux',
      Architecture: 'amd64',
    });
    const svc = await initWith('ghcr.io/studio-saelix/sencho:0.97.1');
    await until(() => expect(svc.getBuildInfo().revision).toBe(`sha256:${DIGEST}`));

    expect(svc.getBuildInfo().channel).toBe('stable');
  });

  it('reads unknown for partial metadata (no running image reference)', async () => {
    const svc = await initWith(undefined);

    const info = svc.getBuildInfo();
    expect(info.imageRef).toBeNull();
    expect(info.channel).toBe('unknown');
    expect(info.revision).toBeNull();
    expect(info.imageId).toBe(FULL_IMAGE_ID_HEX);
  });

  it('keeps the dev channel but null revision when image inspection fails', async () => {
    mockInspectImage.mockRejectedValue(new Error('docker daemon unreachable'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const svc = await initWith('ghcr.io/studio-saelix/sencho-dev:dev');
    await until(() => expect(warnSpy).toHaveBeenCalled());

    const info = svc.getBuildInfo();
    expect(info.channel).toBe('dev');
    expect(info.revision).toBeNull();
    // C2: a failed enrichment must not corrupt the already-captured core identity.
    expect(info.imageRef).toBe('ghcr.io/studio-saelix/sencho-dev:dev');
    expect(info.imageId).toBe(FULL_IMAGE_ID_HEX);
  });

  it('never inspects the image again on repeated reads', async () => {
    mockInspectImage.mockResolvedValue({
      RepoDigests: [`ghcr.io/studio-saelix/sencho-dev@sha256:${DIGEST}`],
      Os: 'linux',
      Architecture: 'amd64',
    });
    const svc = await initWith('ghcr.io/studio-saelix/sencho-dev:dev');
    await until(() => expect(mockInspectImage).toHaveBeenCalledTimes(1));

    for (let i = 0; i < 5; i++) svc.getBuildInfo();
    expect(mockInspectImage).toHaveBeenCalledTimes(1);
  });

  it('exposes revision only after enrichment settles, and whenRevisionResolved awaits that', async () => {
    let resolveInspect!: (v: { RepoDigests: string[]; Os: string; Architecture: string }) => void;
    mockInspectImage.mockReturnValue(new Promise((res) => { resolveInspect = res; }));

    const svc = await initWith('ghcr.io/studio-saelix/sencho-dev:dev');
    // initialize() returned without awaiting the detached enrichment, so the
    // revision is still transiently null and the settle promise is pending.
    expect(svc.getBuildInfo().revision).toBeNull();

    // A reader that awaits the settle promise (the build-info route) blocks
    // until enrichment lands, then observes the resolved digest, so a single
    // successful read never freezes a transient null.
    const settled = svc.whenRevisionResolved();
    resolveInspect({
      RepoDigests: [`ghcr.io/studio-saelix/sencho-dev@sha256:${DIGEST}`],
      Os: 'linux',
      Architecture: 'amd64',
    });
    await settled;
    expect(svc.getBuildInfo().revision).toBe(`sha256:${DIGEST}`);
  });

  it('resolves whenRevisionResolved immediately when no enrichment ever started', async () => {
    process.env.HOSTNAME = undefined;
    const svc = SelfIdentityService.getInstance();
    await svc.whenRevisionResolved();
    expect(svc.getBuildInfo().revision).toBeNull();
  });
});
