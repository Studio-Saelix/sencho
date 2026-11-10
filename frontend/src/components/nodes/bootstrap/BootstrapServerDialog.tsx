import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ConfirmModal, Modal, ModalBody, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { BusyButton } from '@/components/ui/busy-button';
import { cn } from '@/lib/utils';
import { BootstrapTargetStep } from './BootstrapTargetStep';
import { BootstrapPreflightStep } from './BootstrapPreflightStep';
import { BootstrapPlanStep } from './BootstrapPlanStep';
import { BootstrapRunStep } from './BootstrapRunStep';
import { BootstrapOperationsList } from './BootstrapOperationsList';
import { isOperationRunning } from './operationStatus';
import { useBootstrapOperation, type UseBootstrapOperation } from './useBootstrapOperation';
import { FirstTrustPrompt } from './FirstTrustPrompt';
import { HostKeyCompare } from './HostKeyCompare';
import { INVALIDATION_MESSAGE } from './invalidation';
import { useNodeBootstrap, type UseNodeBootstrap } from './useNodeBootstrap';
import type { BootstrapStep } from './types';

const STEPS: Array<{ id: BootstrapStep; label: string }> = [
  { id: 'target', label: 'Server' },
  { id: 'preflight', label: 'Preflight' },
  { id: 'plan', label: 'Plan' },
  { id: 'run', label: 'Run' },
];

function StepRail({ step, reachablePlan }: { step: BootstrapStep; reachablePlan: boolean }) {
  const activeIndex = STEPS.findIndex((entry) => entry.id === step);
  return (
    <div className="grid grid-cols-4 border-b border-card-border/60" role="list" aria-label="Bootstrap steps">
      {STEPS.map((entry, index) => {
        const isActive = index === activeIndex;
        const isComplete = index < activeIndex;
        const unreachable = (entry.id === 'plan' && !reachablePlan && step !== 'run') || (entry.id === 'run' && step !== 'run');
        return (
          <div
            key={entry.id}
            role="listitem"
            aria-current={isActive ? 'step' : undefined}
            className={cn(
              'relative flex items-center justify-center gap-2 px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.18em]',
              index < STEPS.length - 1 && 'border-r border-card-border/60',
              isActive ? 'text-brand' : isComplete ? 'text-stat-subtitle' : 'text-stat-subtitle/60',
              unreachable && 'opacity-50',
            )}
          >
            {isComplete ? (
              <span className="h-1.5 w-1.5 rounded-full bg-brand" aria-hidden />
            ) : (
              <span className="tabular-nums">{String(index + 1).padStart(2, '0')}</span>
            )}
            <span>{entry.label}</span>
            {isActive && <span aria-hidden className="absolute inset-x-3 bottom-0 h-[2px] bg-brand" />}
          </div>
        );
      })}
    </div>
  );
}

function FooterActions({
  wizard,
  run,
  onClose,
  onApprove,
}: {
  wizard: UseNodeBootstrap;
  run: UseBootstrapOperation;
  onClose: () => void;
  onApprove: () => void;
}) {
  const { step, busy, hostKey, trusted, replacing, result, resultIsCurrent, runPreflight, checkHostKey, back } = wizard;
  const checkingKey = busy === 'host-key';
  const running = busy === 'preflight';
  const canRun = hostKey !== null && (trusted || hostKey.trust === 'trusted' || (hostKey.trust === 'changed' && replacing));
  const planShown = step === 'plan' && resultIsCurrent && result?.plan;

  if (step === 'target') {
    // After a host key check the pin survives a field edit, so returning to the
    // preflight step does not repeat the keyscan.
    const canContinue = hostKey !== null;
    return (
      <ModalFooter
        secondary={<Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>}
        primary={canContinue ? (
          <Button size="sm" onClick={() => wizard.setStep('preflight')}>Continue to preflight</Button>
        ) : (
          <BusyButton pending={checkingKey} busyLabel="Checking host key" onClick={() => { void checkHostKey(); }}>
            Check host key
          </BusyButton>
        )}
      />
    );
  }

  if (step === 'preflight') {
    return (
      <ModalFooter
        secondary={<Button variant="outline" size="sm" onClick={back}>Back</Button>}
        primary={(
          <BusyButton
            pending={running}
            busyLabel="Inspecting host"
            onClick={() => { void runPreflight(); }}
            disabled={!canRun}
          >
            {result ? 'Run preflight again' : 'Run preflight'}
          </BusyButton>
        )}
        hint={running ? 'Inspecting the host over SSH. The preflight is bounded to 90 seconds.' : undefined}
      />
    );
  }

  if (step === 'run') {
    const operation = run.operation;
    const running = operation !== null && isOperationRunning(operation);
    return (
      <ModalFooter
        primary={<Button size="sm" onClick={onClose}>{running ? 'Close' : 'Done'}</Button>}
        hint={running
          ? 'The run continues on the hub after you close this window.'
          : operation?.state === 'enrolled'
            ? 'Readiness for deployments is not verified by this run.'
            : undefined}
      />
    );
  }

  return (
    <ModalFooter
      secondary={<Button variant="outline" size="sm" onClick={back}>Back to inspection</Button>}
      primary={planShown ? (
        <Button size="sm" onClick={onApprove} disabled={busy !== null}>
          {wizard.retryOf ? 'Approve and retry' : 'Approve and run'}
        </Button>
      ) : (
        <Button size="sm" onClick={onClose}>Close</Button>
      )}
      hint="Nothing has changed on this server yet."
    />
  );
}

function ApproveConfirm({
  wizard,
  open,
  onOpenChange,
  onApproved,
}: {
  wizard: UseNodeBootstrap;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApproved: (operation: Awaited<ReturnType<UseNodeBootstrap['approve']>>) => void;
}) {
  const plan = wizard.result?.plan;
  if (!plan) return null;
  const stepCount = plan.stages.reduce((total, stage) => total + stage.steps.length, 0);
  return (
    <ConfirmModal
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      kicker={`BOOTSTRAP · ${plan.targetName}`}
      title={wizard.retryOf ? 'Retry with this plan?' : 'Run this plan?'}
      hint={`CHANGES ${plan.target.host}`}
      confirmLabel={wizard.retryOf ? 'Approve and retry' : 'Approve and run'}
      busyConfirmLabel="Starting"
      confirming={wizard.busy === 'approve'}
      onConfirm={async () => {
        const operation = await wizard.approve();
        onOpenChange(false);
        if (operation) onApproved(operation);
      }}
    >
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          Sencho connects to {plan.target.username}@{plan.target.host} and runs the {stepCount} steps of this plan,
          then waits for the Pilot to enroll. It inspects the server again first and stops without changing anything
          if the server no longer matches the plan.
        </p>
        <ol className="list-decimal space-y-0.5 pl-5 text-xs">
          {plan.stages.map((stage) => <li key={stage.id}>{stage.title}</li>)}
        </ol>
        <p className="break-all font-mono text-[10px] text-stat-subtitle">Plan sha256:{plan.digest}</p>
      </div>
    </ConfirmModal>
  );
}

function DialogBody({ wizard, run }: { wizard: UseNodeBootstrap; run: UseBootstrapOperation }) {
  const { step, result, resultIsCurrent, invalidated, error, hostKey, trusted, setTrusted, replacing, setReplacing, supersededFingerprint, runPreflight, busy } = wizard;

  const follow = async (id: string) => {
    if (await run.openOperation(id)) wizard.setStep('run');
  };

  return (
    <ModalBody className="max-h-[65vh] overflow-y-auto">
      <div className="space-y-4">
        {wizard.retryOf && step !== 'run' && (
          <div className="rounded-lg border border-muted bg-card/40 px-3 py-2" data-testid="bootstrap-retry-banner">
            <p className="text-xs text-muted-foreground">
              Retrying {wizard.retryOf.targetName} on {wizard.retryOf.host}. Enter the SSH key again: the hub never stored it.
              The preflight then shows a new plan to approve.
            </p>
          </div>
        )}

        {invalidated && (
          <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2">
            <p className="text-xs text-warning">
              {INVALIDATION_MESSAGE[invalidated]}
            </p>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
            <p className="flex items-start gap-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.5} aria-hidden />
              {error}
            </p>
          </div>
        )}

        {step === 'target' && !wizard.retryOf && (
          <BootstrapOperationsList
            operations={run.operations}
            disabled={busy !== null || run.busy !== null}
            onFollow={(operation) => { void follow(operation.id); }}
            onRetry={(operation) => wizard.startRetry(operation)}
          />
        )}

        {step === 'target' && <BootstrapTargetStep wizard={wizard} />}

        {step === 'run' && run.operation && (
          <BootstrapRunStep
            operation={run.operation}
            busy={run.busy}
            onCancel={() => { void run.cancel(); }}
            onRetry={() => { if (run.operation) wizard.startRetry(run.operation); }}
            onRelease={run.release}
          />
        )}

        {step === 'preflight' && result && resultIsCurrent && (
          <BootstrapPreflightStep
            inspection={result.inspection}
            blocked={result.blocked}
            hostKeyTrust={hostKey?.trust ?? 'unknown'}
            pinnedFingerprint={hostKey?.pinnedFingerprint ?? null}
            trusted={trusted}
            onTrustedChange={setTrusted}
            replacing={replacing}
            onReplaceRequest={() => setReplacing(true)}
          />
        )}

        {step === 'preflight' && (!result || !resultIsCurrent) && hostKey && (
          <div className="space-y-3">
            <div className="rounded-lg border border-muted bg-card/40 px-3 py-2">
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">Host key fingerprint</p>
              <code className="mt-1 block break-all font-mono text-[12px] text-stat-value">{hostKey.fingerprint}</code>
              <p className="mt-1 font-mono text-[10px] text-stat-subtitle">{hostKey.algorithm} · dialed {hostKey.address}</p>
              {hostKey.trust === 'unknown' && (
                <FirstTrustPrompt
                  algorithm={hostKey.algorithm}
                  fingerprint={hostKey.fingerprint}
                  knownHostsLine={hostKey.knownHostsLine}
                  supersededFingerprint={supersededFingerprint}
                  trusted={trusted}
                  onTrustedChange={setTrusted}
                />
              )}
              {hostKey.trust === 'changed' && (
                <div className="mt-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5">
                  <p className="text-xs text-destructive">
                    This key differs from the pinned key. Replace the pin only if you know the host was rebuilt.
                  </p>
                  {hostKey.pinnedFingerprint && (
                    <p className="mt-1 break-all font-mono text-[10px] text-stat-subtitle">Pinned: {hostKey.pinnedFingerprint}</p>
                  )}
                  <p className="mt-1 break-all font-mono text-[10px] text-stat-subtitle">Observed: {hostKey.fingerprint}</p>
                  <HostKeyCompare algorithm={hostKey.algorithm} knownHostsLine={hostKey.knownHostsLine} />
                  <label className="mt-2 flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={replacing}
                      onChange={(event) => setReplacing(event.target.checked)}
                    />
                    I understand this replaces the pinned key and confirms the observed fingerprint.
                  </label>
                </div>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              The preflight runs a fixed catalog of read-only commands. Nothing is installed or written.
            </p>
          </div>
        )}

        {step === 'plan' && result?.plan && resultIsCurrent && (
          <BootstrapPlanStep plan={result.plan} inspection={result.inspection} />
        )}

        {step === 'plan' && (!result?.plan || !resultIsCurrent) && (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">The plan is no longer current. Run the preflight again.</p>
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { void runPreflight(); }}>
              Run preflight again
            </Button>
          </div>
        )}
      </div>
    </ModalBody>
  );
}

export function BootstrapServerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const wizard = useNodeBootstrap({ open });
  const run = useBootstrapOperation({ open });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const reachablePlan = wizard.result?.plan != null && wizard.resultIsCurrent;
  // The dialog is opened from a menu item, which unmounts when the menu closes.
  // Radix would try to restore focus to that gone item, so hand focus back to
  // the toolbar trigger explicitly after the close settles.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const timer = window.setTimeout(() => {
      document.querySelector<HTMLElement>('[data-node-management-trigger="true"]')?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  const close = () => {
    onOpenChange(false);
    wizard.reset();
    run.show(null);
  };

  return (
    <Modal open={open} onOpenChange={(next) => { if (!next) close(); else onOpenChange(true); }} size="xl" mobileFullScreen>
      <ModalHeader
        kicker="NODES · BOOTSTRAP"
        title="Bootstrap a new Linux server"
        description="Inspect a host over SSH, review the plan, then approve it to prepare Docker and enroll a Pilot."
      />
      <StepRail step={wizard.step} reachablePlan={reachablePlan} />
      <DialogBody wizard={wizard} run={run} />
      <FooterActions wizard={wizard} run={run} onClose={close} onApprove={() => setConfirmOpen(true)} />
      <ApproveConfirm
        wizard={wizard}
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onApproved={(operation) => {
          if (!operation) return;
          run.show(operation);
          void run.refreshList();
        }}
      />
    </Modal>
  );
}
