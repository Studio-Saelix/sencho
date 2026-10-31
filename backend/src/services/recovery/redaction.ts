import { redactSensitiveText } from '../../utils/safeLog';
import type { RecoveryErrorClass } from './types';

/**
 * The redaction boundary for recovery.
 *
 * Plaintext repository passwords, keys, file bodies and raw engine output never
 * leave node memory: the database holds only `enc:` ciphertext of a password.
 * API responses, audit rows and notifications carry a fixed error class and
 * its fixed sentence (`errorDetailFor`), never an engine message. A node-local
 * log line that carries engine output goes through `redactRecoveryLogText` or
 * `errorMessageForLog`. Point evidence is rebuilt from its known fields, and
 * its snapshot id and consistency are checked by `assertMetadataOnly`, before
 * it is stored.
 */

const ERROR_DETAIL: Record<RecoveryErrorClass, string> = {
  invalid_request: 'The request is not valid for this storage.',
  permission_denied: 'You do not have permission for this recovery action.',
  capability_unavailable: 'Volume protection is not available on this node.',
  update_required: 'This node needs an update before it can protect volumes.',
  schema_unsupported: 'This build cannot read the recovery records on this node.',
  identity_unknown: 'The storage identity could not be established.',
  lock_held: 'Another recovery operation is running on this node.',
  lock_stale: 'An interrupted operation still holds a lock this request needs and must be reviewed.',
  repository_unavailable: 'The recovery repository is not reachable.',
  repository_key_unavailable: 'The recovery repository key is not available.',
  source_unreadable: 'Some data could not be read.',
  integrity_mismatch: 'The recovery point failed its integrity check.',
  attributes_not_restored: 'The files were restored, but some file attributes could not be applied.',
  interrupted: 'The operation was interrupted before it reported a result.',
  transport_unreachable: 'The node could not be reached.',
  node_refused: 'The node refused the request.',
  node_error: 'The node, or the recovery helper running on it, failed to complete the request.',
  internal: 'The recovery operation failed.',
};

export function errorDetailFor(errorClass: RecoveryErrorClass): string {
  return ERROR_DETAIL[errorClass];
}

export function isRecoveryErrorClass(value: unknown): value is RecoveryErrorClass {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ERROR_DETAIL, value);
}

/** What a refusal can say beyond its class: a machine reason and a more specific sentence. */
export interface RecoveryErrorOptions {
  /** A stable token a client can switch on, such as `repository_not_initialized`. */
  reason?: string;
  /** A fixed sentence for this refusal. Never built from engine output. */
  detail?: string;
}

/** A recovery failure that already carries its sanitized class. */
export class RecoveryError extends Error {
  readonly errorClass: RecoveryErrorClass;
  readonly reason: string | undefined;
  readonly detail: string;
  constructor(errorClass: RecoveryErrorClass, options: RecoveryErrorOptions = {}) {
    const detail = options.detail ?? ERROR_DETAIL[errorClass];
    super(detail);
    this.name = 'RecoveryError';
    this.errorClass = errorClass;
    this.reason = options.reason;
    this.detail = detail;
  }
}

/** Class of any thrown value; anything that is not a RecoveryError is `internal`. */
export function classifyRecoveryError(err: unknown): RecoveryErrorClass {
  return err instanceof RecoveryError ? err.errorClass : 'internal';
}

/**
 * Text for a node-local log line. Strips every known secret value verbatim
 * (the repository password the engine was handed, for instance), then the
 * generic credential shapes. Never use it to build an API or audit payload:
 * those carry `errorDetailFor` only.
 */
export function redactRecoveryLogText(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret.length > 0) out = out.split(secret).join('[redacted]');
  }
  return redactSensitiveText(out);
}

const SECRET_KEY_PATTERN = /password|passphrase|secret|token|credential|private_?key|api_?key|encryption_?key|repository_?key|^key$/i;
/** Home-directory prefixes are not credentials; the generic redactor rewrites them too. */
const HOME_PREFIX_PATTERN = /\/home\/|\/Users\/|:\\Users\\/g;

function hasCredentialShape(text: string): boolean {
  const probe = text.replace(HOME_PREFIX_PATTERN, '/');
  return redactSensitiveText(probe) !== probe;
}

/**
 * Throw when a metadata object about to cross a boundary (database JSON column,
 * API response, hub dispatch) carries a secret-shaped key or a string that
 * looks like a credential. Evidence is counts, ids, classes and timestamps.
 */
export function assertMetadataOnly(value: unknown, where: string): void {
  const visit = (node: unknown, trail: string): void => {
    if (typeof node === 'string') {
      if (hasCredentialShape(node)) {
        throw new Error(`Recovery metadata at ${where}${trail} carries credential-shaped text`);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((child, i) => visit(child, `${trail}[${i}]`));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        if (SECRET_KEY_PATTERN.test(key)) {
          throw new Error(`Recovery metadata at ${where}${trail} carries a secret-shaped key`);
        }
        visit(child, `${trail}.${key}`);
      }
    }
  };
  visit(value, '');
}
