/** Categories a failed stack deploy or update can be classified into. */
export type FailureReason =
  | 'image_pull_failed'
  | 'compose_render_failed'
  | 'env_missing'
  | 'port_conflict'
  | 'bind_path_missing'
  | 'permission_denied'
  | 'container_exited'
  | 'healthcheck_failed'
  | 'dependency_unavailable'
  | 'node_unreachable'
  | 'unknown';

/**
 * Operator-facing classification of a failed deploy/update, attached to the
 * route's error response so the recovery surfaces can show a cause and a next
 * step instead of only the raw compose output.
 */
export interface FailureClassification {
  reason: FailureReason;
  /** Short display headline ("Host port conflict"). */
  label: string;
  /** Suggested next action, one sentence. */
  suggestion: string;
}
