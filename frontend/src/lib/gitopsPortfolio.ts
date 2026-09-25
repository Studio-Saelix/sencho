/**
 * Words and tones for the GitOps portfolio surface.
 *
 * The backend classifies; this module only names what it returns. Everything
 * reads through Partial lookups, the same convention `gitopsState.ts` uses for
 * facet statuses, so a reason code a newer server build introduces renders as
 * its raw code rather than crashing the page.
 */
import type { GitOpsAttentionReason, GitOpsPortfolioPosture, GitOpsPortfolioTargetSummary } from '@/types/gitopsPortfolio';

export type PortfolioTone = 'brand' | 'success' | 'warning' | 'destructive' | 'neutral';

export interface PortfolioLabel {
  /** Short label, rendered in tracked-mono chips. */
  label: string;
  tone: PortfolioTone;
  /** One complete sentence, for the row's inline explanation. Never hidden behind a tooltip only. */
  line: string;
}

export const POSTURE_LABEL: Record<GitOpsPortfolioPosture, { label: string; tone: PortfolioTone }> = {
  failed: { label: 'failed', tone: 'destructive' },
  attention: { label: 'needs attention', tone: 'warning' },
  in_progress: { label: 'in progress', tone: 'brand' },
  converged: { label: 'converged', tone: 'success' },
  converged_qualified: { label: 'converged · qualified', tone: 'success' },
  unknown: { label: 'unknown', tone: 'neutral' },
};

export const ATTENTION_LABEL: Partial<Record<GitOpsAttentionReason, PortfolioLabel>> = {
  source_failed: { label: 'source failed', tone: 'destructive', line: 'The last reconciliation of the Git source failed.' },
  source_unknown_outcome: { label: 'outcome unknown', tone: 'warning', line: 'A source operation was interrupted before its outcome could be confirmed.' },
  source_review_pending: { label: 'review required', tone: 'warning', line: 'A fetched commit is waiting for review before it can apply.' },
  source_conflict_blocker: { label: 'blocked by conflicts', tone: 'warning', line: 'The change plan has local conflicts; apply stays disabled until they resolve.' },
  source_reconcile_required: { label: 'reconcile required', tone: 'warning', line: 'What was reconciled no longer matches the configuration in force; fetch again to rebuild the candidate.' },
  source_retry_scheduled: { label: 'retry scheduled', tone: 'warning', line: 'The last reconciliation failed and a retry is scheduled.' },
  source_suspended: { label: 'source suspended', tone: 'neutral', line: 'Reconciliation is suspended for this source.' },
  placement_review_pending: { label: 'placement review', tone: 'warning', line: 'A target placement decision is waiting for review.' },
  stateful_confirmation_required: { label: 'stateful confirmation', tone: 'warning', line: 'Stateful changes need explicit confirmation before proceeding.' },
  stateful_withdrawal_blocked: { label: 'stateful change blocked', tone: 'warning', line: 'An automatic acceptance was held for review because the candidate removes or renames a stateful service, or that cannot be ruled out.' },
  rollout_authorization_pending: { label: 'rollout authorization', tone: 'warning', line: 'The rollout is waiting for authorization.' },
  rollout_authorization_stale: { label: 'authorization stale', tone: 'warning', line: 'The rollout authorization no longer matches the current intent; re-authorize to proceed.' },
  preflight_blocked: { label: 'preflight blocked', tone: 'warning', line: 'Preflight evidence blocks this rollout (for example an unready private-registry target).' },
  rollout_paused: { label: 'rollout paused', tone: 'warning', line: 'The rollout is paused.' },
  rollout_partial: { label: 'partial rollout', tone: 'warning', line: 'The rollout completed on only some required targets.' },
  rollout_completion_unknown: { label: 'completion unknown', tone: 'warning', line: 'A rollout step was interrupted; Sencho cannot confirm where it stopped.' },
  rollback_failed: { label: 'rollback failed', tone: 'destructive', line: 'A rollback did not complete.' },
  target_stale: { label: 'stale target', tone: 'warning', line: 'A target is reporting evidence older than the current intent.' },
  target_unreachable: { label: 'target unreachable', tone: 'destructive', line: 'A required target could not be reached.' },
  recovery_required: { label: 'recovery required', tone: 'warning', line: 'Recovery is required or in progress for this application.' },
  recovery_failed: { label: 'recovery failed', tone: 'destructive', line: 'Recovery did not complete.' },
  health_failed: { label: 'health failed', tone: 'destructive', line: 'A health check on this application is failing.' },
  artifact_unqualified: { label: 'artifact unverified', tone: 'warning', line: 'The executable artifact for the accepted generation is not provably identified.' },
  artifact_stale: { label: 'artifact stale', tone: 'warning', line: 'A registry tag moved after the generation was accepted.' },
  artifact_identity_changed: { label: 'artifact changed', tone: 'warning', line: 'Newer artifact evidence disagrees with the accepted executable identity.' },
  drift: { label: 'drifted', tone: 'warning', line: 'What is running no longer matches the intended state.' },
};

/** Fallback rendering for a reason this build has not heard of. */
export function attentionLabel(reason: GitOpsAttentionReason): PortfolioLabel {
  return ATTENTION_LABEL[reason] ?? { label: reason.replace(/_/g, ' '), tone: 'warning', line: 'This application reports an attention reason this Sencho build does not know.' };
}

export const POSTURE_TONE_CLASS: Record<PortfolioTone, string> = {
  brand: 'text-brand border-brand/40 bg-brand/[0.06]',
  success: 'text-success border-success/40 bg-success/[0.06]',
  warning: 'text-warning border-warning/40 bg-warning/[0.06]',
  destructive: 'text-destructive border-destructive/40 bg-destructive/[0.06]',
  neutral: 'text-stat-subtitle border-card-border bg-card/40',
};

/**
 * Masthead verdict for the whole portfolio, from server-computed summary.
 *
 * Ordered by what the operator needs to learn first: a failure outranks a
 * pending decision, which outranks work in flight. `Unknown` only earns the
 * masthead when nothing else is true, and "Converged" only when every
 * application in scope provably converged; a mixed or unproven portfolio
 * reports "In progress" rather than a claim the evidence cannot fund.
 */
export function portfolioMastheadState(summary: {
  failed: number;
  attentionRequired: number;
  inProgress: number;
  converged: number;
  convergedQualified: number;
  unknown: number;
  applications: number;
}, coverageFailed: boolean): { state: string; tone: 'error' | 'warn' | 'live' | 'idle' } {
  if (summary.applications === 0 && coverageFailed) return { state: 'Unknown', tone: 'idle' };
  if (summary.failed > 0) return { state: 'Needs action', tone: 'error' };
  if (summary.attentionRequired > 0) return { state: 'Needs attention', tone: 'warn' };
  if (summary.inProgress > 0) return { state: 'In progress', tone: 'live' };
  if (summary.applications === 0) return { state: 'No applications', tone: 'idle' };
  if (summary.unknown > 0) return { state: 'Partially known', tone: 'idle' };
  // Qualified convergence is not exact convergence: when nothing is provably
  // exact, the verdict says so instead of borrowing the stronger word.
  if (summary.converged === 0 && summary.convergedQualified > 0) {
    return { state: 'Converged · qualified', tone: 'live' };
  }
  return { state: 'Converged', tone: 'live' };
}

export function countCurrentTargets(targets: readonly GitOpsPortfolioTargetSummary[]): number {
  return targets.filter(target => !target.tombstoned).length;
}

/** Empty-portfolio copy, shared by the desktop table and the phone screen. */
export const PORTFOLIO_EMPTY_COPY =
  'No GitOps applications yet. Connect a stack to a Git repository, or deploy a Git-managed Blueprint, and it appears here.';
