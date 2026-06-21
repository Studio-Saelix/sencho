import { useState, useEffect, useCallback, useMemo } from 'react';
import { Trash2, FolderPlus, Download, Loader2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmModal } from '@/components/ui/modal';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui/toast-store';
import { downloadStackFile, listStackDirectory, listFileRoots, renameStackPath, STACK_SOURCE_ROOT_ID } from '@/lib/stackFilesApi';
import { FileTree } from './FileTree';
import { FileViewer } from './FileViewer';
import { FileUploadDropzone } from './FileUploadDropzone';
import { NewFolderDialog } from './NewFolderDialog';
import { NewFileDialog } from './NewFileDialog';
import { DeleteFileConfirm } from './DeleteFileConfirm';
import { RenameDialog } from './RenameDialog';
import { MoveFileDialog } from './MoveFileDialog';
import { FilePermissionsDialog } from './FilePermissionsDialog';
import type { FileEntry, FileRoot } from '@/lib/stackFilesApi';

interface StackFileExplorerProps {
  stackName: string;
  canEdit: boolean;
  isDarkMode: boolean;
  onNavigateToCompose?: () => void;
  onNavigateToEnv?: () => void;
}

/** The synthetic stack-source root used before roots load or if discovery fails. */
const STACK_SOURCE_FALLBACK: FileRoot = {
  id: STACK_SOURCE_ROOT_ID,
  kind: 'stack-source',
  label: 'Stack source',
  hostPathOrName: '',
  mounts: [],
  readonly: false,
  accessible: true,
  browsable: true,
  writable: true,
  chmodable: true,
  dangerous: false,
  managedSourceOverlap: false,
  warning: null,
  backend: 'fs',
};

/** Short label for a root option: container path (or volume name) + how many service mounts. */
function rootOptionLabel(root: FileRoot): string {
  if (root.kind === 'stack-source') return 'Stack source';
  const primary = root.mounts[0]?.containerPath || root.label;
  const count = root.mounts.length > 1 ? ` · ${root.mounts.length} mounts` : '';
  const ro = root.readonly ? ' · read-only' : '';
  return `${primary}${count}${ro}`;
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

  // ── file roots (Volumes + Stack source) ──
  const [roots, setRoots] = useState<FileRoot[]>([STACK_SOURCE_FALLBACK]);
  const [selectedRootId, setSelectedRootId] = useState<string>(STACK_SOURCE_ROOT_ID);
  // When a root switch is requested while the viewer has unsaved edits, hold it
  // here until the user confirms or cancels in the guard modal.
  const [pendingRootId, setPendingRootId] = useState<string | null>(null);

  const selectedRoot = useMemo(
    () => roots.find((r) => r.id === selectedRootId) ?? STACK_SOURCE_FALLBACK,
    [roots, selectedRootId],
  );
  const volumeRoots = useMemo(() => roots.filter((r) => r.kind !== 'stack-source'), [roots]);
  const isStackSource = selectedRoot.kind === 'stack-source';
  // Edits are allowed only when the user can edit AND the selected root is writable.
  const rootCanEdit = canEdit && selectedRoot.writable;

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

  // ── context menu: move ──
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveRelPath, setMoveRelPath] = useState('');
  const [moveEntry, setMoveEntry] = useState<FileEntry | null>(null);

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
    setRoots([STACK_SOURCE_FALLBACK]);
    setSelectedRootId(STACK_SOURCE_ROOT_ID);
    setPendingRootId(null);
  }, [stackName]);

  // Discover the stack's file roots and default to the first browsable volume
  // root when one exists, otherwise the stack source.
  useEffect(() => {
    let cancelled = false;
    listFileRoots(stackName)
      .then((fetched) => {
        if (cancelled) return;
        const list = fetched.length ? fetched : [STACK_SOURCE_FALLBACK];
        setRoots(list);
        const defaultVolume = list.find((r) => r.kind !== 'stack-source' && r.browsable);
        setSelectedRootId(defaultVolume?.id ?? STACK_SOURCE_ROOT_ID);
      })
      .catch(() => {
        if (cancelled) return;
        setRoots([STACK_SOURCE_FALLBACK]);
        setSelectedRootId(STACK_SOURCE_ROOT_ID);
      });
    return () => { cancelled = true; };
  }, [stackName]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  // Apply a root switch: reset the open file/tree to the new root's contents.
  const applyRootSwitch = useCallback((rootId: string) => {
    setSelectedRootId(rootId);
    setSelectedPath(null);
    setSelectedEntry(null);
    setCurrentDir('');
  }, []);

  // Switch roots, guarding unsaved edits in the viewer first.
  const handleRootChange = useCallback((rootId: string) => {
    if (rootId === selectedRootId) return;
    if (isViewerDirty) {
      setPendingRootId(rootId);
      return;
    }
    applyRootSwitch(rootId);
  }, [selectedRootId, isViewerDirty, applyRootSwitch]);

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
      const res = await downloadStackFile(stackName, selectedPath, selectedRootId);
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

  // Shared move handler for both the "Move to…" dialog and tree drag-and-drop.
  // Relocates `fromRel` into `destDir` (''=stack root). Blocks the move when it
  // would discard unsaved edits to the open file, and deselects when the open
  // file (or a folder containing it) is the thing being moved. Returns true only
  // when the entry actually moved, so the dialog closes on success and stays open
  // when the move was a no-op, blocked, or failed.
  const handleMove = useCallback(async (fromRel: string, entryName: string, destDir: string): Promise<boolean> => {
    const toRel = destDir ? `${destDir}/${entryName}` : entryName;
    if (toRel === fromRel) return false;
    const affectsOpen = selectedPath === fromRel
      || (selectedPath !== null && selectedPath.startsWith(`${fromRel}/`));
    if (affectsOpen && isViewerDirty) {
      toast.error('Save or discard your changes before moving this file.');
      return false;
    }
    try {
      await renameStackPath(stackName, fromRel, toRel, selectedRootId);
      toast.success('Moved successfully.');
      if (affectsOpen) handleDeleted();
      else refresh();
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Move failed.');
      return false;
    }
  }, [stackName, selectedRootId, selectedPath, isViewerDirty, handleDeleted, refresh]);

  // ── Context menu callbacks ──

  const handleContextMenuMove = useCallback((relPath: string, entry: FileEntry) => {
    setMoveRelPath(relPath);
    setMoveEntry(entry);
    setMoveOpen(true);
  }, []);

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
      {/* Left pane: root switcher + tree + upload + new folder */}
      <div className="flex flex-col w-56 shrink-0 border-r border-glass-border min-h-0">
        <div className="flex flex-col gap-1 px-2 py-1.5 border-b border-glass-border shrink-0">
          <span className="text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">Browsing</span>
          <Select value={selectedRootId} onValueChange={handleRootChange}>
            <SelectTrigger className="h-8 px-2 text-xs font-mono" aria-label="File root">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {volumeRoots.length > 0 && (
                <SelectGroup>
                  <SelectLabel className="text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">Volumes</SelectLabel>
                  {volumeRoots.map((r) => (
                    <SelectItem key={r.id} value={r.id} disabled={!r.browsable} className="text-xs font-mono">
                      {rootOptionLabel(r)}{r.browsable ? '' : ' (unavailable)'}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              <SelectGroup>
                <SelectLabel className="text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">Stack source</SelectLabel>
                <SelectItem value={STACK_SOURCE_ROOT_ID} className="text-xs font-mono">Stack source</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          {selectedRoot.warning && (
            <p className="flex items-start gap-1 text-[10px] text-stat-subtitle">
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" strokeWidth={1.5} />
              <span>{selectedRoot.warning}</span>
            </p>
          )}
          {volumeRoots.length === 0 && (
            <p className="text-[10px] text-stat-subtitle italic">
              No browsable stack volumes detected. Sencho can only browse mounted folders declared by this stack.
            </p>
          )}
        </div>
        <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-glass-border shrink-0">
          <div className="flex-1 min-w-0">
            <FileUploadDropzone
              stackName={stackName}
              currentDir={currentDir}
              canEdit={rootCanEdit}
              rootId={selectedRootId}
              onUploaded={refresh}
            />
          </div>
          {rootCanEdit && (
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
            key={`${stackName}:${selectedRootId}:${refreshKey}`}
            sourceKey={`${stackName}:${selectedRootId}`}
            loadDir={(p) => listStackDirectory(stackName, p, selectedRootId)}
            refreshKey={refreshKey}
            selectedPath={selectedPath ?? ''}
            onSelectFile={handleSelectFile}
            onNavigateToCompose={isStackSource ? onNavigateToCompose : undefined}
            onNavigateToEnv={isStackSource ? onNavigateToEnv : undefined}
            redirectProtected={isStackSource}
            canEdit={rootCanEdit}
            onContextMenuRename={handleContextMenuRename}
            onContextMenuMove={handleContextMenuMove}
            onContextMenuNewFile={handleContextMenuNewFile}
            onContextMenuNewFolder={handleContextMenuNewFolder}
            onContextMenuDelete={handleContextMenuDelete}
            onContextMenuPermissions={handleContextMenuPermissions}
            onMove={handleMove}
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
            {rootCanEdit && (
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
            canEdit={rootCanEdit}
            isDarkMode={isDarkMode}
            rootId={selectedRootId}
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
        rootId={selectedRootId}
        onDeleted={handleDeleted}
      />

      {/* Context menu delete */}
      <DeleteFileConfirm
        open={ctxDeleteOpen}
        onOpenChange={setCtxDeleteOpen}
        stackName={stackName}
        relPath={ctxDeletePath}
        entry={ctxDeleteEntry}
        rootId={selectedRootId}
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
        rootId={selectedRootId}
        onCreated={refresh}
      />

      {/* New file (context menu) */}
      <NewFileDialog
        open={newFileOpen}
        onOpenChange={setNewFileOpen}
        stackName={stackName}
        currentDir={newFileDir}
        rootId={selectedRootId}
        onCreated={refresh}
      />

      {/* Rename */}
      <RenameDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        stackName={stackName}
        relPath={renameRelPath}
        currentName={renameCurrentName}
        rootId={selectedRootId}
        onRenamed={() => {
          // If the renamed item was selected, deselect since the path changed.
          if (renameRelPath === selectedPath) handleDeleted();
          else refresh();
        }}
      />

      {/* Move */}
      <MoveFileDialog
        open={moveOpen}
        onOpenChange={setMoveOpen}
        stackName={stackName}
        relPath={moveRelPath}
        entry={moveEntry}
        rootId={selectedRootId}
        onMove={handleMove}
      />

      {/* Permissions */}
      <FilePermissionsDialog
        open={permissionsOpen}
        onOpenChange={setPermissionsOpen}
        stackName={stackName}
        relPath={permissionsRelPath}
        entryName={permissionsEntryName}
        rootId={selectedRootId}
        canEdit={rootCanEdit}
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

      {/* Unsaved-changes guard on root switch */}
      <ConfirmModal
        open={pendingRootId !== null}
        onOpenChange={(next) => { if (!next) setPendingRootId(null); }}
        onCancel={() => setPendingRootId(null)}
        kicker="FILES · UNSAVED CHANGES"
        title="Discard unsaved changes?"
        description="Switching roots will discard the edits in the current viewer."
        confirmLabel="Discard and switch"
        onConfirm={() => {
          if (pendingRootId) {
            applyRootSwitch(pendingRootId);
            setPendingRootId(null);
          }
        }}
      >
        <p className="text-sm text-muted-foreground">
          You have unsaved changes in the current file. Switching to another root will discard them.
        </p>
      </ConfirmModal>
    </div>
  );
}
