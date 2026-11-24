/** Refusal codes a node answers on `/api/sealed-secrets/*`. */
export type SealedSecretNodeCode =
  | 'SEALED_SECRET_PURPOSE_UNKNOWN'
  | 'SEALED_SECRET_SLOT_INVALID'
  | 'SEALED_SECRET_REQUEST_INVALID'
  | 'SEALED_SECRET_OPEN_FAILED'
  | 'SEALED_SECRET_GENERATION_STALE'
  | 'SECRET_VOLUME_FOREIGN'
  | 'SECRET_STORE_UNAVAILABLE';

/** Refusal codes the hub answers when it will not, or could not, deliver. */
export type SealedSecretHubCode =
  | 'SEALED_SECRET_TARGET_UNSUPPORTED'
  | 'SEALED_SECRET_TARGET_UNREACHABLE'
  | 'SEALED_SECRET_TRANSPORT_NOT_CONFIDENTIAL'
  | 'SEAL_KEY_MISMATCH'
  | 'SEALED_SECRET_TARGET_REFUSED'
  | 'SEALED_SECRET_DELIVERY_PENDING'
  | 'SEALED_SECRET_DELIVERY_FAILED';

export type SealedSecretCode = SealedSecretNodeCode | SealedSecretHubCode;

/**
 * A named refusal. The status is never 401 (a 401 signs the browser out on the
 * hub) and never 404 for a domain refusal (a node's 404 reads as "route
 * missing", which is how an older node is told apart). The message never
 * carries secret material.
 */
export class SealedSecretError extends Error {
  readonly code: SealedSecretCode;
  readonly status: number;
  /** Extra machine-readable facts for the response body (never secret). */
  readonly details: Record<string, string | number | null>;

  constructor(code: SealedSecretCode, status: number, message: string, details: Record<string, string | number | null> = {}) {
    super(message);
    this.name = 'SealedSecretError';
    this.code = code;
    this.status = status;
    this.details = details;
    Object.setPrototypeOf(this, SealedSecretError.prototype);
  }
}

export function isSealedSecretError(error: unknown): error is SealedSecretError {
  return error instanceof SealedSecretError;
}
