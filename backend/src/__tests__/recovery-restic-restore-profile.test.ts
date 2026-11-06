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
import { isRecoveryWorkDirName, RECOVERY_WORK_DIR_GLOB } from '../services/recovery/restoreIntents';
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

  it('redacts the repository password and strips control characters from what restic printed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { engine } = engineWith(async (spec) => {
      // A file name a workload wrote can carry control bytes, and a misbehaving
      // build could echo the password it read from stdin.
      spec.onStderrLine?.(JSON.stringify({
        message_type: 'error',
        item: '/restore/evil\u001b[2Jname\tfile',
        error: { message: 'unable to write: password sentinel-password was rejected' },
      }));
      return {
        exitCode: 1,
        stderrTail: 'Fatal: repository password sentinel-password\u0000 is wrong\n',
        aborted: false,
        killed: false,
      };
    });
    await engine.restore(intent(STAGED), context());
    const line = warn.mock.calls.map((call) => format(...call)).find((text) => text.includes('Restore helper'));
    expect(line).toBeDefined();
    expect(line).not.toContain('sentinel-password');
    expect(line).toContain('[redacted]');
    expect(line).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/);
  });

  it('keeps the end of stderr, where a fatal error lands, when restic reported many items', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { engine } = engineWith(async (spec) => {
      for (let i = 0; i < 5; i += 1) {
        spec.onStderrLine?.(JSON.stringify({
          message_type: 'error', item: `/restore/file-${i}`, error: { message: 'x'.repeat(190) },
        }));
      }
      return { exitCode: 1, stderrTail: 'Fatal: the fatal line\n', aborted: false, killed: false };
    });
    await engine.restore(intent(STAGED), context());
    const line = warn.mock.calls.map((call) => format(...call)).find((text) => text.includes('Restore helper'));
    expect(line).toContain('the fatal line');
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

describe('what a restore leaves out', () => {
  // A point captured before the capture skipped work directories can carry one at
  // its root. Putting it into a new volume would make that volume refuse its first
  // overwrite, and into the live volume would leave a second work directory there.
  it('leaves a root work directory out of a restore into a new volume, and only a root one', async () => {
    const { engine, specs } = engineWith(async () => OK);
    await engine.restore(intent({ mode: 'new_volume', volumeName: 'fresh' }), context());
    const args = specs[0].cmd as readonly string[];
    expect(args).toContain('snap-1:/data');
    const at = args.indexOf('--exclude');
    expect(args[at + 1]).toBe(`/${RECOVERY_WORK_DIR_GLOB}`);
    expect(args.filter((arg) => arg === '--exclude')).toHaveLength(1);
  });

  it('leaves a root work directory out of the copy an overwrite restores into the volume', async () => {
    const { engine, specs } = engineWith(async () => OK);
    await engine.restore(intent(STAGED), context());
    const args = specs[0].cmd as readonly string[];
    const at = args.indexOf('--exclude');
    expect(args[at + 1]).toBe(`/data/${RECOVERY_WORK_DIR_GLOB}`);
    expect(args.filter((arg) => arg === '--exclude')).toHaveLength(1);
  });

  // The exclusion is by name, so it must match only the name Sencho makes. A
  // user's `.sencho-restore-notes/`, `.sencho-restore-x.txt`, or a 36-character
  // name that is not the lower-case hex intent id is data.
  it('matches only an intent-id work directory name', () => {
    const glob = (text: string): RegExp => {
      let body = '';
      for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (char === '[') {
          // A filepath.Match character class is copied as-is; everything else is
          // one literal character.
          const end = text.indexOf(']', i + 1);
          body += text.slice(i, end + 1);
          i = end;
        } else if ('\\.^$|+(){}*?'.includes(char)) {
          body += `\\${char}`;
        } else {
          body += char;
        }
      }
      return new RegExp(`^${body}$`);
    };
    const matches = glob(RECOVERY_WORK_DIR_GLOB);
    expect(matches.test(`.sencho-restore-${INTENT_ID}`)).toBe(true);
    expect(matches.test('.sencho-restore-notes')).toBe(false);
    expect(matches.test('.sencho-restore-x.txt')).toBe(false);
    expect(matches.test('.sencho-restore-ZZZZZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZZZZZZZZZ')).toBe(false);
    expect(matches.test('sub/.sencho-restore-' + INTENT_ID)).toBe(false);
    expect(isRecoveryWorkDirName(`.sencho-restore-${INTENT_ID}`)).toBe(true);
    expect(isRecoveryWorkDirName('.sencho-restore-notes')).toBe(false);
    expect(isRecoveryWorkDirName('.sencho-restore-x.txt')).toBe(false);
    expect(isRecoveryWorkDirName('.sencho-restore-ZZZZZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZZZZZZZZZ')).toBe(false);
  });
});

describe('what a capture leaves out', () => {
  const REQUEST = {
    kind: 'root',
    storage: { kind: 'named_volume', locator: 'live-volume', storageKey: 'k'.repeat(64), generation: 1, generationToken: 'token' },
    repository: { id: 'repo', locator: 'repo-volume' },
    trigger: 'manual',
    actor: 'admin',
  } as never;

  // A work directory left by a restore that did not settle holds the replaced data and a
  // copy of the restored data. A point that carried it would put it back on a restore, and
  // every later overwrite of that volume would refuse it.
  it('excludes the restore work directories at the volume root, and only there', async () => {
    const { engine, specs } = engineWith(async (spec) => {
      expect(spec.profile).toBe('backup');
      return { ...OK, aborted: true };
    });
    await engine.createPoint(REQUEST, context());
    expect(specs).toHaveLength(1);
    const args = specs[0].cmd as readonly string[];
    const at = args.indexOf('--exclude');
    expect(at).toBeGreaterThan(-1);
    expect(args[at + 1]).toBe(`/data/${RECOVERY_WORK_DIR_GLOB}`);
    expect(args.filter((arg) => arg === '--exclude')).toHaveLength(1);
    expect(args.indexOf('/data')).toBeLessThan(at);
  });
});
