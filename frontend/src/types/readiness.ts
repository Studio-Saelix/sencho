/**
 * Mirrors the backend aggregate payload (`services/readiness/types.ts`); the
 * frontend never imports backend code.
 *
 * Only the aggregate contract is declared. The node-local evidence payload that
 * the hub reads during its fan-out has no browser consumer, so mirroring it
 * here would be surface with nothing on the other end.
 */

/**
 * The canonical update-guard verdicts, which readiness restates rather than
 * recomputes (`services/updateGuard/types.ts` on the node, served per stack by
 * the two `/update-readiness` and `/rollback-readiness` routes).
 *
 * Declared here so the stack surfaces and this aggregate share one spelling:
 * the verdict-to-label, icon, and tone maps below are keyed by these unions, and
 * a second declaration would let those maps drift apart.
 */
export type ReadinessVerdict = 'ready' | 'ready_with_warnings' | 'review_required' | 'blocked' | 'unknown';

export type RollbackOverall = 'ready' | 'partial' | 'not_ready';

/**
 * The six readiness domains, in the canonical column order. A payload carries
 * its own `domains` array in this order and the matrix renders that array, so a
 * hub that withholds a domain yields a narrower board rather than a gap.
 */
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
 * Domain states, worst first. Render order for the summary buckets, and the
 * order a node's own worst state is picked in.
 *
 * `unknown` and `unavailable` are separate: `unavailable` means the domain was
 * never evaluated on this node, `unknown` that it was evaluated but an input is
 * missing. Neither may be rendered as healthy.
 */
export const DOMAIN_STATE_ORDER = [
  'attention',
  'degraded',
  'unavailable',
  'unknown',
  'healthy',
] as const;

export type DomainState = (typeof DOMAIN_STATE_ORDER)[number];

/**
 * Why a cell is not `healthy`. One closed set shared by every domain, so the
 * copy table is a single lookup.
 *
 * The union is flat, so an out-of-domain code is possible on the wire; the copy
 * table falls back rather than rendering nothing.
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
  | 'summary_stale'
  // Security
  | 'posture_partial'
  | 'posture_action_needed'
  | 'scanner_unavailable'
  | 'scans_stale'
  | 'scans_never_completed'
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
 * discriminator rather than as a route segment. A consumer maps the variant
 * onto that surface's existing navigation affordance and never turns it into a
 * path itself.
 */
export type ReadinessTarget =
  | { surface: 'stack'; nodeId: number; stackName: string }
  | { surface: 'auto-updates' }
  | { surface: 'fleet-snapshots' }
  | { surface: 'security'; tab: string | null }
  | { surface: 'node-details'; nodeId: number }
  | { surface: 'settings-nodes' };

/** Findings sort by this, worst first. `healthy` never produces a finding. */
export const FINDING_SEVERITIES = ['attention', 'degraded', 'unavailable', 'unknown'] as const;

export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** The canonical vocabulary a finding restates, tagged by which one it holds. */
export type FindingVerdict =
  | { kind: 'update'; value: ReadinessVerdict }
  | { kind: 'rollback'; value: RollbackOverall };

/**
 * One thing needing attention, or one thing that cannot be determined.
 *
 * `id` is stable across refetches, so the list keys on it. `code` supplies the
 * title and the icon; the tone comes from `severity` beside it, because one
 * code can be published against more than one state.
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
  /** Pass-through of the canonical explanation, redacted by the producer. */
  detail: string | null;
  target: ReadinessTarget;
}

/** Fields every domain cell carries, whatever its state. */
interface NodeDomainCellBase {
  /** Tallies in the domain's own vocabulary. Render only the keys you know. */
  counts: Record<string, number>;
  /** Age of the evidence behind this cell, or null when it is not knowable. */
  evidenceAgeMs: number | null;
  /**
   * Whether this request's own read of the node produced the answer (`live`),
   * or the hub answered from what it already had (`stored`). Independent of
   * `evidenceAgeMs`: a `live` cell can be old.
   */
  source: 'live' | 'stored';
}

/**
 * One domain's state for one node.
 *
 * A healthy cell carries no reason code, so a reader cannot hand a healthy cell
 * to the copy table and get an explanation for a state that needs none.
 */
export type NodeDomainCell =
  | (NodeDomainCellBase & { state: 'healthy'; reasonCode: null })
  | (NodeDomainCellBase & { state: Exclude<DomainState, 'healthy'>; reasonCode: ReadinessReasonCode });

/**
 * Which transport the hub would use to reach the node right now. Same four
 * values as `MeshReachableMode` (`types/mesh.ts`), so no translation table.
 */
export type NodeTransport = 'local' | 'pilot' | 'proxy' | 'unreachable';

export interface NodeReachability {
  status: 'online' | 'offline' | 'unknown';
  /** Epoch ms of the last contact the hub can vouch for. */
  contactAt: number | null;
  contactSource: 'local' | 'pilot_last_seen' | 'last_successful_contact';
  /**
   * How reachability was decided. The hub sends one of a closed set of words;
   * this mirror keeps the field open so an older UI can show a newer hub's word
   * rather than rendering nothing.
   */
  note: string;
  /** True when this row's own evidence read succeeded; a node that answered with an error, or not at all, is false. */
  probedLive: boolean;
  /** Round-trip time of the read behind this row, or null when none succeeded. */
  latencyMs: number | null;
}

export interface FleetReadinessNode {
  id: number;
  name: string;
  type: 'local' | 'remote';
  mode: 'proxy' | 'pilot_agent';
  transport: NodeTransport;
  reachability: NodeReachability;
  /**
   * Keys are exactly `FleetReadinessResponse.domains`, so columns are laid out
   * from that list once and every row read against it. A domain missing from
   * that list is one this caller was not told about and renders as no column at
   * all, never as a column of unavailable cells.
   */
  cells: Partial<Record<ReadinessDomainKey, NodeDomainCell>>;
  /** Stacks known on this node, or null when it could not be read. */
  stackCount: number | null;
}

/** Payload of `GET /api/fleet/readiness`, the hub-only aggregate. */
export interface FleetReadinessResponse {
  /** Epoch ms this response was assembled; the surface's "last checked" time. */
  generatedAt: number;
  /** Domains present in this response, in column order. */
  domains: ReadinessDomainKey[];
  /** Domains withheld from this caller. Never present in a node's `cells`. */
  domainsOmitted: ReadinessDomainKey[];
  summary: {
    /** Nodes whose worst domain state is each value; sums to `nodes.length`. */
    nodes: Record<DomainState, number>;
    /** Findings across the fleet, by severity. */
    findings: Record<FindingSeverity, number>;
  };
  /** Worst severity first, then by `id`. Deterministic order. */
  findings: ReadinessFinding[];
  nodes: FleetReadinessNode[];
}
