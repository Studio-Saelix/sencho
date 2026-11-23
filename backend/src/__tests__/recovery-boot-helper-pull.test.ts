/**
 * What boot does when the pinned recovery helper image is not on the host.
 *
 * Each Sencho image pins its own helper digest, so a node that already has a
 * repository finds the new helper missing after an image change. Without a pull
 * every recovery point reads as unavailable until provisioning runs again. Boot
 * pulls the pinned helper once for such a node, never for a node that has no
 * repository, never for an image id, and never lets a failed or slow pull stop
 * the rest of boot.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type Docker from 'dockerode';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let runner: typeof import('../services/recovery/operationRunner');
let operations: typeof import('../services/recovery/operations');
let repositoryStore: typeof import('../services/recovery/repositories');
let recoveryDbModule: typeof import('../services/recovery/recoveryDb');
let DockerController: typeof import('../services/DockerController').default;
let nodeId: number;

const ENGINE_KEY = 'docker-engine:engine-1';
const HELPER_ENV = 'SENCHO_RECOVERY_HELPER_IMAGE';
const HELPER_DIGEST_REF = `ghcr.io/studio-saelix/sencho-recovery-helper@sha256:${'b'.repeat(64)}`;
const HELPER_IMAGE_ID = `sha256:${'a'.repeat(64)}`;
let previousHelperEnv: string | undefined;

interface DaemonScript {
  /** Whether the helper image is on the host before boot. */
  present: boolean;
  /** How the pull ends: it finishes, fails, or never ends within the test. */
  pull: 'finishes' | 'fails' | 'hangs';
}

function fakeDocker(script: DaemonScript, calls: string[]): Docker {
  let present = script.present;
  return {
    info: async () => ({ ID: 'engine-1' }),
    listVolumes: async () => ({ Volumes: [] }),
    getVolume: () => ({ inspect: async () => { throw Object.assign(new Error('no such volume'), { statusCode: 404 }); } }),
    listContainers: async () => [],
    getImage: () => ({
      inspect: async () => {
        if (!present) throw Object.assign(new Error('no such image'), { statusCode: 404 });
        return { Id: 'sha256:helper' };
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
        if (script.pull === 'hangs') return;
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
    removeForeignEpochHelpers: async () => 0,
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

async function boot(script: DaemonScript): Promise<{ calls: string[]; service: ReturnType<typeof runner.RecoveryEngineService.getInstance> }> {
  const calls: string[] = [];
  vi.spyOn(DockerController.prototype, 'getDocker').mockReturnValue(fakeDocker(script, calls));
  const service = runner.RecoveryEngineService.getInstance(nodeId);
  service.setHelperRunnerForTests(helper(calls));
  await service.runBootSequence();
  return { calls, service };
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  runner = await import('../services/recovery/operationRunner');
  operations = await import('../services/recovery/operations');
  repositoryStore = await import('../services/recovery/repositories');
  recoveryDbModule = await import('../services/recovery/recoveryDb');
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
  it('pulls the pinned digest once for a node that has a repository, before any helper runs', async () => {
    activateRepository();
    const { calls, service } = await boot({ present: false, pull: 'finishes' });

    expect(calls.filter((c) => c.startsWith('pull:'))).toEqual([`pull:${HELPER_DIGEST_REF}`]);
    // The unlock helper runs only once the image is there.
    expect(calls.indexOf(`pull:${HELPER_DIGEST_REF}`)).toBeLessThan(calls.indexOf('run:unlock'));
    expect(service.isReady()).toBe(true);
    // With the helper in place the cheap check moves on to the repository volume, not the helper.
    expect(service.health()).not.toEqual({ state: 'unavailable', reason: 'helper_unavailable' });
  });

  it('does not pull when the helper is already on the host', async () => {
    activateRepository();
    const { calls } = await boot({ present: true, pull: 'finishes' });

    expect(calls.some((c) => c.startsWith('pull:'))).toBe(false);
  });

  it('does not pull for a node with no repository, because nobody turned recovery on', async () => {
    const { calls, service } = await boot({ present: false, pull: 'finishes' });

    expect(calls.some((c) => c.startsWith('pull:'))).toBe(false);
    expect(service.isReady()).toBe(true);
  });

  it('does not try to pull an image id, which has nothing to be pulled from', async () => {
    process.env[HELPER_ENV] = HELPER_IMAGE_ID;
    activateRepository();
    const { calls, service } = await boot({ present: false, pull: 'finishes' });

    expect(calls.some((c) => c.startsWith('pull:'))).toBe(false);
    expect(service.isReady()).toBe(true);
  });

  it('finishes boot and says so when the registry cannot be reached', async () => {
    activateRepository();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { service } = await boot({ present: false, pull: 'fails' });

    expect(service.isReady()).toBe(true);
    expect(warn.mock.calls.flat().join(' ')).toContain('Helper image could not be pulled at startup');
    // The truthful answer stays: no helper, no protection.
    expect(service.health()).toEqual({ state: 'unavailable', reason: 'helper_unavailable' });
  });

  it('stops waiting for a pull that does not end, so the rest of boot still runs', async () => {
    activateRepository();
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const booting = boot({ present: false, pull: 'hangs' });
    await vi.advanceTimersByTimeAsync(121_000);
    const { service } = await booting;

    expect(service.isReady()).toBe(true);
    expect(warn.mock.calls.flat().join(' ')).toContain('boot continues without waiting');
  });
});
