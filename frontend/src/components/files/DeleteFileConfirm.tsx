import { useState, useEffect } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Modal, ModalDestructiveHeader, ModalBody, ModalFooter } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast-store';
import { deleteStackPath } from '@/lib/stackFilesApi';
import type { FileEntry } from '@/lib/stackFilesApi';

interface DeleteFileConfirmProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stackName: string;
  relPath: string;
  entry: FileEntry | null;
  rootId?: string;
  onDeleted: () => void;
}

export function DeleteFileConfirm({
  open,
  onOpenChange,
  stackName,
  relPath,
  entry,
  rootId,
  onDeleted,
}: DeleteFileConfirmProps) {
  const [deleting, setDeleting] = useState(false);
  const [confirmInput, setConfirmInput] = useState('');
  const [notEmpty, setNotEmpty] = useState(false);

  const isProtected = entry?.isProtected ?? false;
  const entryName = entry?.name ?? '';

  useEffect(() => {
    if (!open) {
      setConfirmInput('');
      setNotEmpty(false);
    }
  }, [open]);

  const handleClose = (next: boolean) => {
    if (deleting) return;
    onOpenChange(next);
  };

  const executeDelete = async (recursive: boolean) => {
    setDeleting(true);
    try {
      await deleteStackPath(stackName, relPath, recursive || undefined, rootId);
      onDeleted();
      onOpenChange(false);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Delete failed.';
      if (!recursive && msg.toUpperCase().includes('NOT_EMPTY')) {
        setNotEmpty(true);
      } else {
        toast.error(msg);
      }
    } finally {
      setDeleting(false);
    }
  };

  const handleDelete = () => void executeDelete(notEmpty);

  const protectedOk = !isProtected || confirmInput === entryName;

  const deleteLabel = notEmpty ? 'Delete all' : 'Delete';

  const titleNode = entryName ? (
    <>
      Delete <em className="font-display italic text-destructive">{entryName}</em>?
    </>
  ) : (
    'Delete item?'
  );

  return (
    <Modal open={open} onOpenChange={handleClose} size="sm">
      <ModalDestructiveHeader
        kicker={`${stackName.toUpperCase()} · DELETE · IRREVERSIBLE`}
        title={titleNode}
        description={`Confirm deletion of ${entryName || 'item'} from ${stackName}.`}
      />
      <ModalBody>
        {notEmpty ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
            <span>This folder is not empty. Delete everything inside?</span>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">This action cannot be undone.</p>
        )}

        {isProtected && (
          <div className="space-y-2">
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
              <p>This is a critical stack file. Type the filename to confirm.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="delete-confirm-input" className="text-xs">
                Type <span className="font-mono">{entryName}</span> to confirm
              </Label>
              <Input
                id="delete-confirm-input"
                value={confirmInput}
                onChange={(e) => setConfirmInput(e.target.value)}
                placeholder={entryName}
                disabled={deleting}
                autoFocus
              />
            </div>
          </div>
        )}
      </ModalBody>
      <ModalFooter
        hint={isProtected ? 'PROTECTED FILE' : notEmpty ? 'NON-EMPTY FOLDER' : undefined}
        secondary={
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleClose(false)}
            disabled={deleting}
          >
            Cancel
          </Button>
        }
        primary={
          <Button
            variant="destructive"
            size="sm"
            data-testid="delete-confirm-btn"
            onClick={handleDelete}
            disabled={deleting || !protectedOk}
          >
            {deleting && (
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" strokeWidth={1.5} />
            )}
            {deleteLabel}
          </Button>
        }
      />
    </Modal>
  );
}
