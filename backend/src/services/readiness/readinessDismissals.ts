import { DatabaseService } from '../DatabaseService';
import { FindingDismissalStore } from '../findingDismissals/FindingDismissalStore';
import { toFindingDismissal, type FindingDismissal, type FindingDismissalRow } from '../findingDismissals/types';
import { errorMessageForLog } from '../../utils/safeLog';
import {
  FINDING_SEVERITIES,
  READINESS_DOMAINS,
  type DismissPolicy,
  type FleetReadinessNode,
  type ReadinessDomainKey,
  type ReadinessFinding,
  type ReadinessReasonCode,
} from './types';

interface CodeDismissal {
  /**
   * What a team may do with a finding of this code. `none`: it restates another
   * surface's verdict and is resolved there. `timed`: it says the evidence could
   * not be read, so only a dismissal for a set time is allowed; "until it changes"
   * would never lift while the evidence stays unreadable, which is a permanent
   * dismissal by another name. `any`: every mode.
   */
  policy: DismissPolicy;
  /**
   * True when the code means a read was partial or missing. While one is present
   * for a node, another finding's absence proves nothing, so no dismissal is retired.
   */
  incompleteRead: boolean;
}

/**
 * Exhaustive over the code union on purpose: adding a reason code fails the
 * build until someone decides how it may be dismissed, instead of defaulting to
 * the permissive answer.
 */
const CODE_DISMISSAL: Record<ReadinessReasonCode, CodeDismissal> = {
  node_unreachable: { policy: 'timed', incompleteRead: true },
  pilot_disconnected: { policy: 'timed', incompleteRead: true },
  contact_stale: { policy: 'any', incompleteRead: false },
  probe_timeout: { policy: 'timed', incompleteRead: true },

  workloads_exited: { policy: 'any', incompleteRead: false },
  workloads_partial: { policy: 'any', incompleteRead: false },
  workloads_unknown: { policy: 'timed', incompleteRead: true },
  status_evidence_degraded: { policy: 'timed', incompleteRead: true },
  status_evidence_stale: { policy: 'timed', incompleteRead: true },

  update_blocked: { policy: 'any', incompleteRead: false },
  update_review_required: { policy: 'any', incompleteRead: false },
  update_ready_with_warnings: { policy: 'any', incompleteRead: false },

  rollback_not_ready: { policy: 'any', incompleteRead: false },
  rollback_partial: { policy: 'any', incompleteRead: false },
  snapshot_failed: { policy: 'any', incompleteRead: false },

  stacks_unknown: { policy: 'timed', incompleteRead: true },
  summary_truncated: { policy: 'timed', incompleteRead: true },
  summary_stale: { policy: 'timed', incompleteRead: true },

  // Security owns the posture word, so Readiness cannot dismiss what restates it.
  posture_partial: { policy: 'none', incompleteRead: false },
  posture_action_needed: { policy: 'none', incompleteRead: false },
  scanner_unavailable: { policy: 'any', incompleteRead: false },
  scans_stale: { policy: 'any', incompleteRead: false },
  scans_never_completed: { policy: 'timed', incompleteRead: true },

  control_paused: { policy: 'any', incompleteRead: false },
  control_degraded: { policy: 'any', incompleteRead: false },
  control_unknown: { policy: 'timed', incompleteRead: true },

  capability_absent: { policy: 'timed', incompleteRead: true },
  domain_error: { policy: 'timed', incompleteRead: true },
};

/** A finding is "unverified" when its state says the evidence is missing rather than bad. */
const UNVERIFIED_SEVERITIES: ReadonlySet<string> = new Set(['unavailable', 'unknown']);

export function dismissPolicyFor(finding: Pick<ReadinessFinding, 'code' | 'severity'>): DismissPolicy {
  const entry = CODE_DISMISSAL[finding.code];
  // A code a newer peer sent that this build does not know is not dismissable.
  if (entry === undefined) return 'none';
  if (entry.policy === 'any' && UNVERIFIED_SEVERITIES.has(finding.severity)) return 'timed';
  return entry.policy;
}

export interface ParsedReadinessKey {
  domain: ReadinessDomainKey;
  nodeId: number;
  stack: string | null;
}

/**
 * The scope a readiness finding id names: `domain:nodeId[:stack]:code`. Stack
 * names cannot contain `:`, so the shape is unambiguous. Returns null for
 * anything else, and the caller refuses it.
 */
export function parseReadinessKey(key: string): ParsedReadinessKey | null {
  const parts = key.split(':');
  if (parts.length !== 3 && parts.length !== 4) return null;
  const [domain, nodeText, ...rest] = parts;
  if (!(READINESS_DOMAINS as readonly string[]).includes(domain)) return null;
  if (!/^[1-9]\d{0,9}$/.test(nodeText)) return null;
  const stack = rest.length === 2 ? rest[0] : null;
  return { domain: domain as ReadinessDomainKey, nodeId: Number(nodeText), stack };
}

function becameMoreSevere(stored: string, current: string): boolean {
  if (stored === current) return false;
  const storedRank = FINDING_SEVERITIES.indexOf(stored as ReadinessFinding['severity']);
  const currentRank = FINDING_SEVERITIES.indexOf(current as ReadinessFinding['severity']);
  // A word this build does not know is not provably the same, so it lifts.
  if (storedRank < 0 || currentRank < 0) return true;
  if (currentRank < storedRank) return true;
  return UNVERIFIED_SEVERITIES.has(current) && !UNVERIFIED_SEVERITIES.has(stored);
}

/**
 * Whether a dismissal still covers the finding as it reads now. The client
 * applies the same rule (`frontend/src/lib/findingDismissals.ts`) so a dismissal
 * takes effect the moment it is made; the hub applies it here so a row that
 * stopped covering a finding is retired rather than left to hide the finding
 * again if it drifts back to the state that was dismissed.
 */
export function dismissalCovers(
  finding: Pick<ReadinessFinding, 'severity' | 'count' | 'fingerprint' | 'dismissPolicy'>,
  row: Pick<FindingDismissalRow, 'severity' | 'count_at' | 'fingerprint' | 'mode' | 'expires_at'>,
  now: number,
): boolean {
  if (finding.dismissPolicy === 'none') return false;
  if (finding.dismissPolicy === 'timed' && row.mode !== 'days') return false;
  if (becameMoreSevere(row.severity, finding.severity)) return false;
  if (finding.count > row.count_at) return false;
  switch (row.mode) {
    case 'until_change':
      return finding.fingerprint === row.fingerprint;
    case 'days':
      return row.expires_at !== null && row.expires_at > now;
    case 'forever':
      return true;
    default:
      return false;
  }
}

/**
 * Whether the response proves a finding is gone, as opposed to merely not
 * listed. True only when its domain's cell for that node was read live, was
 * evaluated (not unknown or unavailable), and none of the node's findings in
 * the domain or on Connectivity say the read was partial. Control is the hub's
 * own rows, so a healthy cell is enough there. Anything less keeps the
 * dismissal: an outage or a truncated read must never retire it.
 */
export function isFindingProvenGone(
  row: Pick<FindingDismissalRow, 'finding_key'>,
  nodes: readonly Omit<FleetReadinessNode, 'state'>[],
  findingIds: ReadonlySet<string>,
  findings: readonly ReadinessFinding[],
): boolean {
  if (findingIds.has(row.finding_key)) return false;
  const key = parseReadinessKey(row.finding_key);
  if (key === null) return false;
  const cell = nodes.find((node) => node.id === key.nodeId)?.cells[key.domain];
  if (cell === undefined) return false;
  if (key.domain === 'control') return cell.state === 'healthy';
  if (cell.source !== 'live' || cell.state === 'unknown' || cell.state === 'unavailable') return false;
  return !findings.some((finding) => finding.nodeId === key.nodeId
    && (finding.domain === key.domain || finding.domain === 'connectivity')
    && CODE_DISMISSAL[finding.code]?.incompleteRead === true);
}

interface AttachInput {
  nodes: readonly Omit<FleetReadinessNode, 'state'>[];
  findings: readonly ReadinessFinding[];
  domains: readonly ReadinessDomainKey[];
  now: number;
  /**
   * When this evaluation began. A dismissal made after it was judged against
   * evidence that did not yet show its finding, so it is published as is and
   * never retired by this pass.
   */
  startedAt: number;
}

/**
 * The dismissals to publish with a readiness response, after retiring the ones
 * the evidence shows are obsolete: expired, no longer covering a finding that
 * changed, or covering a finding a complete read proves gone.
 *
 * Retirement runs here, on the hub, because only the hub sees the complete
 * evaluation. A row for a node outside this response, or a domain it did not
 * carry, is left alone: this request cannot speak for it. A row whose key cannot
 * be read, or whose node is gone, is removed whatever the request carried.
 */
export function attachReadinessDismissals({ nodes, findings, domains, now, startedAt }: AttachInput): FindingDismissal[] {
  const store = FindingDismissalStore.getInstance();
  const nodeIds = new Set(nodes.map((node) => node.id));
  const knownNodes = new Set(DatabaseService.getInstance().getNodes().map((node) => node.id));
  const byId = new Map(findings.map((finding) => [finding.id, finding]));
  const findingIds = new Set(byId.keys());
  const retire: number[] = [];
  const published: FindingDismissal[] = [];

  for (const row of store.list('readiness')) {
    const key = parseReadinessKey(row.finding_key);
    if (key === null || !knownNodes.has(row.node_id)) {
      retire.push(row.id);
      continue;
    }
    if (!nodeIds.has(row.node_id) || !domains.includes(key.domain)) continue;
    const settled = row.created_at < startedAt;
    const finding = byId.get(row.finding_key);
    const lapsed = row.mode === 'days' && row.expires_at !== null && row.expires_at <= now;
    const lifted = finding !== undefined && !dismissalCovers(finding, row, now);
    const gone = finding === undefined && isFindingProvenGone(row, nodes, findingIds, findings);
    if (settled && (lapsed || lifted || gone)) {
      retire.push(row.id);
      continue;
    }
    published.push(toFindingDismissal(row));
  }
  if (retire.length > 0) {
    try {
      store.deleteMany(retire);
    } catch (error) {
      // Rows queued for retirement were already left out of `published`, so the
      // response is correct without the cleanup, and the next pass retries it.
      console.error('[Readiness] Could not retire obsolete dismissals:', errorMessageForLog(error));
    }
  }
  return published;
}
