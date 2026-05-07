import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { SystemSheet } from '@/components/ui/system-sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast-store';
import { FileTree } from '@/components/files/FileTree';
import type { FileEntry } from '@/lib/stackFilesApi';
import { listVolumeDirectory, readVolumeFile } from '@/lib/volumeApi';
import type { VolumeFileResult } from '@/lib/volumeApi';
import { formatBytes } from '@/lib/utils';

interface VolumeBrowserSheetProps {
  volumeName: string | null;
  onClose: () => void;
}

export function VolumeBrowserSheet({ volumeName, onClose }: VolumeBrowserSheetProps) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedPath, setSelectedPath] = useState<string>('');
  const [fileLoading, setFileLoading] = useState(false);
  const [fileResult, setFileResult] = useState<VolumeFileResult | null>(null);
  // Generation counter so a slow read for a stale (volume, path) selection
  // cannot stomp the visible result after the user has moved on.
  const readGenerationRef = useRef(0);

  useEffect(() => {
    // Cancel any in-flight read when the volume context changes.
    readGenerationRef.current += 1;
  }, [volumeName]);

  const handleSelectFile = useCallback(async (relPath: string) => {
    if (!volumeName) return;
    const generation = ++readGenerationRef.current;
    const targetVolume = volumeName;
    setSelectedPath(relPath);
    setFileLoading(true);
    setFileResult(null);
    try {
      const result = await readVolumeFile(targetVolume, relPath);
      if (readGenerationRef.current !== generation) return;
      setFileResult(result);
    } catch (err: unknown) {
      if (readGenerationRef.current !== generation) return;
      const msg = err instanceof Error ? err.message : 'Failed to read file.';
      toast.error(msg);
    } finally {
      if (readGenerationRef.current === generation) setFileLoading(false);
    }
  }, [volumeName]);

  const handleClose = (open: boolean) => {
    if (!open) {
      setSelectedPath('');
      setFileResult(null);
      setFileLoading(false);
      onClose();
    }
  };

  const loadDir = useCallback(
    (relPath: string) => {
      if (!volumeName) return Promise.resolve<FileEntry[]>([]);
      return listVolumeDirectory(volumeName, relPath);
    },
    [volumeName]
  );

  const meta = selectedPath || 'No file selected';

  return (
    <SystemSheet
      open={!!volumeName}
      onOpenChange={handleClose}
      crumb={['Resources', 'Volumes', volumeName ?? '—']}
      name={volumeName ?? 'Volume'}
      meta={meta}
      primaryAction={{
        label: 'Refresh tree',
        icon: RefreshCw,
        onClick: () => setRefreshKey((k) => k + 1),
      }}
      footerContext="File reads are recorded in the audit log."
      size="lg"
      noScroll
    >
      {volumeName && (
        <div className="grid grid-cols-[260px_1fr] gap-3 px-6 py-5 flex-1 min-h-0">
          <div className="rounded-md border border-card-border bg-card overflow-hidden">
            <FileTree
              key={`${volumeName}:${refreshKey}`}
              sourceKey={volumeName}
              loadDir={loadDir}
              refreshKey={refreshKey}
              selectedPath={selectedPath}
              onSelectFile={handleSelectFile}
            />
          </div>

          <div className="rounded-md border border-card-border bg-card overflow-hidden flex flex-col">
            {!selectedPath && (
              <div className="flex-1 flex items-center justify-center p-6 text-xs text-muted-foreground italic">
                Select a file to preview.
              </div>
            )}
            {selectedPath && fileLoading && (
              <div className="p-3 space-y-2">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
              </div>
            )}
            {selectedPath && !fileLoading && fileResult && (
              <FileResultPanel path={selectedPath} result={fileResult} />
            )}
          </div>
        </div>
      )}
    </SystemSheet>
  );
}

function FileResultPanel({ path, result }: { path: string; result: VolumeFileResult }) {
  const decoded = result.binary ? base64ToHex(result.content) : result.content;
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-card-border">
        <span className="font-mono text-[11px] text-muted-foreground truncate" title={path}>{path}</span>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {formatBytes(result.size)}{result.binary ? ' · binary' : ''}{result.truncated ? ' · truncated' : ''}
        </span>
      </div>
      {result.truncated && (
        <div className="px-3 py-1.5 text-[11px] text-warning bg-warning/10 border-b border-card-border">
          Showing first {formatBytes(5 * 1024 * 1024)}. Larger files cannot be downloaded from this view.
        </div>
      )}
      <ScrollArea className="flex-1">
        <pre className="p-3 font-mono text-[11px] whitespace-pre-wrap break-all leading-relaxed">
          {decoded}
        </pre>
      </ScrollArea>
    </div>
  );
}

function base64ToHex(b64: string): string {
  try {
    const binary = atob(b64);
    const out: string[] = [];
    for (let i = 0; i < binary.length; i += 16) {
      const offset = i.toString(16).padStart(8, '0');
      const chunk = binary.slice(i, i + 16);
      const hex = Array.from(chunk).map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ');
      const ascii = Array.from(chunk).map((c) => {
        const code = c.charCodeAt(0);
        return code >= 32 && code <= 126 ? c : '.';
      }).join('');
      out.push(`${offset}  ${hex.padEnd(48, ' ')}  ${ascii}`);
    }
    return out.join('\n');
  } catch {
    return '(unable to decode binary content)';
  }
}
