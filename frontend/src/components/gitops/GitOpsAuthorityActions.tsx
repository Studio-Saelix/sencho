import { useState } from 'react';
import { CheckCheck, Hourglass, ShieldCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast-store';
import { RolloutPreviewDialog } from '@/components/blueprints/RolloutPreviewDialog';
import { acceptGitOpsSource, authorizeGitOpsRollout } from '@/lib/gitopsAuthorityApi';
import { policyReadFor } from '@/lib/gitopsAuthorityPolicy';
import GitOpsPolicyControl from '@/components/gitops/GitOpsPolicyControl';
import { livePlacementFacet, liveSourceFacet } from '@/lib/gitopsState';
import type { PermissionAction } from '@/context/AuthContext';
import type { GitOpsRevisionProjection } from '@/types/gitops';

interface GitOpsAuthorityActionsProps {
  /** The portfolio identity (`bp:<blueprintId>`) the actions write to. */
  applicationId: string;
  /** The bound Blueprint, for the placement review dialog. */
  blueprintId: number | null;
  blueprintName: string;
  projection: GitOpsRevisionProjection;
  /** Refresh the surface after a write. */
  onChanged: () => void;
  /**
   * Permission resolver. Required in effect: without one the row renders
   * nothing, so a surface that forgets it hides an action rather than offering
   * one the session may not hold.
   */
  can?: (action: PermissionAction) => boolean;
  /**
   * The bound Blueprint's state, when the surface knows it. Disabled withholds
   * the execution authority (placement and rollout) but not source
   * acceptance: content review stays available while the reconciler is off,
   * the same way an Inline Blueprint's editor stays editable.
   */
  blueprintEnabled?: boolean;
}

type PendingAction = 'source' | 'rollout';

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

/**
 * The decomposed authority actions for one Git-managed Blueprint application:
 * accept the waiting source revision, approve the reviewed placement, or
 * authorize the rollout.
 *
 * Each action is offered only while the projection says its authority step is
 * outstanding, so the row is a next-step prompt rather than a permanent
 * toolbar; when nothing is outstanding it renders nothing. Inline and Direct
 * applications render nothing: their authority runs through Apply or through
 * the owning stack, and both are rejected by the routes.
 *
 * Placement approval opens the Blueprint's rollout preview, which is the
 * reviewed plan the approval is bound to; the confirm there writes the
 * placement approval instead of an inline apply.
 */
export default function GitOpsAuthorityActions({
  applicationId,
  blueprintId,
  blueprintName,
  projection,
  onChanged,
  can,
  blueprintEnabled = true,
}: GitOpsAuthorityActionsProps) {
  const allowed = (action: PermissionAction): boolean => can?.(action) === true;
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  // Both Blueprint modes count as a live application here, because both are
  // placed. A Blueprint demoted back to Inline keeps its placement policy and the
  // placement decision still evaluates it, so its policy needs a control; hiding
  // the whole block on target mode left a demoted application with a live
  // automatic decision and no way to reach it from the interface.
  const isBlueprintTarget = projection.targetMode === 'blueprint' || projection.targetMode === 'inline_blueprint';
  const live = isBlueprintTarget ? projection : null;
  const source = liveSourceFacet(projection);
  const placement = livePlacementFacet(projection);

  // The source facet names the waiting generation directly; the placement
  // facet's pending arm agrees with it, but a newer candidate after an earlier
  // acceptance is the source facet's fact to carry.
  const candidateGenerationId = source?.status === 'candidate_ready' || source?.status === 'source_review_pending'
    ? source.candidateGenerationId
    : null;
  // Each of these acts on a Git source generation, which an Inline Blueprint
  // does not have, and the routes behind them refuse anything but a Git-managed
  // application. Offering one would be a button whose every press is a 409.
  const canAcceptSource = projection.targetMode === 'blueprint'
    && candidateGenerationId !== null
    && allowed('stack:create');

  const canApprovePlacement = projection.targetMode === 'blueprint'
    && blueprintId !== null
    && placement?.status === 'placement_review_pending'
    && allowed('stack:create') && allowed('stack:deploy');

  const canAuthorizeRollout = projection.targetMode === 'blueprint'
    && (placement?.status === 'rollout_authorization_pending'
      || placement?.status === 'rollout_authorization_stale'
      || placement?.status === 'preflight_blocked')
    && allowed('stack:deploy');

  // The placement policy is configurable whether or not a placement is waiting,
  // so the row cannot be gated on an outstanding action the way the three action
  // buttons are. Without this the control would only exist at the moment it is
  // least needed, which is exactly when an operator is deciding what to do.
  const placementPolicyRead = policyReadFor(live?.authorityPolicies, 'placement');
  const canConfigurePlacement = !!live && allowed('stack:deploy');

  if (!canAcceptSource && !canApprovePlacement && !canAuthorizeRollout && !canConfigurePlacement) {
    return null;
  }

  async function handleAcceptSource(): Promise<void> {
    if (!candidateGenerationId) return;
    setPending('source');
    try {
      const result = await acceptGitOpsSource(applicationId, candidateGenerationId);
      if (result.note) {
        // The acceptance stands; the note names what is still missing (an
        // unresolved artifact identity, or a preparation still running).
        toast.warning(result.note);
      } else if (result.dispatched) {
        toast.success('Source revision accepted and the rollout started');
      } else {
        toast.success('Source revision accepted');
      }
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to accept the source revision'));
    } finally {
      setPending(null);
    }
  }

  async function handleAuthorizeRollout(): Promise<void> {
    setPending('rollout');
    try {
      const result = await authorizeGitOpsRollout(applicationId);
      if (result.dispatched) {
        toast.success('Rollout authorized and started');
      } else {
        toast.warning(result.note ?? 'Rollout authorized; the rollout has not started yet.');
      }
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to authorize the rollout'));
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      <div
        data-testid="gitops-authority-actions"
        className="flex flex-wrap items-center gap-2 rounded-md border border-card-border bg-glass-highlight px-3 py-2"
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
          Next authority step
        </span>
        {!blueprintEnabled && (
          <span className="font-mono text-[10px] uppercase tracking-wide text-warning">
            Blueprint disabled
          </span>
        )}
        {canAcceptSource && (
          <Button
            size="sm"
            className="gap-1.5 max-md:min-h-11"
            onClick={() => void handleAcceptSource()}
            disabled={pending !== null}
            data-testid="gitops-action-accept-source"
          >
            <CheckCheck className="h-3.5 w-3.5" strokeWidth={1.5} />
            {pending === 'source' ? 'Accepting…' : 'Accept source'}
          </Button>
        )}
        {canApprovePlacement && (
          <Button
            size="sm"
            className="gap-1.5 max-md:min-h-11"
            onClick={() => setPreviewOpen(true)}
            disabled={pending !== null || !blueprintEnabled}
            data-testid="gitops-action-approve-placement"
          >
            <Hourglass className="h-3.5 w-3.5" strokeWidth={1.5} />
            Review and approve placement
          </Button>
        )}
        {canAuthorizeRollout && (
          <Button
            size="sm"
            className="gap-1.5 max-md:min-h-11"
            onClick={() => void handleAuthorizeRollout()}
            disabled={pending !== null || !blueprintEnabled}
            data-testid="gitops-action-authorize-rollout"
            title="Evaluates registry preflight, records the operator authorization, and starts the rollout."
          >
            <ShieldCheck className="h-3.5 w-3.5" strokeWidth={1.5} />
            {pending === 'rollout' ? 'Authorizing…' : 'Authorize rollout'}
          </Button>
        )}
        {placementPolicyRead && canConfigurePlacement && (
          // Beside the placement approval, because that is the decision this
          // policy governs. Same gate as the approval it configures, so a
          // session that cannot deploy is not offered either.
          <GitOpsPolicyControl
            applicationId={applicationId}
            domain="placement"
            read={placementPolicyRead}
            onChanged={onChanged}
            canWrite={canConfigurePlacement}
            trigger={(open) => (
              <button
                type="button"
                onClick={open}
                className="ml-auto font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 max-md:min-h-11"
                data-testid="gitops-action-placement-policy"
              >
                Placement policy
              </button>
            )}
          />
        )}
      </div>

      {blueprintId !== null && (
        <RolloutPreviewDialog
          blueprintId={blueprintId}
          blueprintName={blueprintName}
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          onApplied={onChanged}
        />
      )}
    </>
  );
}
