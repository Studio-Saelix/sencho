import { RefreshCw, Ship } from 'lucide-react';
import { ConfirmModal } from '@/components/ui/modal';

interface SelfStackProtectedDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Present only for a caller who can reapply: confirming reapplies Sencho from
   * its current Compose configuration. The handler closes the dialog itself, so
   * a confirmation it cannot act on yet (the node is not ready) stays open.
   */
  onReapply?: () => void;
  /** When true (and the caller cannot reapply), the primary action routes to Fleet node updates. */
  canOpenFleetUpdates: boolean;
  onOpenFleetUpdates?: () => void;
}

export function SelfStackProtectedDialog({
  open,
  onOpenChange,
  onReapply,
  canOpenFleetUpdates,
  onOpenFleetUpdates,
}: SelfStackProtectedDialogProps) {
  if (onReapply) {
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
        onConfirm={onReapply}
      >
        <p className="text-sm text-stat-subtitle">
          This stack is the running Sencho instance, so anything that would stop
          or recreate it (Deploy, Update, Stop, Take down, Delete, Rollback) is
          blocked on it. Reapply recreates Sencho from its current Compose
          configuration. No newer version is selected and the configured image
          reference is not rewritten. The dashboard briefly disconnects and
          reconnects automatically when the restart completes.
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
