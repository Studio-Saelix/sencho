import { useState } from 'react';
import { Check, Copy, RefreshCw } from 'lucide-react';
import type { Node } from '@/context/NodeContext';
import { Button } from '@/components/ui/button';
import { BusyButton } from '@/components/ui/busy-button';
import { IconBusyButton } from '@/components/ui/icon-busy-button';
import { ConfirmModal } from '@/components/ui/modal';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusPath } from '@/components/ui/status-path';
import { SheetSection, SystemSheet } from '@/components/ui/system-sheet';
import { toast } from '@/components/ui/toast-store';
import { useVisualBusy } from '@/hooks/useVisualBusy';
import { useNodeSealingKey, type NodeSealingKeyView } from '@/hooks/useNodeSealingKey';
import { copyToClipboard } from '@/lib/clipboard';
import { formatTimeAgo } from '@/lib/relativeTime';
import { RESET_PIN_CONSEQUENCE, sealingKeyAnswer } from '@/lib/sealingKeyStatus';

function FingerprintRow({ label, fingerprint, testId }: { label: string; fingerprint: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await copyToClipboard(fingerprint);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (error: unknown) {
      const e = error as { message?: string } | null;
      toast.error(e?.message || 'Could not copy the fingerprint.');
    }
  };
  return (
    <div className="flex items-start gap-3 py-1.5" data-testid={testId}>
      <span className="w-24 shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-stat-subtitle pt-0.5">{label}</span>
      <code className="min-w-0 flex-1 break-all font-mono text-xs text-stat-value">{fingerprint}</code>
      <Button
        size="icon"
        variant="ghost"
        className="h-6 w-6 shrink-0"
        aria-label={`Copy ${label.toLowerCase()} fingerprint`}
        onClick={() => void copy()}
      >
        {copied ? <Check className="h-3.5 w-3.5" strokeWidth={1.5} /> : <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />}
      </Button>
    </div>
  );
}

function Fingerprints({ view }: { view: NodeSealingKeyView }) {
  if (view.kind === 'local') {
    return <FingerprintRow label="This instance" fingerprint={view.fingerprint} testId="sealing-fp-local" />;
  }
  const { pinned, presented } = view;
  if (!pinned && !presented) {
    return <p className="font-mono text-[11px] text-stat-subtitle">No key is pinned and the node presented none.</p>;
  }
  // Each fingerprint is shown once: a matching pair is one row.
  if (pinned && presented && pinned.fingerprint === presented.fingerprint) {
    return <FingerprintRow label="Pinned" fingerprint={pinned.fingerprint} testId="sealing-fp-pinned" />;
  }
  return (
    <>
      {pinned && <FingerprintRow label="Pinned" fingerprint={pinned.fingerprint} testId="sealing-fp-pinned" />}
      {presented && <FingerprintRow label="Presented" fingerprint={presented.fingerprint} testId="sealing-fp-presented" />}
    </>
  );
}

function pinMeta(view: NodeSealingKeyView): string | null {
  if (view.kind === 'local' || !view.pinned) return null;
  const pin = view.pinned;
  if (pin.confirmedBy && pin.confirmedAt) {
    return `Confirmed by ${pin.confirmedBy} ${formatTimeAgo(pin.confirmedAt)}`;
  }
  return `Pinned ${formatTimeAgo(pin.registeredAt)}${pin.confidential ? ' over a confidential connection' : ''}`;
}

export interface SealingKeySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: Pick<Node, 'id' | 'name' | 'type' | 'mode'> | null;
  /** Confirm fingerprint: Admin only, matching the backend guard. */
  isAdmin: boolean;
  /** Reset pin: node:manage on this node, matching the backend guard. */
  canManage: boolean;
  /** Called after a pin is cleared, so the Nodes table can refresh. */
  onPinCleared?: () => void;
}

/**
 * A node's sealing key: whether the control instance can send it sealed
 * secrets, the fingerprints behind that answer, and the two verbs that change
 * it (Confirm fingerprint, Reset pin). For the local instance it shows this
 * instance's own key, the value an Admin compares on another control instance.
 */
export function SealingKeySheet({ open, onOpenChange, node, isAdmin, canManage, onPinCleared }: SealingKeySheetProps) {
  const key = useNodeSealingKey(node, open && node !== null, onPinCleared);
  const [confirmReset, setConfirmReset] = useState(false);
  const { showBusy: showSkeleton } = useVisualBusy(key.loading && key.view === null);
  const view = key.view;

  const remote = view?.kind === 'remote' ? view : null;
  const canReset = canManage && remote !== null && remote.pinned !== null;
  const mismatch = remote?.readiness === 'key_mismatch';

  const meta = node?.type === 'local'
    ? 'this instance · X25519'
    : `remote · ${node?.mode === 'pilot_agent' ? 'pilot agent' : 'proxy'} · ${remote?.pinned ? 'pinned' : 'not pinned'}`;

  const answerAction = (() => {
    if (!remote) return undefined;
    if (remote.readiness === 'pin_unconfirmed' && isAdmin && remote.presented) {
      const fingerprint = remote.presented.fingerprint;
      return (
        <BusyButton
          size="sm"
          pending={key.pending === 'confirm'}
          busyLabel="Confirming…"
          disabled={key.pending !== null}
          onClick={() => void key.confirm(fingerprint)}
        >
          Confirm fingerprint
        </BusyButton>
      );
    }
    // The resolving verb for a changed key is the reset; the toolbar does not repeat it.
    if (mismatch && canReset) {
      return (
        <Button size="sm" variant="destructive" disabled={key.pending !== null} onClick={() => setConfirmReset(true)}>
          Reset pin
        </Button>
      );
    }
    if (remote.readiness === 'unreachable' || remote.readiness === 'key_invalid') {
      return (
        <BusyButton size="sm" variant="outline" pending={key.pending === 'reload'} busyLabel="Retrying…" disabled={key.pending !== null} onClick={() => void key.reload()}>
          Retry
        </BusyButton>
      );
    }
    return undefined;
  })();

  const answer = view ? sealingKeyAnswer(view, isAdmin) : null;
  const stale = view !== null && key.loadError !== null;

  return (
    <>
      <SystemSheet
        open={open}
        onOpenChange={onOpenChange}
        crumb={['Settings', 'Nodes', 'Sealing key']}
        name={node?.name ?? ''}
        meta={meta}
        destructiveAction={canReset && !mismatch
          ? { label: 'Reset pin', onClick: () => setConfirmReset(true), disabled: key.pending !== null }
          : undefined}
        footerContext={key.readAt !== null ? `Read ${formatTimeAgo(key.readAt)} · not refreshed automatically` : undefined}
        size="md"
      >
        <div data-testid="sealing-key-sheet">
          {!view && key.loadError && (
            <SheetSection title="Status">
              <StatusPath
                stages={[]}
                answer={{
                  tone: 'destructive',
                  status: 'load_failed',
                  title: 'Could not read the sealing key',
                  line: key.loadError,
                  action: (
                    <IconBusyButton
                      size="sm"
                      variant="outline"
                      icon={RefreshCw}
                      label="Retry"
                      pending={key.pending === 'reload'}
                      onClick={() => void key.reload()}
                    />
                  ),
                }}
              />
            </SheetSection>
          )}
          {!view && !key.loadError && (
            <div className="min-h-[180px]" data-testid="sealing-key-loading" aria-busy="true">
              {showSkeleton && (
                <div className="space-y-4">
                  <Skeleton className="h-[68px] w-full" />
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-4/5" />
                </div>
              )}
            </div>
          )}
          {view && answer && (
            <>
              <SheetSection title="Status">
                <StatusPath
                  stages={[]}
                  answer={{
                    ...answer,
                    action: answerAction,
                    detail: stale ? key.loadError : undefined,
                    marker: stale ? 'not refreshed' : undefined,
                  }}
                />
              </SheetSection>
              <SheetSection title="Fingerprint" meta={pinMeta(view) ?? undefined}>
                <Fingerprints view={view} />
              </SheetSection>
            </>
          )}
        </div>
      </SystemSheet>
      <ConfirmModal
        open={confirmReset}
        onOpenChange={setConfirmReset}
        variant="destructive"
        kicker="Nodes · Sealing key"
        title={`Reset the sealing key pin for ${node?.name ?? 'this node'}`}
        description={RESET_PIN_CONSEQUENCE}
        confirmLabel="Reset pin"
        busyConfirmLabel="Resetting…"
        confirming={key.pending === 'reset'}
        onConfirm={async () => {
          await key.reset();
          setConfirmReset(false);
        }}
      >
        <p className="text-sm text-stat-subtitle" data-testid="reset-pin-consequence">{RESET_PIN_CONSEQUENCE}</p>
      </ConfirmModal>
    </>
  );
}
