import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { BusyButton } from '@/components/ui/busy-button';
import { ConfirmModal } from '@/components/ui/modal';
import { StatusPath } from '@/components/ui/status-path';
import { STATUS_DOT_CLASS, type StatusTone } from '@/lib/statusTone';
import { cn } from '@/lib/utils';
import { operationAnswer, operationStages } from './operationStatus';
import type { BootstrapOperationDetail, BootstrapOperationEvent, NodeReadiness, ReadinessGateStatus } from './types';

const EVENT_TONE: Record<BootstrapOperationEvent['status'], StatusTone> = {
  started: 'brand',
  done: 'success',
  skipped: 'neutral',
  info: 'neutral',
  failed: 'destructive',
  unknown: 'warning',
};

const GATE_TONE: Record<ReadinessGateStatus, StatusTone> = {
  pass: 'success',
  warn: 'warning',
  fail: 'destructive',
  unknown: 'warning',
};

const GATE_WORD: Record<ReadinessGateStatus, string> = {
  pass: 'pass',
  warn: 'warning',
  fail: 'failed',
  unknown: 'unknown',
};

function time(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2">
      <dt className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">{label}</dt>
      <dd className="break-all font-mono text-[11px] text-stat-value">{value}</dd>
    </div>
  );
}

/** Each gate of the last readiness check, with its remediation where it did not pass. */
function ReadinessChecks({ readiness }: { readiness: NodeReadiness }) {
  if (readiness.gates.length === 0) return null;
  return (
    <section aria-label="Readiness checks" className="space-y-1.5">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
        Readiness{readiness.checkedAt !== null ? ` · ${new Date(readiness.checkedAt).toISOString()}` : ''}{readiness.agentVersion ? ` · Pilot ${readiness.agentVersion}` : ''}
      </p>
      <ul className="space-y-1.5">
        {readiness.gates.map((gate) => (
          <li key={gate.id} className="text-xs" data-testid="bootstrap-readiness-gate" data-state={gate.status}>
            <div className="flex items-start gap-2">
              <span aria-hidden className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT_CLASS[GATE_TONE[gate.status]])} />
              <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-stat-subtitle">{GATE_WORD[gate.status]}</span>
              <span className="text-foreground/80"><span className="font-medium">{gate.label}.</span> {gate.summary}</span>
            </div>
            {gate.remediation && gate.status !== 'pass' && (
              <p className="ml-3.5 mt-0.5 text-[11px] text-muted-foreground">{gate.remediation}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The evidence behind the Answer: what was approved, the readiness checks, and every recorded event. */
function OperationProof({ operation }: { operation: BootstrapOperationDetail }) {
  return (
    <div className="space-y-3">
      <dl className="grid gap-1">
        <Fact label="Plan" value={`sha256:${operation.planDigest}`} />
        <Fact label="Approved" value={`${operation.approvedBy} · ${new Date(operation.approvedAt).toISOString()} · attempt ${operation.attempt}`} />
        <Fact label="Server" value={`${operation.username}@${operation.host}:${operation.port} (${operation.address})`} />
        <Fact label="Host key" value={operation.hostKeyFingerprint} />
        {operation.nodeId !== null && <Fact label="Node" value={`#${operation.nodeId}`} />}
      </dl>
      {/* Gates describe a finished check; while one is pending they would be the previous check's. */}
      {(operation.readiness?.state === 'ready' || operation.readiness?.state === 'not_ready') && <ReadinessChecks readiness={operation.readiness} />}
      <ol className="space-y-1.5" aria-label="Activity">
        {operation.events.map((event, index) => (
          <li key={`${event.at}-${index}`} className="text-xs" data-testid="bootstrap-event">
            {operation.attempt > 1 && (index === 0 || operation.events[index - 1].attempt !== event.attempt) && (
              <p className="mb-1 mt-2 font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle first:mt-0">Attempt {event.attempt}</p>
            )}
            <div className="flex items-start gap-2">
              <span aria-hidden className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT_CLASS[EVENT_TONE[event.status]])} />
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-stat-subtitle">{time(event.at)}</span>
              <span className="text-foreground/80">{event.message}</span>
            </div>
            {event.detail && (
              <pre className="ml-3.5 mt-1 max-h-40 overflow-auto rounded-md border border-card-border bg-muted/40 p-2 font-mono text-[10px] text-foreground/80">{event.detail}</pre>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Step 4: the approved run. One Answer carries the verbs the hub offers for
 * the operation now (cancel while running; retry or release once stopped;
 * verify again once enrolled), the Path shows how far it got, and the
 * Activity holds the readiness checks and the record.
 */
export function BootstrapRunStep({
  operation,
  busy,
  onCancel,
  onRetry,
  onRelease,
  onVerify,
}: {
  operation: BootstrapOperationDetail;
  busy: 'open' | 'cancel' | 'release' | 'verify' | null;
  onCancel: () => void;
  onRetry: () => void;
  onRelease: () => Promise<void>;
  onVerify: () => void;
}) {
  const [confirmRelease, setConfirmRelease] = useState(false);
  const { actions } = operation;
  const verbs = (actions.cancel || actions.retry || actions.release || actions.verify) ? (
    <div className="flex flex-wrap items-center gap-2">
      {actions.verify && (
        <BusyButton
          size="sm"
          variant={operation.readiness?.state === 'ready' ? 'outline' : 'default'}
          pending={busy === 'verify'}
          busyLabel="Verifying"
          disabled={busy !== null && busy !== 'verify'}
          onClick={onVerify}
        >
          {operation.readiness?.state === 'provisional' ? 'Verify now' : 'Verify again'}
        </BusyButton>
      )}
      {actions.retry && (
        <Button size="sm" onClick={onRetry} disabled={busy !== null}>Retry</Button>
      )}
      {actions.cancel && (
        <BusyButton size="sm" variant="outline" pending={busy === 'cancel'} busyLabel="Cancelling" onClick={onCancel}>
          Cancel run
        </BusyButton>
      )}
      {actions.release && (
        <Button size="sm" variant="ghost" onClick={() => setConfirmRelease(true)} disabled={busy !== null}>
          Release server
        </Button>
      )}
    </div>
  ) : undefined;

  return (
    <>
      <StatusPath
        answer={{ ...operationAnswer(operation), action: verbs, 'data-testid': 'bootstrap-run-answer' }}
        stages={operationStages(operation)}
        proof={{ label: 'Activity', children: <OperationProof operation={operation} /> }}
        data-testid="bootstrap-run-status"
      />
      <ConfirmModal
        open={confirmRelease}
        onOpenChange={setConfirmRelease}
        kicker={`BOOTSTRAP · ${operation.targetName}`}
        title="Release this server?"
        hint={`CHANGES nothing on ${operation.host}`}
        confirmLabel="Release server"
        busyConfirmLabel="Releasing"
        confirming={busy === 'release'}
        onConfirm={async () => {
          await onRelease();
          setConfirmRelease(false);
        }}
      >
        <p className="text-sm text-muted-foreground">
          Another bootstrap can then run on {operation.host}. Steps this run already made stay on the server
          {operation.nodeId !== null ? (operation.nodeExists ? ', and the node record stays in Fleet' : ', and the node record is no longer in Fleet') : ''}. Nothing is removed.
        </p>
      </ConfirmModal>
    </>
  );
}
