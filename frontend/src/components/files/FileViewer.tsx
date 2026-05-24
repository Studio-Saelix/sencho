import { useState, useEffect, useMemo, Suspense } from 'react';
import { Editor } from '@/lib/monacoLoader';
import { AlertCircle, FileIcon, Download, Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast-store';
import { readStackFile, writeStackFile, downloadStackFile, FileConflictError } from '@/lib/stackFilesApi';
import { extensionToLanguage } from '@/lib/monacoLanguages';
import { formatBytes } from '@/lib/utils';

interface FileViewerProps {
  stackName: string;
  selectedPath: string | null;
  canEdit: boolean;
  isDarkMode: boolean;
  onSaved?: () => void;
}

function getFilename(path: string): string {
  return path.split('/').pop() ?? path;
}

interface SpecialFilePanelProps {
  filename: string;
  size: number;
  label: string;
  stackName: string;
  relPath: string;
}

function SpecialFilePanel({
  filename,
  size,
  label,
  stackName,
  relPath,
}: SpecialFilePanelProps) {
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const res = await downloadStackFile(stackName, relPath);
      if (!res.ok) {
        toast.error('Download failed.');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 100);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Download failed.');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center gap-4 h-full min-h-[200px] text-muted-foreground">
      <FileIcon className="w-10 h-10 text-stat-icon" strokeWidth={1.25} />
      <div className="text-center space-y-1">
        <p className="font-mono text-sm text-stat-title">{filename}</p>
        <p className="text-xs text-stat-subtitle">{label} &middot; {formatBytes(size)}</p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => void handleDownload()}
        disabled={downloading}
      >
        {downloading ? (
          <Loader2 className="w-4 h-4 mr-1.5 animate-spin" strokeWidth={1.5} />
        ) : (
          <Download className="w-4 h-4 mr-1.5" strokeWidth={1.5} />
        )}
        Download
      </Button>
    </div>
  );
}

export function FileViewer({
  stackName,
  selectedPath,
  canEdit,
  isDarkMode,
  onSaved,
}: FileViewerProps) {
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isBinary, setIsBinary] = useState(false);
  const [isOversized, setIsOversized] = useState(false);
  const [size, setSize] = useState(0);
  const [loadedMtimeMs, setLoadedMtimeMs] = useState<number | null>(null);

  const readOnly = !canEdit;

  const editorOptions = useMemo(
    () => ({
      readOnly,
      minimap: { enabled: false },
      fontFamily: "'Geist Mono', monospace",
      fontSize: 13,
      padding: { top: 8 },
      scrollBeyondLastLine: false,
    }),
    [readOnly],
  );

  useEffect(() => {
    if (!selectedPath) {
      setContent('');
      setOriginalContent('');
      setIsBinary(false);
      setIsOversized(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setIsBinary(false);
    setIsOversized(false);

    readStackFile(stackName, selectedPath)
      .then((result) => {
        if (cancelled) return;
        setSize(result.size);
        setLoadedMtimeMs(result.mtimeMs);
        if (result.binary) {
          setIsBinary(true);
        } else if (result.oversized) {
          setIsOversized(true);
        } else {
          const text = result.content ?? '';
          setContent(text);
          setOriginalContent(text);
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to load file.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [stackName, selectedPath]);

  const handleSave = async () => {
    if (!selectedPath) return;
    setSaving(true);
    const loadingId = toast.loading('Saving...');
    try {
      const result = await writeStackFile(stackName, selectedPath, content, {
        ifMatchMtimeMs: loadedMtimeMs ?? undefined,
      });
      setOriginalContent(content);
      if (result.mtimeMs !== null) setLoadedMtimeMs(result.mtimeMs);
      toast.success('Saved.');
      onSaved?.();
    } catch (e) {
      if (e instanceof FileConflictError) {
        // The server-side content has moved on. Adopt the server snapshot as
        // the new baseline, surface the conflict to the user, and let them
        // re-edit on top of the fresh content. Their unsaved buffer is
        // intentionally preserved in `content` so they can copy / diff before
        // re-saving.
        setOriginalContent(e.currentContent);
        setLoadedMtimeMs(e.currentMtimeMs);
        toast.error('File changed elsewhere. Reload reset the viewer to the current version.');
        setContent(e.currentContent);
      } else {
        toast.error(e instanceof Error ? e.message : 'Save failed.');
      }
    } finally {
      toast.dismiss(loadingId);
      setSaving(false);
    }
  };

  if (!selectedPath) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Select a file to view it
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col h-full p-3 gap-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="flex-1 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 h-full text-muted-foreground">
        <AlertCircle className="w-6 h-6 text-destructive" strokeWidth={1.5} />
        <p className="text-sm text-center px-4">{error}</p>
      </div>
    );
  }

  const filename = getFilename(selectedPath);
  const language = extensionToLanguage(filename);

  if (isBinary) {
    return (
      <SpecialFilePanel
        filename={filename}
        size={size}
        label="Binary file"
        stackName={stackName}
        relPath={selectedPath}
      />
    );
  }

  if (isOversized) {
    return (
      <SpecialFilePanel
        filename={filename}
        size={size}
        label="File too large to preview"
        stackName={stackName}
        relPath={selectedPath}
      />
    );
  }

  const hasChanges = content !== originalContent;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-glass-border shrink-0">
        <span className="font-mono text-xs text-stat-subtitle truncate">{filename}</span>
        <div className="flex items-center gap-2 shrink-0">
          {readOnly && (
            <span className="text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-subtitle border border-border rounded px-1.5 py-0.5">
              Read-only
            </span>
          )}
          {!readOnly && (
            <Button
              size="sm"
              className="h-7"
              onClick={() => void handleSave()}
              disabled={saving || !hasChanges}
            >
              {saving ? (
                <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" strokeWidth={1.5} />
              ) : (
                <Save className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} />
              )}
              Save
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0">
        <Suspense fallback={<div className="w-full h-full" aria-busy="true" />}>
          <Editor
            height="100%"
            language={language}
            value={content}
            onChange={(val) => {
              if (!readOnly) setContent(val ?? '');
            }}
            theme={isDarkMode ? 'vs-dark' : 'light'}
            options={editorOptions}
          />
        </Suspense>
      </div>
    </div>
  );
}
