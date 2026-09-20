import type { RollbackOverall, ReadinessVerdict } from '../updateGuard/types';
import type { Node, NodeMode } from '../DatabaseService';
import type { PreviewContactSource, PreviewReachabilityNote } from '../blueprintPreviewProjection';

/** The six readiness domains, in the order the matrix renders its columns. */
export const READINESS_DOMAINS = [
  'connectivity',
  'workloads',
  'updates',
  'recovery',
  'security',
  'control',
] as const;

export type ReadinessDomainKey = (typeof READINESS_DOMAINS)[number];

/**
 * Domain states, worst first.
 *
 * The order is executable rather than prose: a node's worst domain is the
 * first of its cell states found in this list, and the summary renders its
 * buckets in the same order. A known problem outranks a not-knowable one
 * because this surface exists to answer "what needs attention now";
 * `unavailable` (no evidence at all) outranks `unknown` (incomplete evidence).
 */
export const DOMAIN_STATE_ORDER = [
  'attention',
  'degraded',
  'unavailable',
  'unknown',
  'healthy',
] as const;

/**
 * State of one domain on one node.
 *
 * `unknown` and `unavailable` are separate on purpose. `unavailable` means the
 * domain was never evaluated on this node (capability absent, probe timed out,
 * tier-2 error). `unknown` means it was evaluated but an input is missing (no
 * stored rows yet, truncated at the cap, deadline reached). Both are
 * non-healthy: nothing in this surface may report `healthy` from missing or
 * stale evidence.
 *
 * Overlaps the per-signal `SignalStatus` in `updateGuard/types.ts` on
 * `attention` and `unknown` and adds states one signal does not need. Both are
 * closed sets; neither is derived from the other.
 */
export type DomainState = (typeof DOMAIN_STATE_ORDER)[number];

/**
 * Why a cell is not `healthy`. One closed set shared by every domain so the
 * frontend maps a single table to copy and icon.
 *
 * The grouping below is a producer obligation, not a type constraint: the
 * union is flat, so any code is assignable in any cell. The aggregator holds a
 * per-domain allowlist and reports a code that falls outside its domain's list
 * as `domain_error`, because a misplaced code renders the wrong sentence
 * rather than failing loudly.
 */
export type ReadinessReasonCode =
  // Connectivity
  | 'node_unreachable'
  | 'pilot_disconnected'
  | 'contact_stale'
  | 'probe_timeout'
  // Workloads
  | 'workloads_exited'
  | 'workloads_partial'
  | 'workloads_unknown'
  | 'status_evidence_degraded'
  | 'status_evidence_stale'
  // Updates
  | 'update_blocked'
  | 'update_review_required'
  | 'update_ready_with_warnings'
  // Recovery
  | 'rollback_not_ready'
  | 'rollback_partial'
  | 'snapshot_failed'
  // Updates + Recovery
  | 'stacks_unknown'
  | 'summary_truncated'
  // Security
  | 'posture_partial'
  | 'scanner_unavailable'
  | 'scans_stale'
  | 'scans_failed'
  // Control
  | 'control_paused'
  | 'control_degraded'
  | 'control_unknown'
  // Any domain, node level
  | 'capability_absent'
  | 'domain_error';

/**
 * Where a finding sends the operator.
 *
 * Each variant names an existing surface, spelled as this contract's own
 * discriminator rather than as a route segment: a consumer maps the variant
 * onto that surface's existing navigation affordance (`SENCHO_NAVIGATE_EVENT`,
 * the in-view node sheet, the Settings section prop) and never turns it into a
 * path itself.
 *
 * `security.tab` is a plain string rather than a union because the frontend
 * owns the tab set (`SECURITY_TABS` in `lib/router/senchoRoute.ts`) and
 * narrows a raw segment the same way a deep link does. `null` means the
 * Security overview.
 */
export type ReadinessTarget =
  | { surface: 'stack'; nodeId: number; stackName: string }
  | { surface: 'auto-updates' }
  | { surface: 'fleet-snapshots' }
  | { surface: 'security'; tab: string | null }
  | { surface: 'node-details'; nodeId: number }
  | { surface: 'settings-nodes' };

/**
 * Findings sort by this, worst first. A finding's severity is the domain state
 * of the cell it came from, so this is the same list as `DOMAIN_STATE_ORDER`
 * minus `healthy`, which never produces a finding. Declared separately so the
 * sort order reads without the member a finding cannot carry.
 */
export const FINDING_SEVERITIES = ['attention', 'degraded', 'unavailable', 'unknown'] as const;

export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** The canonical verdict a finding restates, tagged by the vocabulary it holds. */
export type FindingVerdict =
  | { kind: 'update'; value: ReadinessVerdict }
  | { kind: 'rollback'; value: RollbackOverall };

/**
 * One thing needing attention, or one thing that cannot be determined.
 *
 * `id` is stable across refetches, so the list keys and de-duplicates on it:
 * `domain:nodeId[:stack]:code`. Ordering is severity first, then `id`, so a
 * refetch cannot reorder rows under the operator.
 *
 * `code` is the only display payload. The frontend maps it to a title, icon,
 * and tone, so no backend prose reaches the UI as a headline. `detail` is the
 * single free-text field, passed through from the canonical contract that
 * produced the finding (a `ReadinessSignal.detail` or a
 * `RollbackReadinessItem.detail`) so the strongest existing explanation
 * survives rather than being re-derived here.
 */
export interface ReadinessFinding {
  id: string;
  domain: ReadinessDomainKey;
  nodeId: number;
  stack: string | null;
  code: ReadinessReasonCode;
  severity: FindingSeverity;
  /** How many items sit behind this row (stacks, containers, snapshots). */
  count: number;
  /** The canonical verdict this restates, or null when none applies. */
  verdict: FindingVerdict | null;
  /**
   * Pass-through of the canonical explanation. Producers must run this through
   * `redactSensitiveText` (`utils/safeLog.ts`) before the payload leaves the
   * node, and again before the aggregate leaves the hub.
   */
  detail: string | null;
  target: ReadinessTarget;
}

/**
 * Fields every domain cell carries, whatever its state.
 *
 * `counts` uses the domain's own vocabulary (`running`, `blocked`, `unknown`,
 * ...) so a cell can say "2 blocked" without the hub inventing a metric. The
 * frontend keeps a per-domain list of the keys it renders and ignores keys it
 * does not know, so a newer hub can add one without breaking an older UI.
 * These are tallies of existing facts, never a score.
 */
interface NodeDomainCellBase {
  counts: Record<string, number>;
  /** Age of the newest evidence behind this cell, or null when the age is not knowable. */
  evidenceAgeMs: number | null;
  /** `live` was computed during this request; `stored` came from cache or earlier rows. */
  source: 'live' | 'stored';
}

/**
 * One domain's state for one node, as the matrix renders it.
 *
 * A healthy cell carries no reason code by construction, so a reader cannot
 * hand a cell to the copy table and get an explanation for a state that needs
 * none.
 */
export type NodeDomainCell =
  | (NodeDomainCellBase & { state: 'healthy'; reasonCode: null })
  | (NodeDomainCellBase & { state: Exclude<DomainState, 'healthy'>; reasonCode: ReadinessReasonCode });

/**
 * Which transport this hub would use to reach the node right now.
 *
 * Same four values as `MeshReachableMode` (`services/MeshService.ts`) and its
 * frontend twin (`frontend/src/types/mesh.ts`), so the matrix needs no
 * translation table. Declared here rather than imported because the question
 * differs: readiness asks which transport the hub would use, the mesh asks how
 * a peer is reachable including mesh participation.
 */
export type NodeTransport = 'local' | 'pilot' | 'proxy' | 'unreachable';

export interface NodeReachability {
  status: Node['status'];
  /** Epoch ms of the last contact this hub can vouch for. */
  contactAt: number | null;
  contactSource: PreviewContactSource;
  /** How reachability was decided, using the cached classification the blueprint preview shows. */
  note: PreviewReachabilityNote;
  /** True when this request itself reached the node. */
  probedLive: boolean;
  /** Round-trip time of the probe that produced this row, or null when there was none. */
  latencyMs: number | null;
}

export interface FleetReadinessNode {
  id: number;
  name: string;
  type: Node['type'];
  mode: NodeMode;
  transport: NodeTransport;
  reachability: NodeReachability;
  /**
   * Keys are exactly `FleetReadinessResponse.domains`. A key that is absent
   * because its domain was withheld renders as no column at all; a consumer
   * that looks up a domain it was told about must fall back to an
   * `unavailable` cell rather than dropping the column.
   */
  cells: Partial<Record<ReadinessDomainKey, NodeDomainCell>>;
  /** Stacks known on this node, or null when it could not be read. */
  stackCount: number | null;
}

/**
 * Per-stack readiness as the node that owns the Docker socket computed it,
 * served by `GET /api/stacks/readiness-summary`.
 *
 * The verdicts are the canonical ones (`UpdateGuardService.computeUpdateReadiness`
 * and `computeRollbackReadiness`) passed through unchanged. This route adds no
 * scoring: it selects, bounds, and reports.
 */
export interface NodeStackReadinessSummary {
  generatedAt: number;
  /** True when the stack cap or the deadline cut the pass short. */
  truncated: boolean;
  stacks: Array<{
    stack: string;
    update: {
      verdict: ReadinessVerdict;
      /**
       * The strongest signal detail behind the verdict, or null. Redacted the
       * same way `ReadinessFinding.detail` is: it carries text the canonical
       * contracts pass through from the managed-project inventory, which can
       * embed a materialized input path.
       */
      topReason: string | null;
      computedAt: number;
    } | null;
    rollback: {
      overall: RollbackOverall;
      /** Redacted the same way `update.topReason` is. */
      topReason: string | null;
      computedAt: number;
    } | null;
    /**
     * Set only when both `update` and `rollback` are null, naming why neither
     * verdict could be produced for this stack (the cap, the deadline, or a
     * compute error).
     */
    unavailableReason: ReadinessReasonCode | null;
  }>;
}

/**
 * Payload of `GET /api/fleet/readiness`, the hub-only aggregate. Readable by
 * any role holding `node:read` except for the withheld domains below.
 */
export interface FleetReadinessResponse {
  /** Epoch ms this response was assembled; the surface's "last checked" time. */
  generatedAt: number;
  /** Domains present in this response, in column order. */
  domains: ReadinessDomainKey[];
  /**
   * Domains withheld from this caller. Today the only member is `control`,
   * omitted unless the caller passes the same admin check `GET
   * /api/fleet/sync-status` uses; the key never appears in a node's cells.
   */
  domainsOmitted: ReadinessDomainKey[];
  summary: {
    /**
     * Nodes whose worst domain state is each value, counted over the domains
     * this response actually carries and rendered in `DOMAIN_STATE_ORDER`. A
     * node counts once, so the values sum to `nodes.length`.
     */
    nodes: Record<DomainState, number>;
    /**
     * Findings across the fleet, by severity. There is no separate
     * completeness flag: a truncated or unevaluated domain already carries a
     * reason code on its own cell, which is what the matrix and the findings
     * list both read.
     */
    findings: Record<FindingSeverity, number>;
  };
  /** Worst severity first, then by `id`. Deterministic order. */
  findings: ReadinessFinding[];
  nodes: FleetReadinessNode[];
}
