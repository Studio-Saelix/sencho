/**
 * No prune path removes a secret volume: the daemon-wide volume prune, the
 * managed-only prune, the prune plan, and the plan executor. A secret volume is
 * one with the reserved name or the `io.sencho.secret` label (any value).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    modem: { dial: vi.fn() },
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
import { SecretVolumeProtectedError } from '../helpers/secretVolume';

const PROJECT = { 'com.docker.compose.project': 'my-stack' };
const SECRET_LABELLED = { Name: 'my-stack_tok', Labels: { ...PROJECT, 'io.sencho.secret': '' } };
const SECRET_RESERVED = { Name: 'sencho_edge_secret', Labels: { ...PROJECT } };
const ORDINARY = { Name: 'my-stack_data', Labels: { ...PROJECT } };
const REPOSITORY = { Name: 'sencho-recovery-repo', Labels: { 'dev.sencho.recovery.repository': '1' } };

function unused(...names: string[]) {
  return { Volumes: names.map((Name) => ({ Name, UsageData: { RefCount: 0, Size: 10 } })), Images: [], LayersSize: 0 };
}

beforeEach(() => {
  vi.clearAllMocks();
  CacheService.getInstance().invalidate('project-name-map');
  mockDocker.listImages.mockResolvedValue([]);
  mockDocker.listVolumes.mockResolvedValue({ Volumes: [] });
  mockDocker.listNetworks.mockResolvedValue([]);
  mockDocker.listContainers.mockResolvedValue([]);
  mockDocker.df.mockResolvedValue({ Volumes: [], Images: [], LayersSize: 0 });
  mockDocker.modem.dial.mockImplementation(
    (_opts: unknown, cb: (err: Error | null, data?: unknown) => void) => {
      const configured = mockDocker.df.getMockImplementation();
      Promise.resolve(configured ? configured() : {}).then((snapshot: unknown) => cb(null, snapshot), (err: Error) => cb(err));
    },
  );
});

describe('pruneSystem volumes', () => {
  it('keeps the single daemon prune when the node holds no secret volume', async () => {
    mockDocker.listVolumes.mockResolvedValue({ Volumes: [ORDINARY] });
    mockDocker.pruneVolumes.mockResolvedValue({ SpaceReclaimed: 5 });

    const result = await DockerController.getInstance(1).pruneSystem('volumes');

    expect(mockDocker.pruneVolumes).toHaveBeenCalledWith({
      filters: { all: ['true'], 'label!': ['dev.sencho.recovery.repository'] },
    });
    expect(result).toEqual({ success: true, reclaimedBytes: 5 });
  });

  it.each([
    ['labelled', SECRET_LABELLED],
    ['reserved name', SECRET_RESERVED],
  ])('removes unused volumes one by one and keeps a %s secret volume', async (_kind, secret) => {
    const all = [secret, ORDINARY, REPOSITORY];
    mockDocker.listVolumes.mockResolvedValue({ Volumes: all });
    mockDocker.df.mockResolvedValue(unused(...all.map((v) => v.Name)));
    const removed: string[] = [];
    mockDocker.getVolume.mockImplementation((name: string) => ({
      remove: vi.fn().mockImplementation(async () => { removed.push(name); }),
    }));

    const result = await DockerController.getInstance(1).pruneSystem('volumes');

    // The daemon ANDs `label!` values, so a node with a secret volume never
    // reaches the bulk prune API.
    expect(mockDocker.pruneVolumes).not.toHaveBeenCalled();
    expect(mockDocker.listVolumes).toHaveBeenCalledWith({ filters: { dangling: ['true'] } });
    expect(removed).toEqual(['my-stack_data']);
    expect(result).toEqual({ success: true, reclaimedBytes: 10 });
  });

  it('honours a label filter on the per-volume path', async () => {
    const tagged = { Name: 'tagged', Labels: { 'com.example': 'yes' } };
    const all = [SECRET_LABELLED, ORDINARY, tagged];
    mockDocker.listVolumes.mockResolvedValue({ Volumes: all });
    const removed: string[] = [];
    mockDocker.getVolume.mockImplementation((name: string) => ({
      remove: vi.fn().mockImplementation(async () => { removed.push(name); }),
    }));

    await DockerController.getInstance(1).pruneSystem('volumes', 'com.example=yes');

    expect(removed).toEqual(['tagged']);
  });
});

describe('pruneManagedOnly volumes', () => {
  it('never removes a secret volume of a known stack', async () => {
    const all = [SECRET_LABELLED, SECRET_RESERVED, ORDINARY];
    mockDocker.listVolumes.mockResolvedValue({ Volumes: all });
    mockDocker.df.mockResolvedValue(unused(...all.map((v) => v.Name)));
    const removed: string[] = [];
    mockDocker.getVolume.mockImplementation((name: string) => ({
      remove: vi.fn().mockImplementation(async () => { removed.push(name); }),
    }));

    await DockerController.getInstance(1).pruneManagedOnly('volumes', ['my-stack']);

    expect(removed).toEqual(['my-stack_data']);
  });
});

describe('prune plan', () => {
  it.each(['managed', 'all'] as const)('leaves secret volumes out of a %s plan', async (scope) => {
    const all = [SECRET_LABELLED, SECRET_RESERVED, ORDINARY];
    mockDocker.listVolumes.mockResolvedValue({ Volumes: all });
    mockDocker.df.mockResolvedValue(unused(...all.map((v) => v.Name)));

    const plan = await DockerController.getInstance(1).buildPrunePlan(['volumes'], scope, ['my-stack'], 1);

    expect(plan.items.map((item) => item.id)).toEqual(['my-stack_data']);
  });

  it('skips a planned volume that became a secret volume before it was removed', async () => {
    const plain = { Name: 'my-stack_late', Labels: { ...PROJECT } };
    const labelled = { Name: 'my-stack_late', Labels: { ...PROJECT, 'io.sencho.secret': 'edge-tunnel-run-token' } };
    mockDocker.df.mockResolvedValue(unused('my-stack_late'));
    // Plan, then the freshness rebuild, see the plain volume; the executor's own
    // read sees the label.
    mockDocker.listVolumes
      .mockResolvedValueOnce({ Volumes: [plain] })
      .mockResolvedValueOnce({ Volumes: [plain] })
      .mockResolvedValue({ Volumes: [labelled] });
    const remove = vi.fn();
    mockDocker.getVolume.mockReturnValue({ remove });

    const dc = DockerController.getInstance(1);
    const plan = await dc.buildPrunePlan(['volumes'], 'managed', ['my-stack'], 1);
    const result = await dc.executePrunePlan(plan, ['my-stack']);

    expect(result.outcomes).toEqual([
      { id: 'my-stack_late', target: 'volumes', status: 'skipped', reason: 'Volume holds a delivered secret' },
    ]);
    expect(remove).not.toHaveBeenCalled();
  });
});

describe('removeVolume', () => {
  it('refuses the reserved secret volume name without asking Docker', async () => {
    await expect(DockerController.getInstance(1).removeVolume('sencho_edge_secret'))
      .rejects.toBeInstanceOf(SecretVolumeProtectedError);
    expect(mockDocker.getVolume).not.toHaveBeenCalled();
  });

  it('refuses a labelled secret volume and never removes it', async () => {
    const remove = vi.fn();
    mockDocker.getVolume.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({ Labels: { 'io.sencho.secret': '' } }),
      remove,
    });
    await expect(DockerController.getInstance(1).removeVolume('my-stack_tok'))
      .rejects.toBeInstanceOf(SecretVolumeProtectedError);
    expect(remove).not.toHaveBeenCalled();
  });

  it('still removes an ordinary volume', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    mockDocker.getVolume.mockReturnValue({ inspect: vi.fn().mockResolvedValue({ Labels: {} }), remove });
    await DockerController.getInstance(1).removeVolume('my-stack_data');
    expect(remove).toHaveBeenCalledWith({ force: true });
  });
});
