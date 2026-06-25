import { useRef, useState } from 'react';
import { UploadCloud } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ConfirmModal } from '@/components/ui/modal';
import { toast } from '@/components/ui/toast-store';
import { uploadStackFile, UploadConflictError } from '@/lib/stackFilesApi';

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

interface FileUploadDropzoneProps {
  stackName: string;
  currentDir: string;
  canEdit: boolean;
  rootId?: string;
  onUploaded: () => void;
}

export function FileUploadDropzone({
  stackName,
  currentDir,
  canEdit,
  rootId,
  onUploaded,
}: FileUploadDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isOver, setIsOver] = useState(false);
  const [conflict, setConflict] = useState<File | null>(null);

  if (!canEdit) return null;

  const runUpload = async (file: File, overwrite: boolean): Promise<void> => {
    const loadingId = toast.loading(`Uploading ${file.name}...`);
    try {
      await uploadStackFile(stackName, currentDir, file, { overwrite, rootId });
      toast.success(overwrite ? 'Replaced.' : 'Uploaded.');
      onUploaded();
    } catch (e: unknown) {
      if (e instanceof UploadConflictError) {
        setConflict(file);
        return;
      }
      toast.error(e instanceof Error ? e.message : 'Upload failed.');
    } finally {
      toast.dismiss(loadingId);
    }
  };

  const handleFile = (file: File) => {
    if (file.size > MAX_BYTES) {
      toast.error('File exceeds 25 MB.');
      return;
    }
    void runUpload(file, false);
  };

  const handleChange = (ev: React.ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    if (file) handleFile(file);
    ev.target.value = '';
  };

  const handleDragOver = (ev: React.DragEvent<HTMLDivElement>) => {
    if (!ev.dataTransfer.types.includes('Files')) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
    if (!isOver) setIsOver(true);
  };

  const handleDragLeave = (ev: React.DragEvent<HTMLDivElement>) => {
    // Ignore leave events that bubble from child elements still within the
    // dropzone (relatedTarget is contained by currentTarget); only react when
    // the cursor truly leaves the zone.
    const next = ev.relatedTarget;
    if (next instanceof Node && ev.currentTarget.contains(next)) return;
    setIsOver(false);
  };

  const handleDrop = (ev: React.DragEvent<HTMLDivElement>) => {
    ev.preventDefault();
    setIsOver(false);
    const files = ev.dataTransfer.files;
    if (!files || files.length === 0) return;
    if (files.length > 1) {
      toast.error('Drop one file at a time.');
      return;
    }
    void handleFile(files[0]);
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        onChange={handleChange}
        aria-label="Upload file"
      />
      <div
        role="button"
        tabIndex={0}
        className={cn(
          'border border-dashed rounded-md p-2 text-xs flex items-center gap-2 cursor-pointer transition-colors',
          isOver
            ? 'border-brand bg-brand/10 text-brand'
            : 'border-border text-muted-foreground hover:border-brand/50',
        )}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <UploadCloud className="w-3.5 h-3.5 shrink-0" strokeWidth={1.5} />
        {isOver ? 'Drop to upload' : 'Upload or drop file'}
      </div>

      <ConfirmModal
        open={conflict !== null}
        onOpenChange={(next) => { if (!next) setConflict(null); }}
        onCancel={() => setConflict(null)}
        kicker="FILES · REPLACE EXISTING"
        title="Replace existing file?"
        description={conflict ? `${conflict.name} already exists in this folder.` : ''}
        confirmLabel="Replace"
        onConfirm={() => {
          const file = conflict;
          setConflict(null);
          if (file) void runUpload(file, true);
        }}
      >
        <p className="text-sm text-muted-foreground">
          {conflict?.name ?? 'The file'} already exists. Replacing it overwrites the current contents and cannot be undone.
        </p>
      </ConfirmModal>
    </>
  );
}
