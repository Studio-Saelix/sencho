import path from 'path';
import { canonicalizePathScope } from '../recoveryPoints';
import { HELPER_SOURCE_MOUNT } from './helperRunner';
import type { ExclusionReason, PointExclusion } from '../types';

/**
 * restic's reported results, mapped to Sencho's vocabulary.
 *
 * Pure: every function here takes text or an exit code and answers with a
 * status, a count or a class. Nothing is logged and nothing is stored, so the
 * mapping table can be read and tested without a daemon.
 *
 * Exit codes are restic's own contract:
 *   0  success
 *   3  the backup ran but some source data could not be read
 *   10 the repository does not exist
 *   11 the repository is already locked
 *   12 the password is wrong
 *   130 interrupted
 * Everything else is a failure whose class depends on what the daemon reported.
 */

/** Most exclusion paths stored on one point. The count keeps the real total. */
export const MAX_STORED_EXCLUSIONS = 200;

export interface ResticBackupSummary {
  snapshotId: string;
  filesProcessed: number;
  bytesProcessed: number;
  errorCount: number;
}

export interface BackupAccumulator {
  summary: ResticBackupSummary | null;
  /** Paths left out, relative to the storage root, capped at MAX_STORED_EXCLUSIONS. */
  exclusions: PointExclusion[];
  /** Every path restic reported, including the ones past the cap. */
  skippedCount: number;
  /** Status lines, for progress only. */
  filesDone: number;
  bytesDone: number;
  bytesTotal: number | null;
}

export function newBackupAccumulator(): BackupAccumulator {
  return { summary: null, exclusions: [], skippedCount: 0, filesDone: 0, bytesDone: 0, bytesTotal: null };
}

interface JsonRecord {
  message_type?: unknown;
  [key: string]: unknown;
}

function asRecord(line: string): JsonRecord | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as JsonRecord;
  } catch {
    return null;
  }
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Why restic could not read one path, in Sencho's terms. A permission refusal is
 * the operator's to fix; a file that went away during the capture is not an
 * error in the data that was read; anything else is unreadable.
 */
export function classifyBackupError(message: string): ExclusionReason {
  const text = message.toLowerCase();
  if (text.includes('permission denied')) return 'permission_denied';
  if (text.includes('no such file or directory') || text.includes('lstat') || text.includes('file does not exist')) {
    return 'vanished';
  }
  return 'unreadable';
}

/**
 * A restic path turned into a root-relative scope. Anything outside the source
 * mount, and anything that would escape it, is dropped: the exclusion list
 * describes the captured root, not the mount layout.
 */
export function toRelativeExclusionPath(item: string, mount: string = HELPER_SOURCE_MOUNT): string | null {
  if (typeof item !== 'string' || item === '') return null;
  if (!item.startsWith(`${mount}/`)) return null;
  const relative = item.slice(mount.length + 1);
  if (relative === '') return null;
  try {
    return canonicalizePathScope(relative);
  } catch {
    return null;
  }
}

/** Fold one stdout line into the accumulator. */
export function applyBackupLine(accumulator: BackupAccumulator, line: string): void {
  const record = asRecord(line);
  if (!record) return;
  switch (record.message_type) {
    case 'status': {
      accumulator.filesDone = num(record.files_done);
      accumulator.bytesDone = num(record.bytes_done);
      accumulator.bytesTotal = typeof record.total_bytes === 'number' ? num(record.total_bytes) : null;
      return;
    }
    case 'summary': {
      const snapshotId = typeof record.snapshot_id === 'string' ? record.snapshot_id : '';
      accumulator.summary = {
        snapshotId,
        filesProcessed: num(record.total_files_processed),
        bytesProcessed: num(record.total_bytes_processed),
        errorCount: num(record.error_count),
      };
      return;
    }
    case 'error': {
      accumulator.skippedCount += 1;
      const error = record.error as { message?: unknown } | undefined;
      const message = typeof error?.message === 'string' ? error.message : '';
      const item = typeof record.item === 'string' ? record.item : '';
      if (accumulator.exclusions.length >= MAX_STORED_EXCLUSIONS) return;
      const relative = toRelativeExclusionPath(item);
      if (relative === null) return;
      accumulator.exclusions.push({ path: relative, reason: classifyBackupError(message) });
      return;
    }
    default:
      return;
  }
}

export type BackupOutcome =
  | { status: 'succeeded' }
  | { status: 'partial'; errorClass: 'source_unreadable' }
  | { status: 'cancelled' }
  | { status: 'failed'; errorClass: import('../types').RecoveryErrorClass };

/**
 * What a finished backup process means. A run that reported a summary and exited
 * 3 is a real capture with gaps: `partial`, never failed, because the data it did
 * read is in the repository and usable.
 */
export function classifyBackupRun(input: {
  exitCode: number | null;
  aborted: boolean;
  killed: boolean;
  accumulator: BackupAccumulator;
  stderrTail: string;
}): BackupOutcome {
  if (input.aborted) return { status: 'cancelled' };
  if (input.killed) return { status: 'failed', errorClass: 'node_error' };
  switch (input.exitCode) {
    case 0:
      return input.accumulator.skippedCount > 0
        ? { status: 'partial', errorClass: 'source_unreadable' }
        : { status: 'succeeded' };
    case 3:
      return { status: 'partial', errorClass: 'source_unreadable' };
    case 130:
      return { status: 'cancelled' };
    case 10:
      return { status: 'failed', errorClass: 'repository_unavailable' };
    case 11:
      return { status: 'failed', errorClass: 'lock_held' };
    case 12:
      return { status: 'failed', errorClass: 'repository_key_unavailable' };
    default:
      if (/no space left on device|enospc/i.test(input.stderrTail)) {
        return { status: 'failed', errorClass: 'repository_unavailable' };
      }
      return { status: 'failed', errorClass: 'node_error' };
  }
}

export interface RestoreAccumulator {
  filesRestored: number;
  bytesRestored: number;
  /** Errors restic reported while restoring, classified by whether they mean content. */
  contentErrors: number;
  xattrErrors: number;
  /** First few error items, for the node-local log only. */
  sampleErrors: string[];
}

export function newRestoreAccumulator(): RestoreAccumulator {
  return { filesRestored: 0, bytesRestored: 0, contentErrors: 0, xattrErrors: 0, sampleErrors: [] };
}

/**
 * Extended-attribute failures the restore cannot fix from inside the file
 * system: file capabilities (`security.capability`) and SELinux labels
 * (`security.selinux`, `trusted.*`). They do not mean a file is missing or
 * wrong, so they downgrade a restore to `partial` instead of failing it.
 */
export function isExtendedAttributeError(message: string, item: string): boolean {
  const text = `${message} ${item}`.toLowerCase();
  if (!/extended attribute|xattr|setxattr|lsetxattr|security\.|trusted\./.test(text)) return false;
  return /operation not permitted|permission denied|not supported|cannot set|failed to set/.test(text);
}

export function applyRestoreLine(accumulator: RestoreAccumulator, line: string): void {
  const record = asRecord(line);
  if (!record) return;
  switch (record.message_type) {
    case 'status':
    case 'summary': {
      accumulator.filesRestored = num(record.files_restored);
      accumulator.bytesRestored = num(record.bytes_restored);
      return;
    }
    case 'error': {
      const error = record.error as { message?: unknown } | undefined;
      const message = typeof error?.message === 'string' ? error.message : '';
      const item = typeof record.item === 'string' ? record.item : '';
      if (isExtendedAttributeError(message, item)) accumulator.xattrErrors += 1;
      else accumulator.contentErrors += 1;
      if (accumulator.sampleErrors.length < 5) {
        accumulator.sampleErrors.push(`${item}: ${message}`.slice(0, 200));
      }
      return;
    }
    default:
      return;
  }
}

export type RestoreOutcome =
  | { status: 'restored' }
  /** Only extended-attribute sets failed: the files are there, some metadata is not. */
  | { status: 'partial'; xattrWarnings: number }
  | { status: 'cancelled' }
  | { status: 'failed'; errorClass: import('../types').RecoveryErrorClass };

/**
 * What a finished restore means. `--verify` reads every restored file back, so a
 * content error or a nonzero exit with no extended-attribute explanation means
 * the target holds data Sencho cannot vouch for.
 */
export function classifyRestoreRun(input: {
  exitCode: number | null;
  aborted: boolean;
  killed: boolean;
  accumulator: RestoreAccumulator;
  stderrTail: string;
}): RestoreOutcome {
  if (input.aborted) return { status: 'cancelled' };
  if (input.killed) return { status: 'failed', errorClass: 'node_error' };
  const xattrOnly = input.accumulator.contentErrors === 0 && input.accumulator.xattrErrors > 0;
  switch (input.exitCode) {
    case 0:
      return xattrOnly
        ? { status: 'partial', xattrWarnings: input.accumulator.xattrErrors }
        : { status: 'restored' };
    case 10:
      return { status: 'failed', errorClass: 'repository_unavailable' };
    case 11:
      return { status: 'failed', errorClass: 'lock_held' };
    case 12:
      return { status: 'failed', errorClass: 'repository_key_unavailable' };
    default:
      if (xattrOnly) return { status: 'partial', xattrWarnings: input.accumulator.xattrErrors };
      if (/no space left on device|enospc/i.test(input.stderrTail)) {
        return { status: 'failed', errorClass: 'node_error' };
      }
      return { status: 'failed', errorClass: 'node_error' };
  }
}

export type IntegrityOutcome =
  | { result: 'verified' }
  | { result: 'mismatch' }
  | { result: 'error'; errorClass: import('../types').RecoveryErrorClass };

/**
 * What a finished `restic check` means. A check is repository-wide evidence: a
 * mismatch makes every point of that repository unverified until a later check
 * passes. A check that could not run at all is `error`, which never counts as
 * verified either.
 */
export function classifyCheckRun(input: {
  exitCode: number | null;
  aborted: boolean;
  killed: boolean;
  stderrTail: string;
}): IntegrityOutcome {
  if (input.aborted || input.killed) return { result: 'error', errorClass: 'interrupted' };
  switch (input.exitCode) {
    case 0:
      return { result: 'verified' };
    case 10:
      return { result: 'error', errorClass: 'repository_unavailable' };
    case 11:
      return { result: 'error', errorClass: 'lock_held' };
    case 12:
      return { result: 'error', errorClass: 'repository_key_unavailable' };
    case 1:
      return { result: 'mismatch' };
    default:
      if (/no space left on device|enospc/i.test(input.stderrTail)) {
        return { result: 'error', errorClass: 'repository_unavailable' };
      }
      return { result: 'error', errorClass: 'node_error' };
  }
}

/** `restic cat config` output, or null when it is not a repository config. */
export function parseRepositoryConfig(stdout: string): { id: string } | null {
  const parsed = asRecord(stdout);
  if (!parsed) return null;
  const id = parsed.id;
  if (typeof id !== 'string' || !/^[0-9a-f]{32,64}$/i.test(id)) return null;
  return { id: id.toLowerCase() };
}

/** A file name restic printed, made safe for a node-local log line. */
export function trimForLog(text: string, max = 200): string {
  const oneLine = text.replace(/[\r\n]+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** The default ordering of exclusion paths, for stable evidence. */
export function sortExclusions(exclusions: readonly PointExclusion[]): PointExclusion[] {
  return [...exclusions].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** True when every restic error item sits under the mount root. */
export function allWithinMount(items: readonly string[], mount: string = HELPER_SOURCE_MOUNT): boolean {
  return items.every((item) => path.posix.normalize(item).startsWith(`${mount}/`));
}
