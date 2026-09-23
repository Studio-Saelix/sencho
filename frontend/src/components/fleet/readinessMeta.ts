import {
  Boxes, CircleHelp, Download, RefreshCw,
  Shield, Undo2, Wifi,
  type LucideIcon,
} from 'lucide-react';
import type {
  DomainState,
  FleetReadinessNode,
  NodeDomainCell,
  ReadinessDomainKey,
  ReadinessFinding,
  ReadinessReasonCode,
  ReadinessTarget,
} from '@/types/readiness';

/**
 * Presentation tables for the readiness surface: domain labels and icons, state
 * tones, cell values, and the one place a reason code becomes words.
 *
 * Nothing here computes a state: the hub decides every state and every reason
 * code, and this module only gives each one its words. Every lookup a payload
 * feeds goes through an accessor with a fallback, so a word a newer hub
 * introduced renders as a legible value rather than a crash or a blank cell.
 */

export type ReadinessTone = 'success' | 'warning' | 'destructive' | 'neutral';

const DOMAIN_META: Record<ReadinessDomainKey, { label: string; icon: LucideIcon }> = {
  connectivity: { label: 'Connectivity', icon: Wifi },
  workloads: { label: 'Workloads', icon: Boxes },
  updates: { label: 'Updates', icon: Download },
  recovery: { label: 'Recovery', icon: Undo2 },
  security: { label: 'Security', icon: Shield },
  control: { label: 'Policy sync', icon: RefreshCw },
};

/** A domain's column header, keeping a newer hub's own word for one this build does not know. */
export function domainMeta(domain: ReadinessDomainKey): { label: string; icon: LucideIcon } {
  return DOMAIN_META[domain] ?? { label: domain, icon: CircleHelp };
}

/**
 * How each state reads. `unknown` and `unavailable` are named for what they mean
 * to an operator: evidence that exists but could not be confirmed, and a check
 * that did not run at all.
 */
const STATE_META: Record<DomainState, { label: string; tone: ReadinessTone }> = {
  attention: { label: 'needs attention', tone: 'destructive' },
  degraded: { label: 'degraded', tone: 'warning' },
  unavailable: { label: 'not checked', tone: 'neutral' },
  unknown: { label: 'unverified', tone: 'neutral' },
  healthy: { label: 'healthy', tone: 'success' },
};

/** A state's words and tone. An unrecognized state is not a quiet one, so it reads as unverified. */
export function stateMeta(state: DomainState): { label: string; tone: ReadinessTone } {
  return STATE_META[state] ?? STATE_META.unknown;
}

export const TONE_CHIP: Record<ReadinessTone, string> = {
  success: 'border-success/40 bg-success/[0.06] text-success',
  warning: 'border-warning/40 bg-warning/[0.06] text-warning',
  destructive: 'border-destructive/40 bg-destructive/[0.06] text-destructive',
  neutral: 'border-card-border bg-card/40 text-stat-subtitle',
};

export const TONE_DOT: Record<ReadinessTone, string> = {
  success: 'bg-success',
  warning: 'bg-warning shadow-[0_0_6px_0_var(--warning)]',
  destructive: 'bg-destructive shadow-[0_0_6px_0_var(--destructive)]',
  neutral: 'bg-stat-icon',
};

export const TONE_TEXT: Record<ReadinessTone, string> = {
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
  neutral: 'text-stat-subtitle',
};

/** Whole-row tint for a row that crossed into a problem state (design system row tinting). */
export const TONE_ROW: Record<ReadinessTone, string> = {
  success: '',
  warning: 'bg-warning/[0.04]',
  destructive: 'bg-destructive/[0.04]',
  neutral: '',
};

/**
 * The short value a problem cell shows. `{n}` is how many items sit behind the
 * code on that node (stacks, scans), summed from the findings the cell carries.
 */
const CELL_VALUE: Record<ReadinessReasonCode, string> = {
  node_unreachable: 'offline',
  pilot_disconnected: 'pilot offline',
  contact_stale: 'contact stale',
  probe_timeout: 'timed out',

  workloads_exited: '{n} exited',
  workloads_partial: '{n} partly down',
  workloads_unknown: 'unrecognized',
  status_evidence_degraded: 'incomplete read',
  status_evidence_stale: 'stale read',

  update_blocked: '{n} blocked',
  update_review_required: '{n} to review',
  update_ready_with_warnings: '{n} with warnings',

  rollback_not_ready: '{n} not ready',
  rollback_partial: '{n} partial',
  snapshot_failed: 'snapshot skipped',

  stacks_unknown: 'undetermined',
  summary_truncated: 'partly checked',
  summary_stale: 'stale check',

  posture_partial: 'partial scan',
  posture_action_needed: 'action needed',
  scanner_unavailable: 'no scanner',
  scans_stale: '{n} stale scans',
  scans_never_completed: 'never scanned',

  control_paused: 'paused',
  control_degraded: 'sync failing',
  control_unknown: 'never synced',

  capability_absent: 'not supported',
  domain_error: 'check failed',
};

/** The value a healthy cell shows: what "fine" means in that domain's own words. */
function healthyValue(domain: ReadinessDomainKey, cell: NodeDomainCell, node: FleetReadinessNode): string {
  switch (domain) {
    case 'connectivity':
      return node.transport === 'local' ? 'local' : 'online';
    case 'workloads': {
      const running = cell.counts.running ?? 0;
      if (running > 0) return `${running} running`;
      return (cell.counts.unknown ?? 0) > 0 ? 'not deployed' : 'no stacks';
    }
    case 'updates':
      return 'ready';
    case 'recovery':
      return 'covered';
    case 'security':
      return 'clear';
    case 'control':
      return 'in sync';
    default:
      return 'healthy';
  }
}

/**
 * The value a cell shows in the node matrix.
 *
 * A problem cell names its reason in the domain's own words, with the number of
 * items behind it where the reason counts something ("2 blocked"). A code this
 * build does not know falls back to the state's own word.
 */
export function cellValue(
  domain: ReadinessDomainKey,
  cell: NodeDomainCell,
  node: FleetReadinessNode,
  findings: readonly ReadinessFinding[],
): string {
  if (cell.state === 'healthy') return healthyValue(domain, cell, node);
  const template = CELL_VALUE[cell.reasonCode];
  if (template === undefined) return stateMeta(cell.state).label;
  if (!template.includes('{n}')) return template;
  const count = findings
    .filter(finding => finding.nodeId === node.id && finding.domain === domain && finding.code === cell.reasonCode)
    .reduce((total, finding) => total + finding.count, 0);
  return count > 0 ? template.replace('{n}', String(count)) : template.replace('{n} ', '');
}

/**
 * What each reason code says as a finding title. Sentences, not fragments: a
 * finding row is the only place the operator reads why a cell is not healthy.
 */
const CODE_COPY: Record<ReadinessReasonCode, string> = {
  node_unreachable: 'Node did not answer',
  pilot_disconnected: 'Pilot tunnel is down',
  contact_stale: 'No recent contact from this node',
  probe_timeout: 'Node did not answer in time',

  workloads_exited: 'Stack is stopped',
  workloads_partial: 'Stack is partly down',
  workloads_unknown: 'Stack reported a status this version does not recognize',
  status_evidence_degraded: 'Stack listing is incomplete',
  status_evidence_stale: 'Stack state is older than its refresh window',

  update_blocked: 'Update is blocked',
  update_review_required: 'Update needs review first',
  update_ready_with_warnings: 'Update carries warnings',

  rollback_not_ready: 'Rollback is not ready',
  rollback_partial: 'Rollback is only partly ready',
  snapshot_failed: 'The latest fleet snapshot skipped this node',

  stacks_unknown: 'Stack readiness could not be determined',
  summary_truncated: 'Stack readiness stopped before every stack was checked',
  summary_stale: 'Stack readiness is older than its refresh window',

  posture_partial: 'Security evidence is incomplete',
  posture_action_needed: 'Security needs action',
  scanner_unavailable: 'Security scanner is unavailable',
  scans_stale: 'Scans are older than their freshness window',
  scans_never_completed: 'No scan has completed yet',

  control_paused: 'Policy sync is paused on this node',
  control_degraded: 'Policy sync is failing',
  control_unknown: 'Policy sync has never reached this node',

  capability_absent: 'This node runs a version without this check',
  domain_error: 'This check could not run',
};

/** A code's finding title, with a legible fallback for a code this build does not know. */
export function codeCopy(code: ReadinessReasonCode): string {
  return CODE_COPY[code] ?? 'This check reported something this version does not recognize';
}

/** The drill-down label for each target surface. */
export const TARGET_ACTION: Record<ReadinessTarget['surface'], string> = {
  stack: 'Open stack',
  'auto-updates': 'Auto-updates',
  'fleet-snapshots': 'Snapshots',
  security: 'Security',
  'node-details': 'Node details',
  'settings-nodes': 'Settings',
};
