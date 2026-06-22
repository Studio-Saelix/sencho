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

// Holder for the renameStackPath mock and the captured onMove callback, so tests
// can drive the shared move handler directly (the DnD path passes it as onMove).
const h = vi.hoisted(() => ({
  renameMock: vi.fn<(stack: string, from: string, to: string) => Promise<void>>(),
  copyMock: vi.fn<(stack: string, from: string, to: string, rootId?: string) => Promise<void>>(),
  listMock: vi.fn<(stack: string, dir: string, rootId?: string) => Promise<FileEntry[]>>(),
  onMove: null as null | ((fromRel: string, entryName: string, destDir: string) => void),
  onCopy: null as null | ((fromRel: string, entryName: string, destDir: string) => boolean | Promise<boolean>),
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
  relPathParentDir: (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''),
  nextDuplicateName: (n: string) => `${n} copy`,
}));

vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: h.toastError, success: h.toastSuccess, loading: vi.fn(() => 'id'), dismiss: vi.fn() },
}));

vi.mock('../FileUploadDropzone', () => ({
  FileUploadDropzone: () => <div data-testid="upload-dropzone" />,
}));

vi.mock('../NewFolderDialog', () => ({ NewFolderDialog: () => null }));
vi.mock('../NewFileDialog', () => ({ NewFileDialog: () => null }));
vi.mock('../DeleteFileConfirm', () => ({ DeleteFileConfirm: () => null }));
vi.mock('../RenameDialog', () => ({ RenameDialog: () => null }));
// Capture the copy-mode dialog's confirm callback so handleCopy can be driven
// directly (the move-mode instance is exercised via the drag-and-drop onMove).
vi.mock('../MoveFileDialog', () => ({
  MoveFileDialog: ({ mode, onMove }: {
    mode?: 'move' | 'copy';
    onMove?: (fromRel: string, entryName: string, destDir: string) => boolean | Promise<boolean>;
  }) => {
    if (mode === 'copy') h.onCopy = onMove ?? null;
    return null;
  },
}));
vi.mock('../FilePermissionsDialog', () => ({ FilePermissionsDialog: () => null }));

// FileTree mock: selection buttons (two siblings + one nested file) plus capture
// of the onMove callback so move-handler behaviour can be driven directly.
vi.mock('../FileTree', () => ({
  FileTree: ({ onSelectFile, onMove, onContextMenuDuplicate }: {
    onSelectFile: (rel: string, entry: FileEntry) => void;
    onMove?: (fromRel: string, entryName: string, destDir: string) => void;
    onContextMenuDuplicate?: (relPath: string, entry: FileEntry) => void;
  }) => {
    h.onMove = onMove ?? null;
    return (
      <div>
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
