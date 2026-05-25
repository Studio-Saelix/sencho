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
// and the editor renders synchronously.
vi.mock('@/lib/monacoLoader', () => ({
  Editor: () => <div data-testid="monaco-editor" />,
  DiffEditor: () => <div data-testid="monaco-diff-editor" />,
}));

vi.mock('@/lib/stackFilesApi', () => ({
  readStackFile: vi.fn(),
  writeStackFile: vi.fn(),
  downloadStackFile: vi.fn(),
}));

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

import { readStackFile } from '@/lib/stackFilesApi';
import { FileViewer } from '../FileViewer';

const mockReadFile = readStackFile as unknown as ReturnType<typeof vi.fn>;

function textResult(content = 'hello world'): FileContentResult {
  return { content, binary: false, oversized: false, size: content.length, mime: 'text/plain' };
}

function binaryResult(): FileContentResult {
  return { binary: true, oversized: false, size: 1024, mime: 'application/octet-stream' };
}

function oversizedResult(): FileContentResult {
  return { binary: false, oversized: true, size: 5_000_000, mime: 'text/plain' };
}

const defaultProps = {
  stackName: 'my-stack',
  canEdit: true,
  isDarkMode: false,
};

beforeEach(() => {
  mockReadFile.mockReset();
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
});
