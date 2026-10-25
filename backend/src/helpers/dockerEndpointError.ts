/**
 * The Docker endpoint guard's refusal type, in a module with no imports so the
 * services that only need to recognise a refusal (recovery, deletion) can do so
 * without loading the guard and the Docker services it reads.
 */
export const DOCKER_ENDPOINT_PROTECTED_CODE = 'docker_endpoint_protected';

export const ENDPOINT_REFUSAL_REASONS = ['sencho', 'provider', 'invalid_label', 'unresolved'] as const;
export type EndpointRefusalReason = typeof ENDPOINT_REFUSAL_REASONS[number];

/** Whether anything moved before a restore was refused; set by the recovery that knows. */
export type EndpointFailureClass = 'pre_mutation' | 'post_mutation';

export interface DockerEndpointRefusal {
  reason: EndpointRefusalReason;
  service: string | null;
  message: string;
}

export class DockerEndpointProtectedError extends Error {
  readonly code = DOCKER_ENDPOINT_PROTECTED_CODE;
  readonly reason: EndpointRefusalReason;
  readonly service: string | null;
  failureClass?: EndpointFailureClass;

  constructor(refusal: DockerEndpointRefusal) {
    super(refusal.message);
    this.name = 'DockerEndpointProtectedError';
    this.reason = refusal.reason;
    this.service = refusal.service;
    Object.setPrototypeOf(this, DockerEndpointProtectedError.prototype);
  }
}

export function isDockerEndpointProtectedError(error: unknown): error is DockerEndpointProtectedError {
  return error instanceof DockerEndpointProtectedError;
}

/**
 * Recognises a refusal wherever it came from: raised in this process, or
 * answered by a remote node's own guard (a 409 carrying the same code, which
 * `remoteStackError` surfaces with the remote's message and reason). Returns
 * the text to show and the reason, or null for any other error.
 */
export function dockerEndpointRefusalOf(error: unknown): { message: string; reason: EndpointRefusalReason | null } | null {
  if (isDockerEndpointProtectedError(error)) return { message: error.message, reason: error.reason };
  if (!(error instanceof Error)) return null;
  const remote = error as Error & { code?: unknown; httpStatus?: unknown; remoteError?: unknown; remoteReason?: unknown };
  if (remote.code !== DOCKER_ENDPOINT_PROTECTED_CODE || remote.httpStatus !== 409) return null;
  return {
    message: typeof remote.remoteError === 'string' && remote.remoteError ? remote.remoteError : error.message,
    reason: ENDPOINT_REFUSAL_REASONS.find(reason => reason === remote.remoteReason) ?? null,
  };
}
