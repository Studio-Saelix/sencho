import type { Response } from 'express';
import { RECOVERY_RESERVED_PREFIX } from '../services/recovery/reservedNames';

/**
 * The refusal when a stack's volume removal would delete the recovery repository.
 *
 * `/system/volumes/delete`, the prune plan and the managed sweep already skip the
 * repository volume. `docker compose down --volumes` is the other way a volume
 * disappears: Compose removes every non-external volume the stack declares, by
 * name, so a stack that declares the repository volume would take every recovery
 * point with it. Compose cannot be told to skip one volume, so the whole removal
 * is refused and the stack can still be taken down or deleted without it. The
 * same refusal covers a stack whose volumes could not be read at all.
 */
export const RECOVERY_VOLUME_PROTECTED_CODE = 'recovery_volume_protected';

export class RecoveryVolumeProtectedError extends Error {
  readonly code = RECOVERY_VOLUME_PROTECTED_CODE;

  constructor(message: string) {
    super(message);
    this.name = 'RecoveryVolumeProtectedError';
    Object.setPrototypeOf(this, RecoveryVolumeProtectedError.prototype);
  }
}

export function isRecoveryVolumeProtectedError(error: unknown): error is RecoveryVolumeProtectedError {
  return error instanceof RecoveryVolumeProtectedError;
}

/**
 * The names among `volumeNames` that belong to the recovery repository: the
 * reserved prefix covers every generation Sencho ever created (a replaced
 * repository's volume is kept), and `isRegistered` covers a locator the engine
 * has recorded.
 */
export function recoveryVolumeNamesIn(
  volumeNames: Iterable<string>,
  isRegistered: (name: string) => boolean,
): string[] {
  const found = new Set<string>();
  for (const name of volumeNames) {
    if (name.startsWith(RECOVERY_RESERVED_PREFIX) || isRegistered(name)) found.add(name);
  }
  return [...found];
}

/** The refusal text when a stack declares the repository volume. */
export function recoveryVolumeRefusalMessage(): string {
  return 'This stack declares a recovery repository volume, and removing volumes would delete the recovery points it holds. '
    + 'Run the operation without removing volumes, or remove that volume from the stack\'s compose file first.';
}

/** The refusal text when the stack's volumes could not be read, so nothing can be promised. */
export function recoveryVolumeUnverifiedMessage(): string {
  return 'Sencho could not read this stack\'s volumes to check that none is a recovery repository volume, so volumes were not removed. '
    + 'Run the operation without removing volumes, or retry once the stack\'s compose configuration renders again.';
}

/** Answers 423 with the refusal's code when `error` is one. Returns false for any other error. */
export function sendIfRecoveryVolumeProtected(res: Response, error: unknown): boolean {
  if (!isRecoveryVolumeProtectedError(error)) return false;
  if (!res.headersSent) res.status(423).json({ error: error.message, code: error.code });
  return true;
}
