import { RefreshCw, Ship } from 'lucide-react';
import { ConfirmModal } from '@/components/ui/modal';

interface SelfStackProtectedDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When true, confirming reapplies Sencho from its current Compose configuration. */
  canReapply: boolean;
  onReapply?: () => void;
  /** When true (and the caller cannot reapply), the primary action routes to Fleet node updates. */
  canOpenFleetUpdates: boolean;
  onOpenFleetUpdates?: () => void;
}

export function SelfStackProtectedDialog({
  open,
  onOpenChange,
  canReapply,
  onReapply,
  canOpenFleetUpdates,
  onOpenFleetUpdates,
}: SelfStackProtectedDialogProps) {
  if (canReapply && onReapply) {
    return (
      <ConfirmModal
        open={open}
        onOpenChange={onOpenChange}
        kicker="SELF STACK"
        title="Reapply Sencho"
        confirmLabel={
          <>
            <RefreshCw className="w-4 h-4 mr-1.5" strokeWidth={1.5} />
            Reapply &amp; restart
          </>
        }
        onConfirm={() => {
          onOpenChange(false);
          onReapply();
        }}
      >
        <p className="text-sm text-stat-subtitle">
          This stack is the running Sencho instance, so Deploy, Stop, and Update are
          blocked on it. Reapply recreates Sencho from its current Compose
          configuration. The dashboard briefly disconnects and reconnects
          automatically when the restart completes.
        </p>
      </ConfirmModal>
    );
  }

  return (
    <ConfirmModal
      open={open}
      onOpenChange={onOpenChange}
      kicker="SELF STACK"
      title="Sencho instance protected"
      cancelLabel="Close"
      confirmLabel={
        canOpenFleetUpdates ? (
          <>
            <Ship className="w-4 h-4 mr-1.5" strokeWidth={1.5} />
            Open Fleet node updates
          </>
        ) : (
          'Got it'
        )
      }
      onConfirm={() => {
        if (canOpenFleetUpdates && onOpenFleetUpdates) {
          onOpenFleetUpdates();
        }
        onOpenChange(false);
      }}
    >
      <p className="text-sm text-stat-subtitle">
        This stack is the running Sencho instance. Destructive lifecycle actions
        stay protected. Eligible admins can use Save &amp; Reapply in the Compose
        editor, or Fleet -&gt; Node Updates, to recreate Sencho from its current
        Compose configuration. To manage it as a normal stack, move Sencho&apos;s
        compose project outside COMPOSE_DIR.
      </p>
    </ConfirmModal>
  );
}
