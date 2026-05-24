/**
 * Unit tests for the client-side path-traversal guard added to
 * stackFilesApi exports. The guard mirrors
 * backend/src/utils/validation.ts::isValidRelativeStackPath so a
 * malicious or buggy caller cannot slip a `..` segment past the
 * client before it would otherwise be caught by the server.
 */
import { describe, it, expect } from 'vitest';
import { isClientSafeRelPath } from '../stackFilesApi';

describe('isClientSafeRelPath', () => {
  it('accepts the empty string (means the stack root)', () => {
    expect(isClientSafeRelPath('')).toBe(true);
  });

  it('accepts a simple file name', () => {
    expect(isClientSafeRelPath('compose.yaml')).toBe(true);
  });

  it('accepts a nested POSIX path', () => {
    expect(isClientSafeRelPath('config/redis/redis.conf')).toBe(true);
  });

  it('accepts a hidden file', () => {
    expect(isClientSafeRelPath('.env')).toBe(true);
  });

  it('rejects parent-directory traversal', () => {
    expect(isClientSafeRelPath('..')).toBe(false);
    expect(isClientSafeRelPath('../etc/passwd')).toBe(false);
    expect(isClientSafeRelPath('config/../../../etc/passwd')).toBe(false);
  });

  it('rejects same-directory segment', () => {
    expect(isClientSafeRelPath('./config')).toBe(false);
    expect(isClientSafeRelPath('config/./redis.conf')).toBe(false);
  });

  it('rejects absolute POSIX paths', () => {
    expect(isClientSafeRelPath('/etc/passwd')).toBe(false);
    expect(isClientSafeRelPath('/')).toBe(false);
  });

  it('rejects Windows drive-letter paths', () => {
    expect(isClientSafeRelPath('C:/Windows/System32')).toBe(false);
    expect(isClientSafeRelPath('d:foo')).toBe(false);
  });

  it('rejects backslashes', () => {
    expect(isClientSafeRelPath('config\\redis.conf')).toBe(false);
    expect(isClientSafeRelPath('..\\..\\etc\\passwd')).toBe(false);
  });

  it('rejects NUL bytes', () => {
    expect(isClientSafeRelPath('foo\0bar')).toBe(false);
  });

  it('rejects double slashes', () => {
    expect(isClientSafeRelPath('config//redis.conf')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isClientSafeRelPath(undefined as unknown as string)).toBe(false);
    expect(isClientSafeRelPath(null as unknown as string)).toBe(false);
    expect(isClientSafeRelPath(42 as unknown as string)).toBe(false);
  });
});
