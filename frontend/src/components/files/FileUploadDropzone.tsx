import { useRef, useState } from 'react';
import { UploadCloud } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast-store';
import { uploadStackFile } from '@/lib/stackFilesApi';

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
  const [isOver, setIsOver] = useState(false);

  if (!canEdit) return null;

  const handleFile = async (file: File) => {
    if (file.size > MAX_BYTES) {
      toast.error('File exceeds 25 MB.');
      return;
    }
    const loadingId = toast.loading(`Uploading ${file.name}...`);
    try {
      await uploadStackFile(stackName, currentDir, file);
      toast.success('Uploaded.');
      onUploaded();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Upload failed.');
    } finally {
      toast.dismiss(loadingId);
    }
  };

  const handleChange = (ev: React.ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    if (file) void handleFile(file);
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
    </>
  );
}
