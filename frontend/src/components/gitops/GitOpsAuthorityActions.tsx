import { useState } from 'react';
import { CheckCheck, Hourglass, ShieldCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast-store';
import { RolloutPreviewDialog } from '@/components/blueprints/RolloutPreviewDialog';
import { acceptGitOpsSource, authorizeGitOpsRollout } from '@/lib/gitopsAuthorityApi';
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
  /** The bound Blueprint's state, when the surface knows it; disabled withholds every action. */
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

  const live = projection.targetMode === 'blueprint' ? projection : null;
  const source = liveSourceFacet(projection);
  const placement = livePlacementFacet(projection);

  // The source facet names the waiting generation directly; the placement
  // facet's pending arm agrees with it, but a newer candidate after an earlier
  // acceptance is the source facet's fact to carry.
  const candidateGenerationId = source?.status === 'candidate_ready' || source?.status === 'source_review_pending'
    ? source.candidateGenerationId
    : null;
  const canAcceptSource = !!live
    && candidateGenerationId !== null
    && allowed('stack:create');

  const canApprovePlacement = !!live
    && blueprintId !== null
    && placement?.status === 'placement_review_pending'
    && allowed('stack:create') && allowed('stack:deploy');

  const canAuthorizeRollout = !!live
    && (placement?.status === 'rollout_authorization_pending'
      || placement?.status === 'rollout_authorization_stale'
      || placement?.status === 'preflight_blocked')
    && allowed('stack:deploy');

  if (!canAcceptSource && !canApprovePlacement && !canAuthorizeRollout) return null;

  async function handleAcceptSource(): Promise<void> {
    if (!candidateGenerationId) return;
    setPending('source');
    try {
      await acceptGitOpsSource(applicationId, candidateGenerationId);
      toast.success('Source revision accepted');
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
            disabled={pending !== null || !blueprintEnabled}
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
