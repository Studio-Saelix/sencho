/**
 * Reading a saved point's contents: restic's node records, the snapshot path a
 * point path maps to, and the exit-code map.
 *
 * The sample lines are what `restic ls --json` printed for a real repository
 * (0.19.1, the pinned helper build), so the parser is tested against the shape
 * the helper produces rather than against a guess.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_CONTENT_LINE_BYTES,
  classifyContentRun,
  contentSnapshotPath,
  formatEntryMode,
  parentPointPath,
  parseContentLine,
} from '../services/recovery/restic/resticContents';

/** The entry a line maps to, or null for a skipped or malformed line. */
function parseContentNodeLine(line: string) {
  const parsed = parseContentLine(line);
  return parsed.kind === 'entry' ? parsed.entry : null;
}

const SNAPSHOT_HEADER = '{"time":"2026-11-07T18:58:56.320279769Z","tree":"b85fbc3f","paths":["/data"],"hostname":"sencho","program_version":"restic 0.19.1","summary":{"backup_start":"2026-11-07T18:58:56.320279769Z","backup_end":"2026-11-07T18:58:57.07714048Z","files_new":3},"id":"06b26c23","short_id":"06b26c23","message_type":"snapshot","struct_type":"snapshot"}';
const DIR = '{"name":"etc","type":"dir","path":"/data/etc","uid":0,"gid":0,"mode":2147484141,"permissions":"drwxr-xr-x","mtime":"2026-11-07T18:58:44.058753409Z","atime":"2026-11-07T18:58:44.058753409Z","ctime":"2026-11-07T18:58:44.058753409Z","inode":6074664,"message_type":"node","struct_type":"node"}';
const FILE = '{"name":"config.txt","type":"file","path":"/data/etc/app/config.txt","uid":1000,"gid":1000,"size":12,"mode":416,"permissions":"-rw-r-----","mtime":"2026-11-07T18:58:44.060020974Z","atime":"2026-11-07T18:58:44.060020974Z","ctime":"2026-11-07T18:58:44.060020974Z","inode":4122636,"message_type":"node","struct_type":"node"}';
const SYMLINK = '{"name":"escape-link","type":"symlink","path":"/data/escape-link","uid":0,"gid":0,"mode":134218239,"permissions":"Lrwxrwxrwx","mtime":"2026-11-07T18:58:44.060020974Z","message_type":"node","struct_type":"node"}';
const FIFO = '{"name":"a-fifo","type":"fifo","path":"/data/a-fifo","uid":0,"gid":0,"mode":33554852,"permissions":"prw-r--r--","mtime":"2026-11-07T18:58:44.061020946Z","message_type":"node","struct_type":"node"}';

describe('contentSnapshotPath', () => {
  it('maps a point path onto the captured mount, so an argument always starts with a slash', () => {
    expect(contentSnapshotPath('/')).toBe('/data');
    expect(contentSnapshotPath('/etc/app')).toBe('/data/etc/app');
    expect(contentSnapshotPath('/-rf')).toBe('/data/-rf');
  });

  it('names the parent of a point path, with the root its own parent', () => {
    expect(parentPointPath('/')).toBe('/');
    expect(parentPointPath('/etc')).toBe('/');
    expect(parentPointPath('/etc/app/config.txt')).toBe('/etc/app');
  });
});

describe('formatEntryMode', () => {
  it('prints Go file modes as POSIX octal, special bits moved back into place', () => {
    expect(formatEntryMode(2147484141)).toBe('0755');
    expect(formatEntryMode(416)).toBe('0640');
    expect(formatEntryMode((1 << 23) | 0o755)).toBe('4755');
    expect(formatEntryMode((1 << 22) | 0o750)).toBe('2750');
    expect(formatEntryMode(2 ** 31 + (1 << 20) + 0o777)).toBe('1777');
  });

  it('answers null for a missing or invalid mode', () => {
    expect(formatEntryMode(undefined)).toBeNull();
    expect(formatEntryMode(-1)).toBeNull();
    expect(formatEntryMode(1.5)).toBeNull();
  });
});

describe('parseContentLine', () => {
  it('skips what is not a record and refuses a record it cannot trust', () => {
    expect(parseContentLine(SNAPSHOT_HEADER)).toEqual({ kind: 'skip' });
    expect(parseContentLine('applying 3 changes')).toEqual({ kind: 'skip' });
    expect(parseContentLine('{"message_type":"status","percent_done":0.5}')).toEqual({ kind: 'skip' });
    // A truncated record, a record outside the root, and one whose name disagrees.
    expect(parseContentLine('{"name":"x","type":"file","path":"/data/x"')).toEqual({ kind: 'malformed' });
    expect(parseContentLine('{"name":"passwd","type":"file","path":"/etc/passwd","message_type":"node"}')).toEqual({ kind: 'malformed' });
    expect(parseContentLine('{"name":"other","type":"file","path":"/data/x","message_type":"node"}')).toEqual({ kind: 'malformed' });
    expect(parseContentLine(`{"pad":"${'a'.repeat(MAX_CONTENT_LINE_BYTES)}","message_type":"node"}`)).toEqual({ kind: 'malformed' });
  });

  it('lists a name a request cannot spell, but never as downloadable', () => {
    const tab = JSON.stringify({ name: 'tab\there', type: 'file', path: '/data/tab\there', size: 3, message_type: 'node' });
    expect(parseContentNodeLine(tab)).toMatchObject({ name: 'tab\there', type: 'file', size: 3, downloadable: false });
    const long = 'a'.repeat(256);
    const longLine = JSON.stringify({ name: long, type: 'file', path: `/data/${long}`, size: 3, message_type: 'node' });
    expect(parseContentNodeLine(longLine)).toMatchObject({ downloadable: false });
  });

  it('lists a name restic printed with U+FFFD, but never as downloadable', () => {
    const replaced = JSON.stringify({ name: 'bad\ufffdname', type: 'file', path: '/data/bad\ufffdname', size: 3, message_type: 'node' });
    expect(parseContentNodeLine(replaced)).toMatchObject({ name: 'bad\ufffdname', type: 'file', downloadable: false });
  });
});

describe('parseContentNodeLine', () => {
  it('reads a directory, a file, a symlink and a special file', () => {
    expect(parseContentNodeLine(DIR)).toEqual({
      name: 'etc', path: '/etc', type: 'directory', size: null, mode: '0755',
      mtime: '2026-11-07T18:58:44.058753409Z', uid: 0, gid: 0, downloadable: false,
    });
    expect(parseContentNodeLine(FILE)).toEqual({
      name: 'config.txt', path: '/etc/app/config.txt', type: 'file', size: 12, mode: '0640',
      mtime: '2026-11-07T18:58:44.060020974Z', uid: 1000, gid: 1000, downloadable: true,
    });
    expect(parseContentNodeLine(SYMLINK)).toMatchObject({ path: '/escape-link', type: 'symlink', size: null, downloadable: false });
    expect(parseContentNodeLine(FIFO)).toMatchObject({ path: '/a-fifo', type: 'other', size: null, downloadable: false });
  });

  it('reads the point root\'s own record as /', () => {
    const root = '{"name":"data","type":"dir","path":"/data","mode":2147484141,"message_type":"node"}';
    expect(parseContentNodeLine(root)).toMatchObject({ path: '/', type: 'directory' });
  });

  it('ignores the snapshot header and anything that is not a node record', () => {
    expect(parseContentNodeLine(SNAPSHOT_HEADER)).toBeNull();
    expect(parseContentNodeLine('')).toBeNull();
    expect(parseContentNodeLine('applying 3 changes')).toBeNull();
    expect(parseContentNodeLine('{"message_type":"status","percent_done":0.5}')).toBeNull();
    expect(parseContentNodeLine('not json at all')).toBeNull();
    expect(parseContentNodeLine('{"name":"x","type":"file","path":"/data/x"')).toBeNull();
  });

  it('drops a line over the length cap whole instead of parsing part of it', () => {
    const padded = `{"name":"x","type":"file","path":"/data/x","size":1,"pad":"${'a'.repeat(MAX_CONTENT_LINE_BYTES)}","message_type":"node"}`;
    expect(parseContentNodeLine(padded)).toBeNull();
  });

  it('drops a record whose name is not its path\'s last segment', () => {
    const disagreeing = '{"name":"other","type":"file","path":"/data/etc/realfile","size":1,"message_type":"node"}';
    expect(parseContentNodeLine(disagreeing)).toBeNull();
  });

  it('refuses a negative or fractional size and fractional ids', () => {
    const negative = '{"name":"x","type":"file","path":"/data/x","size":-1,"message_type":"node"}';
    const fractional = '{"name":"x","type":"file","path":"/data/x","size":1.5,"message_type":"node"}';
    expect(parseContentNodeLine(negative)).toMatchObject({ size: null, downloadable: false });
    expect(parseContentNodeLine(fractional)?.size).toBeNull();
    const badUid = '{"name":"x","type":"file","path":"/data/x","size":1,"uid":1.5,"message_type":"node"}';
    expect(parseContentNodeLine(badUid)?.uid).toBeNull();
  });

  it('drops a record that names a path outside the captured root', () => {
    const outside = '{"name":"passwd","type":"file","path":"/etc/passwd","size":1,"message_type":"node"}';
    expect(parseContentNodeLine(outside)).toBeNull();
    const traversal = '{"name":"passwd","type":"file","path":"/data/../etc/passwd","size":1,"message_type":"node"}';
    expect(parseContentNodeLine(traversal)).toBeNull();
    const sibling = '{"name":"x","type":"file","path":"/database/x","size":1,"message_type":"node"}';
    expect(parseContentNodeLine(sibling)).toBeNull();
  });

  it('accepts the deprecated struct_type marker when message_type is absent', () => {
    const legacy = '{"name":"x","type":"file","path":"/data/x","size":1,"struct_type":"node"}';
    expect(parseContentNodeLine(legacy)).toMatchObject({ path: '/x', size: 1 });
  });

  it('reports a file with no size record as an unknown size that cannot be downloaded', () => {
    const noSize = '{"name":"x","type":"file","path":"/data/x","message_type":"node"}';
    expect(parseContentNodeLine(noSize)).toMatchObject({ size: null, downloadable: false });
  });

  it('drops an invalid modification time rather than passing it on', () => {
    const badTime = '{"name":"x","type":"file","path":"/data/x","size":1,"mtime":"yesterday","message_type":"node"}';
    expect(parseContentNodeLine(badTime)?.mtime).toBeNull();
  });
});

describe('classifyContentRun', () => {
  const base = { exitCode: 0, aborted: false, killed: false, externalAborted: false, stoppedEarly: false };

  it('reads a clean exit as success', () => {
    expect(classifyContentRun(base)).toEqual({ status: 'ok' });
  });

  it('reads a listing that stopped itself as success, whatever the helper exit says', () => {
    expect(classifyContentRun({ ...base, exitCode: 130, aborted: true, killed: true, stoppedEarly: true }))
      .toEqual({ status: 'ok' });
  });

  it('reads a caller cancellation as cancelled', () => {
    expect(classifyContentRun({ ...base, exitCode: 130, aborted: true, externalAborted: true }))
      .toEqual({ status: 'cancelled' });
    expect(classifyContentRun({ ...base, aborted: true })).toEqual({ status: 'cancelled' });
  });

  it('reads a kill with no caller abort behind it as the run\'s own deadline', () => {
    // The 120-second listing bound SIGKILLs the helper without aborting anyone's
    // signal; that is the node failing to answer, not the client leaving.
    expect(classifyContentRun({ ...base, exitCode: null, killed: true }))
      .toEqual({ status: 'failed', errorClass: 'node_error' });
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
