import { useMemo, useState } from 'react';
import { CirclePause, CirclePlay, MoreHorizontal, Undo2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ConfirmModal, Modal, ModalBody, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { toast } from '@/components/ui/toast-store';
import {
  pauseGitOpsRollout,
  replanGitOpsRollout,
  resumeGitOpsRollout,
  rollbackGitOpsRollout,
  supersedeGitOpsRollout,
  type RolloutRollbackScope,
} from '@/lib/gitopsAuthorityApi';
import { livePlacementFacet, liveRolloutFacet } from '@/lib/gitopsState';
import type { PermissionAction } from '@/context/AuthContext';
import type { GitOpsRevisionProjection, GitOpsTargetProjection } from '@/types/gitops';

interface GitOpsRolloutControlsProps {
  /** The portfolio identity (`bp:<blueprintId>`) the controls write to. */
  applicationId: string;
  projection: GitOpsRevisionProjection;
  /** Refresh the surface after a write. */
  onChanged: () => void;
  can?: (action: PermissionAction) => boolean;
  /**
   * A disabled Blueprint withholds the execution controls (pause, resume,
   * supersede, rollback), the same way it withholds placement approval and
   * rollout authorization. Replanning placement stays available: it re-opens a
   * review and changes nothing on the fleet.
   */
  blueprintEnabled?: boolean;
  /** Display name for a target node; falls back to `node <id>`. */
  nodeLabel?: (nodeId: number) => string;
  /**
   * Prior generations the hub knows for this application, from the
   * rollout-generation history on the detail payload. Rollback is offered only
   * when this is present and non-empty: the projection carries no generation
   * list of its own.
   */
  rollbackGenerations?: Array<{ generationId: string }>;
}

type PendingAction = 'pause' | 'resume';

const PAUSABLE_ROLLOUT_STATES = new Set([
  'rollout_queued',
  'canary_in_progress',
  'batch_in_progress',
  'partially_rolled_out',
]);

const SUPERSEDABLE_ROLLOUT_STATES = new Set([
  'rollout_queued',
  'canary_in_progress',
  'batch_in_progress',
  'partially_rolled_out',
  'rollout_paused',
]);

/** Runtime states that read as a failed target rather than a result. */
const FAILED_RUNTIME_STATES = new Set([
  'recovery_failed',
  'recovery_required',
  'failed_previous_workload_intact',
  'failed_after_mutation',
]);

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function targetLooksFailed(target: GitOpsTargetProjection): boolean {
  return FAILED_RUNTIME_STATES.has(target.runtime.status)
    || target.connectivity === 'unreachable'
    || target.connectivity === 'stale';
}

/**
 * The rollout lifecycle controls for one Git-managed Blueprint application.
 *
 * Pause and resume are the only first-row actions: they are reversible and
 * apply to the rollout that is running now. Replan, supersede, and rollback are
 * rare or consequential, so they live behind the overflow menu and each opens
 * an explicit confirmation. Every control is offered only from the projection's
 * own statuses, and each action is gated by the permission the route requires.
 */
export default function GitOpsRolloutControls({
  applicationId,
  projection,
  onChanged,
  can,
  blueprintEnabled = true,
  nodeLabel,
  rollbackGenerations,
}: GitOpsRolloutControlsProps) {
  const allowed = (action: PermissionAction): boolean => can?.(action) === true;
  const live = projection.targetMode === 'blueprint' ? projection : null;
  const rollout = liveRolloutFacet(projection);
  const placement = livePlacementFacet(projection);
  const targets = useMemo(() => live?.targets ?? [], [live]);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [replanOpen, setReplanOpen] = useState(false);
  const [supersedeOpen, setSupersedeOpen] = useState(false);
  const [rollbackOpen, setRollbackOpen] = useState(false);

  const canPause = !!live
    && blueprintEnabled
    && rollout !== null
    && PAUSABLE_ROLLOUT_STATES.has(rollout.status)
    && allowed('stack:deploy');
  const canResume = !!live
    && blueprintEnabled
    && rollout?.status === 'rollout_paused'
    && allowed('stack:deploy');
  const canReplan = !!live
    && placement !== null
    && placement.status !== 'unbound_direct'
    && allowed('stack:create');
  const canSupersede = !!live
    && blueprintEnabled
    && rollout !== null
    && SUPERSEDABLE_ROLLOUT_STATES.has(rollout.status)
    && allowed('stack:deploy');
  const generations = useMemo<RollbackCandidate[]>(
    () => (rollbackGenerations ?? []).map(candidate => ({ generationId: candidate.generationId, nodeIds: [] })),
    [rollbackGenerations],
  );
  const canRollback = !!live
    && blueprintEnabled
    && generations.length > 0
    && allowed('stack:deploy');

  if (!canPause && !canResume && !canReplan && !canSupersede && !canRollback) return null;

  async function handlePause(reason: string): Promise<void> {
    setPending('pause');
    try {
      await pauseGitOpsRollout(applicationId, { reason });
      toast.success('Rollout paused');
      setPauseOpen(false);
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to pause the rollout'));
    } finally {
      setPending(null);
    }
  }

  async function handleResume(): Promise<void> {
    setPending('resume');
    try {
      const result = await resumeGitOpsRollout(applicationId);
      if (result.dispatched) {
        toast.success('Rollout resumed and started');
      } else {
        toast.warning(result.note ?? 'Rollout resumed; nothing was dispatched yet.');
      }
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to resume the rollout'));
    } finally {
      setPending(null);
    }
  }

  async function handleReplan(): Promise<void> {
    try {
      await replanGitOpsRollout(applicationId);
      toast.success('Placement review reopened');
      setReplanOpen(false);
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to replan the rollout'));
    }
  }

  async function handleSupersede(): Promise<void> {
    try {
      await supersedeGitOpsRollout(applicationId);
      toast.success('Rollout superseded');
      setSupersedeOpen(false);
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to supersede the rollout'));
    }
  }

  return (
    <>
      <div
        data-testid="gitops-rollout-controls"
        className="flex flex-wrap items-center gap-2 rounded-md border border-card-border bg-glass-highlight px-3 py-2"
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
          Rollout controls
        </span>
        {canPause && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 max-md:min-h-11"
            onClick={() => setPauseOpen(true)}
            disabled={pending !== null}
            data-testid="gitops-action-pause-rollout"
          >
            <CirclePause className="h-3.5 w-3.5" strokeWidth={1.5} />
            {pending === 'pause' ? 'Pausing…' : 'Pause rollout'}
          </Button>
        )}
        {canResume && (
          <Button
            size="sm"
            className="gap-1.5 max-md:min-h-11"
            onClick={() => void handleResume()}
            disabled={pending !== null}
            data-testid="gitops-action-resume-rollout"
          >
            <CirclePlay className="h-3.5 w-3.5" strokeWidth={1.5} />
            {pending === 'resume' ? 'Resuming…' : 'Resume rollout'}
          </Button>
        )}
        {(canReplan || canSupersede || canRollback) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 max-md:min-h-11 max-md:w-11"
                aria-label="More rollout controls"
                title="More rollout controls"
                data-testid="gitops-rollout-overflow"
              >
                <MoreHorizontal className="h-4 w-4" strokeWidth={1.5} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              {canReplan && (
                <DropdownMenuItem onSelect={() => setReplanOpen(true)} data-testid="gitops-action-replan">
                  Replan placement
                </DropdownMenuItem>
              )}
              {canSupersede && (
                <DropdownMenuItem onSelect={() => setSupersedeOpen(true)} data-testid="gitops-action-supersede">
                  Supersede rollout
                </DropdownMenuItem>
              )}
              {canRollback && (
                <DropdownMenuItem onSelect={() => setRollbackOpen(true)} data-testid="gitops-action-rollback">
                  <Undo2 className="mr-2 h-3.5 w-3.5" strokeWidth={1.5} />
                  Roll back rollout
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <PauseRolloutDialog
        open={pauseOpen}
        onOpenChange={setPauseOpen}
        confirming={pending === 'pause'}
        onConfirm={handlePause}
      />
      <ConfirmModal
        open={replanOpen}
        onOpenChange={setReplanOpen}
        kicker="PLACEMENT · REPLAN"
        title="Replan this Blueprint's placement?"
        description="Sencho re-derives the nodes this Blueprint targets and opens a fresh placement review. Any existing placement approval and rollout authorization are withdrawn, so the rollout cannot run until placement is approved and authorized again."
        confirmLabel="Replan placement"
        onConfirm={handleReplan}
      />
      <ConfirmModal
        open={supersedeOpen}
        onOpenChange={setSupersedeOpen}
        variant="destructive"
        kicker="ROLLOUT · SUPERSEDE"
        title="Supersede the live rollout?"
        description="This withdraws the rollout authorization. Nodes that already received the rollout keep running it, the abandoned rollout is reported as superseded, and a new authorization is required before anything else runs."
        confirmLabel="Supersede rollout"
        busyConfirmLabel="Superseding…"
        onConfirm={handleSupersede}
      />
      <RollbackRolloutDialog
        open={rollbackOpen}
        onOpenChange={setRollbackOpen}
        applicationId={applicationId}
        candidates={generations}
        targets={targets}
        nodeLabel={nodeLabel}
        onChanged={onChanged}
      />
    </>
  );
}

type RollbackCandidate = { generationId: string; nodeIds: number[] };

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function PauseRolloutDialog({ open, onOpenChange, confirming, onConfirm }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  confirming: boolean;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  return (
    <Modal open={open} onOpenChange={onOpenChange} size="sm">
      <ModalHeader kicker="ROLLOUT · PAUSE" title="Pause the rollout" />
      <ModalBody>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rollout-pause-reason" className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
            Reason
          </Label>
          <Input
            id="rollout-pause-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="waiting for the maintenance window"
            className="font-mono text-xs"
            maxLength={280}
            data-testid="gitops-pause-reason"
          />
        </div>
        <p className="font-mono text-[11px] text-stat-subtitle">
          Nodes keep running what they already deployed. A pause stops the rollout from advancing, nothing more.
        </p>
      </ModalBody>
      <ModalFooter
        hint="PAUSES the current rollout"
        secondary={(
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={confirming}>
            Cancel
          </Button>
        )}
        primary={(
          <Button
            size="sm"
            onClick={() => void onConfirm(trimmed)}
            disabled={confirming || trimmed.length === 0}
            data-testid="gitops-confirm-pause"
          >
            {confirming ? 'Pausing…' : 'Pause rollout'}
          </Button>
        )}
      />
    </Modal>
  );
}

type RollbackScopeKind = RolloutRollbackScope['kind'];

function RollbackRolloutDialog({
  open,
  onOpenChange,
  applicationId,
  candidates,
  targets,
  nodeLabel,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  applicationId: string;
  candidates: RollbackCandidate[];
  targets: readonly GitOpsTargetProjection[];
  nodeLabel?: (nodeId: number) => string;
  onChanged: () => void;
}) {
  const [generationId, setGenerationId] = useState<string>(candidates[0]?.generationId ?? '');
  const [scopeKind, setScopeKind] = useState<RollbackScopeKind>('all_changed');
  const [targetNodeId, setTargetNodeId] = useState<number | null>(targets[0]?.nodeId ?? null);
  const [confirming, setConfirming] = useState(false);
  const label = (nodeId: number): string => nodeLabel?.(nodeId) ?? `node ${nodeId}`;

  const activeTargets = targets.filter(target => !target.tombstoned);
  const failedTargets = activeTargets.filter(targetLooksFailed);
  const selectedGenerationId = candidates.some(candidate => candidate.generationId === generationId)
    ? generationId
    : (candidates[0]?.generationId ?? '');
  // Targets can arrive after the dialog mounted, so the selected node follows
  // the current list rather than freezing the first empty value.
  const selectedTargetNodeId = activeTargets.some(target => target.nodeId === targetNodeId)
    ? targetNodeId
    : (activeTargets[0]?.nodeId ?? null);

  const scopeOptions = [
    { value: 'all_changed' as const, label: 'All changed targets' },
    ...(failedTargets.length > 0 ? [{ value: 'failed' as const, label: 'Failed targets' }] : []),
    { value: 'target' as const, label: 'One target' },
  ];

  async function handleConfirm(): Promise<void> {
    if (selectedGenerationId.length === 0) return;
    if (scopeKind === 'target' && selectedTargetNodeId === null) return;
    const scope: RolloutRollbackScope = scopeKind === 'target'
      ? { kind: 'target', nodeId: selectedTargetNodeId as number }
      : { kind: scopeKind };
    setConfirming(true);
    try {
      const result = await rollbackGitOpsRollout(applicationId, { generationId: selectedGenerationId, scope });
      const restored = result.results.filter(entry => entry.status === 'restored').length;
      const failed = result.results.filter(entry => entry.status === 'failed');
      if (result.ok) {
        toast.success(`Rolled back ${restored} target${restored === 1 ? '' : 's'}`);
      } else {
        const firstError = failed[0]?.error;
        toast.warning(
          firstError
            ? `Rollback failed on ${failed.length} of ${result.results.length} targets: ${firstError}`
            : `Rollback failed on ${failed.length} of ${result.results.length} targets`,
        );
      }
      onOpenChange(false);
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to roll back the rollout'));
    } finally {
      setConfirming(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} size="md">
      <ModalHeader kicker="ROLLOUT · ROLLBACK" title="Roll back the rollout" />
      <ModalBody>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
              Generation to restore
            </Label>
            <div data-testid="gitops-rollback-generation">
              <Combobox
                options={candidates.map(candidate => ({
                  value: candidate.generationId,
                  label: candidate.nodeIds.length > 0
                    ? `${shortId(candidate.generationId)} · ${candidate.nodeIds.map(label).join(', ')}`
                    : shortId(candidate.generationId),
                }))}
                value={selectedGenerationId}
                onValueChange={setGenerationId}
                placeholder="Select a generation"
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
              Targets
            </Label>
            <SegmentedControl
              value={scopeKind}
              options={scopeOptions}
              onChange={setScopeKind}
              ariaLabel="Rollback target scope"
            />
            {scopeKind === 'target' && (
              <div data-testid="gitops-rollback-target">
                <Combobox
                  options={activeTargets.map(target => ({ value: String(target.nodeId), label: label(target.nodeId) }))}
                  value={selectedTargetNodeId === null ? '' : String(selectedTargetNodeId)}
                  onValueChange={(next) => setTargetNodeId(Number(next))}
                  placeholder="Select a target"
                />
              </div>
            )}
            <p className="font-mono text-[11px] text-stat-subtitle">
              {scopeKind === 'failed'
                ? `${failedTargets.length} target${failedTargets.length === 1 ? '' : 's'} recorded as failed, unreachable, or stale.`
                : scopeKind === 'all_changed'
                  ? `${activeTargets.length} target${activeTargets.length === 1 ? '' : 's'} currently in the rollout.`
                  : 'One target recovers from its own captured recovery point.'}
            </p>
          </div>
          <p className="font-mono text-[11px] text-stat-subtitle" data-testid="gitops-rollback-caveats">
            Rollback restores the authored project captured on each node. It does not restore application data. A locally
            built image is rebuilt from its authored inputs unless the node's recovery point still holds the previous
            image; the per-target result reports what actually happened. Only the generation captured immediately before
            each node's latest rollout can be restored there, so an older selection is reported as a failed target.
          </p>
        </div>
      </ModalBody>
      <ModalFooter
        hint="RESTORES the selected generation"
        secondary={(
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={confirming}>
            Cancel
          </Button>
        )}
        primary={(
          <Button
            size="sm"
            onClick={() => void handleConfirm()}
            disabled={confirming || candidates.length === 0 || (scopeKind === 'target' && selectedTargetNodeId === null)}
            data-testid="gitops-confirm-rollback"
          >
            {confirming ? 'Rolling back…' : 'Roll back'}
          </Button>
        )}
      />
    </Modal>
  );
}
