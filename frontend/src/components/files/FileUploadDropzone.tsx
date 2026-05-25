import { useRef, useState } from 'react';
import { UploadCloud } from 'lucide-react';
import { ConfirmModal } from '@/components/ui/modal';
import { toast } from '@/components/ui/toast-store';
import { uploadStackFile, UploadConflictError } from '@/lib/stackFilesApi';

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

interface FileUploadDropzoneProps {
  stackName: string;
  currentDir: string;
  canEdit: boolean;
  onUploaded: () => void;
}

export function FileUploadDropzone({
  stackName,
  currentDir,
  canEdit,
  onUploaded,
}: FileUploadDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [conflict, setConflict] = useState<File | null>(null);

  if (!canEdit) return null;

  const runUpload = async (file: File, overwrite: boolean): Promise<void> => {
    const loadingId = toast.loading(`Uploading ${file.name}...`);
    try {
      await uploadStackFile(stackName, currentDir, file, { overwrite });
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
        className="border border-dashed border-border rounded-md p-2 text-xs text-muted-foreground flex items-center gap-2 cursor-pointer hover:border-brand/50 transition-colors"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
      >
        <UploadCloud className="w-3.5 h-3.5 shrink-0" strokeWidth={1.5} />
        Upload file
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
