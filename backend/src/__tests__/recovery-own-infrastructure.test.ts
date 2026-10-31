/**
 * Sencho's own recovery infrastructure is Sencho's own everywhere.
 *
 * The repository volume holds every point this node has taken and the helper
 * image is the only program that can read them. One predicate covers every
 * removal path: the itemized prune plan, the managed sweep, the system prune, the
 * fleet plan and the remove-volume route. These tests pin that predicate and the
 * paths that must consult it, plus the helper's exclusion from crash alerts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Docker from 'dockerode';
import DockerController from '../services/DockerController';
import { NodeRegistry } from '../services/NodeRegistry';
import SelfIdentityService from '../services/SelfIdentityService';
import { classifyDie } from '../services/ContainerLifecycleClassifier';

/** A daemon with one recovery repository volume, one spare volume and no containers. */
function fakeDocker(volumes: string[]) {
  const removed: string[] = [];
  const createdAt = new Date().toISOString();
  const docker = {
    info: async () => ({ ID: 'engine-own' }),
    listVolumes: async () => ({
      Volumes: volumes.map((Name) => ({ Name, Driver: 'local', Labels: {}, CreatedAt: createdAt })),
    }),
    listContainers: async () => [],
    listNetworks: async () => [],
    listImages: async () => [],
    // `docker system df` goes through the modem, not a dockerode helper.
    modem: {
      dial: (_options: unknown, callback: (err: Error | null, data: unknown) => void) => {
        callback(null, { Volumes: volumes.map((Name) => ({ Name, UsageData: { RefCount: 0, Size: 10 } })) });
      },
    },
    getVolume: (name: string) => ({
      inspect: async () => ({ Name: name, Driver: 'local', Labels: {}, CreatedAt: createdAt }),
      remove: async () => { removed.push(name); },
    }),
  } as unknown as Docker;
  return { docker, removed };
}

let stub: ReturnType<typeof vi.spyOn>;

/**
 * DockerController binds its daemon handle in its constructor, so the stub has to
 * sit on the registry it asks, not on the controller's accessor.
 */
function useDocker(docker: Docker): void {
  stub = vi.spyOn(NodeRegistry.prototype, 'getDocker').mockReturnValue(docker);
}

beforeEach(() => {
  SelfIdentityService.getInstance().resetForTesting();
});

afterEach(() => {
  stub?.mockRestore();
  SelfIdentityService.getInstance().resetForTesting();
});

describe('the own-infrastructure predicate', () => {
  it('treats a registered recovery volume as Sencho\'s own', () => {
    const self = SelfIdentityService.getInstance();
    expect(self.isOwnVolume('sencho-recovery-abc-def-g1')).toBe(false);
    self.registerRecoveryVolume('sencho-recovery-abc-def-g1');
    expect(self.isOwnVolume('sencho-recovery-abc-def-g1')).toBe(true);
    expect(self.getRecoveryVolumeNames()).toEqual(['sencho-recovery-abc-def-g1']);
  });

  it('treats the helper image as Sencho\'s own, by full or short id', () => {
    const self = SelfIdentityService.getInstance();
    const id = 'sha256:' + 'a'.repeat(64);
    expect(self.isOwnImage(id)).toBe(false);
    self.registerRecoveryImage(id);
    expect(self.isOwnImage(id)).toBe(true);
    expect(self.isOwnImage('sha256:' + 'a'.repeat(12))).toBe(true);
    expect(self.isOwnImage('b'.repeat(64))).toBe(false);
  });
});

describe('prune paths', () => {
  it('never lists the repository volume in an itemized prune plan', async () => {
    const self = SelfIdentityService.getInstance();
    self.registerRecoveryVolume('sencho-recovery-abc-def-g1');
    const fake = fakeDocker(['sencho-recovery-abc-def-g1', 'spare_volume']);
    useDocker(fake.docker);

    const plan = await DockerController.getInstance(1).buildPrunePlan(['volumes'], 'all', [], 1);
    expect(plan.items.map((item) => item.id)).toEqual(['spare_volume']);
  });

  it('keeps the repository volume through a managed sweep', async () => {
    const self = SelfIdentityService.getInstance();
    self.registerRecoveryVolume('sencho-recovery-abc-def-g1');
    // Managed scope needs a compose project label to consider a volume at all.
    const fake = fakeDocker(['sencho-recovery-abc-def-g1']);
    useDocker(fake.docker);

    const result = await DockerController.getInstance(1).pruneManagedOnly('volumes', [], undefined);
    expect(result.success).toBe(true);
    expect(fake.removed).toEqual([]);
  });

  it('refuses to remove the repository volume through the plain remove path', async () => {
    const self = SelfIdentityService.getInstance();
    self.registerRecoveryVolume('sencho-recovery-abc-def-g1');
    const fake = fakeDocker(['sencho-recovery-abc-def-g1', 'ordinary']);
    useDocker(fake.docker);

    await expect(DockerController.getInstance(1).removeVolume('sencho-recovery-abc-def-g1'))
      .rejects.toThrow(/belongs to Sencho/);
    expect(fake.removed).toEqual([]);
    // An ordinary volume still goes through.
    await DockerController.getInstance(1).removeVolume('ordinary');
    expect(fake.removed).toContain('ordinary');
  });
});

describe('crash alerts', () => {
  it('never classifies a helper exit as a crash, whatever the exit code', () => {
    expect(classifyDie({ at: 1_000, exitCode: 137 }, { helperContainer: true })).toBe('intentional');
    expect(classifyDie({ at: 1_000, exitCode: 1 }, { helperContainer: true })).toBe('intentional');
    expect(classifyDie({ at: 1_000, exitCode: 1 }, {})).toBe('crash');
  });
});
