import { useState } from 'react';
import type { DragEvent } from 'react';
import { ChevronRight, ChevronDown, Folder, File, Link, Loader2 } from 'lucide-react';
import {
  FILE_ENTRY_DND_MIME,
  isProtectedRootRelPath,
  isSameOrDescendantPath,
  readFileEntryDragPayload,
  relPathParentDir,
  type FileEntry,
  type FileEntryDragPayload,
} from '@/lib/stackFilesApi';
import { cn } from '@/lib/utils';
import { FileTreeContextMenu } from './FileTreeContextMenu';

interface FileTreeNodeProps {
  entry: FileEntry;
  relPath: string;
  depth: number;
  isSelected: boolean;
  isExpanded?: boolean;
  isLoading?: boolean;
  onClick: () => void;
  // Accessibility / roving-tabindex wiring (the parent owns keyboard navigation).
  /** The single roving-focusable node holds tabIndex 0; all others hold -1. */
  isActive: boolean;
  /** Register/unregister this row's element so the parent can move DOM focus. */
  registerRef: (relPath: string, el: HTMLDivElement | null) => void;
  /** Keep the parent's active node in sync when this row gains focus (click/Tab). */
  onFocusNode: (relPath: string) => void;
  // Context menu wiring
  canEdit: boolean;
  onContextMenuRename: (relPath: string) => void;
  onContextMenuMove: (relPath: string, entry: FileEntry) => void;
  onContextMenuDuplicate: (relPath: string, entry: FileEntry) => void;
  onContextMenuCopy: (relPath: string, entry: FileEntry) => void;
  onContextMenuNewFile: (dirRelPath: string) => void;
  onContextMenuNewFolder: (dirRelPath: string) => void;
  onContextMenuDelete: (relPath: string, entry: FileEntry) => void;
  onContextMenuPermissions: (relPath: string, entry: FileEntry) => void;
  // Drag-and-drop move: relocate `fromRel` into `destDir`.
  onMove: (fromRel: string, entryName: string, destDir: string) => void;
}

export function FileTreeNode({
  entry,
  relPath,
  depth,
  isSelected,
  isExpanded,
  isLoading,
  onClick,
  isActive,
  registerRef,
  onFocusNode,
  canEdit,
  onContextMenuRename,
  onContextMenuMove,
  onContextMenuDuplicate,
  onContextMenuCopy,
  onContextMenuNewFile,
  onContextMenuNewFolder,
  onContextMenuDelete,
  onContextMenuPermissions,
  onMove,
}: FileTreeNodeProps) {
  const isDir = entry.type === 'directory';
  const [isDropTarget, setIsDropTarget] = useState(false);

  const canDrag = canEdit && !isProtectedRootRelPath(relPath);

  // A directory accepts a dropped entry unless the drop would be a no-op (the
  // entry already lives here) or would move a folder into its own subtree.
  const wouldAcceptDrop = (payload: FileEntryDragPayload): boolean => {
    if (relPathParentDir(payload.relPath) === relPath) return false;
    if (payload.type === 'directory' && isSameOrDescendantPath(payload.relPath, relPath)) return false;
    return true;
  };

  const handleDragStart = (e: DragEvent) => {
    const payload: FileEntryDragPayload = { relPath, name: entry.name, type: entry.type };
    e.dataTransfer.setData(FILE_ENTRY_DND_MIME, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: DragEvent) => {
    if (!isDir || !canEdit) return;
    const payload = readFileEntryDragPayload(e.dataTransfer);
    if (!payload || !wouldAcceptDrop(payload)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (!isDropTarget) setIsDropTarget(true);
  };

  const handleDragLeave = () => {
    if (isDropTarget) setIsDropTarget(false);
  };

  const handleDrop = (e: DragEvent) => {
    if (!isDir || !canEdit) return;
    const payload = readFileEntryDragPayload(e.dataTransfer);
    if (!payload) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDropTarget(false);
    if (!wouldAcceptDrop(payload)) return;
    onMove(payload.relPath, payload.name, relPath);
  };

  return (
    <FileTreeContextMenu
      entry={entry}
      relPath={relPath}
      canEdit={canEdit}
      onRequestRename={onContextMenuRename}
      onRequestMove={onContextMenuMove}
      onRequestDuplicate={onContextMenuDuplicate}
      onRequestCopy={onContextMenuCopy}
      onRequestNewFile={onContextMenuNewFile}
      onRequestNewFolder={onContextMenuNewFolder}
      onRequestDelete={onContextMenuDelete}
      onRequestPermissions={onContextMenuPermissions}
    >
      <div
        ref={(el) => registerRef(relPath, el)}
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={isSelected}
        aria-expanded={isDir ? isExpanded : undefined}
        tabIndex={isActive ? 0 : -1}
        draggable={canDrag}
        onDragStart={canDrag ? handleDragStart : undefined}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={onClick}
        onFocus={() => onFocusNode(relPath)}
        onKeyDown={(e) => {
          // Enter/Space activate the row; arrow/Home/End navigation is owned by
          // the parent tree (it needs the flattened visible order).
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick();
          }
        }}
        className={cn(
          'flex items-center gap-1.5 py-0.5 cursor-pointer select-none rounded-sm',
          isSelected
            ? 'bg-accent text-accent-foreground'
            : 'hover:bg-accent/50 text-foreground',
          isDropTarget && 'ring-1 ring-inset ring-accent-foreground/40 bg-accent/40'
        )}
        style={{ paddingLeft: depth * 16 + 8 }}
      >
        {isDir && (
          isLoading
            ? <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" strokeWidth={1.5} />
            : isExpanded
              ? <ChevronDown className="w-3.5 h-3.5 shrink-0" strokeWidth={1.5} />
              : <ChevronRight className="w-3.5 h-3.5 shrink-0" strokeWidth={1.5} />
        )}
        {isDir
          ? <Folder className="w-3.5 h-3.5 shrink-0" strokeWidth={1.5} />
          : entry.type === 'symlink'
            ? <Link className="w-3.5 h-3.5 shrink-0" strokeWidth={1.5} />
            : <File className="w-3.5 h-3.5 shrink-0" strokeWidth={1.5} />
        }
        <span className="font-mono text-sm truncate">{entry.name}</span>
        {entry.isProtected && (
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
        )}
      </div>
    </FileTreeContextMenu>
  );
}
