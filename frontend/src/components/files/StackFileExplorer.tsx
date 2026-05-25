import { useState, useEffect, useCallback } from 'react';
import { Trash2, FolderPlus, Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmModal } from '@/components/ui/modal';
import { toast } from '@/components/ui/toast-store';
import { downloadStackFile, listStackDirectory } from '@/lib/stackFilesApi';
import { FileTree } from './FileTree';
import { FileViewer } from './FileViewer';
import { FileUploadDropzone } from './FileUploadDropzone';
import { NewFolderDialog } from './NewFolderDialog';
import { NewFileDialog } from './NewFileDialog';
import { DeleteFileConfirm } from './DeleteFileConfirm';
import { RenameDialog } from './RenameDialog';
import { FilePermissionsDialog } from './FilePermissionsDialog';
import type { FileEntry } from '@/lib/stackFilesApi';

interface StackFileExplorerProps {
  stackName: string;
  canEdit: boolean;
  isDarkMode: boolean;
  onNavigateToCompose?: () => void;
  onNavigateToEnv?: () => void;
}

export function StackFileExplorer({
  stackName,
  canEdit,
  isDarkMode,
  onNavigateToCompose,
  onNavigateToEnv,
}: StackFileExplorerProps) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<FileEntry | null>(null);
  const [currentDir, setCurrentDir] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [isDownloading, setIsDownloading] = useState(false);

  // ── toolbar delete (existing behaviour) ──
  const [deleteOpen, setDeleteOpen] = useState(false);

  // ── new folder dialog (toolbar button + context menu) ──
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderDir, setNewFolderDir] = useState('');

  // ── context menu: new file ──
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFileDir, setNewFileDir] = useState('');

  // ── context menu: rename ──
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameRelPath, setRenameRelPath] = useState('');
  const [renameCurrentName, setRenameCurrentName] = useState('');

  // ── context menu: delete ──
  const [ctxDeleteOpen, setCtxDeleteOpen] = useState(false);
  const [ctxDeletePath, setCtxDeletePath] = useState('');
  const [ctxDeleteEntry, setCtxDeleteEntry] = useState<FileEntry | null>(null);

  // ── context menu: permissions ──
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [permissionsRelPath, setPermissionsRelPath] = useState('');
  const [permissionsEntryName, setPermissionsEntryName] = useState('');

  // ── unsaved-changes guard on file switch ──
  const [isViewerDirty, setIsViewerDirty] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<{ relPath: string; entry: FileEntry } | null>(null);

  useEffect(() => {
    setSelectedPath(null);
    setSelectedEntry(null);
    setCurrentDir('');
    setIsViewerDirty(false);
    setPendingSelection(null);
  }, [stackName]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const applySelection = useCallback((relPath: string, entry: FileEntry) => {
    setSelectedPath(relPath);
    setSelectedEntry(entry);
    const parts = relPath.split('/');
    parts.pop();
    setCurrentDir(parts.join('/'));
  }, []);

  const handleSelectFile = useCallback((relPath: string, entry: FileEntry) => {
    if (relPath === selectedPath) return;
    if (isViewerDirty) {
      setPendingSelection({ relPath, entry });
      return;
    }
    applySelection(relPath, entry);
  }, [selectedPath, isViewerDirty, applySelection]);

  const handleDeleted = useCallback(() => {
    setSelectedPath(null);
    setSelectedEntry(null);
    refresh();
  }, [refresh]);

  const handleDownload = async () => {
    if (!selectedPath) return;
    setIsDownloading(true);
    try {
      const res = await downloadStackFile(stackName, selectedPath);
      if (!res.ok) {
        toast.error('Download failed.');
        return;
      }
      const blob = await res.blob();
      const filename = selectedPath.split('/').pop() ?? selectedPath;
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
      setIsDownloading(false);
    }
  };

  // ── Context menu callbacks ──

  const handleContextMenuRename = useCallback((relPath: string) => {
    const name = relPath.split('/').pop() ?? relPath;
    setRenameRelPath(relPath);
    setRenameCurrentName(name);
    setRenameOpen(true);
  }, []);

  const handleContextMenuNewFile = useCallback((dirRelPath: string) => {
    setNewFileDir(dirRelPath);
    setNewFileOpen(true);
  }, []);

  const handleContextMenuNewFolder = useCallback((dirRelPath: string) => {
    setNewFolderDir(dirRelPath);
    setNewFolderOpen(true);
  }, []);

  const handleContextMenuDelete = useCallback((relPath: string, entry: FileEntry) => {
    setCtxDeletePath(relPath);
    setCtxDeleteEntry(entry);
    setCtxDeleteOpen(true);
  }, []);

  const handleContextMenuPermissions = useCallback((relPath: string, entry: FileEntry) => {
    setPermissionsRelPath(relPath);
    setPermissionsEntryName(entry.name);
    setPermissionsOpen(true);
  }, []);

  return (
    <div className="flex h-full min-h-0">
      {/* Left pane: tree + upload + new folder */}
      <div className="flex flex-col w-56 shrink-0 border-r border-glass-border min-h-0">
        <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-glass-border shrink-0">
          <div className="flex-1 min-w-0">
            <FileUploadDropzone
              stackName={stackName}
              currentDir={currentDir}
              canEdit={canEdit}
              onUploaded={refresh}
            />
          </div>
          {canEdit && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0"
              title="New folder"
              onClick={() => {
                setNewFolderDir(currentDir);
                setNewFolderOpen(true);
              }}
            >
              <FolderPlus className="w-3.5 h-3.5" strokeWidth={1.5} />
            </Button>
          )}
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          <FileTree
            key={`${stackName}:${refreshKey}`}
            sourceKey={stackName}
            loadDir={(p) => listStackDirectory(stackName, p)}
            refreshKey={refreshKey}
            selectedPath={selectedPath ?? ''}
            onSelectFile={handleSelectFile}
            onNavigateToCompose={onNavigateToCompose}
            onNavigateToEnv={onNavigateToEnv}
            canEdit={canEdit}
            onContextMenuRename={handleContextMenuRename}
            onContextMenuNewFile={handleContextMenuNewFile}
            onContextMenuNewFolder={handleContextMenuNewFolder}
            onContextMenuDelete={handleContextMenuDelete}
            onContextMenuPermissions={handleContextMenuPermissions}
          />
        </div>
      </div>

      {/* Right pane: action bar + viewer */}
      <div className="flex flex-col flex-1 min-h-0 min-w-0">
        {selectedPath !== null && (
          <div className="flex items-center justify-end gap-1 px-2 py-1 border-b border-glass-border shrink-0">
            <Button
              variant="ghost"
              size="sm"
              className="h-7"
              onClick={() => void handleDownload()}
              disabled={isDownloading}
            >
              {isDownloading ? (
                <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" strokeWidth={1.5} />
              ) : (
                <Download className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} />
              )}
              Download
            </Button>
            {canEdit && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                data-testid="file-action-delete"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} />
                Delete
              </Button>
            )}
          </div>
        )}
        <div className="flex-1 min-h-0">
          <FileViewer
            stackName={stackName}
            selectedPath={selectedPath}
            canEdit={canEdit}
            isDarkMode={isDarkMode}
            onSaved={refresh}
            onDirtyChange={setIsViewerDirty}
          />
        </div>
      </div>

      {/* ── Dialogs ── */}

      {/* Toolbar delete (currently selected file) */}
      <DeleteFileConfirm
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        stackName={stackName}
        relPath={selectedPath ?? ''}
        entry={selectedEntry}
        onDeleted={handleDeleted}
      />

      {/* Context menu delete */}
      <DeleteFileConfirm
        open={ctxDeleteOpen}
        onOpenChange={setCtxDeleteOpen}
        stackName={stackName}
        relPath={ctxDeletePath}
        entry={ctxDeleteEntry}
        onDeleted={() => {
          if (ctxDeletePath === selectedPath) handleDeleted();
          else refresh();
          setCtxDeletePath('');
          setCtxDeleteEntry(null);
        }}
      />

      {/* New folder (toolbar + context menu) */}
      <NewFolderDialog
        open={newFolderOpen}
        onOpenChange={setNewFolderOpen}
        stackName={stackName}
        currentDir={newFolderDir}
        onCreated={refresh}
      />

      {/* New file (context menu) */}
      <NewFileDialog
        open={newFileOpen}
        onOpenChange={setNewFileOpen}
        stackName={stackName}
        currentDir={newFileDir}
        onCreated={refresh}
      />

      {/* Rename */}
      <RenameDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        stackName={stackName}
        relPath={renameRelPath}
        currentName={renameCurrentName}
        onRenamed={() => {
          // If the renamed item was selected, deselect since the path changed.
          if (renameRelPath === selectedPath) handleDeleted();
          else refresh();
        }}
      />

      {/* Permissions */}
      <FilePermissionsDialog
        open={permissionsOpen}
        onOpenChange={setPermissionsOpen}
        stackName={stackName}
        relPath={permissionsRelPath}
        entryName={permissionsEntryName}
        canEdit={canEdit}
      />

      {/* Unsaved-changes guard on file switch */}
      <ConfirmModal
        open={pendingSelection !== null}
        onOpenChange={(next) => { if (!next) setPendingSelection(null); }}
        onCancel={() => setPendingSelection(null)}
        kicker="FILES · UNSAVED CHANGES"
        title="Discard unsaved changes?"
        description="Switching files will discard the edits in the current viewer."
        confirmLabel="Discard and switch"
        onConfirm={() => {
          if (pendingSelection) {
            applySelection(pendingSelection.relPath, pendingSelection.entry);
            setPendingSelection(null);
          }
        }}
      >
        <p className="text-sm text-muted-foreground">
          You have unsaved changes in the current file. Switching to another file will discard them.
        </p>
      </ConfirmModal>
    </div>
  );
}
