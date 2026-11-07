import path from 'path';
import { HELPER_SOURCE_MOUNT } from './helperRunner';
import { RecoveryError } from '../redaction';
import type {
  RecoveryContentEntry,
  RecoveryContentKind,
  RecoveryContents,
  RecoveryErrorClass,
} from '../types';

/**
 * What `restic ls --json` and `restic dump` answer, mapped to Sencho's
 * vocabulary.
 *
 * Pure: every function here takes a line, a path or an exit code and answers
 * with an entry, a listing or a class. Nothing is logged and nothing is stored,
 * so the mapping can be read and tested without a daemon.
 *
 * Captured paths start with the helper's mount (`/data`), because a capture backs
 * up that directory. The API never shows that mount: an entry's `path` is
 * relative to the point root, and the point root is ''.
 */

/** Entries one listing returns. A directory past this is reported truncated. */
export const MAX_CONTENT_ENTRIES = 2_000;
/**
 * Largest file one download serves. A larger file is refused before any byte
 * moves, because the bytes travel from the node through the hub to the browser
 * and a point that large is better restored than downloaded.
 */
export const MAX_CONTENT_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
/** Longest path a request may name. Well above any real name, well below a body. */
export const MAX_CONTENT_PATH_LENGTH = 4_096;
/**
 * How long a file body may go without a byte before the read is stopped. A
 * stalled repository mount and a client that stays connected but stops reading
 * both look the same from here, and neither may hold a helper forever. The bound
 * is idle time, not total time: a slow transfer that keeps moving is never cut.
 */
export const MAX_CONTENT_DOWNLOAD_IDLE_MS = 2 * 60 * 1000;

/**
 * A requested path, canonical and root-relative. '' is the point root.
 *
 * A leading slash is read as the point root, not the host's root, so `/etc/x`
 * and `etc/x` name the same entry. `..` is refused rather than resolved: a point
 * is browsed, never walked out of. The rest is path syntax only, so a name with
 * spaces or unicode survives unchanged.
 */
export function canonicalizeContentPath(raw: unknown): string {
  if (typeof raw !== 'string') throw new RecoveryError('invalid_request');
  if (raw.includes('\0')) throw new RecoveryError('invalid_request');
  if (raw.length > MAX_CONTENT_PATH_LENGTH) throw new RecoveryError('invalid_request');
  const relative = raw.replace(/^\/+/, '');
  if (relative === '') return '';
  if (relative.split('/').includes('..')) throw new RecoveryError('invalid_request');
  const normalized = path.posix.normalize(relative).replace(/\/+$/, '');
  if (normalized === '' || normalized === '.') return '';
  if (normalized.split('/').includes('..')) throw new RecoveryError('invalid_request');
  return normalized;
}

/** The path inside the snapshot that a root-relative path names. */
export function contentSnapshotPath(relative: string): string {
  const canonical = canonicalizeContentPath(relative);
  return canonical === '' ? HELPER_SOURCE_MOUNT : `${HELPER_SOURCE_MOUNT}/${canonical}`;
}

/** Entry type restic reports, mapped to the three shapes a browser acts on. */
function entryType(raw: unknown): RecoveryContentEntry['type'] {
  if (raw === 'file') return 'file';
  if (raw === 'dir') return 'directory';
  if (raw === 'symlink') return 'symlink';
  return 'other';
}

/** A byte count, a mode, a uid or a gid: a non-negative integer, never a fraction. */
function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function millisOrNull(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * One `restic ls --json` line as an entry, or null when the line is not a node
 * record (the snapshot header, or a line restic writes for progress).
 *
 * The mount prefix is checked before it is stripped: a record naming anything
 * outside the captured root is dropped rather than shown as if it were part of
 * the point. There is no way for well-formed output to name one, which is why
 * this is a guard and not a translation.
 */
export function parseContentNodeLine(line: string): RecoveryContentEntry | null {
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

  const name = stringOrNull(record.name);
  const recordPath = stringOrNull(record.path);
  if (!name || recordPath === null) return null;

  let relative: string;
  if (recordPath === HELPER_SOURCE_MOUNT) {
    relative = '';
  } else if (recordPath.startsWith(`${HELPER_SOURCE_MOUNT}/`)) {
    relative = recordPath.slice(HELPER_SOURCE_MOUNT.length + 1);
  } else {
    return null;
  }
  if (relative.split('/').includes('..')) return null;

  // The name is the last segment of the recorded path. A record that disagrees
  // is dropped rather than trusted, because the name is what a download puts in
  // its Content-Disposition header. The point root is the one exception: its
  // record is named after the mount, and the listing hides that entry anyway.
  if (relative !== '') {
    const segments = relative.split('/');
    if (segments[segments.length - 1] !== name) return null;
  }

  const type = entryType(record.type);
  return {
    path: relative,
    name,
    type,
    size: type === 'file' ? nonNegativeInteger(record.size) : null,
    permissions: stringOrNull(record.permissions),
    mode: nonNegativeInteger(record.mode),
    uid: nonNegativeInteger(record.uid),
    gid: nonNegativeInteger(record.gid),
    mtime: millisOrNull(record.mtime),
  };
}

/** Directories first, then by name, so two reads of one directory always agree. */
export function sortContentEntries(entries: readonly RecoveryContentEntry[]): RecoveryContentEntry[] {
  return [...entries].sort((a, b) => {
    const aDir = a.type === 'directory' ? 0 : 1;
    const bDir = b.type === 'directory' ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    if (a.name === b.name) return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    return a.name < b.name ? -1 : 1;
  });
}

export function contentKindFor(entry: RecoveryContentEntry): RecoveryContentKind {
  if (entry.type === 'file') return 'file';
  if (entry.type === 'directory') return 'directory';
  return 'other';
}

/**
 * The listing a read answers with. Null when the requested path is not in the
 * snapshot, which is `not_found` rather than an empty directory.
 *
 * The point root has no entry of its own: restic names it after the helper's
 * mount, which is not part of the point and must not reach a client.
 */
export function contentListingFor(input: {
  path: string;
  self: RecoveryContentEntry | null;
  entries: readonly RecoveryContentEntry[];
  truncated: boolean;
}): RecoveryContents | null {
  if (!input.self) return null;
  const kind = contentKindFor(input.self);
  return {
    path: input.path,
    kind,
    entry: input.path === '' ? null : input.self,
    entries: kind === 'directory' ? sortContentEntries(input.entries) : [],
    truncated: kind === 'directory' ? input.truncated : false,
  };
}

export type ContentRunOutcome =
  | { status: 'ok' }
  | { status: 'cancelled' }
  | { status: 'failed'; errorClass: RecoveryErrorClass };

/**
 * A read run's exit, in Sencho's terms.
 *
 * `truncated` wins over everything: the listing stopped itself at its entry cap,
 * so the helper's SIGINT and its exit code say nothing about the repository.
 * Exit 1 is restic's generic failure: the repository could not produce a tree or
 * a blob the point recorded, or a snapshot this repository no longer holds. The
 * node-local log line names which, so an operator is not sent looking for
 * corruption when the snapshot is simply gone. Exit 2 is the Go runtime failing,
 * which says nothing about the data and is the node's problem. Exit 3 (a backup
 * that skipped source data) does not occur for a read.
 */
export function classifyContentRun(input: {
  exitCode: number | null;
  aborted: boolean;
  killed: boolean;
  externalAborted: boolean;
  truncated: boolean;
}): ContentRunOutcome {
  if (input.truncated) return { status: 'ok' };
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
