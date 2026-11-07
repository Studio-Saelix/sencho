/**
 * Unit tests for the bounded compose-input read. These run against the real
 * filesystem where they can, because the contract is what the sink does with a
 * path, not how a caller mocks it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fsPromises } from 'fs';
import os from 'os';
import path from 'path';
import { readComposeInputWithinCap } from '../helpers/composeInputReadSink';

let dir: string;

beforeEach(async () => {
  dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-compose-read-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsPromises.rm(dir, { recursive: true, force: true });
});

function codedError(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function fakeHandle(overrides: {
  stat?: () => Promise<{ isFile: () => boolean; size: number }>;
  read?: () => Promise<{ bytesRead: number }>;
  close?: () => Promise<void>;
}): Awaited<ReturnType<typeof fsPromises.open>> {
  return {
    stat: vi.fn().mockResolvedValue({ isFile: () => true, size: 0 }),
    read: vi.fn().mockResolvedValue({ bytesRead: 0 }),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Awaited<ReturnType<typeof fsPromises.open>>;
}

describe('readComposeInputWithinCap', () => {
  it('reads a regular file within the cap', async () => {
    const file = path.join(dir, 'compose.yaml');
    await fsPromises.writeFile(file, 'services:\n');

    await expect(readComposeInputWithinCap(file, 1024)).resolves.toEqual({
      content: 'services:\n',
      tooLarge: false,
    });
  });

  it('decodes a UTF-16LE file with a byte-order mark', async () => {
    const file = path.join(dir, 'compose.yaml');
    await fsPromises.writeFile(file, Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('services:\n', 'utf16le'),
    ]));

    await expect(readComposeInputWithinCap(file, 1024)).resolves.toEqual({
      content: 'services:\n',
      tooLarge: false,
    });
  });

  it('decodes a UTF-16BE file with a byte-order mark', async () => {
    const file = path.join(dir, 'compose.yaml');
    const body = Buffer.from('services:\n', 'utf16le');
    body.swap16();
    await fsPromises.writeFile(file, Buffer.concat([Buffer.from([0xfe, 0xff]), body]));

    await expect(readComposeInputWithinCap(file, 1024)).resolves.toEqual({
      content: 'services:\n',
      tooLarge: false,
    });
  });

  it('drops a UTF-8 byte-order mark', async () => {
    const file = path.join(dir, 'compose.yaml');
    await fsPromises.writeFile(file, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('services:\n', 'utf8'),
    ]));

    await expect(readComposeInputWithinCap(file, 1024)).resolves.toEqual({
      content: 'services:\n',
      tooLarge: false,
    });
  });

  it('applies the byte cap to an encoded file, not its decoded length', async () => {
    const file = path.join(dir, 'compose.yaml');
    await fsPromises.writeFile(file, Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('x'.repeat(32), 'utf16le'),
    ]));

    await expect(readComposeInputWithinCap(file, 16)).resolves.toEqual({
      content: null,
      tooLarge: true,
    });
  });

  it('reports a file larger than the cap without reading it', async () => {
    const file = path.join(dir, 'compose.yaml');
    await fsPromises.writeFile(file, 'x'.repeat(32));

    await expect(readComposeInputWithinCap(file, 16)).resolves.toEqual({
      content: null,
      tooLarge: true,
    });
  });

  it('skips a missing file', async () => {
    await expect(readComposeInputWithinCap(path.join(dir, 'missing.yaml'), 1024))
      .resolves.toEqual({ content: null, tooLarge: false });
  });

  it('skips a directory', async () => {
    await expect(readComposeInputWithinCap(dir, 1024))
      .resolves.toEqual({ content: null, tooLarge: false });
  });

  it('skips a broken symlink', async () => {
    const link = path.join(dir, 'compose.yaml');
    await fsPromises.symlink(path.join(dir, 'gone.yaml'), link);

    await expect(readComposeInputWithinCap(link, 1024))
      .resolves.toEqual({ content: null, tooLarge: false });
  });

  it('skips an input it is not allowed to read', async () => {
    vi.spyOn(fsPromises, 'open').mockRejectedValueOnce(codedError('EACCES'));

    await expect(readComposeInputWithinCap(path.join(dir, 'compose.yaml'), 1024))
      .resolves.toEqual({ content: null, tooLarge: false });
  });

  it('rethrows an unexpected open failure rather than handing the file to Compose unmeasured', async () => {
    vi.spyOn(fsPromises, 'open').mockRejectedValueOnce(codedError('EIO', 'input/output error'));

    await expect(readComposeInputWithinCap(path.join(dir, 'compose.yaml'), 1024))
      .rejects.toThrow('input/output error');
  });

  it('rethrows an unexpected read failure and closes the descriptor', async () => {
    const handle = fakeHandle({
      stat: vi.fn().mockResolvedValue({ isFile: () => true, size: 10 }),
      read: vi.fn().mockRejectedValue(codedError('EIO', 'input/output error')),
    });
    vi.spyOn(fsPromises, 'open').mockResolvedValueOnce(handle);

    await expect(readComposeInputWithinCap(path.join(dir, 'compose.yaml'), 1024))
      .rejects.toThrow('input/output error');
    expect(handle.close).toHaveBeenCalled();
  });

  it('keeps the content when only the descriptor close fails', async () => {
    const handle = fakeHandle({
      close: vi.fn().mockRejectedValue(codedError('EBADF')),
    });
    vi.spyOn(fsPromises, 'open').mockResolvedValueOnce(handle);

    await expect(readComposeInputWithinCap(path.join(dir, 'compose.yaml'), 1024))
      .resolves.toEqual({ content: '', tooLarge: false });
  });
});
