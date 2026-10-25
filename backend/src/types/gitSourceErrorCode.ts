/**
 * The single source of the git source error code list.
 *
 * Deliberately a leaf module with no imports. The service that raises these
 * codes and the HTTP helper that maps and validates them both import from
 * here, so neither has to read a value through the other while a module cycle
 * is still evaluating. An empty set would silently disable the code check.
 */
export const GIT_SOURCE_ERROR_CODE_VALUES = [
    'REPO_NOT_FOUND',
    'AUTH_FAILED',
    'REF_NOT_FOUND',
    'REF_DELETED',
    'UNSUPPORTED_REF',
    'SSH_HOST_KEY_FAILED',
    'FILE_NOT_FOUND',
    'RATE_LIMITED',
    'NETWORK_TIMEOUT',
    'GIT_ERROR',
    'STALE_PLAN',
    'PLAN_FINGERPRINT_REQUIRED',
    'PLAN_BLOCKED',
    'LEGACY_PENDING',
    'PLAN_UNAVAILABLE',
    'OPERATION_IN_FLIGHT',
    'SOURCE_CLAIMED_BY_BLUEPRINT',
    'SOPS_DECRYPT_FAILED',
] as const;

export type GitSourceErrorCode = (typeof GIT_SOURCE_ERROR_CODE_VALUES)[number];
