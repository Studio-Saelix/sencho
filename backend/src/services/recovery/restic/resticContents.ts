import { HELPER_SOURCE_MOUNT } from './helperRunner';
import type { PointEntry, RecoveryErrorClass } from '../types';

/**
 * What `restic ls --json` and `restic dump` answer, mapped to Sencho's
 * vocabulary.
 *
 * Pure: every function here takes a line, a path or an exit code and answers
 * with an entry or a class. Nothing is logged and nothing is stored, so the
 * mapping can be read and tested without a daemon.
 *
 * Captured paths start with the helper's mount (`/data`), because a capture backs
 * up that directory. The API never shows that mount: an entry's `path` is
 * absolute within the point, and the point root is `/`.
 */

/**
 * Longest `ls` line the parser reads. A node record is a few hundred bytes; a
 * longer line is not one, and is dropped whole rather than parsed in part.
 */
export const MAX_CONTENT_LINE_BYTES = 64 * 1024;

/**
 * The path inside the snapshot that a validated point path names. The result
 * always starts with `/`, so restic can never read it as a flag.
 */
export function contentSnapshotPath(pointPath: string): string {
  return pointPath === '/' ? HELPER_SOURCE_MOUNT : `${HELPER_SOURCE_MOUNT}${pointPath}`;
}

/** The parent of an absolute point path; the root is its own parent. */
export function parentPointPath(pointPath: string): string {
  const cut = pointPath.lastIndexOf('/');
  return cut <= 0 ? '/' : pointPath.slice(0, cut);
}

function entryType(raw: unknown): PointEntry['type'] {
  if (raw === 'file') return 'file';
  if (raw === 'dir') return 'directory';
  if (raw === 'symlink') return 'symlink';
  return 'other';
}

/** A byte count, a uid or a gid: a non-negative integer, never a fraction. */
function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

// Go's os.FileMode keeps the special bits above the type bits, not where POSIX
// puts them, so they are moved back before the mode is printed.
const GO_MODE_SETUID = 1 << 23;
const GO_MODE_SETGID = 1 << 22;
const GO_MODE_STICKY = 1 << 20;

/** restic's Go file mode as four POSIX octal digits, such as `0644`. */
export function formatEntryMode(value: unknown): string | null {
  const mode = nonNegativeInteger(value);
  if (mode === null) return null;
  let bits = mode & 0o777;
  if (mode & GO_MODE_SETUID) bits |= 0o4000;
  if (mode & GO_MODE_SETGID) bits |= 0o2000;
  if (mode & GO_MODE_STICKY) bits |= 0o1000;
  return bits.toString(8).padStart(4, '0');
}

function mtimeOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * One `restic ls --json` line as an entry, or null when the line is not a node
 * record (the snapshot header, a progress line, anything malformed or too long).
 *
 * The mount prefix is checked before it is stripped: a record naming anything
 * outside the captured root is dropped rather than shown as if it were part of
 * the point. Well-formed output cannot name one, which is why this is a guard
 * and not a translation.
 */
export function parseContentNodeLine(line: string): PointEntry | null {
  if (Buffer.byteLength(line) > MAX_CONTENT_LINE_BYTES) return null;
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  // `ls --json` marks both fields; requiring one keeps a status line from being
  // read as an entry if restic ever stops writing one of them.
  const marker = record.message_type ?? record.struct_type;
  if (marker !== 'node') return null;

  const name = typeof record.name === 'string' ? record.name : '';
  const recordPath = typeof record.path === 'string' ? record.path : null;
  if (!name || recordPath === null) return null;

  let pointPath: string;
  if (recordPath === HELPER_SOURCE_MOUNT) {
    pointPath = '/';
  } else if (recordPath.startsWith(`${HELPER_SOURCE_MOUNT}/`)) {
    pointPath = recordPath.slice(HELPER_SOURCE_MOUNT.length);
  } else {
    return null;
  }
  const segments = pointPath.split('/').slice(1);
  if (pointPath !== '/' && segments.some((s) => s === '' || s === '.' || s === '..')) return null;

  // The name is the last segment of the recorded path. A record that disagrees
  // is dropped rather than trusted, because the name is what a download puts in
  // its Content-Disposition header. The point root is the one exception: its
  // record is named after the mount, and no listing shows it as an entry.
  if (pointPath !== '/' && segments[segments.length - 1] !== name) return null;

  const type = entryType(record.type);
  const size = type === 'file' ? nonNegativeInteger(record.size) : null;
  return {
    name,
    path: pointPath,
    type,
    size,
    mode: formatEntryMode(record.mode),
    mtime: mtimeOrNull(record.mtime),
    uid: nonNegativeInteger(record.uid),
    gid: nonNegativeInteger(record.gid),
    downloadable: type === 'file' && size !== null,
  };
}

export type ContentRunOutcome =
  | { status: 'ok' }
  | { status: 'cancelled' }
  | { status: 'failed'; errorClass: RecoveryErrorClass };

/**
 * A read run's exit, in Sencho's terms.
 *
 * `stoppedEarly` wins over everything: the listing stopped itself once it held
 * a full page, so the helper's SIGINT and its exit code say nothing about the
 * repository. Exit 1 is restic's generic failure: the repository could not
 * produce a tree or a blob the point recorded, or a snapshot this repository no
 * longer holds, and either way the read cannot be trusted. Exit 2 is the Go
 * runtime failing, which says nothing about the data and is the node's problem.
 */
export function classifyContentRun(input: {
  exitCode: number | null;
  aborted: boolean;
  killed: boolean;
  externalAborted: boolean;
  stoppedEarly: boolean;
}): ContentRunOutcome {
  if (input.stoppedEarly) return { status: 'ok' };
  if (input.externalAborted || input.aborted) return { status: 'cancelled' };
  // A SIGKILL with no abort behind it is the run's own deadline, not a caller
  // leaving. It is a failure of this node's read, and it is logged as one.
  if (input.killed) return { status: 'failed', errorClass: 'node_error' };
  switch (input.exitCode) {
    case 0:
      return { status: 'ok' };
    case 10:
      return { status: 'failed', errorClass: 'repository_unavailable' };
    case 11:
      return { status: 'failed', errorClass: 'lock_held' };
    case 12:
      return { status: 'failed', errorClass: 'repository_key_unavailable' };
    case 130:
      return { status: 'cancelled' };
    case 2:
      return { status: 'failed', errorClass: 'node_error' };
    case null:
      return { status: 'failed', errorClass: 'internal' };
    default:
      return { status: 'failed', errorClass: 'integrity_mismatch' };
  }
}
