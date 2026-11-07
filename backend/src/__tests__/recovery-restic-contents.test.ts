/**
 * Reading a saved point's contents: the path grammar, restic's node records, the
 * listing shape and the exit-code map.
 *
 * The sample lines are what `restic ls --json` printed for a real repository
 * (0.19.1, the pinned helper build), so the parser is tested against the shape
 * the helper produces rather than against a guess.
 */
import { describe, it, expect } from 'vitest';
import type { RecoveryContentEntry } from '../services/recovery/types';
import {
  MAX_CONTENT_ENTRIES,
  MAX_CONTENT_PATH_LENGTH,
  canonicalizeContentPath,
  classifyContentRun,
  contentListingFor,
  contentSnapshotPath,
  parseContentNodeLine,
  sortContentEntries,
} from '../services/recovery/restic/resticContents';

const SNAPSHOT_HEADER = '{"time":"2026-11-07T18:58:56.320279769Z","tree":"b85fbc3f","paths":["/data"],"hostname":"sencho","program_version":"restic 0.19.1","summary":{"backup_start":"2026-11-07T18:58:56.320279769Z","backup_end":"2026-11-07T18:58:57.07714048Z","files_new":3},"id":"06b26c23","short_id":"06b26c23","message_type":"snapshot","struct_type":"snapshot"}';
const DIR = '{"name":"etc","type":"dir","path":"/data/etc","uid":0,"gid":0,"mode":2147484141,"permissions":"drwxr-xr-x","mtime":"2026-11-07T18:58:44.058753409Z","atime":"2026-11-07T18:58:44.058753409Z","ctime":"2026-11-07T18:58:44.058753409Z","inode":6074664,"message_type":"node","struct_type":"node"}';
const FILE = '{"name":"config.txt","type":"file","path":"/data/etc/app/config.txt","uid":1000,"gid":1000,"size":12,"mode":416,"permissions":"-rw-r-----","mtime":"2026-11-07T18:58:44.060020974Z","atime":"2026-11-07T18:58:44.060020974Z","ctime":"2026-11-07T18:58:44.060020974Z","inode":4122636,"message_type":"node","struct_type":"node"}';
const SYMLINK = '{"name":"escape-link","type":"symlink","path":"/data/escape-link","uid":0,"gid":0,"mode":134218239,"permissions":"Lrwxrwxrwx","mtime":"2026-11-07T18:58:44.060020974Z","message_type":"node","struct_type":"node"}';
const FIFO = '{"name":"a-fifo","type":"fifo","path":"/data/a-fifo","uid":0,"gid":0,"mode":33554852,"permissions":"prw-r--r--","mtime":"2026-11-07T18:58:44.061020946Z","message_type":"node","struct_type":"node"}';

describe('canonicalizeContentPath', () => {
  it('reads empty and slash as the point root', () => {
    expect(canonicalizeContentPath('')).toBe('');
    expect(canonicalizeContentPath('/')).toBe('');
    expect(canonicalizeContentPath('//')).toBe('');
  });

  it('reads a leading slash as the point root, not the host root', () => {
    expect(canonicalizeContentPath('/etc/app')).toBe('etc/app');
    expect(canonicalizeContentPath('etc/app')).toBe('etc/app');
    expect(canonicalizeContentPath('etc//app/')).toBe('etc/app');
    expect(canonicalizeContentPath('./etc')).toBe('etc');
  });

  it('keeps a name that only looks special', () => {
    expect(canonicalizeContentPath('..hidden')).toBe('..hidden');
    expect(canonicalizeContentPath('my file.txt')).toBe('my file.txt');
  });

  it('refuses traversal instead of resolving it', () => {
    expect(() => canonicalizeContentPath('..')).toThrow();
    expect(() => canonicalizeContentPath('../etc/passwd')).toThrow();
    expect(() => canonicalizeContentPath('etc/../../etc/passwd')).toThrow();
    expect(() => canonicalizeContentPath('/../etc')).toThrow();
  });

  it('refuses a NUL and an absurdly long path', () => {
    expect(() => canonicalizeContentPath('a\0b')).toThrow();
    expect(() => canonicalizeContentPath('a'.repeat(MAX_CONTENT_PATH_LENGTH + 1))).toThrow();
  });

  it('refuses anything that is not a string', () => {
    expect(() => canonicalizeContentPath(undefined)).toThrow();
    expect(() => canonicalizeContentPath(['a'])).toThrow();
  });
});

describe('contentSnapshotPath', () => {
  it('maps a root-relative path onto the captured mount', () => {
    expect(contentSnapshotPath('')).toBe('/data');
    expect(contentSnapshotPath('etc/app')).toBe('/data/etc/app');
    expect(contentSnapshotPath('/etc/app')).toBe('/data/etc/app');
  });

  it('refuses a path that would leave the mount', () => {
    expect(() => contentSnapshotPath('../etc')).toThrow();
  });
});

describe('parseContentNodeLine', () => {
  it('reads a directory, a file, a symlink and a special file', () => {
    expect(parseContentNodeLine(DIR)).toMatchObject({
      path: 'etc', name: 'etc', type: 'directory', size: null, permissions: 'drwxr-xr-x', uid: 0, gid: 0,
    });
    expect(parseContentNodeLine(FILE)).toMatchObject({
      path: 'etc/app/config.txt', name: 'config.txt', type: 'file', size: 12, mode: 416, uid: 1000, gid: 1000,
    });
    expect(parseContentNodeLine(SYMLINK)).toMatchObject({ path: 'escape-link', type: 'symlink', size: null });
    expect(parseContentNodeLine(FIFO)).toMatchObject({ path: 'a-fifo', type: 'other', size: null });
  });

  it('carries the modification time as milliseconds', () => {
    expect(parseContentNodeLine(FILE)?.mtime).toBe(Date.parse('2026-11-07T18:58:44.060020974Z'));
  });

  it('ignores the snapshot header and anything that is not a node record', () => {
    expect(parseContentNodeLine(SNAPSHOT_HEADER)).toBeNull();
    expect(parseContentNodeLine('')).toBeNull();
    expect(parseContentNodeLine('applying 3 changes')).toBeNull();
    expect(parseContentNodeLine('{"message_type":"status","percent_done":0.5}')).toBeNull();
    expect(parseContentNodeLine('not json at all')).toBeNull();
  });

  it('drops a record that names a path outside the captured root', () => {
    const outside = '{"name":"passwd","type":"file","path":"/etc/passwd","size":1,"message_type":"node"}';
    expect(parseContentNodeLine(outside)).toBeNull();
    const traversal = '{"name":"passwd","type":"file","path":"/data/../etc/passwd","size":1,"message_type":"node"}';
    expect(parseContentNodeLine(traversal)).toBeNull();
  });

  it('accepts the deprecated struct_type marker when message_type is absent', () => {
    const legacy = '{"name":"x","type":"file","path":"/data/x","size":1,"struct_type":"node"}';
    expect(parseContentNodeLine(legacy)).toMatchObject({ path: 'x', size: 1 });
  });

  it('reports a file with no size record as an unknown size, never as empty', () => {
    const noSize = '{"name":"x","type":"file","path":"/data/x","message_type":"node"}';
    expect(parseContentNodeLine(noSize)?.size).toBeNull();
  });
});

describe('sortContentEntries', () => {
  it('puts directories first, then names, so two reads agree', () => {
    const entries: RecoveryContentEntry[] = [
      { path: 'b.txt', name: 'b.txt', type: 'file', size: 0, permissions: null, mode: null, uid: null, gid: null, mtime: null },
      { path: 'z', name: 'z', type: 'directory', size: null, permissions: null, mode: null, uid: null, gid: null, mtime: null },
      { path: 'a.txt', name: 'a.txt', type: 'file', size: 0, permissions: null, mode: null, uid: null, gid: null, mtime: null },
      { path: 'a', name: 'a', type: 'directory', size: null, permissions: null, mode: null, uid: null, gid: null, mtime: null },
    ];
    expect(sortContentEntries(entries).map((e) => e.name)).toEqual(['a', 'z', 'a.txt', 'b.txt']);
  });
});

describe('contentListingFor', () => {
  const dir = parseContentNodeLine(DIR)!;
  const file = parseContentNodeLine(FILE)!;

  it('answers a directory with its sorted entries', () => {
    const contents = contentListingFor({
      path: 'etc',
      self: dir,
      entries: [file],
      truncated: false,
    });
    expect(contents).toMatchObject({ path: 'etc', kind: 'directory', truncated: false });
    expect(contents?.entry?.path).toBe('etc');
    expect(contents?.entries.map((e) => e.path)).toEqual(['etc/app/config.txt']);
  });

  it('answers a file with its metadata and no entries', () => {
    const contents = contentListingFor({ path: 'etc/app/config.txt', self: file, entries: [], truncated: false });
    expect(contents).toMatchObject({ kind: 'file', entries: [], truncated: false });
  });

  it('answers a symlink as neither a file nor a directory', () => {
    const contents = contentListingFor({
      path: 'escape-link', self: parseContentNodeLine(SYMLINK)!, entries: [], truncated: false,
    });
    expect(contents?.kind).toBe('other');
  });

  it('answers null when the path is not in the snapshot', () => {
    expect(contentListingFor({ path: 'nope', self: null, entries: [], truncated: false })).toBeNull();
  });

  it('never names the point root as an entry, because restic names it after the mount', () => {
    const root = parseContentNodeLine(
      '{"name":"data","type":"dir","path":"/data","uid":0,"gid":0,"permissions":"drwxr-xr-x","message_type":"node"}',
    )!;
    const contents = contentListingFor({ path: '', self: root, entries: [dir, file], truncated: false });
    expect(contents).toMatchObject({ path: '', kind: 'directory', entry: null });
    expect(contents?.entries.map((e) => e.path)).toEqual(['etc', 'etc/app/config.txt']);
    expect(JSON.stringify(contents)).not.toContain('"name":"data"');
  });

  it('never reports truncation for a file', () => {
    const contents = contentListingFor({ path: 'etc/app/config.txt', self: file, entries: [], truncated: true });
    expect(contents?.truncated).toBe(false);
  });

  it('can report the entry cap of a directory', () => {
    expect(MAX_CONTENT_ENTRIES).toBeGreaterThan(0);
    const contents = contentListingFor({ path: 'etc', self: dir, entries: [], truncated: true });
    expect(contents?.truncated).toBe(true);
  });
});

describe('classifyContentRun', () => {
  const base = { exitCode: 0, aborted: false, killed: false, externalAborted: false, truncated: false };

  it('reads a clean exit as success', () => {
    expect(classifyContentRun(base)).toEqual({ status: 'ok' });
  });

  it('reads a truncated listing as success, whatever the helper exit says', () => {
    expect(classifyContentRun({ ...base, exitCode: 130, aborted: true, killed: true, truncated: true }))
      .toEqual({ status: 'ok' });
  });

  it('reads a caller cancellation as cancelled', () => {
    expect(classifyContentRun({ ...base, exitCode: 130, aborted: true, externalAborted: true }))
      .toEqual({ status: 'cancelled' });
    expect(classifyContentRun({ ...base, aborted: true })).toEqual({ status: 'cancelled' });
  });

  it('maps restic\'s repository exit codes', () => {
    expect(classifyContentRun({ ...base, exitCode: 10 })).toEqual({ status: 'failed', errorClass: 'repository_unavailable' });
    expect(classifyContentRun({ ...base, exitCode: 11 })).toEqual({ status: 'failed', errorClass: 'lock_held' });
    expect(classifyContentRun({ ...base, exitCode: 12 })).toEqual({ status: 'failed', errorClass: 'repository_key_unavailable' });
    expect(classifyContentRun({ ...base, exitCode: 130 })).toEqual({ status: 'cancelled' });
    expect(classifyContentRun({ ...base, exitCode: null })).toEqual({ status: 'failed', errorClass: 'internal' });
  });

  it('reads a data failure as an integrity answer and a runtime crash as the node\'s', () => {
    expect(classifyContentRun({ ...base, exitCode: 1 })).toEqual({ status: 'failed', errorClass: 'integrity_mismatch' });
    expect(classifyContentRun({ ...base, exitCode: 3 })).toEqual({ status: 'failed', errorClass: 'integrity_mismatch' });
    // Exit 2 is the helper's own Go runtime failing, which says nothing about the data.
    expect(classifyContentRun({ ...base, exitCode: 2 })).toEqual({ status: 'failed', errorClass: 'node_error' });
  });
});
