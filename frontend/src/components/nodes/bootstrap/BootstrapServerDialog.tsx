import { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { BusyButton } from '@/components/ui/busy-button';
import { cn } from '@/lib/utils';
import { BootstrapTargetStep } from './BootstrapTargetStep';
import { BootstrapPreflightStep } from './BootstrapPreflightStep';
import { BootstrapPlanStep } from './BootstrapPlanStep';
import { useNodeBootstrap, type UseNodeBootstrap } from './useNodeBootstrap';
import type { BootstrapStep } from './types';

const STEPS: Array<{ id: BootstrapStep; label: string }> = [
  { id: 'target', label: 'Server' },
  { id: 'preflight', label: 'Preflight' },
  { id: 'plan', label: 'Plan' },
];

function StepRail({ step, reachablePlan }: { step: BootstrapStep; reachablePlan: boolean }) {
  const activeIndex = STEPS.findIndex((entry) => entry.id === step);
  return (
    <div className="grid grid-cols-3 border-b border-card-border/60" role="list" aria-label="Bootstrap steps">
      {STEPS.map((entry, index) => {
        const isActive = index === activeIndex;
        const isComplete = index < activeIndex;
        const unreachable = entry.id === 'plan' && !reachablePlan;
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

function FooterActions({ wizard, onClose }: { wizard: UseNodeBootstrap; onClose: () => void }) {
  const { step, busy, hostKey, trusted, replacing, result, resultIsCurrent, runPreflight, checkHostKey, back } = wizard;
  const checkingKey = busy === 'host-key';
  const running = busy === 'preflight';
  const canRun = hostKey !== null && (trusted || hostKey.trust === 'trusted' || replacing);
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
        hint={running ? 'Inspecting the host over SSH. This usually takes under 30 seconds.' : undefined}
      />
    );
  }

  return (
    <ModalFooter
      secondary={<Button variant="outline" size="sm" onClick={back}>Back to inspection</Button>}
      primary={<Button size="sm" onClick={onClose}>{planShown ? 'Done' : 'Close'}</Button>}
      hint="No changes have been made on this server."
    />
  );
}

function DialogBody({ wizard }: { wizard: UseNodeBootstrap }) {
  const { step, result, resultIsCurrent, invalidated, error, hostKey, trusted, setTrusted, replacing, setReplacing, runPreflight, busy } = wizard;

  return (
    <ModalBody className="max-h-[65vh] overflow-y-auto">
      <div className="space-y-4">
        {invalidated && (
          <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2">
            <p className="text-xs text-warning">
              Paths changed. The previous preflight and plan no longer apply. Run the preflight again.
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

        {step === 'target' && <BootstrapTargetStep wizard={wizard} />}

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
                <label className="mt-2 flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" className="mt-0.5" checked={trusted} onChange={(event) => setTrusted(event.target.checked)} />
                  I trust this host key.
                </label>
              )}
              {hostKey.trust === 'changed' && (
                <p className="mt-2 text-xs text-destructive">
                  This key differs from the pinned key. Replace the pin only if you know the host was rebuilt.
                </p>
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
  };

  return (
    <Modal open={open} onOpenChange={(next) => { if (!next) { onOpenChange(false); wizard.reset(); } else { onOpenChange(true); } }} size="xl" mobileFullScreen>
      <ModalHeader
        kicker="NODES · BOOTSTRAP"
        title="Bootstrap a new Linux server"
        description="Inspect a host over SSH and prepare a plan. Nothing is changed on the server."
      />
      <StepRail step={wizard.step} reachablePlan={reachablePlan} />
      <DialogBody wizard={wizard} />
      <FooterActions wizard={wizard} onClose={close} />
    </Modal>
  );
}
