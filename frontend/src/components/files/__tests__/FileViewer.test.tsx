/**
 * Coverage for FileViewer.
 *
 * Locks the three content-render modes: Monaco editor for text files,
 * binary panel for binary files, and oversized panel for files that
 * exceed the preview limit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { FileContentResult } from '@/lib/stackFilesApi';

// FileViewer now imports `Editor` from the lazy loader, not directly from
// @monaco-editor/react. Mock the loader so tests skip Monaco's setup path
// and the editor renders synchronously. The mock exposes a hidden button
// that calls onChange so tests can drive a dirty buffer without instantiating
// the real editor.
vi.mock('@/lib/monacoLoader', () => ({
  Editor: ({ onChange }: { onChange?: (value: string | undefined) => void }) => (
    <div data-testid="monaco-editor">
      <button
        type="button"
        data-testid="monaco-edit-trigger"
        onClick={() => onChange?.('edited content')}
      >
        edit
      </button>
    </div>
  ),
  DiffEditor: () => <div data-testid="monaco-diff-editor" />,
}));

vi.mock('@/lib/stackFilesApi', () => {
  class MockFileConflictError extends Error {
    readonly code = 'PRECONDITION_FAILED' as const;
    readonly currentContent: string;
    readonly currentMtimeMs: number;
    constructor(message: string, currentContent: string, currentMtimeMs: number) {
      super(message);
      this.name = 'FileConflictError';
      this.currentContent = currentContent;
      this.currentMtimeMs = currentMtimeMs;
    }
  }
  return {
    readStackFile: vi.fn(),
    writeStackFile: vi.fn(),
    downloadStackFile: vi.fn(),
    FileConflictError: MockFileConflictError,
  };
});

vi.mock('@/components/ui/toast-store', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(() => 'loading-id'),
    dismiss: vi.fn(),
  },
}));

vi.mock('@/components/ui/skeleton', () => ({
  Skeleton: () => <div data-testid="skeleton" />,
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock('@/lib/utils', () => ({
  formatBytes: (n: number) => `${n}B`,
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

vi.mock('@/lib/monacoLanguages', () => ({
  extensionToLanguage: () => 'plaintext',
}));

import { readStackFile, writeStackFile, FileConflictError } from '@/lib/stackFilesApi';
import { FileViewer } from '../FileViewer';

const mockReadFile = readStackFile as unknown as ReturnType<typeof vi.fn>;
const mockWriteFile = writeStackFile as unknown as ReturnType<typeof vi.fn>;

function textResult(content = 'hello world'): FileContentResult {
  return { content, binary: false, oversized: false, size: content.length, mime: 'text/plain', mtimeMs: 1_700_000_000_000 };
}

function binaryResult(): FileContentResult {
  return { binary: true, oversized: false, size: 1024, mime: 'application/octet-stream', mtimeMs: 1_700_000_000_000 };
}

function oversizedResult(): FileContentResult {
  return { binary: false, oversized: true, size: 5_000_000, mime: 'text/plain', mtimeMs: 1_700_000_000_000 };
}

const defaultProps = {
  stackName: 'my-stack',
  canEdit: true,
  isDarkMode: false,
};

beforeEach(() => {
  mockReadFile.mockReset();
  mockWriteFile.mockReset();
});

afterEach(() => vi.clearAllMocks());

describe('FileViewer', () => {
  it('shows "Select a file" placeholder when selectedPath is null', () => {
    render(<FileViewer {...defaultProps} selectedPath={null} />);
    expect(screen.getByText(/select a file/i)).toBeInTheDocument();
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('renders Monaco editor for a regular text file', async () => {
    mockReadFile.mockResolvedValue(textResult());

    render(<FileViewer {...defaultProps} selectedPath="config/app.txt" />);

    await waitFor(() => expect(screen.getByTestId('monaco-editor')).toBeInTheDocument());
    expect(screen.queryByText(/binary file/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/too large/i)).not.toBeInTheDocument();
  });

  it('calls readStackFile with the correct stack name and path', async () => {
    mockReadFile.mockResolvedValue(textResult());

    render(<FileViewer {...defaultProps} selectedPath="src/index.ts" />);

    await waitFor(() => expect(mockReadFile).toHaveBeenCalledWith('my-stack', 'src/index.ts'));
  });

  it('renders binary panel (not Monaco) for a binary file', async () => {
    mockReadFile.mockResolvedValue(binaryResult());

    render(<FileViewer {...defaultProps} selectedPath="assets/logo.png" />);

    expect(await screen.findByText(/binary file/i)).toBeInTheDocument();
    expect(screen.queryByTestId('monaco-editor')).not.toBeInTheDocument();
  });

  it('renders oversized panel (not Monaco) when file is too large to preview', async () => {
    mockReadFile.mockResolvedValue(oversizedResult());

    render(<FileViewer {...defaultProps} selectedPath="logs/huge.log" />);

    expect(await screen.findByText(/too large to preview/i)).toBeInTheDocument();
    expect(screen.queryByTestId('monaco-editor')).not.toBeInTheDocument();
  });

  it('renders error message when readStackFile rejects', async () => {
    mockReadFile.mockRejectedValue(new Error('Not found'));

    render(<FileViewer {...defaultProps} selectedPath="missing.txt" />);

    expect(await screen.findByText('Not found')).toBeInTheDocument();
    expect(screen.queryByTestId('monaco-editor')).not.toBeInTheDocument();
  });

  it('shows the Download button for binary files', async () => {
    mockReadFile.mockResolvedValue(binaryResult());

    render(<FileViewer {...defaultProps} selectedPath="data.bin" />);

    await screen.findByText(/binary file/i);
    const downloadBtn = screen.getByRole('button', { name: /download/i });
    expect(downloadBtn).not.toBeDisabled();
  });

  it('re-fetches when selectedPath changes', async () => {
    mockReadFile.mockResolvedValue(textResult());

    const { rerender } = render(<FileViewer {...defaultProps} selectedPath="a.txt" />);
    await waitFor(() => expect(mockReadFile).toHaveBeenCalledTimes(1));

    rerender(<FileViewer {...defaultProps} selectedPath="b.txt" />);
    await waitFor(() => expect(mockReadFile).toHaveBeenCalledTimes(2));
    expect(mockReadFile).toHaveBeenNthCalledWith(2, 'my-stack', 'b.txt');
  });

  it('reports clean dirty state on initial load of a text file', async () => {
    mockReadFile.mockResolvedValue(textResult());
    const onDirtyChange = vi.fn();

    render(<FileViewer {...defaultProps} selectedPath="config/app.txt" onDirtyChange={onDirtyChange} />);

    await waitFor(() => expect(screen.getByTestId('monaco-editor')).toBeInTheDocument());
    // content === originalContent immediately after load → dirty=false
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('resets dirty signal on unmount', async () => {
    mockReadFile.mockResolvedValue(textResult());
    const onDirtyChange = vi.fn();

    const { unmount } = render(<FileViewer {...defaultProps} selectedPath="a.txt" onDirtyChange={onDirtyChange} />);
    await waitFor(() => expect(screen.getByTestId('monaco-editor')).toBeInTheDocument());

    onDirtyChange.mockClear();
    unmount();

    expect(onDirtyChange).toHaveBeenCalledWith(false);
  });

  it('sends If-Match with the loaded mtime on save and updates the local mtime from the response', async () => {
    mockReadFile.mockResolvedValue(textResult('hello'));
    mockWriteFile.mockResolvedValue({ mtimeMs: 1_700_000_000_999 });

    render(<FileViewer {...defaultProps} selectedPath="config.txt" />);
    await waitFor(() => expect(screen.getByTestId('monaco-editor')).toBeInTheDocument());

    // Drive a dirty buffer via the mock editor's edit trigger so Save activates.
    screen.getByTestId('monaco-edit-trigger').click();
    const saveBtn = screen.getByRole('button', { name: /save/i });
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    saveBtn.click();

    await waitFor(() => expect(mockWriteFile).toHaveBeenCalledTimes(1));
    const [s, p, c, opts] = mockWriteFile.mock.calls[0];
    expect(s).toBe('my-stack');
    expect(p).toBe('config.txt');
    expect(c).toBe('edited content');
    expect(opts).toEqual({ ifMatchMtimeMs: 1_700_000_000_000 });
  });

  it('binary panel offers "Open as text anyway"; click refetches with forceText and renders Monaco', async () => {
    mockReadFile
      .mockResolvedValueOnce(binaryResult())
      .mockResolvedValueOnce(textResult('rescued as text'));

    render(<FileViewer {...defaultProps} selectedPath="quirky-utf8.txt" />);
    await screen.findByText(/binary file/i);

    const overrideBtn = screen.getByRole('button', { name: /open as text anyway/i });
    overrideBtn.click();

    await waitFor(() => expect(screen.getByTestId('monaco-editor')).toBeInTheDocument());
    expect(mockReadFile).toHaveBeenCalledTimes(2);
    expect(mockReadFile).toHaveBeenNthCalledWith(2, 'my-stack', 'quirky-utf8.txt', { forceText: true });
  });

  it('updates baseline on FileConflictError without discarding the user buffer; follow-up save uses new mtime', async () => {
    mockReadFile.mockResolvedValue(textResult('stale local copy'));
    mockWriteFile
      .mockRejectedValueOnce(new FileConflictError('changed elsewhere', 'SERVER NOW', 1_700_000_999_000))
      .mockResolvedValueOnce({ mtimeMs: 1_700_001_000_000 });

    render(<FileViewer {...defaultProps} selectedPath="config.txt" />);
    await waitFor(() => expect(screen.getByTestId('monaco-editor')).toBeInTheDocument());
    screen.getByTestId('monaco-edit-trigger').click();
    const saveBtn = screen.getByRole('button', { name: /save/i });
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    saveBtn.click();

    await waitFor(() => expect(mockWriteFile).toHaveBeenCalledTimes(1));

    // The follow-up save sends the mtime from the conflict response so the
    // user does not loop on the same stale precondition. The user's typed
    // content ('edited content' from the mock trigger) is preserved on top.
    saveBtn.click();
    await waitFor(() => expect(mockWriteFile).toHaveBeenCalledTimes(2));
    expect(mockWriteFile.mock.calls[1][2]).toBe('edited content');
    expect(mockWriteFile.mock.calls[1][3]).toEqual({ ifMatchMtimeMs: 1_700_000_999_000 });
  });
});
