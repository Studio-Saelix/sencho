import { useState } from 'react';
import { Hourglass, ShieldCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast-store';
import { RolloutPreviewDialog } from '@/components/blueprints/RolloutPreviewDialog';
import { authorizeGitOpsRollout } from '@/lib/gitopsAuthorityApi';
import { policyReadFor } from '@/lib/gitopsAuthorityPolicy';
import GitOpsPolicyControl from '@/components/gitops/GitOpsPolicyControl';
import GitOpsSourceActions from '@/components/gitops/GitOpsSourceActions';
import { acceptSourceVisible, pullSourceVisible } from '@/components/gitops/sourceActionVisibility';
import { livePlacementFacet } from '@/lib/gitopsState';
import { useNodes } from '@/context/NodeContext';
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
  can?: (
    action: PermissionAction,
    resourceType?: string,
    resourceId?: string,
    nodeId?: number | null,
  ) => boolean;
  /**
   * The bound Blueprint's state, when the surface knows it. Disabled withholds
   * the execution authority (placement and rollout) but not source
   * acceptance: content review stays available while the reconciler is off,
   * the same way an Inline Blueprint's editor stays editable.
   */
  blueprintEnabled?: boolean;
}

type PendingAction = 'rollout';

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

/**
 * The decomposed authority actions for one Blueprint application: accept the
 * waiting source revision, approve the reviewed placement, or authorize the
 * rollout, alongside the placement and rollout authorization policies that
 * govern whether a decision may be taken automatically.
 *
 * Each action is offered only while the projection says its authority step is
 * outstanding, so the action buttons are a next-step prompt rather than a
 * permanent toolbar; when nothing is outstanding it renders nothing. Direct
 * applications render nothing: their authority runs through the owning stack
 * and the routes reject them. An Inline Blueprint renders no Git-lifecycle
 * action, but it does render the two policy controls, because its placement and
 * rollout decisions are evaluated against them.
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
  const { nodes } = useNodes();
  const sourceNodeId = nodes.find((node) => node.is_default)?.id ?? null;
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  // Both Blueprint modes count as a live application here, because both are
  // placed. A Blueprint demoted back to Inline keeps its placement policy and the
  // placement decision still evaluates it, so its policy needs a control; hiding
  // the whole block on target mode left a demoted application with a live
  // automatic decision and no way to reach it from the interface.
  const isBlueprintTarget = projection.targetMode === 'blueprint' || projection.targetMode === 'inline_blueprint';
  const live = isBlueprintTarget ? projection : null;
  const placement = livePlacementFacet(projection);

  // Accept source is a stack:create write. Under the Automatic rollout
  // authorization policy the system starts the rollout from the accepted
  // generation, the same as the automatic source acceptance path, so that
  // acceptance is the whole operator act for Accept source. Pull source is
  // exact stack:edit on the source stack.
  const canPullSource = pullSourceVisible(projection, can, sourceNodeId);
  const canAcceptSource = acceptSourceVisible(projection, can);

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

  // The rollout authorization policy, for the one mode whose rollout controls
  // row does not exist. An Inline Blueprint executes a policy-approved plan on
  // its own only while this policy is automatic, and GitOpsRolloutControls
  // hosts the control only for Git-managed applications, so without it here an
  // operator could configure bounded automatic placement and never let it act.
  // A Git-managed application keeps the control in its rollout overflow.
  const inlineTarget = projection.targetMode === 'inline_blueprint';
  const rolloutPolicyRead = inlineTarget
    ? policyReadFor(live?.authorityPolicies, 'rollout_authorization')
    : null;
  const canConfigureRolloutPolicy = rolloutPolicyRead !== null && allowed('stack:deploy');

  if (
    !canPullSource
    && !canAcceptSource
    && !canApprovePlacement
    && !canAuthorizeRollout
    && !canConfigurePlacement
    && !canConfigureRolloutPolicy
  ) {
    return null;
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
        <GitOpsSourceActions
          applicationId={applicationId}
          projection={projection}
          can={can}
          sourceNodeId={sourceNodeId}
          onChanged={onChanged}
          onPendingChange={setSourceBusy}
        />
        {canApprovePlacement && (
          <Button
            size="sm"
            className="gap-1.5 max-md:min-h-11"
            onClick={() => setPreviewOpen(true)}
            disabled={pending !== null || sourceBusy || !blueprintEnabled}
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
            disabled={pending !== null || sourceBusy || !blueprintEnabled}
            data-testid="gitops-action-authorize-rollout"
            title="Evaluates registry preflight, records the operator authorization, and starts the rollout."
          >
            <ShieldCheck className="h-3.5 w-3.5" strokeWidth={1.5} />
            {pending === 'rollout' ? 'Authorizing…' : 'Authorize rollout'}
          </Button>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-2">
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
                  className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 max-md:min-h-11"
                  data-testid="gitops-action-placement-policy"
                >
                  Placement policy
                </button>
              )}
            />
          )}
          {rolloutPolicyRead && canConfigureRolloutPolicy && (
            // Beside the placement policy, because together they decide whether
            // this Inline Blueprint acts on its own.
            <GitOpsPolicyControl
              applicationId={applicationId}
              domain="rollout_authorization"
              read={rolloutPolicyRead}
              onChanged={onChanged}
              canWrite={canConfigureRolloutPolicy}
              trigger={(open) => (
                <button
                  type="button"
                  onClick={open}
                  className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 max-md:min-h-11"
                  data-testid="gitops-action-rollout-policy"
                >
                  Rollout authorization policy
                </button>
              )}
            />
          )}
        </span>
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
