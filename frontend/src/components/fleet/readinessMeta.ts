import {
  Boxes, CircleHelp, Download, RefreshCw,
  Shield, Undo2, Wifi,
  type LucideIcon,
} from 'lucide-react';
import type { DomainState, ReadinessDomainKey, ReadinessReasonCode } from '@/types/readiness';

/**
 * Presentation tables for the readiness surface: domain labels, domain header
 * icons, state chips, and the one place a reason code becomes words.
 *
 * Nothing here computes a state: the hub decides every state and every reason
 * code, and this module only gives each one its words. Every lookup a payload
 * feeds goes through the accessors below, so a word a newer hub introduced
 * shows as itself rather than as a crash or a blank cell.
 */

const DOMAIN_META: Record<ReadinessDomainKey, { label: string; icon: LucideIcon }> = {
  connectivity: { label: 'Connectivity', icon: Wifi },
  workloads: { label: 'Workloads', icon: Boxes },
  updates: { label: 'Updates', icon: Download },
  recovery: { label: 'Recovery', icon: Undo2 },
  security: { label: 'Security', icon: Shield },
  control: { label: 'Control', icon: RefreshCw },
};

/**
 * The four non-healthy states, and the same four words a finding's severity is
 * drawn from. Keyed on the exclusion rather than on `DomainState` so a healthy
 * cell cannot be handed to this table: healthy has no chip and no explanation on
 * purpose (a green pill on every healthy row is the pattern the design system
 * bans, and healthy is the one state that needs no words).
 */
export const SEVERITY_META: Record<Exclude<DomainState, 'healthy'>, {
  label: string;
  chip: string;
  /** Text-only tone, for a word that sits outside a chip. */
  tone: string;
}> = {
  attention: {
    label: 'needs attention',
    chip: 'border-destructive/40 bg-destructive/[0.06] text-destructive',
    tone: 'text-destructive',
  },
  degraded: {
    label: 'degraded',
    chip: 'border-warning/40 bg-warning/[0.06] text-warning',
    tone: 'text-warning',
  },
  unavailable: {
    label: 'unavailable',
    chip: 'border-muted bg-card/40 text-stat-subtitle',
    tone: 'text-stat-subtitle',
  },
  unknown: {
    label: 'unknown',
    chip: 'border-muted bg-card/40 text-stat-subtitle',
    tone: 'text-stat-subtitle',
  },
};

/** The healthy cell's own treatment: a dot, because healthy is the quiet case. */
export const HEALTHY_META = { label: 'healthy', dot: 'bg-success', tone: 'text-success' };

/**
 * The state chip for a word the payload carried, with a fallback for one this
 * build does not know. An unrecognized state is not a quiet one, so it lands on
 * `unknown` rather than on a blank cell.
 */
export function severityMeta(state: Exclude<DomainState, 'healthy'>) {
  return SEVERITY_META[state] ?? SEVERITY_META.unknown;
}

/**
 * The column header for a domain the payload carried, with a fallback for one
 * this build does not know. The header keeps the hub's own word for it, so a
 * newer hub's seventh domain gets its own column instead of a missing one.
 */
export function domainMeta(domain: ReadinessDomainKey): { label: string; icon: LucideIcon } {
  return DOMAIN_META[domain] ?? { label: domain, icon: CircleHelp };
}

/**
 * What each reason code says. Sentences, not fragments: a finding row is the
 * only place the operator reads why a cell is not healthy, so the code has to
 * carry the whole statement.
 *
 * A code this build does not know (a hub newer than the UI) falls back at the
 * lookup site rather than rendering an empty row.
 */
const CODE_COPY: Record<ReadinessReasonCode, string> = {
  node_unreachable: 'Node did not answer',
  pilot_disconnected: 'Pilot tunnel is down',
  contact_stale: 'No recent contact from this node',
  probe_timeout: 'Node did not answer in time',

  workloads_exited: 'Stacks are not running',
  workloads_partial: 'Some stacks could not be read',
  workloads_unknown: 'Stack state is unknown',
  status_evidence_degraded: 'Stack listing is incomplete',
  status_evidence_stale: 'Stack state is older than its refresh window',

  update_blocked: 'An update is blocked',
  update_review_required: 'An update needs review first',
  update_ready_with_warnings: 'An update carries warnings',

  rollback_not_ready: 'Rollback is not ready',
  rollback_partial: 'Rollback is only partly ready',
  snapshot_failed: 'A fleet snapshot failed',

  stacks_unknown: 'Stack readiness could not be determined',
  summary_truncated: 'Stack readiness stopped early',
  summary_stale: 'Stack readiness is older than its refresh window',

  posture_partial: 'Security evidence is incomplete',
  posture_action_needed: 'Security needs action',
  scanner_unavailable: 'Security scanner is unavailable',
  scans_stale: 'Scans are older than their freshness window',
  scans_never_completed: 'No scan has completed yet',

  control_paused: 'Policy sync is paused on this node',
  control_degraded: 'Policy sync is failing',
  control_unknown: 'Policy sync state is unknown',

  capability_absent: 'This node does not report this yet',
  domain_error: 'This check could not run',
};

/**
 * The label for a code, with a fallback for one this build does not know. The
 * severity chip beside it still carries the tone, so an unknown code renders as
 * a legible row rather than a gap.
 */
export function codeCopy(code: ReadinessReasonCode): string {
  return CODE_COPY[code] ?? 'This check reported something this build does not know';
}
