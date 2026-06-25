import type { ReactNode } from 'react';
import { FilePlus, FolderPlus, Pencil, FolderInput, Copy, CopyPlus, Lock, Trash2 } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { isProtectedRootRelPath, type FileEntry } from '@/lib/stackFilesApi';

interface FileTreeContextMenuProps {
  entry: FileEntry;
  relPath: string;
  canEdit: boolean;
  onRequestRename: (relPath: string) => void;
  onRequestMove: (relPath: string, entry: FileEntry) => void;
  onRequestDuplicate: (relPath: string, entry: FileEntry) => void;
  onRequestCopy: (relPath: string, entry: FileEntry) => void;
  onRequestNewFile: (dirRelPath: string) => void;
  onRequestNewFolder: (dirRelPath: string) => void;
  onRequestDelete: (relPath: string, entry: FileEntry) => void;
  onRequestPermissions: (relPath: string, entry: FileEntry) => void;
  children: ReactNode;
}

export function FileTreeContextMenu({
  entry,
  relPath,
  canEdit,
  onRequestRename,
  onRequestMove,
  onRequestDuplicate,
  onRequestCopy,
  onRequestNewFile,
  onRequestNewFolder,
  onRequestDelete,
  onRequestPermissions,
  children,
}: FileTreeContextMenuProps) {
  const isDir = entry.type === 'directory';
  const canWrite = canEdit;
  // Protected root files (compose/.env) can never leave the stack root, so they
  // are not offered as move sources.
  const canMove = canWrite && !isProtectedRootRelPath(relPath);
  const moveItem = canMove && (
    <ContextMenuItem onSelect={() => onRequestMove(relPath, entry)}>
      <FolderInput className="h-4 w-4 mr-2" strokeWidth={1.5} />
      <span>Move to…</span>
    </ContextMenuItem>
  );
  // Duplicate (same folder, auto-suffixed) and Copy to… are offered for any
  // editable entry. Unlike Move, a protected root file may be duplicated/copied:
  // the copy gets a new name, and the destination picker disables the stack root
  // for a reserved name so it can only land in a subfolder.
  const copyItems = canWrite && (
    <>
      <ContextMenuItem onSelect={() => onRequestDuplicate(relPath, entry)}>
        <CopyPlus className="h-4 w-4 mr-2" strokeWidth={1.5} />
        <span>Duplicate</span>
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onRequestCopy(relPath, entry)}>
        <Copy className="h-4 w-4 mr-2" strokeWidth={1.5} />
        <span>Copy to…</span>
      </ContextMenuItem>
    </>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-[180px]">
        {isDir ? (
          <>
            {canWrite && (
              <>
                <ContextMenuItem
                  onSelect={() => onRequestNewFile(relPath)}
                >
                  <FilePlus className="h-4 w-4 mr-2" strokeWidth={1.5} />
                  <span>New File</span>
                </ContextMenuItem>
                <ContextMenuItem
                  onSelect={() => onRequestNewFolder(relPath)}
                >
                  <FolderPlus className="h-4 w-4 mr-2" strokeWidth={1.5} />
                  <span>New Folder</span>
                </ContextMenuItem>
                <ContextMenuSeparator />
              </>
            )}
            {canWrite && (
              <ContextMenuItem onSelect={() => onRequestRename(relPath)}>
                <Pencil className="h-4 w-4 mr-2" strokeWidth={1.5} />
                <span>Rename</span>
              </ContextMenuItem>
            )}
            {copyItems}
            {moveItem}
            {canWrite && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem
                  onSelect={() => onRequestDelete(relPath, entry)}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="h-4 w-4 mr-2" strokeWidth={1.5} />
                  <span>Delete</span>
                </ContextMenuItem>
              </>
            )}
          </>
        ) : (
          <>
            {canWrite && (
              <ContextMenuItem onSelect={() => onRequestRename(relPath)}>
                <Pencil className="h-4 w-4 mr-2" strokeWidth={1.5} />
                <span>Rename</span>
              </ContextMenuItem>
            )}
            {copyItems}
            {moveItem}
            <ContextMenuItem onSelect={() => onRequestPermissions(relPath, entry)}>
              <Lock className="h-4 w-4 mr-2" strokeWidth={1.5} />
              <span>Permissions</span>
            </ContextMenuItem>
            {canWrite && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem
                  onSelect={() => onRequestDelete(relPath, entry)}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="h-4 w-4 mr-2" strokeWidth={1.5} />
                  <span>Delete</span>
                </ContextMenuItem>
              </>
            )}
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
