import { useState, useEffect, useMemo, useRef, Suspense } from 'react';
import { Editor } from '@/lib/monacoLoader';
import { AlertCircle, FileIcon, Download, Loader2, Save, WrapText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast-store';
import { readStackFile, writeStackFile, downloadStackFile, FileConflictError } from '@/lib/stackFilesApi';
import { extensionToLanguage } from '@/lib/monacoLanguages';
import { cn, formatBytes } from '@/lib/utils';

const WORD_WRAP_KEY = 'sencho.fileViewer.wordWrap';

interface FileViewerProps {
  stackName: string;
  selectedPath: string | null;
  canEdit: boolean;
  isDarkMode: boolean;
  /** The selected file root; undefined/`stack-source` is the legacy behaviour. */
  rootId?: string;
  onSaved?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

function getFilename(path: string): string {
  return path.split('/').pop() ?? path;
}

/** Build the fs version token from a millisecond mtime, for a server response that omits `version`. */
function fsVersionFromMtime(mtimeMs: number | undefined): string | undefined {
  return typeof mtimeMs === 'number' ? `W/"${Math.floor(mtimeMs)}"` : undefined;
}

interface SpecialFilePanelProps {
  filename: string;
  size: number;
  label: string;
  stackName: string;
  relPath: string;
  rootId?: string;
  extraAction?: { label: string; onClick: () => void; disabled?: boolean };
}

function SpecialFilePanel({
  filename,
  size,
  label,
  stackName,
  relPath,
  rootId,
  extraAction,
}: SpecialFilePanelProps) {
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const res = await downloadStackFile(stackName, relPath, rootId);
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
      <div className="flex items-center gap-2">
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
        {extraAction && (
          <Button
            variant="ghost"
            size="sm"
            onClick={extraAction.onClick}
            disabled={extraAction.disabled}
          >
            {extraAction.label}
          </Button>
        )}
      </div>
    </div>
  );
}

export function FileViewer({
  stackName,
  selectedPath,
  canEdit,
  isDarkMode,
  rootId,
  onSaved,
  onDirtyChange,
}: FileViewerProps) {
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isBinary, setIsBinary] = useState(false);
  const [isOversized, setIsOversized] = useState(false);
  const [size, setSize] = useState(0);
  const [loadedVersion, setLoadedVersion] = useState<string | null>(null);

  const readOnly = !canEdit;
  const hasChanges = content !== originalContent;

  // Word wrap, persisted across files and sessions. Defaults on so wide files
  // do not require horizontal scrolling; only an explicit 'false' disables it.
  const [wordWrap, setWordWrap] = useState(() => {
    try { return localStorage.getItem(WORD_WRAP_KEY) !== 'false'; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem(WORD_WRAP_KEY, String(wordWrap)); } catch { /* ignore */ }
  }, [wordWrap]);

  // Stash the latest callback in a ref so the unmount-cleanup effect can be
  // truly unmount-scoped without re-running every time a parent passes a fresh
  // function identity.
  const onDirtyChangeRef = useRef(onDirtyChange);
  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  }, [onDirtyChange]);

  // Mirror selectedPath into a ref so async handlers fired from button clicks
  // (handleForceText) can detect a stale response after the user has already
  // navigated to a different file. A slow override for file A must not stomp
  // on file B's state.
  const selectedPathRef = useRef(selectedPath);
  useEffect(() => {
    selectedPathRef.current = selectedPath;
  }, [selectedPath]);

  useEffect(() => {
    onDirtyChangeRef.current?.(hasChanges);
  }, [hasChanges]);

  useEffect(() => {
    return () => onDirtyChangeRef.current?.(false);
  }, []);

  const editorOptions = useMemo(
    () => ({
      readOnly,
      minimap: { enabled: false },
      fontFamily: "'Geist Mono', monospace",
      fontSize: 13,
      padding: { top: 8 },
      scrollBeyondLastLine: false,
      wordWrap: wordWrap ? ('on' as const) : ('off' as const),
    }),
    [readOnly, wordWrap],
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

    readStackFile(stackName, selectedPath, { rootId })
      .then((result) => {
        if (cancelled) return;
        setSize(result.size);
        setLoadedVersion(result.version ?? fsVersionFromMtime(result.mtimeMs) ?? null);
        // Check oversized BEFORE binary: the backend returns oversized:true
        // for files past the 2 MB inline-preview cap regardless of the binary
        // probe, and the body intentionally carries no content for those
        // files. Showing the binary panel for an oversized file would hide
        // the size signal and offer an override that resolves to an empty
        // editor (the backend keeps the oversized-no-content contract even
        // when force=text is set).
        if (result.oversized) {
          setIsOversized(true);
        } else if (result.binary) {
          setIsBinary(true);
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
  }, [stackName, selectedPath, rootId]);

  const handleSave = async () => {
    if (!selectedPath) return;
    setSaving(true);
    const loadingId = toast.loading('Saving...');
    try {
      const result = await writeStackFile(stackName, selectedPath, content, {
        ifMatchVersion: loadedVersion ?? undefined,
        rootId,
      });
      setOriginalContent(content);
      if (result.version !== null) setLoadedVersion(result.version);
      toast.success('Saved.');
      onSaved?.();
    } catch (e) {
      if (e instanceof FileConflictError) {
        // The server-side content has moved on. Update the baseline (so the
        // next save sends the fresh version token and stops looping on the same
        // precondition) but leave the user's typed buffer untouched. Their
        // edits remain in the editor, Save stays enabled, and a follow-up
        // click will apply their changes on top of the new server content
        // without silently destroying what they typed.
        setOriginalContent(e.currentContent);
        setLoadedVersion(e.currentVersion);
        toast.error('File changed elsewhere. Review your edits then save again to apply them on top of the current version.');
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
    const handleForceText = async () => {
      const requestedPath = selectedPath;
      setLoading(true);
      setError(null);
      try {
        const result = await readStackFile(stackName, requestedPath, { forceText: true, rootId });
        // Stale-request guard: the user may have navigated to a different
        // file while the override request was in flight. Drop the response
        // rather than stomp on the new file's state.
        if (selectedPathRef.current !== requestedPath) return;
        setSize(result.size);
        setLoadedVersion(result.version ?? fsVersionFromMtime(result.mtimeMs) ?? null);
        if (result.oversized) {
          // Backend keeps oversized files out of the inline editor even with
          // force=text set; the body has no content. Surface the Download
          // panel so the user does not get an empty Monaco buffer that they
          // could accidentally save back over the file.
          setIsBinary(false);
          setIsOversized(true);
        } else {
          const text = result.content ?? '';
          setContent(text);
          setOriginalContent(text);
          setIsBinary(false);
        }
      } catch (e) {
        if (selectedPathRef.current !== requestedPath) return;
        const message = e instanceof Error ? e.message : 'Failed to load file as text.';
        setError(message);
        toast.error(message);
      } finally {
        if (selectedPathRef.current === requestedPath) setLoading(false);
      }
    };
    return (
      <SpecialFilePanel
        filename={filename}
        size={size}
        label="Binary file"
        stackName={stackName}
        relPath={selectedPath}
        rootId={rootId}
        extraAction={{
          label: 'Open as text anyway',
          onClick: () => void handleForceText(),
        }}
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
        rootId={rootId}
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-glass-border shrink-0">
        <span className="font-mono text-xs text-stat-subtitle truncate">{filename}</span>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            size="sm"
            variant="ghost"
            className={cn('h-7 w-7 p-0', wordWrap ? 'text-brand' : 'text-stat-subtitle')}
            onClick={() => setWordWrap((v) => !v)}
            aria-pressed={wordWrap}
            title={wordWrap ? 'Word wrap on' : 'Word wrap off'}
            aria-label={wordWrap ? 'Disable word wrap' : 'Enable word wrap'}
          >
            <WrapText className="w-3.5 h-3.5" strokeWidth={1.5} />
          </Button>
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
