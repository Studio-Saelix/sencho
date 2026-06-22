/**
 * Unit tests for the client-side path-traversal guard added to
 * stackFilesApi exports. The guard mirrors
 * backend/src/utils/validation.ts::isValidRelativeStackPath so a
 * malicious or buggy caller cannot slip a `..` segment past the
 * client before it would otherwise be caught by the server.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isClientSafeRelPath,
  isProtectedRootRelPath,
  isSameOrDescendantPath,
  relPathParentDir,
  nextDuplicateName,
  createEmptyStackFile,
  UploadConflictError,
} from '../stackFilesApi';

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

describe('isProtectedRootRelPath', () => {
  it('flags compose and env files at the stack root', () => {
    expect(isProtectedRootRelPath('compose.yaml')).toBe(true);
    expect(isProtectedRootRelPath('compose.yml')).toBe(true);
    expect(isProtectedRootRelPath('docker-compose.yaml')).toBe(true);
    expect(isProtectedRootRelPath('docker-compose.yml')).toBe(true);
    expect(isProtectedRootRelPath('.env')).toBe(true);
  });

  it('does not flag the same names nested in a subdirectory', () => {
    expect(isProtectedRootRelPath('configs/.env')).toBe(false);
    expect(isProtectedRootRelPath('nested/compose.yaml')).toBe(false);
  });

  it('does not flag ordinary files or the empty string', () => {
    expect(isProtectedRootRelPath('app.conf')).toBe(false);
    expect(isProtectedRootRelPath('')).toBe(false);
  });
});

describe('isSameOrDescendantPath', () => {
  it('is true for the path itself', () => {
    expect(isSameOrDescendantPath('src', 'src')).toBe(true);
  });

  it('is true for a nested descendant', () => {
    expect(isSameOrDescendantPath('src', 'src/lib/util.ts')).toBe(true);
  });

  it('is false for a sibling sharing a name prefix', () => {
    expect(isSameOrDescendantPath('src', 'src-extra')).toBe(false);
    expect(isSameOrDescendantPath('src', 'other')).toBe(false);
  });
});

describe('relPathParentDir', () => {
  it('returns the empty string for a root-level entry', () => {
    expect(relPathParentDir('app.conf')).toBe('');
  });

  it('returns the directory portion for a nested entry', () => {
    expect(relPathParentDir('configs/redis/redis.conf')).toBe('configs/redis');
  });
});

describe('nextDuplicateName', () => {
  it('inserts " copy" before the extension', () => {
    expect(nextDuplicateName('app.conf', new Set())).toBe('app copy.conf');
  });

  it('increments the suffix when the copy name already exists', () => {
    expect(nextDuplicateName('app.conf', new Set(['app copy.conf']))).toBe('app copy 2.conf');
    expect(nextDuplicateName('app.conf', new Set(['app copy.conf', 'app copy 2.conf']))).toBe('app copy 3.conf');
  });

  it('treats a leading-dot file as having no extension', () => {
    expect(nextDuplicateName('.env', new Set())).toBe('.env copy');
  });

  it('appends to a name with no extension', () => {
    expect(nextDuplicateName('Dockerfile', new Set())).toBe('Dockerfile copy');
  });
});

describe('createEmptyStackFile', () => {
  function stubFetch(status: number, body?: object) {
    const res = {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: () => null },
      clone() { return this; },
      json: async () => body ?? {},
    };
    const fetchMock = vi.fn().mockResolvedValue(res);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it('posts a zero-byte file to the upload endpoint without overwrite', async () => {
    const fetchMock = stubFetch(204);
    await createEmptyStackFile('my-stack', 'configs', 'app.conf', { rootId: 'stack-source' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url, 'http://x').searchParams.get('path')).toBe('configs');
    expect(url).not.toContain('overwrite=1'); // never clobbers
    const file = (init.body as FormData).get('file') as File;
    expect(file.name).toBe('app.conf');
    expect(file.size).toBe(0);
  });

  it('targets the stack root when the directory is empty', async () => {
    const fetchMock = stubFetch(204);
    await createEmptyStackFile('my-stack', '', 'root-file.txt');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // An empty directory means the stack root: the path query carries no segment.
    expect(new URL(url, 'http://x').searchParams.get('path')).toBe('');
    expect(url).not.toContain('overwrite=1');
    expect((init.body as FormData).get('file') as File).toMatchObject({ name: 'root-file.txt', size: 0 });
  });

  it('throws UploadConflictError when a file of that name already exists', async () => {
    stubFetch(409, { code: 'FILE_EXISTS', error: 'app.conf already exists.' });
    await expect(createEmptyStackFile('my-stack', 'configs', 'app.conf')).rejects.toBeInstanceOf(
      UploadConflictError,
    );
  });

  it('throws a generic error (not UploadConflictError) when a folder of that name exists', async () => {
    stubFetch(409, { code: 'DIR_EXISTS', error: 'A folder named app already exists in this folder.' });
    const err = await createEmptyStackFile('my-stack', 'configs', 'app').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UploadConflictError);
  });
});
