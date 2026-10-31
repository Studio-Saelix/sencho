/**
 * Which volumes can be protected, what depends on one, and whether anything is
 * using it.
 *
 * The dependent set is the input to every authorization decision, so the tests
 * that matter most here are the ones where a dependent would otherwise be missed:
 * an external volume a stopped stack still declares, a Compose project whose name
 * differs from the stack directory, and a stack whose model cannot be rendered at
 * all (which must fail closed, not narrow).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import type Docker from 'dockerode';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

const renderResults = new Map<string, { rendered: string | null; stderr: string; timedOut: boolean }>();

vi.mock('../services/ComposeService', () => ({
  ComposeService: {
    getInstance: () => ({
      renderConfig: async (stackName: string) => {
        const result = renderResults.get(stackName);
        if (!result) return { rendered: null, stderr: 'no configuration file found', timedOut: false };
        return result;
      },
    }),
  },
}));

let tmpDir: string;
let volumeSources: typeof import('../services/recovery/volumeSources');
let storageIdentity: typeof import('../services/recovery/storageIdentity');
let recoveryDbModule: typeof import('../services/recovery/recoveryDb');

const ENGINE = 'docker-engine:volume-sources';

function modelWithVolume(projectName: string, volumeName: string): string {
  return JSON.stringify({
    name: projectName,
    services: { web: { name: 'web', image: 'nginx', storageMounts: [] } },
    networks: {},
    volumes: { data: { name: volumeName, external: false, internal: false } },
  });
}

function containerFixtures() {
  return [
    {
      Id: 'c1',
      State: 'running',
      Labels: { 'com.docker.compose.project': 'myproject', 'com.docker.compose.service': 'db' },
      Mounts: [{ Type: 'volume', Name: 'shared_data' }],
    },
    {
      Id: 'c2',
      State: 'exited',
      Labels: { 'com.docker.compose.project': 'other' },
      Mounts: [{ Type: 'volume', Name: 'shared_data' }],
    },
    {
      Id: 'c3',
      State: 'paused',
      Labels: { 'com.docker.compose.project': 'other' },
      Mounts: [{ Type: 'volume', Name: 'paused_vol' }],
    },
    {
      Id: 'c4',
      State: 'restarting',
      Labels: {},
      Mounts: [{ Type: 'volume', Name: 'restarting_vol' }],
    },
  ];
}

function fakeDocker(volumes: Array<Record<string, unknown>> = []) {
  return {
    listVolumes: async () => ({ Volumes: volumes }),
    listContainers: async () => containerFixtures(),
    getVolume: (name: string) => ({
      inspect: async () => {
        const found = volumes.find((v) => v.Name === name);
        if (!found) throw Object.assign(new Error('no such volume'), { statusCode: 404 });
        return found;
      },
    }),
  } as unknown as Docker;
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  volumeSources = await import('../services/recovery/volumeSources');
  storageIdentity = await import('../services/recovery/storageIdentity');
  recoveryDbModule = await import('../services/recovery/recoveryDb');
  // A stack whose Compose `name:` differs from its directory name.
  fs.mkdirSync(path.join(process.env.COMPOSE_DIR as string, 'stack-dir'), { recursive: true });
  fs.writeFileSync(
    path.join(process.env.COMPOSE_DIR as string, 'stack-dir', 'docker-compose.yml'),
    'name: myproject\nservices:\n  db:\n    image: postgres\n',
  );
});

afterAll(async () => {
  await cleanupTestDb(tmpDir);
});

beforeEach(() => {
  renderResults.clear();
  recoveryDbModule.recoveryDb().prepare('DELETE FROM recovery_storage_dependents').run();
  recoveryDbModule.recoveryDb().prepare('DELETE FROM recovery_storage_identities').run();
});

describe('volume eligibility', () => {
  const base = {
    driver: 'local',
    options: undefined,
    labels: {} as Record<string, string>,
    isOwnVolume: () => false,
  };

  it('reads a changed creation time as a recreated volume, and a foreign token as no evidence', () => {
    const token = '2026-10-31T10:00:00Z|63:42';
    expect(volumeSources.generationTokenMatchesVolume(token, '2026-10-31T10:00:00Z')).toBe(true);
    expect(volumeSources.generationTokenMatchesVolume(token, '2026-10-31T11:30:00Z')).toBe(false);
    expect(volumeSources.generationTokenMatchesVolume('unknown|63:42', null)).toBe(true);
    expect(volumeSources.generationTokenMatchesVolume('unknown|63:42', '2026-10-31T11:30:00Z')).toBe(false);
    // The same instant printed in another zone is the same volume.
    expect(volumeSources.generationTokenMatchesVolume(token, '2026-10-31T06:00:00-04:00')).toBe(true);
    // A token this adapter did not mint says nothing about the volume.
    expect(volumeSources.generationTokenMatchesVolume('t1', '2026-10-31T11:30:00Z')).toBe(true);
  });

  it('accepts a plain named volume with the local driver', () => {
    expect(volumeSources.classifyVolumeEligibility({ ...base, name: 'app_data' })).toBeNull();
  });

  it('refuses each ineligible kind with its own reason', () => {
    expect(volumeSources.classifyVolumeEligibility({ ...base, name: 'sencho-recovery-abc-g1' })).toBe('reserved_name');
    // The repository volume carries both the label and the reserved prefix, and it
    // says what it is rather than only that its name is reserved.
    expect(volumeSources.classifyVolumeEligibility({
      ...base, name: 'sencho-recovery-abc-g1', labels: { 'dev.sencho.recovery.repository': 'r1' },
    })).toBe('repository_volume');
    expect(volumeSources.classifyVolumeEligibility({
      ...base, name: 'repo', labels: { 'dev.sencho.recovery.repository': 'r1' },
    })).toBe('repository_volume');
    expect(volumeSources.classifyVolumeEligibility({ ...base, name: 'app_data', isOwnVolume: () => true })).toBe('sencho_volume');
    expect(volumeSources.classifyVolumeEligibility({ ...base, name: 'a'.repeat(64) })).toBe('anonymous_volume');
    expect(volumeSources.classifyVolumeEligibility({ ...base, name: 'nfs_data', driver: 'nfs' })).toBe('non_local_driver');
    expect(volumeSources.classifyVolumeEligibility({ ...base, name: 'bind_data', options: { type: 'none', o: 'bind' } })).toBe('driver_options');
  });

  it('never omits a volume from the listing', async () => {
    const sources = await volumeSources.listVolumeSources(fakeDocker([
      { Name: 'ok', Driver: 'local', Labels: {}, CreatedAt: '2026-01-01T00:00:00Z' },
      { Name: 'nfs', Driver: 'nfs', Labels: {} },
      // Docker reports the zero time for some volumes; it is not a creation time.
      { Name: 'unknown_time', Driver: 'local', Labels: {}, CreatedAt: '0001-01-01T00:00:00Z' },
    ]), () => false);
    expect(sources.map((s) => s.volumeName)).toEqual(['ok', 'nfs', 'unknown_time']);
    expect(sources[0]).toMatchObject({ eligible: true, createdAt: '2026-01-01T00:00:00Z' });
    expect(sources[1]).toMatchObject({ eligible: false, ineligibleReason: 'non_local_driver' });
    expect(sources[2].createdAt).toBeNull();
  });
});

describe('generation token and in-use observation', () => {
  it('builds the token from the creation time and the root identity', async () => {
    const runner = {
      run: async (spec: { onStdoutLine?: (line: string) => void }) => {
        spec.onStdoutLine?.(JSON.stringify({ dev: 63, ino: 42, uid: 999, gid: 999, mode: 16877 }));
        return { exitCode: 0, stderrTail: '', aborted: false, killed: false };
      },
    };
    const token = await volumeSources.probeGenerationToken({
      runner: runner as unknown as import('../services/recovery/restic/helperRunner').RecoveryHelperRunner,
      operationId: 'op',
      volumeName: 'data',
      createdAt: '2026-01-01T00:00:00Z',
    });
    expect(token).toBe('2026-01-01T00:00:00Z|63:42');
  });

  it('changes the token when either half changes', async () => {
    const probe = (ino: number) => ({
      run: async (spec: { onStdoutLine?: (line: string) => void }) => {
        spec.onStdoutLine?.(JSON.stringify({ dev: 63, ino, uid: 0, gid: 0, mode: 16877 }));
        return { exitCode: 0, stderrTail: '', aborted: false, killed: false };
      },
    }) as unknown as import('../services/recovery/restic/helperRunner').RecoveryHelperRunner;
    const createdAt = '2026-01-01T00:00:00Z';
    const first = await volumeSources.probeGenerationToken({ runner: probe(1), operationId: 'o', volumeName: 'd', createdAt });
    const recreated = await volumeSources.probeGenerationToken({ runner: probe(2), operationId: 'o', volumeName: 'd', createdAt });
    expect(first).not.toBe(recreated);
  });

  it('refuses to invent a token when the probe fails', async () => {
    const runner = {
      run: async () => ({ exitCode: 1, stderrTail: 'no such file', aborted: false, killed: false }),
    } as unknown as import('../services/recovery/restic/helperRunner').RecoveryHelperRunner;
    await expect(volumeSources.probeGenerationToken({
      runner, operationId: 'o', volumeName: 'd', createdAt: null,
    })).rejects.toMatchObject({ errorClass: 'identity_unknown' });
  });

  it('counts running, paused and restarting containers as in use', async () => {
    const docker = fakeDocker();
    expect(await volumeSources.observeVolumeInUse(docker, 'shared_data')).toMatchObject({ inUse: true });
    expect(await volumeSources.observeVolumeInUse(docker, 'paused_vol')).toMatchObject({ inUse: true });
    expect(await volumeSources.observeVolumeInUse(docker, 'restarting_vol')).toMatchObject({ inUse: true });
    expect(await volumeSources.observeVolumeInUse(docker, 'nobody_mounts_me')).toMatchObject({ inUse: false });
  });

  it('labels a capture by what was observed at both checks', () => {
    const idle = { inUse: false, liveContainers: [] };
    const busy = { inUse: true, liveContainers: ['c1'] };
    expect(volumeSources.consistencyFromObservations(idle, idle)).toBe('crash_consistent_stopped');
    expect(volumeSources.consistencyFromObservations(idle, busy)).toBe('crash_consistent_live');
    expect(volumeSources.consistencyFromObservations(busy, idle)).toBe('crash_consistent_live');
    expect(volumeSources.consistencyFromObservations(null, idle)).toBe('unknown');
    expect(volumeSources.consistencyFromObservations(idle, null)).toBe('unknown');
  });
});

describe('dependents', () => {
  it('finds a container, the volume label, and a stack whose project name differs from its directory', async () => {
    renderResults.set('stack-dir', { rendered: modelWithVolume('myproject', 'shared_data'), stderr: '', timedOut: false });
    const resolution = await volumeSources.resolveVolumeDependents({
      nodeId: 1,
      ownerNodeKey: ENGINE,
      knownStackNames: ['stack-dir'],
      volumeName: 'shared_data',
      volumeLabels: { 'com.docker.compose.project': 'myproject' },
      render: true,
      docker: fakeDocker(),
    });
    expect(resolution.kind).toBe('resolved');
    if (resolution.kind !== 'resolved') return;
    // The project name resolves to the stack directory, not the project name; the
    // service comes from the container and the label-only row reads as unknown.
    const stacks = new Set(resolution.dependents.map((d) => d.stackName));
    expect([...stacks]).toEqual(['stack-dir']);
    expect(resolution.dependents).toContainEqual({ stackName: 'stack-dir', serviceName: 'db' });
    expect(resolution.mountedByContainer).toBe(true);
  });

  it('covers an external volume declared by a stopped stack', async () => {
    renderResults.set('stopped-stack', { rendered: modelWithVolume('stopped', 'shared_external'), stderr: '', timedOut: false });
    const resolution = await volumeSources.resolveVolumeDependents({
      nodeId: 1,
      ownerNodeKey: ENGINE,
      knownStackNames: ['stopped-stack'],
      volumeName: 'shared_external',
      volumeLabels: {},
      render: true,
      // No container mounts it at all.
      docker: { listContainers: async () => [] } as unknown as Docker,
    });
    expect(resolution.kind).toBe('resolved');
    if (resolution.kind !== 'resolved') return;
    expect(resolution.dependents).toEqual([{ stackName: 'stopped-stack', serviceName: null }]);
    expect(resolution.mountedByContainer).toBe(false);
  });

  it('fails closed when a stack model cannot be rendered', async () => {
    renderResults.set('broken', { rendered: null, stderr: 'syntax error', timedOut: false });
    const resolution = await volumeSources.resolveVolumeDependents({
      nodeId: 1,
      ownerNodeKey: ENGINE,
      knownStackNames: ['broken'],
      volumeName: 'anything',
      volumeLabels: {},
      render: true,
      docker: { listContainers: async () => [] } as unknown as Docker,
    });
    expect(resolution.kind).toBe('unrenderable');
    if (resolution.kind !== 'unrenderable') return;
    expect(resolution.stackName).toBe('broken');
  });

  it('does not render when the caller is only listing', async () => {
    const resolution = await volumeSources.resolveVolumeDependents({
      nodeId: 1,
      ownerNodeKey: ENGINE,
      knownStackNames: ['broken'],
      volumeName: 'a_volume',
      volumeLabels: {},
      render: false,
      docker: fakeDocker(),
    });
    // No render, so an unrenderable stack cannot fail the listing.
    expect(resolution.kind).toBe('resolved');
  });

  it('includes the dependents recorded at the last observation', async () => {
    storageIdentity.StorageIdentityStore.getInstance().observe({
      ownerNodeKey: ENGINE,
      kind: 'named_volume',
      locator: 'recorded_vol',
      generationToken: 't1',
      dependents: [{ stackName: 'was-using-it', serviceName: null }],
    });
    const resolution = await volumeSources.resolveVolumeDependents({
      nodeId: 1,
      ownerNodeKey: ENGINE,
      knownStackNames: [],
      volumeName: 'recorded_vol',
      volumeLabels: {},
      render: false,
      docker: { listContainers: async () => [] } as unknown as Docker,
    });
    expect(resolution.kind).toBe('resolved');
    if (resolution.kind !== 'resolved') return;
    expect(resolution.dependents).toEqual([{ stackName: 'was-using-it', serviceName: null }]);
  });
});
