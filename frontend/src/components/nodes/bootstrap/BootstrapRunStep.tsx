import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { BusyButton } from '@/components/ui/busy-button';
import { ConfirmModal } from '@/components/ui/modal';
import { StatusPath } from '@/components/ui/status-path';
import { STATUS_DOT_CLASS, type StatusTone } from '@/lib/statusTone';
import { cn } from '@/lib/utils';
import { operationAnswer, operationStages } from './operationStatus';
import type { BootstrapOperationDetail, BootstrapOperationEvent } from './types';

const EVENT_TONE: Record<BootstrapOperationEvent['status'], StatusTone> = {
  started: 'brand',
  done: 'success',
  skipped: 'neutral',
  info: 'neutral',
  failed: 'destructive',
  unknown: 'warning',
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

/** The evidence behind the Answer: what was approved, and every recorded event. */
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
 * the operation now (cancel while running; retry or release once stopped),
 * the Path shows how far it got, and the Activity holds the record.
 */
export function BootstrapRunStep({
  operation,
  busy,
  onCancel,
  onRetry,
  onRelease,
}: {
  operation: BootstrapOperationDetail;
  busy: 'open' | 'cancel' | 'release' | null;
  onCancel: () => void;
  onRetry: () => void;
  onRelease: () => Promise<void>;
}) {
  const [confirmRelease, setConfirmRelease] = useState(false);
  const { actions } = operation;
  const verbs = (actions.cancel || actions.retry || actions.release) ? (
    <div className="flex flex-wrap items-center gap-2">
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
          {operation.nodeId !== null ? ', and the node record stays in Fleet' : ''}. Nothing is removed.
        </p>
      </ConfirmModal>
    </>
  );
}
