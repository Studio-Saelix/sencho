import { useState, useEffect, useRef, Fragment } from 'react';
import type { ReactNode, DragEvent } from 'react';
import { Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast-store';
import {
  readFileEntryDragPayload,
  relPathParentDir,
  type FileEntry,
} from '@/lib/stackFilesApi';
import { FileTreeNode } from './FileTreeNode';
import { cn } from '@/lib/utils';

interface FileTreeProps {
  /** Loads directory contents at `relPath` (use '' for the tree root). */
  loadDir: (relPath: string) => Promise<FileEntry[]>;
  /** Stable identity for the source. Changing it remounts the tree. */
  sourceKey: string;
  refreshKey?: number;
  selectedPath: string;
  onSelectFile: (relPath: string, entry: FileEntry) => void;
  onNavigateToCompose?: () => void;
  onNavigateToEnv?: () => void;
  /** When true (stack source only), clicking compose/.env redirects to their
   *  dedicated editors. For volume roots a file named .env is just an ordinary
   *  file and opens in the viewer. */
  redirectProtected?: boolean;
  // Context menu wiring
  canEdit?: boolean;
  onContextMenuRename?: (relPath: string) => void;
  onContextMenuMove?: (relPath: string, entry: FileEntry) => void;
  onContextMenuDuplicate?: (relPath: string, entry: FileEntry) => void;
  onContextMenuCopy?: (relPath: string, entry: FileEntry) => void;
  onContextMenuNewFile?: (dirRelPath: string) => void;
  onContextMenuNewFolder?: (dirRelPath: string) => void;
  onContextMenuDelete?: (relPath: string, entry: FileEntry) => void;
  onContextMenuPermissions?: (relPath: string, entry: FileEntry) => void;
  /** Relocate `fromRel` into `destDir` (''=stack root) via drag-and-drop. */
  onMove?: (fromRel: string, entryName: string, destDir: string) => void;
}

const COMPOSE_NAMES = new Set(['compose.yaml', 'compose.yml']);
const ENV_NAMES = new Set(['.env']);
// The server caps the response at 1000 entries and exposes the unfiltered
// total via X-Total-Count; matching the client guard means a perfectly-sized
// directory never shows the truncation hint.
const MAX_ENTRIES = 1000;

export function FileTree({
  loadDir,
  sourceKey,
  refreshKey,
  selectedPath,
  onSelectFile,
  onNavigateToCompose,
  onNavigateToEnv,
  redirectProtected = true,
  canEdit = false,
  onContextMenuRename = () => undefined,
  onContextMenuMove = () => undefined,
  onContextMenuDuplicate = () => undefined,
  onContextMenuCopy = () => undefined,
  onContextMenuNewFile = () => undefined,
  onContextMenuNewFolder = () => undefined,
  onContextMenuDelete = () => undefined,
  onContextMenuPermissions = () => undefined,
  onMove = () => undefined,
}: FileTreeProps) {
  const [rootEntries, setRootEntries] = useState<FileEntry[] | null>(null);
  const [rootLoading, setRootLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [dirContents, setDirContents] = useState<Map<string, FileEntry[]>>(new Map());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [isRootDropTarget, setIsRootDropTarget] = useState(false);

  // The scroll area is the stack-root drop target. Folder nodes stop propagation
  // on their own drops, so an event only reaches here when it lands on a file
  // row or empty space. A root-level entry dropped here is a no-op and ignored.
  function handleRootDragOver(e: DragEvent) {
    if (!canEdit) return;
    const payload = readFileEntryDragPayload(e.dataTransfer);
    if (!payload || relPathParentDir(payload.relPath) === '') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!isRootDropTarget) setIsRootDropTarget(true);
  }

  function handleRootDrop(e: DragEvent) {
    if (!canEdit) return;
    const payload = readFileEntryDragPayload(e.dataTransfer);
    setIsRootDropTarget(false);
    if (!payload || relPathParentDir(payload.relPath) === '') return;
    e.preventDefault();
    onMove(payload.relPath, payload.name, '');
  }
  const sourceKeyRef = useRef(sourceKey);
  const loadDirRef = useRef(loadDir);

  // Always keep the latest loader in a ref so callers can pass a fresh
  // function each render without re-triggering the root fetch effect below.
  loadDirRef.current = loadDir;

  useEffect(() => {
    sourceKeyRef.current = sourceKey;
    let cancelled = false;

    loadDirRef.current('')
      .then((entries) => {
        if (!cancelled) {
          setRootEntries(entries);
          setRootLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : 'Failed to load files.';
          setError(msg);
          setRootLoading(false);
          toast.error('Failed to load files.');
        }
      });

    return () => {
      cancelled = true;
    };
    // loadDir is intentionally read through loadDirRef to avoid refetch on
    // identity-only changes from the parent (StackFileExplorer rebuilds the
    // arrow on every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, refreshKey]);

  function handleDirClick(dirRelPath: string) {
    if (expandedDirs.has(dirRelPath)) {
      setExpandedDirs((prev) => {
        const next = new Set(prev);
        next.delete(dirRelPath);
        return next;
      });
      return;
    }

    if (dirContents.has(dirRelPath)) {
      setExpandedDirs((prev) => new Set(prev).add(dirRelPath));
      return;
    }

    setLoadingDirs((prev) => new Set(prev).add(dirRelPath));

    const capturedSourceKey = sourceKey;
    loadDirRef.current(dirRelPath)
      .then((entries) => {
        if (sourceKeyRef.current !== capturedSourceKey) return;
        setDirContents((prev) => {
          const next = new Map(prev);
          next.set(dirRelPath, entries);
          return next;
        });
        setExpandedDirs((prev) => new Set(prev).add(dirRelPath));
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : 'Failed to load directory.';
        toast.error(msg);
      })
      .finally(() => {
        setLoadingDirs((prev) => {
          const next = new Set(prev);
          next.delete(dirRelPath);
          return next;
        });
      });
  }

  function handleFileClick(relPath: string, entry: FileEntry) {
    // Only the stack source root redirects compose/.env to their dedicated
    // editors; on a volume root these are ordinary files opened in the viewer.
    if (redirectProtected && relPath === entry.name && COMPOSE_NAMES.has(entry.name)) {
      if (onNavigateToCompose) onNavigateToCompose();
      else toast.info('Open the Compose tab to edit this file.');
      return;
    }
    if (redirectProtected && relPath === entry.name && ENV_NAMES.has(entry.name)) {
      if (onNavigateToEnv) onNavigateToEnv();
      else toast.info('Open the Env tab to edit this file.');
      return;
    }
    onSelectFile(relPath, entry);
  }

  const matchesFilter = (name: string): boolean =>
    name.toLowerCase().includes(filter.toLowerCase());

  // True when any already-loaded descendant of `dirPath` matches the filter.
  // Walks dirContents only, so unexpanded subtrees are not falsely shown as
  // "has match" until the user expands them. Bounded by what the user has
  // already loaded; no extra fetch.
  function hasMatchingDescendant(dirPath: string): boolean {
    const children = dirContents.get(dirPath);
    if (!children) return false;
    for (const child of children) {
      if (matchesFilter(child.name)) return true;
      if (child.type === 'directory') {
        const childPath = dirPath ? `${dirPath}/${child.name}` : child.name;
        if (hasMatchingDescendant(childPath)) return true;
      }
    }
    return false;
  }

  function renderEntries(entries: FileEntry[], parentRelPath: string, depth: number): ReactNode {
    // When the filter is active, keep entries that either match by name OR
    // are directories with a matching loaded descendant. Without the
    // ancestor-keep rule, the parent directory of a match would be filtered
    // out at this level and its loaded children would never render.
    const filtered = filter
      ? entries.filter(e => {
          if (matchesFilter(e.name)) return true;
          if (e.type !== 'directory') return false;
          const path = parentRelPath ? `${parentRelPath}/${e.name}` : e.name;
          return hasMatchingDescendant(path);
        })
      : entries;
    const capped = filtered.length > MAX_ENTRIES;
    const visible = capped ? filtered.slice(0, MAX_ENTRIES) : filtered;

    return (
      <>
        {visible.map((entry) => {
          const entryRelPath = parentRelPath ? `${parentRelPath}/${entry.name}` : entry.name;
          const isDir = entry.type === 'directory';
          // While a filter is active, auto-expand any directory that is being
          // kept solely because it has a matching descendant. The user gets
          // the match in view without manually expanding every ancestor.
          const isExpanded = expandedDirs.has(entryRelPath)
            || (filter !== '' && isDir && hasMatchingDescendant(entryRelPath));
          const isLoading = loadingDirs.has(entryRelPath);
          const children = dirContents.get(entryRelPath);

          return (
            <Fragment key={entryRelPath}>
              <FileTreeNode
                entry={entry}
                relPath={entryRelPath}
                depth={depth}
                isSelected={selectedPath === entryRelPath}
                isExpanded={isExpanded}
                isLoading={isLoading}
                onClick={() => {
                  if (isDir) {
                    handleDirClick(entryRelPath);
                  } else {
                    handleFileClick(entryRelPath, entry);
                  }
                }}
                canEdit={canEdit}
                onContextMenuRename={onContextMenuRename}
                onContextMenuMove={onContextMenuMove}
                onContextMenuDuplicate={onContextMenuDuplicate}
                onContextMenuCopy={onContextMenuCopy}
                onContextMenuNewFile={onContextMenuNewFile}
                onContextMenuNewFolder={onContextMenuNewFolder}
                onContextMenuDelete={onContextMenuDelete}
                onContextMenuPermissions={onContextMenuPermissions}
                onMove={onMove}
              />
              {isDir && isExpanded && children !== undefined && (
                children.length === 0
                  ? (
                    <div className="text-xs text-muted-foreground pl-4 py-0.5 italic">
                      Empty folder
                    </div>
                  )
                  : renderEntries(children, entryRelPath, depth + 1)
              )}
            </Fragment>
          );
        })}
        {capped && (
          <div className="text-xs text-muted-foreground pl-4 py-0.5">
            Showing {MAX_ENTRIES} of {filtered.length} - refine the filter or use a shell
          </div>
        )}
        {filter && filtered.length === 0 && depth === 0 && (
          <div className="text-xs text-muted-foreground pl-4 py-0.5 italic">
            No entries match &ldquo;{filter}&rdquo;
          </div>
        )}
      </>
    );
  }

  if (rootLoading) {
    return (
      <div className="flex flex-col gap-1.5 p-2">
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-full" />
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="p-2 text-xs text-destructive">
        {error}
      </div>
    );
  }

  if (rootEntries === null || rootEntries.length === 0) {
    return (
      <div className="p-2 text-xs text-muted-foreground italic">
        Empty folder
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="relative px-2 py-1.5 border-b border-glass-border shrink-0">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" strokeWidth={1.5} />
        <Input
          type="text"
          placeholder="Filter files..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="h-6 text-xs pl-6 pr-6"
          aria-label="Filter files"
        />
        {filter && (
          <button
            type="button"
            onClick={() => setFilter('')}
            className="absolute right-3.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            aria-label="Clear filter"
          >
            <X className="w-3 h-3" strokeWidth={1.5} />
          </button>
        )}
      </div>
      <ScrollArea type="hover" className="flex-1 min-h-0">
        <div
          data-testid="file-tree-root-dropzone"
          className={cn('py-1 min-h-full', isRootDropTarget && 'bg-accent/20')}
          onDragOver={handleRootDragOver}
          onDragLeave={() => setIsRootDropTarget(false)}
          onDrop={handleRootDrop}
        >
          {renderEntries(rootEntries, '', 0)}
        </div>
      </ScrollArea>
    </div>
  );
}
