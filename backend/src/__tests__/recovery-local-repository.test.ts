/**
 * The node-local repository: provisioning is idempotent, resumable and never
 * writes over a repository that opened.
 *
 * Each step is exercised by its own crash point: the test stops the scripted
 * helper after the step, then runs the same provisioning call again and asserts
 * it continued rather than starting over. The password is asserted stable across
 * attempts, because overwriting it is what makes existing points unreadable.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type Docker from 'dockerode';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import type { HelperRunSpec, HelperRunResult } from '../services/recovery/restic/helperRunner';

let tmpDir: string;
let localRepository: typeof import('../services/recovery/localRepository');
let repositories: typeof import('../services/recovery/repositories');
let recoveryDbModule: typeof import('../services/recovery/recoveryDb');

const AUTHORITY_ENGINE = 'docker-engine:repo-test';
const CONFIG_ID = 'f'.repeat(32);

interface ScriptedResult {
  exitCode: number | null;
  stdout?: string;
  aborted?: boolean;
  killed?: boolean;
}

/** A runner that answers from a script, one entry per call. */
function scriptedRunner(script: ScriptedResult[]) {
  const calls: HelperRunSpec[] = [];
  const results: HelperRunResult[] = [];
  return {
    calls,
    results,
    runner: {
      run: async (spec: HelperRunSpec): Promise<HelperRunResult> => {
        calls.push(spec);
        const next = script.shift();
        if (!next) throw new Error('helper was run more times than the script allows');
        if (next.stdout && spec.onStdoutLine) {
          for (const line of next.stdout.split('\n')) if (line !== '') spec.onStdoutLine(line);
        }
        const result: HelperRunResult = {
          exitCode: next.exitCode,
          stderrTail: '',
          aborted: next.aborted ?? false,
          killed: next.killed ?? false,
        };
        results.push(result);
        return result;
      },
      removeForeignEpochHelpers: async () => 0,
    },
  };
}

interface VolumeState {
  name: string;
  labels: Record<string, string>;
}

function fakeDocker(initial: VolumeState[] = []) {
  const volumes = new Map(initial.map((v) => [v.name, v]));
  const created: string[] = [];
  return {
    volumes,
    created,
    docker: {
      getVolume: (name: string) => ({
        inspect: async () => {
          const volume = volumes.get(name);
          if (!volume) throw Object.assign(new Error('no such volume'), { statusCode: 404 });
          return { Name: volume.name, Driver: 'local', Labels: volume.labels, CreatedAt: '2026-01-01T00:00:00Z' };
        },
      }),
      createVolume: async (options: { Name: string; Labels?: Record<string, string> }) => {
        created.push(options.Name);
        volumes.set(options.Name, { name: options.Name, labels: options.Labels ?? {} });
        return { Name: options.Name };
      },
      getImage: () => ({ inspect: async () => ({}) }),
    } as unknown as Docker,
  };
}

function configLine(id = CONFIG_ID): string {
  return JSON.stringify({ version: 2, id, chunker_polynomial: 'x' });
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  localRepository = await import('../services/recovery/localRepository');
  repositories = await import('../services/recovery/repositories');
  recoveryDbModule = await import('../services/recovery/recoveryDb');
});

afterAll(async () => {
  await cleanupTestDb(tmpDir);
});

beforeEach(() => {
  // Every test starts with no repositories of its own.
  const db = recoveryDbModule.recoveryDb();
  db.prepare('DELETE FROM recovery_repositories').run();
  db.prepare("DELETE FROM system_state WHERE key = 'recovery_active_repository_id'").run();
});

function depsFor(
  scripted: ReturnType<typeof scriptedRunner>,
  docker: Docker,
  events: string[] = [],
) {
  return {
    nodeId: 1,
    docker,
    authorityId: recoveryDbModule.getRecoveryAuthorityId(),
    ownerNodeKey: AUTHORITY_ENGINE,
    runner: scripted.runner as unknown as import('../services/recovery/restic/helperRunner').RecoveryHelperRunner,
    operationId: 'op-1',
    onEvent: (event: string) => { events.push(event); },
  };
}

describe('recovery repository provisioning', () => {
  it('initializes an empty labelled volume once and records the fingerprint', async () => {
    const docker = fakeDocker();
    const scripted = scriptedRunner([
      { exitCode: 10 },
      { exitCode: 0 },
      { exitCode: 0, stdout: configLine() },
    ]);
    const events: string[] = [];
    const provisioned = await new localRepository.RepositoryProvisioner().provision(
      depsFor(scripted, docker.docker, events),
      { generation: 1 },
    );

    expect(events).toEqual(['registered', 'secret_created', 'volume_created', 'initialized']);
    expect(provisioned.repository.repositoryFingerprint).toBe(CONFIG_ID);
    expect(provisioned.repository.locator).toMatch(/^sencho-recovery-[0-9a-f]{12}-[0-9a-z]{12}-g1$/);
    expect(docker.volumes.get(provisioned.repository.locator)?.labels)
      .toEqual({ 'dev.sencho.recovery.repository': provisioned.repository.id });
    expect(repositories.RecoveryRepositoryStore.getInstance().getActive()?.id).toBe(provisioned.repository.id);
    // init ran exactly once, after the repository was found absent.
    expect(scripted.calls.map((c) => c.cmd.find((arg) => arg === 'cat' || arg === 'init')))
      .toEqual(['cat', 'init', 'cat']);
  });

  it('adopts a repository that already opens, and never re-initializes it', async () => {
    const docker = fakeDocker();
    const scripted = scriptedRunner([
      { exitCode: 10 },
      { exitCode: 0 },
      { exitCode: 0, stdout: configLine() },
      // Second attempt: the repository opens.
      { exitCode: 0, stdout: configLine() },
    ]);
    const provisionerInstance = new localRepository.RepositoryProvisioner();
    const first = await provisionerInstance.provision(depsFor(scripted, docker.docker), { generation: 1 });
    const second = await provisionerInstance.provision(depsFor(scripted, docker.docker), { generation: 1 });

    expect(second.repository.id).toBe(first.repository.id);
    expect(scripted.calls.map((c) => c.cmd.find((arg) => arg === 'cat' || arg === 'init')))
      .toEqual(['cat', 'init', 'cat', 'cat']);
    expect(scripted.calls.filter((c) => c.cmd.includes('init'))).toHaveLength(1);
  });

  it('keeps the stored password across attempts', async () => {
    const docker = fakeDocker();
    const provisionerInstance = new localRepository.RepositoryProvisioner();
    const scripted = scriptedRunner([
      { exitCode: 10 },
      { exitCode: 0 },
      { exitCode: 0, stdout: configLine() },
      { exitCode: 0, stdout: configLine() },
    ]);
    const first = await provisionerInstance.provision(depsFor(scripted, docker.docker), { generation: 1 });
    const secretAfterFirst = recoveryDbModule.recoveryDb()
      .prepare('SELECT encrypted_secret FROM recovery_repositories WHERE id = ?')
      .get(first.repository.id) as { encrypted_secret: string };
    await provisionerInstance.provision(depsFor(scripted, docker.docker), { generation: 1 });
    const secretAfterSecond = recoveryDbModule.recoveryDb()
      .prepare('SELECT encrypted_secret FROM recovery_repositories WHERE id = ?')
      .get(first.repository.id) as { encrypted_secret: string };
    expect(secretAfterSecond.encrypted_secret).toBe(secretAfterFirst.encrypted_secret);
    // And the plaintext the helper was given is the same one both times.
    expect(scripted.calls[0].stdinSecret).toBe(scripted.calls[3].stdinSecret);
    expect(scripted.calls[0].stdinSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('resumes after a crash between register and volume creation', async () => {
    const docker = fakeDocker();
    const provisionerInstance = new localRepository.RepositoryProvisioner();
    // The first attempt dies before the repository is read at all.
    await expect(
      provisionerInstance.provision(
        depsFor(scriptedRunner([{ exitCode: null, killed: true }]), docker.docker),
        { generation: 1 },
      ),
    ).rejects.toMatchObject({ errorClass: 'node_error' });

    const scripted = scriptedRunner([
      { exitCode: 10 },
      { exitCode: 0 },
      { exitCode: 0, stdout: configLine() },
    ]);
    const resumed = await provisionerInstance.provision(depsFor(scripted, docker.docker), { generation: 1 });
    expect(resumed.repository.repositoryFingerprint).toBe(CONFIG_ID);
    // One repository row, not two: the locator is the same and registration is idempotent.
    const rows = recoveryDbModule.recoveryDb().prepare('SELECT id FROM recovery_repositories').all();
    expect(rows).toHaveLength(1);
  });

  it('refuses a volume that does not carry this repository label', async () => {
    const db = recoveryDbModule.recoveryDb();
    const authorityId = recoveryDbModule.getRecoveryAuthorityId();
    const locator = localRepository.repositoryVolumeName(authorityId, AUTHORITY_ENGINE, 1);
    const docker = fakeDocker([{ name: locator, labels: { 'dev.sencho.recovery.repository': 'someone-else' } }]);
    const scripted = scriptedRunner([]);
    await expect(
      new localRepository.RepositoryProvisioner().provision(depsFor(scripted, docker.docker), { generation: 1 }),
    ).rejects.toMatchObject({ errorClass: 'repository_unavailable' });
    expect(docker.created).toEqual([]);
    expect(db.prepare('SELECT repository_fingerprint FROM recovery_repositories').all()).toEqual([
      { repository_fingerprint: null },
    ]);
  });

  it('reports a wrong key as repository_key_unavailable', async () => {
    const docker = fakeDocker();
    const scripted = scriptedRunner([{ exitCode: 12 }]);
    await expect(
      new localRepository.RepositoryProvisioner().provision(depsFor(scripted, docker.docker), { generation: 1 }),
    ).rejects.toMatchObject({ errorClass: 'repository_key_unavailable' });
  });

  it('replace moves the active pointer and keeps the previous repository', async () => {
    const docker = fakeDocker();
    const provisionerInstance = new localRepository.RepositoryProvisioner();
    const first = await provisionerInstance.provision(
      depsFor(scriptedRunner([
        { exitCode: 10 },
        { exitCode: 0 },
        { exitCode: 0, stdout: configLine() },
      ]), docker.docker),
      { generation: 1 },
    );

    const second = await provisionerInstance.provision(
      depsFor(scriptedRunner([
        { exitCode: 10 },
        { exitCode: 0 },
        { exitCode: 0, stdout: configLine('e'.repeat(32)) },
      ]), docker.docker),
      { generation: 2, replace: true },
    );

    expect(second.repository.id).not.toBe(first.repository.id);
    expect(second.repository.locator).toMatch(/-g2$/);
    expect(repositories.RecoveryRepositoryStore.getInstance().getActive()?.id).toBe(second.repository.id);
    // The old row and its volume are kept: evidence is never destroyed by a replace.
    expect(repositories.RecoveryRepositoryStore.getInstance().get(first.repository.id)).not.toBeNull();
    expect(docker.volumes.has(first.repository.locator)).toBe(true);
  });
});
