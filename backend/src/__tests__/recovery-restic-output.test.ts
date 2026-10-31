/**
 * The pinned helper reference and restic's reported results, in Sencho's terms.
 *
 * Both are pure: a reference is a string and a result is an exit code plus
 * newline-delimited JSON. That means the whole mapping table can be pinned here,
 * including the cases that must never read as success.
 */
import { describe, it, expect } from 'vitest';
import Docker from 'dockerode';
import {
  RECOVERY_HELPER_IMAGE_ENV,
  inspectHelperImage,
  parseHelperImageRef,
  pullHelperImage,
  resolveHelperImageRef,
} from '../services/recovery/restic/helperImage';
import {
  MAX_STORED_EXCLUSIONS,
  applyBackupLine,
  applyRestoreLine,
  classifyBackupRun,
  classifyBackupError,
  classifyCheckRun,
  classifyRestoreRun,
  isScratchSpaceError,
  newBackupAccumulator,
  newRestoreAccumulator,
  parseRepositoryConfig,
  toRelativeExclusionPath,
} from '../services/recovery/restic/resticOutput';

const DIGEST = 'sha256:' + 'b'.repeat(64);

describe('recovery helper image reference', () => {
  it('accepts a registry digest and a bare image id, and nothing else', () => {
    expect(parseHelperImageRef(`ghcr.io/studio-saelix/sencho-recovery-helper@${DIGEST}`))
      .toEqual({ kind: 'pinned', ref: `ghcr.io/studio-saelix/sencho-recovery-helper@${DIGEST}` });
    expect(parseHelperImageRef(DIGEST)).toEqual({ kind: 'pinned', ref: DIGEST });
    expect(parseHelperImageRef('ghcr.io/studio-saelix/sencho-recovery-helper:1.2.3'))
      .toEqual({ kind: 'unpinned', reason: 'not_digest' });
    expect(parseHelperImageRef('saelix/sencho-recovery-helper:latest'))
      .toEqual({ kind: 'unpinned', reason: 'not_digest' });
    expect(parseHelperImageRef('')).toEqual({ kind: 'unpinned', reason: 'missing' });
    expect(parseHelperImageRef(undefined)).toEqual({ kind: 'unpinned', reason: 'missing' });
    // A 63-character digest is not a digest.
    expect(parseHelperImageRef('repo@sha256:' + 'c'.repeat(63)).kind).toBe('unpinned');
  });

  it('reads the pin from the environment only', () => {
    expect(resolveHelperImageRef({} as NodeJS.ProcessEnv).kind).toBe('unpinned');
    expect(resolveHelperImageRef({ [RECOVERY_HELPER_IMAGE_ENV]: DIGEST }))
      .toEqual({ kind: 'pinned', ref: DIGEST });
  });

  it('reports the image absent without pulling it', async () => {
    let pulled = false;
    const docker = {
      getImage: () => ({
        inspect: async () => {
          const err = Object.assign(new Error('no such image'), { statusCode: 404 });
          throw err;
        },
      }),
      pull: () => { pulled = true; },
    };
    const state = await inspectHelperImage(docker as unknown as Docker, parseHelperImageRef(DIGEST));
    expect(state).toEqual({ state: 'missing', ref: DIGEST });
    expect(pulled).toBe(false);
  });

  it('refuses to pull an image id, which no registry can resolve', async () => {
    await expect(pullHelperImage({} as Docker, DIGEST)).rejects.toThrow();
  });
});

describe('restic backup output', () => {
  function feed(lines: string[]) {
    const accumulator = newBackupAccumulator();
    for (const line of lines) applyBackupLine(accumulator, line);
    return accumulator;
  }

  it('reads the summary, the counts and the snapshot id', () => {
    const accumulator = feed([
      JSON.stringify({ message_type: 'status', files_done: 3, bytes_done: 30, total_bytes: 100 }),
      JSON.stringify({
        message_type: 'summary',
        files_new: 1,
        files_changed: 2,
        total_files_processed: 3,
        total_bytes_processed: 30,
        snapshot_id: 'abcdef123456',
        error_count: 0,
      }),
    ]);
    expect(accumulator.filesDone).toBe(3);
    expect(accumulator.bytesTotal).toBe(100);
    expect(accumulator.summary).toEqual({
      snapshotId: 'abcdef123456',
      filesProcessed: 3,
      bytesProcessed: 30,
      errorCount: 0,
    });
  });

  it('turns each error item into an exclusion with the right reason', () => {
    const accumulator = feed([
      JSON.stringify({ message_type: 'error', error: { message: 'open /data/a: permission denied' }, item: '/data/a', during: 'archival' }),
      JSON.stringify({ message_type: 'error', error: { message: 'no such file or directory' }, item: '/data/b', during: 'archival' }),
      JSON.stringify({ message_type: 'error', error: { message: 'input/output error' }, item: '/data/c', during: 'archival' }),
      // Outside the mount: counted, never stored.
      JSON.stringify({ message_type: 'error', error: { message: 'failure' }, item: '/elsewhere/d', during: 'scan' }),
      'not json at all',
    ]);
    expect(accumulator.skippedCount).toBe(4);
    expect(accumulator.exclusions).toEqual([
      { path: 'a', reason: 'permission_denied' },
      { path: 'b', reason: 'vanished' },
      { path: 'c', reason: 'unreadable' },
    ]);
  });

  it('caps stored exclusions and keeps the real count', () => {
    const lines: string[] = [];
    for (let i = 0; i < MAX_STORED_EXCLUSIONS + 25; i += 1) {
      lines.push(JSON.stringify({ message_type: 'error', error: { message: 'permission denied' }, item: `/data/f${i}` }));
    }
    const accumulator = feed(lines);
    expect(accumulator.exclusions).toHaveLength(MAX_STORED_EXCLUSIONS);
    expect(accumulator.skippedCount).toBe(MAX_STORED_EXCLUSIONS + 25);
  });

  it('classifies the error message, never guessing permission', () => {
    expect(classifyBackupError('permission denied')).toBe('permission_denied');
    expect(classifyBackupError('lstat /data/x: no such file')).toBe('vanished');
    expect(classifyBackupError('something else')).toBe('unreadable');
  });

  it('refuses a path that would escape the root', () => {
    expect(toRelativeExclusionPath('/data/a/b')).toBe('a/b');
    expect(toRelativeExclusionPath('/data/../etc/passwd')).toBeNull();
    expect(toRelativeExclusionPath('/data')).toBeNull();
    expect(toRelativeExclusionPath('/other/x')).toBeNull();
  });

  it('maps every exit code to the documented outcome', () => {
    const partial = feed([JSON.stringify({ message_type: 'error', error: { message: 'permission denied' }, item: '/data/x' })]);
    const clean = feed([JSON.stringify({ message_type: 'summary', snapshot_id: 's', total_files_processed: 1, total_bytes_processed: 1 })]);
    const run = (exitCode: number | null, opts: Partial<{ aborted: boolean; killed: boolean; accumulator: typeof clean; stderrTail: string }> = {}) =>
      classifyBackupRun({
        exitCode,
        aborted: opts.aborted ?? false,
        killed: opts.killed ?? false,
        accumulator: opts.accumulator ?? clean,
        stderrTail: opts.stderrTail ?? '',
      });

    expect(run(0)).toEqual({ status: 'succeeded' });
    expect(run(0, { accumulator: partial })).toEqual({ status: 'partial', errorClass: 'source_unreadable' });
    expect(run(3, { accumulator: partial })).toEqual({ status: 'partial', errorClass: 'source_unreadable' });
    expect(run(130)).toEqual({ status: 'cancelled' });
    expect(run(null, { aborted: true })).toEqual({ status: 'cancelled' });
    expect(run(10)).toEqual({ status: 'failed', errorClass: 'repository_unavailable' });
    expect(run(11)).toEqual({ status: 'failed', errorClass: 'lock_held' });
    expect(run(12)).toEqual({ status: 'failed', errorClass: 'repository_key_unavailable' });
    expect(run(1, { stderrTail: 'write /repo: no space left on device' }))
      .toEqual({ status: 'failed', errorClass: 'repository_unavailable' });
    expect(run(null, { killed: true })).toEqual({ status: 'failed', errorClass: 'node_error' });
  });

  it('does not report a full helper scratch as an unreachable repository', () => {
    // restic names the file it could not write; a temporary pack under /tmp is the
    // helper's own scratch, which says nothing about the repository.
    const scratchFull = 'Fatal: unable to save snapshot: Write: write /tmp/restic-temp-pack-1085925781: no space left on device';
    expect(isScratchSpaceError(scratchFull)).toBe(true);
    expect(isScratchSpaceError('{"message":"failed to save /data/a: Write: write /tmp/restic-temp-pack-1: no space left on device"}')).toBe(true);
    expect(isScratchSpaceError('write /repo/data/ab/abcdef: no space left on device')).toBe(false);
    // A source file whose own path contains /tmp is not the helper's scratch.
    expect(isScratchSpaceError('write /repo/data/x: no space left on device (source /data/tmp/file)')).toBe(false);
    expect(isScratchSpaceError('write /tmp/restic-temp-pack-1: permission denied')).toBe(false);

    const clean = feed([JSON.stringify({ message_type: 'summary', snapshot_id: 's', total_files_processed: 1, total_bytes_processed: 1 })]);
    expect(classifyBackupRun({ exitCode: 1, aborted: false, killed: false, accumulator: clean, stderrTail: scratchFull }))
      .toEqual({ status: 'failed', errorClass: 'node_error' });
    expect(classifyCheckRun({ exitCode: 2, aborted: false, killed: false, stderrTail: scratchFull }))
      .toEqual({ result: 'error', errorClass: 'node_error' });
    // The same disk-full text about the repository volume still reads as the repository.
    expect(classifyCheckRun({ exitCode: 2, aborted: false, killed: false, stderrTail: 'write /repo/data/x: no space left on device' }))
      .toEqual({ result: 'error', errorClass: 'repository_unavailable' });
  });
});

describe('restic restore and check output', () => {
  it('reads restore counts and separates xattr failures from content failures', () => {
    const accumulator = newRestoreAccumulator();
    applyRestoreLine(accumulator, JSON.stringify({ message_type: 'status', files_restored: 5, bytes_restored: 500 }));
    applyRestoreLine(accumulator, JSON.stringify({
      message_type: 'error',
      error: { message: 'setxattr: operation not permitted' },
      item: '/restore/bin/ping',
    }));
    expect(accumulator.filesRestored).toBe(5);
    expect(accumulator.bytesRestored).toBe(500);
    expect(accumulator.xattrErrors).toBe(1);
    expect(accumulator.contentErrors).toBe(0);
  });

  it('reports an xattr-only failure as partial and a content failure as failed', () => {
    const xattr = newRestoreAccumulator();
    xattr.xattrErrors = 2;
    expect(classifyRestoreRun({ exitCode: 0, aborted: false, killed: false, accumulator: xattr, stderrTail: '' }))
      .toEqual({ status: 'partial', xattrWarnings: 2 });

    const content = newRestoreAccumulator();
    content.contentErrors = 1;
    expect(classifyRestoreRun({ exitCode: 1, aborted: false, killed: false, accumulator: content, stderrTail: '' }))
      .toEqual({ status: 'failed', errorClass: 'node_error' });

    expect(classifyRestoreRun({ exitCode: null, aborted: true, killed: false, accumulator: newRestoreAccumulator(), stderrTail: '' }))
      .toEqual({ status: 'cancelled' });
  });

  it('never treats a check that could not run as verified', () => {
    expect(classifyCheckRun({ exitCode: 0, aborted: false, killed: false, stderrTail: '' })).toEqual({ result: 'verified' });
    expect(classifyCheckRun({ exitCode: 1, aborted: false, killed: false, stderrTail: '' })).toEqual({ result: 'mismatch' });
    expect(classifyCheckRun({ exitCode: 12, aborted: false, killed: false, stderrTail: '' }))
      .toEqual({ result: 'error', errorClass: 'repository_key_unavailable' });
    expect(classifyCheckRun({ exitCode: null, aborted: false, killed: true, stderrTail: '' }))
      .toEqual({ result: 'error', errorClass: 'interrupted' });
  });

  it('reads a repository config id, and nothing that is not one', () => {
    expect(parseRepositoryConfig('{"version":2,"id":"a'.concat('0'.repeat(31), '","chunker_polynomial":"x"}'))).toEqual({
      id: 'a' + '0'.repeat(31),
    });
    expect(parseRepositoryConfig('{"version":2,"id":"short"}')).toBeNull();
    expect(parseRepositoryConfig('restic 0.19.1')).toBeNull();
  });
});
