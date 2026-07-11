/**
 * Unit tests for fingerprinted prune plans: fingerprint stability, managed
 * container enumeration, stale detection, per-item skip on race, and no
 * unplanned deletes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fingerprintPrunePlan,
  normalizePruneTargets,
  PrunePlanStaleError,
} from '../services/prunePlan';

const { mockDocker } = vi.hoisted(() => {
  const mockDocker = {
    df: vi.fn(),
    listImages: vi.fn().mockResolvedValue([]),
    listVolumes: vi.fn().mockResolvedValue({ Volumes: [] }),
    listNetworks: vi.fn().mockResolvedValue([]),
    listContainers: vi.fn().mockResolvedValue([]),
    getContainer: vi.fn(),
    getImage: vi.fn(),
    getVolume: vi.fn(),
    getNetwork: vi.fn(),
    pruneContainers: vi.fn(),
    pruneImages: vi.fn(),
    pruneNetworks: vi.fn(),
    pruneVolumes: vi.fn(),
  };
  return { mockDocker };
});

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getDocker: () => mockDocker,
      getDefaultNodeId: () => 1,
      getComposeDir: () => '/test/compose',
    }),
  },
}));

vi.mock('../services/SelfIdentityService', () => ({
  default: {
    getInstance: () => ({
      isOwnContainer: () => false,
      isOwnImage: () => false,
      isOwnVolume: () => false,
      isOwnNetwork: () => false,
    }),
  },
}));

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
}));
vi.mock('util', () => ({
  promisify: () => vi.fn(),
}));

import DockerController from '../services/DockerController';
import { CacheService } from '../services/CacheService';

beforeEach(() => {
  vi.clearAllMocks();
  CacheService.getInstance().invalidate('project-name-map');
  mockDocker.listImages.mockResolvedValue([]);
  mockDocker.listVolumes.mockResolvedValue({ Volumes: [] });
  mockDocker.listNetworks.mockResolvedValue([]);
  mockDocker.listContainers.mockResolvedValue([]);
  // Real Docker listVolumes returns UsageData: null; RefCount lives on df.
  mockDocker.df.mockResolvedValue({ Volumes: [], Images: [], LayersSize: 0 });
});

describe('fingerprintPrunePlan', () => {
  it('is stable for the same sorted target:id pairs regardless of input order', () => {
    const a = fingerprintPrunePlan(1, 'managed', ['volumes', 'images'], [
      { target: 'images', id: 'img-b' },
      { target: 'volumes', id: 'vol-a' },
    ]);
    const b = fingerprintPrunePlan(1, 'managed', ['volumes', 'images'], [
      { target: 'volumes', id: 'vol-a' },
      { target: 'images', id: 'img-b' },
    ]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes when scope, targets, nodeId, or items change', () => {
    const base = fingerprintPrunePlan(1, 'managed', ['volumes'], [{ target: 'volumes', id: 'v1' }]);
    expect(fingerprintPrunePlan(2, 'managed', ['volumes'], [{ target: 'volumes', id: 'v1' }])).not.toBe(base);
    expect(fingerprintPrunePlan(1, 'all', ['volumes'], [{ target: 'volumes', id: 'v1' }])).not.toBe(base);
    expect(fingerprintPrunePlan(1, 'managed', ['images'], [{ target: 'volumes', id: 'v1' }])).not.toBe(base);
    expect(fingerprintPrunePlan(1, 'managed', ['volumes'], [{ target: 'volumes', id: 'v2' }])).not.toBe(base);
  });
});

describe('normalizePruneTargets', () => {
  it('keeps single-target order and sorts multi-target into dependency order', () => {
    expect(normalizePruneTargets(['images'])).toEqual(['images']);
    expect(normalizePruneTargets(['images', 'volumes', 'containers'])).toEqual([
      'volumes', 'containers', 'images',
    ]);
  });
});

describe('DockerController.buildPrunePlan', () => {
  it('enumerates managed stopped containers and never calls pruneSystem', async () => {
    mockDocker.listContainers.mockResolvedValue([
      {
        Id: 'c-managed-exited',
        Names: ['/stack_web_1'],
        State: 'exited',
        ImageID: 'img-managed',
        Labels: { 'com.docker.compose.project': 'my-stack' },
        SizeRw: 100,
      },
      {
        Id: 'c-unmanaged',
        Names: ['/other'],
        State: 'exited',
        ImageID: 'img-other',
        Labels: { 'com.docker.compose.project': 'foreign' },
      },
      {
        Id: 'c-running',
        Names: ['/stack_db_1'],
        State: 'running',
        ImageID: 'img-managed',
        Labels: { 'com.docker.compose.project': 'my-stack' },
      },
    ]);

    const dc = DockerController.getInstance(1);
    const plan = await dc.buildPrunePlan(['containers'], 'managed', ['my-stack'], 1);

    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      target: 'containers',
      id: 'c-managed-exited',
      name: 'stack_web_1',
    });
    expect(mockDocker.pruneContainers).not.toHaveBeenCalled();
    expect(mockDocker.getContainer).not.toHaveBeenCalled();
  });

  it('does not call any remove APIs while building a plan', async () => {
    mockDocker.listVolumes.mockResolvedValue({
      Volumes: [{
        Name: 'my-stack_data',
        Labels: { 'com.docker.compose.project': 'my-stack' },
        UsageData: null,
      }],
    });
    mockDocker.df.mockResolvedValue({
      Volumes: [{ Name: 'my-stack_data', UsageData: { RefCount: 0, Size: 50 } }],
      Images: [],
      LayersSize: 0,
    });
    const remove = vi.fn();
    mockDocker.getVolume.mockReturnValue({ remove });

    const dc = DockerController.getInstance(1);
    await dc.buildPrunePlan(['volumes'], 'managed', ['my-stack'], 1);

    expect(remove).not.toHaveBeenCalled();
    expect(mockDocker.getVolume).not.toHaveBeenCalled();
  });

  it('plans dangling volumes using df RefCount when listVolumes UsageData is null', async () => {
    mockDocker.listVolumes.mockResolvedValue({
      Volumes: [{
        Name: 'my-stack_data',
        Labels: { 'com.docker.compose.project': 'my-stack' },
        UsageData: null,
      }],
    });
    mockDocker.df.mockResolvedValue({
      Volumes: [{ Name: 'my-stack_data', UsageData: { RefCount: 0, Size: 42 } }],
      Images: [],
      LayersSize: 0,
    });

    const dc = DockerController.getInstance(1);
    const plan = await dc.buildPrunePlan(['volumes'], 'managed', ['my-stack'], 1);

    expect(plan.items).toEqual([
      expect.objectContaining({
        target: 'volumes',
        id: 'my-stack_data',
        sizeBytes: 42,
      }),
    ]);
  });

  it('excludes unattributed unused images from managed scope', async () => {
    mockDocker.listImages.mockResolvedValue([
      { Id: 'img-external', RepoTags: ['saelix/sencho:pr-1610'], Size: 100, Containers: 0 },
      {
        Id: 'img-labeled',
        RepoTags: ['my-stack-web:latest'],
        Size: 50,
        Containers: 0,
        Labels: { 'com.docker.compose.project': 'my-stack' },
      },
    ]);

    const dc = DockerController.getInstance(1);
    const plan = await dc.buildPrunePlan(['images'], 'managed', ['my-stack'], 1);

    expect(plan.items.map((i) => i.id)).toEqual(['img-labeled']);
  });

  it('does not mark an image free when only some referencing containers are planned', async () => {
    mockDocker.listContainers.mockResolvedValue([
      {
        Id: 'c-exited',
        Names: ['/exited'],
        State: 'exited',
        ImageID: 'img-shared',
        Labels: { 'com.docker.compose.project': 'my-stack' },
      },
      {
        Id: 'c-running',
        Names: ['/running'],
        State: 'running',
        ImageID: 'img-shared',
        Labels: { 'com.docker.compose.project': 'my-stack' },
      },
    ]);
    mockDocker.listImages.mockResolvedValue([
      { Id: 'img-shared', RepoTags: ['alpine:3.19'], Size: 7_000_000, Containers: 2 },
    ]);

    const dc = DockerController.getInstance(1);
    const plan = await dc.buildPrunePlan(['containers', 'images'], 'managed', ['my-stack'], 1);

    expect(plan.items.some((i) => i.target === 'containers' && i.id === 'c-exited')).toBe(true);
    expect(plan.items.some((i) => i.target === 'images' && i.id === 'img-shared')).toBe(false);
  });

  it('uses SharedSize when estimating reclaimable image bytes', async () => {
    mockDocker.listImages.mockResolvedValue([
      { Id: 'img-a', RepoTags: ['a:1'], Size: 1_000_000_000, Containers: 0 },
      { Id: 'img-b', RepoTags: ['b:1'], Size: 1_000_000_000, Containers: 0 },
    ]);
    mockDocker.df.mockResolvedValue({
      Volumes: [],
      Images: [
        { Id: 'img-a', SharedSize: 900_000_000, Size: 1_000_000_000 },
        { Id: 'img-b', SharedSize: 900_000_000, Size: 1_000_000_000 },
      ],
      LayersSize: 1_100_000_000,
    });

    const dc = DockerController.getInstance(1);
    const plan = await dc.buildPrunePlan(['images'], 'all', [], 1);

    // Unique bytes per image = Size - SharedSize = 100MB each, not full 1GB each.
    expect(plan.reclaimableBytes).toBe(200_000_000);
  });
});

describe('DockerController.executePrunePlan', () => {
  it('throws PrunePlanStaleError when the fingerprint no longer matches', async () => {
    mockDocker.listContainers.mockResolvedValue([
      {
        Id: 'c1',
        Names: ['/c1'],
        State: 'exited',
        ImageID: 'img1',
        Labels: { 'com.docker.compose.project': 'my-stack' },
      },
    ]);
    const dc = DockerController.getInstance(1);
    const plan = await dc.buildPrunePlan(['containers'], 'managed', ['my-stack'], 1);
    const stale = { ...plan, fingerprint: 'deadbeef' };

    await expect(dc.executePrunePlan(stale, ['my-stack'])).rejects.toBeInstanceOf(PrunePlanStaleError);
  });

  it('skips a planned container that becomes running before delete', async () => {
    mockDocker.listContainers.mockResolvedValue([
      {
        Id: 'c1',
        Names: ['/c1'],
        State: 'exited',
        ImageID: 'img1',
        Labels: { 'com.docker.compose.project': 'my-stack' },
      },
    ]);
    const remove = vi.fn();
    mockDocker.getContainer.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({
        State: { Status: 'running' },
        Config: { Labels: { 'com.docker.compose.project': 'my-stack' } },
        Image: 'img1',
      }),
      remove,
    });

    const dc = DockerController.getInstance(1);
    const plan = await dc.buildPrunePlan(['containers'], 'managed', ['my-stack'], 1);
    const result = await dc.executePrunePlan(plan, ['my-stack']);

    expect(remove).not.toHaveBeenCalled();
    expect(result.outcomes).toEqual([
      expect.objectContaining({
        id: 'c1',
        target: 'containers',
        status: 'skipped',
        reason: expect.stringMatching(/running/i),
      }),
    ]);
  });

  it('skips a planned image when its container removal failed and the image is still referenced', async () => {
    mockDocker.listContainers.mockResolvedValue([
      {
        Id: 'c1',
        Names: ['/c1'],
        State: 'exited',
        ImageID: 'img1',
        Labels: { 'com.docker.compose.project': 'my-stack' },
      },
    ]);
    mockDocker.listImages.mockResolvedValue([
      { Id: 'img1', RepoTags: ['app:latest'], Size: 1000, Containers: 1 },
    ]);
    mockDocker.listNetworks.mockResolvedValue([]);
    mockDocker.listVolumes.mockResolvedValue({ Volumes: [] });

    const containerRemove = vi.fn().mockRejectedValue(new Error('busy'));
    mockDocker.getContainer.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({
        State: { Status: 'exited' },
        Config: { Labels: { 'com.docker.compose.project': 'my-stack' } },
        Image: 'img1',
      }),
      remove: containerRemove,
    });
    const imageRemove = vi.fn();
    mockDocker.getImage.mockReturnValue({ remove: imageRemove });

    const dc = DockerController.getInstance(1);
    const plan = await dc.buildPrunePlan(['containers', 'images'], 'managed', ['my-stack'], 1);
    expect(plan.items.some((i) => i.target === 'images' && i.id === 'img1')).toBe(true);

    // After failed container remove, image list still reports Containers > 0.
    mockDocker.listImages.mockResolvedValue([
      { Id: 'img1', RepoTags: ['app:latest'], Size: 1000, Containers: 1 },
    ]);

    const result = await dc.executePrunePlan(plan, ['my-stack']);
    const imageOutcome = result.outcomes.find((o) => o.target === 'images' && o.id === 'img1');
    expect(imageOutcome).toMatchObject({ status: 'skipped' });
    expect(imageRemove).not.toHaveBeenCalled();
  });

  it('never deletes items that are not in the plan', async () => {
    mockDocker.listVolumes.mockResolvedValue({
      Volumes: [
        {
          Name: 'planned-vol',
          Labels: { 'com.docker.compose.project': 'my-stack' },
          UsageData: null,
        },
        {
          Name: 'other-vol',
          Labels: { 'com.docker.compose.project': 'my-stack' },
          UsageData: null,
        },
      ],
    });
    mockDocker.df.mockResolvedValue({
      Volumes: [
        { Name: 'planned-vol', UsageData: { RefCount: 0, Size: 10 } },
        { Name: 'other-vol', UsageData: { RefCount: 0, Size: 20 } },
      ],
      Images: [],
      LayersSize: 0,
    });

    const removed: string[] = [];
    mockDocker.getVolume.mockImplementation((name: string) => ({
      remove: vi.fn().mockImplementation(async () => { removed.push(name); }),
    }));

    const dc = DockerController.getInstance(1);
    const plan = await dc.buildPrunePlan(['volumes'], 'managed', ['my-stack'], 1);
    // Execute a surgically narrowed plan that only includes planned-vol.
    const narrow = {
      ...plan,
      items: plan.items.filter((i) => i.id === 'planned-vol'),
      fingerprint: fingerprintPrunePlan(1, 'managed', ['volumes'], [{ target: 'volumes', id: 'planned-vol' }]),
      reclaimableBytes: 10,
    };

    // assertPlanFresh rebuilds from Docker and will see both volumes, so the
    // fingerprint will mismatch. Instead spy assertPlanFresh to accept the
    // narrowed plan as fresh so we can assert execute only touches plan items.
    vi.spyOn(dc, 'assertPlanFresh').mockResolvedValue(narrow);
    await dc.executePrunePlan(narrow, ['my-stack']);

    expect(removed).toEqual(['planned-vol']);
    expect(removed).not.toContain('other-vol');
  });

  it('removes with force:false', async () => {
    mockDocker.listVolumes.mockResolvedValue({
      Volumes: [{
        Name: 'v1',
        Labels: { 'com.docker.compose.project': 'my-stack' },
        UsageData: null,
      }],
    });
    mockDocker.df.mockResolvedValue({
      Volumes: [{ Name: 'v1', UsageData: { RefCount: 0, Size: 5 } }],
      Images: [],
      LayersSize: 0,
    });
    const remove = vi.fn().mockResolvedValue(undefined);
    mockDocker.getVolume.mockReturnValue({ remove });

    const dc = DockerController.getInstance(1);
    const plan = await dc.buildPrunePlan(['volumes'], 'managed', ['my-stack'], 1);
    await dc.executePrunePlan(plan, ['my-stack']);

    expect(remove).toHaveBeenCalledWith({ force: false });
  });
});
