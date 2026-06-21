import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast-store';
import { mkdirStackPath } from '@/lib/stackFilesApi';

interface NewFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stackName: string;
  currentDir: string;
  rootId?: string;
  onCreated: () => void;
}

function isValidFolderName(name: string): boolean {
  if (!name || name === '.' || name === '..') return false;
  return /^[^/\\]+$/.test(name);
}

export function NewFolderDialog({
  open,
  onOpenChange,
  stackName,
  currentDir,
  rootId,
  onCreated,
}: NewFolderDialogProps) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleClose = (next: boolean) => {
    if (creating) return;
    onOpenChange(next);
    if (!next) {
      setName('');
      setValidationError(null);
    }
  };

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!isValidFolderName(trimmed)) {
      setValidationError('Folder name must not be empty, and must not contain / or \\.');
      return;
    }
    setValidationError(null);
    setCreating(true);
    const relPath = currentDir ? `${currentDir}/${trimmed}` : trimmed;
    try {
      await mkdirStackPath(stackName, relPath, rootId);
      toast.success('Folder created.');
      onCreated();
      onOpenChange(false);
      setName('');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create folder.');
    } finally {
      setCreating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') void handleCreate();
  };

  const parentLabel = currentDir || stackName;

  return (
    <Modal open={open} onOpenChange={handleClose} size="sm">
      <ModalHeader
        kicker={`${stackName.toUpperCase()} · NEW FOLDER`}
        title="New folder"
        description="Enter a name for the new folder."
      />
      <ModalBody>
        <div className="space-y-1.5">
          <Label htmlFor="folder-name">Folder name</Label>
          <Input
            id="folder-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setValidationError(null);
            }}
            onKeyDown={handleKeyDown}
            placeholder="my-folder"
            disabled={creating}
            autoFocus
          />
          {validationError && (
            <p className="text-xs text-destructive">{validationError}</p>
          )}
        </div>
      </ModalBody>
      <ModalFooter
        hint="PARENT"
        hintAccent={parentLabel}
        secondary={
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleClose(false)}
            disabled={creating}
          >
            Cancel
          </Button>
        }
        primary={
          <Button
            size="sm"
            onClick={() => void handleCreate()}
            disabled={creating || !name.trim()}
          >
            {creating && (
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" strokeWidth={1.5} />
            )}
            Create
          </Button>
        }
      />
    </Modal>
  );
}
