/**
 * A real Unix socket at a test-owned path.
 *
 * Linux caps a socket address at the kernel's `sun_path` size (108 bytes), so a
 * bind at a path under the per-test temp directory fails with `EINVAL` once
 * `TMPDIR` or the checkout is deep enough. Bind through a short alias of the
 * target's directory instead: the socket still lands at `target` itself, which
 * is where the code under test looks for it, and closing the server unlinks it
 * there. The alias root stays fixed and short because `os.tmpdir()` is exactly
 * the value that pushes the address over the limit.
 */
import fs from 'fs';
import net from 'net';
import path from 'path';
import { runWithUnixSocketBindAllowed } from './unixSocketBindGuard';

export async function withUnixSocketAt(
  target: string,
  run: () => Promise<void>,
): Promise<void> {
  const aliasRoot = await fs.promises.mkdtemp(path.join('/tmp', 'sencho-sock-'));
  const server = net.createServer();
  try {
    const alias = path.join(aliasRoot, 'dir');
    await fs.promises.symlink(path.dirname(target), alias);
    await runWithUnixSocketBindAllowed(() => new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path.join(alias, path.basename(target)), resolve);
    }));
    await run();
  } finally {
    // The server unlinks the address it was given, which resolves through the
    // alias to the socket at `target`.
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await fs.promises.rm(aliasRoot, { recursive: true, force: true });
  }
}
