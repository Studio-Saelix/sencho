import { ChevronRight, ChevronDown, Folder, File, Link, Loader2 } from 'lucide-react';
import type { FileEntry } from '@/lib/stackFilesApi';
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
  // Context menu wiring
  canEdit: boolean;
  onContextMenuRename: (relPath: string) => void;
  onContextMenuNewFile: (dirRelPath: string) => void;
  onContextMenuNewFolder: (dirRelPath: string) => void;
  onContextMenuDelete: (relPath: string, entry: FileEntry) => void;
  onContextMenuPermissions: (relPath: string, entry: FileEntry) => void;
}

export function FileTreeNode({
  entry,
  relPath,
  depth,
  isSelected,
  isExpanded,
  isLoading,
  onClick,
  canEdit,
  onContextMenuRename,
  onContextMenuNewFile,
  onContextMenuNewFolder,
  onContextMenuDelete,
  onContextMenuPermissions,
}: FileTreeNodeProps) {
  const isDir = entry.type === 'directory';

  return (
    <FileTreeContextMenu
      entry={entry}
      relPath={relPath}
      canEdit={canEdit}
      onRequestRename={onContextMenuRename}
      onRequestNewFile={onContextMenuNewFile}
      onRequestNewFolder={onContextMenuNewFolder}
      onRequestDelete={onContextMenuDelete}
      onRequestPermissions={onContextMenuPermissions}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') onClick();
        }}
        aria-expanded={isDir ? isExpanded : undefined}
        className={cn(
          'flex items-center gap-1.5 py-0.5 cursor-pointer select-none rounded-sm',
          isSelected
            ? 'bg-accent text-accent-foreground'
            : 'hover:bg-accent/50 text-foreground'
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
