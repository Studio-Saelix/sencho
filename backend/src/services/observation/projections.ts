import type { Node } from '../DatabaseService';
import type { BulkStackInfo } from '../DockerController';
import type { StackContainerFact } from '../health/stackHealthFacts';
import {
  DOMAIN_STATE_ORDER,
  FINDING_SEVERITIES,
  READINESS_DOMAINS,
  type DomainState,
  type FindingSeverity,
  type FleetReadinessResponse,
  type NodeDomainCell,
  type NodeTransport,
  type ReadinessDomainKey,
  type ReadinessReasonCode,
  type StackReadinessRow,
} from '../readiness/types';
import type { ReadinessVerdict, RollbackOverall } from '../updateGuard/types';
import { isValidStackName } from '../../utils/validation';

/**
 * The projection contract shared by every observation route and by the
 * `sencho-mcp` adapter that reads them.
 *
 * One rule holds for the whole module: every outgoing object is built field by
 * field from an allowlist, never spread from a source object. A new field on a
 * canonical evidence type therefore cannot leak through an observation response
 * by inheritance; it has to be named here, which is the review the contract
 * exists to force.
 *
 * The other rule is that nothing here computes: the projections select and
 * bound evidence that canonical engines already produced.
 */

/** Bumped when a projection's shape changes in a way a client must notice. */
export const OBSERVATION_SCHEMA_VERSION = 1;

export interface ObservationEnvelope<T> {
  schemaVersion: typeof OBSERVATION_SCHEMA_VERSION;
  /** Epoch ms the evidence behind `data` was produced, not when it was serialized. */
  generatedAt: number;
  data: T;
}

export function observationEnvelope<T>(generatedAt: number, data: T): ObservationEnvelope<T> {
  return { schemaVersion: OBSERVATION_SCHEMA_VERSION, generatedAt, data };
}

/** Node names are operator-authored; the projection truncates rather than trusting a bound. */
export const NODE_NAME_MAX_LENGTH = 128;
/** Response bound on one stack's containers. */
export const CONTAINER_LIMIT = 100;
/** Response bound on fleet findings, worst first. */
export const FINDINGS_LIMIT = 50;
/** Stack list page size. */
export const STACK_PAGE_DEFAULT = 100;
export const STACK_PAGE_MAX = 200;

function bounded(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export type ObservedNodeTransport = 'local' | 'proxy' | 'pilot';

export interface ObservedNode {
  id: number;
  name: string;
  type: 'local' | 'remote';
  transport: ObservedNodeTransport;
  status: 'online' | 'offline' | 'unknown';
  /** Epoch ms of the last contact this hub can vouch for, or null. */
  lastContactAt: number | null;
  cordoned: boolean;
}

/**
 * The node's last contact in epoch ms. The two sources keep different units:
 * `pilot_last_seen` is stamped in ms and `last_successful_contact` in whole
 * seconds (`updateNodeLastContact`), so the proxy value is scaled here and the
 * published field has one unit for every transport.
 */
function lastContactAtMs(node: Node): number | null {
  if (node.mode === 'pilot_agent') return node.pilot_last_seen ?? null;
  return node.last_successful_contact == null ? null : node.last_successful_contact * 1000;
}

/**
 * A node as an AI client may see it.
 *
 * Deliberately absent: `compose_dir`, `api_url`, `api_token`, the sealing
 * fingerprint, `cordoned_reason` (operator free text), `created_at`,
 * `pilot_agent_version`. Version and capability support are answered by the
 * hub's capability gate instead of a per-node field, because a headless caller
 * has no warm meta cache to read them from.
 */
export function projectNode(node: Node): ObservedNode {
  const transport: ObservedNodeTransport = node.mode === 'pilot_agent'
    ? 'pilot'
    : node.type === 'remote' ? 'proxy' : 'local';
  return {
    id: node.id,
    name: bounded(node.name, NODE_NAME_MAX_LENGTH),
    type: node.type === 'remote' ? 'remote' : 'local',
    transport,
    status: node.status,
    lastContactAt: lastContactAtMs(node),
    cordoned: node.cordoned === true,
  };
}

// ---------------------------------------------------------------------------
// Stack list
// ---------------------------------------------------------------------------

export type ObservedStackStatus = BulkStackInfo['status'];

export interface ObservedStackSummary {
  name: string;
  status: ObservedStackStatus;
  running: number | null;
  total: number | null;
  source: 'local' | 'git';
  isSelf: boolean;
}

export interface ObservedStackList {
  degraded: boolean;
  total: number;
  nextCursor: string | null;
  stacks: ObservedStackSummary[];
}

/** One stack as the status evidence read it, before projection. */
export interface StackStatusEntry {
  name: string;
  info: BulkStackInfo;
  source: 'local' | 'git';
  isSelf: boolean;
}

/**
 * One page of the stack list.
 *
 * The cursor is the last returned stack name and the page is the alphabetical
 * strict-greater slice, so a stack deleted between two pages does not shift the
 * rest of the list. Bounds: `limit` is 1..{@link STACK_PAGE_MAX}; the caller
 * validates it before reaching here.
 *
 * A name is published exactly as stored, never cut: the client feeds it back as
 * the cursor and as the `:stackName` of the per-stack routes, and both accept
 * only `isValidStackName` names. A directory whose name fails that check cannot
 * be addressed by any of those routes, so it is left out of the list and out of
 * `total` rather than listed under a name the client cannot use.
 */
export function projectStackList(
  entries: readonly StackStatusEntry[],
  cursor: string | null,
  limit: number,
  degraded: boolean,
): ObservedStackList {
  const sorted = entries
    .filter((entry) => isValidStackName(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const start = cursor === null
    ? 0
    : (() => {
        const index = sorted.findIndex((entry) => entry.name.localeCompare(cursor) > 0);
        return index < 0 ? sorted.length : index;
      })();
  const page = sorted.slice(start, start + limit);
  const nextCursor = start + page.length < sorted.length && page.length > 0
    ? page[page.length - 1].name
    : null;
  return {
    degraded,
    total: sorted.length,
    nextCursor,
    stacks: page.map((entry): ObservedStackSummary => ({
      name: entry.name,
      status: entry.info.status,
      running: typeof entry.info.running === 'number' ? entry.info.running : null,
      total: typeof entry.info.total === 'number' ? entry.info.total : null,
      source: entry.source,
      isSelf: entry.isSelf === true,
    })),
  };
}

// ---------------------------------------------------------------------------
// Stack status
// ---------------------------------------------------------------------------

export type ObservedContainerState =
  | 'created'
  | 'running'
  | 'paused'
  | 'restarting'
  | 'removing'
  | 'exited'
  | 'dead'
  | 'other';

export type ObservedContainerHealth = 'healthy' | 'unhealthy' | 'starting' | 'none';

export interface ObservedContainer {
  name: string;
  service: string | null;
  state: ObservedContainerState;
  health: ObservedContainerHealth | null;
  restartCount: number;
  exitCode: number | null;
  startedAt: string | null;
}

export interface ObservedStackStatusData {
  stack: string;
  /**
   * `unavailable` means the node could not read its own containers. It is a
   * 200 with no container list, not a 5xx: the request succeeded and the answer
   * is that the evidence is missing right now.
   */
  outcome: 'ok' | 'unavailable';
  containers: ObservedContainer[];
  truncated: boolean;
}

/**
 * Docker states this projection publishes. Anything else is `other` rather than
 * dropped, so a container is never silently missing from the list.
 */
const CONTAINER_STATE_MAP: Record<string, ObservedContainerState> = {
  created: 'created',
  running: 'running',
  paused: 'paused',
  restarting: 'restarting',
  removing: 'removing',
  exited: 'exited',
  dead: 'dead',
};

const CONTAINER_HEALTH_MAP: Record<string, ObservedContainerHealth> = {
  healthy: 'healthy',
  unhealthy: 'unhealthy',
  starting: 'starting',
  none: 'none',
};

function projectContainer(fact: StackContainerFact): ObservedContainer {
  return {
    name: fact.name,
    service: fact.service,
    state: CONTAINER_STATE_MAP[fact.state] ?? 'other',
    health: fact.health === null ? null : (CONTAINER_HEALTH_MAP[fact.health] ?? 'none'),
    restartCount: fact.restartCount,
    exitCode: fact.exitCode,
    startedAt: fact.startedAt,
  };
}

/** 0 = needs attention, 1 = still starting, 2 = running and not unhealthy. */
function attentionRank(container: ObservedContainer): number {
  if (container.state !== 'running' || container.health === 'unhealthy') return 0;
  return container.health === 'starting' ? 1 : 2;
}

/**
 * The container list, ordered so the {@link CONTAINER_LIMIT} cap keeps the
 * containers that explain an incident: anything not running or unhealthy first,
 * then those still starting, then the healthy ones, each group by name. Docker's
 * own order is arbitrary, so without this a cap could cut the one exited
 * container the caller asked about the stack to find.
 */
export function projectStackStatus(
  stack: string,
  facts: readonly StackContainerFact[],
): ObservedStackStatusData {
  const ordered = facts
    .map(projectContainer)
    .sort((a, b) => attentionRank(a) - attentionRank(b) || compareCodePoints(a.name, b.name));
  return {
    stack,
    outcome: 'ok',
    containers: ordered.slice(0, CONTAINER_LIMIT),
    truncated: ordered.length > CONTAINER_LIMIT,
  };
}

function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function projectUnavailableStackStatus(stack: string): ObservedStackStatusData {
  return {
    stack,
    outcome: 'unavailable',
    containers: [],
    truncated: false,
  };
}

// ---------------------------------------------------------------------------
// Stack readiness
// ---------------------------------------------------------------------------

export interface ObservedStackReadinessData {
  stack: string;
  update: {
    verdict: ReadinessVerdict;
    topReasonId: string | null;
    hasUpdate: boolean;
    computedAt: number;
  } | null;
  rollback: {
    overall: RollbackOverall;
    topReasonId: string | null;
    computedAt: number;
  } | null;
  /** Set only when both slots are null. */
  unavailableReason: 'summary_truncated' | 'domain_error' | null;
}

/**
 * Project one served readiness row.
 *
 * `topReason` (free-text prose) is dropped and only its id survives, so the
 * client picks its own words. `unavailableReason` is narrowed to the two codes
 * the per-stack compute can produce.
 */
export function projectStackReadiness(row: StackReadinessRow): ObservedStackReadinessData {
  const unavailableReason = row.unavailableReason === 'summary_truncated'
    || row.unavailableReason === 'domain_error'
    ? row.unavailableReason
    : null;
  return {
    stack: row.stack,
    update: row.update === null
      ? null
      : {
          verdict: row.update.verdict,
          topReasonId: row.update.topReasonId ?? null,
          hasUpdate: row.update.hasUpdate === true,
          computedAt: row.update.computedAt,
        },
    rollback: row.rollback === null
      ? null
      : {
          overall: row.rollback.overall,
          topReasonId: row.rollback.topReasonId ?? null,
          computedAt: row.rollback.computedAt,
        },
    unavailableReason,
  };
}

// ---------------------------------------------------------------------------
// Fleet health
// ---------------------------------------------------------------------------

export interface ObservedFleetCell {
  state: DomainState;
  reasonCode: ReadinessReasonCode | null;
  evidenceAgeMs: number | null;
  source: 'live' | 'stored';
}

export interface ObservedFleetNode {
  id: number;
  name: string;
  transport: NodeTransport;
  state: DomainState;
  reachability: {
    status: 'online' | 'offline' | 'unknown';
    contactAt: number | null;
    probedLive: boolean;
    latencyMs: number | null;
  };
  cells: Partial<Record<ReadinessDomainKey, ObservedFleetCell>>;
  stackCount: number | null;
}

export interface ObservedFleetFinding {
  id: string;
  domain: ReadinessDomainKey;
  nodeId: number;
  stack: string | null;
  code: ReadinessReasonCode;
  severity: FindingSeverity;
  count: number;
}

export interface ObservedFleetHealthData {
  /** True when the cache served an expired entry after a failed refresh. */
  stale: boolean;
  domains: ReadinessDomainKey[];
  domainsOmitted: ReadinessDomainKey[];
  summary: {
    nodes: Record<DomainState, number>;
    findings: Record<FindingSeverity, number>;
  };
  nodes: ObservedFleetNode[];
  findings: ObservedFleetFinding[];
  findingsTruncated: boolean;
}

function projectCell(cell: NodeDomainCell): ObservedFleetCell {
  return {
    state: cell.state,
    reasonCode: cell.reasonCode,
    evidenceAgeMs: cell.evidenceAgeMs,
    source: cell.source,
  };
}

/**
 * Project the canonical fleet aggregate, withholding everything a read did not
 * need to disclose: finding prose (`detail`), fingerprints, dismissal policy,
 * the verdict objects, `reachability.note`, and the dismissals themselves.
 *
 * `control` is absent by construction (`includeControl: false`), and the caller
 * is told so through `domainsOmitted` rather than by a silently missing column.
 */
export function projectFleetHealth(
  response: FleetReadinessResponse,
  stale: boolean,
): ObservedFleetHealthData {
  const findings = response.findings.slice(0, FINDINGS_LIMIT).map((finding): ObservedFleetFinding => ({
    id: finding.id,
    domain: finding.domain,
    nodeId: finding.nodeId,
    stack: finding.stack,
    code: finding.code,
    severity: finding.severity,
    count: finding.count,
  }));

  const nodes = response.nodes.map((node): ObservedFleetNode => {
    const cells: Partial<Record<ReadinessDomainKey, ObservedFleetCell>> = {};
    for (const domain of READINESS_DOMAINS) {
      const cell = node.cells[domain];
      if (!cell) continue;
      cells[domain] = projectCell(cell);
    }
    return {
      id: node.id,
      name: bounded(node.name, NODE_NAME_MAX_LENGTH),
      transport: node.transport,
      state: node.state,
      reachability: {
        status: node.reachability.status,
        contactAt: node.reachability.contactAt,
        probedLive: node.reachability.probedLive,
        latencyMs: node.reachability.latencyMs,
      },
      cells,
      stackCount: node.stackCount,
    };
  });

  return {
    stale,
    domains: [...response.domains],
    domainsOmitted: [...response.domainsOmitted],
    summary: {
      nodes: countStates(response.summary.nodes),
      findings: countFindings(response.summary.findings),
    },
    nodes,
    findings,
    findingsTruncated: response.findings.length > FINDINGS_LIMIT,
  };
}

/** Rebuild the state tally field by field, so a new canonical key cannot ride along. */
function countStates(source: Record<DomainState, number>): Record<DomainState, number> {
  const counts = {} as Record<DomainState, number>;
  for (const state of DOMAIN_STATE_ORDER) counts[state] = source[state] ?? 0;
  return counts;
}

function countFindings(source: Record<FindingSeverity, number>): Record<FindingSeverity, number> {
  const counts = {} as Record<FindingSeverity, number>;
  for (const severity of FINDING_SEVERITIES) counts[severity] = source[severity] ?? 0;
  return counts;
}
