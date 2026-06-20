import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast-store';
import { writeStackFile } from '@/lib/stackFilesApi';

function isValidFileName(name: string): boolean {
  if (!name || name === '.' || name === '..') return false;
  return /^[^/\\]+$/.test(name);
}

interface NewFileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stackName: string;
  /** Directory within the stack where the file will be created */
  currentDir: string;
  rootId?: string;
  onCreated: () => void;
}

export function NewFileDialog({
  open,
  onOpenChange,
  stackName,
  currentDir,
  rootId,
  onCreated,
}: NewFileDialogProps) {
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
    if (!isValidFileName(trimmed)) {
      setValidationError('File name must not be empty and must not contain / or \\.');
      return;
    }
    setValidationError(null);
    setCreating(true);
    const relPath = currentDir ? `${currentDir}/${trimmed}` : trimmed;
    try {
      await writeStackFile(stackName, relPath, '', { rootId });
      toast.success('File created.');
      onCreated();
      onOpenChange(false);
      setName('');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create file.');
    } finally {
      setCreating(false);
    }
  };

  const parentLabel = currentDir || stackName;

  return (
    <Modal open={open} onOpenChange={handleClose} size="sm">
      <ModalHeader
        kicker={`${stackName.toUpperCase()} · NEW FILE`}
        title="New file"
        description="Enter a name for the new file."
      />
      <ModalBody>
        <div className="space-y-1.5">
          <Label htmlFor="new-file-name">File name</Label>
          <Input
            id="new-file-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setValidationError(null);
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate(); }}
            placeholder="config.yaml"
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
          <Button variant="outline" size="sm" onClick={() => handleClose(false)} disabled={creating}>
            Cancel
          </Button>
        }
        primary={
          <Button
            size="sm"
            onClick={() => void handleCreate()}
            disabled={creating || !name.trim()}
          >
            {creating && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" strokeWidth={1.5} />}
            Create
          </Button>
        }
      />
    </Modal>
  );
}
