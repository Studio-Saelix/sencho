/**
 * The restic adapter on a host directory.
 *
 * A capture binds the proven root (the runner starts it through the guard), the
 * mounts below it become `nested_mount` exclusions, and a guard refusal is an
 * identity failure, not a backup failure. A path restore names exactly that path,
 * with restic's glob characters escaped, and only ever into a new volume.
 */
import { describe, expect, it } from 'vitest';
import type { HelperRunSpec } from '../services/recovery/restic/helperRunner';
import { ResticEngine, escapeResticPattern, type ResticHostRootDeps } from '../services/recovery/restic/ResticEngine';
import { ProvenHostRoot } from '../services/recovery/hostRoots';
import { RecoveryError } from '../services/recovery/redaction';
import type { EngineExecutionContext, RestoreIntent, StorageIdentity } from '../services/recovery/types';

const ROOT = ProvenHostRoot.mint('/srv/app/data', '64768', '1234');

type RunResult = { exitCode: number | null; stderrTail: string; aborted: boolean; killed: boolean; guardRefused?: boolean };

function engineWith(run: (spec: HelperRunSpec) => RunResult, hostRoots?: Partial<ResticHostRootDeps>) {
  const specs: HelperRunSpec[] = [];
  const deps: ResticHostRootDeps = {
    prepareSource: async () => ({ root: ROOT, exclusions: [{ path: 'cache', reason: 'nested_mount' }] }),
    readGenerationToken: async () => 'fs|1234|1700000000.000000001',
    observeInUse: async () => ({ inUse: false, liveContainers: [] }),
    ...hostRoots,
  };
  const engine = new ResticEngine({
    runner: {
      run: async (spec: HelperRunSpec) => {
        specs.push(spec);
        const result = run(spec);
        if (result.exitCode === 0 && spec.profile === 'backup') {
          spec.onStdoutLine?.(JSON.stringify({
            message_type: 'summary', snapshot_id: 'snap-fs', total_files_processed: 2, total_bytes_processed: 20, error_count: 0,
          }));
        }
        return result;
      },
    } as never,
    secret: 'sentinel-password',
    helperImageRef: 'sha256:' + 'a'.repeat(64),
    inspectHelperImage: async () => ({ state: 'present' }),
    parentSnapshot: () => null,
    readGenerationToken: async () => 'volume-token',
    observeInUse: async () => ({ inUse: false, liveContainers: [] }),
    repositoryFor: () => ({ id: 'repo', locator: 'repo-volume' }),
    runCheck: async () => ({ result: 'verified' }),
    hostRoots: deps,
  });
  return { engine, specs };
}

const OK: RunResult = { exitCode: 0, stderrTail: '', aborted: false, killed: false };

function context(): EngineExecutionContext {
  return {
    operationId: 'op-1',
    pointId: 'point-1',
    lock: { scope: 'repository', resourceKey: 'repo', ownerOperationId: 'op-1', processEpoch: 'e', acquiredAt: 1, staleSince: null },
    signal: new AbortController().signal,
    onProgress: () => undefined,
  };
}

const STORAGE: StorageIdentity = {
  id: 'storage', authorityId: 'a', ownerNodeKey: 'docker-engine:a', kind: 'bind_root', locator: '/srv/app/data',
  storageKey: 'k'.repeat(64), generation: 1, generationToken: 'fs|1234|1700000000.000000001', lineageParentId: null,
  state: 'current', firstSeenAt: 1, lastSeenAt: 1,
};

const REPOSITORY = {
  id: 'repo', authorityId: 'a', ownerNodeKey: 'docker-engine:a', kind: 'local_volume' as const, locator: 'repo-volume',
  repositoryFingerprint: null, failureDomain: 'same_failure_domain' as const, secretState: 'stored' as const, createdAt: 1,
};

function capture(engine: ResticEngine) {
  return engine.createPoint({ storage: STORAGE, repository: REPOSITORY, trigger: 'manual', actor: 'admin', kind: 'root' }, context());
}

describe('a host directory capture', () => {
  it('binds the proven root and records the mounts below it as nested_mount exclusions', async () => {
    const { engine, specs } = engineWith(() => OK);
    const result = await capture(engine);
    expect(result.ok).toBe(true);
    const backup = specs.find((spec) => spec.profile === 'backup')!;
    expect(backup.mounts.source).toBe(ROOT);
    expect(result.ok && result.evidence.exclusions).toEqual([{ path: 'cache', reason: 'nested_mount' }]);
  });

  it('ends identity_unknown when the guard refuses the root, and records no snapshot', async () => {
    const { engine } = engineWith((spec) => (spec.profile === 'backup' ? { ...OK, exitCode: 86, guardRefused: true } : OK));
    expect(await capture(engine)).toEqual({ ok: false, errorClass: 'identity_unknown' });
  });

  it('records nothing when the proof fails, and refuses a directory recreated while it was read', async () => {
    const unproven = engineWith(() => OK, {
      prepareSource: async () => { throw new RecoveryError('identity_unknown', { reason: 'path_mapping_unproven' }); },
    });
    expect(await capture(unproven.engine)).toEqual({ ok: false, errorClass: 'identity_unknown' });
    expect(unproven.specs).toHaveLength(0);
    const recreated = engineWith(() => OK, { readGenerationToken: async () => 'fs|9999|1700000000.000000001' });
    expect(await capture(recreated.engine)).toEqual({ ok: false, errorClass: 'identity_unknown' });
  });

  it('labels the capture live when a container that writes the directory runs during it', async () => {
    const { engine } = engineWith(() => OK, { observeInUse: async () => ({ inUse: true, liveContainers: ['app'] }) });
    const result = await capture(engine);
    expect(result.ok && result.evidence.consistency).toBe('crash_consistent_live');
  });

  it('refuses a host directory on an engine built only for volumes', async () => {
    const engine = new ResticEngine({
      runner: { run: async () => OK } as never,
      secret: 's',
      helperImageRef: 'sha256:' + 'a'.repeat(64),
      inspectHelperImage: async () => ({ state: 'present' }),
      parentSnapshot: () => null,
      readGenerationToken: async () => 't',
      observeInUse: async () => ({ inUse: false, liveContainers: [] }),
      repositoryFor: () => ({ id: 'repo', locator: 'repo-volume' }),
      runCheck: async () => ({ result: 'verified' }),
    });
    expect(await capture(engine)).toEqual({ ok: false, errorClass: 'capability_unavailable' });
  });
});

function intent(target: RestoreIntent['target'], pathScope: string | null = null): RestoreIntent {
  return {
    id: '4f3a2b1c-0d9e-4a8b-9c7d-6e5f4a3b2c1d', operationId: 'op-1', pointId: 'point-1', repositoryId: 'repo',
    snapshotId: 'snap-1', target, pathScope, phase: 'staging', actor: 'admin', createdAt: 1,
  };
}

describe('a path restore', () => {
  it('restores exactly the path, with its glob characters escaped', async () => {
    const { engine, specs } = engineWith(() => OK);
    await engine.restore(intent({ mode: 'new_volume', volumeName: 'restored' }, 'logs/[2026]*.log'), context());
    const cmd = specs[0].cmd as string[];
    expect(cmd).toContain('--include');
    expect(cmd[cmd.indexOf('--include') + 1]).toBe('/logs/\\[2026\\]\\*.log');
    expect(escapeResticPattern('a?b\\c')).toBe('a\\?b\\\\c');
  });

  it('never restores one path over a live target', async () => {
    const { engine, specs } = engineWith(() => OK);
    const result = await engine.restore(intent({
      mode: 'staged_overwrite', storageId: 's', expectedGenerationToken: 't',
      workDir: '.sencho-restore-4f3a2b1c-0d9e-4a8b-9c7d-6e5f4a3b2c1d/incoming', volumeName: 'v',
    }, 'one/path'), context());
    expect(result).toEqual({ ok: false, errorClass: 'invalid_request' });
    expect(specs).toHaveLength(0);
  });
});

describe('an overwrite of a host directory', () => {
  const STAGED = {
    mode: 'staged_overwrite' as const, storageId: 's', expectedGenerationToken: 't',
    workDir: '.sencho-restore-4f3a2b1c-0d9e-4a8b-9c7d-6e5f4a3b2c1d/incoming', volumeName: 'fs:abc', hostRoot: ROOT,
  };

  it('writes the work directory through the proven root on the materialize profile', async () => {
    const { engine, specs } = engineWith(() => OK);
    await engine.restore(intent(STAGED), context());
    expect(specs[0]).toMatchObject({ profile: 'materialize' });
    expect(specs[0].mounts.target).toBe(ROOT);
  });

  it('ends identity_unknown when the guard refuses the root', async () => {
    const { engine } = engineWith(() => ({ ...OK, exitCode: 86, guardRefused: true }));
    expect(await engine.restore(intent(STAGED), context())).toEqual({ ok: false, errorClass: 'identity_unknown' });
  });
});
