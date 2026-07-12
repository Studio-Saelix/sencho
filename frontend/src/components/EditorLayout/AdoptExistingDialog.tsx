import { Modal, ModalHeader } from '../ui/modal';
import { ImportStackPanel } from './ImportStackPanel';

export interface AdoptExistingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStacksChanged: () => void | Promise<void>;
}

export function AdoptExistingDialog({ open, onOpenChange, onStacksChanged }: AdoptExistingDialogProps) {
  return (
    <Modal size="xl" open={open} onOpenChange={onOpenChange}>
      <ModalHeader
        kicker="STACKS · ADOPT"
        title="Adopt existing files"
        description="Compose files that are not in their own subfolder yet. Preview services, then move each one into place so Sencho can manage it."
      />
      <ImportStackPanel
        onClose={() => onOpenChange(false)}
        onImported={() => { void onStacksChanged(); }}
      />
    </Modal>
  );
}
