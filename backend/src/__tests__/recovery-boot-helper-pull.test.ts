/**
 * What boot does when the pinned recovery helper image is not on the host.
 *
 * Each Sencho image pins its own helper digest, so a node with an active
 * repository finds the new helper missing after an image change. Without a pull
 * every recovery point reads as unavailable until provisioning runs again. Boot
 * pulls the pinned helper once for such a node, registers it as Sencho's own
 * infrastructure so a prune keeps it, and never lets a failed or slow pull stop
 * the rest of boot. It pulls nothing for a node without an active repository,
 * for an image id, or for an unpinned reference.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type Docker from 'dockerode';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let runner: typeof import('../services/recovery/operationRunner');
let operations: typeof import('../services/recovery/operations');
let repositoryStore: typeof import('../services/recovery/repositories');
let recoveryDbModule: typeof import('../services/recovery/recoveryDb');
let SelfIdentityService: typeof import('../services/SelfIdentityService').default;
let DockerController: typeof import('../services/DockerController').default;
let nodeId: number;

const ENGINE_KEY = 'docker-engine:engine-1';
const HELPER_ENV = 'SENCHO_RECOVERY_HELPER_IMAGE';
const HELPER_DIGEST_REF = `ghcr.io/studio-saelix/sencho-recovery-helper@sha256:${'b'.repeat(64)}`;
const HELPER_IMAGE_ID = `sha256:${'a'.repeat(64)}`;
// Longer than the wait boot gives a pull, whatever that is set to.
const PAST_THE_WAIT_MS = 10 * 60_000;
const PRESENT_IMAGE_ID = 'sha256:helper';
const HELPER_UNAVAILABLE = { state: 'unavailable', reason: 'helper_unavailable' } as const;
let previousHelperEnv: string | undefined;

interface DaemonScript {
  /** Whether the helper image is on the host before boot. */
  present: boolean;
  /** How the pull ends: it finishes, fails, or waits until the test settles it. */
  pull: 'finishes' | 'fails' | 'hangs';
  /** The status the image inspect answers while the image is absent. */
  absentStatus?: number;
  /** The startup pull's own image inspect (the second one of boot) never answers while the image is absent. */
  inspectHangs?: boolean;
}

interface HangingPull {
  settle: (err: Error | null) => void;
}

function fakeDocker(script: DaemonScript, calls: string[], hanging: HangingPull): Docker {
  let present = script.present;
  let inspects = 0;
  return {
    info: async () => ({ ID: 'engine-1' }),
    listVolumes: async () => ({ Volumes: [] }),
    getVolume: () => ({ inspect: async () => { throw Object.assign(new Error('no such volume'), { statusCode: 404 }); } }),
    listContainers: async () => [],
    getImage: () => ({
      inspect: async () => {
        calls.push('inspect');
        inspects += 1;
        if (!present && script.inspectHangs && inspects === 2) await new Promise<never>(() => undefined);
        if (!present) throw Object.assign(new Error('no such image'), { statusCode: script.absentStatus ?? 404 });
        return { Id: PRESENT_IMAGE_ID };
      },
    }),
    pull: (ref: string, callback: (err: Error | null, stream: NodeJS.ReadableStream | null) => void) => {
      calls.push(`pull:${ref}`);
      if (script.pull === 'fails') {
        callback(new Error('registry unreachable'), null);
        return;
      }
      callback(null, {} as NodeJS.ReadableStream);
    },
    modem: {
      followProgress: (_stream: unknown, done: (err: Error | null) => void) => {
        if (script.pull === 'hangs') {
          hanging.settle = (err) => {
            if (!err) present = true;
            done(err);
          };
          return;
        }
        present = true;
        done(null);
      },
    },
  } as unknown as Docker;
}

function helper(calls: string[]) {
  return {
    run: async (spec: { profile: string }) => {
      calls.push(`run:${spec.profile}`);
      return { exitCode: 0, stderrTail: '', aborted: false, killed: false };
    },
    removeForeignEpochHelpers: async () => {
      calls.push('removeForeign');
      return 0;
    },
    countForeignEpochHelpers: async () => 0,
  } as unknown as import('../services/recovery/restic/helperRunner').RecoveryHelperRunner;
}

function activateRepository(): void {
  const store = repositoryStore.RecoveryRepositoryStore.getInstance();
  const repository = store.register({
    ownerNodeKey: ENGINE_KEY, kind: 'local_volume', locator: 'sencho-recovery-boot-pull', failureDomain: 'same_failure_domain',
  });
  store.storeSecret(repository.id, 'password-1');
  store.setFingerprint(repository.id, 'f'.repeat(32));
  store.setActive(repository.id);
}

function quietConsole() {
  return {
    log: vi.spyOn(console, 'log').mockImplementation(() => undefined),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
  };
}

function text(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.flat().map(String).join(' ');
}

/** Moves the fake clock until the boot promise settles, however many timers boot arms on the way. */
async function settleBootWith(booting: Promise<unknown>): Promise<void> {
  let settled = false;
  void booting.finally(() => { settled = true; });
  for (let i = 0; i < 200 && !settled; i += 1) {
    await vi.advanceTimersByTimeAsync(PAST_THE_WAIT_MS);
  }
}

async function boot(script: DaemonScript) {
  const calls: string[] = [];
  const hanging: HangingPull = { settle: () => undefined };
  vi.spyOn(DockerController.prototype, 'getDocker').mockReturnValue(fakeDocker(script, calls, hanging));
  const service = runner.RecoveryEngineService.getInstance(nodeId);
  service.setHelperRunnerForTests(helper(calls));
  await service.runBootSequence();
  return { calls, service, hanging };
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  runner = await import('../services/recovery/operationRunner');
  operations = await import('../services/recovery/operations');
  repositoryStore = await import('../services/recovery/repositories');
  recoveryDbModule = await import('../services/recovery/recoveryDb');
  SelfIdentityService = (await import('../services/SelfIdentityService')).default;
  DockerController = (await import('../services/DockerController')).default;
  nodeId = (await import('../services/DatabaseService')).DatabaseService.getInstance().getDefaultNode()?.id ?? 1;
  previousHelperEnv = process.env[HELPER_ENV];
});

afterAll(async () => {
  if (previousHelperEnv === undefined) delete process.env[HELPER_ENV];
  else process.env[HELPER_ENV] = previousHelperEnv;
  await cleanupTestDb(tmpDir);
});

beforeEach(() => {
  process.env[HELPER_ENV] = HELPER_DIGEST_REF;
  runner.RecoveryEngineService.resetForTests();
  SelfIdentityService.getInstance().resetForTesting();
  (operations.RecoveryOperationStore.getInstance() as unknown as { reconciled: boolean }).reconciled = false;
  const db = recoveryDbModule.recoveryDb();
  for (const table of [
    'recovery_restore_fence_members', 'recovery_restore_intents', 'recovery_repository_checks', 'recovery_locks', 'recovery_operations',
    'recovery_point_verifications', 'recovery_points', 'recovery_repositories',
    'recovery_storage_dependents', 'recovery_storage_identities',
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  db.prepare("DELETE FROM system_state WHERE key = 'recovery_active_repository_id'").run();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('boot with the pinned helper image missing', () => {
  it('pulls the pinned digest once for an active repository, before any helper runs', async () => {
    activateRepository();
    const { calls, service } = await boot({ present: false, pull: 'finishes' });

    expect(calls.filter((c) => c.startsWith('pull:'))).toEqual([`pull:${HELPER_DIGEST_REF}`]);
    expect(calls.indexOf(`pull:${HELPER_DIGEST_REF}`)).toBeLessThan(calls.indexOf('removeForeign'));
    expect(calls.indexOf(`pull:${HELPER_DIGEST_REF}`)).toBeLessThan(calls.indexOf('run:unlock'));
    expect(service.isReady()).toBe(true);
    // With the helper in place the cheap check reaches the repository volume, which this fake daemon does not have.
    expect(service.health()).toEqual({ state: 'unavailable', reason: 'repository_unavailable' });
  });

  it('registers the pulled image as Sencho infrastructure, so a prune keeps it', async () => {
    activateRepository();
    const registered = vi.spyOn(SelfIdentityService.getInstance(), 'registerRecoveryImage');
    await boot({ present: false, pull: 'finishes' });

    expect(registered).toHaveBeenCalledWith(PRESENT_IMAGE_ID);
    expect(SelfIdentityService.getInstance().isRecoveryImage(PRESENT_IMAGE_ID)).toBe(true);
  });

  it('does not pull when the helper is already on the host', async () => {
    activateRepository();
    const { calls } = await boot({ present: true, pull: 'finishes' });

    expect(calls.some((c) => c.startsWith('pull:'))).toBe(false);
  });

  it('does not pull for a node with no active repository, because nobody turned recovery on', async () => {
    const { calls, service } = await boot({ present: false, pull: 'finishes' });

    expect(calls.some((c) => c.startsWith('pull:'))).toBe(false);
    expect(service.isReady()).toBe(true);
  });

  it('does not look at an image id, which has nothing to be pulled from', async () => {
    process.env[HELPER_ENV] = HELPER_IMAGE_ID;
    activateRepository();
    const out = quietConsole();
    const { calls, service } = await boot({ present: false, pull: 'finishes' });

    expect(calls.some((c) => c.startsWith('pull:'))).toBe(false);
    expect(text(out.log)).not.toContain('Pulling the pinned helper image');
    expect(text(out.warn)).not.toContain('could not be pulled at startup');
    expect(service.isReady()).toBe(true);
  });

  it('does not pull when no helper is pinned', async () => {
    delete process.env[HELPER_ENV];
    activateRepository();
    const { calls, service } = await boot({ present: false, pull: 'finishes' });

    expect(calls.some((c) => c.startsWith('pull:'))).toBe(false);
    expect(service.isReady()).toBe(true);
  });

  it('pulls when the daemon cannot answer the inspect, and still finishes boot', async () => {
    activateRepository();
    const { calls, service } = await boot({ present: false, pull: 'finishes', absentStatus: 500 });

    expect(calls.filter((c) => c.startsWith('pull:'))).toHaveLength(1);
    expect(service.isReady()).toBe(true);
  });

  it('finishes boot and says so when the registry cannot be reached', async () => {
    activateRepository();
    const out = quietConsole();
    const { service } = await boot({ present: false, pull: 'fails' });

    expect(service.isReady()).toBe(true);
    expect(text(out.warn)).toContain('Helper image could not be pulled at startup');
    // The truthful answer stays: no helper, no protection.
    expect(service.health()).toEqual(HELPER_UNAVAILABLE);
  });

  it('finishes boot when reading the active repository throws', async () => {
    activateRepository();
    const out = quietConsole();
    vi.spyOn(repositoryStore.RecoveryRepositoryStore.getInstance(), 'getActive').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    const { calls, service } = await boot({ present: false, pull: 'finishes' });

    expect(service.isReady()).toBe(true);
    expect(text(out.warn)).toContain('database is locked');
    expect(calls.some((c) => c.startsWith('pull:'))).toBe(false);
  });

  it.each(['finishes', 'fails'] as const)('leaves no wait timer behind after a pull that %s in time', async (pull) => {
    activateRepository();
    quietConsole();
    vi.useFakeTimers();
    const before = vi.getTimerCount();
    const { service } = await boot({ present: false, pull });

    expect(service.isReady()).toBe(true);
    expect(vi.getTimerCount()).toBe(before);
  });

  it('stops waiting for an inspect that never answers, so boot still finishes', async () => {
    activateRepository();
    const out = quietConsole();
    vi.useFakeTimers();
    const booting = boot({ present: false, pull: 'finishes', inspectHangs: true });
    await settleBootWith(booting);
    const { service, calls } = await booting;

    expect(service.isReady()).toBe(true);
    expect(calls).toContain('run:unlock');
    expect(text(out.warn)).toContain('boot continues without waiting');
  });
});

describe('boot with a pull that outlasts the wait', () => {
  /** Starts a boot against a pull that never ends by itself and lets the wait run out. */
  async function bootPastTheWait() {
    activateRepository();
    vi.useFakeTimers();
    const out = quietConsole();
    const booting = boot({ present: false, pull: 'hangs' });
    await settleBootWith(booting);
    const result = await booting;
    return { ...result, out };
  }

  it('carries on with the rest of boot and keeps the answer honest', async () => {
    const { calls, service, out } = await bootPastTheWait();

    expect(service.isReady()).toBe(true);
    expect(calls).toContain('run:unlock');
    expect(text(out.warn)).toContain('boot continues without waiting');
    expect(service.health()).toEqual(HELPER_UNAVAILABLE);
  });

  it('registers the image and corrects the answer when the pull finishes later', async () => {
    const { hanging, service, out } = await bootPastTheWait();
    vi.useRealTimers();
    expect(SelfIdentityService.getInstance().isRecoveryImage(PRESENT_IMAGE_ID)).toBe(false);

    hanging.settle(null);
    await vi.waitFor(() => expect(SelfIdentityService.getInstance().isRecoveryImage(PRESENT_IMAGE_ID)).toBe(true));
    expect(text(out.log)).toContain('pull finished after boot moved on');
    await vi.waitFor(() => expect(service.health()).toEqual({ state: 'unavailable', reason: 'repository_unavailable' }));
  });

  it('logs a pull that fails later, with no unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const { hanging, out } = await bootPastTheWait();
      vi.useRealTimers();

      hanging.settle(new Error('connection reset'));
      await vi.waitFor(() => expect(text(out.warn)).toContain('failed after boot moved on'));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('which helper references can be pulled', () => {
  it('accepts a registry digest reference and refuses an image id or a tag', async () => {
    const { helperImageCanBePulled } = await import('../services/recovery/restic/helperImage');

    expect(helperImageCanBePulled(HELPER_DIGEST_REF)).toBe(true);
    expect(helperImageCanBePulled(HELPER_IMAGE_ID)).toBe(false);
    expect(helperImageCanBePulled('ghcr.io/studio-saelix/sencho-recovery-helper:latest')).toBe(false);
    expect(helperImageCanBePulled('')).toBe(false);
  });
});
