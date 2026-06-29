export type StackRowStatus = 'running' | 'exited' | 'unknown' | 'partial';

export function statusText(status: StackRowStatus): string {
  if (status === 'running') return 'UP';
  if (status === 'exited') return 'DN';
  if (status === 'partial') return 'PT';
  return '--';
}

export function statusColor(status: StackRowStatus, isBusy: boolean): string {
  if (isBusy) return 'text-muted-foreground';
  if (status === 'running') return 'text-success';
  if (status === 'exited') return 'text-destructive';
  if (status === 'partial') return 'text-warning';
  return 'text-stat-icon';
}

/** Stacks the Down filter surfaces: fully stopped, or partially crashed. */
export function isDownStatus(status: StackRowStatus | undefined): boolean {
  return status === 'exited' || status === 'partial';
}

/** Minimal container shape needed to classify a stack's status. */
interface ContainerStateInfo {
  State: string;
  Status?: string;
}

/** Exit code parsed from a Docker status string like "Exited (1) 2 hours ago".
 *  Returns null when no parenthesized code is present (e.g. "Up 3 hours"). */
function parseExitCode(status: string | undefined): number | null {
  if (!status) return null;
  const match = /\((\d+)\)/.exec(status);
  return match ? Number(match[1]) : null;
}

/** Whether a container is a genuine crash rather than a clean finish. Mirrors
 *  the backend bulk-status classifier so the compatibility fallback agrees with
 *  a current node's `/stacks/statuses`: a dead container always counts, and an
 *  exited or restarting one counts only with a non-zero (or unreadable) code, so
 *  a finished init job (exit 0) does not mark its stack degraded. */
function isContainerFailed(state: string, status: string | undefined): boolean {
  if (state === 'dead') return true;
  if (state === 'exited' || state === 'restarting') {
    const code = parseExitCode(status);
    return code === null ? true : code !== 0;
  }
  return false;
}

/** Whether a parsed `/stacks/statuses` response is the current object format
 *  (`{ status, ... }` per stack) rather than the legacy plain-string format.
 *  Only the object format can express `partial`; a legacy plain-string response
 *  has already collapsed a degraded stack into "running", so it (like a missing
 *  endpoint) must be re-derived from per-stack containers. An empty object is
 *  the current format for a node with no stacks. */
export function isBulkStatusObjectFormat(raw: unknown): boolean {
  return (
    raw !== null &&
    typeof raw === 'object' &&
    Object.values(raw as Record<string, unknown>).every(
      (val) => val !== null && typeof val === 'object' && 'status' in val,
    )
  );
}

/** Derive a stack's row status from its container list, distinguishing a fully-up
 *  stack from one that is partially degraded (some running, some crashed). Used by
 *  the compatibility path for remote nodes whose bulk status endpoint is absent or
 *  predates partial-status support, where trusting "any container running" would
 *  show a degraded stack as healthy. */
export function classifyContainersStatus(containers: ContainerStateInfo[]): StackRowStatus {
  if (containers.length === 0) return 'unknown';
  let running = 0;
  let failed = 0;
  for (const c of containers) {
    if (c.State === 'running') running += 1;
    else if (isContainerFailed(c.State, c.Status)) failed += 1;
  }
  if (running === 0) return 'exited';
  return failed > 0 ? 'partial' : 'running';
}
