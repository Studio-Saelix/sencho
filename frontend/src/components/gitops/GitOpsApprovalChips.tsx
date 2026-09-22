import { Check, CircleSlash, Fingerprint, Hourglass, type LucideIcon } from 'lucide-react';

import { GITOPS_TONE_CLASS, type GitOpsTone } from '@/lib/gitopsState';
import type { GitOpsApprovalRefs, PlacementFacet, RolloutFacet } from '@/types/gitops';
import { cn } from '@/lib/utils';

interface GitOpsApprovalChipsProps {
  /**
   * The recorded authority for this application, or null on the absent arm.
   * A ref being set is the whole proof a step was granted; the chips never
   * infer a grant from a facet status.
   */
  approvals: GitOpsApprovalRefs | null;
  /** Which authority steps are outstanding or do not apply, per the placement facet. */
  placement?: PlacementFacet | null;
  /** Supplies the rollout not_applicable reading; outstanding and stale are read from the placement facet. */
  rollout?: RolloutFacet | null;
  className?: string;
}

type ChipState = 'granted' | 'pending' | 'not_required';

interface Chip {
  approval: 'source' | 'placement' | 'rollout' | 'legacy';
  label: string;
  state: ChipState;
  tone: GitOpsTone;
  icon: LucideIcon;
  title: string;
}

function granted(approval: Chip['approval'], label: string, ref: string, step: string): Chip {
  return {
    approval,
    label,
    state: 'granted',
    tone: 'success',
    icon: Check,
    title: `${step} recorded as ${ref.slice(0, 8)}.`,
  };
}

function pending(approval: Chip['approval'], label: string, title: string): Chip {
  return {
    approval,
    label,
    state: 'pending',
    tone: 'warning',
    icon: Hourglass,
    title,
  };
}

function notRequired(approval: Chip['approval'], label: string, step: string): Chip {
  return {
    approval,
    label,
    state: 'not_required',
    tone: 'neutral',
    icon: CircleSlash,
    title: `${step} does not apply to this application.`,
  };
}

/**
 * The three decomposed authority steps as inline chips: source accepted,
 * placement approved, rollout authorized.
 *
 * Granted comes only from a recorded ref. Pending comes only from a facet that
 * says the step is outstanding, which is why a stale rollout authorization
 * reads as pending again even though its ref is still stored: the ref proves a
 * grant happened, the facet proves it no longer covers the current inputs. A
 * legacy combined approval is always additional, never merged into the three
 * steps it predates.
 *
 * When no authority has been recorded at all there is nothing to summarize, so
 * nothing renders; the state cards carry that story on their own.
 */
export default function GitOpsApprovalChips({ approvals, placement, rollout, className }: GitOpsApprovalChipsProps) {
  if (!approvals) return null;
  const anyRef = approvals.sourceAcceptanceRef
    ?? approvals.placementApprovalRef
    ?? approvals.rolloutAuthorizationRef
    ?? approvals.legacyCombinedApprovalRef;
  if (!anyRef) return null;

  const chips: Chip[] = [];

  if (approvals.sourceAcceptanceRef) {
    chips.push(granted('source', 'source accepted', approvals.sourceAcceptanceRef, 'Source acceptance'));
  } else if (placement?.status === 'source_acceptance_pending') {
    chips.push(pending('source', 'source acceptance pending', 'Source acceptance has not been recorded for the waiting generation.'));
  }

  if (approvals.placementApprovalRef) {
    chips.push(granted('placement', 'placement approved', approvals.placementApprovalRef, 'Placement approval'));
  } else if (placement?.status === 'unbound_direct' || placement?.status === 'not_applicable') {
    chips.push(notRequired('placement', 'placement n/a', 'Placement approval'));
  } else if (placement?.status === 'placement_review_pending' || placement?.status === 'stateful_confirmation_required') {
    chips.push(pending('placement', 'placement approval pending', 'Placement approval has not been recorded.'));
  }

  const rolloutStale = placement?.status === 'rollout_authorization_stale';
  if (approvals.rolloutAuthorizationRef && !rolloutStale) {
    chips.push(granted('rollout', 'rollout authorized', approvals.rolloutAuthorizationRef, 'Rollout authorization'));
  } else if (
    rolloutStale
    || placement?.status === 'rollout_authorization_pending'
    || placement?.status === 'preflight_blocked'
  ) {
    chips.push(pending(
      'rollout',
      'rollout authorization pending',
      rolloutStale
        ? 'The recorded rollout authorization was granted against earlier inputs.'
        : 'Rollout authorization has not been recorded.',
    ));
  } else if (rollout?.status === 'not_applicable' || placement?.status === 'unbound_direct') {
    chips.push(notRequired('rollout', 'rollout n/a', 'Rollout authorization'));
  }

  if (approvals.legacyCombinedApprovalRef) {
    chips.push({
      approval: 'legacy',
      label: 'legacy combined approval',
      state: 'granted',
      tone: 'brand',
      icon: Fingerprint,
      title: `Combined approval recorded as ${approvals.legacyCombinedApprovalRef.slice(0, 8)}. It is always shown in addition to the decomposed steps.`,
    });
  }

  return (
    <div data-testid="gitops-approvals" className={cn('flex flex-wrap items-center gap-1', className)}>
      {chips.map((chip) => {
        const Icon = chip.icon;
        return (
          <span
            key={chip.approval}
            data-approval={chip.approval}
            data-state={chip.state}
            title={chip.title}
            className={cn(
              'inline-flex max-w-full items-center gap-1 rounded-sm border px-1.5 py-0.5',
              'font-mono text-[10px] uppercase tracking-wide',
              GITOPS_TONE_CLASS[chip.tone],
            )}
          >
            <Icon className="h-2.5 w-2.5 shrink-0" strokeWidth={2} aria-hidden />
            <span className="truncate">{chip.label}</span>
          </span>
        );
      })}
    </div>
  );
}
