/**
 * Coverage for StackFileExplorer's unsaved-changes interception.
 *
 * The viewer reports its dirty state up via onDirtyChange. When the user
 * clicks a sibling file in the tree, the explorer must intercept the switch
 * and show a confirm dialog if there are unsaved edits. The viewer mock
 * exposes a "Mark dirty" button so the test can drive the dirty signal
 * without instantiating Monaco.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FileEntry } from '@/lib/stackFilesApi';
import { downloadBlob } from '@/lib/download';

// Holder for the renameStackPath mock and the captured onMove callback, so tests
// can drive the shared move handler directly (the DnD path passes it as onMove).
const h = vi.hoisted(() => ({
  renameMock: vi.fn<(stack: string, from: string, to: string) => Promise<void>>(),
  copyMock: vi.fn<(stack: string, from: string, to: string, rootId?: string) => Promise<void>>(),
  listMock: vi.fn<(stack: string, dir: string, rootId?: string) => Promise<FileEntry[]>>(),
  bulkDeleteMock: vi.fn<(stack: string, paths: string[], rootId?: string) => Promise<{ deleted: string[]; failed: { path: string; error: string }[] }>>(),
  bulkMoveMock: vi.fn<(stack: string, from: string[], toDir: string, rootId?: string) => Promise<{ moved: string[]; failed: { path: string; error: string }[] }>>(),
  bulkDownloadMock: vi.fn<(stack: string, paths: string[], rootId?: string) => Promise<Response>>(),
  onMove: null as null | ((fromRel: string, entryName: string, destDir: string) => void),
  onCopy: null as null | ((fromRel: string, entryName: string, destDir: string) => boolean | Promise<boolean>),
  onConfirmDestination: null as null | ((destDir: string) => boolean | Promise<boolean>),
  onSelectionChange: null as null | ((next: Set<string>) => void),
  newFileProps: null as null | { open: boolean; currentDir: string; rootId?: string },
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@/lib/stackFilesApi', () => ({
  STACK_SOURCE_ROOT_ID: 'stack-source',
  listStackDirectory: h.listMock,
  listFileRoots: vi.fn().mockResolvedValue([]),
  downloadStackFile: vi.fn(),
  readStackFile: vi.fn(),
  writeStackFile: vi.fn(),
  renameStackPath: h.renameMock,
  copyStackFile: h.copyMock,
  bulkDeleteStackPaths: h.bulkDeleteMock,
  bulkMoveStackPaths: h.bulkMoveMock,
  bulkDownloadStackFiles: h.bulkDownloadMock,
  relPathParentDir: (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''),
  nextDuplicateName: (n: string) => `${n} copy`,
  isProtectedRootRelPath: (rel: string) =>
    ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml', '.env'].includes(rel),
  normalizeSelection: (paths: string[]) => {
    const set = new Set(paths);
    return [...set].filter((p) => {
      const seg = p.split('/');
      for (let i = 1; i < seg.length; i++) if (set.has(seg.slice(0, i).join('/'))) return false;
      return true;
    });
  },
}));

vi.mock('@/lib/download', () => ({ downloadBlob: vi.fn() }));

vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: h.toastError, success: h.toastSuccess, loading: vi.fn(() => 'id'), dismiss: vi.fn() },
}));

vi.mock('../FileUploadDropzone', () => ({
  FileUploadDropzone: () => <div data-testid="upload-dropzone" />,
}));

vi.mock('../NewFolderDialog', () => ({ NewFolderDialog: () => null }));
// Capture the dialog props so the toolbar button's open/dir/root wiring is testable.
vi.mock('../NewFileDialog', () => ({
  NewFileDialog: (props: { open: boolean; currentDir: string; rootId?: string }) => {
    h.newFileProps = { open: props.open, currentDir: props.currentDir, rootId: props.rootId };
    return null;
  },
}));
vi.mock('../DeleteFileConfirm', () => ({ DeleteFileConfirm: () => null }));
vi.mock('../RenameDialog', () => ({ RenameDialog: () => null }));
// Capture the copy-mode dialog's confirm callback so handleCopy can be driven
// directly (the move-mode instance is exercised via the drag-and-drop onMove).
vi.mock('../MoveFileDialog', () => ({
  MoveFileDialog: ({ mode, onMove, onConfirmDestination }: {
    mode?: 'move' | 'copy';
    onMove?: (fromRel: string, entryName: string, destDir: string) => boolean | Promise<boolean>;
    onConfirmDestination?: (destDir: string) => boolean | Promise<boolean>;
  }) => {
    if (mode === 'copy') h.onCopy = onMove ?? null;
    if (onConfirmDestination) h.onConfirmDestination = onConfirmDestination; // the bulk-move instance
    return null;
  },
}));
vi.mock('../FilePermissionsDialog', () => ({ FilePermissionsDialog: () => null }));

// FileTree mock: selection buttons (two siblings + one nested file) plus capture
// of the onMove callback so move-handler behaviour can be driven directly.
vi.mock('../FileTree', () => ({
  FileTree: ({ onSelectFile, onMove, onContextMenuDuplicate, onSelectionChange }: {
    onSelectFile: (rel: string, entry: FileEntry) => void;
    onMove?: (fromRel: string, entryName: string, destDir: string) => void;
    onContextMenuDuplicate?: (relPath: string, entry: FileEntry) => void;
    onSelectionChange?: (next: Set<string>) => void;
  }) => {
    h.onMove = onMove ?? null;
    h.onSelectionChange = onSelectionChange ?? null;
    return (
      <div>
        <button onClick={() => onSelectionChange?.(new Set(['a.txt', 'b.txt']))}>bulk-select-two</button>
        <button onClick={() => onSelectionChange?.(new Set(['compose.yaml', 'a.txt']))}>bulk-select-protected</button>
        <button onClick={() => onSelectFile('a.txt', { name: 'a.txt', type: 'file', size: 1, mtime: 0, isProtected: false })}>
          select-a
        </button>
        <button onClick={() => onSelectFile('b.txt', { name: 'b.txt', type: 'file', size: 1, mtime: 0, isProtected: false })}>
          select-b
        </button>
        <button onClick={() => onSelectFile('dir/a.txt', { name: 'a.txt', type: 'file', size: 1, mtime: 0, isProtected: false })}>
          select-nested
        </button>
        <button onClick={() => onContextMenuDuplicate?.('configs/app.conf', { name: 'app.conf', type: 'file', size: 1, mtime: 0, isProtected: false })}>
          ctx-duplicate
        </button>
      </div>
    );
  },
}));

// FileViewer mock exposes a button that flips its dirty signal.
vi.mock('../FileViewer', () => ({
  FileViewer: ({ selectedPath, onDirtyChange }: {
    selectedPath: string | null;
    onDirtyChange?: (dirty: boolean) => void;
  }) => (
    <div>
      <div data-testid="viewer-selected">{selectedPath ?? '(none)'}</div>
      <button onClick={() => onDirtyChange?.(true)}>mark-dirty</button>
      <button onClick={() => onDirtyChange?.(false)}>mark-clean</button>
    </div>
  ),
}));

import { StackFileExplorer } from '../StackFileExplorer';

function setup() {
  return render(
    <StackFileExplorer stackName="my-stack" canEdit isDarkMode={false} />,
  );
}

describe('StackFileExplorer unsaved-changes interception', () => {
  it('switches files immediately when the viewer is clean', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByText('select-a'));
    expect(screen.getByTestId('viewer-selected').textContent).toBe('a.txt');

    await user.click(screen.getByText('select-b'));
    expect(screen.getByTestId('viewer-selected').textContent).toBe('b.txt');
    expect(screen.queryByText(/discard unsaved changes/i)).not.toBeInTheDocument();
  });

  it('intercepts the switch when the viewer is dirty and applies on confirm', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByText('select-a'));
    await user.click(screen.getByText('mark-dirty'));

    // Switching siblings while dirty must NOT swap the selection immediately.
    await user.click(screen.getByText('select-b'));
    expect(screen.getByTestId('viewer-selected').textContent).toBe('a.txt');
    expect(screen.getByText(/discard unsaved changes/i)).toBeInTheDocument();

    // Confirming the dialog applies the pending selection.
    await user.click(screen.getByRole('button', { name: /discard and switch/i }));
    expect(screen.getByTestId('viewer-selected').textContent).toBe('b.txt');
  });

  it('intercepts the switch when dirty and preserves the original on cancel', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByText('select-a'));
    await user.click(screen.getByText('mark-dirty'));

    await user.click(screen.getByText('select-b'));
    expect(screen.getByText(/discard unsaved changes/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.getByTestId('viewer-selected').textContent).toBe('a.txt');
  });

  it('clicking the already-selected file does not prompt even when dirty', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByText('select-a'));
    await user.click(screen.getByText('mark-dirty'));

    await user.click(screen.getByText('select-a'));
    expect(screen.queryByText(/discard unsaved changes/i)).not.toBeInTheDocument();
  });
});

describe('StackFileExplorer move handling', () => {
  beforeEach(() => {
    h.renameMock.mockReset().mockResolvedValue(undefined);
    h.toastError.mockReset();
    h.toastSuccess.mockReset();
  });

  it('moves an unaffected entry and reports success without deselecting', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByText('select-a'));

    h.onMove?.('other.txt', 'other.txt', 'sub');

    await waitFor(() => expect(h.renameMock).toHaveBeenCalledWith('my-stack', 'other.txt', 'sub/other.txt', 'stack-source'));
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith('Moved successfully.'));
    // The open file was not the one moved, so the viewer keeps its selection.
    expect(screen.getByTestId('viewer-selected').textContent).toBe('a.txt');
  });

  it('blocks the move and warns when the open file has unsaved edits', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByText('select-a'));
    await user.click(screen.getByText('mark-dirty'));

    h.onMove?.('a.txt', 'a.txt', 'sub');

    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith(expect.stringMatching(/save or discard/i)));
    expect(h.renameMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('viewer-selected').textContent).toBe('a.txt');
  });

  it('deselects the viewer when the open file itself is moved', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByText('select-a'));

    h.onMove?.('a.txt', 'a.txt', 'sub');

    await waitFor(() => expect(h.renameMock).toHaveBeenCalledWith('my-stack', 'a.txt', 'sub/a.txt', 'stack-source'));
    await waitFor(() => expect(screen.getByTestId('viewer-selected').textContent).toBe('(none)'));
  });

  it('deselects the viewer when a folder containing the open file is moved', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByText('select-nested'));
    expect(screen.getByTestId('viewer-selected').textContent).toBe('dir/a.txt');

    h.onMove?.('dir', 'dir', 'other');

    await waitFor(() => expect(h.renameMock).toHaveBeenCalledWith('my-stack', 'dir', 'other/dir', 'stack-source'));
    await waitFor(() => expect(screen.getByTestId('viewer-selected').textContent).toBe('(none)'));
  });

  it('surfaces an error toast when the move fails', async () => {
    h.renameMock.mockRejectedValueOnce(new Error('Cannot move across a storage boundary'));
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByText('select-a'));

    // Move a different file so the open file is unaffected; only the toast matters.
    h.onMove?.('other.txt', 'other.txt', 'sub');

    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('Cannot move across a storage boundary'));
    expect(screen.getByTestId('viewer-selected').textContent).toBe('a.txt');
  });
});

describe('StackFileExplorer copy and duplicate handling', () => {
  beforeEach(() => {
    h.copyMock.mockReset().mockResolvedValue(undefined);
    h.listMock.mockReset().mockResolvedValue([]);
    h.toastError.mockReset();
    h.toastSuccess.mockReset();
  });

  it('duplicates into the same folder under a non-colliding "copy" name', async () => {
    h.listMock.mockResolvedValue([
      { name: 'app.conf', type: 'file', size: 1, mtime: 0, isProtected: false },
    ]);
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByText('ctx-duplicate'));

    // Siblings are listed from the entry's parent dir, then copied to the derived name.
    await waitFor(() => expect(h.listMock).toHaveBeenCalledWith('my-stack', 'configs', 'stack-source'));
    await waitFor(() => expect(h.copyMock).toHaveBeenCalledWith('my-stack', 'configs/app.conf', 'configs/app.conf copy', 'stack-source'));
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith('Duplicated successfully.'));
  });

  it('surfaces an error toast when the sibling listing for duplicate fails', async () => {
    h.listMock.mockRejectedValueOnce(new Error('Failed to load folders.'));
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByText('ctx-duplicate'));

    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('Failed to load folders.'));
    expect(h.copyMock).not.toHaveBeenCalled();
  });

  it('copies via the copy-to dialog handler and reports success', async () => {
    setup();
    await waitFor(() => expect(h.onCopy).not.toBeNull());

    const result = await h.onCopy?.('a.txt', 'a.txt', 'sub');
    expect(result).toBe(true);
    expect(h.copyMock).toHaveBeenCalledWith('my-stack', 'a.txt', 'sub/a.txt', 'stack-source');
    expect(h.toastSuccess).toHaveBeenCalledWith('Copied successfully.');
  });

  it('surfaces an error toast and stays open when the copy fails', async () => {
    h.copyMock.mockRejectedValueOnce(new Error('already exists'));
    setup();
    await waitFor(() => expect(h.onCopy).not.toBeNull());

    const result = await h.onCopy?.('a.txt', 'a.txt', 'sub');
    expect(result).toBe(false);
    expect(h.toastError).toHaveBeenCalledWith('already exists');
  });
});

describe('StackFileExplorer bulk selection', () => {
  beforeEach(() => {
    h.bulkDeleteMock.mockReset().mockResolvedValue({ deleted: [], failed: [] });
    h.bulkMoveMock.mockReset().mockResolvedValue({ moved: [], failed: [] });
    h.bulkDownloadMock.mockReset();
    h.onConfirmDestination = null;
    h.toastError.mockReset();
    h.toastSuccess.mockReset();
    vi.mocked(downloadBlob).mockReset();
  });

  it('shows the bulk action bar with a count once files are selected', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByText('bulk-select-two'));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download selection' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move selection' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete selection' })).toBeInTheDocument();
  });

  it('downloads the selection as an archive', async () => {
    h.bulkDownloadMock.mockResolvedValue({ ok: true, blob: async () => new Blob(['x']) } as unknown as Response);
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByText('bulk-select-two'));
    await user.click(screen.getByRole('button', { name: 'Download selection' }));
    await waitFor(() => expect(h.bulkDownloadMock).toHaveBeenCalledWith('my-stack', ['a.txt', 'b.txt'], 'stack-source'));
    await waitFor(() => expect(vi.mocked(downloadBlob)).toHaveBeenCalled());
  });

  it('moves the selection through the destination picker', async () => {
    h.bulkMoveMock.mockResolvedValue({ moved: ['a.txt', 'b.txt'], failed: [] });
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByText('bulk-select-two'));
    expect(h.onConfirmDestination).not.toBeNull();

    const ok = await h.onConfirmDestination?.('dest');
    expect(ok).toBe(true);
    expect(h.bulkMoveMock).toHaveBeenCalledWith('my-stack', ['a.txt', 'b.txt'], 'dest', 'stack-source');
    expect(h.toastSuccess).toHaveBeenCalledWith('Moved 2 items.');
  });

  it('deletes the selection but excludes protected files from the request', async () => {
    h.bulkDeleteMock.mockResolvedValue({ deleted: ['a.txt'], failed: [] });
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByText('bulk-select-protected')); // compose.yaml + a.txt
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete selection' }));
    const confirm = await screen.findByRole('button', { name: /^delete$/i });
    await user.click(confirm);

    // compose.yaml (protected) is excluded; only a.txt is sent.
    await waitFor(() => expect(h.bulkDeleteMock).toHaveBeenCalledWith('my-stack', ['a.txt'], 'stack-source'));
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith('Deleted 1 item.'));
  });

  it('reports a partial delete failure with detail and keeps the failed item selected', async () => {
    h.bulkDeleteMock.mockResolvedValue({ deleted: ['a.txt'], failed: [{ path: 'b.txt', error: 'locked' }] });
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByText('bulk-select-two'));
    await user.click(screen.getByRole('button', { name: 'Delete selection' }));
    await user.click(await screen.findByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith(expect.stringContaining('b.txt (locked)')));
    // The failed item stays selected so the user can retry it.
    await waitFor(() => expect(screen.getByText('1 selected')).toBeInTheDocument());
  });

  it('surfaces the server message when the bulk download is rejected (e.g. a volume symlink)', async () => {
    h.bulkDownloadMock.mockResolvedValue({
      ok: false, status: 400, json: async () => ({ error: '"x" cannot be downloaded from this volume' }),
    } as unknown as Response);
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByText('bulk-select-two'));
    await user.click(screen.getByRole('button', { name: 'Download selection' }));
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('"x" cannot be downloaded from this volume'));
  });

  it('falls back to a too-large message when a 413 body cannot be parsed', async () => {
    // No json() on the response: the parse fails and the per-status default shows.
    h.bulkDownloadMock.mockResolvedValue({ ok: false, status: 413 } as unknown as Response);
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByText('bulk-select-two'));
    await user.click(screen.getByRole('button', { name: 'Download selection' }));
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith(expect.stringMatching(/too large/i)));
  });

  it('clears the selection with the Clear button', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByText('bulk-select-two'));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByText('2 selected')).not.toBeInTheDocument();
  });
});

describe('StackFileExplorer new file affordance', () => {
  beforeEach(() => { h.newFileProps = null; });

  it('opens the New file dialog at the stack root from the toolbar button', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'New file' }));
    expect(h.newFileProps).toMatchObject({ open: true, currentDir: '', rootId: 'stack-source' });
  });

  it('targets the current directory once a nested file is selected', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByText('select-nested')); // dir/a.txt -> currentDir 'dir'
    await user.click(screen.getByRole('button', { name: 'New file' }));
    expect(h.newFileProps).toMatchObject({ open: true, currentDir: 'dir' });
  });

  it('hides the New file button on a non-editable root', () => {
    render(<StackFileExplorer stackName="my-stack" canEdit={false} isDarkMode={false} />);
    expect(screen.queryByRole('button', { name: 'New file' })).not.toBeInTheDocument();
  });
});
