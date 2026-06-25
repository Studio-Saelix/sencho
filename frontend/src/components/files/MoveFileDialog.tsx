import { useState, useEffect, useRef, Fragment } from 'react';
import type { ReactNode } from 'react';
import { ChevronRight, ChevronDown, Folder, FolderRoot, Loader2 } from 'lucide-react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast-store';
import { cn } from '@/lib/utils';
import {
  listStackDirectory,
  isProtectedRootRelPath,
  isSameOrDescendantPath,
  relPathParentDir,
  type FileEntry,
} from '@/lib/stackFilesApi';

interface MoveFileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stackName: string;
  /** Full relative path of the entry being moved, e.g. "configs/app.conf". */
  relPath: string;
  /** The entry being moved (null until a source is chosen). */
  entry: FileEntry | null;
  /** The selected file root; the destination tree is loaded within it. */
  rootId?: string;
  /** 'move' relocates the entry; 'copy' duplicates it into the destination. The
   *  destination rules are identical (the current parent stays disabled in both,
   *  so a same-folder copy goes through Duplicate, not this picker). */
  mode?: 'move' | 'copy';
  /** Bulk mode: the rel paths of every selected source. When set, the dialog
   *  validates the destination against all of them and calls onConfirmDestination
   *  instead of onMove (the single relPath/entry props are ignored). */
  bulkSourcePaths?: string[];
  /** Relocate or copy `fromRel` into `destDir` (''=stack root). Resolves true only
   *  when the action succeeded, so the dialog stays open on a blocked/failed run. */
  onMove: (fromRel: string, entryName: string, destDir: string) => boolean | Promise<boolean>;
  /** Bulk confirm: move the whole selection into `destDir`. Resolves true on success. */
  onConfirmDestination?: (destDir: string) => boolean | Promise<boolean>;
}

export function MoveFileDialog({
  open,
  onOpenChange,
  stackName,
  relPath,
  entry,
  rootId,
  mode = 'move',
  bulkSourcePaths,
  onMove,
  onConfirmDestination,
}: MoveFileDialogProps) {
  const isCopy = mode === 'copy';
  // Treat an empty bulk list as not-bulk so the picker never enables a no-op move.
  const bulkSources = bulkSourcePaths && bulkSourcePaths.length > 0 ? bulkSourcePaths : null;
  // Loaded directory children, keyed by directory rel path ('' = stack root).
  const [dirChildren, setDirChildren] = useState<Map<string, FileEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<Set<string>>(new Set());
  const [selectedDest, setSelectedDest] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  // Bumped on every (re)open so stale async directory loads are discarded.
  const requestSeqRef = useRef(0);

  const currentParent = relPathParentDir(relPath);

  // A destination directory is valid unless it is the entry's current parent
  // (a no-op), the entry itself or a descendant (for a directory), or the stack
  // root when the entry's name is reserved at the root (compose/.env files).
  const isValidDest = (dir: string): boolean => {
    if (bulkSources) {
      // No destination inside or equal to any selected directory (would move a
      // folder into its own subtree).
      if (bulkSources.some((s) => isSameOrDescendantPath(s, dir))) return false;
      // Not a no-op for the whole selection (every item already lives here).
      if (bulkSources.every((s) => relPathParentDir(s) === dir)) return false;
      // The stack root is reserved if any item carries a protected root name.
      if (dir === '' && bulkSources.some((s) => isProtectedRootRelPath(s.split('/').pop() ?? s))) return false;
      return true;
    }
    if (!entry) return false;
    if (dir === currentParent) return false;
    if (entry.type === 'directory' && isSameOrDescendantPath(relPath, dir)) return false;
    if (dir === '' && isProtectedRootRelPath(entry.name)) return false;
    return true;
  };

  const loadDir = (dir: string) => {
    const seq = requestSeqRef.current;
    setLoading((prev) => new Set(prev).add(dir));
    setLoadError((prev) => {
      if (!prev.has(dir)) return prev;
      const next = new Set(prev);
      next.delete(dir);
      return next;
    });
    listStackDirectory(stackName, dir, rootId)
      .then((entries) => {
        if (requestSeqRef.current !== seq) return;
        setDirChildren((prev) => new Map(prev).set(dir, entries.filter((e) => e.type === 'directory')));
      })
      .catch((err: unknown) => {
        if (requestSeqRef.current !== seq) return;
        // Mark the dir as failed so its row shows an inline retry instead of
        // collapsing to look like an empty folder after the toast fades.
        setLoadError((prev) => new Set(prev).add(dir));
        toast.error(err instanceof Error ? err.message : 'Failed to load folders.');
      })
      .finally(() => {
        if (requestSeqRef.current !== seq) return;
        setLoading((prev) => {
          const next = new Set(prev);
          next.delete(dir);
          return next;
        });
      });
  };

  useEffect(() => {
    if (!open) return;
    requestSeqRef.current += 1;
    setDirChildren(new Map());
    setExpanded(new Set());
    setLoading(new Set());
    setLoadError(new Set());
    setSelectedDest(null);
    loadDir('');
    // loadDir is stable enough for this reset; re-running only on open/source change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, stackName, relPath]);

  const toggleDir = (dir: string) => {
    if (expanded.has(dir)) {
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(dir);
        return next;
      });
      return;
    }
    if (!dirChildren.has(dir)) loadDir(dir);
    setExpanded((prev) => new Set(prev).add(dir));
  };

  const handleClose = (next: boolean) => {
    if (moving) return;
    onOpenChange(next);
  };

  const handleMove = async () => {
    if (selectedDest === null || !isValidDest(selectedDest)) return;
    setMoving(true);
    try {
      // Close only when the action actually succeeded; a blocked or failed run
      // (handled and toasted upstream) leaves the picker open to retry.
      const ok = bulkSources
        ? await onConfirmDestination?.(selectedDest)
        : entry
          ? await onMove(relPath, entry.name, selectedDest)
          : false;
      if (ok) onOpenChange(false);
    } finally {
      setMoving(false);
    }
  };

  function renderDir(dir: string, depth: number): ReactNode {
    const children = dirChildren.get(dir);
    if (children === undefined) {
      if (loadError.has(dir)) {
        return (
          <div className="flex items-center gap-1.5 text-xs text-destructive" style={{ paddingLeft: depth * 16 + 28 }}>
            <span>Couldn&rsquo;t load folders.</span>
            <button type="button" onClick={() => loadDir(dir)} className="underline hover:text-foreground">
              Retry
            </button>
          </div>
        );
      }
      return null;
    }
    if (children.length === 0) {
      return (
        <div className="text-xs text-muted-foreground italic" style={{ paddingLeft: depth * 16 + 28 }}>
          No subfolders
        </div>
      );
    }
    return children.map((child) => {
      const childRel = dir ? `${dir}/${child.name}` : child.name;
      const isOpen = expanded.has(childRel);
      const isLoading = loading.has(childRel);
      const selectable = isValidDest(childRel);
      return (
        <Fragment key={childRel}>
          <div
            className={cn(
              'flex items-center gap-1 rounded-sm py-0.5 pr-2',
              selectedDest === childRel && 'bg-accent text-accent-foreground'
            )}
            style={{ paddingLeft: depth * 16 + 4 }}
          >
            <button
              type="button"
              onClick={() => toggleDir(childRel)}
              className="shrink-0 text-muted-foreground hover:text-foreground"
              aria-label={isOpen ? 'Collapse folder' : 'Expand folder'}
            >
              {isLoading
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />
                : isOpen
                  ? <ChevronDown className="w-3.5 h-3.5" strokeWidth={1.5} />
                  : <ChevronRight className="w-3.5 h-3.5" strokeWidth={1.5} />}
            </button>
            <button
              type="button"
              disabled={!selectable}
              onClick={() => setSelectedDest(childRel)}
              className={cn(
                'flex items-center gap-1.5 min-w-0 flex-1 text-left rounded-sm px-1',
                selectable ? 'hover:bg-accent/50' : 'opacity-40 cursor-not-allowed'
              )}
            >
              <Folder className="w-3.5 h-3.5 shrink-0" strokeWidth={1.5} />
              <span className="font-mono text-sm truncate">{child.name}</span>
            </button>
          </div>
          {isOpen && renderDir(childRel, depth + 1)}
        </Fragment>
      );
    });
  }

  const rootSelectable = isValidDest('');
  const rootLoading = loading.has('');

  return (
    <Modal open={open} onOpenChange={handleClose} size="sm">
      <ModalHeader
        kicker={`${stackName.toUpperCase()} · ${isCopy ? 'COPY' : 'MOVE'}`}
        title={isCopy ? 'Copy to…' : 'Move to…'}
        description={
          bulkSources
            ? `Choose a destination folder for ${bulkSources.length} ${bulkSources.length === 1 ? 'item' : 'items'}.`
            : entry
              ? `Choose a destination folder for ${entry.name}.`
              : 'Choose a destination folder.'
        }
      />
      <ModalBody>
        <div className="rounded-md border border-glass-border max-h-72 overflow-y-auto p-1">
          {/* Stack root row */}
          <button
            type="button"
            disabled={!rootSelectable}
            onClick={() => setSelectedDest('')}
            className={cn(
              'flex items-center gap-1.5 w-full text-left rounded-sm px-2 py-1',
              selectedDest === '' && 'bg-accent text-accent-foreground',
              rootSelectable ? 'hover:bg-accent/50' : 'opacity-40 cursor-not-allowed'
            )}
          >
            <FolderRoot className="w-3.5 h-3.5 shrink-0" strokeWidth={1.5} />
            <span className="font-mono text-sm">Stack root</span>
          </button>
          {rootLoading && dirChildren.get('') === undefined ? (
            <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
              <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />
              Loading folders…
            </div>
          ) : (
            renderDir('', 0)
          )}
        </div>
      </ModalBody>
      <ModalFooter
        secondary={
          <Button variant="outline" size="sm" onClick={() => handleClose(false)} disabled={moving}>
            Cancel
          </Button>
        }
        primary={
          <Button
            size="sm"
            onClick={() => void handleMove()}
            disabled={moving || selectedDest === null || !isValidDest(selectedDest)}
          >
            {moving && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" strokeWidth={1.5} />}
            {isCopy ? 'Copy' : 'Move'}
          </Button>
        }
      />
    </Modal>
  );
}
