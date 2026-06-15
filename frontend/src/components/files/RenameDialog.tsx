import { useState, useEffect } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast-store';
import { renameStackPath, isProtectedRootRelPath } from '@/lib/stackFilesApi';

function isValidName(name: string): boolean {
  if (!name || name === '.' || name === '..') return false;
  return /^[^/\\]+$/.test(name);
}

interface RenameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stackName: string;
  /** Full relative path of the entry to rename, e.g. "configs/my-file.conf" */
  relPath: string;
  /** Current basename of the entry */
  currentName: string;
  onRenamed: () => void;
}

export function RenameDialog({
  open,
  onOpenChange,
  stackName,
  relPath,
  currentName,
  onRenamed,
}: RenameDialogProps) {
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(currentName);
      setValidationError(null);
    }
  }, [open, currentName]);

  const handleClose = (next: boolean) => {
    if (renaming) return;
    onOpenChange(next);
  };

  const handleRename = async () => {
    const trimmed = name.trim();
    if (!isValidName(trimmed)) {
      setValidationError('Name must not be empty and must not contain / or \\.');
      return;
    }
    if (trimmed === currentName) {
      onOpenChange(false);
      return;
    }
    setValidationError(null);
    setRenaming(true);
    const parentDir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
    const toRel = parentDir ? `${parentDir}/${trimmed}` : trimmed;
    try {
      await renameStackPath(stackName, relPath, toRel);
      toast.success('Renamed successfully.');
      onRenamed();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Rename failed.');
    } finally {
      setRenaming(false);
    }
  };

  const isProtected = isProtectedRootRelPath(relPath);

  return (
    <Modal open={open} onOpenChange={handleClose} size="sm">
      <ModalHeader
        kicker={`${stackName.toUpperCase()} · RENAME`}
        title="Rename"
        description={`Enter a new name for ${currentName}.`}
      />
      <ModalBody>
        {isProtected && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-500 mb-3">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
            <span>This is a critical stack file. Renaming it may break the stack.</span>
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="rename-input">New name</Label>
          <Input
            id="rename-input"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setValidationError(null);
            }}
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleRename(); }}
            disabled={renaming}
            autoFocus
          />
          {validationError && (
            <p className="text-xs text-destructive">{validationError}</p>
          )}
        </div>
      </ModalBody>
      <ModalFooter
        secondary={
          <Button variant="outline" size="sm" onClick={() => handleClose(false)} disabled={renaming}>
            Cancel
          </Button>
        }
        primary={
          <Button
            size="sm"
            onClick={() => void handleRename()}
            disabled={renaming || !name.trim() || name.trim() === currentName}
          >
            {renaming && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" strokeWidth={1.5} />}
            Rename
          </Button>
        }
      />
    </Modal>
  );
}
