import {
  DatabaseService,
  type FleetSnapshot,
  type FleetSyncStatus,
  type Node,
} from '../DatabaseService';
import { NodeRegistry, type ProxyTarget } from '../NodeRegistry';
import { SYNC_ERROR_CODES } from '../fleetSyncConstants';
import { contactInfo, type PreviewReachabilityNote } from '../blueprintPreviewProjection';
import { safeRemoteFetch } from '../../utils/outboundTarget';
import { mapWithConcurrency } from '../../utils/mapWithConcurrency';
import { withTimeout, TimeoutError } from '../../utils/withTimeout';
import { errorMessageForLog, redactSensitiveText, sanitizeForLog } from '../../utils/safeLog';
import type { SecurityPostureState } from '../securityPosture';
import type { ReadinessVerdict, RollbackOverall } from '../updateGuard/types';
import { buildNodeReadinessEvidence } from './readinessEvidence';
import { buildStackReadinessSummary } from './stackReadinessSummary';
import {
  DOMAIN_STATE_ORDER,
  FINDING_SEVERITIES,
  READINESS_DOMAINS,
  type DomainState,
  type FindingVerdict,
  type FleetReadinessNode,
  type FleetReadinessResponse,
  type NodeDomainCell,
  type NodeReadinessEvidence,
  type NodeReachability,
  type NodeSecurityEvidence,
  type NodeStackReadinessSummary,
  type NodeTransport,
  type NodeWorkloadEvidence,
  type NodeWorkloadProblem,
  type ReadinessDomainKey,
  type ReadinessFinding,
  type ReadinessReasonCode,
  type ReadinessTarget,
  type StackReadinessRow,
} from './types';

/**
 * Budget for one node's readiness evidence.
 *
 * This does not bound a row's latency, and the reason is worth stating: both of
 * this node's reads run in one `Promise.all`, so the row settles at the slower
 * of the two legs, which is the summary budget whenever tier two was asked for.
 * What this bounds is the leg itself, so a request that asked for no verdicts is
 * not held for the longer budget.
 */
const EVIDENCE_BUDGET_MS = 3_000;
/**
 * Budget for one node's per-stack verdicts. Above the producer's own pass
 * deadline on purpose: the node bounds its pass itself and answers with partial
 * results, and this ceiling only catches a node that cannot answer at all.
 *
 * Exported so a test can pin that ordering against the producer's deadline.
 * Nothing else enforces it, and the two live in different modules: a hub budget
 * at or under the node's deadline turns every node's partial answer into a
 * timeout here, which costs both Update cells on every node in the fleet and
 * looks like a fleet-wide outage rather than one stale constant.
 */
export const SUMMARY_BUDGET_MS = 8_000;
/**
 * Nodes in flight at once, not reads: each worker may hold an evidence and a
 * summary request open together, so the in-flight request count can reach twice
 * this.
 */
const FANOUT_CONCURRENCY = 8;

const EVIDENCE_PATH = '/api/readiness/evidence';
const SUMMARY_PATH = '/api/stacks/readiness-summary';

/**
 * Which reason codes each domain may publish.
 *
 * The union in `types.ts` is flat, so this is the constraint that makes the
 * grouping real: a code filed under the wrong domain is a build failure here
 * rather than a cell that renders another column's story. A word that arrives
 * from a peer is the part no type can speak for, and each of those is decided
 * where it lands rather than here: `rowUnavailableCode` for a stack row's own
 * `unavailableReason`, `isKnownWord` against the verdict and posture maps, and
 * `checkedCode` as the runtime net under every path into a cell or a finding.
 *
 * `contact_stale` stays Connectivity-only because it reports the hub's own
 * stored view of a node's contact rather than anything the node said, and a
 * stale stored view is a fact about that column and not about any other. The
 * node-level codes are registered for every domain that is gated behind a read,
 * because a failed or absent read gates all of them at once: the Workloads
 * column of an unreachable node is not broken, it is unread, and the code has to
 * be able to say so in that column.
 * `capability_absent` and `domain_error` belong there for the same reason, since
 * a 404 or a 200 whose domain came back null is a fact about the node's version
 * or its answer rather than about the domain's own read. `domain_error` also
 * carries the row `emptyNodeRow` builds when the hub's own work for a node
 * throws: every domain in that row is unavailable for one shared cause, which is
 * the same shape as a gating read. Control is the exception: it is classified
 * from the hub's own rows, so it is never gated behind a node read and never
 * carries one of those codes.
 */
const NODE_LEVEL_CODES = [
  'node_unreachable',
  'pilot_disconnected',
  'probe_timeout',
  'capability_absent',
  'domain_error',
] as const;

type NodeLevelCode = (typeof NODE_LEVEL_CODES)[number];

/**
 * What each domain may publish, as a type. A domain that can carry one of the
 * node-level codes spells that in, so `control` carries only the fallback.
 */
type DomainCodeMap = {
  connectivity: NodeLevelCode | 'contact_stale';
  workloads: NodeLevelCode
    | 'workloads_exited'
    | 'workloads_partial'
    | 'workloads_unknown'
    | 'status_evidence_degraded'
    | 'status_evidence_stale';
  updates: NodeLevelCode
    | 'update_blocked'
    | 'update_review_required'
    | 'update_ready_with_warnings'
    | 'stacks_unknown'
    | 'summary_truncated'
    | 'summary_stale';
  recovery: NodeLevelCode
    | 'rollback_not_ready'
    | 'rollback_partial'
    | 'snapshot_failed'
    | 'stacks_unknown'
    | 'summary_truncated'
    | 'summary_stale';
  security: NodeLevelCode
    | 'posture_partial'
    | 'posture_action_needed'
    | 'scanner_unavailable'
    | 'scans_stale'
    | 'scans_never_completed';
  // The three states, plus `domain_error` for one reason: `checkedCode` returns
  // that code for anything it does not find registered, and it reads control's
  // registry like every other domain's. Control derives none of the other
  // node-level codes (a control concern is never an unreachable node), so this
  // is the only member of that group it accepts.
  control: 'control_paused' | 'control_degraded' | 'control_unknown' | 'domain_error';
};

type DomainReasonCode<D extends ReadinessDomainKey> = DomainCodeMap[D];

const DOMAIN_REASON_CODES: { [D in ReadinessDomainKey]: ReadonlySet<DomainReasonCode<D>> } = {
  connectivity: new Set([...NODE_LEVEL_CODES, 'contact_stale']),
  workloads: new Set([
    ...NODE_LEVEL_CODES,
    'workloads_exited',
    'workloads_partial',
    'workloads_unknown',
    'status_evidence_degraded',
    'status_evidence_stale',
  ]),
  updates: new Set([
    ...NODE_LEVEL_CODES,
    'update_blocked',
    'update_review_required',
    'update_ready_with_warnings',
    'stacks_unknown',
    'summary_truncated',
    'summary_stale',
  ]),
  recovery: new Set([
    ...NODE_LEVEL_CODES,
    'rollback_not_ready',
    'rollback_partial',
    'snapshot_failed',
    'stacks_unknown',
    'summary_truncated',
    'summary_stale',
  ]),
  security: new Set([
    ...NODE_LEVEL_CODES,
    'posture_partial',
    'posture_action_needed',
    'scanner_unavailable',
    'scans_stale',
    'scans_never_completed',
  ]),
  // The three states plus `domain_error`, which `checkedCode` reaches for a code
  // this build does not know. Registering it is what keeps that function from
  // publishing a code control's own registry rejects; nothing derives a control
  // state from it.
  control: new Set(['control_paused', 'control_degraded', 'control_unknown', 'domain_error']),
};

/**
 * The codes `domain` may publish, widened so a runtime string can be looked up
 * against them. The per-domain sets are what the compiler checks; this is the
 * one place that reads them as a single vocabulary.
 */
function registeredCodes(domain: ReadinessDomainKey): ReadonlySet<ReadinessReasonCode> {
  return DOMAIN_REASON_CODES[domain];
}

/** A domain condition: the cell state it forces, and the code that names it. */
interface ConcernSpec {
  state: Exclude<DomainState, 'healthy'>;
  code: ReadinessReasonCode;
}

/**
 * The verdict-to-concern maps, exhaustive over their own unions.
 *
 * Keyed by the canonical verdict type rather than by `string` so a verdict word
 * added to `updateGuard/types.ts` fails the type check here instead of falling
 * through a lookup and reporting a not-ready stack as healthy. The update and
 * rollback maps carry a null `ready` entry, because an explained-ready stack is
 * exactly the case this surface has nothing to say about; the workload map is
 * keyed by problems only, so a ready stack never reaches it.
 */
const WORKLOAD_STATUS_CONCERNS: Record<NodeWorkloadProblem['status'], ConcernSpec> = {
  exited: { state: 'attention', code: 'workloads_exited' },
  partial: { state: 'degraded', code: 'workloads_partial' },
  unknown: { state: 'unknown', code: 'workloads_unknown' },
};

const UPDATE_VERDICT_CONCERNS: Record<ReadinessVerdict, ConcernSpec | null> = {
  ready: null,
  blocked: { state: 'attention', code: 'update_blocked' },
  review_required: { state: 'degraded', code: 'update_review_required' },
  ready_with_warnings: { state: 'degraded', code: 'update_ready_with_warnings' },
  unknown: { state: 'unknown', code: 'stacks_unknown' },
};

const ROLLBACK_OVERALL_CONCERNS: Record<RollbackOverall, ConcernSpec | null> = {
  ready: null,
  not_ready: { state: 'attention', code: 'rollback_not_ready' },
  partial: { state: 'degraded', code: 'rollback_partial' },
};

/**
 * The posture words, exhaustive over the four the derivation can return.
 *
 * `Monitoring` maps to no concern on purpose. It is the posture for a node with
 * no blocker but something still open behind it: residual Critical or High load
 * that was accepted or ignored, or a review reason that carries no instruction.
 * None of those is a decision readiness can ask for, and Security's own page
 * tells that story. `Unknown` is null here because the word alone is ambiguous
 * between "no scanner" and "nothing scanned yet"; the evidence carries the
 * inputs that disambiguate it, and `securityConcerns` reads them.
 */
const SECURITY_POSTURE_CONCERNS: Record<SecurityPostureState, ConcernSpec | null> = {
  'Action needed': { state: 'attention', code: 'posture_action_needed' },
  'Monitoring': null,
  'Secure': null,
  'Unknown': null,
};

/**
 * Outcome of one bounded read against one node.
 *
 * `absent` is a 404, which the fan-out reads as "this node's version has no
 * such route" rather than as a failure: it is the version-skew boundary, and it
 * is a stronger signal than a capability advertisement, which a partially
 * rolled out node can serve while still 404ing the route. Neither `failed` nor
 * `unreachable` carries detail on purpose. The reason a read failed is for the
 * log, not for the wire, because an undici transport error can name the node's
 * address and the finding it would land on is readable by every role holding
 * `node:read`.
 *
 * `failed` and `unreachable` are both "no usable answer" and are still two
 * kinds, because the operator's next move differs. `failed` means the node
 * answered and the answer was unusable (a status this hub rejects, a body it
 * cannot read), which is a fact about that node's build or its health;
 * `unreachable` means the transport produced no answer at all (a refused
 * connection, a reset stream, a request cancelled with the caller), which is a
 * fact about the path between the two instances. Reporting the second as the
 * first sends someone to read logs on a node that never heard the question.
 */
type NodeRead<T> =
  | { kind: 'ok'; value: T; elapsedMs: number }
  | { kind: 'absent' }
  | { kind: 'timeout' }
  | { kind: 'failed' }
  | { kind: 'unreachable' };

/**
 * One reason a domain is not healthy, before it becomes a cell state and a row
 * in the findings list.
 *
 * A domain holds several of these and publishes the worst one as its state, so
 * a cell that reports `attention` is not hiding an `unknown` behind it, and the
 * findings list still carries both. The cell keeps only the worst code because
 * a cell has one reason field, which is the trade this shape records.
 */
interface DomainConcern {
  state: Exclude<DomainState, 'healthy'>;
  code: ReadinessReasonCode;
  /**
   * Redacted by the producer, and again by `findingsFor` before this reaches the
   * wire. Null when the canonical contract carried no explanation.
   */
  detail: string | null;
  /** What the row counts: stacks, containers, snapshots, resources. */
  count: number;
  /** The stack the row is about, or null for a node-level concern. */
  stack: string | null;
  verdict: FindingVerdict | null;
  target: ReadinessTarget;
}

interface DomainResult {
  cell: NodeDomainCell;
  findings: ReadinessFinding[];
}

/**
 * A concern carrying the values every concern carries unless it has its own.
 *
 * Most concerns are a state, a code, and a target: nothing to count, no stack,
 * no verdict. Writing that whole literal at each site is how one of them ends up
 * with a field the others do not have, and the fields are all nullable, so the
 * omission compiles: it surfaces later as a finding whose verdict is absent for
 * a reason no reader can see. The defaults live here instead, and a concern that
 * carries more overrides the ones it has.
 *
 * State and code are not overridable, because they are the two fields that
 * decide what the cell and the finding report. `count` defaults to 1 rather than
 * 0: a concern is one fact about one thing unless the evidence says how many,
 * and a zero would publish a row counting nothing.
 */
function concern(
  spec: ConcernSpec,
  target: ReadinessTarget,
  overrides: Partial<Pick<DomainConcern, 'detail' | 'count' | 'stack' | 'verdict'>> = {},
): DomainConcern {
  return {
    state: spec.state,
    code: spec.code,
    detail: null,
    count: 1,
    stack: null,
    verdict: null,
    target,
    ...overrides,
  };
}

/**
 * The concern for a domain this hub could not compute.
 *
 * The hub cannot say which input was missing, only that this domain's own answer
 * is not there, so every one of these carries the same state and the same code
 * and differs only in what it points at.
 */
function domainErrorConcern(target: ReadinessTarget): DomainConcern {
  return concern({ state: 'unavailable', code: 'domain_error' }, target);
}

export interface FleetReadinessRequest {
  /** Domains to publish, already validated against `READINESS_DOMAINS`. */
  domains: readonly ReadinessDomainKey[];
  /** Restrict the fan-out to these nodes, or null for all of them. */
  nodeIds: readonly number[] | null;
  /** True when the caller passed the same admin check `GET /api/fleet/sync-status` uses. */
  includeControl: boolean;
  /** Aborted when the client goes away, so in-flight reads stop with it. */
  signal: AbortSignal;
}

function stateRank(state: DomainState): number {
  return DOMAIN_STATE_ORDER.indexOf(state);
}

/**
 * How long ago a stamp was written, never negative.
 *
 * A node whose clock runs ahead of the hub's writes stamps in the hub's future,
 * which would report the cell as fresher than it is. Clamping is what keeps the
 * one direction `oldestAge` forbids closed for the single-clock case too.
 */
function ageOf(stamp: number): number {
  return Math.max(0, Date.now() - stamp);
}

/** Age of the newest evidence among the stamps given, or null when there are none. */
function newestAge(...ages: Array<number | null>): number | null {
  let newest: number | null = null;
  for (const age of ages) {
    if (age === null) continue;
    if (newest === null || age < newest) newest = age;
  }
  return newest;
}

/**
 * Age of the oldest evidence among the stamps given, or null when there are
 * none.
 *
 * A cell's age is read against a freshness window, so understating it is the one
 * direction a cell may not take. `newestAge` is right where the newest input is
 * the one that decided the answer, which is the Control domain's case: its rows
 * are classified by their latest event. It is wrong wherever every input
 * contributed, which is Recovery's, so that domain ages itself with this.
 */
function oldestAge(...ages: Array<number | null>): number | null {
  let oldest: number | null = null;
  for (const age of ages) {
    if (age === null) continue;
    if (oldest === null || age > oldest) oldest = age;
  }
  return oldest;
}

function ageOrNull(stamp: number | null): number | null {
  return stamp === null ? null : ageOf(stamp);
}

function checkedCode(domain: ReadinessDomainKey, code: ReadinessReasonCode): ReadinessReasonCode {
  if (registeredCodes(domain).has(code)) return code;
  console.error(
    `Readiness aggregate: reason code "${code}" is not registered for the ${domain} domain; reporting domain_error`,
  );
  return 'domain_error';
}

/**
 * The code for a stack row that answered with no verdict for that stack.
 *
 * The node names its own reason, and this hub publishes it only if that domain
 * registers it. A word from a wider vocabulary is a version skew rather than a
 * fact about the stack, so the row falls back to `stacks_unknown`.
 *
 * The registration test is why this does not route through `checkedCode`:
 * `checkedCode` answers an unregistered word with `domain_error`, which says the
 * read was unreadable, and this read answered. A registered word passes through
 * as itself whatever state the row carries, so a node reporting its own
 * per-stack compute as failed keeps that word on this `unknown` cell instead of
 * losing it to a `stacks_unknown` that says nothing about why.
 */
function rowUnavailableCode(domain: 'updates' | 'recovery', reason: ReadinessReasonCode | null): ReadinessReasonCode {
  if (reason === null) return 'stacks_unknown';
  if (registeredCodes(domain).has(reason)) return reason;
  console.error(
    `Readiness aggregate: a ${domain} stack row reported "${reason}", which that domain does not register; reporting stacks_unknown`,
  );
  return 'stacks_unknown';
}

function worstConcern(concerns: readonly DomainConcern[]): DomainConcern | null {
  let worst: DomainConcern | null = null;
  for (const concern of concerns) {
    if (worst === null || stateRank(concern.state) < stateRank(worst.state)) worst = concern;
  }
  return worst;
}

/** What a cell carries beside its state: the counts, the age, and where it came from. */
interface CellBase {
  counts?: Record<string, number>;
  evidenceAgeMs: number | null;
  source: 'live' | 'stored';
}

function cellFrom(
  domain: ReadinessDomainKey,
  concerns: readonly DomainConcern[],
  base: CellBase,
): NodeDomainCell {
  const counts = base.counts ?? {};
  const worst = worstConcern(concerns);
  if (worst === null) {
    return { state: 'healthy', reasonCode: null, counts, evidenceAgeMs: base.evidenceAgeMs, source: base.source };
  }
  return {
    state: worst.state,
    reasonCode: checkedCode(domain, worst.code),
    counts,
    evidenceAgeMs: base.evidenceAgeMs,
    source: base.source,
  };
}

/**
 * A domain's cell and the findings behind it, built from one concern list.
 *
 * The two always come from the same concerns, so building them at each site is
 * how a cell and the rows under it come to disagree about what happened. Keeping
 * them in one call makes "the cell's worst reason is one of the published rows" a
 * property of the shape rather than something every site has to remember.
 */
function domainResult(
  nodeId: number,
  domain: ReadinessDomainKey,
  concerns: readonly DomainConcern[],
  base: CellBase,
): DomainResult {
  return {
    cell: cellFrom(domain, concerns, base),
    findings: findingsFor(nodeId, domain, concerns),
  };
}

function findingId(domain: ReadinessDomainKey, nodeId: number, stack: string | null, code: ReadinessReasonCode): string {
  return stack === null ? `${domain}:${nodeId}:${code}` : `${domain}:${nodeId}:${stack}:${code}`;
}

/**
 * One finding per concern, so the list carries every reason the cell's single
 * code had to collapse. A finding's severity is the state its own concern would
 * give the cell, not the state the cell ended up with: on a node with one
 * blocked and one warning stack both rows ship, and reporting the warning as
 * `attention` because a sibling outranked it would misstate it.
 *
 * `detail` is redacted here as well as at the node that produced it. A remote's
 * payload is scrubbed before it leaves that peer, but this hub is where the
 * aggregate is assembled into the response the browser receives, and every other
 * free-text field on this path is scrubbed at the point it enters the payload.
 * A second pass over already-redacted text is a no-op, which is the reason it is
 * safe to run unconditionally rather than tracking which concerns came from a
 * peer.
 */
function findingsFor(
  nodeId: number,
  domain: ReadinessDomainKey,
  concerns: readonly DomainConcern[],
): ReadinessFinding[] {
  return concerns.map((concern) => {
    // One code for both fields. The id is what a consumer de-duplicates,
    // re-anchors, and compares across refetches on, so an id naming a code the
    // row does not publish would leave two different peer words rendering as the
    // same `domain_error` row under two ids that never collapse.
    const code = checkedCode(domain, concern.code);
    return {
      id: findingId(domain, nodeId, concern.stack, code),
      domain,
      nodeId,
      stack: concern.stack,
      code,
      severity: concern.state,
      count: concern.count,
      verdict: concern.verdict,
      detail: concern.detail === null ? null : redactSensitiveText(concern.detail) || null,
      target: concern.target,
    };
  });
}

/** Findings ordered worst first, then by id, so a refetch cannot reorder rows. */
function sortFindings(findings: ReadinessFinding[]): ReadinessFinding[] {
  const rank = (severity: ReadinessFinding['severity']): number => FINDING_SEVERITIES.indexOf(severity);
  return findings.sort((a, b) => rank(a.severity) - rank(b.severity) || a.id.localeCompare(b.id));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Whether a word a peer sent is one of the keys of an exhaustive map.
 *
 * The maps are typed over the canonical unions, but the word arrives over HTTP
 * from a node that may be running a wider vocabulary, and a wider word is not a
 * member of the union this node compiled against. A plain record answers that
 * question at runtime (`Map` would not, without casting the key back), and an
 * own-property check rather than `in` is what keeps an inherited name such as
 * `constructor` from passing for a verdict.
 */
function isKnownWord<T extends string>(map: Record<T, unknown>, word: unknown): word is T {
  return typeof word === 'string' && Object.prototype.hasOwnProperty.call(map, word);
}

function isWorkloadProblem(value: unknown): value is NodeWorkloadProblem {
  return isRecord(value) && typeof value.stack === 'string';
}

function isWorkloadEvidence(value: unknown): value is NodeWorkloadEvidence | null {
  return value === null || (isRecord(value)
    && typeof value.generatedAt === 'number'
    && typeof value.degraded === 'boolean'
    && typeof value.stale === 'boolean'
    && isRecord(value.counts)
    && Array.isArray(value.problems)
    && value.problems.every(isWorkloadProblem));
}

function isSecurityEvidence(value: unknown): value is NodeSecurityEvidence | null {
  // Null is a shape the producer emits on purpose, not a malformed payload: it
  // is how a domain whose compute threw is reported, and the aggregator renders
  // it as `domain_error` for that domain alone. Rejecting it here would read as
  // a broken payload and take the other domain down with it.
  //
  // The posture word is checked for being a word rather than for being one this
  // build knows. An unrecognized word is version skew rather than a malformed
  // body, and `securityConcerns` decides it, so it costs this one column instead
  // of the payload that carries Workloads alongside it.
  if (value === null) return true;
  if (!isRecord(value)) return false;
  const lastScan = value.lastSuccessfulScanAt;
  return typeof value.generatedAt === 'number'
    && typeof value.posture === 'string'
    && typeof value.posturePartial === 'boolean'
    && typeof value.scannerAvailable === 'boolean'
    && typeof value.staleScans === 'number'
    && typeof value.failedScans === 'number'
    && (lastScan === null || typeof lastScan === 'number');
}

/**
 * Whether a peer's payload carries the shape the reads below dereference.
 *
 * Checked field by field rather than at the top level, because the domains
 * destructure these deeply, and a body that passes a shallow check and then
 * throws on a missing array costs the node's entire row: the throw leaves
 * `buildNodeRow`, so the per-node catch replaces every one of the node's columns
 * with an unavailable one, including the connectivity cell the read did answer.
 * That is a larger loss than the malformed field ever justified, and it is why
 * the checks below follow the shape rather than the top level. A body that fails
 * here is reported as a failed read, which is the answer an unparseable body
 * already gets.
 *
 * The words that name a verdict are deliberately not checked here, in either
 * payload. Those are lists, one entry per stack, and an unrecognized word is
 * version skew rather than a malformed payload: it degrades per row below, so a
 * peer that adds a verdict costs one stack's answer instead of the node's whole
 * column. The security posture word is the one word this function checks, and
 * only for being a word rather than for being one this build knows;
 * `isSecurityEvidence` states why that one is treated differently.
 */
function isEvidencePayload(value: unknown): value is NodeReadinessEvidence {
  return isRecord(value)
    && typeof value.generatedAt === 'number'
    && 'workloads' in value
    && 'security' in value
    && isWorkloadEvidence(value.workloads)
    && isSecurityEvidence(value.security);
}

function isSummaryRow(value: unknown): value is StackReadinessRow {
  return isRecord(value)
    && typeof value.stack === 'string'
    && (value.update === null || isRecord(value.update))
    && (value.rollback === null || isRecord(value.rollback))
    && (value.unavailableReason === null || typeof value.unavailableReason === 'string');
}

function isSummaryPayload(value: unknown): value is NodeStackReadinessSummary {
  return isRecord(value)
    && typeof value.generatedAt === 'number'
    && typeof value.stale === 'boolean'
    && typeof value.truncated === 'boolean'
    && Array.isArray(value.stacks)
    && value.stacks.every(isSummaryRow);
}

/**
 * Drop a body the read does not consume, without letting the cleanup speak for
 * the read.
 *
 * `cancel()` rejects when the stream died after the status line arrived, and
 * that rejection belongs to this call, not to the response: letting it reach the
 * catch below would rewrite an answered read into `unreachable`, which reports a
 * node that predates the slice as an outage instead of as version skew, and
 * skips the last-contact stamp for a node that did answer.
 */
async function releaseAnsweredBody(response: Response, path: string, nodeName: string): Promise<void> {
  try {
    await response.body?.cancel();
  } catch (error) {
    console.warn(
      `Readiness aggregate: ${path} could not release an answered body for node ${sanitizeForLog(nodeName)}:`,
      errorMessageForLog(error),
    );
  }
}

/**
 * Read one of this node's slices over HTTP, bounded by the smaller of the
 * request's remaining life and the budget.
 *
 * `AbortSignal.any` is what makes one signal serve both: navigating away
 * cancels an in-flight read immediately instead of leaving it to run out its
 * budget, and the budget still holds when the client stays.
 */
async function fetchNodeJson<T>(
  nodeName: string,
  target: ProxyTarget,
  path: string,
  signal: AbortSignal,
  budgetMs: number,
  isPayload: (value: unknown) => value is T,
): Promise<NodeRead<T>> {
  const url = `${target.apiUrl.replace(/\/$/, '')}${path}`;
  const headers = target.apiToken ? { Authorization: `Bearer ${target.apiToken}` } : {};
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(budgetMs)]);
  const startedAt = Date.now();
  try {
    const response = await safeRemoteFetch(url, { headers, signal: bounded }, target.trustedLoopback);
    // Both early returns drop the body unread, which leaves its connection held
    // on undici's pool until the stream is consumed, cancelled, or collected.
    // A 404 is the expected answer from a node that predates the slice, so those
    // held connections would accumulate across a fleet instead of being a
    // one-off, and the dispatcher sets no connection cap to absorb them.
    if (response.status === 404) {
      await releaseAnsweredBody(response, path, nodeName);
      return { kind: 'absent' };
    }
    if (!response.ok) {
      console.warn(`Readiness aggregate: ${path} answered ${response.status} for node ${sanitizeForLog(nodeName)}`);
      await releaseAnsweredBody(response, path, nodeName);
      return { kind: 'failed' };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (parseError) {
      // An abort or an expired budget rejects this too, and those belong to the
      // outer catch, so they are handed straight back to it. Everything left is
      // a response that arrived with a body this hub could not read, and the
      // distinction is not the error's class: a body stream that dies mid-flight
      // rejects with a bare `terminated` rather than a syntax error, and it
      // still belongs here. A response was in hand by the time this ran, so the
      // transport did not produce nothing, and reporting it as `unreachable`
      // would send the operator to a tunnel for a node that completed a
      // handshake and sent a status line.
      if (signal.aborted || bounded.aborted) throw parseError;
      console.warn(
        `Readiness aggregate: ${path} answered ${response.status} with a body this hub cannot read for node ${sanitizeForLog(nodeName)}:`,
        errorMessageForLog(parseError),
      );
      return { kind: 'failed' };
    }
    if (!isPayload(body)) {
      console.warn(`Readiness aggregate: ${path} returned an unusable payload for node ${sanitizeForLog(nodeName)}`);
      return { kind: 'failed' };
    }
    return { kind: 'ok', value: body, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    if (signal.aborted) {
      console.warn(`Readiness aggregate: ${path} aborted with the request for node ${sanitizeForLog(nodeName)}`);
      return { kind: 'unreachable' };
    }
    if (bounded.aborted) {
      console.warn(`Readiness aggregate: ${path} exceeded its ${budgetMs}ms budget for node ${sanitizeForLog(nodeName)}`);
      return { kind: 'timeout' };
    }
    // The transport's own failure, with no response behind it, which is what
    // separates this from the answered returns above.
    console.warn(
      `Readiness aggregate: ${path} failed for node ${sanitizeForLog(nodeName)}:`,
      // The cause is folded into this message by `errorMessageForLog`, which is
      // where a rejected fetch keeps the reason an operator can act on.
      errorMessageForLog(error),
    );
    return { kind: 'unreachable' };
  }
}

/**
 * One node-local slice of readiness evidence, and both ways of reading it.
 *
 * The hub reads its own node in process and a remote over HTTP, and the two
 * paths have to return the same payload, so they run the same code behind the
 * same budget. That is what the entry below the type is: this slice's route, its
 * ceiling, and the in-process builder the assembly exports.
 */
interface NodeSlice<T> {
  /** Path this node serves the slice on, for the remote read. */
  path: string;
  /** Ceiling for one read of the slice, whichever path it takes. */
  budgetMs: number;
  /** Shape check the remote body has to pass before it is used. */
  isPayload: (value: unknown) => value is T;
  /** Name for the routine lines about this slice, e.g. `local evidence`. */
  name: string;
  /**
   * Name `withTimeout` reports a budget overrun under, which words the call
   * rather than the slice: `local readiness evidence`, against the shorter word
   * the routine lines use.
   */
  timeoutLabel: string;
  buildLocal: (nodeId: number) => Promise<T>;
}

const EVIDENCE_SLICE: NodeSlice<NodeReadinessEvidence> = {
  path: EVIDENCE_PATH,
  budgetMs: EVIDENCE_BUDGET_MS,
  isPayload: isEvidencePayload,
  name: 'local evidence',
  timeoutLabel: 'local readiness evidence',
  buildLocal: buildNodeReadinessEvidence,
};

const SUMMARY_SLICE: NodeSlice<NodeStackReadinessSummary> = {
  path: SUMMARY_PATH,
  budgetMs: SUMMARY_BUDGET_MS,
  isPayload: isSummaryPayload,
  name: 'local readiness summary',
  timeoutLabel: 'local readiness summary',
  buildLocal: buildStackReadinessSummary,
};

/**
 * One of this node's slices: workload and security evidence, or the per-stack
 * verdicts.
 *
 * The in-process call is bounded by the same budget as the HTTP one, because the
 * fan-out's latency ceiling has to hold whichever path a node takes; the cost is
 * that a timed-out local read keeps running, which is the trade `withTimeout`
 * documents.
 */
async function readNodeSlice<T>(
  node: Node,
  target: ProxyTarget | null,
  signal: AbortSignal,
  slice: NodeSlice<T>,
): Promise<NodeRead<T>> {
  if (node.type !== 'local') {
    // The caller's `reachable` guard is what made this read happen, so a null
    // target cannot arrive here; the check exists because the type allows it,
    // and `unreachable` is its truthful kind if it ever does.
    return target === null
      ? { kind: 'unreachable' }
      : fetchNodeJson(node.name, target, slice.path, signal, slice.budgetMs, slice.isPayload);
  }
  const startedAt = Date.now();
  try {
    const value = await withTimeout(slice.buildLocal(node.id), slice.budgetMs, slice.timeoutLabel);
    return { kind: 'ok', value, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    if (error instanceof TimeoutError) {
      console.warn(`Readiness aggregate: ${slice.name} exceeded its ${slice.budgetMs}ms budget`);
      return { kind: 'timeout' };
    }
    // In process rather than over the wire, so this is an error and not the
    // routine warn a remote failure gets.
    console.error(
      `Readiness aggregate: ${slice.name} failed:`,
      errorMessageForLog(error),
    );
    return { kind: 'failed' };
  }
}

/**
 * The code for a read that did not answer.
 *
 * One mapping serves the domain cells and the Connectivity column both, so a
 * transport that produced nothing, a budget that ran out, and a response this
 * hub could not use cannot read one way in one column and another way in the
 * next. `null` and `unreachable` are the same event to an operator (no answer
 * arrived) and differ only in whether the hub had a transport to try at all,
 * which is what the mode-based code names. `absent` is a 404 and keeps its own
 * code: the node answered, and what is missing is the route rather than the
 * transport.
 */
function unansweredCode(
  read: Exclude<NodeRead<unknown>, { kind: 'ok' }> | null,
  node: Node,
): ReadinessReasonCode {
  if (read === null || read.kind === 'unreachable') {
    return node.mode === 'pilot_agent' ? 'pilot_disconnected' : 'node_unreachable';
  }
  if (read.kind === 'absent') return 'capability_absent';
  if (read.kind === 'timeout') return 'probe_timeout';
  return 'domain_error';
}

/**
 * The concern a domain carries when the read that feeds it did not answer.
 *
 * Callers guard on `kind !== 'ok'` before reaching here, so `null` means no
 * read was attempted, which happens only when the hub has no transport to the
 * node. That is a different event from a read that failed: it describes a node
 * the hub could not reach, not one whose check errored. Reporting it as
 * `domain_error` would say the node answered and its payload was bad, which
 * sends the operator to look at the node's build instead of at the transport
 * between them.
 */
function readFailureConcern(
  read: Exclude<NodeRead<unknown>, { kind: 'ok' }> | null,
  target: ReadinessTarget,
  node: Node,
): DomainConcern {
  return concern({ state: 'unavailable', code: unansweredCode(read, node) }, target);
}

/**
 * A domain whose read produced no answer at all.
 *
 * The read is the whole story here, so the cell is that one concern and there is
 * nothing to count or age. The source is `stored` only when the read is null,
 * which is the case where the hub attempted nothing at all and the cell reports
 * what it already knew rather than a result it just obtained; every read that
 * ran, including one that failed, is this request's own evidence.
 */
function unreadResult(
  node: Node,
  domain: ReadinessDomainKey,
  read: Exclude<NodeRead<unknown>, { kind: 'ok' }> | null,
  target: ReadinessTarget,
): DomainResult {
  const failure = readFailureConcern(read, target, node);
  return domainResult(node.id, domain, [failure], { evidenceAgeMs: null, source: read === null ? 'stored' : 'live' });
}

/**
 * How the cached classification reads when no live probe answered.
 *
 * Exhaustive over the closed union rather than a lookup with a default, so a
 * note added to `blueprintPreviewProjection.ts` fails the type check here
 * instead of silently classifying as healthy, which is the one answer this
 * surface may never guess at.
 *
 * The value pairs a state with the reason it happened rather than carrying a
 * nullable code beside a state, so a reader never has to invent a code to fill
 * the gap, which is how a cell ends up naming a condition that is not the one it
 * is reporting.
 */
type CachedClassification =
  | { state: 'healthy'; code: null }
  | { state: Exclude<DomainState, 'healthy'>; code: ReadinessReasonCode };

const CACHED_CLASSIFICATION: Record<PreviewReachabilityNote, CachedClassification> = {
  'Local node': { state: 'healthy', code: null },
  'Pilot heartbeat fresh but cached status is offline': { state: 'degraded', code: 'contact_stale' },
  'Pilot node cached as offline or unknown': { state: 'attention', code: 'pilot_disconnected' },
  'Pilot heartbeat expired (cached)': { state: 'attention', code: 'contact_stale' },
  'Pilot heartbeat fresh (cached)': { state: 'healthy', code: null },
  'Remote node cached as offline or unknown': { state: 'attention', code: 'node_unreachable' },
  'Proxy contact missing or stale (cached status)': { state: 'degraded', code: 'contact_stale' },
  'Proxy contact fresh (cached)': { state: 'healthy', code: null },
};

interface ConnectivityInput {
  node: Node;
  target: ProxyTarget | null;
  read: NodeRead<NodeReadinessEvidence> | null;
}

/**
 * The node's reachability, from the probe when it answered and from the hub's
 * cached classification when it did not.
 *
 * The probe and the cache answer different questions and both are published:
 * `reachability.note` is the cached classification and `reachability.probedLive`
 * is this request's own result, so a reader can tell "the hub thinks this node
 * is offline" from "this node answered me just now". The cached classification
 * decides the state only when no probe ran or the probe failed, and even then a
 * cached row that claims health is refused, because a fresh failure outranks a
 * stale success.
 */
function connectivityResult(input: ConnectivityInput): { result: DomainResult; reachability: NodeReachability } {
  const { node, target, read } = input;
  const info = contactInfo(node);
  const nodeTarget: ReadinessTarget = { surface: 'node-details', nodeId: node.id };
  const probedLive = read !== null && read.kind === 'ok';
  // A 404 is an answer: the node is up and its build is older than this hub's,
  // so what is missing is the route this generation reads rather than the
  // transport. It is not the cached classification's story either, so it is
  // decided before the cache is consulted.
  const routeAbsent = read !== null && read.kind === 'absent';
  // Set when this request's own probe produced the answer, which is what the
  // cell's `source` reports. A state taken from the hub's stored classification
  // is the other thing, whatever the probe did on its way to failing.
  let source: 'live' | 'stored' = probedLive ? 'live' : 'stored';
  let spec: ConcernSpec | null = null;

  if (node.type === 'local') {
    // A local node is its own transport, so nothing between the hub and this row
    // can be unreachable. The domains below report on the reads themselves.
    //
    // The healthy state comes from the node row rather than from this request's
    // read, so the cell is `stored` whatever the read did. The local evidence
    // read is the workloads and security pass, and relabelling this cell from
    // its outcome would report a Docker failure as an answer about the transport
    // between the hub and itself, which is the one thing a local node cannot
    // get wrong.
    source = 'stored';
  } else if (target === null) {
    // The disconnected-Pilot fast path: no transport exists, so no read was
    // attempted. The node's own mode decides which disconnected code applies,
    // and the hub's cached view still reaches the surface through
    // `reachability.note` rather than through this cell.
    spec = { state: 'attention', code: node.mode === 'pilot_agent' ? 'pilot_disconnected' : 'node_unreachable' };
  } else if (routeAbsent) {
    spec = { state: 'unavailable', code: 'capability_absent' };
    source = 'live';
  } else if (read === null || read.kind !== 'ok') {
    // The condition restates `!probedLive` rather than using it: the two are the
    // same test, and this spelling is what narrows `read` to the answers that
    // are not an answer, which is the type `unansweredCode` takes.
    const cached = CACHED_CLASSIFICATION[info.reachabilityNote];
    if (cached.state === 'healthy') {
      // A probe that just failed outranks a cached success: the hub's stored
      // view is not evidence that this request's failure did not happen. The
      // code comes from the mapping the sibling domains use, so a response this
      // hub could not read reads as `domain_error` here too, rather than
      // claiming the node was unreachable about a node that answered.
      spec = { state: 'attention', code: unansweredCode(read, node) };
      source = 'live';
    } else {
      spec = { state: cached.state, code: cached.code };
    }
  }

  const concerns: DomainConcern[] = spec === null ? [] : [concern(spec, nodeTarget)];

  const reachability: NodeReachability = {
    status: node.status,
    contactAt: info.contactAt,
    contactSource: info.contactSource,
    note: info.reachabilityNote,
    probedLive,
    latencyMs: probedLive ? read.elapsedMs : null,
  };

  return {
    result: domainResult(node.id, 'connectivity', concerns, { evidenceAgeMs: null, source }),
    reachability,
  };
}

function workloadsConcerns(node: Node, evidence: NodeWorkloadEvidence): DomainConcern[] {
  const concerns: DomainConcern[] = [];
  const nodeTarget: ReadinessTarget = { surface: 'node-details', nodeId: node.id };
  if (evidence.stale) {
    // A status bundle whose cache went stale, or whose compute reported itself
    // degraded, describes the state of this node's workload evidence rather than
    // the state of any one stack, so both land on the node and not on a row.
    concerns.push(concern({ state: 'unknown', code: 'status_evidence_stale' }, nodeTarget));
  }
  if (evidence.degraded) {
    concerns.push(concern({ state: 'unknown', code: 'status_evidence_degraded' }, nodeTarget));
  }
  for (const problem of evidence.problems) {
    const stackTarget: ReadinessTarget = { surface: 'stack', nodeId: node.id, stackName: problem.stack };
    if (!isKnownWord(WORKLOAD_STATUS_CONCERNS, problem.status)) {
      // A status word this build does not have, which is a peer on a different
      // version rather than a stack with nothing wrong. It is reported per stack
      // so one unrecognized word costs one row instead of the node's column.
      concerns.push(concern({ state: 'unknown', code: 'workloads_unknown' }, stackTarget, { stack: problem.stack }));
      continue;
    }
    concerns.push(concern(WORKLOAD_STATUS_CONCERNS[problem.status], stackTarget, { stack: problem.stack }));
  }
  return concerns;
}

/**
 * The count entries that arrived as numbers.
 *
 * The wire type promises a number per entry, but this map crossed a peer's JSON
 * boundary to get here, and an entry that is not a number would otherwise be
 * published under a type that says it is. Such an entry is dropped rather than
 * failing the read: the counts are decoration on a cell the concerns already
 * classify, so one unreadable count must not cost the Workloads column, let
 * alone the Security column the same read carries.
 */
function numericCounts(counts: Record<string, unknown>): Record<string, number> {
  const numeric: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) {
    if (typeof value === 'number' && Number.isFinite(value)) numeric[key] = value;
  }
  return numeric;
}

/**
 * A row's explanation, only when it arrived as text.
 *
 * The wire type says `string | null`, but this value crossed a peer's JSON
 * boundary too. A peer that omits the field or sends something else leaves the
 * row without an explanation, rather than putting the literal text "undefined"
 * in the operator's findings list.
 */
function reasonText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function workloadsResult(node: Node, read: NodeRead<NodeReadinessEvidence> | null): DomainResult {
  if (read === null || read.kind !== 'ok') {
    return unreadResult(node, 'workloads', read, { surface: 'node-details', nodeId: node.id });
  }

  // Distinct from a failed read: the node answered and said this one compute
  // threw, so the null costs this column its `domain_error` while the Security
  // column the same payload carries keeps its evidence.
  const evidence = read.value.workloads;
  if (evidence === null) {
    const domainError = domainErrorConcern({ surface: 'node-details', nodeId: node.id });
    return domainResult(node.id, 'workloads', [domainError], { evidenceAgeMs: null, source: 'live' });
  }

  const concerns = workloadsConcerns(node, evidence);
  const counts = numericCounts(evidence.counts);
  return domainResult(node.id, 'workloads', concerns, {
    counts,
    evidenceAgeMs: ageOf(evidence.generatedAt),
    source: 'live',
  });
}

function securityConcerns(evidence: NodeSecurityEvidence): DomainConcern[] {
  const concerns: DomainConcern[] = [];
  const overviewTarget: ReadinessTarget = { surface: 'security', tab: null };
  if (!isKnownWord(SECURITY_POSTURE_CONCERNS, evidence.posture)) {
    // A posture word this build does not have: a peer on a different version
    // rather than a fleet with nothing wrong. The word is the column's headline
    // rather than one row of it, so the column says it cannot classify what it
    // leads with, instead of falling through to healthy on a word it never read.
    // The inputs beside it are still read below, so a stale or failed scan is
    // reported as itself rather than hidden behind the unreadable headline.
    concerns.push(domainErrorConcern(overviewTarget));
  } else {
    const posture = SECURITY_POSTURE_CONCERNS[evidence.posture];
    if (posture !== null) concerns.push(concern(posture, overviewTarget));
  }
  if (evidence.posture === 'Unknown') {
    // The word alone is ambiguous between "no scanner" and "nothing scanned
    // yet", which is why the evidence carries the inputs beside it.
    concerns.push(concern(
      { state: 'unknown', code: evidence.scannerAvailable ? 'scans_never_completed' : 'scanner_unavailable' },
      evidence.scannerAvailable ? overviewTarget : { surface: 'security', tab: 'scanner' },
    ));
  }
  if (evidence.posturePartial) {
    // Any of four independent caps can set this, and the finding-array caps can
    // hide the very finding that would have moved the posture, so nothing
    // derived from the pass is safe to read as healthy while it is set.
    concerns.push(concern({ state: 'unknown', code: 'posture_partial' }, overviewTarget));
  }
  if (evidence.staleScans > 0) {
    concerns.push(concern(
      { state: 'degraded', code: 'scans_stale' },
      { surface: 'security', tab: 'images' },
      { count: evidence.staleScans },
    ));
  }
  // `failedScans` deliberately raises no concern. It is a lifetime count over
  // the scan retention window, so a fleet that scans on a schedule carries a
  // nonzero value almost permanently and the column would read degraded for a
  // failure that was already retried. The canonical posture derivation files the
  // same input as context only, and a second surface escalating it would be a
  // second authority over one fact. The count is still published in the cell's
  // `counts`, where a history belongs.
  return concerns;
}

function securityResult(node: Node, read: NodeRead<NodeReadinessEvidence> | null): DomainResult {
  if (read === null || read.kind !== 'ok') {
    return unreadResult(node, 'security', read, { surface: 'security', tab: null });
  }

  // A null here is the node reporting that its own security compute threw, not
  // a read that failed, exactly as in `workloadsResult`.
  const evidence = read.value.security;
  if (evidence === null) {
    const domainError = domainErrorConcern({ surface: 'security', tab: null });
    return domainResult(node.id, 'security', [domainError], { evidenceAgeMs: null, source: 'live' });
  }

  const concerns = securityConcerns(evidence);
  const counts = { staleScans: evidence.staleScans, failedScans: evidence.failedScans };
  return domainResult(node.id, 'security', concerns, {
    counts,
    evidenceAgeMs: ageOf(evidence.generatedAt),
    source: 'live',
  });
}

/**
 * The update verdicts, as the canonical contract reports them.
 *
 * This restates verdicts rather than deriving them: the four states below are
 * the strongest existing explanation of each verdict, and a stack whose verdict
 * is itself `unknown` is reported as unknown rather than folded into healthy,
 * because "nobody could decide" is the answer this surface exists to publish.
 */
function updatesConcerns(node: Node, summary: NodeStackReadinessSummary): DomainConcern[] {
  const concerns: DomainConcern[] = [];
  const target: ReadinessTarget = { surface: 'auto-updates' };
  for (const row of summary.stacks) {
    const stackTarget: ReadinessTarget = { surface: 'stack', nodeId: node.id, stackName: row.stack };
    if (row.update === null) {
      // The row carries its own reason for having no verdict, so that reason is
      // the code rather than a flattening to `stacks_unknown`. A reason this
      // domain does not register is a version skew, so it falls back to
      // `stacks_unknown` and says so on the console; `rowUnavailableCode` holds
      // the rule.
      concerns.push(concern(
        { state: 'unknown', code: rowUnavailableCode('updates', row.unavailableReason) },
        stackTarget,
        { stack: row.stack },
      ));
      continue;
    }
    if (!isKnownWord(UPDATE_VERDICT_CONCERNS, row.update.verdict)) {
      // A verdict word this build does not have: a peer running a wider
      // vocabulary than this hub compiled against. It is not a healthy stack and
      // not silence either, and the tagged union cannot hold a word it does not
      // recognize, so the row is reported as unknown with the verdict left null.
      concerns.push(concern({ state: 'unknown', code: 'stacks_unknown' }, stackTarget, { stack: row.stack }));
      continue;
    }
    const entry = UPDATE_VERDICT_CONCERNS[row.update.verdict];
    if (entry === null) continue;
    concerns.push(concern(entry, stackTarget, {
      detail: reasonText(row.update.topReason),
      stack: row.stack,
      verdict: { kind: 'update', value: row.update.verdict },
    }));
  }
  if (summary.truncated) {
    concerns.push(concern({ state: 'unknown', code: 'summary_truncated' }, target));
  }
  return concerns;
}

function recoveryConcerns(node: Node, summary: NodeStackReadinessSummary, missed: number | null): DomainConcern[] {
  const concerns: DomainConcern[] = [];
  // Every node-level row in this domain is a fact about the fleet's snapshots,
  // which is where a reader goes to act on it.
  const snapshotsTarget: ReadinessTarget = { surface: 'fleet-snapshots' };
  for (const row of summary.stacks) {
    const stackTarget: ReadinessTarget = { surface: 'stack', nodeId: node.id, stackName: row.stack };
    if (row.rollback === null) {
      concerns.push(concern(
        { state: 'unknown', code: rowUnavailableCode('recovery', row.unavailableReason) },
        stackTarget,
        { stack: row.stack },
      ));
      continue;
    }
    if (!isKnownWord(ROLLBACK_OVERALL_CONCERNS, row.rollback.overall)) {
      // The same version-skew case as the update verdict above: unknown, with no
      // verdict to carry, rather than a healthy stack.
      concerns.push(concern({ state: 'unknown', code: 'stacks_unknown' }, stackTarget, { stack: row.stack }));
      continue;
    }
    const entry = ROLLBACK_OVERALL_CONCERNS[row.rollback.overall];
    if (entry === null) continue;
    concerns.push(concern(entry, stackTarget, {
      detail: reasonText(row.rollback.topReason),
      stack: row.stack,
      verdict: { kind: 'rollback', value: row.rollback.overall },
    }));
  }
  if (summary.truncated) {
    concerns.push(concern({ state: 'unknown', code: 'summary_truncated' }, snapshotsTarget));
  }
  if (missed === null) {
    // There is no snapshot to read, or the newest one's own columns could not be
    // read: either way whether this node was captured is not knowable from here.
    // It is not 0 and it is not healthy, because the answer a reader would take
    // from a healthy cell is that recovery coverage for this node is confirmed.
    concerns.push(concern({ state: 'unknown', code: 'stacks_unknown' }, snapshotsTarget));
  } else if (missed > 0) {
    concerns.push(concern({ state: 'degraded', code: 'snapshot_failed' }, snapshotsTarget, { count: missed }));
  }
  return concerns;
}

function isSkipEntry(value: unknown): value is { nodeId: number } {
  return isRecord(value) && 'nodeId' in value && typeof value.nodeId === 'number';
}

/**
 * How many entries of the newest snapshot name this node among the ones it could
 * not capture, or null when that cannot be answered.
 *
 * Two things produce the null, and they mean the same thing to a reader: no
 * snapshot exists at all, or the newest one's skip column could not be read.
 * Zero is the answer "this node was fully captured", and neither a fleet with no
 * recovery point nor a fault in the hub's own storage may give it. The caller
 * turns null into an unknown cell, the way every other missing input on this
 * surface is reported.
 *
 * An entry the reader cannot classify is treated as an unreadable column for the
 * same reason a partly understood list would be: a count taken from the entries
 * that happened to parse is a guess wearing the dress of a number.
 */
function snapshotMisses(snapshot: FleetSnapshot | null, nodeId: number): number | null {
  // No snapshot at all, which is a fleet that has never been captured rather
  // than a fleet that captured everything. Returning 0 here would report every
  // node as fully captured on the strength of a capture that does not exist.
  if (snapshot === null) return null;
  let misses = 0;
  for (const column of [snapshot.skipped_nodes, snapshot.skipped_stacks]) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(column);
    } catch (error) {
      console.error(
        `Readiness aggregate: unreadable skip column on snapshot ${snapshot.id}:`,
        errorMessageForLog(error),
      );
      return null;
    }
    if (!Array.isArray(parsed) || !parsed.every(isSkipEntry)) {
      console.error(`Readiness aggregate: snapshot ${snapshot.id} carries a skip column this hub cannot read`);
      return null;
    }
    misses += parsed.filter((entry) => entry.nodeId === nodeId).length;
  }
  return misses;
}

function tierTwoResult(
  node: Node,
  domain: 'updates' | 'recovery',
  read: NodeRead<NodeStackReadinessSummary> | null,
  snapshot: FleetSnapshot | null,
): DomainResult {
  // Which surface answers for this domain, with no node id in it: neither target
  // varies by node, so this is a value rather than the function of the node id
  // the callers used to hand over.
  const target: ReadinessTarget = domain === 'updates'
    ? { surface: 'auto-updates' }
    : { surface: 'fleet-snapshots' };
  if (read === null || read.kind !== 'ok') {
    return unreadResult(node, domain, read, target);
  }

  const summary = read.value;

  // Read once here rather than inside the recovery branch, because the age below
  // has to know whether the snapshot actually decided anything.
  const missed = domain === 'recovery' ? snapshotMisses(snapshot, node.id) : null;
  const concerns = domain === 'updates'
    ? updatesConcerns(node, summary)
    : recoveryConcerns(node, summary, missed);
  // A pass older than its freshness window is real but unbounded in age, and
  // neither cell may be healthy on it, so staleness enters as a concern rather
  // than as a flag the cell would still be allowed to call healthy. It carries
  // its own code rather than `stacks_unknown` so that a stale pass and an
  // unknown coverage answer, which can hold at once, stay two findings with two
  // ids instead of one id counted twice.
  if (summary.stale) {
    concerns.push(concern({ state: 'unknown', code: 'summary_stale' }, target));
  }
  const evidenceAgeMs = oldestAge(
    ageOf(summary.generatedAt),
    // The Recovery cell rests on two reads, and the age it reports is the oldest
    // of the ones that decided it: a fresh snapshot that skipped nobody does not
    // make an hour-old verdict set current, and an old snapshot that contributed
    // nothing does not age a cell whose verdicts are new.
    domain === 'recovery' && snapshot !== null && (missed === null || missed > 0)
      ? ageOf(snapshot.created_at)
      : null,
  );
  return domainResult(node.id, domain, concerns, { evidenceAgeMs, source: 'live' });
}

/**
 * The Control domain, classified from the hub's own sync rows: a sticky
 * `CONTROL_IDENTITY_MISMATCH` is a paused control plane and is not retriable, a
 * failure newer than the last success is degraded, and no rows at all is unknown
 * rather than healthy.
 *
 * This is the readiness surface's one classifier for the domain: the fleet view
 * renders what this projection publishes rather than re-deriving the three
 * answers from the same rows. Settings -> Nodes reads those rows for its own
 * anchor-mismatch banner and derives its own answer, so a change to the
 * semantics here does not reach it.
 */
function controlResult(nodeId: number, rows: readonly FleetSyncStatus[] | null): DomainResult {
  const concerns: DomainConcern[] = [];
  const target: ReadinessTarget = { surface: 'settings-nodes' };
  if (rows === null) {
    // The hub's own rows failed to read, which is a statement about the hub and
    // not about this node, so it is filed as an unreadable domain rather than as
    // the never-synced `unknown` an empty row set means. Same code and state as
    // any other in-process read failure, for the same reason.
    concerns.push(concern({ state: 'unavailable', code: 'domain_error' }, target));
    // Null age, not zero: nothing was read, so there is no evidence to date.
    return domainResult(nodeId, 'control', concerns, { counts: {}, evidenceAgeMs: null, source: 'stored' });
  }
  // The first failed resource in the `node_id, resource` order these rows come
  // back in, not the newest failure: the set is not ordered by time, and one
  // explanation is what the finding carries.
  const firstError = rows.find((row) => row.last_error !== null)?.last_error ?? null;
  const detail = firstError === null ? null : redactSensitiveText(firstError) || null;

  if (rows.length === 0) {
    // No rows is not an empty failure set: it is a node the hub has never synced
    // with, and the detail above is null for the same reason.
    concerns.push(concern({ state: 'unknown', code: 'control_unknown' }, target));
  } else if (rows.some((row) => row.sticky_error_code === SYNC_ERROR_CODES.controlIdentityMismatch)) {
    concerns.push(concern({ state: 'attention', code: 'control_paused' }, target, { detail }));
  } else if (rows.some((row) => row.last_failure_at !== null
    && (row.last_success_at === null || row.last_failure_at > row.last_success_at))) {
    concerns.push(concern({ state: 'degraded', code: 'control_degraded' }, target, { detail }));
  }

  const evidenceAgeMs = newestAge(
    ...rows.flatMap((row) => [ageOrNull(row.last_success_at), ageOrNull(row.last_failure_at)]),
  );
  const counts = { resources: rows.length };
  return domainResult(nodeId, 'control', concerns, { counts, evidenceAgeMs, source: 'stored' });
}

function stackCountOf(read: NodeRead<NodeReadinessEvidence> | null): number | null {
  const evidence = read !== null && read.kind === 'ok' ? read.value.workloads : null;
  if (evidence === null || evidence.degraded) return null;
  // Through the same filter `workloadsResult` uses, so the number this total is
  // built from cannot be a value the column beside it dropped as unreadable.
  const counts = numericCounts(evidence.counts);
  // Anything that filter dropped leaves this total short by an unknown amount,
  // which is the one thing a total must not be. `degraded` already withholds it
  // on that reasoning for the read as a whole, and an unreadable tally is the
  // same claim about one bucket: the cell keeps the counts it could read, and
  // the number is withheld rather than quietly reported short.
  if (Object.keys(counts).length !== Object.keys(evidence.counts).length) return null;
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

interface NodeRowResult {
  node: FleetReadinessNode;
  findings: ReadinessFinding[];
}

async function buildNodeRow(node: Node, request: FleetReadinessRequest): Promise<NodeRowResult> {
  const db = DatabaseService.getInstance();
  const isLocal = node.type === 'local';
  const target = isLocal ? null : NodeRegistry.getInstance().getProxyTarget(node.id);
  const transport = transportOf(node, target);
  const reachable = isLocal || target !== null;
  const wanted = new Set(request.domains);
  const wantsTierTwo = wanted.has('updates') || wanted.has('recovery');

  const [evidenceRead, summaryRead] = await Promise.all([
    reachable ? readNodeSlice(node, target, request.signal, EVIDENCE_SLICE) : null,
    reachable && wantsTierTwo ? readNodeSlice(node, target, request.signal, SUMMARY_SLICE) : null,
  ]);

  // A 404 counts as contact: the node answered, which is what this timestamp
  // records. Only a read that produced no answer at all leaves it alone, because
  // writing it on a failed attempt would turn the hub's assumption into the
  // record it later reads back as fact.
  const answered = evidenceRead !== null && (evidenceRead.kind === 'ok' || evidenceRead.kind === 'absent');
  if (!isLocal && answered) {
    try {
      db.updateNodeLastContact(node.id);
    } catch (error) {
      // Guarded on its own rather than by the worker's catch: that one returns an
      // empty row, so letting this throw would discard the evidence already read
      // above over a failed timestamp write. The stamp is the side effect, so a
      // failure costs the stamp.
      console.error(
        `Readiness aggregate: could not record last contact for node ${sanitizeForLog(node.name)}:`,
        errorMessageForLog(error),
      );
    }
  }

  const connectivity = connectivityResult({ node, target, read: evidenceRead });
  const cells: Partial<Record<ReadinessDomainKey, NodeDomainCell>> = {};
  const findings: ReadinessFinding[] = [];
  // The producer is a thunk rather than a value so a domain the caller did not
  // ask for costs nothing. Recovery's would otherwise read the newest snapshot
  // on every request, including the ones that never look at that column.
  const publish = (domain: ReadinessDomainKey, produce: () => DomainResult): void => {
    if (!wanted.has(domain)) return;
    const result = produce();
    cells[domain] = result.cell;
    findings.push(...result.findings);
  };

  // Reachability is node-level and always published, but the cell is one of the
  // six domains and follows the same rule as its siblings: a caller that did not
  // ask for Connectivity does not get a cell for it, and `domainsOmitted` is
  // where its absence is accounted for.
  publish('connectivity', () => connectivity.result);
  publish('workloads', () => workloadsResult(node, evidenceRead));
  publish('updates', () => tierTwoResult(node, 'updates', summaryRead, null));
  publish('recovery', () => tierTwoResult(node, 'recovery', summaryRead, db.getSnapshots(1)[0] ?? null));
  publish('security', () => securityResult(node, evidenceRead));

  return {
    node: {
      id: node.id,
      name: node.name,
      type: node.type,
      mode: node.mode,
      transport,
      reachability: connectivity.reachability,
      cells,
      stackCount: stackCountOf(evidenceRead),
    },
    findings,
  };
}

/**
 * The worst state among a node's cells, counted over the domains this response
 * carries. A node with no cells at all is `unknown`, never healthy: an empty
 * row is the absence of evidence, which is the one thing this surface may not
 * read as good news.
 */
function worstNodeState(cells: Partial<Record<ReadinessDomainKey, NodeDomainCell>>): DomainState {
  let worst: DomainState | null = null;
  for (const cell of Object.values(cells)) {
    if (cell === undefined) continue;
    if (worst === null || stateRank(cell.state) < stateRank(worst)) worst = cell.state;
  }
  return worst ?? 'unknown';
}

function emptyStateCounts(): Record<DomainState, number> {
  return { attention: 0, degraded: 0, unavailable: 0, unknown: 0, healthy: 0 };
}

function emptySeverityCounts(): Record<ReadinessFinding['severity'], number> {
  return { attention: 0, degraded: 0, unavailable: 0, unknown: 0 };
}

/**
 * Assemble `GET /api/fleet/readiness`.
 *
 * The fan-out is bounded twice over: `mapWithConcurrency` caps how many nodes
 * are in flight, and every read carries its own budget through
 * `AbortSignal.any` so a node that never answers costs one budget rather than
 * the page. No worker is expected to reject, because each node's row is built by
 * a function that degrades rather than throws. The hub-side reads inside it are
 * the exception, and the catch below is what keeps an unexpected throw from
 * taking the fleet row with it.
 *
 * Control is merged here rather than inside the per-node work, so the caller's
 * admin check decides whether it exists at all and no cached or intermediate
 * structure ever holds it for a caller who may not see it.
 */
export async function buildFleetReadiness(request: FleetReadinessRequest): Promise<FleetReadinessResponse> {
  const db = DatabaseService.getInstance();
  const all = db.getNodes();
  const nodeIds = request.nodeIds;
  const selected = nodeIds === null ? all : all.filter((node) => nodeIds.includes(node.id));

  const rows = await mapWithConcurrency(selected, FANOUT_CONCURRENCY, async (node) => {
    try {
      return await buildNodeRow(node, request);
    } catch (error) {
      // Not expected to fire: every read of a node in the row above degrades
      // rather than throws. The hub-side reads in it are the exception, because
      // the last-contact stamp and the newest-snapshot lookup are plain database
      // calls and can fail like any other statement. Kept so an unexpected throw
      // costs one node instead of the fleet, which is the property the pool's
      // reject-on-first-error would otherwise take away.
      console.error(
        `Readiness aggregate: node ${sanitizeForLog(node.name)} failed:`,
        errorMessageForLog(error),
      );
      return emptyNodeRow(node, request.domains);
    }
  });

  const nodes = rows.map((row) => row.node);
  const findings = rows.flatMap((row) => row.findings);
  // Both halves are required: the admin check decides whether the hub may
  // publish Control at all, and the filter decides whether this caller asked for
  // it. Merging on the admin check alone would put a `control` cell in every row
  // of a response whose `domains` (and `domainsOmitted`) say the domain was
  // filtered out, and `summary.nodes` would then count a state the caller did
  // not ask for.
  if (request.includeControl && request.domains.includes('control')) {
    // The one hub-side read that lands after the fan-out, so an unguarded throw
    // here would escape the fleet row entirely and turn a partial answer into no
    // answer, which is the trade the per-node catch above exists to avoid. The
    // null is what tells the Control classifier the read failed rather than that
    // the fleet has no sync rows.
    let statuses: readonly FleetSyncStatus[] | null = null;
    try {
      statuses = db.getFleetSyncStatuses();
    } catch (error) {
      console.error(
        'Readiness aggregate: could not read the Control rows:',
        errorMessageForLog(error),
      );
    }
    findings.push(...mergeControlCells(nodes, statuses));
  }

  const summaryNodes = emptyStateCounts();
  for (const node of nodes) summaryNodes[worstNodeState(node.cells)] += 1;
  const summaryFindings = emptySeverityCounts();
  for (const finding of findings) summaryFindings[finding.severity] += 1;

  const domains = READINESS_DOMAINS.filter((domain) => request.domains.includes(domain)
    && (domain !== 'control' || request.includeControl));

  return {
    generatedAt: Date.now(),
    domains,
    domainsOmitted: request.domains.filter((domain) => !domains.includes(domain)),
    summary: { nodes: summaryNodes, findings: summaryFindings },
    findings: sortFindings(findings),
    nodes,
  };
}

/**
 * Attach the Control domain to every node row, returning the findings it added.
 *
 * Control is the one domain that does not come from the fan-out: it is classified
 * from the hub's own sync rows, after every node row exists, which is what lets
 * the caller's admin check decide whether it is classified at all.
 */
function mergeControlCells(
  nodes: readonly FleetReadinessNode[],
  // Null when the hub could not read its own rows, which `controlResult` files
  // as an unreadable Control domain rather than as a fleet with no sync history.
  statuses: readonly FleetSyncStatus[] | null,
): ReadinessFinding[] {
  const findings: ReadinessFinding[] = [];
  for (const node of nodes) {
    const result = controlResult(
      node.id,
      statuses === null ? null : statuses.filter((status) => status.node_id === node.id),
    );
    node.cells.control = result.cell;
    findings.push(...result.findings);
  }
  return findings;
}

/**
 * Which transport the hub would use to reach `node` right now, from a proxy
 * target it has already resolved.
 *
 * Shared with the fallback row so a node's transport cannot mean one thing in a
 * row that was read and another in a row that was not.
 */
function transportOf(node: Node, target: ProxyTarget | null): NodeTransport {
  if (node.type === 'local') return 'local';
  if (target === null) return 'unreachable';
  return target.trustedLoopback ? 'pilot' : 'proxy';
}

/**
 * The proxy target for a node whose own build threw, or null when there is none.
 *
 * Guarded because this is a database read running inside the fan-out's error
 * path: the row exists because something threw, and a second throw here would
 * leave the worker and take the fleet with it, which is the one property that
 * catch is there to hold. Null on failure, so the transport collapses into the
 * value that claims no route rather than into a route that was never resolved.
 */
function fallbackTarget(node: Node): ProxyTarget | null {
  if (node.type === 'local') return null;
  try {
    return NodeRegistry.getInstance().getProxyTarget(node.id);
  } catch (error) {
    // This is the hub's own read failing, not a remote declining to answer, so it
    // is filed the way the in-process failures further down are.
    console.error(
      `Readiness aggregate: could not resolve the transport for node ${sanitizeForLog(node.name)}:`,
      errorMessageForLog(error),
    );
    return null;
  }
}

/**
 * The row a node gets when its own build threw. Nothing is claimed about it
 * beyond the fact that it could not be read.
 *
 * Every published domain gets a cell, not just Connectivity: the contract is
 * that a node's cells are the domains this response carries, so a row missing a
 * column the caller asked for would render as a gap rather than as the
 * `unavailable` it is. Control is skipped because the caller writes it after the
 * fan-out, and only when the caller is an admin who asked for that domain.
 */
function emptyNodeRow(node: Node, domains: readonly ReadinessDomainKey[]): NodeRowResult {
  const target: ReadinessTarget = { surface: 'node-details', nodeId: node.id };
  // The transport is a property of the node and the hub rather than of the read,
  // so it is resolved here the way a built row resolves it. Reporting
  // `unreachable` for a node with a live proxy target would contradict this
  // row's own reachability record, and it would collapse "no route exists" into
  // "the row could not be built", which are two different things to go and fix.
  //
  // That resolve is guarded, so it can also come back empty-handed on the one
  // path where this row exists because something else already threw. The
  // transport is then the pessimistic `unreachable`, which claims no route
  // rather than naming one the guard could not verify, and the guard logs it so
  // the pessimism is not silent.
  const transport = transportOf(node, fallbackTarget(node));
  // The same classifier a built row uses, so this row cannot describe a node's
  // contact any differently than one that was read. No probe ran here, which is
  // why both probe fields are empty.
  //
  // This reads the node snapshot the fan-out took before its reads, so a stamp
  // this request updated is not reflected here. That is left alone deliberately:
  // re-reading the row is a second database read on the one path that exists to
  // survive a thrown one, and an error row describing the moment before the
  // failure is the more useful record of the two.
  const contact = contactInfo(node);
  const cells: Partial<Record<ReadinessDomainKey, NodeDomainCell>> = {};
  const findings: ReadinessFinding[] = [];
  for (const domain of domains) {
    if (domain === 'control') continue;
    const result = domainResult(node.id, domain, [domainErrorConcern(target)], { evidenceAgeMs: null, source: 'stored' });
    cells[domain] = result.cell;
    findings.push(...result.findings);
  }
  return {
    node: {
      id: node.id,
      name: node.name,
      type: node.type,
      mode: node.mode,
      transport,
      reachability: {
        status: node.status,
        contactAt: contact.contactAt,
        contactSource: contact.contactSource,
        note: contact.reachabilityNote,
        probedLive: false,
        latencyMs: null,
      },
      cells,
      stackCount: null,
    },
    findings,
  };
}
