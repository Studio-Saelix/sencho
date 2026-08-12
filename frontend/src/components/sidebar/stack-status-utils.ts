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
export interface ContainerStateInfo {
  State: string;
  Status?: string;
}

/** Whether a value satisfies the minimal container shape. The legacy
 *  per-stack fallback must not count a successful-but-malformed response
 *  (e.g. `{ error: "..." }` or an array of junk) as authoritative coverage. */
export function isContainerStateInfo(value: unknown): value is ContainerStateInfo {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { State?: unknown }).State === 'string'
  );
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

const STATUS_VALUES: ReadonlySet<string> = new Set(['running', 'exited', 'unknown', 'partial']);

/** Whether a value is a recognized runtime status string. Guards both payload
 *  validators so an arbitrary string (e.g. an error object) is never mistaken
 *  for a legacy status map, which would otherwise fan out N per-stack fallback
 *  requests for one malformed response. */
function isStatusValue(value: unknown): value is StackRowStatus {
  return typeof value === 'string' && STATUS_VALUES.has(value);
}

/** Per-stack entry shape of the current bulk status payload. */
export interface BulkStatusPayloadEntry {
  status: StackRowStatus;
  mainPort?: number;
  running?: number;
  total?: number;
  isSelf?: boolean;
}

/** Whether a bulk payload's entries all carry a recognized runtime status and
 *  well-typed optional fields. Distinguishes the current object format with
 *  valid values from a malformed payload that merely has a `status` property
 *  with an unrecognized value, or carries a mistyped port/count field that
 *  would flow into `buildServiceUrl` and the row counts. */
export function isValidBulkPayload(
  raw: unknown,
): raw is Record<string, BulkStatusPayloadEntry> {
  if (!isBulkStatusObjectFormat(raw)) return false;
  return Object.values(raw as Record<string, unknown>).every((val) => {
    const entry = val as {
      status?: unknown;
      mainPort?: unknown;
      running?: unknown;
      total?: unknown;
      isSelf?: unknown;
    };
    return (
      isStatusValue(entry.status) &&
      (entry.mainPort === undefined || typeof entry.mainPort === 'number') &&
      (entry.running === undefined || typeof entry.running === 'number') &&
      (entry.total === undefined || typeof entry.total === 'number') &&
      (entry.isSelf === undefined || typeof entry.isSelf === 'boolean')
    );
  });
}

/** Parse a validated bulk status payload into the row-facing maps plus the
 *  count of current-list files it covers. Coverage counts exact filename
 *  matches; unrelated keys never contribute. */
export function parseBulkStatusPayload(
  raw: Record<string, BulkStatusPayloadEntry>,
  fileList: string[],
): {
  statuses: Record<string, StackRowStatus>;
  ports: Record<string, number | undefined>;
  self: Record<string, boolean>;
  counts: Record<string, { running: number; total: number } | undefined>;
  coveredFileCount: number;
} {
  const statuses: Record<string, StackRowStatus> = {};
  const ports: Record<string, number | undefined> = {};
  const self: Record<string, boolean> = {};
  const counts: Record<string, { running: number; total: number } | undefined> = {};
  let coveredFileCount = 0;
  for (const [key, val] of Object.entries(raw)) {
    statuses[key] = val.status;
    if (val.mainPort) ports[key] = val.mainPort;
    if (val.isSelf) self[key] = true;
    if (val.running !== undefined && val.total !== undefined) {
      counts[key] = { running: val.running, total: val.total };
    }
  }
  for (const file of fileList) {
    if (raw[file] !== undefined) coveredFileCount += 1;
  }
  return { statuses, ports, self, counts, coveredFileCount };
}

/** Whether a payload is a legacy string-value map whose values are recognized
 *  runtime statuses (the pre-object-format response). A string map with other
 *  values (e.g. `{ error: "failed" }`) is malformed, not legacy. */
export function isValidLegacyPayload(raw: unknown): raw is Record<string, StackRowStatus> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
  return Object.values(raw as Record<string, unknown>).every(isStatusValue);
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
