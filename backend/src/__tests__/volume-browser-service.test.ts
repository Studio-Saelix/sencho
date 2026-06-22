/**
 * Coverage for VolumeBrowserService pure helpers: path traversal sanitization,
 * volume-name validation, and binary detection. The Docker-facing exec path
 * is exercised in manual E2E only (mocking dockerode.run reliably is not worth
 * the brittleness here). That includes every helper that runs a script in the
 * Alpine container: list/read/write/writeFileStream/delete/rename/copy and
 * their exit-code-to-HTTP mappings (e.g. copy's 11 to 409, 12 to 400). Those
 * run on Linux nodes / CI against a real named volume, not on this workstation.
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeRelPath,
  isValidVolumeName,
  isBinaryBuffer,
  PathTraversalError,
} from '../services/VolumeBrowserService';

describe('sanitizeRelPath', () => {
  it('returns empty string for the volume root', () => {
    expect(sanitizeRelPath('')).toBe('');
    expect(sanitizeRelPath('.')).toBe('');
    expect(sanitizeRelPath('/')).toBe('');
  });

  it('strips leading slashes', () => {
    expect(sanitizeRelPath('/etc/foo')).toBe('etc/foo');
    expect(sanitizeRelPath('//etc/foo')).toBe('etc/foo');
  });

  it('preserves nested relative paths', () => {
    expect(sanitizeRelPath('a/b/c.txt')).toBe('a/b/c.txt');
  });

  it('rejects parent-escape segments', () => {
    expect(() => sanitizeRelPath('../etc/passwd')).toThrow(PathTraversalError);
    expect(() => sanitizeRelPath('foo/../../etc/passwd')).toThrow(PathTraversalError);
    expect(() => sanitizeRelPath('..')).toThrow(PathTraversalError);
  });

  it('rejects null bytes', () => {
    expect(() => sanitizeRelPath('foo\0.txt')).toThrow(PathTraversalError);
  });

  it('rejects oversize paths', () => {
    const huge = 'a/'.repeat(700);
    expect(() => sanitizeRelPath(huge)).toThrow(PathTraversalError);
  });

  it('rejects non-string input', () => {
    expect(() => sanitizeRelPath(undefined as unknown as string)).toThrow(PathTraversalError);
    expect(() => sanitizeRelPath(null as unknown as string)).toThrow(PathTraversalError);
  });
});

describe('isValidVolumeName', () => {
  it('accepts typical Docker volume names', () => {
    expect(isValidVolumeName('my-stack_data')).toBe(true);
    expect(isValidVolumeName('volume.with.dots')).toBe(true);
    expect(isValidVolumeName('a')).toBe(true);
    expect(isValidVolumeName('Vol_123')).toBe(true);
  });

  it('rejects names with disallowed characters', () => {
    expect(isValidVolumeName('vol/with/slashes')).toBe(false);
    expect(isValidVolumeName('vol with space')).toBe(false);
    expect(isValidVolumeName('vol;rm -rf')).toBe(false);
    expect(isValidVolumeName('')).toBe(false);
  });

  it('rejects names that start with non-alphanumeric', () => {
    expect(isValidVolumeName('-leading-dash')).toBe(false);
    expect(isValidVolumeName('.leading-dot')).toBe(false);
  });

  it('rejects oversize names', () => {
    expect(isValidVolumeName('a'.repeat(256))).toBe(false);
  });
});

describe('isBinaryBuffer', () => {
  it('flags buffers containing null bytes as binary', () => {
    expect(isBinaryBuffer(Buffer.from('hello\0world'))).toBe(true);
    expect(isBinaryBuffer(Buffer.from([0xff, 0x00, 0x42]))).toBe(true);
  });

  it('treats plain UTF-8 text as non-binary', () => {
    expect(isBinaryBuffer(Buffer.from('hello world\nlet me see\n'))).toBe(false);
    expect(isBinaryBuffer(Buffer.from('héllo wörld'))).toBe(false);
  });

  it('only inspects the first 8 KB', () => {
    // Pure text in the first 8KB; null byte after.
    const head = Buffer.alloc(8192, 0x41);
    const tail = Buffer.from([0]);
    const buf = Buffer.concat([head, tail]);
    expect(isBinaryBuffer(buf)).toBe(false);
  });

  it('handles an empty buffer', () => {
    expect(isBinaryBuffer(Buffer.alloc(0))).toBe(false);
  });
});
