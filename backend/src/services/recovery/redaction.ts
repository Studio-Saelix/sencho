import { redactSensitiveText } from '../../utils/safeLog';
import type { RecoveryErrorClass } from './types';

/**
 * The redaction boundary for recovery.
 *
 * Repository passwords, keys, file bodies and raw engine output stay on the
 * node, in memory. What crosses into the database, an API response, an audit
 * row, a notification or a log is a fixed error class with a fixed sentence,
 * plus metadata that has been checked for secret-shaped keys.
 */

const ERROR_DETAIL: Record<RecoveryErrorClass, string> = {
  invalid_request: 'The request is not valid for this storage.',
  permission_denied: 'You do not have permission for every stack that uses this storage.',
  capability_unavailable: 'Volume protection is not available on this node.',
  update_required: 'This node needs an update before it can protect volumes.',
  schema_unsupported: 'This build cannot read the recovery records on this node.',
  identity_unknown: 'The storage identity could not be established.',
  lock_held: 'Another recovery operation is running on this storage.',
  lock_stale: 'An interrupted operation still holds this storage and must be reviewed.',
  repository_unavailable: 'The recovery repository is not reachable.',
  repository_key_unavailable: 'The recovery repository key is not available.',
  source_unreadable: 'Some data could not be read.',
  integrity_mismatch: 'The recovery point failed its integrity check.',
  interrupted: 'The operation was interrupted before it reported a result.',
  transport_unreachable: 'The node could not be reached.',
  internal: 'The recovery operation failed.',
};

export function errorDetailFor(errorClass: RecoveryErrorClass): string {
  return ERROR_DETAIL[errorClass];
}

export function isRecoveryErrorClass(value: unknown): value is RecoveryErrorClass {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ERROR_DETAIL, value);
}

/** A recovery failure that already carries its sanitized class. */
export class RecoveryError extends Error {
  readonly errorClass: RecoveryErrorClass;
  constructor(errorClass: RecoveryErrorClass) {
    super(ERROR_DETAIL[errorClass]);
    this.name = 'RecoveryError';
    this.errorClass = errorClass;
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

/**
 * Throw when a metadata object about to cross a boundary (database JSON column,
 * API response, hub dispatch) carries a secret-shaped key or a string that
 * looks like a credential. Evidence is counts, ids, classes and timestamps.
 */
export function assertMetadataOnly(value: unknown, where: string): void {
  const visit = (node: unknown, trail: string): void => {
    if (typeof node === 'string') {
      const probe = node.replace(HOME_PREFIX_PATTERN, '/');
      if (redactSensitiveText(probe) !== probe) {
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
