import fs from 'fs';
import os from 'os';
import path from 'path';

export interface TrustedRootValidationOptions {
  /** Absolute path to the application-owned root directory. */
  rootPath: string;
  /** Human-readable kind for error messages (e.g. docker-auth, prepared-source). */
  kind: string;
}

export type TrustedRootValidationResult =
  | {
      ok: true;
      resolvedRoot: string;
      resolvedTempRoot: string;
    }
  | {
      ok: false;
      reason: string;
    };

function getExpectedUid(): number | null {
  if (typeof process.getuid === 'function') {
    return process.getuid();
  }
  return null;
}

function hasPrivateDirectoryMode(mode: number): boolean {
  return (mode & 0o777) === 0o700;
}

/**
 * Validate that an application-owned root directory is safe to use for
 * sensitive payload writes and startup sweeps. Fails closed when the path is
 * missing, not a directory, a symlink, owned by another user, or has loose
 * permissions, or when resolved containment escapes the system temp root.
 */
export function validateTrustedRoot(options: TrustedRootValidationOptions): TrustedRootValidationResult {
  const { rootPath, kind } = options;

  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(rootPath);
  } catch {
    return { ok: false, reason: `${kind} root does not exist` };
  }

  if (!rootStat.isDirectory()) {
    return { ok: false, reason: `${kind} root is not a directory` };
  }
  if (rootStat.isSymbolicLink()) {
    return { ok: false, reason: `${kind} root is a symlink` };
  }
  if (!hasPrivateDirectoryMode(rootStat.mode)) {
    return { ok: false, reason: `${kind} root permissions are not private` };
  }

  const expectedUid = getExpectedUid();
  if (expectedUid !== null && rootStat.uid !== expectedUid) {
    return { ok: false, reason: `${kind} root is not owned by this process` };
  }

  let resolvedRoot: string;
  let resolvedTempRoot: string;
  try {
    resolvedRoot = fs.realpathSync(rootPath);
    resolvedTempRoot = fs.realpathSync(os.tmpdir());
  } catch {
    return { ok: false, reason: `${kind} root could not be resolved` };
  }

  const relative = path.relative(resolvedTempRoot, resolvedRoot);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, reason: `${kind} root escapes the temporary root` };
  }

  return { ok: true, resolvedRoot, resolvedTempRoot };
}

/**
 * Create a trusted root directory with mode 0700 when absent, then validate it.
 */
export function ensureTrustedRoot(options: TrustedRootValidationOptions): TrustedRootValidationResult {
  const { rootPath } = options;
  if (!fs.existsSync(rootPath)) {
    fs.mkdirSync(rootPath, { recursive: true, mode: 0o700 });
  }
  return validateTrustedRoot(options);
}
