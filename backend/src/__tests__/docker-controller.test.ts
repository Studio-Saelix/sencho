/**
 * Unit tests for DockerController — validateApiData, state-safe container ops,
 * disk usage, classified resources, orphan detection, and error paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────

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
    pruneContainers: vi.fn().mockResolvedValue({ SpaceReclaimed: 0 }),
    pruneImages: vi.fn().mockResolvedValue({ SpaceReclaimed: 0 }),
    pruneNetworks: vi.fn().mockResolvedValue({}),
    pruneVolumes: vi.fn().mockResolvedValue({ SpaceReclaimed: 0 }),
    createNetwork: vi.fn(),
  };
  return { mockDocker };
});

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getDocker: () => mockDocker,
      getDefaultNodeId: () => 1,
    }),
  },
}));

// Prevent COMPOSE_DIR related issues
vi.mock('child_process', () => ({
  exec: vi.fn(),
}));
vi.mock('util', () => ({
  promisify: () => vi.fn(),
}));

import DockerController from '../services/DockerController';
import { CacheService } from '../services/CacheService';

beforeEach(() => {
  vi.clearAllMocks();
});

// ── validateApiData ────────────────────────────────────────────────────

describe('DockerController - validateApiData', () => {
  it('throws when response is a string (HTML from wrong port)', async () => {
    mockDocker.listImages.mockResolvedValue('<html>Not Docker</html>');

    const dc = DockerController.getInstance(1);
    await expect(dc.getImages()).rejects.toThrow('Invalid response from Docker API');
  });

  it('passes through valid object data', async () => {
    const imageData = [{ Id: 'sha256:abc', RepoTags: ['nginx:latest'], Size: 100 }];
    mockDocker.listImages.mockResolvedValue(imageData);

    const dc = DockerController.getInstance(1);
    const result = await dc.getImages();
    expect(result).toEqual(imageData);
  });
});

// ── State-safe container operations ────────────────────────────────────

describe('DockerController - startContainer', () => {
  it('starts a container successfully', async () => {
    const mockStart = vi.fn().mockResolvedValue(undefined);
    mockDocker.getContainer.mockReturnValue({ start: mockStart });

    const dc = DockerController.getInstance(1);
    await dc.startContainer('abc123');

    expect(mockStart).toHaveBeenCalled();
  });

  it('silently ignores 304 already-started error', async () => {
    const mockStart = vi.fn().mockRejectedValue({ statusCode: 304 });
    mockDocker.getContainer.mockReturnValue({ start: mockStart });

    const dc = DockerController.getInstance(1);
    await expect(dc.startContainer('abc123')).resolves.toBeUndefined();
  });

  it('rethrows other errors', async () => {
    const mockStart = vi.fn().mockRejectedValue(new Error('container not found'));
    mockDocker.getContainer.mockReturnValue({ start: mockStart });

    const dc = DockerController.getInstance(1);
    await expect(dc.startContainer('abc123')).rejects.toThrow('container not found');
  });
});

describe('DockerController - stopContainer', () => {
  it('stops a container successfully', async () => {
    const mockStop = vi.fn().mockResolvedValue(undefined);
    mockDocker.getContainer.mockReturnValue({ stop: mockStop });

    const dc = DockerController.getInstance(1);
    await dc.stopContainer('abc123');

    expect(mockStop).toHaveBeenCalled();
  });

  it('silently ignores 304 already-stopped error', async () => {
    const mockStop = vi.fn().mockRejectedValue({ statusCode: 304 });
    mockDocker.getContainer.mockReturnValue({ stop: mockStop });

    const dc = DockerController.getInstance(1);
    await expect(dc.stopContainer('abc123')).resolves.toBeUndefined();
  });

  it('rethrows other errors', async () => {
    const err = new Error('permission denied');
    const mockStop = vi.fn().mockRejectedValue(err);
    mockDocker.getContainer.mockReturnValue({ stop: mockStop });

    const dc = DockerController.getInstance(1);
    await expect(dc.stopContainer('abc123')).rejects.toThrow('permission denied');
  });
});

// ── removeContainers ───────────────────────────────────────────────────

describe('DockerController - removeContainers', () => {
  it('removes multiple containers and returns results', async () => {
    const mockRemove = vi.fn().mockResolvedValue(undefined);
    mockDocker.getContainer.mockReturnValue({ remove: mockRemove });

    const dc = DockerController.getInstance(1);
    const results = await dc.removeContainers(['c1', 'c2']);

    expect(results).toEqual([
      { id: 'c1', success: true },
      { id: 'c2', success: true },
    ]);
  });

  it('returns failure result for containers that cannot be removed', async () => {
    let callCount = 0;
    mockDocker.getContainer.mockImplementation(() => ({
      remove: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 2) throw new Error('in use');
        return Promise.resolve();
      }),
    }));

    const dc = DockerController.getInstance(1);
    const results = await dc.removeContainers(['c1', 'c2']);

    expect(results[0]).toEqual({ id: 'c1', success: true });
    expect(results[1]).toMatchObject({ id: 'c2', success: false, error: 'in use' });
  });
});

// ── getDiskUsage ───────────────────────────────────────────────────────

describe('DockerController - getDiskUsage', () => {
  it('calculates reclaimable space correctly', async () => {
    mockDocker.df.mockResolvedValue({
      LayersSize: 800,                                  // total image-layer bytes on disk
      Images: [
        { Id: 'img1', Containers: 0, Size: 500, SharedSize: 0 },  // reclaimable (unused)
        { Id: 'img2', Containers: 1, Size: 300, SharedSize: 0 },  // not reclaimable (in use); used = 300
      ],
      Containers: [
        { State: 'running', SizeRw: 100 },              // not reclaimable (running)
        { State: 'exited', SizeRw: 200 },                // reclaimable (stopped)
      ],
      Volumes: [
        { UsageData: { RefCount: 0, Size: 400 } },      // reclaimable (unused)
        { UsageData: { RefCount: 1, Size: 300 } },      // not reclaimable (in use)
      ],
      BuildCache: [
        { ID: 'bc1', InUse: false, Size: 600 },          // reclaimable
        { ID: 'bc2', InUse: true, Size: 250 },           // not reclaimable
      ],
    });

    const dc = DockerController.getInstance(1);
    const usage = await dc.getDiskUsage();

    // 800 LayersSize - 300 used-by-in-use-image = 500 reclaimable
    expect(usage.reclaimableImages).toBe(500);
    expect(usage.reclaimableImageCount).toBe(1);
    expect(usage.reclaimableContainers).toBe(200);
    expect(usage.reclaimableVolumes).toBe(400);
    expect(usage.reclaimableBuildCache).toBe(600);
    expect(usage.reclaimableBuildCacheCount).toBe(1);
  });

  it('uses daemon-reported ImageUsage.Reclaimable when present (API v1.44+)', async () => {
    // Modern Docker daemons compute Reclaimable server-side and ship the exact
    // value `docker system df` displays. Trust it over any client-side fallback.
    mockDocker.df.mockResolvedValue({
      LayersSize: 10_000_000_000,
      ImageUsage: { Reclaimable: 7_837_305_085, TotalSize: 10_000_000_000, ActiveCount: 11, TotalCount: 33 },
      Images: [
        { Id: 'a', Containers: 0, Size: 5_000_000_000, SharedSize: 0 },  // a fallback formula would say 5G
        { Id: 'b', Containers: 1, Size: 3_000_000_000, SharedSize: 0 },
      ],
      Containers: [],
      Volumes: [],
    });

    const dc = DockerController.getInstance(1);
    const usage = await dc.getDiskUsage();

    expect(usage.reclaimableImages).toBe(7_837_305_085);
    expect(usage.reclaimableImageCount).toBe(1);
  });

  it('does not double-count shared layers across unused images', async () => {
    // Three images sharing a 400MB base layer: two unused (800MB virtual each),
    // one in-use (600MB virtual). Total on-disk: 1GB. The in-use image holds
    // its unique 200MB; pruning the two unused frees the remaining 800MB.
    // The previous formula summed VirtualSize and would have returned 1.6GB
    // (impossibly larger than LayersSize).
    mockDocker.df.mockResolvedValue({
      LayersSize: 1_000_000_000,
      Images: [
        { Id: 'a', Containers: 0, VirtualSize: 800_000_000, SharedSize: 400_000_000 },
        { Id: 'b', Containers: 0, VirtualSize: 800_000_000, SharedSize: 400_000_000 },
        { Id: 'c', Containers: 1, VirtualSize: 600_000_000, SharedSize: 400_000_000 },
      ],
      Containers: [],
      Volumes: [],
    });

    const dc = DockerController.getInstance(1);
    const usage = await dc.getDiskUsage();

    expect(usage.reclaimableImages).toBe(800_000_000);
    expect(usage.reclaimableImageCount).toBe(2);
  });

  it('skips active images only when no usable size is available', async () => {
    // Truly unaccountable image: both VirtualSize and Size are -1 / missing.
    // Skipping leaks at most one image's worth of bytes into the reclaim
    // total, but modern daemons never return this shape; the prior "always
    // skip on -1" path moved any image with SharedSize=-1 into the leak set.
    mockDocker.df.mockResolvedValue({
      LayersSize: 1000,
      Images: [
        { Id: 'known', Containers: 1, VirtualSize: 400, SharedSize: 100 },
        { Id: 'truly-lost', Containers: 1, VirtualSize: -1, Size: -1 },
      ],
      Containers: [],
      Volumes: [],
    });

    const dc = DockerController.getInstance(1);
    const usage = await dc.getDiskUsage();

    // truly-lost is unaccountable and skipped; used = 400 - 100 = 300
    expect(usage.reclaimableImages).toBe(700);
    expect(usage.reclaimableImageCount).toBe(0);
  });

  it('treats SharedSize=-1 conservatively (full Size counts as used)', async () => {
    // Older daemons may report SharedSize as -1 (unknown) while Size is
    // accurate. Treating SharedSize as 0 in that case under-reports
    // reclaimable, which is the safe direction; the prior skip-on-(-1)
    // path made the image's full Size look reclaimable.
    mockDocker.df.mockResolvedValue({
      LayersSize: 1000,
      Images: [
        { Id: 'modern', Containers: 1, Size: 400, SharedSize: 100 },
        { Id: 'no-shared-info', Containers: 1, Size: 300, SharedSize: -1 },
      ],
      Containers: [],
      Volumes: [],
    });

    const dc = DockerController.getInstance(1);
    const usage = await dc.getDiskUsage();

    // modern: used += 400 - 100 = 300
    // no-shared-info: shared treated as 0, used += 300 - 0 = 300; total = 600
    // (the old buggy formula skipped no-shared-info, leaving used=300 and
    //  reclaimable=700 — i.e. the in-use 300 bytes looked reclaimable)
    expect(usage.reclaimableImages).toBe(400);
  });

  it('handles empty arrays gracefully', async () => {
    mockDocker.df.mockResolvedValue({
      Images: [],
      Containers: [],
      Volumes: [],
    });

    const dc = DockerController.getInstance(1);
    const usage = await dc.getDiskUsage();

    expect(usage.reclaimableImages).toBe(0);
    expect(usage.reclaimableContainers).toBe(0);
    expect(usage.reclaimableVolumes).toBe(0);
  });

  it('handles missing fields gracefully', async () => {
    mockDocker.df.mockResolvedValue({});

    const dc = DockerController.getInstance(1);
    const usage = await dc.getDiskUsage();

    expect(usage.reclaimableImages).toBe(0);
    expect(usage.reclaimableContainers).toBe(0);
    expect(usage.reclaimableVolumes).toBe(0);
  });

  it('counts only prune-eligible container states (created/exited/dead)', async () => {
    // `docker container prune` removes stopped containers (created/exited/dead).
    // Paused and restarting containers survive it, so counting them would leave
    // a residue the banner can never clear no matter which prune runs.
    mockDocker.df.mockResolvedValue({
      Images: [],
      Volumes: [],
      Containers: [
        { State: 'exited', SizeRw: 200 },      // prunable
        { State: 'created', SizeRw: 50 },      // prunable
        { State: 'dead', SizeRw: 25 },         // prunable
        { State: 'paused', SizeRw: 1000 },     // survives prune
        { State: 'restarting', SizeRw: 1000 }, // survives prune
        { State: 'running', SizeRw: 1000 },    // in use
      ],
    });

    const dc = DockerController.getInstance(1);
    const usage = await dc.getDiskUsage();

    expect(usage.reclaimableContainers).toBe(275);
    expect(usage.reclaimableContainerCount).toBe(3);
  });

  it('sizes stopped containers by the writable layer (SizeRw), not SizeRootFs', async () => {
    // SizeRootFs includes the read-only image layers, which removing a
    // container never frees. A stopped container that wrote nothing reclaims 0.
    mockDocker.df.mockResolvedValue({
      Images: [],
      Volumes: [],
      Containers: [
        { State: 'exited', SizeRw: 0, SizeRootFs: 500_000_000 }, // wrote nothing
        { State: 'exited', SizeRw: 1_500, SizeRootFs: 900_000 }, // writable layer only
      ],
    });

    const dc = DockerController.getInstance(1);
    const usage = await dc.getDiskUsage();

    expect(usage.reclaimableContainers).toBe(1_500);
    expect(usage.reclaimableContainerCount).toBe(2);
  });
});

// ── pruneSystem ────────────────────────────────────────────────────────

describe('DockerController - pruneSystem', () => {
  it('prunes containers and returns reclaimed bytes', async () => {
    mockDocker.pruneContainers.mockResolvedValue({ SpaceReclaimed: 1024 });

    const dc = DockerController.getInstance(1);
    const result = await dc.pruneSystem('containers');

    expect(result).toEqual({ success: true, reclaimedBytes: 1024 });
  });

  it('prunes images with dangling false filter', async () => {
    mockDocker.pruneImages.mockResolvedValue({ SpaceReclaimed: 2048 });

    const dc = DockerController.getInstance(1);
    await dc.pruneSystem('images');

    expect(mockDocker.pruneImages).toHaveBeenCalledWith({
      filters: expect.objectContaining({ dangling: { 'false': true } }),
    });
  });

  it('includes label filter when provided', async () => {
    mockDocker.pruneContainers.mockResolvedValue({ SpaceReclaimed: 0 });

    const dc = DockerController.getInstance(1);
    await dc.pruneSystem('containers', 'com.example=true');

    expect(mockDocker.pruneContainers).toHaveBeenCalledWith({
      filters: { label: ['com.example=true'] },
    });
  });

  it('prunes volumes with all true filter', async () => {
    mockDocker.pruneVolumes.mockResolvedValue({ SpaceReclaimed: 4096 });

    const dc = DockerController.getInstance(1);
    await dc.pruneSystem('volumes');

    expect(mockDocker.pruneVolumes).toHaveBeenCalledWith({
      filters: { all: ['true'] },
    });
  });
});

// ── pruneDanglingImages ────────────────────────────────────────────────

describe('DockerController - pruneDanglingImages', () => {
  it('prunes only dangling images and returns reclaimed bytes', async () => {
    mockDocker.pruneImages.mockResolvedValue({ SpaceReclaimed: 5000 });

    const dc = DockerController.getInstance(1);
    const result = await dc.pruneDanglingImages();

    // dangling:true keeps the prune to untagged layers, unlike pruneSystem('images')
    // which uses dangling:false to remove every unused image.
    expect(mockDocker.pruneImages).toHaveBeenCalledWith({
      filters: { dangling: { 'true': true } },
    });
    expect(result).toEqual({ success: true, reclaimedBytes: 5000 });
  });
});

// ── getClassifiedResources ─────────────────────────────────────────────

describe('DockerController - getClassifiedResources', () => {
  it('classifies managed and unmanaged images', async () => {
    mockDocker.listImages.mockResolvedValue([
      { Id: 'img1', RepoTags: ['nginx:latest'], Size: 100, Containers: 1 },
      { Id: 'img2', RepoTags: ['redis:latest'], Size: 200, Containers: 1 },
      { Id: 'img3', RepoTags: ['old:v1'], Size: 50, Containers: 0 },
    ]);
    mockDocker.listContainers.mockResolvedValue([
      { ImageID: 'img1', Labels: { 'com.docker.compose.project': 'my-stack' } },
      { ImageID: 'img2', Labels: { 'com.docker.compose.project': 'unknown-stack' } },
    ]);
    mockDocker.listVolumes.mockResolvedValue({ Volumes: [] });
    mockDocker.listNetworks.mockResolvedValue([]);

    const dc = DockerController.getInstance(1);
    const result = await dc.getClassifiedResources(['my-stack']);

    const managed = result.images.find(i => i.Id === 'img1');
    expect(managed!.managedStatus).toBe('managed');
    expect(managed!.managedBy).toBe('my-stack');

    const unmanaged = result.images.find(i => i.Id === 'img2');
    expect(unmanaged!.managedStatus).toBe('unmanaged');

    const unused = result.images.find(i => i.Id === 'img3');
    expect(unused!.managedStatus).toBe('unused');
  });

  it('classifies system networks', async () => {
    mockDocker.listImages.mockResolvedValue([]);
    mockDocker.listContainers.mockResolvedValue([]);
    mockDocker.listVolumes.mockResolvedValue({ Volumes: [] });
    mockDocker.listNetworks.mockResolvedValue([
      { Id: 'n1', Name: 'bridge', Driver: 'bridge', Scope: 'local' },
      { Id: 'n2', Name: 'host', Driver: 'host', Scope: 'local' },
      { Id: 'n3', Name: 'none', Driver: 'null', Scope: 'local' },
      { Id: 'n4', Name: 'my-stack_default', Driver: 'bridge', Scope: 'local', Labels: { 'com.docker.compose.project': 'my-stack' } },
    ]);

    const dc = DockerController.getInstance(1);
    const result = await dc.getClassifiedResources(['my-stack']);

    expect(result.networks.filter(n => n.managedStatus === 'system')).toHaveLength(3);
    expect(result.networks.find(n => n.Name === 'my-stack_default')!.managedStatus).toBe('managed');
  });

  it('classifies managed and unmanaged volumes', async () => {
    mockDocker.listImages.mockResolvedValue([]);
    mockDocker.listContainers.mockResolvedValue([]);
    mockDocker.listNetworks.mockResolvedValue([]);
    mockDocker.listVolumes.mockResolvedValue({
      Volumes: [
        { Name: 'my-stack_data', Driver: 'local', Mountpoint: '/var/lib/docker/volumes/my-stack_data', Labels: { 'com.docker.compose.project': 'my-stack' } },
        { Name: 'random_vol', Driver: 'local', Mountpoint: '/var/lib/docker/volumes/random', Labels: {} },
      ],
    });

    const dc = DockerController.getInstance(1);
    const result = await dc.getClassifiedResources(['my-stack']);

    expect(result.volumes.find(v => v.Name === 'my-stack_data')!.managedStatus).toBe('managed');
    expect(result.volumes.find(v => v.Name === 'random_vol')!.managedStatus).toBe('unmanaged');
  });
});

// ── pruneManagedOnly / estimateManagedReclaim (images) ─────────────────

describe('DockerController - managed image prune accounting', () => {
  // Two unused images each report a 1000-byte rolled-up Size, but 400 of those
  // bytes live in a layer shared with a third (in-use) image, so removing
  // the unused pair only frees the 600 unique bytes from each. The buggy
  // sum-of-Size accounting would have reported 2000; the fix should report
  // 1200 (600 × 2).
  const sharedLayerDfMock = {
    Images: [
      { Id: 'img-a', SharedSize: 400 },
      { Id: 'img-b', SharedSize: 400 },
      { Id: 'img-c', SharedSize: 400 },
    ],
  };
  const unusedManagedListMock = [
    { Id: 'img-a', Containers: 0, Size: 1000 },
    { Id: 'img-b', Containers: 0, Size: 1000 },
    { Id: 'img-c', Containers: 1, Size: 800 },  // in-use; filtered by Containers===0
  ];

  it('estimateManagedReclaim subtracts SharedSize per prunable image', async () => {
    mockDocker.df.mockResolvedValue(sharedLayerDfMock);
    mockDocker.listImages.mockResolvedValue(unusedManagedListMock);
    mockDocker.listContainers.mockResolvedValue([]);

    const dc = DockerController.getInstance(1);
    const result = await dc.estimateManagedReclaim('images', ['any-stack']);

    expect(result.reclaimableBytes).toBe(1200);
  });

  it('pruneManagedOnly reports the LayersSize delta as the reclaimed total', async () => {
    // df-before reports 5000 bytes on disk; df-after reports 3400. The
    // honest reclaim is 1600, independent of per-image Size/SharedSize.
    // Two prunable images that share a layer exclusively would be
    // undercounted by the per-image formula (1200) but Docker actually
    // frees the shared layer too.
    mockDocker.df
      .mockResolvedValueOnce({
        LayersSize: 5000,
        Images: [
          { Id: 'img-a', SharedSize: 400 },
          { Id: 'img-b', SharedSize: 400 },
        ],
      })
      .mockResolvedValueOnce({ LayersSize: 3400, Images: [] });
    mockDocker.listImages.mockResolvedValue([
      { Id: 'img-a', Containers: 0, Size: 1000 },
      { Id: 'img-b', Containers: 0, Size: 1000 },
    ]);
    mockDocker.listContainers.mockResolvedValue([]);
    const removeFn = vi.fn().mockResolvedValue(undefined);
    mockDocker.getImage.mockReturnValue({ remove: removeFn });

    const dc = DockerController.getInstance(1);
    const result = await dc.pruneManagedOnly('images', ['any-stack']);

    expect(result).toEqual({ success: true, reclaimedBytes: 1600 });
    expect(removeFn).toHaveBeenCalledTimes(2);
  });

  it('pruneManagedOnly falls back to per-image lower bound using before-snapshot when after-df fails', async () => {
    // Before-snapshot succeeded (SharedSize known); after-snapshot failed.
    // Fall back to Σ(Size - SharedSize) over the prunable set: a
    // conservative lower bound, but defensible because each pruned image's
    // SharedSize was known at the start.
    mockDocker.df
      .mockResolvedValueOnce({
        Images: [
          { Id: 'img-a', SharedSize: 400 },
          { Id: 'img-b', SharedSize: 400 },
        ],
      })
      .mockRejectedValueOnce(new Error('df unavailable after prune'));
    mockDocker.listImages.mockResolvedValue([
      { Id: 'img-a', Containers: 0, Size: 1000 },
      { Id: 'img-b', Containers: 0, Size: 1000 },
    ]);
    mockDocker.listContainers.mockResolvedValue([]);
    mockDocker.getImage.mockReturnValue({ remove: vi.fn().mockResolvedValue(undefined) });

    const dc = DockerController.getInstance(1);
    const result = await dc.pruneManagedOnly('images', ['any-stack']);

    // (1000 - 400) + (1000 - 400) = 1200
    expect(result).toEqual({ success: true, reclaimedBytes: 1200 });
  });

  it('pruneManagedOnly reports 0 reclaimed when both df snapshots fail', async () => {
    // Without the before-snapshot we cannot build a meaningful per-image
    // bound (after-only has stale image IDs missing from its view), so the
    // destructive path completes the removes and reports 0 rather than a
    // misleading approximation.
    mockDocker.df
      .mockRejectedValueOnce(new Error('df unavailable before'))
      .mockRejectedValueOnce(new Error('df unavailable after'));
    mockDocker.listImages.mockResolvedValue([
      { Id: 'img-a', Containers: 0, Size: 1000 },
    ]);
    mockDocker.listContainers.mockResolvedValue([]);
    const removeFn = vi.fn().mockResolvedValue(undefined);
    mockDocker.getImage.mockReturnValue({ remove: removeFn });

    const dc = DockerController.getInstance(1);
    const result = await dc.pruneManagedOnly('images', ['any-stack']);

    expect(result).toEqual({ success: true, reclaimedBytes: 0 });
    expect(removeFn).toHaveBeenCalledTimes(1);
  });

  it('estimateManagedReclaim under-reports when layers are shared exclusively between prunable images', async () => {
    // Two prunable images that share a 400-byte layer with no retained
    // image. Docker would free that layer once on prune (1600 bytes total:
    // each image's unique 600 plus the shared 400). The estimate formula
    // subtracts 400 from each image and reports 1200, a conservative
    // lower bound documented in the JSDoc.
    mockDocker.df.mockResolvedValue({
      Images: [
        { Id: 'img-a', SharedSize: 400 },
        { Id: 'img-b', SharedSize: 400 },
      ],
    });
    mockDocker.listImages.mockResolvedValue([
      { Id: 'img-a', Containers: 0, Size: 1000 },
      { Id: 'img-b', Containers: 0, Size: 1000 },
    ]);
    mockDocker.listContainers.mockResolvedValue([]);

    const dc = DockerController.getInstance(1);
    const result = await dc.estimateManagedReclaim('images', ['any-stack']);

    expect(result.reclaimableBytes).toBe(1200);
  });

  it('invariant: pruneManagedOnly reports >= estimateManagedReclaim on the same inputs', async () => {
    // The estimate is a conservative lower bound; the destructive path
    // reports the truth (df-delta). On any input, destructive >= estimate.
    // This locks the contract so future changes to either formula cannot
    // accidentally flip the direction.
    const dfBefore = {
      LayersSize: 5000,
      Images: [
        { Id: 'img-a', SharedSize: 400 },
        { Id: 'img-b', SharedSize: 400 },
      ],
    };
    const dfAfter = { LayersSize: 3400, Images: [] };
    const listImages = [
      { Id: 'img-a', Containers: 0, Size: 1000 },
      { Id: 'img-b', Containers: 0, Size: 1000 },
    ];

    // Estimate path: df called once.
    mockDocker.df.mockResolvedValueOnce(dfBefore);
    mockDocker.listImages.mockResolvedValue(listImages);
    mockDocker.listContainers.mockResolvedValue([]);
    const dc = DockerController.getInstance(1);
    const estimate = await dc.estimateManagedReclaim('images', ['any-stack']);

    // Reset the df mock for the destructive path: before then after.
    mockDocker.df.mockReset();
    mockDocker.df.mockResolvedValueOnce(dfBefore).mockResolvedValueOnce(dfAfter);
    mockDocker.getImage.mockReturnValue({ remove: vi.fn().mockResolvedValue(undefined) });
    const prune = await dc.pruneManagedOnly('images', ['any-stack']);

    expect(prune.reclaimedBytes).toBeGreaterThanOrEqual(estimate.reclaimableBytes);
  });

  it('treats images missing from the df map as having no shared layers', async () => {
    // df reports only img-a; img-b is omitted (stale / race / older daemon).
    // The accounting should still process img-b, defaulting its SharedSize to 0.
    mockDocker.df.mockResolvedValue({ Images: [{ Id: 'img-a', SharedSize: 400 }] });
    mockDocker.listImages.mockResolvedValue([
      { Id: 'img-a', Containers: 0, Size: 1000 },
      { Id: 'img-b', Containers: 0, Size: 1000 },
    ]);
    mockDocker.listContainers.mockResolvedValue([]);

    const dc = DockerController.getInstance(1);
    const result = await dc.estimateManagedReclaim('images', ['any-stack']);

    // img-a: 1000-400=600; img-b: 1000-0=1000; total 1600
    expect(result.reclaimableBytes).toBe(1600);
  });

  it('degrades to no-sharing assumption when df fails', async () => {
    // If df throws, the helper returns an empty map and the accounting falls
    // back to full per-image Size. This preserves prior behavior (over-report)
    // rather than failing the prune.
    mockDocker.df.mockRejectedValue(new Error('daemon df failed'));
    mockDocker.listImages.mockResolvedValue([
      { Id: 'img-a', Containers: 0, Size: 1000 },
      { Id: 'img-b', Containers: 0, Size: 1000 },
    ]);
    mockDocker.listContainers.mockResolvedValue([]);

    const dc = DockerController.getInstance(1);
    const result = await dc.estimateManagedReclaim('images', ['any-stack']);

    expect(result.reclaimableBytes).toBe(2000);
  });
});

// ── getOrphanContainers ────────────────────────────────────────────────

describe('DockerController - getOrphanContainers', () => {
  it('returns containers whose project label is not in known stacks', async () => {
    mockDocker.listContainers.mockResolvedValue([
      { Id: 'c1', Names: ['/c1'], State: 'running', Status: 'Up', Image: 'nginx', Labels: { 'com.docker.compose.project': 'orphan-stack' } },
      { Id: 'c2', Names: ['/c2'], State: 'running', Status: 'Up', Image: 'redis', Labels: { 'com.docker.compose.project': 'known-stack' } },
    ]);

    const dc = DockerController.getInstance(1);
    const result = await dc.getOrphanContainers(['known-stack']);

    expect(result['orphan-stack']).toHaveLength(1);
    expect(result['orphan-stack'][0].Id).toBe('c1');
    expect(result['known-stack']).toBeUndefined();
  });

  it('returns empty when all containers belong to known stacks', async () => {
    mockDocker.listContainers.mockResolvedValue([
      { Id: 'c1', Names: ['/c1'], State: 'running', Status: 'Up', Image: 'nginx', Labels: { 'com.docker.compose.project': 'my-stack' } },
    ]);

    const dc = DockerController.getInstance(1);
    const result = await dc.getOrphanContainers(['my-stack']);

    expect(Object.keys(result)).toHaveLength(0);
  });
});

// ── Docker daemon unreachable ──────────────────────────────────────────

describe('DockerController - error paths', () => {
  it('propagates connection errors from Docker daemon', async () => {
    mockDocker.listContainers.mockRejectedValue(
      new Error('connect ECONNREFUSED /var/run/docker.sock')
    );

    const dc = DockerController.getInstance(1);
    await expect(dc.getOrphanContainers(['x'])).rejects.toThrow('ECONNREFUSED');
  });

  it('propagates errors from df() call', async () => {
    mockDocker.df.mockRejectedValue(new Error('daemon not running'));

    const dc = DockerController.getInstance(1);
    await expect(dc.getDiskUsage()).rejects.toThrow('daemon not running');
  });
});

// ── inspectNetwork ────────────────────────────────────────────────────

describe('DockerController - inspectNetwork', () => {
  it('returns full network details from Docker API', async () => {
    const inspectData = {
      Id: 'abc123',
      Name: 'my-network',
      Driver: 'bridge',
      Scope: 'local',
      IPAM: { Config: [{ Subnet: '172.20.0.0/16', Gateway: '172.20.0.1' }] },
      Containers: {
        'ctr1': { Name: 'web', IPv4Address: '172.20.0.2/16', MacAddress: '02:42:ac:14:00:02' },
      },
    };
    mockDocker.getNetwork.mockReturnValue({ inspect: vi.fn().mockResolvedValue(inspectData) });

    const dc = DockerController.getInstance(1);
    const result = await dc.inspectNetwork('abc123');

    expect(result).toEqual(inspectData);
    expect(mockDocker.getNetwork).toHaveBeenCalledWith('abc123');
  });

  it('propagates errors when network not found', async () => {
    mockDocker.getNetwork.mockReturnValue({
      inspect: vi.fn().mockRejectedValue(new Error('network not found')),
    });

    const dc = DockerController.getInstance(1);
    await expect(dc.inspectNetwork('nonexistent')).rejects.toThrow('network not found');
  });
});

// ── createNetwork ─────────────────────────────────────────────────────

describe('DockerController - createNetwork', () => {
  it('creates a network with valid options', async () => {
    mockDocker.createNetwork.mockResolvedValue({ id: 'new-net-123' });

    const dc = DockerController.getInstance(1);
    const result = await dc.createNetwork({ Name: 'test-network', Driver: 'bridge' });

    expect(result).toEqual({ id: 'new-net-123' });
    expect(mockDocker.createNetwork).toHaveBeenCalledWith({ Name: 'test-network', Driver: 'bridge' });
  });

  it('rejects empty network name', async () => {
    const dc = DockerController.getInstance(1);
    await expect(dc.createNetwork({ Name: '' })).rejects.toThrow('Invalid network name');
  });

  it('rejects network name with invalid characters', async () => {
    const dc = DockerController.getInstance(1);
    await expect(dc.createNetwork({ Name: '../escape' })).rejects.toThrow('Invalid network name');
  });

  it('accepts names with hyphens, underscores, and dots', async () => {
    mockDocker.createNetwork.mockResolvedValue({ id: 'ok-123' });

    const dc = DockerController.getInstance(1);
    await dc.createNetwork({ Name: 'my-net_v2.0' });

    expect(mockDocker.createNetwork).toHaveBeenCalledWith({ Name: 'my-net_v2.0' });
  });

  it('propagates Docker daemon errors', async () => {
    mockDocker.createNetwork.mockRejectedValue(new Error('network with name test already exists'));

    const dc = DockerController.getInstance(1);
    await expect(dc.createNetwork({ Name: 'test' })).rejects.toThrow('already exists');
  });

  it('rejects names starting with a dot', async () => {
    const dc = DockerController.getInstance(1);
    await expect(dc.createNetwork({ Name: '.hidden' })).rejects.toThrow('Invalid network name');
  });

  it('rejects names starting with a hyphen', async () => {
    const dc = DockerController.getInstance(1);
    await expect(dc.createNetwork({ Name: '-leading-dash' })).rejects.toThrow('Invalid network name');
  });

  it('rejects names with spaces', async () => {
    const dc = DockerController.getInstance(1);
    await expect(dc.createNetwork({ Name: 'has spaces' })).rejects.toThrow('Invalid network name');
  });

  it('rejects names with slashes (path traversal)', async () => {
    const dc = DockerController.getInstance(1);
    await expect(dc.createNetwork({ Name: 'foo/bar' })).rejects.toThrow('Invalid network name');
  });

  it('passes IPAM config through to Docker', async () => {
    mockDocker.createNetwork.mockResolvedValue({ id: 'ipam-net' });

    const dc = DockerController.getInstance(1);
    const options = {
      Name: 'ipam-test',
      Driver: 'bridge' as const,
      IPAM: { Config: [{ Subnet: '10.0.0.0/24', Gateway: '10.0.0.1' }] },
      Internal: true,
      Attachable: true,
    };
    await dc.createNetwork(options);

    expect(mockDocker.createNetwork).toHaveBeenCalledWith(options);
  });

  it('passes labels through to Docker', async () => {
    mockDocker.createNetwork.mockResolvedValue({ id: 'labeled-net' });

    const dc = DockerController.getInstance(1);
    const options = {
      Name: 'labeled',
      Labels: { env: 'test', team: 'infra' },
    };
    await dc.createNetwork(options);

    expect(mockDocker.createNetwork).toHaveBeenCalledWith(options);
  });

  it('accepts single-character name', async () => {
    mockDocker.createNetwork.mockResolvedValue({ id: 'single' });

    const dc = DockerController.getInstance(1);
    await dc.createNetwork({ Name: 'a' });

    expect(mockDocker.createNetwork).toHaveBeenCalledWith({ Name: 'a' });
  });
});

// ── inspectNetwork edge cases ─────────────────────────────────────────

describe('DockerController - inspectNetwork edge cases', () => {
  it('returns network with empty containers map', async () => {
    const inspectData = {
      Id: 'empty-net',
      Name: 'isolated',
      Driver: 'bridge',
      Containers: {},
    };
    mockDocker.getNetwork.mockReturnValue({ inspect: vi.fn().mockResolvedValue(inspectData) });

    const dc = DockerController.getInstance(1);
    const result = await dc.inspectNetwork('empty-net');

    expect(result.Containers).toEqual({});
  });

  it('returns network with multiple containers', async () => {
    const inspectData = {
      Id: 'multi-net',
      Name: 'busy-network',
      Driver: 'bridge',
      Containers: {
        'c1': { Name: 'web', IPv4Address: '172.20.0.2/16' },
        'c2': { Name: 'db', IPv4Address: '172.20.0.3/16' },
        'c3': { Name: 'cache', IPv4Address: '172.20.0.4/16' },
      },
    };
    mockDocker.getNetwork.mockReturnValue({ inspect: vi.fn().mockResolvedValue(inspectData) });

    const dc = DockerController.getInstance(1);
    const result = await dc.inspectNetwork('multi-net');

    expect(Object.keys(result.Containers ?? {})).toHaveLength(3);
  });

  it('propagates Docker daemon connection errors', async () => {
    mockDocker.getNetwork.mockReturnValue({
      inspect: vi.fn().mockRejectedValue(new Error('Cannot connect to Docker daemon')),
    });

    const dc = DockerController.getInstance(1);
    await expect(dc.inspectNetwork('any-id')).rejects.toThrow('Cannot connect to Docker daemon');
  });
});

// --- inspectImage --------------------------------------------------------------

describe('DockerController - inspectImage', () => {
  it('returns combined inspect + history payload', async () => {
    const inspectData = {
      Id: 'sha256:abc12345',
      RepoTags: ['nginx:1.27'],
      Size: 187_000_000,
      Architecture: 'amd64',
      Os: 'linux',
      Config: { Cmd: ['nginx', '-g', 'daemon off;'] },
    };
    const historyData = [
      { Id: 'layer1', Created: 1700000000, CreatedBy: '/bin/sh -c #(nop) ADD file:abc', Size: 72_000_000, Tags: null, Comment: '' },
      { Id: 'layer2', Created: 1700000010, CreatedBy: 'ENV NGINX_VERSION=1.27', Size: 0, Tags: null, Comment: '' },
    ];
    mockDocker.getImage.mockReturnValue({
      inspect: vi.fn().mockResolvedValue(inspectData),
      history: vi.fn().mockResolvedValue(historyData),
    });

    const dc = DockerController.getInstance(1);
    const result = await dc.inspectImage('sha256:abc12345');

    expect(result.inspect).toEqual(inspectData);
    expect(result.history).toEqual(historyData);
    expect(mockDocker.getImage).toHaveBeenCalledWith('sha256:abc12345');
  });

  it('propagates 404 from Dockerode when image is missing', async () => {
    mockDocker.getImage.mockReturnValue({
      inspect: vi.fn().mockRejectedValue(Object.assign(new Error('No such image: missing'), { statusCode: 404 })),
      history: vi.fn().mockResolvedValue([]),
    });

    const dc = DockerController.getInstance(1);
    await expect(dc.inspectImage('missing')).rejects.toThrow('No such image');
  });

  it('returns empty history when an image has none', async () => {
    mockDocker.getImage.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({ Id: 'sha256:empty', Size: 0 }),
      history: vi.fn().mockResolvedValue([]),
    });

    const dc = DockerController.getInstance(1);
    const result = await dc.inspectImage('sha256:empty');

    expect(result.history).toEqual([]);
    expect(result.inspect.Id).toBe('sha256:empty');
  });
});

// --- createNetwork validation --------------------------------------------------

describe('createNetwork', () => {
  it('rejects empty network name', async () => {
    const dc = DockerController.getInstance(1);
    await expect(dc.createNetwork({ Name: '' })).rejects.toThrow('Invalid network name');
  });

  it('rejects names with invalid characters', async () => {
    const dc = DockerController.getInstance(1);
    await expect(dc.createNetwork({ Name: 'net work' })).rejects.toThrow('Invalid network name');
    await expect(dc.createNetwork({ Name: '../escape' })).rejects.toThrow('Invalid network name');
    await expect(dc.createNetwork({ Name: 'net;rm' })).rejects.toThrow('Invalid network name');
  });

  it('accepts valid network names and passes through to Docker', async () => {
    mockDocker.createNetwork.mockResolvedValue({ id: 'new-net-id' });
    const dc = DockerController.getInstance(1);
    const result = await dc.createNetwork({ Name: 'my-network_v2' });
    expect(result.id).toBe('new-net-id');
    expect(mockDocker.createNetwork).toHaveBeenCalledWith({ Name: 'my-network_v2' });
  });
});

// --- removeContainers mixed results -------------------------------------------

describe('removeContainers', () => {
  it('returns mixed results when some removals fail', async () => {
    mockDocker.getContainer.mockImplementation((id: string) => {
      if (id === 'fail-id') {
        return { remove: vi.fn().mockRejectedValue(new Error('no such container')) };
      }
      return { remove: vi.fn().mockResolvedValue(undefined) };
    });

    const dc = DockerController.getInstance(1);
    const results = await dc.removeContainers(['ok-id-000000', 'fail-id']);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ id: 'ok-id-000000', success: true });
    expect(results[1]).toMatchObject({ id: 'fail-id', success: false });
  });

  it('returns empty array for empty input', async () => {
    const dc = DockerController.getInstance(1);
    const results = await dc.removeContainers([]);
    expect(results).toEqual([]);
  });
});

// ── Network connect / disconnect helpers ───────────────────────────────

describe('DockerController - connectContainerToNetwork', () => {
  it('attaches a container to a network with no static IP', async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    mockDocker.getNetwork.mockReturnValue({ connect });

    const dc = DockerController.getInstance(1);
    await dc.connectContainerToNetwork('sencho_mesh', 'sencho-host-1234');

    expect(mockDocker.getNetwork).toHaveBeenCalledWith('sencho_mesh');
    expect(connect).toHaveBeenCalledWith({ Container: 'sencho-host-1234' });
  });

  it('attaches with a static IPv4 address when provided', async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    mockDocker.getNetwork.mockReturnValue({ connect });

    const dc = DockerController.getInstance(1);
    await dc.connectContainerToNetwork('sencho_mesh', 'sencho-host-1234', { ipv4Address: '172.30.0.2' });

    expect(connect).toHaveBeenCalledWith({
      Container: 'sencho-host-1234',
      EndpointConfig: { IPAMConfig: { IPv4Address: '172.30.0.2' } },
    });
  });

  it('treats 403 already-connected as success (idempotent)', async () => {
    const connect = vi.fn().mockRejectedValue({ statusCode: 403, message: 'endpoint already exists' });
    mockDocker.getNetwork.mockReturnValue({ connect });

    const dc = DockerController.getInstance(1);
    await expect(dc.connectContainerToNetwork('sencho_mesh', 'sencho-host-1234')).resolves.toBeUndefined();
  });

  it('rethrows non-idempotent errors', async () => {
    const connect = vi.fn().mockRejectedValue({ statusCode: 500, message: 'server error' });
    mockDocker.getNetwork.mockReturnValue({ connect });

    const dc = DockerController.getInstance(1);
    await expect(dc.connectContainerToNetwork('sencho_mesh', 'sencho-host-1234')).rejects.toMatchObject({
      statusCode: 500,
    });
  });

  it('rethrows a 403 whose message is unrelated to already-attached', async () => {
    const connect = vi.fn().mockRejectedValue({ statusCode: 403, message: 'host-mode container cannot join network' });
    mockDocker.getNetwork.mockReturnValue({ connect });

    const dc = DockerController.getInstance(1);
    await expect(dc.connectContainerToNetwork('sencho_mesh', 'sencho-host-1234')).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});

describe('DockerController - disconnectContainerFromNetwork', () => {
  it('detaches a container from a network with force=true', async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined);
    mockDocker.getNetwork.mockReturnValue({ disconnect });

    const dc = DockerController.getInstance(1);
    await dc.disconnectContainerFromNetwork('sencho_mesh', 'sencho-host-1234');

    expect(mockDocker.getNetwork).toHaveBeenCalledWith('sencho_mesh');
    expect(disconnect).toHaveBeenCalledWith({ Container: 'sencho-host-1234', Force: true });
  });

  it('treats 404 not-connected as success (idempotent)', async () => {
    const disconnect = vi.fn().mockRejectedValue({ statusCode: 404, message: 'no such network endpoint' });
    mockDocker.getNetwork.mockReturnValue({ disconnect });

    const dc = DockerController.getInstance(1);
    await expect(dc.disconnectContainerFromNetwork('sencho_mesh', 'sencho-host-1234')).resolves.toBeUndefined();
  });

  it('rethrows non-idempotent errors', async () => {
    const disconnect = vi.fn().mockRejectedValue({ statusCode: 500, message: 'server error' });
    mockDocker.getNetwork.mockReturnValue({ disconnect });

    const dc = DockerController.getInstance(1);
    await expect(dc.disconnectContainerFromNetwork('sencho_mesh', 'sencho-host-1234')).rejects.toMatchObject({
      statusCode: 500,
    });
  });
});

// ── getDependencySnapshot ──────────────────────────────────────────────

describe('DockerController - getDependencySnapshot', () => {
  beforeEach(() => {
    // resolveProjectNameMap caches under a constant key; clear it so each test
    // resolves stack ownership from its own mocked compose set.
    CacheService.getInstance().invalidate('project-name-map');
  });

  it('maps service identity, networks, volume mounts, and published ports', async () => {
    mockDocker.listContainers.mockResolvedValue([
      {
        Id: 'abc123def456',
        Names: ['/web-1'],
        Image: 'nginx:alpine',
        State: 'running',
        Labels: { 'com.docker.compose.project': 'web', 'com.docker.compose.service': 'api' },
        NetworkSettings: { Networks: { web_frontend: { NetworkID: 'net1', IPAddress: '172.18.0.2' } } },
        Mounts: [
          { Type: 'volume', Name: 'web_data', Destination: '/data' },
          { Type: 'bind', Source: '/host/path', Destination: '/app' },
        ],
        Ports: [
          { IP: '0.0.0.0', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' },
          { PrivatePort: 9090, Type: 'tcp' },
        ],
      },
    ]);
    mockDocker.listNetworks.mockResolvedValue([
      { Id: 'b', Name: 'bridge' },
      { Id: 'net1', Name: 'web_frontend', Driver: 'bridge', Scope: 'local', Labels: { 'com.docker.compose.project': 'web' } },
    ]);
    mockDocker.listVolumes.mockResolvedValue({ Volumes: [{ Name: 'web_data', Driver: 'local', Labels: { 'com.docker.compose.project': 'web' } }] });

    const dc = DockerController.getInstance(1);
    const snap = await dc.getDependencySnapshot(['web']);

    const c = snap.containers[0];
    expect(c.service).toBe('api');
    expect(c.stack).toBe('web');
    expect(c.networks).toEqual([{ name: 'web_frontend', id: 'net1', ip: '172.18.0.2' }]);
    expect(c.volumes).toEqual(['web_data']); // bind mount dropped
    expect(c.ports).toEqual([{ ip: '0.0.0.0', publishedPort: 8080, privatePort: 80, protocol: 'tcp' }]); // unpublished 9090 dropped

    expect(snap.networks.find((n) => n.name === 'bridge')?.isSystem).toBe(true);
    const frontend = snap.networks.find((n) => n.name === 'web_frontend');
    expect(frontend?.isSystem).toBe(false);
    expect(frontend?.stack).toBe('web');

    expect(snap.volumes[0]).toMatchObject({ name: 'web_data', stack: 'web', composeProject: 'web' });
  });

  it('classifies a non-compose container as having no service or stack', async () => {
    mockDocker.listContainers.mockResolvedValue([
      { Id: 'x', Names: ['/manual'], Image: 'redis', State: 'running', Labels: {}, NetworkSettings: { Networks: {} }, Mounts: [], Ports: [] },
    ]);
    mockDocker.listNetworks.mockResolvedValue([]);
    mockDocker.listVolumes.mockResolvedValue({ Volumes: [] });

    const dc = DockerController.getInstance(1);
    const snap = await dc.getDependencySnapshot([]);
    expect(snap.containers[0].service).toBeNull();
    expect(snap.containers[0].stack).toBeNull();
    expect(snap.containers[0].composeProject).toBeNull();
  });
});
