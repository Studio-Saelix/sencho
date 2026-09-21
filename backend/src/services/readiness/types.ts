import type { RollbackOverall, ReadinessVerdict } from '../updateGuard/types';
import type { BulkStackInfo } from '../DockerController';
import type { SecurityPostureState } from '../securityPosture';
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
  // The pass answered but is older than its freshness window. Kept apart from
  // `stacks_unknown`, which says the verdicts are absent rather than old: the
  // two conditions can hold at once, and one code for both would collapse them
  // into a single finding id.
  | 'summary_stale'
  // Security
  // `posture_action_needed` and `posture_partial` are the two `posture_*` codes,
  // and only the first names a derived posture word (`'Action needed'`); the
  // second names the truncation flag. Every other code names an input fact
  // behind the word. The word and those facts are published together and the
  // cell takes the worst of them: `'Action needed'` outranks every input fact
  // because it is the domain's worst state, and a word that needs no code
  // (`'Secure'`) never silences a fact that does. The facts carry what the word
  // cannot, because the word alone is ambiguous: `'Unknown'` is both "no
  // scanner" and "nothing scanned yet".
  //
  // `'Secure'` and `'Monitoring'` are the two words that need no code. A
  // `'Monitoring'` posture is the one with no blocker but something still open
  // behind it: residual Critical or High load that was accepted or ignored, or a
  // review reason that carries no instruction. None of those is a decision
  // readiness can ask for, and Security's own page tells that story, so the
  // aggregator reads a bare `'Monitoring'` as healthy on purpose. This union is
  // not a claim that every posture state is listed: it states which ones this
  // surface publishes, and the aggregator classifies the word through an
  // exhaustive map so a new word cannot land on healthy by omission.
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
 * Findings sort by this, worst first. A finding's severity is the state of the
 * concern that produced it, which is not always the state the cell ended up
 * with: a cell publishes its worst concern while the list still carries the
 * milder siblings, each labelled with its own state, so one blocked stack does
 * not restate a warning beside it as `attention`. The order is therefore the
 * same list as `DOMAIN_STATE_ORDER` minus `healthy`, which never produces a
 * finding. Declared separately so the sort order reads without the member a
 * finding cannot carry.
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
 * `code` is the only payload the frontend turns into words. It supplies the
 * title and the icon, and the tone comes from `severity` beside it rather than
 * from the code: one code can be published against more than one state, so a
 * state-keyed tone is the only one that stays true for every row carrying it.
 * That also keeps the copy for a code state-neutral, and it is why no backend
 * prose reaches the UI as a headline. `detail` is the
 * single free-text field, passed through from whatever canonical record
 * produced the finding, so the strongest existing explanation survives rather
 * than being re-derived here: a `ReadinessSignal.detail`, a
 * `RollbackReadinessItem.detail`, or the Control row's own `last_error`, which
 * is the one source that is not a verdict contract.
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
 * key set is open so a newer hub can add one without breaking an older UI,
 * which renders nothing for a key it does not know. These are tallies of
 * existing facts, never a score.
 */
interface NodeDomainCellBase {
  counts: Record<string, number>;
  /**
   * Age of the evidence behind this cell, or null when it is not knowable.
   *
   * Which stamp that is belongs to the domain: the newest where the newest input
   * decided the answer, the oldest where every input contributed, so a cell
   * cannot age itself by its freshest input and clear a freshness window that
   * the evidence it was built on had already left.
   */
  evidenceAgeMs: number | null;
  /**
   * Whether this request's own read of the node produced the answer (`live`), or
   * the hub answered from what it already had (`stored`). A `live` cell can
   * still carry old evidence and a `stored` one can be seconds old, which is
   * `evidenceAgeMs`'s question rather than this one.
   */
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
  /** True when this row's own evidence read succeeded; a node that answered with an error, or not at all, is false. */
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
   * Keys are exactly `FleetReadinessResponse.domains`, so a consumer lays out
   * its columns from that list once and reads every row against it. A domain
   * missing from that list is one this caller was not told about
   * (`domainsOmitted` names it) and renders as no column at all, never as a
   * column of unavailable cells.
   */
  cells: Partial<Record<ReadinessDomainKey, NodeDomainCell>>;
  /** Stacks known on this node, or null when it could not be read. */
  stackCount: number | null;
}

export interface StackUpdateReadinessRow {
  verdict: ReadinessVerdict;
  /**
   * The strongest signal detail behind the verdict, or null. Redacted the same
   * way `ReadinessFinding.detail` is: it carries text the canonical contracts
   * pass through from the managed-project inventory, which can embed a
   * materialized input path.
   */
  topReason: string | null;
  computedAt: number;
}

export interface StackRollbackReadinessRow {
  overall: RollbackOverall;
  /** Redacted the same way `StackUpdateReadinessRow.topReason` is. */
  topReason: string | null;
  computedAt: number;
}

/**
 * One stack's readiness in a node-local pass.
 *
 * A null verdict slot means the compute for that question failed, which
 * `unavailableReason` names when both failed. It is not the same statement as a
 * present slot whose verdict is itself `unknown`, which means the compute ran
 * and could not decide; `RollbackOverall` has no `unknown` member, so a failed
 * rollback compute can only be reported as a null slot.
 */
export interface StackReadinessRow {
  stack: string;
  /** The canonical update verdict, or null when it was never evaluated. */
  update: StackUpdateReadinessRow | null;
  /** The canonical rollback verdict, or null when it was never evaluated. */
  rollback: StackRollbackReadinessRow | null;
  /**
   * Set only when both `update` and `rollback` are null, naming why neither
   * verdict could be produced for this stack (the deadline, or a compute
   * error). A stack the cap excluded has no entry here at all; the cap is
   * reported by `truncated` instead, so a row present in this array always
   * carries either a verdict or a reason it has none.
   */
  unavailableReason: ReadinessReasonCode | null;
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
  /** Epoch ms of the pass that produced these verdicts, not of this request. */
  generatedAt: number;
  /** True when the stack cap or the deadline cut the pass short. */
  truncated: boolean;
  /**
   * True when the verdicts served are older than the freshness window, which is
   * what an earlier failed pass leaves behind. These rows fold into the hub's
   * `updates` and `recovery` cells, and neither cell may be `healthy` while this
   * is true: the verdicts are real but their age is unbounded.
   *
   * A `false` here says only that a pass completed within the window, not that
   * the verdicts are current relative to anything else. A stack deployed since
   * the pass is neither, so a consumer that needs currency bounds the age
   * through `generatedAt` as well.
   */
  stale: boolean;
  /**
   * Worst first: stacks whose stored check failed, then those with an update
   * available, then those with open drift findings, then alphabetical, as
   * `orderStacks` in `stackReadinessSummary.ts` implements it. The cap keeps this
   * prefix, so a stack missing from the array was not judged healthy, only left
   * unevaluated.
   */
  stacks: StackReadinessRow[];
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

/**
 * One stack whose containers are not all running, as this node's bulk status
 * read reported it.
 *
 * Every status other than `running` is here, `unknown` and `partial` included:
 * a stack nobody could read is not a stack that is fine, and the reason codes
 * separate the three so the copy can say which one it is.
 */
export interface NodeWorkloadProblem {
  /**
   * Stack name: the compose directory under the node's base directory, which is
   * the key the bulk status read reports under. Not the compose file name: the
   * read keys on the directory, so `myapp` rather than `myapp.yml`.
   */
  stack: string;
  status: Exclude<BulkStackInfo['status'], 'running'>;
}

/**
 * This node's workload facts, from the same read and the same cache entry that
 * `GET /api/stacks/statuses` serves.
 *
 * Evidence, not a verdict: it reports what the read found and leaves the choice
 * of reason code to the hub, which owns that mapping for every domain. Nothing
 * here reaches into the healthcheck or drift engines, which arrive at the
 * surface through the canonical per-stack verdicts instead of a second
 * classifier.
 */
export interface NodeWorkloadEvidence {
  /**
   * Epoch ms the pass that produced `counts` and `problems` finished. The read's
   * cache TTL is measured from that same instant, so a consumer aging this
   * evidence against that TTL asks the question the cache already answered
   * rather than a second one.
   */
  generatedAt: number;
  /**
   * Stacks per container status, complete for the node even where `problems`
   * is not the whole story, so a cell can report "2 of 30" without a second
   * read. The keys are exactly `BulkStackInfo['status']`, the same vocabulary
   * `problems[].status` draws from, so a bucket typo is a compile error rather
   * than a stack that quietly leaves the arithmetic. `Partial` because a status
   * with no stacks has no bucket, so a key can legitimately be absent. The
   * open-keyed type is `NodeDomainCellBase.counts`, opened for a different reason
   * (a hub adding a tally an older UI ignores), so the two are not a mismatch to
   * iron out.
   */
  counts: Partial<Record<BulkStackInfo['status'], number>>;
  /**
   * True when an input behind the read failed: an enrichment source (instance
   * identity, the git-source scan), or the strict stack listing disagreeing with
   * the payload it confirms, which is the one case where `counts` is knowingly
   * short of the node.
   *
   * Which of the two it was is not recoverable from this flag, since the labels
   * the enrichment sources produce (`source`, `isSelf`) are not carried here.
   * That makes it a caveat on the payload rather than a note beside it, and the
   * hub reads it that way: a degraded read publishes its counts but no stack
   * total, in preference to a total short by an unknown amount.
   */
  degraded: boolean;
  /**
   * True when the bytes behind this payload are older than the read's cache TTL,
   * which is what a failed refresh leaves behind: the entry the cache served had
   * expired and the refresh meant to replace it did not land. Drawn from the
   * timestamp rather than from the cache outcome because the outcome cannot
   * speak for every reader (a caller joining an in-flight refresh is told
   * `inflight` while the owner is told `stale`, on identical old bytes), and
   * conservative in one direction only: nothing here can report old bytes as
   * fresh. Kept apart from `degraded` because the two are different claims and
   * earn different reason codes: `degraded` says an input to the read failed,
   * `stale` says the whole payload is the previous pass served after a refresh
   * failed.
   */
  stale: boolean;
  /**
   * Every stack not fully running, uncapped. The read this derives from already
   * returns one entry per stack, so this payload is the same order of magnitude
   * as a response the node serves anyway, and a node whose stacks are genuinely
   * all down is the thing this surface exists to show rather than noise to
   * truncate.
   *
   * Order is not significant and is not stable: it follows the directory read
   * beneath it. A consumer that renders a sequence sorts first, the way the
   * aggregate sorts its findings.
   */
  problems: NodeWorkloadProblem[];
}

/**
 * This node's security facts, taken from the canonical posture pass
 * (`buildSecurityOverview` in `services/securityOverview.ts`) unchanged. The
 * posture word and its type come from `services/securityPosture.ts`, which is
 * what derives it.
 *
 * Carries no severity totals and no scanner version: a count of high findings
 * would be a competing vulnerability score, which this surface does not own,
 * and Security stays the detailed remediation surface. The posture is the
 * canonical state rather than a readiness verdict, so the hub maps it to a
 * reason code in one place along with every other domain.
 */
export interface NodeSecurityEvidence {
  /**
   * Epoch ms the posture pass behind this payload finished. Carried so the hub
   * can age a Security cell by its own instant rather than by the payload's, the
   * way `NodeWorkloadEvidence.generatedAt` lets it age a Workloads cell. The
   * pass is synchronous and stamped after it returns, so this is not a
   * read-start lower bound.
   */
  generatedAt: number;
  /**
   * The canonical posture word, authoritative over the fields below if they
   * ever appear to disagree with it. `'Unknown'` arises exactly when the
   * scanner is unavailable or no scan has completed, so the inputs are carried
   * to let a consumer say which of the two it is rather than guessing.
   */
  posture: SecurityPostureState;
  /**
   * True when any bounded pass behind the posture was capped, so one of its
   * views was partial. Four independent sources set it: the Critical/High
   * finding array, the known-exploited findings, the high-misconfiguration
   * findings, and the target list attached to a reason. The finding-array caps
   * are the ones that can hide the very finding that would have moved
   * `'Secure'` to `'Monitoring'`; the target-list cap only shortens the
   * remediation list and removes nothing from the derivation. A reader that
   * needs to know which applies has to look at the reason it is rendering.
   * Nothing derived from this pass is safe to read as healthy while this is
   * set, whichever source set it.
   */
  posturePartial: boolean;
  scannerAvailable: boolean;
  /**
   * Scan summaries whose newest completed scan is older than the scan staleness
   * threshold. One summary per image ref, and the refs include the synthetic
   * `stack:` rows a stack reports for its own compose file, so this is not a
   * count of stacks.
   */
  staleScans: number;
  /**
   * Scan runs that ended in failure, counted in runs rather than targets, so it
   * shares no denominator with `staleScans` and the two are never summed.
   *
   * Read it as a history rather than as a current state: `staleScans` is a point
   * in time (summaries past the staleness threshold right now), while this counts
   * every failed run still retained. It carries no time predicate of its own, so
   * the bound on it is scan retention rather than a window this number names:
   * rows past the retention age are pruned, and each image keeps only its newest
   * runs. A fleet that scans on a schedule therefore carries a nonzero value
   * almost permanently, and a large number here is a record of retries rather
   * than a count of broken things today.
   */
  failedScans: number;
  /** Epoch ms of the newest successful scan, or null when none has completed. */
  lastSuccessfulScanAt: number | null;
}

/**
 * Payload of `GET /api/readiness/evidence`, the node-local readiness rows.
 *
 * Served by whichever node the request lands on, and read by the hub during its
 * fan-out. Scoped to Workloads and Security on purpose: those are the two
 * domains whose evidence is cheap and lives only on the node. Updates and
 * Recovery arrive through `GET /api/stacks/readiness-summary`, Connectivity and
 * Control are read from the hub's own rows, and fleet-snapshot state is
 * hub-side, so carrying any of them here would duplicate a read without
 * changing an answer.
 *
 * A null domain means its compute threw. The hub is expected to render that as a
 * `domain_error` cell for that domain alone while the other domain keeps its
 * evidence. There is no failures array beside the nulls, and no in-band tag
 * either: a null is the only thing this payload can say about a failed domain,
 * the failure is always the same kind, and its detail is log-only, so a tag
 * would carry a constant and a second field stating it could disagree with the
 * first.
 *
 * Version skew runs the other way too, and the reader owns that boundary. This
 * payload is produced by whatever version the node runs, so a peer that answers
 * with anything other than a 200 JSON body carrying both fields has said nothing
 * the hub can use, and the hub records every domain that read feeds as an
 * `unavailable` cell.
 *
 * In those columns that is indistinguishable from a 200 whose domains both came
 * back null: both end in `domain_error`, because in both cases the node gave the
 * hub no usable evidence for the domain and the response does not claim to know
 * which happened. What separates them on the wire is Connectivity, which the
 * read decides rather than the payload (`probedLive` is false and the cached
 * classification stands when no body arrived), and the log line, which names the
 * unusable body. The case this contract exists for is the mixed one: a 200 with
 * a null for one domain and evidence for the other, where the null costs that
 * domain alone.
 */
export interface NodeReadinessEvidence {
  /**
   * Epoch ms this payload finished assembling, taken after both domains have
   * settled, so it is an upper bound on each domain's own instant rather than a
   * read-start lower bound. It is not the age of either domain: each carries its
   * own (`NodeWorkloadEvidence.generatedAt`, `NodeSecurityEvidence.generatedAt`),
   * and a consumer ages a cell by its domain's, never by this one, or it will
   * report evidence as fresher or older than the read behind it. For a domain
   * that came back null it is the only instant there is, and it bounds the
   * payload as a whole for a consumer that wants one number for the answer.
   */
  generatedAt: number;
  workloads: NodeWorkloadEvidence | null;
  security: NodeSecurityEvidence | null;
}
