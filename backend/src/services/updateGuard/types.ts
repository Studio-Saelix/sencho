/** Overall verdict of an update readiness check. */
export type ReadinessVerdict = 'ready' | 'ready_with_warnings' | 'review_required' | 'blocked' | 'unknown';

/** Graded status of a single readiness signal. */
export type SignalStatus = 'ok' | 'warning' | 'attention' | 'blocked' | 'unknown';

/** One input to the readiness verdict (preflight, drift, containers, ...). */
export interface ReadinessSignal {
  id: 'preflight' | 'drift' | 'containers' | 'healthchecks' | 'update_preview' | 'backup_slot' | 'disk';
  status: SignalStatus;
  /** Short headline ("Compose Doctor", "Running containers"). */
  title: string;
  /** What was observed and why it matters. Never carries an env value. */
  detail: string;
  /**
   * False for informational unknowns (preflight never run, preview
   * unavailable) that should not drag the overall verdict to `unknown`.
   */
  affectsVerdict: boolean;
}

/** Computed on demand; not persisted (the inputs keep their own history). */
export interface UpdateReadinessReport {
  stack: string;
  computedAt: number;
  verdict: ReadinessVerdict;
  signals: ReadinessSignal[];
}

/** State of one rollback readiness item. */
export type RollbackItemState = 'ready' | 'missing' | 'unknown' | 'not_covered';

export interface RollbackReadinessItem {
  id: 'compose_source' | 'env_keys' | 'previous_images' | 'last_deploy' | 'healthchecks' | 'volume_data';
  state: RollbackItemState;
  label: string;
  /** Names only for env coverage; values never appear here. */
  detail: string;
}

export type RollbackOverall = 'ready' | 'partial' | 'not_ready';

export interface RollbackReadinessReport {
  stack: string;
  computedAt: number;
  overall: RollbackOverall;
  items: RollbackReadinessItem[];
}

/** Normalized per-container probe used by readiness and the health gate. */
export interface ContainerProbe {
  name: string;
  /** Docker container state (running, exited, restarting, ...), or 'unknown'. */
  state: string;
  /** Docker health status (healthy | unhealthy | starting) or null without a healthcheck. */
  health: string | null;
  exitCode: number | null;
  hasHealthcheck: boolean;
  /** RestartPolicy.Name, or null/'no' when none is set. */
  restartPolicy: string | null;
  /** Mount descriptors ("volume data", "bind /srv/app"), for coverage disclosure. */
  mounts: string[];
}

/** Lifecycle of a post-update health gate observation. */
export type HealthGateStatus = 'observing' | 'passed' | 'failed' | 'unknown';

/** Per-container end state captured when a gate run finalizes. */
export interface HealthGateContainer {
  name: string;
  /** Docker container state, or 'missing' when it vanished mid-observation. */
  state: string;
  health: string | null;
  restarts: number;
}

/** Payload of GET /:stackName/health-gate ('never-run' when no run exists). */
export interface HealthGateReport {
  stack: string;
  id: string | null;
  status: HealthGateStatus | 'never-run';
  trigger: 'update' | 'deploy' | null;
  reason: string | null;
  windowSeconds: number | null;
  startedAt: number | null;
  endedAt: number | null;
  containers: HealthGateContainer[];
}

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
