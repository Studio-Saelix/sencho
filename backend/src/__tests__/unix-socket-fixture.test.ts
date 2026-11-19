/**
 * The socket fixture has to place a real socket at the target path no matter
 * how deep the caller's temp directory is. Linux caps a socket address at 108
 * bytes, so a fixture that binds the target directly passes on a short CI path
 * and fails on a deep one; this test runs at a depth good luck will not reach.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { withUnixSocketAt } from './helpers/unixSocketFixture';

describe('withUnixSocketAt', () => {
  it('places the socket at a target deeper than the kernel address limit', async () => {
    const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sencho-sock-target-'));
    const deep = path.join(base, ...Array.from({ length: 6 }, () => 'd'.repeat(40)));
    await fs.promises.mkdir(deep, { recursive: true });
    const target = path.join(deep, 'home.sock');
    expect(target.length).toBeGreaterThan(107);
    try {
      await withUnixSocketAt(target, async () => {
        // Recovery stats this path, so the entry itself has to be the socket,
        // not a link to one.
        const entry = await fs.promises.lstat(target);
        expect(entry.isSymbolicLink()).toBe(false);
        expect(entry.isSocket()).toBe(true);
      });
      // Closing the server leaves the target free for the caller to rewrite.
      await expect(fs.promises.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.promises.rm(base, { recursive: true, force: true });
    }
  });
});

describe('the Unix socket bind guard', () => {
  it('refuses a direct bind, which is the shape a deep temp directory breaks', () => {
    const server = net.createServer();
    expect(() => server.listen(path.join(os.tmpdir(), 'sencho-direct.sock')))
      .toThrow(/use withUnixSocketAt/);
  });

  it('refuses the options form of a direct bind too', () => {
    const server = net.createServer();
    expect(() => server.listen({ path: path.join(os.tmpdir(), 'sencho-options.sock') }))
      .toThrow(/use withUnixSocketAt/);
  });

  it('leaves a TCP listen alone', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
