/**
 * Coverage for StackFileExplorer's unsaved-changes interception.
 *
 * The viewer reports its dirty state up via onDirtyChange. When the user
 * clicks a sibling file in the tree, the explorer must intercept the switch
 * and show a confirm dialog if there are unsaved edits. The viewer mock
 * exposes a "Mark dirty" button so the test can drive the dirty signal
 * without instantiating Monaco.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FileEntry } from '@/lib/stackFilesApi';

vi.mock('@/lib/stackFilesApi', () => ({
  listStackDirectory: vi.fn().mockResolvedValue([]),
  downloadStackFile: vi.fn(),
  readStackFile: vi.fn(),
  writeStackFile: vi.fn(),
}));

vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), loading: vi.fn(() => 'id'), dismiss: vi.fn() },
}));

vi.mock('../FileUploadDropzone', () => ({
  FileUploadDropzone: () => <div data-testid="upload-dropzone" />,
}));

vi.mock('../NewFolderDialog', () => ({ NewFolderDialog: () => null }));
vi.mock('../NewFileDialog', () => ({ NewFileDialog: () => null }));
vi.mock('../DeleteFileConfirm', () => ({ DeleteFileConfirm: () => null }));
vi.mock('../RenameDialog', () => ({ RenameDialog: () => null }));
vi.mock('../FilePermissionsDialog', () => ({ FilePermissionsDialog: () => null }));

// FileTree mock exposes two buttons that synthesise selection of two siblings.
vi.mock('../FileTree', () => ({
  FileTree: ({ onSelectFile }: { onSelectFile: (rel: string, entry: FileEntry) => void }) => (
    <div>
      <button onClick={() => onSelectFile('a.txt', { name: 'a.txt', type: 'file', size: 1, mtime: 0, isProtected: false })}>
        select-a
      </button>
      <button onClick={() => onSelectFile('b.txt', { name: 'b.txt', type: 'file', size: 1, mtime: 0, isProtected: false })}>
        select-b
      </button>
    </div>
  ),
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
