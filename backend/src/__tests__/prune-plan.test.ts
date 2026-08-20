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
      { target: 'images', id: 'img-b', image: { references: ['app:1'] } },
      { target: 'volumes', id: 'vol-a' },
    ]);
    const b = fingerprintPrunePlan(1, 'managed', ['volumes', 'images'], [
      { target: 'volumes', id: 'vol-a' },
      { target: 'images', id: 'img-b', image: { references: ['app:1'] } },
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

  it('changes when an image gains or loses RepoTags without changing the image id', () => {
    const sameId = 'sha256:abc';
    const before = fingerprintPrunePlan(1, 'managed', ['images'], [
      { target: 'images', id: sameId, image: { references: ['app:v0'] } },
    ]);
    const afterAddTag = fingerprintPrunePlan(1, 'managed', ['images'], [
      { target: 'images', id: sameId, image: { references: ['app:v0', 'extra:v0'] } },
    ]);
    const afterReorder = fingerprintPrunePlan(1, 'managed', ['images'], [
      { target: 'images', id: sameId, image: { references: ['extra:v0', 'app:v0'] } },
    ]);
    expect(afterAddTag).not.toBe(before);
    expect(afterReorder).toBe(afterAddTag);
  });

  it('changes when the image digest differs for the same id and tags', () => {
    const base = fingerprintPrunePlan(1, 'managed', ['images'], [
      { target: 'images', id: 'img1', image: { references: ['app:1'], digest: 'd1' } },
    ]);
    const other = fingerprintPrunePlan(1, 'managed', ['images'], [
      { target: 'images', id: 'img1', image: { references: ['app:1'], digest: 'd2' } },
    ]);
    expect(other).not.toBe(base);
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
  it('projects target metadata and only safe ownership labels in all scope', async () => {
    mockDocker.listImages.mockResolvedValue([{
      Id: 'sha256:dangling',
      RepoTags: ['<none>:<none>'],
      RepoDigests: ['example/app@sha256:digest'],
      Created: 1_700_000_000,
      Size: 100,
      Containers: 0,
      Labels: { 'com.docker.compose.project': 'my-stack', secret: 'do-not-return' },
    }]);
    mockDocker.listVolumes.mockResolvedValue({ Volumes: [{
      Name: 'my-stack_data',
      Driver: 'local',
      Labels: { 'com.docker.compose.project': 'my-stack', secret: 'do-not-return' },
    }] });
    mockDocker.listNetworks.mockResolvedValue([{
      Id: 'network-id',
      Name: 'my-stack_default',
      Driver: 'bridge',
      Scope: 'local',
      Labels: {
        'com.docker.compose.project': 'my-stack',
        'com.docker.compose.network': 'default',
        secret: 'do-not-return',
      },
    }]);
    mockDocker.getNetwork.mockReturnValue({ inspect: vi.fn().mockResolvedValue({ Containers: {} }) });
    mockDocker.df.mockResolvedValue({
      Volumes: [{ Name: 'my-stack_data', UsageData: { RefCount: 0, Size: 42 } }],
      Images: [{ Id: 'sha256:dangling', SharedSize: 10 }],
      LayersSize: 0,
    });

    const plan = await DockerController.getInstance(1).buildPrunePlan(
      ['images', 'volumes', 'networks'], 'all', ['my-stack'], 1,
    );

    expect(plan.items.find((entry) => entry.target === 'images')).toMatchObject({
      name: '<none>:<none>',
      managed: true,
      stackName: 'my-stack',
      image: {
        references: [],
        digest: 'example/app@sha256:digest',
        createdAt: 1_700_000_000,
      },
    });
    expect(plan.items.find((entry) => entry.target === 'volumes')).toMatchObject({
      managed: true,
      stackName: 'my-stack',
      volume: {
        driver: 'local',
        ownershipLabels: { 'com.docker.compose.project': 'my-stack' },
      },
    });
    expect(plan.items.find((entry) => entry.target === 'networks')).toMatchObject({
      managed: true,
      stackName: 'my-stack',
      network: {
        driver: 'bridge',
        scope: 'local',
        ownershipLabels: {
          'com.docker.compose.project': 'my-stack',
          'com.docker.compose.network': 'default',
        },
      },
    });
    expect(JSON.stringify(plan.items)).not.toContain('do-not-return');
    expect(plan.reclaimableBytes).toBe(
      plan.items.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0),
    );
  });

  it('uses Compose path ownership fallbacks for non-container resources', async () => {
    const ownershipLabels = {
      'com.docker.compose.project.working_dir': '/app/compose/my-stack',
      'com.docker.compose.project.config_files': '/app/compose/my-stack/compose.yml',
    };
    mockDocker.listImages.mockResolvedValue([{
      Id: 'sha256:path-owned', RepoTags: ['example/path:latest'], Size: 100, Containers: 0, Labels: ownershipLabels,
    }]);
    mockDocker.listVolumes.mockResolvedValue({ Volumes: [{ Name: 'path_data', Labels: ownershipLabels }] });
    mockDocker.listNetworks.mockResolvedValue([{ Id: 'path-network', Name: 'path_default', Labels: ownershipLabels }]);
    mockDocker.getNetwork.mockReturnValue({ inspect: vi.fn().mockResolvedValue({ Containers: {} }) });
    mockDocker.df.mockResolvedValue({
      Volumes: [{ Name: 'path_data', UsageData: { RefCount: 0, Size: 42 } }],
      Images: [{ Id: 'sha256:path-owned', SharedSize: 0 }],
      LayersSize: 0,
    });

    const plan = await DockerController.getInstance(1).buildPrunePlan(
      ['images', 'volumes', 'networks'], 'managed', ['my-stack'], 1,
    );

    expect(plan.items).toHaveLength(3);
    expect(plan.items.every((entry) => entry.managed && entry.stackName === 'my-stack')).toBe(true);
  });

  it.each(['__proto__', 'constructor', 'toString', 'prototype'])(
    'does not attribute inherited project key %s to a managed stack',
    async (project) => {
      const labels = { 'com.docker.compose.project': project };
      mockDocker.listVolumes.mockResolvedValue({ Volumes: [{ Name: `${project}_data`, Labels: labels }] });
      mockDocker.df.mockResolvedValue({
        Volumes: [{ Name: `${project}_data`, UsageData: { RefCount: 0, Size: 42 } }],
        Images: [],
        LayersSize: 0,
      });

      const managedPlan = await DockerController.getInstance(1).buildPrunePlan(
        ['volumes'], 'managed', ['my-stack'], 1,
      );
      const allPlan = await DockerController.getInstance(1).buildPrunePlan(
        ['volumes'], 'all', ['my-stack'], 1,
      );

      expect(managedPlan.items).toEqual([]);
      expect(allPlan.items).toEqual([
        expect.objectContaining({ id: `${project}_data`, managed: false }),
      ]);
      expect(allPlan.items[0].stackName).toBeUndefined();
    },
  );

  it('does not plan an image referenced by a container when Docker reports Containers as unknown', async () => {
    mockDocker.listContainers.mockResolvedValue([{ Id: 'container', ImageID: 'sha256:in-use' }]);
    mockDocker.listImages.mockResolvedValue([{
      Id: 'sha256:in-use', RepoTags: ['example/in-use:latest'], Size: 100, Containers: -1,
    }]);
    mockDocker.df.mockResolvedValue({
      Volumes: [], Images: [{ Id: 'sha256:in-use', SharedSize: 0 }], LayersSize: 0,
    });

    const plan = await DockerController.getInstance(1).buildPrunePlan(['images'], 'all', [], 1);
    expect(plan.items).toEqual([]);
  });

  it('preserves Compose path ownership fallback during volume and network execution', async () => {
    const labels = { 'com.docker.compose.project.working_dir': '/app/compose/my-stack' };
    const volumeRemove = vi.fn().mockResolvedValue(undefined);
    const networkRemove = vi.fn().mockResolvedValue(undefined);
    const networkInspect = vi.fn().mockResolvedValue({ Name: 'path_default', Labels: labels, Containers: {} });
    mockDocker.listVolumes.mockResolvedValue({ Volumes: [{ Name: 'path_data', Labels: labels }] });
    mockDocker.listNetworks.mockResolvedValue([{ Id: 'path-network', Name: 'path_default', Labels: labels }]);
    mockDocker.df.mockResolvedValue({
      Volumes: [{ Name: 'path_data', UsageData: { RefCount: 0, Size: 42 } }], Images: [], LayersSize: 0,
    });
    mockDocker.getVolume.mockReturnValue({ remove: volumeRemove });
    mockDocker.getNetwork.mockReturnValue({ inspect: networkInspect, remove: networkRemove });

    const controller = DockerController.getInstance(1);
    const plan = await controller.buildPrunePlan(['volumes', 'networks'], 'managed', ['my-stack'], 1);
    const result = await controller.executePrunePlan(plan, ['my-stack']);

    expect(result.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: 'volumes', status: 'removed' }),
      expect.objectContaining({ target: 'networks', status: 'removed' }),
    ]));
    expect(volumeRemove).toHaveBeenCalledWith({ force: false });
    expect(networkRemove).toHaveBeenCalled();
  });

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

  it('includes labeled free images under managed and excludes foreign repos without attribution', async () => {
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

  it('includes previous free tags of a repo still used by a managed container', async () => {
    mockDocker.listContainers.mockResolvedValue([
      {
        Id: 'c-run',
        Names: ['/web'],
        State: 'running',
        Image: 'myapp:1.1',
        ImageID: 'img-current',
        Labels: { 'com.docker.compose.project': 'my-stack' },
      },
    ]);
    mockDocker.listImages.mockResolvedValue([
      { Id: 'img-current', RepoTags: ['myapp:1.1'], Size: 200, Containers: 1 },
      { Id: 'img-old', RepoTags: ['myapp:1.0'], Size: 180, Containers: 0 },
    ]);

    const dc = DockerController.getInstance(1);
    const plan = await dc.buildPrunePlan(['images'], 'managed', ['my-stack'], 1);

    expect(plan.items).toEqual([
      expect.objectContaining({
        id: 'img-old',
        managed: true,
        reason: 'Unused image whose repository is used by a Sencho stack',
      }),
    ]);
    // Repository sharing is not ownership: confirm surface must not name a stack.
    expect(plan.items[0]?.stackName).toBeUndefined();
  });

  it('attributes stackName for label-owned free images but not for repo-matched free tags', async () => {
    mockDocker.listContainers.mockResolvedValue([
      {
        Id: 'c-run',
        Names: ['/web'],
        State: 'running',
        Image: 'myapp:1.1',
        ImageID: 'img-current',
        Labels: { 'com.docker.compose.project': 'my-stack' },
      },
    ]);
    mockDocker.listImages.mockResolvedValue([
      { Id: 'img-current', RepoTags: ['myapp:1.1'], Size: 200, Containers: 1 },
      { Id: 'img-old', RepoTags: ['myapp:1.0'], Size: 180, Containers: 0 },
      {
        Id: 'img-labeled',
        RepoTags: ['other:1'],
        Size: 50,
        Containers: 0,
        Labels: { 'com.docker.compose.project': 'my-stack' },
      },
    ]);

    const dc = DockerController.getInstance(1);
    const plan = await dc.buildPrunePlan(['images'], 'managed', ['my-stack'], 1);
    const byId = Object.fromEntries(plan.items.map((item) => [item.id, item]));

    expect(byId['img-old']).toEqual(
      expect.objectContaining({
        reason: 'Unused image whose repository is used by a Sencho stack',
      }),
    );
    expect(byId['img-old']?.stackName).toBeUndefined();
    expect(byId['img-labeled']).toEqual(
      expect.objectContaining({
        managed: true,
        stackName: 'my-stack',
      }),
    );
  });

  it('excludes a foreign Compose project image even when its repo matches a managed stack', async () => {
    mockDocker.listContainers.mockResolvedValue([
      {
        Id: 'c-run',
        Names: ['/web'],
        State: 'running',
        Image: 'nginx:1.27',
        ImageID: 'img-current',
        Labels: { 'com.docker.compose.project': 'my-stack' },
      },
    ]);
    mockDocker.listImages.mockResolvedValue([
      { Id: 'img-current', RepoTags: ['nginx:1.27'], Size: 200, Containers: 1 },
      {
        Id: 'img-foreign',
        RepoTags: ['nginx:1.24'],
        Size: 180,
        Containers: 0,
        Labels: { 'com.docker.compose.project': 'other-project' },
      },
    ]);

    const dc = DockerController.getInstance(1);
    const managedPlan = await dc.buildPrunePlan(['images'], 'managed', ['my-stack'], 1);
    const allPlan = await dc.buildPrunePlan(['images'], 'all', ['my-stack'], 1);

    expect(managedPlan.items.map((i) => i.id)).toEqual([]);
    expect(allPlan.items.map((i) => i.id)).toContain('img-foreign');
  });

  it('excludes untagged dangling images from managed scope and includes them under all', async () => {
    mockDocker.listContainers.mockResolvedValue([
      {
        Id: 'c-run',
        Names: ['/web'],
        State: 'running',
        Image: 'myapp:1.1',
        ImageID: 'img-current',
        Labels: { 'com.docker.compose.project': 'my-stack' },
      },
    ]);
    mockDocker.listImages.mockResolvedValue([
      { Id: 'img-current', RepoTags: ['myapp:1.1'], Size: 200, Containers: 1 },
      { Id: 'img-dangling', RepoTags: null, Size: 90, Containers: 0 },
      { Id: 'img-none', RepoTags: ['<none>:<none>'], Size: 80, Containers: 0 },
    ]);

    const dc = DockerController.getInstance(1);
    const managedPlan = await dc.buildPrunePlan(['images'], 'managed', ['my-stack'], 1);
    const allPlan = await dc.buildPrunePlan(['images'], 'all', ['my-stack'], 1);

    expect(managedPlan.items.map((i) => i.id)).toEqual([]);
    expect(allPlan.items.map((i) => i.id).sort()).toEqual(['img-dangling', 'img-none']);
  });

  it('includes a becomesFree image under managed with the free-after-containers reason', async () => {
    mockDocker.listContainers.mockResolvedValue([
      {
        Id: 'c-exited',
        Names: ['/exited'],
        State: 'exited',
        ImageID: 'img-only',
        Labels: { 'com.docker.compose.project': 'my-stack' },
      },
    ]);
    mockDocker.listImages.mockResolvedValue([
      { Id: 'img-only', RepoTags: ['scratch:old'], Size: 50, Containers: 1 },
    ]);

    const dc = DockerController.getInstance(1);
    const plan = await dc.buildPrunePlan(['containers', 'images'], 'managed', ['my-stack'], 1);

    expect(plan.items.some((i) => i.target === 'containers' && i.id === 'c-exited')).toBe(true);
    expect(plan.items.find((i) => i.target === 'images' && i.id === 'img-only')).toEqual(
      expect.objectContaining({
        reason: 'Image becomes unused after planned container removal',
        managed: true,
      }),
    );
  });

  it('excludes a becomesFree image labeled for a foreign Compose project under managed', async () => {
    mockDocker.listContainers.mockResolvedValue([
      {
        Id: 'c-exited',
        Names: ['/exited'],
        State: 'exited',
        ImageID: 'img-foreign',
        Labels: { 'com.docker.compose.project': 'my-stack' },
      },
    ]);
    mockDocker.listImages.mockResolvedValue([
      {
        Id: 'img-foreign',
        RepoTags: ['shared:1'],
        Size: 50,
        Containers: 1,
        Labels: { 'com.docker.compose.project': 'other-project' },
      },
    ]);

    const dc = DockerController.getInstance(1);
    const plan = await dc.buildPrunePlan(['containers', 'images'], 'managed', ['my-stack'], 1);

    expect(plan.items.some((i) => i.target === 'containers')).toBe(true);
    expect(plan.items.some((i) => i.target === 'images' && i.id === 'img-foreign')).toBe(false);
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

  it('attributes via listed image RepoTags when the managed container Image is a bare digest', async () => {
    mockDocker.listContainers.mockResolvedValue([
      {
        Id: 'c-run',
        Names: ['/web'],
        State: 'running',
        Image: 'sha256:' + 'a'.repeat(64),
        ImageID: 'img-current',
        Labels: { 'com.docker.compose.project': 'my-stack' },
      },
    ]);
    mockDocker.listImages.mockResolvedValue([
      { Id: 'img-current', RepoTags: ['ghcr.io/acme/api:v2'], Size: 200, Containers: 1 },
      { Id: 'img-old', RepoTags: ['ghcr.io/acme/api:v1'], Size: 180, Containers: 0 },
    ]);

    const dc = DockerController.getInstance(1);
    const plan = await dc.buildPrunePlan(['images'], 'managed', ['my-stack'], 1);

    expect(plan.items.map((i) => i.id)).toEqual(['img-old']);
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

  it('excludes an image held for a pending service-update recovery from the plan', async () => {
    mockDocker.listImages.mockResolvedValue([
      { Id: 'img-held', RepoTags: ['app:1'], Size: 100, Containers: 0 },
      { Id: 'img-free', RepoTags: ['app:2'], Size: 100, Containers: 0 },
    ]);

    const dc = DockerController.getInstance(1);
    const plan = await dc.buildPrunePlan(['images'], 'all', [], 1, (id) => id === 'img-held');

    expect(plan.items.map((i) => i.id)).toEqual(['img-free']);
  });

  it('excludes a fully synthetic sencho-rb hold image from the plan even without a DB hold', async () => {
    mockDocker.listImages.mockResolvedValue([
      {
        Id: 'img-orphan-hold',
        RepoTags: ['sencho-rb/abc123456789/web:hold', 'sencho-rb/abc123456789/api:hold'],
        Size: 50,
        Containers: 0,
      },
      { Id: 'img-free', RepoTags: ['app:2'], Size: 100, Containers: 0 },
    ]);

    const dc = DockerController.getInstance(1);
    const plan = await dc.buildPrunePlan(['images'], 'all', [], 1, () => false);

    expect(plan.items.map((i) => i.id)).toEqual(['img-free']);
  });

  it('still plans a dual-tagged image that carries a registry tag and a sencho-rb hold tag', async () => {
    mockDocker.listImages.mockResolvedValue([
      {
        Id: 'img-dual',
        RepoTags: ['myregistry/app:1.4', 'sencho-rb/abc123456789/app:hold'],
        Size: 100,
        Containers: 0,
      },
    ]);

    const dc = DockerController.getInstance(1);
    const plan = await dc.buildPrunePlan(['images'], 'all', [], 1);

    expect(plan.items.map((i) => i.id)).toEqual(['img-dual']);
    expect(plan.items[0]?.image?.references).toEqual([
      'myregistry/app:1.4',
      'sencho-rb/abc123456789/app:hold',
    ]);
  });
});

describe('DockerController.executePrunePlan', () => {
  const multiTagImage = {
    Id: 'img-multi',
    RepoTags: ['qa1769/app:v0', 'qa1769-external/keep:v0'],
    Size: 50,
    Containers: 0,
  };

  function mockImageRemove(
    onRemove?: (name: string, opts?: { force?: boolean }) => void | Promise<void>,
  ): Array<{ name: string; force?: boolean }> {
    const removes: Array<{ name: string; force?: boolean }> = [];
    mockDocker.getImage.mockImplementation((name: string) => ({
      remove: vi.fn().mockImplementation(async (opts?: { force?: boolean }) => {
        removes.push({ name, force: opts?.force });
        await onRemove?.(name, opts);
      }),
    }));
    return removes;
  }

  async function executeForcedFreshImagePlan(listings: Array<unknown[] | Error>) {
    for (const listing of listings) {
      if (listing instanceof Error) mockDocker.listImages.mockRejectedValueOnce(listing);
      else mockDocker.listImages.mockResolvedValueOnce(listing);
    }
    const dc = DockerController.getInstance(1);
    const plan = await dc.buildPrunePlan(['images'], 'all', [], 1);
    vi.spyOn(dc, 'assertPlanFresh').mockResolvedValue(plan);
    return dc.executePrunePlan(plan, []);
  }

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

  it('re-checks isImageHeld immediately before deleting, skipping a hold that started after the plan was built', async () => {
    mockDocker.listImages.mockResolvedValue([
      { Id: 'img1', RepoTags: ['app:latest'], Size: 1000, Containers: 0 },
    ]);
    const imageRemove = vi.fn().mockResolvedValue(undefined);
    mockDocker.getImage.mockReturnValue({ remove: imageRemove });

    const dc = DockerController.getInstance(1);
    const plan = await dc.buildPrunePlan(['images'], 'all', [], 1);
    expect(plan.items.map((i) => i.id)).toEqual(['img1']);

    // Bypass the rebuild-based staleness check so this isolates the
    // immediate per-item recheck (prune holds), simulating a
    // recovery snapshot created after the plan was built but before execute.
    vi.spyOn(dc, 'assertPlanFresh').mockResolvedValue(plan);
    const result = await dc.executePrunePlan(plan, [], (id) => id === 'img1');

    expect(imageRemove).not.toHaveBeenCalled();
    expect(result.outcomes).toEqual([
      expect.objectContaining({ id: 'img1', target: 'images', status: 'skipped', reason: expect.stringMatching(/held/i) }),
    ]);
  });

  it('skips a fully synthetic hold image even under a forced-fresh plan', async () => {
    const holdImg = {
      Id: 'img-orphan-hold',
      RepoTags: ['sencho-rb/abc123456789/web:hold', 'sencho-rb/abc123456789/api:hold'],
      Size: 50,
      Containers: 0,
    };
    mockDocker.listImages.mockResolvedValue([holdImg]);
    const removes = mockImageRemove();

    const dc = DockerController.getInstance(1);
    const plan = {
      scope: 'all' as const,
      targets: ['images' as const],
      items: [{
        target: 'images' as const,
        id: holdImg.Id,
        name: holdImg.RepoTags[0],
        sizeBytes: 50,
        managed: false,
        reason: 'Image is not used by any container',
        image: { references: holdImg.RepoTags },
      }],
      reclaimableBytes: 50,
      fingerprint: 'forced-hold',
      createdAt: Date.now(),
      nodeId: 1,
    };
    vi.spyOn(dc, 'assertPlanFresh').mockResolvedValue(plan);
    const result = await dc.executePrunePlan(plan, []);

    expect(removes).toEqual([]);
    expect(result.mutated).toBe(false);
    expect(result.outcomes).toEqual([
      expect.objectContaining({
        id: holdImg.Id,
        target: 'images',
        status: 'skipped',
        reason: 'Sencho rollback-hold image',
      }),
    ]);
  });

  it('marks the plan stale when a free image gains a new RepoTag between plan and rebuild', async () => {
    const img = {
      Id: 'img-retag',
      RepoTags: ['qa1769/app:v0'],
      Size: 100,
      Containers: 0,
    };
    mockDocker.listImages.mockResolvedValue([img]);
    mockDocker.listContainers.mockResolvedValue([]);

    const dc = DockerController.getInstance(1);
    const plan = await dc.buildPrunePlan(['images'], 'all', [], 1);
    expect(plan.items).toHaveLength(1);

    mockDocker.listImages.mockResolvedValue([{
      ...img,
      RepoTags: ['qa1769/app:v0', 'qa1769-external/keep:v0'],
    }]);
    await expect(dc.assertPlanFresh(plan, [])).resolves.toBeNull();
    await expect(dc.executePrunePlan(plan, [])).rejects.toBeInstanceOf(PrunePlanStaleError);
  });

  it('refuses image remove and does not call Docker delete when tags differ under a forced-fresh plan', async () => {
    mockDocker.listImages.mockResolvedValue([
      { Id: 'img-multi', RepoTags: ['qa1769/app:v0'], Size: 50, Containers: 0 },
    ]);
    const imageRemove = vi.fn().mockResolvedValue(undefined);
    mockDocker.getImage.mockReturnValue({ remove: imageRemove });

    const dc = DockerController.getInstance(1);
    const plan = await dc.buildPrunePlan(['images'], 'all', [], 1);
    mockDocker.listImages.mockResolvedValue([
      { Id: 'img-multi', RepoTags: ['qa1769/app:v0', 'qa1769-external/keep:v0'], Size: 50, Containers: 0 },
    ]);
    vi.spyOn(dc, 'assertPlanFresh').mockResolvedValue(plan);
    const result = await dc.executePrunePlan(plan, []);
    expect(imageRemove).not.toHaveBeenCalled();
    expect(result.outcomes[0]).toEqual(expect.objectContaining({
      id: 'img-multi',
      status: 'failed',
      error: expect.stringMatching(/references changed/i),
    }));
  });

  it('untags each reviewed name and reports removed once the image is gone', async () => {
    const removes = mockImageRemove();
    const result = await executeForcedFreshImagePlan([[multiTagImage], [multiTagImage], []]);

    expect(removes.map((entry) => entry.name)).toEqual(['qa1769/app:v0', 'qa1769-external/keep:v0']);
    expect(result.outcomes[0]).toEqual(expect.objectContaining({
      id: 'img-multi',
      status: 'removed',
    }));
    expect(result.mutated).toBe(true);
    expect(result.success).toBe(true);
  });

  it('treats a first-ref 404 as absent and still removes when a later reviewed tag succeeds', async () => {
    const removes = mockImageRemove(async (name) => {
      if (name === 'qa1769/app:v0') {
        throw Object.assign(new Error('No such image: qa1769/app:v0'), { statusCode: 404 });
      }
    });
    const result = await executeForcedFreshImagePlan([[multiTagImage], [multiTagImage], []]);

    expect(removes).toEqual([
      { name: 'qa1769/app:v0', force: false },
      { name: 'qa1769-external/keep:v0', force: false },
    ]);
    expect(result.outcomes[0]).toEqual(expect.objectContaining({ status: 'removed' }));
    expect(result.mutated).toBe(true);
    expect(result.success).toBe(true);
  });

  it('does not report removed when a later 404 leaves another reviewed tag present', async () => {
    mockImageRemove(async (name) => {
      if (name === 'qa1769-external/keep:v0') {
        throw Object.assign(new Error('No such image'), { statusCode: 404 });
      }
    });
    const result = await executeForcedFreshImagePlan([
      [multiTagImage],
      [multiTagImage],
      [{ ...multiTagImage, RepoTags: ['qa1769/app:v0'] }],
    ]);

    expect(result.outcomes[0]).toEqual(expect.objectContaining({
      status: 'failed',
      error: expect.stringMatching(/qa1769\/app:v0/),
    }));
    expect(result.outcomes[0]).not.toEqual(expect.objectContaining({ status: 'removed' }));
    expect(result.mutated).toBe(true);
    expect(result.success).toBe(false);
  });

  it('stops on a hard untag error, lists remaining tags, and marks mutated', async () => {
    const removes = mockImageRemove(async (name) => {
      if (name === 'qa1769-external/keep:v0') {
        throw Object.assign(new Error('conflict: unable to delete (must be forced)'), { statusCode: 409 });
      }
    });
    const result = await executeForcedFreshImagePlan([
      [multiTagImage],
      [multiTagImage],
      [{ ...multiTagImage, RepoTags: ['qa1769-external/keep:v0'] }],
    ]);

    expect(removes.map((entry) => entry.name)).toEqual(['qa1769/app:v0', 'qa1769-external/keep:v0']);
    expect(result.outcomes[0]).toEqual(expect.objectContaining({
      status: 'failed',
      error: expect.stringMatching(/qa1769-external\/keep:v0/),
    }));
    expect(result.mutated).toBe(true);
    expect(result.success).toBe(false);
  });

  it('never removes an unexpected tag that appears during execution', async () => {
    const img = { Id: 'img-multi', RepoTags: ['qa1769/app:v0'], Size: 50, Containers: 0 };
    const removes = mockImageRemove();
    const result = await executeForcedFreshImagePlan([
      [img],
      [img],
      [{ ...img, RepoTags: ['qa1769-external/keep:v0'] }],
    ]);

    expect(removes.map((entry) => entry.name)).toEqual(['qa1769/app:v0']);
    expect(removes.map((entry) => entry.name)).not.toContain('qa1769-external/keep:v0');
    expect(result.outcomes[0]).toEqual(expect.objectContaining({
      status: 'failed',
      error: expect.stringMatching(/not in the reviewed set/i),
    }));
    expect(result.mutated).toBe(true);
  });

  it('removes a dangling planned image by id with force false', async () => {
    const img = { Id: 'img-dang', RepoTags: ['<none>:<none>'], Size: 20, Containers: 0 };
    const removes = mockImageRemove();
    const result = await executeForcedFreshImagePlan([[img], [img], [img]]);

    expect(removes).toEqual([{ name: 'img-dang', force: false }]);
    expect(result.outcomes[0]).toEqual(expect.objectContaining({ status: 'removed' }));
    expect(result.mutated).toBe(true);
    expect(result.success).toBe(true);
  });

  it('id-removes leftover none tags after reviewed names are gone', async () => {
    const img = { Id: 'img-multi', RepoTags: ['qa1769/app:v0'], Size: 50, Containers: 0 };
    const removes = mockImageRemove();
    const result = await executeForcedFreshImagePlan([
      [img],
      [img],
      [{ ...img, RepoTags: ['<none>:<none>'] }],
    ]);

    expect(removes).toEqual([
      { name: 'qa1769/app:v0', force: false },
      { name: 'img-multi', force: false },
    ]);
    expect(result.outcomes[0]).toEqual(expect.objectContaining({ status: 'removed' }));
    expect(result.mutated).toBe(true);
    expect(result.success).toBe(true);
  });

  it('does not treat a 409 as missing when the conflict text contains 404', async () => {
    const img = {
      Id: 'sha256:abc404def',
      RepoTags: ['qa1769/app:v0', 'qa1769/app:latest'],
      Size: 50,
      Containers: 0,
    };
    const removes = mockImageRemove(async () => {
      throw Object.assign(
        new Error('(HTTP code 409) conflict - image sha256:abc404def is being used by running container'),
        { statusCode: 409 },
      );
    });
    const result = await executeForcedFreshImagePlan([[img], [img], [img]]);

    expect(removes).toEqual([{ name: 'qa1769/app:v0', force: false }]);
    expect(result.outcomes[0]).toEqual(expect.objectContaining({
      status: 'failed',
      error: expect.stringMatching(/qa1769\/app:v0/),
    }));
    expect(result.mutated).toBe(false);
    expect(result.success).toBe(false);
  });

  it('does not report dangling id-remove 409 as removed when the message contains 404', async () => {
    const img = { Id: 'sha256:abc404def', RepoTags: ['<none>:<none>'], Size: 20, Containers: 0 };
    mockImageRemove(async () => {
      throw Object.assign(
        new Error('(HTTP code 409) conflict - unable to delete sha256:abc404def (must be forced)'),
        { statusCode: 409 },
      );
    });
    const result = await executeForcedFreshImagePlan([[img], [img], [img]]);

    expect(result.outcomes[0]).toEqual(expect.objectContaining({
      status: 'failed',
      error: expect.stringMatching(/dangling image could not be removed/i),
    }));
    expect(result.mutated).toBe(false);
    expect(result.success).toBe(false);
  });

  it('fails honestly when completion re-list throws after a successful untag', async () => {
    const img = { Id: 'img-multi', RepoTags: ['qa1769/app:v0'], Size: 50, Containers: 0 };
    mockImageRemove();
    const result = await executeForcedFreshImagePlan([[img], [img], new Error('daemon busy')]);

    expect(result.outcomes[0]).toEqual(expect.objectContaining({
      status: 'failed',
      error: expect.stringMatching(/could not confirm remaining/i),
    }));
    expect(result.mutated).toBe(true);
    expect(result.success).toBe(false);
  });
});
