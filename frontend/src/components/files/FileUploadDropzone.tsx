import { useRef } from 'react';
import { UploadCloud } from 'lucide-react';
import { toast } from '@/components/ui/toast-store';
import { useLicense } from '@/context/LicenseContext';
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
  const { isPaid } = useLicense();
  const inputRef = useRef<HTMLInputElement>(null);

  if (!isPaid || !canEdit) return null;

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
    </>
  );
}
