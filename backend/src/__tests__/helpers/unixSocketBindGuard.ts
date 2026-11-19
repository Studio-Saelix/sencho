/**
 * Refuses a Unix-domain socket bind that bypasses `withUnixSocketAt`.
 *
 * Linux caps a socket address at 108 bytes, so a direct bind under the per-test
 * temp directory passes on a short CI path and fails with `EINVAL` on a deep
 * one. That means the deep-path failure only shows up on a developer machine.
 * The setup file installs this guard in every test worker, so the next fixture
 * that writes its own `server.listen(path)` fails everywhere instead.
 */
import net from 'net';

let allowedBinds = 0;
let installed = false;

/** Runs the one bind `withUnixSocketAt` owns. Not for other callers. */
export function runWithUnixSocketBindAllowed<T>(action: () => T): T {
  allowedBinds += 1;
  try {
    return action();
  } finally {
    allowedBinds -= 1;
  }
}

// Node reads a string as a TCP port when `Number(value) >= 0` and as a socket
// path otherwise, so the guard has to make the same split or it would refuse
// `listen('0')` while allowing the path bind it exists to catch.
function isUnixPath(value: unknown): value is string {
  return typeof value === 'string' && !(Number(value) >= 0);
}

function unixPathArgument(args: readonly unknown[]): string | undefined {
  const first = args[0];
  if (isUnixPath(first)) return first;
  if (first !== null && typeof first === 'object' && 'path' in first) {
    const socketPath = (first as { path?: unknown }).path;
    if (isUnixPath(socketPath)) return socketPath;
  }
  return undefined;
}

export function installUnixSocketBindGuard(): void {
  if (installed) return;
  installed = true;
  const originalListen = net.Server.prototype.listen as unknown as (
    this: net.Server,
    ...args: unknown[]
  ) => net.Server;
  net.Server.prototype.listen = function guardedListen(
    this: net.Server,
    ...args: unknown[]
  ): net.Server {
    const socketPath = unixPathArgument(args);
    if (socketPath !== undefined && allowedBinds === 0) {
      throw new Error(
        `test bound a Unix socket directly at ${socketPath}; use withUnixSocketAt so the bind goes through the short alias`,
      );
    }
    return originalListen.apply(this, args);
  } as typeof net.Server.prototype.listen;
}
