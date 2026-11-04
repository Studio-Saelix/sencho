/**
 * Which helper profile a restore runs under, and what a failed one leaves in the
 * log.
 *
 * A staged overwrite writes into a work directory inside the live volume, whose
 * root an application can own and close to everyone else (a PostgreSQL or Redis
 * data directory). Root without DAC_OVERRIDE is "other" on that directory, so the
 * step needs the `materialize` profile; a restore into a new volume writes a root
 * Sencho made and stays on the narrower `restore` profile.
 */
import { format } from 'util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HELPER_PROFILES, type HelperRunSpec } from '../services/recovery/restic/helperRunner';
import { ResticEngine } from '../services/recovery/restic/ResticEngine';
import type { EngineExecutionContext, RestoreIntent } from '../services/recovery/types';

const INTENT_ID = '4f3a2b1c-0d9e-4a8b-9c7d-6e5f4a3b2c1d';

function engineWith(run: (spec: HelperRunSpec) => Promise<{
  exitCode: number | null; stderrTail: string; aborted: boolean; killed: boolean;
}>) {
  const specs: HelperRunSpec[] = [];
  const engine = new ResticEngine({
    runner: {
      run: async (spec: HelperRunSpec) => {
        specs.push(spec);
        return run(spec);
      },
    } as never,
    secret: 'sentinel-password',
    helperImageRef: 'sha256:' + 'a'.repeat(64),
    inspectHelperImage: async () => ({ state: 'present' }),
    parentSnapshot: () => null,
    readGenerationToken: async () => 'token',
    observeInUse: async () => ({ state: 'unknown' }) as never,
    repositoryFor: () => ({ id: 'repo', locator: 'repo-volume' }),
    runCheck: async () => ({ result: 'verified' }),
  });
  return { engine, specs };
}

function context(): EngineExecutionContext {
  return {
    operationId: 'op-1',
    pointId: 'point-1',
    lock: {
      scope: 'repository', resourceKey: 'repo', ownerOperationId: 'op-1',
      processEpoch: 'e', acquiredAt: 1, staleSince: null,
    },
    signal: new AbortController().signal,
    onProgress: () => undefined,
  };
}

function intent(target: RestoreIntent['target']): RestoreIntent {
  return {
    id: INTENT_ID,
    operationId: 'op-1',
    pointId: 'point-1',
    repositoryId: 'repo',
    snapshotId: 'snap-1',
    target,
    pathScope: null,
    phase: 'materializing',
    actor: 'admin',
    createdAt: 1,
  } as RestoreIntent;
}

const STAGED = {
  mode: 'staged_overwrite',
  storageId: 'storage',
  expectedGenerationToken: 'token',
  workDir: `.sencho-restore-${INTENT_ID}/incoming`,
  volumeName: 'live-volume',
} as const;

const OK = { exitCode: 0, stderrTail: '', aborted: false, killed: false };

afterEach(() => vi.restoreAllMocks());

describe('the profile a restore runs under', () => {
  it('runs the in-volume step of an overwrite as materialize, with DAC_OVERRIDE', async () => {
    const { engine, specs } = engineWith(async () => OK);
    const result = await engine.restore(intent(STAGED), context());
    expect(result.ok).toBe(true);
    expect(specs).toHaveLength(1);
    expect(specs[0].profile).toBe('materialize');
    expect(HELPER_PROFILES[specs[0].profile].capAdd).toContain('DAC_OVERRIDE');
    expect(specs[0].mounts).toEqual({ repository: 'repo-volume', target: 'live-volume' });
  });

  it('keeps a restore into a new volume on the narrower restore profile', async () => {
    const { engine, specs } = engineWith(async () => OK);
    await engine.restore(intent({ mode: 'new_volume', volumeName: 'fresh' }), context());
    expect(specs[0].profile).toBe('restore');
    expect(HELPER_PROFILES.restore.capAdd).not.toContain('DAC_OVERRIDE');
  });
});

describe('a failed restore helper', () => {
  it('logs why, from the helper stderr, and still answers the class only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { engine } = engineWith(async () => ({
      exitCode: 1,
      stderrTail: `Fatal: cannot create target directory: mkdir /restore/.sencho-restore-${INTENT_ID}: permission denied\n`,
      aborted: false,
      killed: false,
    }));
    const result = await engine.restore(intent(STAGED), context());

    expect(result).toEqual({ ok: false, errorClass: 'node_error' });
    const lines = warn.mock.calls.map((call) => format(...call));
    const line = lines.find((text) => text.includes('Restore helper'));
    expect(line).toBeDefined();
    expect(line).toContain('materialize');
    expect(line).toContain('node_error');
    expect(line).toContain('exit 1');
    expect(line).toContain('permission denied');
    expect(line).not.toContain('sentinel-password');
  });

  it('logs a restore into a new volume the same way', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { engine } = engineWith(async () => ({
      exitCode: 1, stderrTail: 'Fatal: no space left on device\n', aborted: false, killed: false,
    }));
    await engine.restore(intent({ mode: 'new_volume', volumeName: 'fresh' }), context());
    const lines = warn.mock.calls.map((call) => format(...call));
    expect(lines.some((text) => text.includes('(restore)') && text.includes('no space left on device'))).toBe(true);
  });

  it('logs a failed capture, which is how a pre-restore point fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { engine } = engineWith(async () => ({
      exitCode: 1, stderrTail: 'Fatal: unable to open repository\n', aborted: false, killed: false,
    }));
    const result = await engine.createPoint(
      {
        storage: {
          id: 's', authorityId: 'a', ownerNodeKey: 'n', kind: 'named_volume', locator: 'live-volume',
          storageKey: 'k', generation: 1, generationToken: 'token', lineageParentId: null,
          state: 'current', firstSeenAt: 1, lastSeenAt: 1,
        },
        repository: { id: 'repo', locator: 'repo-volume' } as never,
        trigger: 'pre_restore',
        actor: 'admin',
        kind: 'root',
      },
      { ...context(), pointId: 'point-1' },
    );
    expect(result.ok).toBe(false);
    const lines = warn.mock.calls.map((call) => format(...call));
    expect(lines.some((text) => text.includes('Backup helper') && text.includes('unable to open repository'))).toBe(true);
  });

  it('does not log a cancel as a failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { engine } = engineWith(async () => ({ exitCode: null, stderrTail: '', aborted: true, killed: false }));
    const result = await engine.restore(intent(STAGED), context());
    expect(result).toEqual({ ok: false, errorClass: 'interrupted' });
    expect(warn).not.toHaveBeenCalled();
  });
});
