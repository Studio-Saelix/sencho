import { Ship } from 'lucide-react';
import { ConfirmModal } from '@/components/ui/modal';

interface SelfStackProtectedDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When true, the primary action routes to Fleet node updates. */
  canOpenFleetUpdates: boolean;
  onOpenFleetUpdates?: () => void;
}

export function SelfStackProtectedDialog({
  open,
  onOpenChange,
  canOpenFleetUpdates,
  onOpenFleetUpdates,
}: SelfStackProtectedDialogProps) {
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
        This stack is the running Sencho instance. Use Fleet -&gt; Node Updates to update Sencho
        or reapply its current Compose configuration. To manage it as a normal stack, move
        Sencho&apos;s compose project outside COMPOSE_DIR.
      </p>
    </ConfirmModal>
  );
}
